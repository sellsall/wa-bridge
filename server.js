/**
 * WhatsApp Bridge Server — Baileys
 */

const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

const logger = pino({ level: 'silent' });
const SECRET = process.env.BRIDGE_SECRET || 'saddara_wa_bridge_2025';

app.use((req, res, next) => {
    const key = req.headers['x-bridge-key'] || req.query.key;
    if (key !== SECRET) return res.status(401).json({ error: 'Unauthorized' });
    next();
});

const sessions = {};

// ─── Start Session ────────────────────────────────────────────────────────────
app.post('/session/start', async (req, res) => {
    const { merchantId } = req.body;
    if (!merchantId) return res.status(400).json({ error: 'merchantId required' });

    const mid = String(merchantId);

    if (sessions[mid] && sessions[mid].status === 'WORKING') {
        return res.json({ success: true, status: 'WORKING' });
    }

    if (sessions[mid]) {
        try { sessions[mid].sock?.ev?.removeAllListeners(); } catch (e) { }
        try { sessions[mid].sock?.end(); } catch (e) { }
        const authDir = path.join(__dirname, 'sessions', 'merchant_' + mid);
        try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) { }
        delete sessions[mid];
    }

    sessions[mid] = { sock: null, status: 'STARTING', qr: null, reconnectAttempts: 0, lastError: null };
    res.json({ success: true, status: 'STARTING' });
    initSession(mid);
});

// ─── Init Session ─────────────────────────────────────────────────────────────
async function initSession(mid) {
    try {
        const baileysModule = await import('@whiskeysockets/baileys');
        const makeWASocket = baileysModule.default;
        const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileysModule;

        const { version } = await fetchLatestBaileysVersion();
        console.log(`[${mid}] WA version: ${version}`);

        const authDir = path.join(__dirname, 'sessions', 'merchant_' + mid);
        fs.mkdirSync(authDir, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(authDir);

        const sock = makeWASocket({
            version,
            auth: state,
            logger,
            browser: ['Saddara', 'Chrome', '120.0.6099.109'],
            printQRInTerminal: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 30000,
            keepAliveIntervalMs: 15000,
            retryRequestDelayMs: 2000,
            markOnlineOnConnect: false,
        });

        sessions[mid].sock = sock;

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                try {
                    sessions[mid].qr = await QRCode.toDataURL(qr);
                    sessions[mid].status = 'SCAN_QR_CODE';
                    sessions[mid].reconnectAttempts = 0;
                    console.log(`[${mid}] QR ready`);
                } catch (e) { }
            }

            if (connection === 'open') {
                sessions[mid].status = 'WORKING';
                sessions[mid].qr = null;
                sessions[mid].reconnectAttempts = 0;
                console.log(`[${mid}] Connected ✓`);
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const errMsg = lastDisconnect?.error?.message || String(lastDisconnect?.error || 'unknown');
                const loggedOut = statusCode === DisconnectReason.loggedOut;

                console.log(`[${mid}] Disconnected code:${statusCode} msg:${errMsg}`);
                if (sessions[mid]) sessions[mid].lastError = `code:${statusCode} - ${errMsg}`;

                if (loggedOut) {
                    sessions[mid].status = 'STOPPED';
                    sessions[mid].qr = null;
                    const authDir = path.join(__dirname, 'sessions', 'merchant_' + mid);
                    try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) { }
                    return;
                }

                sessions[mid].reconnectAttempts = (sessions[mid].reconnectAttempts || 0) + 1;

                if (sessions[mid].reconnectAttempts >= 5) {
                    console.log(`[${mid}] Max reconnects — STOPPED`);
                    sessions[mid].status = 'STOPPED';
                    sessions[mid].qr = null;
                    const authDir = path.join(__dirname, 'sessions', 'merchant_' + mid);
                    try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) { }
                } else {
                    sessions[mid].status = 'RECONNECTING';
                    const delay = Math.min(3000 * sessions[mid].reconnectAttempts, 15000);
                    console.log(`[${mid}] Reconnecting in ${delay}ms (attempt ${sessions[mid].reconnectAttempts})`);
                    setTimeout(() => initSession(mid), delay);
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

    } catch (err) {
        console.error(`[${mid}] Init error:`, err.stack || err.message);
        if (sessions[mid]) {
            sessions[mid].status = 'ERROR';
            sessions[mid].qr = null;
            sessions[mid].lastError = err.message;
        }
    }
}

// ─── Send Message ─────────────────────────────────────────────────────────────
app.post('/send', async (req, res) => {
    const { merchantId, phone, message } = req.body;
    const mid = String(merchantId || '');

    if (!mid || !phone || !message) {
        return res.status(400).json({ success: false, error: 'merchantId, phone, message required' });
    }

    const session = sessions[mid];

    if (!session) {
        return res.status(400).json({ success: false, error: 'Session not started' });
    }

    if (session.status !== 'WORKING') {
        return res.status(400).json({ success: false, error: 'Session not ready: ' + session.status });
    }

    if (!session.sock || !session.sock.user) {
        session.status = 'RECONNECTING';
        initSession(mid);
        return res.status(400).json({ success: false, error: 'Socket disconnected — reconnecting' });
    }

    try {
        // حذف + أو 00 من بداية الرقم — WhatsApp لا يقبل + أو 00
        const normalized = String(phone)
            .replace(/\s+/g, '')   // احذف المسافات
            .replace(/^\+/, '')    // احذف + من البداية
            .replace(/^00+/, '')   // احذف 00 أو 000 من البداية
            .replace(/[^0-9]/g, ''); // احذف أي رمز غير رقمي

        const fullNumber = normalized.length >= 10
            ? normalized
            : '966' + normalized.replace(/^0+/, '');

        const jid = fullNumber + '@s.whatsapp.net';
        console.log(`[${mid}] Sending to ${jid}`);

        // منع التعلق — timeout 20 ثانية
        const sendTimeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('sendMessage timeout after 20s')), 20000)
        );

        await Promise.race([
            session.sock.sendMessage(jid, { text: message }),
            sendTimeout
        ]);

        console.log(`[${mid}] Message sent ✓`);
        res.json({ success: true });

    } catch (e) {
        console.error(`[${mid}] Send error:`, e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── QR ──────────────────────────────────────────────────────────────────────
app.get('/session/qr', (req, res) => {
    const mid = String(req.query.merchantId || '');
    if (!sessions[mid]) return res.json({ success: false, status: 'NOT_STARTED', qr: null });
    res.json({ success: true, status: sessions[mid].status, qr: sessions[mid].qr || null });
});

// ─── Status ───────────────────────────────────────────────────────────────────
app.get('/session/status', (req, res) => {
    const mid = String(req.query.merchantId || '');
    if (!sessions[mid]) return res.json({ status: 'NOT_STARTED' });

    const session = sessions[mid];
    if (session.status === 'WORKING' && (!session.sock || !session.sock.user)) {
        session.status = 'RECONNECTING';
        initSession(mid);
    }

    res.json({ status: session.status, lastError: session.lastError || null });
});

// ─── Error Debug ──────────────────────────────────────────────────────────────
app.get('/session/error', (req, res) => {
    const mid = String(req.query.merchantId || '');
    if (!sessions[mid]) return res.json({ error: 'no session' });
    res.json({ status: sessions[mid].status, lastError: sessions[mid].lastError || null });
});

// ─── Logout ───────────────────────────────────────────────────────────────────
app.post('/session/logout', async (req, res) => {
    const mid = String(req.body.merchantId || '');
    if (!sessions[mid]) return res.json({ success: true });

    try { sessions[mid].sock?.ev?.removeAllListeners(); } catch (e) { }
    try { await sessions[mid].sock?.logout(); } catch (e) { }

    const authDir = path.join(__dirname, 'sessions', 'merchant_' + mid);
    try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) { }

    delete sessions[mid];
    res.json({ success: true });
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    const info = {};
    for (const mid in sessions) {
        info[mid] = {
            status: sessions[mid].status,
            hasSocket: !!sessions[mid].sock,
            hasUser: !!sessions[mid].sock?.user,
        };
    }
    res.json({ ok: true, sessions: info });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`WA Bridge running on port ${PORT}`));

// ─── Keep-Alive ───────────────────────────────────────────────────────────────
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
setInterval(() => {
    const http = SELF_URL.startsWith('https') ? require('https') : require('http');
    http.get(`${SELF_URL}/health?key=${SECRET}`, () => { }).on('error', () => { });
}, 14 * 60 * 1000);
