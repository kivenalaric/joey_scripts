// consultation start 

(function () {

    var FRYE_LOCATION_ID = "oUKKuxKyYWHUoncYOKhr";
    var fryeConsultInterval;
    var FRYE_PDF_URL = "https://raw.githubusercontent.com/kivenalaric/joes_files/main/frye_new_docs.pdf";
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

    var cachedUsers = {};
    function fetchUserName(userId, token) {
        if (!userId) return Promise.resolve("");
        if (cachedUsers[userId]) return Promise.resolve(cachedUsers[userId]);
        return ghlFetch("/users/" + userId, token).then(function(data) {
            // data.name is already the full name — don't append lastName again (caused "Paul Stewart Stewart")
            var name = (data.name || ((data.firstName || "") + " " + (data.lastName || ""))).trim();
            cachedUsers[userId] = name;
            return name;
        }).catch(function() { return ""; });
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
    function mapApiToFields(opp, fieldDefs, ownerName, fullContact, appointment, contactId) {
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
        // Intaker + Scheduled by — default GHL Assigned User on the contact
        d.intaker = ownerName || "";
        d.scheduledBy = ownerName || "";
        d.staff = cf("assigned attorney", "assigned attorney (opportunity details)");
        d.legalStatus = cf("citizenship", "citizenship (criminal defense)", "legal status");
        d.calendarFeePaid = cf("calendar fee paid");
        d.reasonWaived = cf("reason waived");

        d.consultStatus = cf("consult status/type", "consult status");
        d.consultType = cf("consult status/type", "consult type");
        d.matterQualified = cf("matter qualified");
        d.reasonNotQualified = cf("reason not qualified");

        // PNC Info — Criminal Defense Intake
        d.pncName = cf("pnc is currently represented by", "pnc name", "contact name") || contact.name || "";

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
        d.priors = cf("prior criminal record", "prior criminal records", "prior charges/arrests", "priors", "prior");
        d.employer = cf("client employer/employment", "employer/employment", "employer");
        d.employmentImpact = cf("employment impact");
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
        d.paymentPlan = cf("payment plan");
        d.noRetainerReferTo = cf("no retainer; reject or refer to", "reject or refer to");
        d.other = cf("other");
        d.dueAtSigning = cf("due at signing");
        d.numInstallments = cf("number of installments", "# of installments");
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
                // console.log("Frye Consult: Contact data", fullContact);
                // Prefer contact.assignedTo (default GHL field on contact) over the opportunity's owner
                var assignedUserId = fullContact.assignedTo || oppData.assignedTo;
                return Promise.all([
                    fetchUserName(assignedUserId, token),
                    fetchAppointments(contactId, token)
                ]).then(function(extras) {
                    var ownerName = extras[0];
                    var appointment = pickAppointment(extras[1]);
                    // console.log("Frye Consult: Appointment", appointment);
                    return mapApiToFields(oppData, fieldDefs, ownerName, fullContact, appointment, contactId);
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
        cards.forEach(function (card) {
            if (card.classList.contains("frye_consult_added")) return;
            card.classList.add("frye_consult_added");
            addConsultBtn(card);
        });
    }

    function addConsultBtn(card) {
        // Insert into the same icon container that adiv1.js uses
        var iconContainer = card.querySelector("div.flex.pt-2\\.5");
        if (!iconContainer) return;
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

            function txt(page, text, x, yTop, size, f) { if (!text) return; page.drawText(String(text), {x:x, y:H-yTop, size:size||sz, font:f||font, color:color}); }
            function chk(page, checked, x, yTop) { if (checked) txt(page, "X", x+1, yTop, 10, fontBold); }
            function m(v, t) { return v != null && String(v).toLowerCase().indexOf(String(t).toLowerCase()) > -1; }
            function wrap(text, f, s, mw) {
                if (!text) return [];
                var words = text.split(" "), lines = [], cur = "";
                for (var i = 0; i < words.length; i++) { var t = cur ? cur + " " + words[i] : words[i]; if (f.widthOfTextAtSize(t, s) > mw && cur) { lines.push(cur); cur = words[i]; } else { cur = t; } }
                if (cur) lines.push(cur); return lines;
            }
            // Single-line auto-shrink: reduces size until text fits maxWidth (min 5)
            function txtFit(page, text, x, yTop, maxWidth, baseSize, f) {
                if (!text) return;
                var fnt = f || font, size = baseSize || sz;
                while (size > 5 && fnt.widthOfTextAtSize(String(text), size) > maxWidth) size -= 0.5;
                txt(page, text, x, yTop, size, fnt);
            }
            // Multi-line auto-shrink: tries baseSize; if wrap exceeds maxLines, shrinks size & line-height
            // until it fits or hits minSize. Truncates last line with ellipsis if still over.
            function wrapFit(page, text, x, yTop, mw, maxLines, baseSize, baseLh, f) {
                if (!text) return;
                var fnt = f || font, size = baseSize || szSm, lh = baseLh || 12;
                var totalH = maxLines * lh, minSize = 5;
                var lines = wrap(text, fnt, size, mw);
                while (lines.length > maxLines && size > minSize) {
                    size -= 0.5;
                    lh = Math.max(size + 1, totalH / Math.ceil(lines.length));
                    if (lh * lines.length > totalH) lh = totalH / lines.length;
                    lines = wrap(text, fnt, size, mw);
                }
                if (lines.length > maxLines) {
                    lh = totalH / lines.length;
                    if (lh < size) { // ensure no overlap; truncate instead
                        lines = lines.slice(0, maxLines);
                        var last = lines[maxLines - 1];
                        while (last.length > 1 && fnt.widthOfTextAtSize(last + "…", size) > mw) last = last.slice(0, -1);
                        lines[maxLines - 1] = last + "…";
                        lh = totalH / maxLines;
                    }
                }
                for (var i = 0; i < lines.length; i++) txt(page, lines[i], x, yTop + (i * lh), size, fnt);
            }

            // PAGE 1 — frye_new_docs.pdf
            // Header: Consult Status / Type / Matter Qualified + Date/Time/Intaker/Scheduled
            chk(p1, m(data.consultStatus,"Completed"), 72, 113); chk(p1, m(data.consultStatus,"Cancelled"), 72, 126); chk(p1, m(data.consultStatus,"No Show"), 72, 139);
            chk(p1, m(data.consultType,"In Person"), 180, 113); chk(p1, m(data.consultType,"Zoom"), 180, 126); chk(p1, m(data.consultType,"Phone"), 180, 139);
            chk(p1, m(data.matterQualified,"Yes"), 288, 113); chk(p1, m(data.matterQualified,"No"), 288, 126);
            txt(p1, data.date, 426, 100); txt(p1, data.time, 428, 113); txt(p1, data.intaker, 438, 126); txt(p1, data.scheduledBy, 438, 139);
            // Reason not qualified + Staff
            txt(p1, data.reasonNotQualified, 186, 158); txt(p1, data.staff, 427, 158);
            // PNC Name + DOB
            txt(p1, data.pncName, 134, 179); txt(p1, data.dob, 360, 179);
            // Phone + Email (shifted up ~14pt from previous iteration — prior text landed on Mailing row)
            txt(p1, data.phone, 110, 194); txt(p1, data.email, 342, 194);
            // Mailing Address
            txt(p1, data.mailingAddress, 156, 209);
            // Military + Legal Status
            txt(p1, data.militaryStatus, 147, 223); txtFit(p1, data.legalStatus, 376, 223, 160, sz);
            // Charges
            txt(p1, data.charges, 118, 237, szSm);
            // DoI / DoA / Court / County (court+county wrap to 2 lines if long)
            txt(p1, data.doi, 95, 251); txt(p1, data.doa, 205, 251);
            txtFit(p1, data.court, 325, 251, 65, sz);
            txtFit(p1, data.county, 445, 251, 90, sz);
            // Primary Source / Subsource / Client Reported Source
            txtFit(p1, data.primarySource, 150, 265, 65, sz);
            txtFit(p1, data.subSource, 285, 265, 65, sz);
            txtFit(p1, data.clientReportedSource, 478, 265, 72, sz);
            // Incident Notes (big box, ~13 lines) — anchor point (keep as-is)
            wrapFit(p1, data.incidentNotes, 82, 325, 440, 13, szSm, 12);
            // Involved Parties (~2 lines) — shift up to land inside box
            wrapFit(p1, data.involvedParties, 82, 502, 440, 2, szSm, 12);
            // Priors (~2 lines)
            wrapFit(p1, data.priors, 82, 562, 440, 2, szSm, 12);
            // Employer/Employment (inline)
            txtFit(p1, data.employer, 202, 593, 340, sz);
            // Employment Impact (~5 lines)
            wrapFit(p1, data.employmentImpact, 82, 628, 440, 5, szSm, 12);
            // Medical Diagnosis (~2 lines)
            wrapFit(p1, data.medicalDiagnosis, 82, 720, 440, 2, szSm, 12);

            // PAGE 2 — frye_new_docs.pdf (Attorney Notes now at top)
            // Attorney Notes (~15 lines)
            wrapFit(p2, data.attorneyNotes, 82, 125, 440, 15, szSm, 12);
            // Desired Outcome + Biggest Concerns (~8 lines)
            wrapFit(p2, data.desiredOutcome, 82, 360, 210, 8, szSm, 12);
            wrapFit(p2, data.biggestConcerns, 312, 360, 210, 8, szSm, 12);
            // To Do if Retained + Assign To (~6 lines)
            wrapFit(p2, data.todoIfRetained, 82, 498, 210, 6, szSm, 12);
            wrapFit(p2, data.assignTo, 312, 498, 210, 6, szSm, 12);
            // Emergency Contact + Relationship to PNC
            txt(p2, data.emergencyContact, 185, 551); txt(p2, data.relationshipToPNC, 434, 551);
            txt(p2, data.emergencyPhone, 112, 571); txt(p2, data.emergencyEmail, 285, 571);
            // Retainer Only $ + Retainer + Trial $
            chk(p2, !!data.retainerOnly, 72, 612); txt(p2, data.retainerOnly, 178, 612);
            chk(p2, !!data.retainerPlusTrial, 251, 612); txt(p2, data.retainerPlusTrial, 365, 612);
            // Single Payment / No Retainer
            chk(p2, m(data.singlePaymentRetainer,"Yes")||m(data.singlePaymentRetainer,"Single"), 72, 632);
            txt(p2, data.noRetainerReferTo, 413, 632);
            // Payment Plan / Other
            chk(p2, m(data.paymentPlan,"Yes")||m(data.paymentPlan,"Payment"), 72, 651);
            txt(p2, data.other, 235, 651);
            // Due at Signing / Installments / Due Date
            txt(p2, data.dueAtSigning, 169, 670); txt(p2, data.numInstallments, 330, 670);
            chk(p2, m(data.dueDate,"10"), 440, 670); chk(p2, m(data.dueDate,"20"), 477, 670);
            // Start Date / Cash Discount / paid by
            txt(p2, data.startDate, 133, 689); txt(p2, data.cashDiscount, 310, 689); txt(p2, data.cashDiscountPaidBy, 412, 689);
            // Courtesy Discount + Notes
            txt(p2, data.courtesyDiscount, 181, 708); txt(p2, data.courtesyNotes, 292, 708);
            // Calendar Fee Paid + Reason Waived
            var cfpV = data.calendarFeePaid;
            var cfpYes = cfpV === true || m(cfpV,"true") || m(cfpV,"yes") || m(cfpV,"paid") || m(cfpV,"1");
            var cfpNo  = cfpV === false || m(cfpV,"false") || m(cfpV,"no") || m(cfpV,"unpaid") || m(cfpV,"waived");
            txt(p2, cfpYes ? "Yes" : (cfpNo ? "No" : ""), 178, 727);
            txtFit(p2, data.reasonWaived, 295, 727, 220, sz);

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
