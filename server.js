/**
 * server.js - FY Bot (no DB)
 * - instant QR: console ASCII + web dashboard + can send QR image to admin on request
 * - admin WhatsApp number can change settings with commands
 * - Immediately notifies admin when deployed (or as soon as WA client becomes ready)
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const ADMIN_WHATSAPP = (process.env.ADMIN_WHATSAPP || '').replace(/\D/g, ''); // e.g. 2547XXXXXXXX
const ADMIN_UI_TOKEN = process.env.ADMIN_UI_TOKEN || 'changeme-strong-token';
const SESSION_DIR = process.env.SESSION_DIR || './session';
const POLL_SECONDS = parseInt(process.env.POLL_SECONDS || '20', 10);
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '5', 10);

// endpoints used (from your prior PHP code)
const SHADOW_STK_URL = 'https://shadow-pay.top/api/v2/stkpush.php';
const SHADOW_STATUS_URL = 'https://shadow-pay.top/api/v2/status.php';
const STATUM_AIRTIME_URL = 'https://api.statum.co.ke/api/v2/airtime';

// file-backed storage (no DB)
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
      return fallback;
    }
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw || 'null') ?? fallback;
  } catch (e) {
    console.error('readJson error', e);
    return fallback;
  }
}
function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

let ORDERS = readJson(ORDERS_FILE, []);
let SETTINGS = readJson(SETTINGS_FILE, {
  statum_consumer_key: '',
  statum_consumer_secret: '',
  shadow_api_key: '',
  shadow_api_secret: '',
  shadow_account_id: '17',
  min_amount: '1',
  max_amount: '1500',
  discount_percent: '0',
  payment_poll_seconds: String(POLL_SECONDS)
});
function saveOrders() { writeJson(ORDERS_FILE, ORDERS); }
function saveSettings() { writeJson(SETTINGS_FILE, SETTINGS); }

// helpers
function now() { return new Date().toISOString().replace('T', ' ').replace('Z', ''); }
function genOrderNo() { return 'FYS-' + Math.floor(Math.random() * 1e8).toString().padStart(8, '0'); }
function normalizePhone(p) {
  if (!p) return '';
  let s = String(p).replace(/\D/g, '');
  if (/^254[0-9]{9}$/.test(s)) return s;
  if (/^0[0-9]{9}$/.test(s)) return '254' + s.substring(1);
  if (/^[0-9]{9}$/.test(s)) return '254' + s;
  return s;
}
function toJid(phone) {
  if (!phone) return null;
  return phone.replace(/\D/g, '') + '@c.us';
}
function prettyOrder(o) {
  const lines = [];
  lines.push(`📦 *Order:* ${o.order_no}`);
  lines.push(`👤 *Payer:* ${o.payer_number}`);
  lines.push(`📲 *Recipient:* ${o.recipient_number}`);
  lines.push(`💸 *Amount:* KES ${parseFloat(o.amount).toFixed(2)}`);
  lines.push(`💰 *Payable:* KES ${parseFloat(o.amount_payable).toFixed(2)}`);
  lines.push(`🔖 *Discount:* ${o.discount_percent}%`);
  lines.push(`🔁 *Status:* ${o.status}`);
  lines.push(`🏷️ *MPesa Code:* ${o.transaction_code || 'N/A'}`);
  lines.push(`📶 *Airtime status:* ${o.airtime_status || 'N/A'}`);
  lines.push(`⏱️ *Created:* ${o.created_at}`);
  lines.push(`⏲️ *Updated:* ${o.updated_at}`);
  return lines.join('\n');
}

// Shadow & Statum wrappers (axios)
async function shadowInitiate(apiKey, apiSecret, accountId, phone, amount, reference, description) {
  try {
    const payload = { payment_account_id: parseInt(accountId || '0', 10), phone, amount: parseFloat(amount), reference, description };
    const r = await axios.post(SHADOW_STK_URL, payload, {
      headers: { 'X-API-Key': apiKey || '', 'X-API-Secret': apiSecret || '', 'Content-Type': 'application/json' },
      timeout: 30000
    });
    return r.data;
  } catch (e) {
    return { success: false, message: e.response && e.response.data ? JSON.stringify(e.response.data) : e.message };
  }
}
async function shadowStatus(apiKey, apiSecret, checkout_request_id) {
  try {
    const payload = { checkout_request_id };
    const r = await axios.post(SHADOW_STATUS_URL, payload, {
      headers: { 'X-API-Key': apiKey || '', 'X-API-Secret': apiSecret || '', 'Content-Type': 'application/json' },
      timeout: 20000
    });
    return r.data;
  } catch (e) {
    return { success: false, message: e.response && e.response.data ? JSON.stringify(e.response.data) : e.message };
  }
}
async function statumSend(consumerKey, consumerSecret, phone, amount) {
  try {
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    const payload = { phone_number: phone, amount: String(amount) };
    const r = await axios.post(STATUM_AIRTIME_URL, payload, {
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      timeout: 30000
    });
    return r.data;
  } catch (e) {
    return { success: false, message: e.response && e.response.data ? JSON.stringify(e.response.data) : e.message };
  }
}

// orders helpers
function createOrder(payer, recipient, amount, discount) {
  const order = {
    id: uuidv4(),
    order_no: genOrderNo(),
    payer_number: payer,
    recipient_number: recipient,
    amount: parseFloat(amount),
    amount_payable: parseFloat((amount - (amount * (parseFloat(discount || '0') / 100))).toFixed(2)),
    discount_percent: parseFloat(discount || '0'),
    status: 'pending_payment',
    checkout_request_id: null,
    merchant_request_id: null,
    transaction_code: null,
    airtime_status: null,
    airtime_response: null,
    created_at: now(),
    updated_at: now()
  };
  ORDERS.unshift(order);
  saveOrders();
  return order;
}
function updateOrderByCheckout(checkout, data) {
  let changed = false;
  for (const o of ORDERS) {
    if (o.checkout_request_id && o.checkout_request_id === checkout) {
      Object.assign(o, data);
      o.updated_at = now();
      changed = true;
      break;
    }
  }
  if (changed) saveOrders();
}
function updateOrderByNo(order_no, data) {
  for (const o of ORDERS) {
    if (o.order_no === order_no) {
      Object.assign(o, data);
      o.updated_at = now();
      saveOrders();
      return o;
    }
  }
  return null;
}
function findOrder(order_no) { return ORDERS.find(x => x.order_no === order_no) || null; }

// polling and delivery
async function pollPayment(checkout_request_id, orderNo, pollSecondsOverride) {
  const apiKey = SETTINGS.shadow_api_key;
  const apiSecret = SETTINGS.shadow_api_secret;
  const timeout = parseInt(pollSecondsOverride ?? SETTINGS.payment_poll_seconds ?? POLL_SECONDS, 10);
  const attempts = Math.ceil(timeout / POLL_INTERVAL);
  let paid = false;
  let tx = null;
  for (let i = 0; i < attempts; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL * 1000));
    try {
      const sres = await shadowStatus(apiKey, apiSecret, checkout_request_id);
      const pstatus = (sres.status || sres.result || '').toString().toLowerCase();
      const tcode = sres.transaction_code || sres.transaction || sres.tx || null;
      if (tcode) tx = tcode;
      if (pstatus === 'completed' || pstatus === 'success' || tx) {
        updateOrderByCheckout(checkout_request_id, { status: 'paid', transaction_code: tx || null });
        paid = true;
        break;
      }
      if (pstatus === 'failed' || (sres.message && sres.message.toString().toLowerCase() === 'failed')) {
        updateOrderByCheckout(checkout_request_id, { status: 'payment_failed' });
        break;
      }
    } catch (e) {
      console.warn('pollPayment error', e && e.message ? e.message : e);
    }
  }
  return { paid, tx };
}
async function deliverAirtime(orderNo) {
  const ord = findOrder(orderNo);
  if (!ord) return { success: false, message: 'Order not found' };
  try {
    const sres = await statumSend(SETTINGS.statum_consumer_key, SETTINGS.statum_consumer_secret, ord.recipient_number, ord.amount);
    if ((sres.status_code && parseInt(sres.status_code) === 200) || sres.success === true) {
      updateOrderByNo(orderNo, { airtime_status: 'delivered', airtime_response: JSON.stringify(sres) });
      return { success: true, statum: sres };
    } else {
      updateOrderByNo(orderNo, { airtime_status: 'delivery_failed', airtime_response: JSON.stringify(sres) });
      return { success: false, statum: sres };
    }
  } catch (e) {
    updateOrderByNo(orderNo, { airtime_status: 'delivery_failed', airtime_response: e.message });
    return { success: false, message: e.message };
  }
}

// ----- Express + Socket.IO & WhatsApp client -----
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'fy-bot', dataPath: SESSION_DIR }),
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

// last QR store
let lastQrDataUrl = null;
let lastQrText = null;
let startupAlertSent = false;

// socket: on connect send status & QR if available
io.on('connection', socket => {
  socket.emit('status', { connected: client.info && client.info.wid ? true : false });
  if (lastQrDataUrl) socket.emit('qr', { url: lastQrDataUrl });
});

// helper to send admin message (returns true if sent)
async function alertAdmin(text) {
  if (!ADMIN_WHATSAPP) {
    console.log('[alertAdmin] ADMIN_WHATSAPP not configured; skipping alert.');
    return false;
  }
  try {
    const to = toJid(ADMIN_WHATSAPP);
    if (!client.info || !client.info.wid) {
      console.log('[alertAdmin] client not ready; cannot send now.');
      return false;
    }
    await client.sendMessage(to, text);
    console.log('[alertAdmin] sent to admin:', text);
    return true;
  } catch (e) {
    console.error('[alertAdmin] error sending', e && e.message ? e.message : e);
    return false;
  }
}

// send startup alert immediately (tries now; if not ready, sets ready listener and retries)
async function ensureStartupAlert() {
  if (startupAlertSent) return;
  // immediate attempt
  const ok = await alertAdmin('✅ FY Bot is online now. (auto-notify)');
  if (ok) { startupAlertSent = true; return; }

  // set 'ready' listener to send as soon as client is ready
  const onReady = async () => {
    try {
      if (!startupAlertSent) {
        const ok2 = await alertAdmin('✅ FY Bot is online now. (auto-notify)');
        if (ok2) startupAlertSent = true;
      }
    } catch (e) {
      console.warn('[ensureStartupAlert.onReady] error', e);
    } finally {
      client.removeListener('ready', onReady);
    }
  };
  client.on('ready', onReady);

  // retry loop (attempt a few times, best-effort)
  let retries = 0;
  const maxRetries = 12; // ~1 minute (12 * 5s)
  const intervalId = setInterval(async () => {
    if (startupAlertSent) { clearInterval(intervalId); return; }
    retries++;
    if (client.info && client.info.wid) {
      const ok3 = await alertAdmin('✅ FY Bot is online now. (auto-notify)');
      if (ok3) { startupAlertSent = true; clearInterval(intervalId); return; }
    }
    if (retries >= maxRetries) {
      clearInterval(intervalId);
      console.log('[ensureStartupAlert] retries exhausted; will send on ready event when available.');
    }
  }, 5000);
}

// QR handling: print ascii to console, produce dataURL, emit via socket, keep last QR
client.on('qr', async qr => {
  try {
    lastQrText = qr;
    qrcodeTerminal.generate(qr, { small: true }); // immediate ASCII QR in console
    console.log('[QR] ASCII QR above; also available on web dashboard.');
    const dataUrl = await qrcode.toDataURL(qr);
    lastQrDataUrl = dataUrl;
    io.emit('qr', { url: dataUrl });
  } catch (e) {
    console.error('[qr] error', e);
  }
});

client.on('ready', async () => {
  console.log('[client] ready');
  io.emit('status', { connected: true });
  try { await ensureStartupAlert(); } catch (e) { console.warn('[ready] ensureStartupAlert failed', e); }
});

client.on('authenticated', () => console.log('[client] authenticated'));
client.on('auth_failure', msg => { console.error('[client] auth_failure', msg); io.emit('status', { connected: false, error: 'auth_failure' }); });
client.on('disconnected', reason => { console.log('[client] disconnected', reason); io.emit('status', { connected: false }); });

// ----- HTTP API routes -----
// Initiate purchase (STK)
app.post('/api/initiate', async (req, res) => {
  try {
    const buy_for = req.body.buy_for || 'self';
    const amount = parseFloat(req.body.amount || 0);
    const min = parseFloat(SETTINGS.min_amount || '1'); const max = parseFloat(SETTINGS.max_amount || '1500');
    if (!amount || amount < min || amount > max) return res.json({ success: false, message: `Amount must be between KES ${min} and KES ${max}` });

    const payer_raw = req.body.mpesa_number || req.body.payer_number || '';
    const recipient_raw = req.body.recipient_number || payer_raw;
    const payer = normalizePhone(payer_raw);
    const recipient = normalizePhone(recipient_raw);
    if (!/^254[0-9]{9}$/.test(payer) || !/^254[0-9]{9}$/.test(recipient)) return res.json({ success: false, message: 'Invalid Kenyan phone numbers.' });

    const order = createOrder(payer, recipient, amount, SETTINGS.discount_percent || '0');

    // call Shadow STK
    const sres = await shadowInitiate(SETTINGS.shadow_api_key, SETTINGS.shadow_api_secret, SETTINGS.shadow_account_id, payer, order.amount_payable, order.order_no, `Airtime payment ${order.order_no}`);
    if (!sres || !sres.success) {
      updateOrderByNo(order.order_no, { status: 'failed_payment_init' });
      return res.json({ success: false, message: `Failed to send STK: ${sres && sres.message ? sres.message : 'Unknown'}`, raw: sres });
    }

    const checkout_request_id = sres.checkout_request_id || null;
    const merchant_request_id = sres.merchant_request_id || null;
    updateOrderByNo(order.order_no, { checkout_request_id, merchant_request_id });

    // background polling + delivery (fire & forget)
    (async () => {
      const pollTimeout = parseInt(SETTINGS.payment_poll_seconds || POLL_SECONDS, 10);
      const { paid, tx } = await pollPayment(checkout_request_id, order.order_no, pollTimeout);
      if (paid) {
        await alertAdmin(`🔔 Payment confirmed for ${order.order_no}. Delivering airtime...`);
        const dres = await deliverAirtime(order.order_no);
        if (dres.success) await alertAdmin(`✅ Airtime delivered for ${order.order_no}`);
        else await alertAdmin(`⚠️ Airtime delivery failed for ${order.order_no}`);
      } else {
        const ord = findOrder(order.order_no);
        if (ord && ord.status !== 'paid') {
          updateOrderByNo(order.order_no, { status: 'payment_timeout' });
          await alertAdmin(`⏰ Payment timeout for ${order.order_no}`);
        }
      }
    })();

    return res.json({ success: true, message: 'STK push sent', order_no: order.order_no, checkout_request_id, amount_payable: order.amount_payable });
  } catch (e) {
    console.error('initiate error', e && e.message ? e.message : e);
    return res.json({ success: false, message: e.message || 'Server error' });
  }
});

// get order info
app.post('/api/get_order', (req, res) => {
  try {
    const order_no = req.body.order_no || req.query.order_no;
    if (!order_no) return res.json({ success: false, message: 'Missing order_no' });
    const ord = findOrder(order_no);
    if (!ord) return res.json({ success: false, message: 'Order not found' });
    return res.json({ success: true, order: ord });
  } catch (e) {
    return res.json({ success: false, message: e.message || 'Server error' });
  }
});

// check status by checkout_request_id
app.post('/api/check_status', async (req, res) => {
  try {
    const checkout = req.body.checkout_request_id || req.body.checkout;
    if (!checkout) return res.json({ success: false, message: 'Missing checkout_request_id' });
    const sres = await shadowStatus(SETTINGS.shadow_api_key, SETTINGS.shadow_api_secret, checkout);
    const pstatus = (sres.status || sres.result || '').toString().toLowerCase();
    const tx = sres.transaction_code || sres.transaction || null;
    if (pstatus === 'completed' || pstatus === 'success' || tx) {
      updateOrderByCheckout(checkout, { status: 'paid', transaction_code: tx || null });
      return res.json({ success: true, status: 'paid', transaction_code: tx, raw: sres });
    }
    if (pstatus === 'failed' || (sres.message && sres.message.toString().toLowerCase() === 'failed')) {
      updateOrderByCheckout(checkout, { status: 'payment_failed' });
      return res.json({ success: true, status: 'payment_failed', raw: sres });
    }
    return res.json({ success: true, status: 'pending', raw: sres });
  } catch (e) {
    return res.json({ success: false, message: e.message || 'Server error' });
  }
});

// deliver (force deliver by order number)
app.post('/api/deliver', async (req, res) => {
  try {
    const order_no = req.body.order_no;
    if (!order_no) return res.json({ success: false, message: 'Missing order_no' });
    const ord = findOrder(order_no);
    if (!ord) return res.json({ success: false, message: 'Order not found' });
    if (ord.status !== 'paid') updateOrderByNo(order_no, { status: 'paid' });
    const dres = await deliverAirtime(order_no);
    if (dres.success) return res.json({ success: true, message: 'Airtime delivered', statum: dres.statum });
    return res.json({ success: false, message: 'Delivery failed', statum: dres.statum || dres });
  } catch (e) {
    return res.json({ success: false, message: e.message || 'Server error' });
  }
});

// ----- Admin endpoints (token protected) -----
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token || req.body.token;
  if (token === ADMIN_UI_TOKEN) return next();
  res.status(401).json({ success: false, message: 'Unauthorized' });
}

app.get('/admin/orders', adminAuth, (req, res) => {
  try {
    const filter = req.query.filter || 'all';
    const q = (req.query.q || '').toLowerCase();
    let list = ORDERS.slice();
    if (filter === 'paid') list = list.filter(x => x.status === 'paid');
    else if (filter === 'pending') list = list.filter(x => x.status && x.status.indexOf('pending') !== -1);
    else if (filter === 'cancelled') list = list.filter(x => ['payment_failed', 'delivery_failed', 'failed_payment_init', 'payment_timeout'].includes(x.status));
    if (q) list = list.filter(o => (o.order_no || '').toLowerCase().includes(q) || (o.transaction_code || '').toLowerCase().includes(q) || (o.payer_number || '').toLowerCase().includes(q));
    res.json({ success: true, orders: list.slice(0, 1000) });
  } catch (e) { res.json({ success: false, message: e.message || 'Server error' }); }
});

app.get('/admin/order/:order_no', adminAuth, (req, res) => {
  const ord = findOrder(req.params.order_no);
  if (!ord) return res.json({ success: false, message: 'Not found' });
  res.json({ success: true, order: ord });
});

app.get('/admin/settings', adminAuth, (req, res) => res.json({ success: true, settings: SETTINGS }));
app.post('/admin/settings', adminAuth, (req, res) => {
  Object.keys(req.body || {}).forEach(k => SETTINGS[k] = String(req.body[k] ?? ''));
  saveSettings();
  res.json({ success: true, message: 'Saved' });
});

app.post('/admin/alert', adminAuth, async (req, res) => {
  const text = req.body.text || 'Test alert';
  await alertAdmin(text);
  res.json({ success: true });
});

app.get('/admin', (req, res) => {
  if (req.query.token !== ADMIN_UI_TOKEN) return res.status(401).send('Unauthorized. Provide ?token=ADMIN_UI_TOKEN');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/health', (req, res) => res.json({ ok: true }));

// ----- Message handler (admin WhatsApp control + user flows) -----
const SESSIONS = new Map();

client.on('message', async msg => {
  try {
    const from = msg.from;
    const fromPhone = (from || '').replace('@c.us', '').replace('@g.us', '');
    const body = (msg.body || '').trim();
    if (!body) return;

    // Admin commands (only from configured admin number)
    if (ADMIN_WHATSAPP && fromPhone === ADMIN_WHATSAPP) {
      if (/^\/set\s+/i.test(body)) {
        const text = body.replace(/^\/set\s+/i, '').trim();
        const idx = text.indexOf('=');
        if (idx === -1) { client.sendMessage(from, 'Usage: /set key=value'); return; }
        const key = text.substring(0, idx).trim(); const value = text.substring(idx + 1).trim();
        SETTINGS[key] = value; saveSettings();
        client.sendMessage(from, `✅ Setting *${key}* updated to:\n\`${value}\``);
        return;
      }
      if (/^\/get\s+/i.test(body)) {
        const key = body.replace(/^\/get\s+/i, '').trim();
        const val = SETTINGS[key];
        client.sendMessage(from, `🔎 *${key}* = \`${val === undefined ? 'NOT SET' : val}\``);
        return;
      }
      if (/^\/settings$/i.test(body)) {
        let msgText = '⚙️ Settings:\n';
        Object.keys(SETTINGS).forEach(k => { msgText += `• ${k} = ${SETTINGS[k]}\n`; });
        client.sendMessage(from, msgText);
        return;
      }
      if (/^\/orders/i.test(body)) {
        const parts = body.split(/\s+/);
        const filter = parts[1] || 'all';
        let arr = ORDERS.slice();
        if (filter === 'paid') arr = arr.filter(x => x.status === 'paid');
        else if (filter === 'pending') arr = arr.filter(x => x.status && x.status.indexOf('pending') !== -1);
        else if (filter === 'cancelled') arr = arr.filter(x => ['payment_failed', 'delivery_failed', 'failed_payment_init', 'payment_timeout'].includes(x.status));
        if (!arr.length) { client.sendMessage(from, `No orders for filter: ${filter}`); return; }
        let out = `📋 Orders (${filter}) — showing ${arr.length}\n\n`;
        arr.slice(0, 50).forEach(o => out += `• ${o.order_no} — KES ${o.amount} — ${o.status} — ${o.created_at}\n`);
        client.sendMessage(from, out);
        return;
      }
      if (/^\/order\s+/i.test(body)) {
        const orderNo = body.replace(/^\/order\s+/i, '').trim();
        const ord = findOrder(orderNo);
        if (!ord) { client.sendMessage(from, `Order not found: ${orderNo}`); return; }
        client.sendMessage(from, prettyOrder(ord));
        return;
      }
      if (/^\/showqr$/i.test(body)) {
        if (!lastQrDataUrl) {
          client.sendMessage(from, 'No QR currently available. If client already logged in there may be no QR. If you want a new QR run /relogin (will clear session).');
          return;
        }
        const idx = lastQrDataUrl.indexOf('base64,');
        if (idx === -1) { client.sendMessage(from, 'QR not available'); return; }
        const base64 = lastQrDataUrl.substring(idx + 7);
        const media = new MessageMedia('image/png', base64, 'qr.png');
        client.sendMessage(from, media).then(() => client.sendMessage(from, '📷 QR image sent. Scan using WhatsApp Linked Devices -> Link a device.'));
        return;
      }
      if (/^\/relogin$/i.test(body)) {
        client.sendMessage(from, '⚠️ Re-initializing session. This will clear existing session and produce a new QR. Type /confirmrelogin to confirm.');
        SETTINGS.__confirm_relogin = now();
        saveSettings();
        return;
      }
      if (/^\/confirmrelogin$/i.test(body)) {
        const t = SETTINGS.__confirm_relogin || '';
        if (!t) { client.sendMessage(from, 'No relogin requested. Use /relogin first.'); return; }
        try {
          client.sendMessage(from, '✅ Logging out and creating a new session. QR will be emitted to console and web dashboard.');
          await client.logout();
          try {
            const p = path.resolve(SESSION_DIR);
            if (fs.existsSync(p)) {
              fs.rmSync(p, { recursive: true, force: true });
              console.log('Removed session dir to force fresh login:', p);
            }
          } catch (e) { console.warn('Failed to remove session dir', e && e.message ? e.message : e); }
          setTimeout(() => { client.initialize().catch(e => console.error('re-init error', e)); }, 1500);
          delete SETTINGS.__confirm_relogin; saveSettings();
        } catch (e) {
          client.sendMessage(from, `⚠️ Re-login failed: ${e && e.message ? e.message : e}`);
        }
        return;
      }
      if (/^\/help$/i.test(body) || /^help$/i.test(body)) {
        const h = `Admin commands:\n• /settings — list settings\n• /get key — get setting\n• /set key=value — update setting\n• /orders [paid|pending|cancelled] — list orders\n• /order <order_no> — show order\n• /showqr — send QR image to this WhatsApp\n• /relogin -> /confirmrelogin — force new QR (clears session)\n`;
        client.sendMessage(from, h);
        return;
      }
    } // end admin block

    // ----- regular user menu -----
    if (!SESSIONS.has(fromPhone)) SESSIONS.set(fromPhone, { step: 'MENU', temp: {} });
    const s = SESSIONS.get(fromPhone);

    if (/^menu$/i.test(body) || body === '0') { s.step = 'MENU'; s.temp = {}; }

    switch (s.step) {
      case 'MENU':
        await client.sendMessage(from, `👋 Welcome to *FY'S Airtime Bot*\nChoose:\n1) Buy Airtime\n2) Check Order Status\n3) Help\n\nType 0 or 'menu' anytime to return.`);
        s.step = 'AWAITING_MENU';
        break;

      case 'AWAITING_MENU':
        if (body === '1') { s.step = 'BUY_AMOUNT'; s.temp = {}; await client.sendMessage(from, 'Enter amount KES (e.g., 100):'); return; }
        if (body === '2') { s.step = 'CHECK_ORDER'; s.temp = {}; await client.sendMessage(from, 'Enter your order number (FYS-XXXXXXXX):'); return; }
        if (body === '3') { await client.sendMessage(from, `Help: Admin alerts: ${ADMIN_WHATSAPP ? '+' + ADMIN_WHATSAPP : 'Not configured'}`); s.step = 'MENU'; return; }
        await client.sendMessage(from, 'Send 1, 2 or 3.'); return;

      case 'BUY_AMOUNT': {
        const amt = parseFloat(body.replace(/[^0-9.]/g, ''));
        if (!amt || amt <= 0) { await client.sendMessage(from, 'Enter a valid amount like 100'); return; }
        s.temp.amount = amt; s.step = 'BUY_FOR'; await client.sendMessage(from, '1) Myself (STK)  2) Another'); return;
      }

      case 'BUY_FOR':
        if (body === '1' || /self|myself/i.test(body)) { s.temp.buy_for = 'self'; s.step = 'BUY_PAYER'; await client.sendMessage(from, 'Enter M-Pesa number (07XXXXXXXX or 2547XXXXXXXX):'); return; }
        if (body === '2' || /another/i.test(body)) { s.temp.buy_for = 'other'; s.step = 'BUY_PAYER'; await client.sendMessage(from, 'Enter payer number (07XXXXXXXX or 2547XXXXXXXX):'); return; }
        await client.sendMessage(from, 'Choose 1 or 2'); return;

      case 'BUY_PAYER': {
        let payer = body;
        if (/^default$/i.test(body) && fromPhone) payer = fromPhone;
        payer = normalizePhone(payer);
        if (!/^254[0-9]{9}$/.test(payer)) { await client.sendMessage(from, 'Invalid phone. Use 07XXXXXXXX or 2547XXXXXXXX'); return; }
        s.temp.payer = payer;
        if (s.temp.buy_for === 'other') { s.step = 'BUY_RECIPIENT'; await client.sendMessage(from, 'Enter recipient number to receive airtime:'); return; }
        s.temp.recipient = s.temp.payer; s.step = 'BUY_CONFIRM'; await client.sendMessage(from, `Confirm:\nPayer: +${s.temp.payer}\nRecipient: +${s.temp.recipient}\nAmount: KES ${parseFloat(s.temp.amount).toFixed(2)}\nType 'confirm' or 'cancel'`); return;
      }

      case 'BUY_RECIPIENT': {
        const rec = normalizePhone(body);
        if (!/^254[0-9]{9}$/.test(rec)) { await client.sendMessage(from, 'Invalid recipient number'); return; }
        s.temp.recipient = rec; s.step = 'BUY_CONFIRM'; await client.sendMessage(from, `Confirm:\nPayer: +${s.temp.payer}\nRecipient: +${s.temp.recipient}\nAmount: KES ${parseFloat(s.temp.amount).toFixed(2)}\nType 'confirm' or 'cancel'`); return;
      }

      case 'BUY_CONFIRM':
        if (/^confirm$/i.test(body)) {
          try {
            const resp = await axios.post(`${BASE_URL}/api/initiate`, {
              buy_for: s.temp.buy_for, mpesa_number: s.temp.payer, payer_number: s.temp.payer,
              recipient_number: s.temp.recipient, amount: s.temp.amount
            }, { timeout: 20000 });
            const j = resp.data;
            if (j && j.success) {
              await client.sendMessage(from, `✅ STK sent! Order: *${j.order_no}*`);
              await alertAdmin(`🔔 New order ${j.order_no} from WhatsApp. Amount KES ${s.temp.amount}`);
              s.step = 'MENU'; s.temp = {}; return;
            } else {
              await client.sendMessage(from, `❌ Failed: ${j && j.message ? j.message : 'Unknown'}`); s.step = 'MENU'; s.temp = {}; return;
            }
          } catch (e) { await client.sendMessage(from, 'Network error while initiating'); s.step = 'MENU'; s.temp = {}; return; }
        } else if (/^cancel$/i.test(body)) { await client.sendMessage(from, 'Cancelled'); s.step = 'MENU'; s.temp = {}; return; } else { await client.sendMessage(from, "Type 'confirm' or 'cancel'"); return; }

      case 'CHECK_ORDER': {
        const orderNo = body.trim();
        if (!orderNo) { await client.sendMessage(from, 'Enter order number'); return; }
        try {
          const resp = await axios.post(`${BASE_URL}/api/get_order`, { order_no: orderNo }, { timeout: 10000 });
          const j = resp.data;
          if (j && j.success && j.order) { await client.sendMessage(from, prettyOrder(j.order)); } else { await client.sendMessage(from, `Order not found: ${orderNo}`); }
        } catch (e) { await client.sendMessage(from, 'Network error while checking order'); }
        s.step = 'MENU'; s.temp = {}; return;
      }

      default:
        s.step = 'MENU'; s.temp = {}; await client.sendMessage(from, 'Type menu for options'); return;
    }

  } catch (e) {
    console.error('message handler error', e && e.message ? e.message : e);
  }
});

// initialize client and start server
client.initialize().catch(e => console.error('client init error', e));

server.listen(PORT, async () => {
  console.log(`Server running at ${BASE_URL}`);
  console.log(`Open ${BASE_URL}/ to view QR dashboard (socket.io). Admin UI (if present) at ${BASE_URL}/admin?token=${ADMIN_UI_TOKEN}`);
  // Immediately attempt to notify admin (if client ready it will send; otherwise ensureStartupAlert will send when ready)
  try { await ensureStartupAlert(); } catch (e) { console.warn('[startup] ensureStartupAlert top-level error', e); }
});
