// consultation start 

(function () {

    var FRYE_LOCATION_ID = "oUKKuxKyYWHUoncYOKhr";
    var fryeConsultInterval;
    var FRYE_PDF_URL = "https://raw.githubusercontent.com/kivenalaric/joey_scripts/main/u5ppdW-Unknown-5%20(1).pdf";
    var GHL_API = "https://services.leadconnectorhq.com";

    console.log("FRYE CONSULTATION SCRIPT LOADED");

    // ── pdf-lib loading ──
    var pdfLibLoaded = false;
    function loadPdfLib() {
        var urls = [
            "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js",
            "https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js",
            "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js"
        ];
        function tryLoad(idx) {
            if (idx >= urls.length) { console.error("Frye Consult: ALL pdf-lib sources failed"); return; }
            fetch(urls[idx]).then(function(r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
            .then(function(code) { var fn = new Function(code); fn(); if (window.PDFLib) { pdfLibLoaded = true; console.log("Frye Consult: pdf-lib loaded!"); } else { throw new Error("not on window"); } })
            .catch(function(err) { console.error("Frye Consult: pdf-lib FAILED from", urls[idx], err.message); tryLoad(idx + 1); });
        }
        tryLoad(0);
    }
    loadPdfLib();

    // ── Template caching ──
    var cachedTemplateBytes = null;
    function fetchTemplate() {
        if (cachedTemplateBytes) return Promise.resolve(cachedTemplateBytes);
        return fetch(FRYE_PDF_URL).then(function(r) {
            if (!r.ok) throw new Error("Template fetch failed: " + r.status);
            return r.arrayBuffer();
        }).then(function(buf) {
            cachedTemplateBytes = new Uint8Array(buf);
            console.log("Frye Consult: Template loaded,", cachedTemplateBytes.length, "bytes");
            return cachedTemplateBytes;
        });
    }

    // ── Auth token from IndexedDB (Firebase) ──
    function getAuthToken() {
        return new Promise(function(resolve, reject) {
            var req = indexedDB.open("firebaseLocalStorageDb");
            req.onerror = function() { reject(new Error("Cannot open IndexedDB")); };
            req.onsuccess = function(e) {
                var db = e.target.result;
                var tx = db.transaction("firebaseLocalStorage", "readonly");
                var store = tx.objectStore("firebaseLocalStorage");
                var getReq = store.getAll();
                getReq.onsuccess = function() {
                    for (var i = 0; i < getReq.result.length; i++) {
                        var item = getReq.result[i];
                        if (item.value && item.value.stsTokenManager && item.value.stsTokenManager.accessToken) {
                            resolve(item.value.stsTokenManager.accessToken);
                            return;
                        }
                    }
                    reject(new Error("No auth token in IndexedDB"));
                };
                getReq.onerror = function() { reject(new Error("IndexedDB read failed")); };
            };
        });
    }

    // ── GHL API helpers ──
    // Uses the same internal-API header pattern as adiv1_contract.js:
    //   token-id (NOT Authorization), channel, source, version, Accept
    function getLocationIdFromUrl() {
        var m = window.location.href.match(/location\/([^\/]+)/);
        return m ? m[1] : FRYE_LOCATION_ID;
    }

    function ghlFetch(path, token, extraQuery) {
        var locationId = getLocationIdFromUrl();
        var sep = path.indexOf("?") === -1 ? "?" : "&";
        var url = GHL_API + path + sep + "locationId=" + encodeURIComponent(locationId);
        if (extraQuery) url += "&" + extraQuery;
        return fetch(url, {
            method: "GET",
            headers: {
                "Accept":   "application/json, text/plain, */*",
                "channel":  "APP",
                "source":   "WEB_USER",
                "version":  "2021-07-28",
                "token-id": token
            }
        }).then(function(r) {
            if (!r.ok) throw new Error("GHL API " + path + ": " + r.status);
            return r.json();
        });
    }

    var cachedFieldDefs = null;
    function fetchFieldDefs(token) {
        if (cachedFieldDefs) return Promise.resolve(cachedFieldDefs);
        var locationId = getLocationIdFromUrl();
        // Custom fields endpoint on services API
        return fetch(GHL_API + "/locations/" + locationId + "/customFields?model=opportunity", {
            headers: {
                "Accept":   "application/json, text/plain, */*",
                "channel":  "APP",
                "source":   "WEB_USER",
                "version":  "2021-07-28",
                "token-id": token
            }
        }).then(function(r) {
            if (!r.ok) throw new Error("customFields: " + r.status);
            return r.json();
        }).then(function(data) {
            var map = {};
            var arr = data.customFields || data.fields || data || [];
            if (Array.isArray(arr)) {
                for (var i = 0; i < arr.length; i++) map[arr[i].id] = (arr[i].name || arr[i].fieldKey || "").trim();
            }
            cachedFieldDefs = map;
            console.log("Frye Consult: Field defs loaded,", Object.keys(map).length, "fields", map);
            return map;
        }).catch(function(err) {
            console.warn("Frye Consult: Field defs failed, custom fields will be blank", err.message);
            cachedFieldDefs = {};
            return {};
        });
    }

    // Fetch full contact (for Primary Phone / Primary Email + address)
    function fetchContact(contactId, token) {
        if (!contactId) return Promise.resolve({});
        return ghlFetch("/contacts/" + contactId, token).then(function(data) {
            return data.contact || data || {};
        }).catch(function(err) {
            console.warn("Frye Consult: Contact fetch failed", err.message);
            return {};
        });
    }

    // Fetch contact appointments — use the nearest upcoming (or most recent) for Date/Time
    function fetchAppointments(contactId, token) {
        if (!contactId) return Promise.resolve([]);
        return ghlFetch("/contacts/" + contactId + "/appointments/", token).then(function(data) {
            return data.events || data.appointments || data || [];
        }).catch(function(err) {
            console.warn("Frye Consult: Appointments fetch failed", err.message);
            return [];
        });
    }

    // ── Upload PDF to contact's Documents tab ──
    // Mirrors adiv1_contract.js: search → delete-if-exists → create → PUT to signed URL → mark completed
    function uploadConsultationToContact(blob, filename, contactId, locationId) {
        if (!contactId) return Promise.reject(new Error("Missing contactId"));
        var TOKEN;
        var hdr = function() {
            return {
                "Accept":   "application/json, text/plain, */*",
                "channel":  "APP",
                "source":   "WEB_USER",
                "version":  "2021-07-28",
                "token-id": TOKEN
            };
        };
        return getAuthToken().then(function(t) {
            TOKEN = t;
            // Create document record (always add — no search/delete/replace)
            return fetch(GHL_API + "/documents/", {
                method: "POST",
                headers: Object.assign({ "Content-Type": "application/json" }, hdr()),
                body: JSON.stringify({
                    name:         filename,
                    size:         blob.size,
                    type:         "file",
                    documentType: ["internal"],
                    contactId:    contactId,
                    locationId:   locationId
                })
            }).then(function(r) { return r.json(); });
        }).then(function(createDoc) {
            if (!createDoc || !createDoc.document || !createDoc.document.url) {
                throw new Error("No signed URL returned from GHL");
            }
            var documentId = createDoc.document.id;
            // Upload to signed S3 URL
            return fetch(createDoc.document.url, {
                method: "PUT",
                headers: { "Content-Type": "application/pdf" },
                body: blob
            }).then(function(up) {
                if (!up.ok) throw new Error("S3 upload failed: " + up.status);
                // Mark completed
                return fetch(GHL_API + "/documents/" + documentId, {
                    method: "PUT",
                    headers: Object.assign({ "Content-Type": "application/json" }, hdr()),
                    body: JSON.stringify({ status: "completed", contactId: contactId, locationId: locationId })
                }).then(function(r) { return r.json(); }).then(function() { return documentId; });
            });
        });
    }

    function pickAppointment(appts) {
        if (!Array.isArray(appts) || !appts.length) return null;
        var now = Date.now();
        var future = appts.filter(function(a) { return a.startTime && new Date(a.startTime).getTime() >= now; });
        future.sort(function(a,b) { return new Date(a.startTime) - new Date(b.startTime); });
        if (future.length) return future[0];
        // fallback: most recent past
        var past = appts.filter(function(a) { return a.startTime; });
        past.sort(function(a,b) { return new Date(b.startTime) - new Date(a.startTime); });
        return past[0] || null;
    }

    // ── Extract opportunity ID from pipeline card ──
    // (Same approach as adiv1.js: opportunity ID is the `id` attribute on .crm-opportunities-card-header)
    function getCardOpportunityId(el) {
        var card = el.closest(".crm-opportunities-card") || el.closest(".ui-card") || el;
        var header = card.querySelector ? card.querySelector(".crm-opportunities-card-header") : null;
        if (header && header.getAttribute("id")) return header.getAttribute("id");
        // Fallback: URL
        var m = window.location.href.match(/opportunity_id=([^&]+)/);
        return m ? m[1] : null;
    }

    // ── Map API response → PDF fields ──
    function mapApiToFields(opp, fieldDefs, fullContact, appointment, contactId) {
        var d = {};
        d.contactId = contactId || (opp.contactId || (opp.contact && opp.contact.id) || (fullContact && fullContact.id));
        d.locationId = getLocationIdFromUrl();
        // Merge embedded opp.contact with separately-fetched full contact (full wins for phone/email/address)
        var contact = Object.assign({}, opp.contact || {}, fullContact || {});

        // Build label→value map from custom fields
        var cfByLabel = {};
        var customFields = opp.customFields || [];
        for (var i = 0; i < customFields.length; i++) {
            var label = (fieldDefs[customFields[i].id] || "").toLowerCase().trim();
            var val = customFields[i].fieldValue || "";
            if (label) cfByLabel[label] = val;
        }
        // console.log("Frye Consult: Custom field values by label", cfByLabel);

        function cf(/* label variants */) {
            // 1. Exact (case-insensitive) match on any of the label variants
            for (var i = 0; i < arguments.length; i++) {
                var key = arguments[i].toLowerCase().trim();
                if (cfByLabel[key]) return cfByLabel[key];
            }
            // 2. Fuzzy fallback: substring match against first variant (either direction)
            if (arguments.length > 0) {
                var needle = arguments[0].toLowerCase().trim();
                for (var lbl in cfByLabel) {
                    if (lbl.indexOf(needle) > -1 || needle.indexOf(lbl) > -1) return cfByLabel[lbl];
                }
            }
            return "";
        }

        // Exact-only lookup (no fuzzy substring fallback) — use when fuzzy would grab wrong field
        function cfExact() {
            for (var i = 0; i < arguments.length; i++) {
                var key = arguments[i].toLowerCase().trim();
                if (cfByLabel[key]) return cfByLabel[key];
            }
            return "";
        }

        // Date / Time — from contact's Book/Update Appointment (nearest upcoming appointment)
        var pad = function(n) { return n < 10 ? "0" + n : "" + n; };
        d.date = ""; d.time = "";
        if (appointment && appointment.startTime) {
            var ad = new Date(appointment.startTime);
            if (!isNaN(ad.getTime())) {
                d.date = pad(ad.getMonth() + 1) + "/" + pad(ad.getDate()) + "/" + ad.getFullYear();
                var hrs = ad.getHours(), mins = ad.getMinutes(), ampm = hrs >= 12 ? "PM" : "AM";
                hrs = hrs % 12; if (hrs === 0) hrs = 12;
                d.time = hrs + ":" + pad(mins) + " " + ampm;
            }
        }

        d.charges = opp.name || "";
        // Intaker + Scheduled by — pulled from the "Intaker" custom field on Opportunity Details
        d.intaker = cf("intaker");
        d.scheduledBy = cf("intaker");
        // Staff — intentionally left blank; filled in manually at time of consult (variable attorney coverage)
        d.staff = "";
        d.legalStatus = cf("citizenship", "citizenship (criminal defense)", "legal status");
        d.calendarFeePaid = cf("calendar fee paid");
        d.reasonWaived = cf("reason waived");

        d.consultStatus = cf("consult status/type", "consult status");
        d.consultType = cf("consult status/type", "consult type");
        d.matterQualified = cf("matter qualified");
        d.reasonNotQualified = cf("reason not qualified");

        // PNC Info — Criminal Defense Intake
        d.pncName = opp.name || "";

        // Opportunity Details — Phone/Email/Address prefer contact record (Primary Phone/Email live there)
        d.dob = cf("dob", "date of birth") || contact.dateOfBirth || "";
        d.phone = contact.phone || cf("primary phone", "phone") || "";
        d.email = contact.email || cf("primary email", "email") || "";
        d.mailingAddress = cf("mailing address", "address") || (contact.address1 ? [contact.address1, contact.city, contact.state, contact.postalCode].filter(Boolean).join(", ") : "");

        // Criminal Defense Intake
        d.militaryStatus = cf("military?", "military status", "military");
        d.doi = cf("date of incident", "doi");
        d.doa = cf("date of arrest", "date of arrest (criminal defense)", "doa");

        // Source Data + Referral (new fields)
        d.primarySource = cf("primary source");
        d.subSource = cf("sub source", "subsource");
        d.clientReportedSource = cf("referral source (client reported)", "client reported source", "referral source - client reported", "referral source");
        d.court = cf("court date (next appearance)", "court date (criminal defense)", "court date", "next appearance", "court house", "court");
        d.county = cf("county/jurisdiction (criminal defense)", "county/jurisdiction", "county");
        d.incidentNotes = cf("incident notes", "incident note");
        d.involvedParties = cf("involved parties", "involved party");
        d.priors = cf("prior history notes", "prior history note");
        d.employer = cf("client employer/employment", "employer/employment", "employer");
        // Employment Impact — no GHL field maps to this box on the new form; leave blank
        d.employmentImpact = "";
        d.medicalDiagnosis = cf("medical diagnosis/meds", "medical diagnosis");

        // Attorney / Outcomes
        d.attorneyNotes = cf("attorney notes");
        d.desiredOutcome = cf("desired outcome");
        d.biggestConcerns = cf("biggest concerns");
        d.todoIfRetained = cf("to do if retained");
        d.assignTo = cf("assign to", "assigned to");

        // Emergency Contact — Opportunity Details "Additional Contact" block
        // Use exact match only — fuzzy would grab "Use Additional Contact" toggle ("Yes") instead of the name
        d.emergencyContact = cfExact("additional contact name", "emergency contact name", "emergency contact", "additional contact");
        d.relationshipToPNC = cfExact("relation to pnc", "relationship to pnc");
        d.emergencyPhone = cfExact("additional contact phone", "emergency contact phone");
        d.emergencyEmail = cfExact("additional contact email", "emergency contact email");

        // Payment
        d.retainerOnly = cf("retainer only");
        d.retainerPlusTrial = cf("retainer + trial");
        d.singlePaymentRetainer = cf("single payment retainer");
        // Payment Plan box is checked when the "Installment Plan?" opportunity field is Yes
        d.paymentPlan = cf("installment plan?", "installment plan", "payment plan");
        d.noRetainerReferTo = cf("no retainer; reject or refer to", "reject or refer to");
        d.other = cf("other");
        d.dueAtSigning = cf("due at signing");
        // Use exact-only so we don't fuzzy-match "Number of Installments (Contracts)" — Contract/Agreement Setup tab field
        d.numInstallments = cfExact("number of installments", "# of installments");
        d.dueDate = cf("due date", "installment due day");
        d.startDate = cf("start date", "installment start month");
        d.cashDiscount = cf("cash discount");
        d.cashDiscountPaidBy = cf("cash discount paid by", "if paid by");
        d.courtesyDiscount = cf("courtesy discount");
        d.courtesyNotes = cf("courtesy discount notes");

        return d;
    }

    // ── Main generate function ──
    function generatePDF(opportunityId) {
        if (!pdfLibLoaded || !window.PDFLib) { alert("PDF library still loading. Please wait."); return Promise.resolve(); }
        console.log("Frye Consult: Generating for opportunity", opportunityId);

        return getAuthToken().then(function(token) {
            return Promise.all([
                ghlFetch("/opportunities/" + opportunityId, token),
                fetchFieldDefs(token),
                token
            ]);
        }).then(function(results) {
            var oppData = results[0].opportunity || results[0];
            var fieldDefs = results[1];
            var token = results[2];
            console.log("Frye Consult: Opportunity data", oppData);
            var contactId = oppData.contactId || (oppData.contact && oppData.contact.id);
            return fetchContact(contactId, token).then(function(fullContact) {
                return fetchAppointments(contactId, token).then(function(appts) {
                    var appointment = pickAppointment(appts);
                    return mapApiToFields(oppData, fieldDefs, fullContact, appointment, contactId);
                });
            });
        }).then(function(data) {
            // console.log("Frye Consult: Mapped fields", data);
            return fetchTemplate().then(function(tpl) { fillTemplate(data, tpl); });
        }).catch(function(err) {
            console.error("Frye Consult: Generate error:", err);
            alert("Error generating PDF: " + err.message + "\nCheck console for details.");
        });
    }

    // ── Scanning ──
    window.addEventListener("routeChangeEvent", function (eev) {
        clearInterval(fryeConsultInterval);
        if (eev && eev.detail && eev.detail.to && eev.detail.to.params && eev.detail.to.params.location_id == FRYE_LOCATION_ID) {
            startScanning();
        }
    });
    if (window.location.href.indexOf(FRYE_LOCATION_ID) > -1) startScanning();

    function startScanning() {
        clearInterval(fryeConsultInterval);
        fryeConsultInterval = setInterval(function () { scanCards(); }, 500);
    }

    // ── Card button (generates without opening modal) ──
    // Uses same DOM approach as adiv1.js: .crm-opportunities-card with header id = opportunityId
    function scanCards() {
        var cards = document.querySelectorAll(".crm-opportunities-card");
        if (!cards.length) return;
        var toAdd = 0;
        cards.forEach(function (card) {
            if (card.classList.contains("frye_consult_added")) return;
            card.classList.add("frye_consult_added");
            toAdd++;
            addConsultBtn(card);
        });
        if (toAdd) console.log("Frye Consult: scanCards processing", toAdd, "new card(s) of", cards.length, "total");
    }

    function addConsultBtn(card) {
        try {
        // Insert into the same icon container that adiv1.js uses
        var iconContainer = card.querySelector("div.flex.pt-2\\.5");
        if (!iconContainer) { console.warn("Frye Consult: addConsultBtn — no iconContainer found on card", card); return; }
        iconContainer.style.overflow = "visible";
        iconContainer.style.flexWrap = "wrap";

        // Clone the existing icon wrapper for consistent styling
        var existingIcon = iconContainer.querySelector(".mb-0\\.5.h-3\\.5");
        var wrapper = existingIcon ? existingIcon.cloneNode(false) : document.createElement("div");
        wrapper.classList.add("frye_consult_btn");
        wrapper.innerHTML = "";
        wrapper.style.cssText = "position:relative;cursor:pointer;margin-right:6px;";

        wrapper.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="mr-2.5 h-4 w-4 cursor-pointer text-gray-500" style="color:#165def"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>';

        var tooltip = document.createElement("div");
        tooltip.textContent = "Consultation PDF";
        tooltip.style.cssText = "visibility:hidden;opacity:0;transition:opacity 0.2s;background:#111827;color:#fff;padding:4px 8px;border-radius:4px;position:absolute;bottom:140%;left:50%;transform:translateX(-50%);font-size:11px;white-space:nowrap;z-index:10000;pointer-events:none;";
        wrapper.appendChild(tooltip);

        wrapper.addEventListener("mouseenter", function() { tooltip.style.visibility = "visible"; tooltip.style.opacity = "1"; });
        wrapper.addEventListener("mouseleave", function() { tooltip.style.visibility = "hidden"; tooltip.style.opacity = "0"; });

        wrapper.addEventListener("click", function (e) {
            e.stopPropagation(); e.preventDefault();
            var oppId = getCardOpportunityId(card);
            if (!oppId) {
                console.error("Frye Consult: Could not extract opportunity ID from card", card);
                alert("Could not find opportunity ID. Try opening the card and using the button there.");
                return;
            }
            console.log("Frye Consult: Card button → oppId:", oppId);
            generatePDF(oppId);
        });

        var lastIcon = iconContainer.lastElementChild;
        if (lastIcon) iconContainer.insertBefore(wrapper, lastIcon);
        else iconContainer.appendChild(wrapper);
        console.log("Frye Consult: button inserted for card", getCardOpportunityId(card));
        } catch (err) {
            console.error("Frye Consult: addConsultBtn threw", err);
        }
    }

    // ── PDF fill + preview ──
    function fillTemplate(data, templateBytes) {
        var PDFLib = window.PDFLib;
        PDFLib.PDFDocument.load(templateBytes).then(function(pdfDoc) {
            return Promise.all([pdfDoc, pdfDoc.embedFont(PDFLib.StandardFonts.Helvetica), pdfDoc.embedFont(PDFLib.StandardFonts.HelveticaBold)]);
        }).then(function(results) {
            var pdfDoc = results[0], font = results[1], fontBold = results[2];
            var pages = pdfDoc.getPages();
            var p1 = pages[0], p2 = pages[1];
            var H = 792, sz = 9, szSm = 8, color = PDFLib.rgb(0, 0, 0);

            function txt(page, text, x, yTop, size, f) { if (!text) return; page.drawText(String(text).replace(/\r?\n/g, " "), {x:x, y:H-yTop, size:size||sz, font:f||font, color:color}); }
            function chk(page, checked, x, yTop) { if (checked) txt(page, "X", x+1, yTop, 10, fontBold); }
            function m(v, t) { return v != null && String(v).toLowerCase().indexOf(String(t).toLowerCase()) > -1; }
            function wrap(text, f, s, mw) {
                if (!text) return [];
                var lines = [], segments = String(text).split(/\r?\n/);
                for (var si = 0; si < segments.length; si++) {
                    var words = segments[si].split(" "), cur = "";
                    for (var i = 0; i < words.length; i++) { var t = cur ? cur + " " + words[i] : words[i]; if (f.widthOfTextAtSize(t, s) > mw && cur) { lines.push(cur); cur = words[i]; } else { cur = t; } }
                    if (cur) lines.push(cur);
                }
                return lines;
            }
            // Trims text with a trailing ellipsis so it fits maxWidth at the given size
            function ellipsize(text, fnt, size, maxWidth) {
                if (fnt.widthOfTextAtSize(text, size) <= maxWidth) return text;
                var t = text;
                while (t.length > 1 && fnt.widthOfTextAtSize(t + "…", size) > maxWidth) t = t.slice(0, -1);
                return t.replace(/\s+$/, "") + "…";
            }
            // Single-line field: fixed font size, ellipsis if the value exceeds maxWidth
            function txtMax(page, text, x, yTop, maxWidth, size, f) {
                if (!text) return;
                var fnt = f || font, s = size || sz;
                txt(page, ellipsize(String(text).replace(/\r?\n/g, " "), fnt, s, maxWidth), x, yTop, s, fnt);
            }
            // Multi-line box: fixed font size, wraps to maxWidth; last allowed line gets an ellipsis if text overflows maxLines
            function wrapMax(page, text, x, yTop, mw, maxLines, size, lh, f) {
                if (!text) return;
                var fnt = f || font, s = size || szSm, lines = wrap(text, fnt, s, mw);
                if (lines.length > maxLines) {
                    lines = lines.slice(0, maxLines);
                    lines[maxLines - 1] += "…";
                }
                for (var i = 0; i < lines.length; i++) txt(page, ellipsize(lines[i], fnt, s, mw), x, yTop + (i * lh), s, fnt);
            }

            // ── PAGE 1 ── (new PDF: u5ppdW-Unknown-5 (1).pdf)
            // Every text field is clipped with an ellipsis at its own max width (pt) so it never overlaps the next label/line
            // Header — Consult Status / Type / Matter Qualified + Date/Time/Intaker/Scheduled
            chk(p1, m(data.consultStatus,"Completed"), 72, 113); chk(p1, m(data.consultStatus,"Cancelled"), 72, 126); chk(p1, m(data.consultStatus,"No Show"), 72, 139);
            chk(p1, m(data.consultType,"In Person"), 180, 113); chk(p1, m(data.consultType,"Zoom"), 180, 126); chk(p1, m(data.consultType,"Phone"), 180, 139);
            chk(p1, m(data.matterQualified,"Yes"), 288, 113); chk(p1, m(data.matterQualified,"No"), 288, 126);
            txtMax(p1, data.date, 426, 100, 110); txtMax(p1, data.time, 428, 113, 108);
            txtMax(p1, data.intaker, 438, 126, 95); txtMax(p1, data.scheduledBy, 438, 139, 95);
            // Reason not qualified + Staff (Staff left blank intentionally)
            txtMax(p1, data.reasonNotQualified, 186, 158, 200);
            // PNC Name + DOB
            txtMax(p1, data.pncName, 134, 179, 170); txtMax(p1, data.dob, 360, 179, 175);
            // Phone + Email
            txtMax(p1, data.phone, 110, 194, 190); txtMax(p1, data.email, 342, 194, 195);
            // Mailing Address
            txtMax(p1, data.mailingAddress, 156, 209, 380);
            // Military + Legal Status
            txtMax(p1, data.militaryStatus, 147, 223, 158); txtMax(p1, data.legalStatus, 376, 223, 160);
            // Charges
            txtMax(p1, data.charges, 118, 237, 418, szSm);
            // DoI / DoA / Court / County
            txtMax(p1, data.doi, 95, 251, 80); txtMax(p1, data.doa, 205, 251, 82);
            txtMax(p1, data.court, 325, 251, 65);
            txtMax(p1, data.county, 445, 251, 90);
            // Primary Source / Subsource / Client Reported Source
            txtMax(p1, data.primarySource, 150, 265, 65);
            txtMax(p1, data.subSource, 285, 265, 65);
            txtMax(p1, data.clientReportedSource, 478, 265, 58);
            // Incident Notes box (x=74-540, y=290-539) — big box, ~19 lines
            wrapMax(p1, data.incidentNotes, 80, 302, 458, 19, szSm, 12);
            // Involved Parties (left) + Priors (right) — side-by-side at y=561-599
            wrapMax(p1, data.involvedParties, 80, 573, 226, 2, szSm, 12);
            wrapMax(p1, data.priors, 318, 573, 216, 2, szSm, 12);
            // Employer/Employment — inline on underline (label at y=608)
            txtMax(p1, data.employer, 196, 619, 338);
            // Employment Impact (left) + Medical Diagnosis (right) — side-by-side at y=649-687
            wrapMax(p1, data.employmentImpact, 80, 661, 226, 2, szSm, 12);
            wrapMax(p1, data.medicalDiagnosis, 318, 661, 216, 2, szSm, 12);
            // Desired Outcome (left) + Biggest Concerns (right) — moved to page 1 in new PDF, y=712-751
            wrapMax(p1, data.desiredOutcome, 80, 724, 226, 2, szSm, 12);
            wrapMax(p1, data.biggestConcerns, 318, 724, 216, 2, szSm, 12);

            // ── PAGE 2 ── (new PDF)
            // Attorney Notes box (x=72-541, y=106-423) — big box, ~25 lines
            wrapMax(p2, data.attorneyNotes, 80, 118, 458, 25, szSm, 12);
            // To Do if Retained (left) + Assign To (right) — box y=450-530, 5 sub-rows (~16pt each)
            wrapMax(p2, data.todoIfRetained, 80, 462, 222, 5, szSm, 16);
            wrapMax(p2, data.assignTo, 312, 462, 224, 5, szSm, 16);
            // Emergency Contact + Relationship to PNC (label y=541, line value y≈553)
            txtMax(p2, data.emergencyContact, 185, 553, 132); txtMax(p2, data.relationshipToPNC, 434, 553, 102);
            txtMax(p2, data.emergencyPhone, 112, 572, 132); txtMax(p2, data.emergencyEmail, 285, 572, 248);
            // Pre-Warrant/Bond Only (left) + Retainer Only (right) — labels at y=577
            txtMax(p2, data.retainerOnly, 405, 590, 66);
            // Retainer + Trial $___ + $___ (label y=594) — single retainerPlusTrial value goes in first $
            txtMax(p2, data.retainerPlusTrial, 185, 606, 60);
            // Single Payment Retainer (left) + No Retainer; Reject or Refer to (right) — y=607
            chk(p2, m(data.singlePaymentRetainer,"Yes")||m(data.singlePaymentRetainer,"Single"), 72, 619);
            txtMax(p2, data.noRetainerReferTo, 410, 619, 98);
            // Payment Plan checkbox (left) — checked when "Installment Plan?" opp field is Yes
            chk(p2, m(data.paymentPlan,"Yes"), 72, 633);
            // Other (right of Payment Plan) — y=621
            txtMax(p2, data.other, 235, 633, 272);
            // Due at Signing / # of Installments / Due Date 10th/20th (labels y=637)
            txtMax(p2, data.dueAtSigning, 170, 649, 58); txtMax(p2, data.numInstallments, 330, 649, 50);
            chk(p2, m(data.dueDate,"10"), 440, 649); chk(p2, m(data.dueDate,"20"), 479, 649);
            // Start Date / Cash Discount / if paid by (label y=654)
            txtMax(p2, data.startDate, 133, 666, 62); txtMax(p2, data.cashDiscount, 310, 666, 54); txtMax(p2, data.cashDiscountPaidBy, 420, 666, 92);
            // Courtesy Discount / Notes (label y=687)
            txtMax(p2, data.courtesyDiscount, 181, 699, 66); txtMax(p2, data.courtesyNotes, 290, 699, 222);
            // Calendar Fee Paid / Reason Waived (label y=707)
            var cfpV = data.calendarFeePaid;
            var cfpYes = cfpV === true || m(cfpV,"true") || m(cfpV,"yes") || m(cfpV,"paid") || m(cfpV,"1");
            var cfpNo  = cfpV === false || m(cfpV,"false") || m(cfpV,"no") || m(cfpV,"unpaid") || m(cfpV,"waived");
            txt(p2, cfpYes ? "Yes" : (cfpNo ? "No" : ""), 175, 719);
            txtMax(p2, data.reasonWaived, 290, 719, 222);

            return pdfDoc.save();
        }).then(function(filledBytes) {
            var blob = new Blob([filledBytes], {type:"application/pdf"});
            showPreview(blob, data);
        }).catch(function(err) { console.error("Frye Consult: Fill error:", err); });
    }

    function showPreview(blob, data) {
        var ex = document.querySelector(".frye-pdf-popup-container"); if (ex) ex.remove();
        var url = URL.createObjectURL(blob);
        var c = document.createElement("div"); c.className = "frye-pdf-popup-container";
        c.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;";
        var p = document.createElement("div"); p.style.cssText = "background:white;border-radius:8px;width:80%;max-width:900px;height:85vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.3);";
        var h = document.createElement("div"); h.style.cssText = "display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid #e5e7eb;";
        var t = document.createElement("span"); t.textContent = "Consultation - " + (data.pncName || "Preview"); t.style.cssText = "font-weight:600;font-size:14px;";
        var bg = document.createElement("div"); bg.style.cssText = "display:flex;gap:8px;";
        var db = document.createElement("button"); db.textContent = "Download PDF"; db.style.cssText = "background:#165def;color:white;border:none;border-radius:5px;padding:6px 14px;cursor:pointer;font-size:13px;";
        var isSaving = false;
        var closePreview = function() { URL.revokeObjectURL(url); c.remove(); };
        db.onclick = function() {
            var baseName = "Consultation_" + (data.pncName||"Form").replace(/\s+/g,"_");
            // Local download keeps clean filename
            var a = document.createElement("a"); a.href = url; a.download = baseName + ".pdf"; a.click();
            // Upload to contact's Documents tab — append timestamp so each upload is unique
            // (GHL rejects /documents/ POST with 400 when a same-name doc already exists on the contact)
            if (!data.contactId) { console.warn("Frye Consult: no contactId, skipping Documents-tab upload"); return; }
            var now = new Date();
            var pad2 = function(n) { return n < 10 ? "0" + n : "" + n; };
            var stamp = now.getFullYear() + pad2(now.getMonth()+1) + pad2(now.getDate()) + "_" +
                        pad2(now.getHours()) + pad2(now.getMinutes()) + pad2(now.getSeconds());
            var uploadFilename = baseName + "_" + stamp + ".pdf";
            isSaving = true;
            db.disabled = true; db.textContent = "Saving to contact…";
            cb.disabled = true; cb.style.cursor = "not-allowed"; cb.style.opacity = "0.4";
            uploadConsultationToContact(blob, uploadFilename, data.contactId, data.locationId)
                .then(function(docId) {
                    console.log("Frye Consult: Uploaded to Documents tab, id=", docId);
                    db.textContent = "Saved ✓";
                    // Auto-close preview after save completes
                    setTimeout(closePreview, 600);
                })
                .catch(function(err) {
                    console.error("Frye Consult: Documents-tab upload failed:", err);
                    db.textContent = "Upload failed";
                    // Restore close controls so user can dismiss the failed preview
                    isSaving = false;
                    cb.disabled = false; cb.style.cursor = "pointer"; cb.style.opacity = "1";
                    setTimeout(function() { db.textContent = "Download PDF"; db.disabled = false; }, 3000);
                });
        };
        var cb = document.createElement("button"); cb.textContent = "\u00D7"; cb.style.cssText = "background:none;border:none;font-size:22px;cursor:pointer;color:#6b7280;padding:0 4px;";
        cb.onclick = function() { if (isSaving) return; closePreview(); };
        bg.appendChild(db); bg.appendChild(cb); h.appendChild(t); h.appendChild(bg);
        var ifr = document.createElement("iframe"); ifr.src = url; ifr.style.cssText = "flex:1;border:none;border-radius:0 0 8px 8px;";
        p.appendChild(h); p.appendChild(ifr); c.appendChild(p);
        c.addEventListener("click", function(e) { if (e.target === c && !isSaving) closePreview(); });
        document.body.appendChild(c);
    }

})();

// consultation end
