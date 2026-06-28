/**
 * WhatsApp Bridge Server — Baileys
 */

const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });

const app = express();
app.use(express.json());

const logger = pino({ level: 'silent' });
const SECRET = process.env.BRIDGE_SECRET || 'saddara_wa_bridge_2025';

app.use((req, res, next) => {
    const key = req.headers['x-bridge-key'] || req.query.key;
    if (key !== SECRET) return res.status(401).json({ error: 'Unauthorized' });
    next();
});

function makeSimpleStore() {
    return {
        chats: {},
        messages: {},
        contacts: {},
        bind(ev) {
            ev.on('chats.set', ({ chats }) => {
                for (const chat of chats) {
                    this.chats[chat.id] = { ...this.chats[chat.id], ...chat };
                }
            });
            ev.on('messaging-history.set', ({ chats, messages }) => {
                if (chats) {
                    for (const chat of chats) {
                        this.chats[chat.id] = { ...this.chats[chat.id], ...chat };
                    }
                }
                if (messages) {
                    for (const m of messages) {
                        const jid = m.key.remoteJid;
                        if (!this.messages[jid]) this.messages[jid] = [];
                        const idx = this.messages[jid].findIndex(msg => msg.key.id === m.key.id);
                        if (idx > -1) this.messages[jid][idx] = m;
                        else this.messages[jid].push(m);
                    }
                }
            });
            ev.on('chats.upsert', chats => {
                for (const chat of chats) {
                    this.chats[chat.id] = { ...this.chats[chat.id], ...chat };
                }
            });
            ev.on('chats.update', updates => {
                for (const update of updates) {
                    if (this.chats[update.id]) {
                        this.chats[update.id] = { ...this.chats[update.id], ...update };
                    }
                }
            });
            ev.on('messages.upsert', ({ messages, type }) => {
                for (const m of messages) {
                    const jid = m.key.remoteJid;
                    
                    // Ensure chat exists
                    if (!this.chats[jid]) {
                        this.chats[jid] = { 
                            id: jid, 
                            unreadCount: 0, 
                            conversationTimestamp: m.messageTimestamp || Math.floor(Date.now()/1000)
                        };
                    }
                    
                    // Update chat details
                    this.chats[jid].conversationTimestamp = m.messageTimestamp || this.chats[jid].conversationTimestamp;
                    if (m.pushName) {
                        this.chats[jid].name = m.pushName;
                    }
                    
                    if (!this.messages[jid]) this.messages[jid] = [];
                    const idx = this.messages[jid].findIndex(msg => msg.key.id === m.key.id);
                    if (idx > -1) this.messages[jid][idx] = m;
                    else this.messages[jid].push(m);
                    
                    if (this.messages[jid].length > 100) this.messages[jid].shift();
                    
                    if (type === 'notify' && !m.key.fromMe) {
                        this.chats[jid].unreadCount = (this.chats[jid].unreadCount || 0) + 1;
                    }
                }
            });
            ev.on('messages.update', (updates) => {
                for (const { key, update } of updates) {
                    const jid = key.remoteJid;
                    if (this.messages[jid]) {
                        const msg = this.messages[jid].find(m => m.key.id === key.id);
                        if (msg) {
                            Object.assign(msg, update);
                        }
                    }
                }
            });
            ev.on('message-receipt.update', (updates) => {
                for (const { key, receipt } of updates) {
                    const jid = key.remoteJid;
                    if (this.messages[jid]) {
                        const msg = this.messages[jid].find(m => m.key.id === key.id);
                        if (msg && receipt) {
                            if (receipt.receiptTimestamp) {
                                msg.status = 4; // Read
                            } else {
                                msg.status = 3; // Delivered
                            }
                        }
                    }
                }
            });
            ev.on('contacts.upsert', (contacts) => {
                for (const contact of contacts) {
                    this.contacts[contact.id] = contact;
                }
            });
            ev.on('contacts.set', ({ contacts }) => {
                for (const contact of contacts) {
                    this.contacts[contact.id] = contact;
                }
            });
            ev.on('contacts.update', (updates) => {
                for (const update of updates) {
                    if (this.contacts[update.id]) {
                        this.contacts[update.id] = { ...this.contacts[update.id], ...update };
                    }
                }
            });
            ev.on('presence.update', (update) => {
                const jid = update.id;
                if (!this.contacts[jid]) this.contacts[jid] = { id: jid };
                this.contacts[jid].presence = update.presences;
            });
        },
        readFromFile(path) {
            try {
                const fs = require('fs');
                if (fs.existsSync(path)) {
                    const data = JSON.parse(fs.readFileSync(path, 'utf-8'));
                    this.chats = data.chats || {};
                    this.messages = data.messages || {};
                    this.contacts = data.contacts || {};
                }
            } catch (e) {
                console.error("Store read error:", e.message);
            }
        },
        writeToFile(path) {
            try {
                require('fs').writeFileSync(path, JSON.stringify({ chats: this.chats, messages: this.messages, contacts: this.contacts }));
            } catch (e) {}
        }
    };
}

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

    sessions[mid] = { sock: null, store: null, status: 'STARTING', qr: null, reconnectAttempts: 0, lastError: null };
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

        const store = makeSimpleStore();
        const storePath = path.join(authDir, 'baileys_store.json');
        store.readFromFile(storePath);
        
        // Save store periodically
        const storeInterval = setInterval(() => {
            if (sessions[mid]?.status === 'WORKING') {
                store.writeToFile(storePath);
            }
        }, 10_000);

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
            syncFullHistory: true,
            getMessage: async (key) => {
                if (store) {
                    const msg = await store.loadMessage(key.remoteJid, key.id);
                    return msg?.message || undefined;
                }
                return undefined;
            }
        });

        store.bind(sock.ev);

        sessions[mid].sock = sock;
        sessions[mid].store = store;
        sessions[mid].storeInterval = storeInterval;
        
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            // Auto-read removed to prevent sending blue ticks prematurely
            for (const m of messages) {
                if (!m.key.fromMe && (m.message?.imageMessage || m.message?.videoMessage || m.message?.audioMessage || m.message?.documentMessage)) {
                    // Upload incoming media to R2 via PHP cache-media webhook
                    try {
                        const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
                        const buffer = await downloadMediaMessage(m, 'buffer', {}, { logger });
                        
                        let ext = 'bin';
                        if (m.message.imageMessage) ext = 'jpg';
                        else if (m.message.videoMessage) ext = 'mp4';
                        else if (m.message.audioMessage) ext = 'ogg';
                        else if (m.message.documentMessage) ext = m.message.documentMessage.fileName?.split('.').pop() || 'pdf';
                        
                        const formData = new FormData();
                        formData.append('file', new Blob([buffer]), 'media.' + ext);
                        
                        const res = await fetch('http://127.0.0.1/api/wa-chats/cache-media', {
                            method: 'POST',
                            headers: { 'X-Bridge-Key': 'saddara_wa_bridge_2025' },
                            body: formData
                        });
                        
                        const data = await res.json();
                        if (data && data.success) {
                            m.r2Url = data.url;
                            // Update store since m is already in store
                            const storeMsg = session.store.messages[m.key.remoteJid]?.find(sm => sm.key.id === m.key.id);
                            if (storeMsg) storeMsg.r2Url = data.url;
                        }
                    } catch (e) {
                        console.error(`[${mid}] Error caching media to R2:`, e.message);
                    }
                }
            }
        });

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
                    clearInterval(sessions[mid].storeInterval);
                    const authDir = path.join(__dirname, 'sessions', 'merchant_' + mid);
                    try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) { }
                    return;
                }

                sessions[mid].reconnectAttempts = (sessions[mid].reconnectAttempts || 0) + 1;

                if (sessions[mid].reconnectAttempts >= 5) {
                    console.log(`[${mid}] Max reconnects — STOPPED`);
                    sessions[mid].status = 'STOPPED';
                    sessions[mid].qr = null;
                    clearInterval(sessions[mid].storeInterval);
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

// إعدادات ذكية لتجنب الحظر (Anti-Ban) تناسب جميع أنواع الإشعارات بما فيها المايسترو
async function sendMessageInternal(session, mid, phone, message, type) {
    const fullNumber = normalizePhone(phone);
    const jid = fullNumber + '@s.whatsapp.net';
    console.log(`[${mid}] Sending to ${jid} (type=${type || 'default'})`);

    // 1. التحقق من الرقم 
    try {
        const [waCheck] = await session.sock.onWhatsApp(fullNumber);
        if (!waCheck || !waCheck.exists) {
            throw new Error(`الرقم ${fullNumber} غير مسجل في واتساب`);
        }
        console.log(`[${mid}] Number ${fullNumber} verified on WhatsApp ✓`);
    } catch (e) {
        if (e.message && e.message.includes('غير مسجل')) {
            throw e;
        }
        console.warn(`[${mid}] onWhatsApp check skipped:`, e.message);
    }

    const sendTimeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('sendMessage timeout after 45s')), 45000)
    );

    try {
        // 2. محاكاة التواجد البشري (Presence Simulation)
        await session.sock.sendPresenceUpdate('available');

        // تأخير عشوائي قبل قراءة المحادثة (1 إلى 2.5 ثانية)
        const readDelay = Math.floor(Math.random() * 1500) + 1000;
        await new Promise(r => setTimeout(r, readDelay));

        // 3. محاكاة الكتابة بناءً على طول الرسالة (Typing Simulation)
        await session.sock.sendPresenceUpdate('composing', jid);

        const chars = message.length;
        // حساب مدة الكتابة: 30 مللي ثانية لكل حرف، بحد أدنى ثانيتين وحد أقصى 8 ثواني
        const typingDelay = Math.min(Math.max((chars * 30) + (Math.random() * 1000), 2000), 8000);
        await new Promise(r => setTimeout(r, typingDelay));

        // محاكاة التوقف قليلاً قبل الإرسال (مراجعة الرسالة)
        await session.sock.sendPresenceUpdate('paused', jid);
        await new Promise(r => setTimeout(r, 500 + Math.random() * 500));

        // 4. إرسال الرسالة
        const msgInfo = await Promise.race([
            session.sock.sendMessage(jid, { text: message }),
            sendTimeout
        ]);

        if (!msgInfo || !msgInfo.key || !msgInfo.key.id) {
            throw new Error('لم يتم استلام تأكيد من خوادم واتساب');
        }

        console.log(`[${mid}] Message sent ✓ (msgId=${msgInfo.key.id})`);
        return msgInfo;
    } finally {
        try { await session.sock.sendPresenceUpdate('unavailable'); } catch (e) { }
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
    const { merchantId, phone, customerName, orderId, total, status, storeName, currency, message: customMessage } = req.body;
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

    let message = customMessage;
    if (!message) {
        const name = customerName || 'عميلنا العزيز';
        const totalStr = total ? `${total} ${currency || 'ر.س'}` : '';
        const statusStr = status || 'جديد';
        const store = storeName || 'متجرنا';
        message = `مرحباً ${name}،\n\nتم استلام طلبك #${orderId} بنجاح! ✅\nالإجمالي: ${totalStr}\nالحالة: ${statusStr}\n\nشكراً لتسوقك مع ${store}! 🛍️\n\nسنقوم بإعلامك بأي تحديثات على طلبك.`;
    }

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
    const { merchantId, phone, reminderType, customerName, orderId, total, currency, storeName, message: customMessage } = req.body;
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

    let message = customMessage;
    if (!message) {
        const name = customerName || 'عميلنا العزيز';
        const totalStr = total ? `${total} ${currency || 'ر.س'}` : '';
        const store = storeName || 'متجرنا';

        const templates = {
            payment: `مرحباً ${name}،\n\nتذكير بخصوص طلبك #${orderId}.\nالإجمالي: ${totalStr}\n\nنود تذكيرك بإتمام عملية الدفع في حال لم تكن قد أنجزتها بعد. 💳\n\nشكراً لك، ${store}`,
            shipping: `مرحباً ${name}،\n\nتذكير بخصوص طلبك #${orderId}.\nالإجمالي: ${totalStr}\n\nسيتم شحن طلبك قريباً. 🚚 سنوافيك بالتفاصيل فور التجهيز.\n\nشكراً لك، ${store}`,
            review: `مرحباً ${name}،\n\nنأمل أنك راضٍ عن طلبك #${orderId}! ⭐\n\nنقدّر إذا تركت لنا تقييماً على المتجر. رأيك يهمنا.\n\nشكراً لك، ${store}`,
            general: `مرحباً ${name}،\n\nتذكير بخصوص طلبك #${orderId}.\nالإجمالي: ${totalStr}\n\nإذا كانت لديك أي استفسارات، لا تتردد بالتواصل معنا. 📞\n\nشكراً لك، ${store}`,
        };
        message = templates[reminderType] || templates['general'];
    }

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

// ─── Send Typing Presence ────────────────────────────────────────────────────────
app.post('/send-presence', async (req, res) => {
    const { merchantId, jid, presence } = req.body;
    const mid = String(merchantId || '');
    const sess = sessions[mid];

    if (!sess) return res.json({ success: false, error: 'no session' });
    if (!sess.sock) return res.json({ success: false, error: 'not connected' });
    if (!jid) return res.json({ success: false, error: 'jid required' });

    try {
        await sess.sock.sendPresenceUpdate(presence || 'composing', jid);
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.post('/subscribe-presence', async (req, res) => {
    const { merchantId, jid } = req.body;
    const mid = String(merchantId || '');
    const sess = sessions[mid];
    
    if (!sess || !sess.sock || !jid) return res.json({ success: false });
    
    try {
        await sess.sock.presenceSubscribe(jid);
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false });
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

// ─── Fetch Chats ─────────────────────────────────────────────────────────────
app.get('/chats', (req, res) => {
    const mid = String(req.query.merchantId);
    if (!sessions[mid] || !sessions[mid].store) {
        return res.json({ success: false, error: 'no store' });
    }
    
    // Debug info
    if (req.query.debug === '1') {
        return res.json({
            success: true,
            chatsCount: Object.keys(sessions[mid].store.chats || {}).length,
            messagesCount: Object.keys(sessions[mid].store.messages || {}).length,
            sampleChat: Object.values(sessions[mid].store.chats || {})[0] || null
        });
    }

    try {
        const chatsObj = sessions[mid].store.chats || {};
        // Convert object to array
        const chats = Object.values(chatsObj);
        
        // Sort by most recent
        chats.sort((a, b) => {
            const t1 = a.conversationTimestamp || 0;
            const t2 = b.conversationTimestamp || 0;
            return t2 - t1;
        });
        
        const mapped = chats.slice(0, 100).map(c => {
            const contact = sessions[mid].store.contacts[c.id];
            const name = c.name || (contact ? (contact.name || contact.verifiedName) : null) || c.verifiedName || null;
            return {
                id: c.id,
                name: name,
                unreadCount: c.unreadCount || 0,
                timestamp: c.conversationTimestamp || 0,
                lastMessage: c.lastMessageRecvTimestamp,
                presence: contact ? contact.presence : null
            };
        });

        res.json({ success: true, chats: mapped });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// ─── Fetch Messages ──────────────────────────────────────────────────────────
app.get('/chats/:jid/messages', async (req, res) => {
    const mid = String(req.query.merchantId || '');
    const { jid } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    
    if (!sessions[mid] || !sessions[mid].store) {
        return res.json({ success: false, error: 'no store' });
    }
    
    try {
        const msgs = sessions[mid].store.messages[jid] || [];
        res.json({ success: true, messages: msgs.slice(-limit) });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// ─── Media Support ────────────────────────────────────────────────────────────
app.get('/media/:merchantId/:jid/:msgId', async (req, res) => {
    const { merchantId, jid, msgId } = req.params;
    const session = sessions[merchantId];
    if (!session || session.status !== 'WORKING') return res.status(404).send('No session');
    
    // Find message in RAM store
    if (!session.store || !session.store.messages || !session.store.messages[jid]) return res.status(404).send('No messages for JID');
    const msg = session.store.messages[jid].find(m => m.key.id === msgId);
    if (!msg) return res.status(404).send('Message not found in store');
    
    try {
        const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger });
        
        let mimetype = 'application/octet-stream';
        if (msg.message?.imageMessage) mimetype = msg.message.imageMessage.mimetype;
        else if (msg.message?.videoMessage) mimetype = msg.message.videoMessage.mimetype;
        else if (msg.message?.audioMessage) mimetype = msg.message.audioMessage.mimetype;
        else if (msg.message?.documentMessage) mimetype = msg.message.documentMessage.mimetype;
        
        // Ensure standard audio types if it's a voice note for browser playback
        if (mimetype.includes('audio/ogg') || mimetype.includes('audio/mp4')) mimetype = 'audio/ogg';

        res.set('Content-Type', mimetype);
        res.send(buffer);
    } catch (e) {
        console.error('Media download error:', e);
        res.status(500).send('Error downloading media');
    }
});

app.post('/send-media', async (req, res) => {
    // Note: No longer using upload.single('file') because PHP handles R2 upload and passes URL
    const { merchantId, jid, type, caption, url, mimetype, fileName } = req.body;
    const mid = String(merchantId || '');

    if (!mid || !jid || !url) {
        return res.status(400).json({ success: false, error: 'merchantId, jid, url required' });
    }

    const session = sessions[mid];
    if (!session || session.status !== 'WORKING') {
        return res.status(400).json({ success: false, error: 'Session not working' });
    }

    try {
        let content = {};
        if (type === 'video') {
            content = { video: { url }, caption: caption || '' };
        } else if (type === 'audio') {
            content = { audio: { url }, ptt: true }; // ptt: voice note
        } else if (type === 'document') {
            content = { document: { url }, fileName: fileName || 'file', mimetype: mimetype || 'application/pdf' };
        } else {
            content = { image: { url }, caption: caption || '' };
        }

        const msgInfo = await session.sock.sendMessage(jid, content);
        
        // Add to RAM store immediately with status 2 (SENT) so UI shows single tick
        msgInfo.status = 2;
        msgInfo.r2Url = url; // Save R2 URL for UI
        if (!session.store.messages[jid]) session.store.messages[jid] = [];
        session.store.messages[jid].push(msgInfo);
        
        res.json({ success: true, message: msgInfo });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Send Chat Message ───────────────────────────────────────────────────────
app.post('/send-chat', async (req, res) => {
    const { merchantId, jid, message } = req.body;
    const mid = String(merchantId || '');

    if (!mid || !jid || !message) {
        return res.status(400).json({ success: false, error: 'merchantId, jid, message required' });
    }

    const session = sessions[mid];
    if (!session || session.status !== 'WORKING') {
        return res.status(400).json({ success: false, error: 'Session not working' });
    }

    try {
        await session.sock.sendPresenceUpdate('composing', jid);
        await new Promise(r => setTimeout(r, 500));
        await session.sock.sendPresenceUpdate('paused', jid);
        
        const msgInfo = await session.sock.sendMessage(jid, { text: message });
        
        // Add to RAM store immediately with status 2 (SENT) so UI shows single tick
        msgInfo.status = 2;
        if (!session.store.messages[jid]) session.store.messages[jid] = [];
        session.store.messages[jid].push(msgInfo);

        res.json({ success: true, message: msgInfo });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Read Chat Messages ──────────────────────────────────────────────────────
app.post('/read-chat', async (req, res) => {
    const { merchantId, jid } = req.body;
    const mid = String(merchantId || '');

    if (!mid || !jid) return res.status(400).json({ success: false, error: 'merchantId, jid required' });

    const session = sessions[mid];
    if (!session || session.status !== 'WORKING') return res.status(400).json({ success: false, error: 'Session not working' });

    try {
        if (session.store && session.store.messages[jid]) {
            // Find unread incoming messages
            const unreadMsgs = session.store.messages[jid].filter(m => !m.key.fromMe && !m.status);
            for (const m of unreadMsgs) {
                await session.sock.readMessages([m.key]);
                m.status = 4; // Mark read locally
            }
        }
        res.json({ success: true });
    } catch (e) {
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

    clearInterval(sessions[mid].storeInterval);

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
app.listen(PORT, () => {
    console.log(`WA Bridge running on port ${PORT}`);
    
    // Auto-init existing sessions
    try {
        const sessionsDir = path.join(__dirname, 'sessions');
        if (require('fs').existsSync(sessionsDir)) {
            const dirs = require('fs').readdirSync(sessionsDir);
            for (const d of dirs) {
                if (d.startsWith('merchant_')) {
                    const mid = d.replace('merchant_', '');
                    console.log(`Auto-starting session for merchant ${mid}...`);
                    sessions[mid] = { sock: null, store: null, status: 'STARTING', qr: null, reconnectAttempts: 0, lastError: null };
                    initSession(mid);
                }
            }
        }
    } catch (e) {
        console.error("Failed to auto-init sessions:", e.message);
    }
});

// ─── Keep-Alive ───────────────────────────────────────────────────────────────
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
setInterval(() => {
    const http = SELF_URL.startsWith('https') ? require('https') : require('http');
    http.get(`${SELF_URL}/health?key=${SECRET}`, () => { }).on('error', () => { });
}, 14 * 60 * 1000);
