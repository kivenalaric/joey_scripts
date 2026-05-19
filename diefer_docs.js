// Diefer Law — GHL Signed Document PDF Extractor
// Location: lBnuc60iFX6sUeorE7Oi
//
// GHL document viewer links (https://link.infosubmit.co/documents/v1/...)
// are NOT direct file links. This server uses a headless browser to open
// the viewer page, intercepts the real PDF request by content-type, and
// returns the actual downloadable URL to n8n.
//
// n8n flow:
//   GHL webhook (Document Signed) → POST /extract-pdf → GET pdfUrl → Drive upload

const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Simple concurrency limiter — prevents server OOM from simultaneous Puppeteer instances
const MAX_CONCURRENT = 3;
let active = 0;
const queue = [];

function acquireSlot() {
    return new Promise(resolve => {
        if (active < MAX_CONCURRENT) {
            active++;
            resolve();
        } else {
            queue.push(resolve);
        }
    });
}

function releaseSlot() {
    active--;
    if (queue.length > 0) {
        active++;
        const next = queue.shift();
        next();
    }
}

// Health check
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', active, queued: queue.length });
});

// POST /extract-pdf
// Body: { "link": "https://link.infosubmit.co/documents/v1/..." }
// Returns: { "pdfUrl": "https://storage.googleapis.com/..." }
app.post('/extract-pdf', async (req, res) => {
    const { link } = req.body;

    if (!link) {
        return res.status(400).json({ error: 'Missing link in request body' });
    }

    if (!link.startsWith('http')) {
        return res.status(400).json({ error: 'Invalid link format' });
    }

    await acquireSlot();

    let browser;

    try {
        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        });

        const page = await browser.newPage();

        // Set a real user-agent so the viewer page loads normally
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        let pdfUrl = null;

        // Intercept responses — check content-type for PDF, not URL pattern
        // GHL/Google Storage URLs do NOT always contain ".pdf" in the path
        page.on('response', async response => {
            if (pdfUrl) return; // already found it

            const contentType = response.headers()['content-type'] || '';
            const url = response.url();

            const isPdf =
                contentType.includes('application/pdf') ||
                url.match(/\.pdf($|\?)/i);

            if (isPdf) {
                pdfUrl = url;
            }
        });

        await page.goto(link, {
            waitUntil: 'networkidle2',
            timeout: 60000
        });

        // If the viewer uses an iframe, wait for it and check src
        if (!pdfUrl) {
            try {
                await page.waitForSelector('iframe', { timeout: 8000 });
                const iframeSrc = await page.$eval('iframe', el => el.src).catch(() => null);
                if (iframeSrc && iframeSrc.match(/\.pdf($|\?)/i)) {
                    pdfUrl = iframeSrc;
                }
            } catch (_) {
                // no iframe found, continue
            }
        }

        await browser.close();
        browser = null;

        if (!pdfUrl) {
            return res.status(404).json({
                error: 'PDF not found in page network activity',
                hint: 'The viewer may use a different loading mechanism. Check /health and try again.'
            });
        }

        console.log(`[Diefer] Extracted PDF for: ${link}`);
        console.log(`[Diefer] PDF URL: ${pdfUrl}`);

        res.json({ pdfUrl });

    } catch (err) {
        console.error(`[Diefer] Error extracting PDF:`, err.message);

        if (browser) {
            await browser.close().catch(() => {});
        }

        res.status(500).json({ error: err.message });

    } finally {
        releaseSlot();
    }
});

app.listen(PORT, () => {
    console.log(`[Diefer] PDF extractor running on port ${PORT}`);
    console.log(`[Diefer] Max concurrent Puppeteer sessions: ${MAX_CONCURRENT}`);
});
