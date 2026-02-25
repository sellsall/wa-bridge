/**
 * WhatsApp Bridge Server — Baileys (No Puppeteer/Chrome needed)
 * Works on any Node.js hosting including Hostinger
 *
 * Endpoints:
 *   POST /session/start   { merchantId }  → start session
 *   GET  /session/qr      ?merchantId=X   → get QR as base64 image
 *   GET  /session/status  ?merchantId=X   → get status
 *   POST /send            { merchantId, phone, message }
 *   POST /session/logout  { merchantId }
 *   GET  /health
 */

const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

// Silent logger (no noise in logs)
const logger = pino({ level: 'silent' });

// Secret key middleware
const SECRET = process.env.BRIDGE_SECRET || 'saddara_wa_bridge_2025';
app.use((req, res, next) => {
    const key = req.headers['x-bridge-key'] || req.query.key;
    if (key !== SECRET) return res.status(401).json({ error: 'Unauthorized' });
    next();
});

// In-memory sessions: merchantId → { sock, status, qr }
const sessions = {};

// ─── Start or restart a session ──────────────────────────────────────────────
app.post('/session/start', async (req, res) => {
    const { merchantId } = req.body;
    if (!merchantId) return res.status(400).json({ error: 'merchantId required' });

    const mid = String(merchantId);

    // Already connected
    if (sessions[mid] && sessions[mid].status === 'WORKING') {
        return res.json({ success: true, status: 'WORKING' });
    }

    // Clean up old session
    if (sessions[mid] && sessions[mid].sock) {
        try { sessions[mid].sock.end(); } catch (e) { }
        delete sessions[mid];
    }

    sessions[mid] = { sock: null, status: 'STARTING', qr: null };

    // Respond immediately — session starts async
    res.json({ success: true, status: 'STARTING' });

    // Init async
    initSession(mid);
});

async function initSession(mid) {
    try {
        // Dynamic import (Baileys is ESM)
        const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = await import('@whiskeysockets/baileys');
        const { Boom } = await import('@hapi/boom');

        const authDir = path.join(__dirname, 'sessions', 'merchant_' + mid);
        fs.mkdirSync(authDir, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(authDir);

        const sock = makeWASocket({
            auth: state,
            logger: logger,
            browser: Browsers.ubuntu('Chrome'),
            printQRInTerminal: false,
        });

        sessions[mid].sock = sock;

        // QR event
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                try {
                    sessions[mid].qr = await QRCode.toDataURL(qr);
                    sessions[mid].status = 'SCAN_QR_CODE';
                    console.log(`[Merchant ${mid}] QR ready`);
                } catch (e) { console.error(e); }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                console.log(`[Merchant ${mid}] Disconnected, code: ${statusCode}, reconnect: ${shouldReconnect}`);

                if (shouldReconnect) {
                    // Keep existing QR — don't clear it, new QR will overwrite on next attempt
                    sessions[mid].status = sessions[mid].qr ? 'SCAN_QR_CODE' : 'RECONNECTING';
                    setTimeout(() => initSession(mid), 2000);
                } else {
                    // Logged out — clear everything
                    sessions[mid].status = 'STOPPED';
                    sessions[mid].qr = null;
                    try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) { }
                }
            }

            if (connection === 'open') {
                sessions[mid].status = 'WORKING';
                sessions[mid].qr = null;
                console.log(`[Merchant ${mid}] Connected!`);
            }
        });

        // Save credentials on update
        sock.ev.on('creds.update', saveCreds);

    } catch (err) {
        console.error(`[Merchant ${mid}] Init error:`, err.message);
        if (sessions[mid]) sessions[mid].status = 'ERROR';
    }
}

// ─── Get QR ──────────────────────────────────────────────────────────────────
app.get('/session/qr', (req, res) => {
    const mid = String(req.query.merchantId || '');
    if (!sessions[mid]) return res.json({ success: false, status: 'NOT_STARTED', qr: null });

    res.json({
        success: true,
        status: sessions[mid].status,
        qr: sessions[mid].qr || null
    });
});

// ─── Get Status ───────────────────────────────────────────────────────────────
app.get('/session/status', (req, res) => {
    const mid = String(req.query.merchantId || '');
    if (!sessions[mid]) return res.json({ status: 'NOT_STARTED' });
    res.json({ status: sessions[mid].status });
});

// ─── Send Message ─────────────────────────────────────────────────────────────
app.post('/send', async (req, res) => {
    const { merchantId, phone, message } = req.body;
    const mid = String(merchantId || '');

    if (!sessions[mid] || sessions[mid].status !== 'WORKING') {
        return res.status(400).json({ success: false, error: 'Session not ready: ' + (sessions[mid]?.status || 'NOT_STARTED') });
    }

    try {
        const normalized = String(phone).replace(/[^0-9]/g, '');
        const jid = normalized + '@s.whatsapp.net';

        await sessions[mid].sock.sendMessage(jid, { text: message });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Logout ───────────────────────────────────────────────────────────────────
app.post('/session/logout', async (req, res) => {
    const mid = String(req.body.merchantId || '');
    if (!sessions[mid]) return res.json({ success: true });

    try {
        if (sessions[mid].sock) await sessions[mid].sock.logout();
    } catch (e) { }

    const authDir = path.join(__dirname, 'sessions', 'merchant_' + mid);
    try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) { }

    delete sessions[mid];
    res.json({ success: true });
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    const info = {};
    for (const mid in sessions) info[mid] = sessions[mid].status;
    res.json({ ok: true, sessions: info });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`WA Bridge (Baileys) running on port ${PORT}`);
});
