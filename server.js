/**
 * WhatsApp Bridge Server — Saddara Platform
 * 
 * Endpoints:
 *   POST /session/start   { merchantId }  → start session + return QR
 *   GET  /session/qr      ?merchantId=X   → get latest QR (base64 img src)
 *   GET  /session/status  ?merchantId=X   → get status
 *   POST /send            { merchantId, phone, message }
 *   POST /session/logout  { merchantId }
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const qrcode = require('qrcode');
const app = express();

app.use(express.json());

// In-memory sessions map: merchantId → { client, status, qrDataUrl }
const sessions = {};

// ─── Middleware: simple secret key check ────────────────────────────────────
const SECRET = process.env.BRIDGE_SECRET || 'saddara_wa_bridge_2025';
app.use((req, res, next) => {
    const key = req.headers['x-bridge-key'] || req.query.key;
    if (key !== SECRET) return res.status(401).json({ error: 'Unauthorized' });
    next();
});

// ─── Start or restart a session ─────────────────────────────────────────────
app.post('/session/start', async (req, res) => {
    const { merchantId } = req.body;
    if (!merchantId) return res.status(400).json({ error: 'merchantId required' });

    const mid = String(merchantId);

    // If already connected, return status
    if (sessions[mid] && sessions[mid].status === 'WORKING') {
        return res.json({ success: true, status: 'WORKING', qr: null });
    }

    // Destroy old session if exists
    if (sessions[mid] && sessions[mid].client) {
        try { await sessions[mid].client.destroy(); } catch (e) { }
        delete sessions[mid];
    }

    sessions[mid] = { client: null, status: 'STARTING', qr: null };

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: 'merchant_' + mid, dataPath: './sessions' }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu'
            ]
        }
    });

    sessions[mid].client = client;

    client.on('qr', async (qr) => {
        try {
            sessions[mid].qr = await qrcode.toDataURL(qr);
            sessions[mid].status = 'SCAN_QR_CODE';
            console.log(`[Merchant ${mid}] QR generated`);
        } catch (e) { console.error(e); }
    });

    client.on('authenticated', () => {
        sessions[mid].status = 'AUTHENTICATED';
        sessions[mid].qr = null;
        console.log(`[Merchant ${mid}] Authenticated`);
    });

    client.on('ready', () => {
        sessions[mid].status = 'WORKING';
        sessions[mid].qr = null;
        console.log(`[Merchant ${mid}] Ready`);
    });

    client.on('disconnected', (reason) => {
        sessions[mid].status = 'STOPPED';
        sessions[mid].qr = null;
        console.log(`[Merchant ${mid}] Disconnected: ${reason}`);
    });

    client.on('auth_failure', () => {
        sessions[mid].status = 'AUTH_FAILURE';
        console.log(`[Merchant ${mid}] Auth failure`);
    });

    // Initialize async (don't await — return immediately)
    client.initialize().catch(e => {
        console.error(`[Merchant ${mid}] Init error:`, e.message);
        sessions[mid].status = 'ERROR';
    });

    res.json({ success: true, status: 'STARTING' });
});

// ─── Get QR code ─────────────────────────────────────────────────────────────
app.get('/session/qr', (req, res) => {
    const mid = String(req.query.merchantId || '');
    if (!sessions[mid]) return res.json({ success: false, status: 'NOT_STARTED', qr: null });

    res.json({
        success: true,
        status: sessions[mid].status,
        qr: sessions[mid].qr || null
    });
});

// ─── Get session status ───────────────────────────────────────────────────────
app.get('/session/status', (req, res) => {
    const mid = String(req.query.merchantId || '');
    if (!sessions[mid]) return res.json({ status: 'NOT_STARTED' });
    res.json({ status: sessions[mid].status });
});

// ─── Send message ─────────────────────────────────────────────────────────────
app.post('/send', async (req, res) => {
    const { merchantId, phone, message } = req.body;
    const mid = String(merchantId || '');

    if (!sessions[mid] || sessions[mid].status !== 'WORKING') {
        return res.status(400).json({ success: false, error: 'Session not ready' });
    }

    try {
        // Normalize phone: strip non-digits, ensure no leading +
        const normalized = String(phone).replace(/[^0-9]/g, '');
        const chatId = normalized + '@c.us';

        await sessions[mid].client.sendMessage(chatId, message);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Logout ───────────────────────────────────────────────────────────────────
app.post('/session/logout', async (req, res) => {
    const mid = String(req.body.merchantId || '');
    if (!sessions[mid]) return res.json({ success: true, message: 'No session found' });

    try {
        await sessions[mid].client.logout();
        await sessions[mid].client.destroy();
    } catch (e) { /* ignore */ }

    delete sessions[mid];
    res.json({ success: true });
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, sessions: Object.keys(sessions).length }));

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`WA Bridge running on port ${PORT}`);
});
