const express = require('express');
const WebSocket = require('ws');
const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');
const { isValid } = require('./key');

const app = express();
app.use(express.json());

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// --- Decoder XOR Logic (Tetap pake yang asli) --- wkkw
function decodeURIData(encodedString, prefixLength = 5) {
    const base64Decoded = Buffer.from(encodedString, 'base64').toString('binary');
    const prefix = base64Decoded.substring(0, prefixLength);
    const body = base64Decoded.substring(prefixLength);
    let decoded = '';
    for (let i = 0; i < body.length; i++) {
        decoded += String.fromCharCode(body.charCodeAt(i) ^ prefix.charCodeAt(i % prefix.length));
    }
    return decoded;
}

async function getLootData(lootUrl) {
    console.log(`[BROWSER] Launching browser...`);
    const browser = await puppeteer.launch({
        headless: "new",
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars'
        ]
    });

    const page = await browser.newPage();
    let lootParams = null;

    page.on('response', async response => {
        const url = response.url();
        try {
            const text = await response.text();
            if (text.includes('urid')) {
                console.log(`[BROWSER] Found urid in response from: ${url}`);
                const json = JSON.parse(text);
                const item = Array.isArray(json) ? json[0] : json;
                if (item && item.urid) {
                    lootParams = {
                        urid: item.urid,
                        pixel: item.action_pixel_url,
                        task_id: item.task_id || 8
                    };
                }
            }
        } catch (e) {}
    });

    await page.setUserAgent(UA);
    
    try {
        await page.goto(lootUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        await page.evaluate(() => window.scrollBy(0, 500));

        console.log('[BROWSER] Waiting 8 seconds for page to fully load...');
        await new Promise(r => setTimeout(r, 8000));

        const html = await page.content();
        const $ = cheerio.load(html);
        let extracted = { 
            TID: null, KEY: null, 
            SERVER: "onsultingco.com", 
            SYNCER: "nerventualken.com", 
            SESSION: null 
        };

        $('script').each((i, el) => {
            const content = $(el).html();
            if (content) {
                const keyM = content.match(/p\['KEY'\]\s*=\s*["'](\d+)["']/);
                const tidM = content.match(/p\['TID'\]\s*=\s*(\d+)/);
                const srvM = content.match(/INCENTIVE_SERVER_DOMAIN\s*=\s*["']([^"']+)["']/);
                const syncM = content.match(/INCENTIVE_SYNCER_DOMAIN\s*=\s*["']([^"']+)["']/);

                if (keyM) extracted.KEY = keyM[1];
                if (tidM) extracted.TID = tidM[1];
                if (srvM) extracted.SERVER = srvM[1];
                if (syncM) extracted.SYNCER = syncM[1];
            }
        });

        extracted.SESSION = await page.evaluate(() => document.session || null);

        if (!lootParams || !extracted.KEY) {
            await browser.close();
            throw new Error('Gagal narik data p[KEY] atau URID via Parser!');
        }

        console.log(`[BROWSER] task_id: ${lootParams.task_id}`);
        console.log(`[BROWSER] urid: ${lootParams.urid}`);
        console.log(`[BROWSER] action_pixel_url: ${lootParams.pixel}`);
        console.log(`[BROWSER] Data Extracted -> TID: ${extracted.TID}, KEY: ${extracted.KEY}`);
        console.log(`[BROWSER] Session: ${extracted.SESSION}`);

        return { ...lootParams, ...extracted, browser };

    } catch (e) {
        if (browser) await browser.close();
        throw e;
    }
}

async function resolvePublisherLink(data) {
    const shard = data.urid.substr(-5) % 3;
    const hostname = `${shard}.${data.SERVER}`;

    const wsUrl = `wss://${hostname}/c?uid=${data.urid}&cat=${data.task_id}&key=${data.KEY}&session_id=${data.SESSION}&is_loot=1&tid=${data.TID}`;
    console.log(`[WS] Connecting to: ${wsUrl}`);

    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl, {
            origin: `https://${hostname}`,
            headers: { 'user-agent': UA }
        });

        let hb;
        let PUBLISHER_LINK = "";
        let resolved = false;

        const timeout = setTimeout(() => {
            if (!resolved) {
                ws.terminate();
                reject(new Error('WebSocket timed out after 200s'));
            }
        }, 200000);

        ws.on('open', () => {
            console.log('[WS] Connected!');
            
            hb = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) ws.send('0');
            }, 1000);

            (async () => {
                try {
                    const base = `https://${hostname}`;
                    await axios.get(`${base}/st?uid=${data.urid}&cat=${data.task_id}`);
                    await axios.get(`${base}/p?uid=${data.urid}`);
                    const px = data.pixel.startsWith('http') ? data.pixel : `https:${data.pixel}`;
                    await axios.get(px);
                    await axios.get(`https://${data.SYNCER}/td?ac=auto_complete&urid=${data.urid}&cat=${data.task_id}&tid=${data.TID}`);
                    await axios.get(`${base}/ad?uid=${data.urid}`);
                    console.log("[WS] Signals sent successfully.");
                } catch (err) {}
            })();
        });

        ws.on('message', (buffer) => {
            const msg = buffer.toString();
            console.log('[WS] RAW Message:', JSON.stringify(msg), 'Length:', msg.length);

            if (msg.startsWith('r:')) {
                PUBLISHER_LINK = msg.replace('r:', '').trim();
                console.log('[WS] Got publisher link from r: prefix:', PUBLISHER_LINK);
            }

            if (!msg.includes(',') && msg.length > 25 && !msg.includes('aaaa')) {
                console.log('[WS] Attempting decode on message length', msg.length);
                try {
                    const decoded = decodeURIComponent(decodeURIData(msg));
                    if (decoded.includes('http')) {
                        PUBLISHER_LINK = msg;
                        console.log('[WS] Confirmed link via manual decode!');
                    }
                } catch(e) {}
            }
        });

        ws.on('close', () => {
            clearInterval(hb);
            clearTimeout(timeout);
            console.log('[WS] Connection closed. PUBLISHER_LINK:', PUBLISHER_LINK);
            if (PUBLISHER_LINK) {
                resolved = true;
                resolve(PUBLISHER_LINK);
            } else {
                reject(new Error('WebSocket closed without link result.'));
            }
        });

        ws.on('error', (err) => {
            clearInterval(hb);
            reject(err);
        });
    });
}

app.get('/bypass', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'Missing ?url=' });

    try {
        console.log(`[1/3] Launching browser for: ${url}`);
        const lootData = await getLootData(url);

        console.log(`[2/3] Got urid: ${lootData.urid} | task_id: ${lootData.task_id}`);
        console.log(`[3/3] Connecting WebSocket and firing pixels after connection...`);
        
        const encodedLink = await resolvePublisherLink(lootData);
        const finalUrl = decodeURIComponent(decodeURIData(encodedLink));

        await lootData.browser.close();

        console.log(`[✓] Resolved: ${finalUrl}`);
        return res.json({ success: true, bypassed: finalUrl });

    } catch (err) {
        console.error(`[✗] Error:`, err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.listen(3100, () => {
    console.log(`Server running on port 3100`);
    console.log(`Usage: GET /bypass?url=https://loot-link.com/s?...`);
});
