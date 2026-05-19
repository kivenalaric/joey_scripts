# Frye Law Group — UTM Parameter Fix

## What This Does
Captures UTM parameters (utm_source, utm_medium, utm_campaign, etc.) from the page URL
and passes them into the GHL contact record every time someone submits a form on the site.

---

## Part 1 — Script for the WordPress Site
*(Hand this to Frye or their WordPress developer)*

Ask them to paste the following code into their site's `<head>`. They can do this via:
- A plugin like **"Insert Headers and Footers"** (WPCode) — free, no developer needed
- Or their developer can drop it in `functions.php` or the theme header

```html
<script>
(function () {
    var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

    // Save UTMs from the landing page URL into sessionStorage
    var params = new URLSearchParams(window.location.search);
    UTM_KEYS.forEach(function (key) {
        if (params.has(key)) sessionStorage.setItem(key, params.get(key));
    });

    // Build UTM query string from sessionStorage
    function getUtmString() {
        return UTM_KEYS
            .map(function (key) {
                var val = sessionStorage.getItem(key);
                return val ? key + '=' + encodeURIComponent(val) : null;
            })
            .filter(Boolean)
            .join('&');
    }

    // Append UTMs to a GHL iframe src
    function injectIntoIframe(iframe) {
        if (!iframe.src || iframe.dataset.utmDone) return;
        var utmString = getUtmString();
        if (!utmString) return;
        iframe.src += (iframe.src.includes('?') ? '&' : '?') + utmString;
        iframe.dataset.utmDone = 'true';
    }

    function processAll() {
        document.querySelectorAll('iframe').forEach(injectIntoIframe);
    }

    // Watch for iframes that load after the page
    var observer = new MutationObserver(function (mutations) {
        mutations.forEach(function (mutation) {
            mutation.addedNodes.forEach(function (node) {
                if (node.tagName === 'IFRAME') injectIntoIframe(node);
                if (node.querySelectorAll) node.querySelectorAll('iframe').forEach(injectIntoIframe);
            });
        });
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            processAll();
            observer.observe(document.body, { childList: true, subtree: true });
        });
    } else {
        processAll();
        observer.observe(document.body, { childList: true, subtree: true });
    }
})();
</script>
```

---

## Part 2 — GHL Form Configuration
*(Done inside GHL — no website access needed)*

For each UTM parameter, add a hidden field in the GHL form builder:

| Field Label   | Field Type | Default Value (URL param) | Maps to Custom Field |
|---------------|------------|---------------------------|----------------------|
| UTM Source    | Hidden     | `utm_source`              | UTM Source           |
| UTM Medium    | Hidden     | `utm_medium`              | UTM Medium           |
| UTM Campaign  | Hidden     | `utm_campaign`            | UTM Campaign         |
| UTM Term      | Hidden     | `utm_term`                | UTM Term             |
| UTM Content   | Hidden     | `utm_content`             | UTM Content          |

**Steps:**
1. Open the form in GHL Form Builder
2. Add a **Hidden Field** for each row above
3. Set the field's **"Pre-populate via URL parameter"** value to the URL param name (e.g. `utm_source`)
4. Make sure each field is mapped to the corresponding **custom contact field**
5. Save and republish the form

---

## How It All Works Together

```
User clicks ad with UTMs in URL
        ↓
WordPress site loads → script saves UTMs to sessionStorage
        ↓
Script rewrites GHL iFrame src to include UTMs as query params
        ↓
GHL form loads with UTMs in its own URL
        ↓
Hidden fields read UTMs from URL → populated on submit
        ↓
GHL contact record shows utm_source, utm_medium, utm_campaign, etc.
```

---

## Notes
- The sessionStorage save means UTMs are preserved even if the visitor navigates
  to another page before hitting the form
- The script is wrapped in an IIFE so it won't conflict with any other JS on the site
- The MutationObserver handles forms that load dynamically (e.g. popup forms)
