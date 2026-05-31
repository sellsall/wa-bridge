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
            syncFullHistory: false,
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
                try {
                    await sock.sendPresenceUpdate('unavailable');
                } catch (e) { }
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

// ─── Helpers ────────────────────────────────────────────────────────────────
function normalizePhone(phone) {
    const normalized = String(phone)
        .replace(/\s+/g, '')
        .replace(/^\+/, '')
        .replace(/^00+/, '')
        .replace(/[^0-9]/g, '');

    // Known country code prefixes (GCC + major countries)
    const knownPrefixes = ['966', '971', '965', '973', '968', '974', '20', '1', '44', '49', '33', '39'];
    const hasPrefix = knownPrefixes.some(p => normalized.startsWith(p));

    return hasPrefix ? normalized : '966' + normalized.replace(/^0+/, '');
}

function shouldShowOnline(type) {
    const onlineTypes = ['abandoned_cart', 'alert', 'reminder', 'order_notification', 'order_status'];
    return onlineTypes.includes(type);
}

async function sendMessageInternal(session, mid, phone, message, type) {
    const fullNumber = normalizePhone(phone);
    const jid = fullNumber + '@s.whatsapp.net';
    console.log(`[${mid}] Sending to ${jid} (type=${type || 'default'})`);

    const sendTimeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('sendMessage timeout after 20s')), 20000)
    );

    const showOnline = shouldShowOnline(type);

    try {
        if (showOnline) {
            await session.sock.sendPresenceUpdate('available');
            await new Promise(r => setTimeout(r, 1000));
            await session.sock.sendPresenceUpdate('composing', jid);
            await new Promise(r => setTimeout(r, 1500));
        }

        await Promise.race([
            session.sock.sendMessage(jid, { text: message }),
            sendTimeout
        ]);

        console.log(`[${mid}] Message sent ✓`);
    } finally {
        if (showOnline) {
            try { await session.sock.sendPresenceUpdate('unavailable'); } catch (e) { }
        }
    }
}

// ─── Send Message ─────────────────────────────────────────────────────────────
app.post('/send', async (req, res) => {
    const { merchantId, phone, message, type } = req.body;
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
        await sendMessageInternal(session, mid, phone, message, type);
        res.json({ success: true });
    } catch (e) {
        console.error(`[${mid}] Send error:`, e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Notify: New Order ────────────────────────────────────────────────────────
app.post('/notify/order', async (req, res) => {
    const { merchantId, phone, customerName, orderId, total, status, storeName, currency } = req.body;
    const mid = String(merchantId || '');

    if (!mid || !phone || !orderId) {
        return res.status(400).json({ success: false, error: 'merchantId, phone, orderId required' });
    }

    const session = sessions[mid];
    if (!session) return res.status(400).json({ success: false, error: 'Session not started' });
    if (session.status !== 'WORKING') return res.status(400).json({ success: false, error: 'Session not ready: ' + session.status });
    if (!session.sock || !session.sock.user) {
        session.status = 'RECONNECTING';
        initSession(mid);
        return res.status(400).json({ success: false, error: 'Socket disconnected — reconnecting' });
    }

    const name = customerName || 'عميلنا العزيز';
    const totalStr = total ? `${total} ${currency || 'ر.س'}` : '';
    const statusStr = status || 'جديد';
    const store = storeName || 'متجرنا';

    const message = `مرحباً ${name}،\n\nتم استلام طلبك #${orderId} بنجاح! ✅\nالإجمالي: ${totalStr}\nالحالة: ${statusStr}\n\nشكراً لتسوقك مع ${store}! 🛍️\n\nسنقوم بإعلامك بأي تحديثات على طلبك.`;

    try {
        await sendMessageInternal(session, mid, phone, message, 'order_notification');
        res.json({ success: true });
    } catch (e) {
        console.error(`[${mid}] Notify order error:`, e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Send Reminder ────────────────────────────────────────────────────────────
app.post('/send-reminder', async (req, res) => {
    const { merchantId, phone, reminderType, customerName, orderId, total, currency, storeName } = req.body;
    const mid = String(merchantId || '');
    console.log('[DEBUG /send-reminder] body=', JSON.stringify(req.body));

    if (!mid || !phone || !orderId || !reminderType) {
        console.log('[DEBUG /send-reminder] 400 reason: mid=', mid, 'phone=', phone, 'orderId=', orderId, 'reminderType=', reminderType);
        return res.status(400).json({ success: false, error: 'merchantId, phone, orderId, reminderType required' });
    }

    const session = sessions[mid];
    if (!session) return res.status(400).json({ success: false, error: 'Session not started' });
    if (session.status !== 'WORKING') return res.status(400).json({ success: false, error: 'Session not ready: ' + session.status });
    if (!session.sock || !session.sock.user) {
        session.status = 'RECONNECTING';
        initSession(mid);
        return res.status(400).json({ success: false, error: 'Socket disconnected — reconnecting' });
    }

    const name = customerName || 'عميلنا العزيز';
    const totalStr = total ? `${total} ${currency || 'ر.س'}` : '';
    const store = storeName || 'متجرنا';

    const templates = {
        payment: `مرحباً ${name}،\n\nتذكير بخصوص طلبك #${orderId}.\nالإجمالي: ${totalStr}\n\nنود تذكيرك بإتمام عملية الدفع في حال لم تكن قد أنجزتها بعد. 💳\n\nشكراً لك، ${store}`,
        shipping: `مرحباً ${name}،\n\nتذكير بخصوص طلبك #${orderId}.\nالإجمالي: ${totalStr}\n\nسيتم شحن طلبك قريباً. 🚚 سنوافيك بالتفاصيل فور التجهيز.\n\nشكراً لك، ${store}`,
        review: `مرحباً ${name}،\n\nنأمل أنك راضٍ عن طلبك #${orderId}! ⭐\n\nنقدّر إذا تركت لنا تقييماً على المتجر. رأيك يهمنا.\n\nشكراً لك، ${store}`,
        general: `مرحباً ${name}،\n\nتذكير بخصوص طلبك #${orderId}.\nالإجمالي: ${totalStr}\n\nإذا كانت لديك أي استفسارات، لا تتردد بالتواصل معنا. 📞\n\nشكراً لك، ${store}`,
    };

    const message = templates[reminderType] || templates['general'];

    try {
        await sendMessageInternal(session, mid, phone, message, 'reminder');
        res.json({ success: true });
    } catch (e) {
        console.error(`[${mid}] Send reminder error:`, e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Control Presence ───────────────────────────────────────────────────────────
app.post('/session/presence', async (req, res) => {
    const { merchantId, presence } = req.body;
    const mid = String(merchantId || '');
    const sess = sessions[mid];

    if (!sess) return res.json({ success: false, error: 'no session' });
    if (!sess.sock) return res.json({ success: false, error: 'not connected' });

    try {
        await sess.sock.sendPresenceUpdate(presence || 'unavailable');
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// ─── Session Me (connected phone) ────────────────────────────────────────────
app.get('/session/me', (req, res) => {
    const mid = String(req.query.merchantId || '');
    if (!sessions[mid]) return res.json({ success: false, error: 'no session' });

    const user = sessions[mid].sock?.user;
    if (!user) return res.json({ success: false, error: 'not connected' });

    // user.id = "201153220643:XX@s.whatsapp.net" → extract phone
    const phone = (user.id || '').split(':')[0].split('@')[0];
    res.json({ success: true, phone });
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
