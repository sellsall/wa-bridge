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

    // Clean up old or stuck session (including RECONNECTING)
    if (sessions[mid]) {
        if (sessions[mid].sock) {
            try { sessions[mid].sock.end(); } catch (e) { }
        }
        // Clear auth dir to force fresh QR on stuck sessions
        const authDir = path.join(__dirname, 'sessions', 'merchant_' + mid);
        try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) { }
        delete sessions[mid];
    }

    sessions[mid] = { sock: null, status: 'STARTING', qr: null, reconnectAttempts: 0, lastError: null };

    // Respond immediately — session starts async
    res.json({ success: true, status: 'STARTING' });

    // Init async
    initSession(mid);
});

async function initSession(mid) {
    try {
        // Dynamic import (Baileys is ESM — @hapi/boom is bundled inside baileys)
        const baileysModule = await import('@whiskeysockets/baileys');
        const makeWASocket = baileysModule.default;
        const { useMultiFileAuthState, DisconnectReason } = baileysModule;

        const authDir = path.join(__dirname, 'sessions', 'merchant_' + mid);
        fs.mkdirSync(authDir, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(authDir);

        const sock = makeWASocket({
            auth: state,
            logger: logger,
            browser: ['Saddara', 'Chrome', '120.0'],
            printQRInTerminal: false,
            connectTimeoutMs: 30000,
            defaultQueryTimeoutMs: 30000,
        });

        sessions[mid].sock = sock;

        // QR & connection events
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                try {
                    sessions[mid].qr = await QRCode.toDataURL(qr);
                    sessions[mid].status = 'SCAN_QR_CODE';
                    sessions[mid].reconnectAttempts = 0; // reset on QR
                    console.log(`[Merchant ${mid}] QR ready`);
                } catch (e) { console.error('QR gen error:', e); }
            }

            if (connection === 'close') {
                const errOutput = lastDisconnect?.error?.output;
                const statusCode = errOutput?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                const errMsg = lastDisconnect?.error?.message || String(lastDisconnect?.error || 'unknown');

                console.log(`[Merchant ${mid}] Disconnected code:${statusCode} msg:${errMsg} reconnect:${shouldReconnect}`);
                if (sessions[mid]) sessions[mid].lastError = `code:${statusCode} - ${errMsg}`;

                if (shouldReconnect) {
                    sessions[mid].reconnectAttempts = (sessions[mid].reconnectAttempts || 0) + 1;

                    if (sessions[mid].reconnectAttempts >= 5) {
                        console.log(`[Merchant ${mid}] Max reconnect attempts reached. Stopping.`);
                        sessions[mid].status = 'STOPPED';
                        sessions[mid].qr = null;
                        try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) { }
                    } else {
                        sessions[mid].status = sessions[mid].qr ? 'SCAN_QR_CODE' : 'RECONNECTING';
                        setTimeout(() => initSession(mid), 3000);
                    }
                } else {
                    sessions[mid].status = 'STOPPED';
                    sessions[mid].qr = null;
                    try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) { }
                }
            }

            if (connection === 'open') {
                sessions[mid].status = 'WORKING';
                sessions[mid].qr = null;
                sessions[mid].reconnectAttempts = 0;
                console.log(`[Merchant ${mid}] Connected!`);
            }
        });

        sock.ev.on('creds.update', saveCreds);

    } catch (err) {
        console.error(`[Merchant ${mid}] Init error:`, err.stack || err.message);
        if (sessions[mid]) {
            sessions[mid].status = 'ERROR';
            sessions[mid].qr = null;
            sessions[mid].lastError = err.message;
        }
    }
}

// ─── Debug: last error ───────────────────────────────────────────────────────
app.get('/session/error', (req, res) => {
    const mid = String(req.query.merchantId || '');
    if (!sessions[mid]) return res.json({ error: 'no session' });
    res.json({ status: sessions[mid].status, lastError: sessions[mid].lastError || null });
});

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
const server = app.listen(PORT, () => {
    console.log(`WA Bridge (Baileys) running on port ${PORT}`);
});

// ─── Keep-Alive (prevents Render free plan from sleeping) ────────────────────
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
setInterval(() => {
    const http = SELF_URL.startsWith('https') ? require('https') : require('http');
    http.get(`${SELF_URL}/health?key=${SECRET}`, () => { }).on('error', () => { });
}, 14 * 60 * 1000); // every 14 minutes
