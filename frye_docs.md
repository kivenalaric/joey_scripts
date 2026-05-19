# Frye Law Group — UTM Parameter Fix

## What This Does
Captures UTM parameters (utm_source, utm_medium, utm_campaign, etc.) from the page URL
and passes them into the GHL contact record every time someone submits a form on the site.

---

## Script for the WordPress Site
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