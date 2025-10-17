/**
 * server.js
 * FY'S Airtime Bot - Standalone Node (no DB, file-backed storage)
 *
 * Features:
 * - whatsapp-web.js with LocalAuth (scan QR at /)
 * - Shadow STK push + status polling via Shadow endpoints:
 *    https://shadow-pay.top/api/v2/stkpush.php
 *    https://shadow-pay.top/api/v2/status.php
 * - Statum airtime delivery via:
 *    https://api.statum.co.ke/api/v2/airtime
 * - Orders and settings stored in JSON files under ./data
 * - Admin UI (token protected) to view/search/filter, update settings
 * - Alerts to ADMIN_WHATSAPP for new orders and startup
 *
 * Usage:
 *   npm install
 *   copy .env.example -> .env and edit
 *   node server.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const qrcode = require('qrcode');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const ADMIN_WHATSAPP = (process.env.ADMIN_WHATSAPP || '').replace(/\D/g, '');
const ADMIN_UI_TOKEN = process.env.ADMIN_UI_TOKEN || 'changeme-strong-token';
const SESSION_DIR = process.env.SESSION_DIR || './session';
const POLL_SECONDS = parseInt(process.env.POLL_SECONDS || '20', 10);
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '5', 10);

// Shadow & Statum endpoints (from your earlier code)
const SHADOW_STK_URL = 'https://shadow-pay.top/api/v2/stkpush.php';
const SHADOW_STATUS_URL = 'https://shadow-pay.top/api/v2/status.php';
const STATUM_AIRTIME_URL = 'https://api.statum.co.ke/api/v2/airtime';

// Data files (simple JSON persistence)
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// Load or init JSON storage
function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) { fs.writeFileSync(file, JSON.stringify(fallback, null, 2)); return fallback; }
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw || 'null') ?? fallback;
  } catch (e) { console.error('readJson error', e); return fallback; }
}
function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

let ORDERS = readJson(ORDERS_FILE, []); // array of order objects
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

// helpers to persist
function saveOrders(){ writeJson(ORDERS_FILE, ORDERS); }
function saveSettings(){ writeJson(SETTINGS_FILE, SETTINGS); }

// small helper
function now(){ return new Date().toISOString().replace('T',' ').replace('Z',''); }

// generate order number like FYS-XXXXXXXX
function genOrderNo(){
  return 'FYS-' + Math.floor(Math.random() * 1e8).toString().padStart(8,'0');
}

// normalize phone
function normalizePhone(p){
  if(!p) return '';
  let s = String(p).replace(/\D/g,'');
  if (/^254[0-9]{9}$/.test(s)) return s;
  if (/^0[0-9]{9}$/.test(s)) return '254' + s.substring(1);
  if (/^[0-9]{9}$/.test(s)) return '254' + s;
  return s;
}

// format for whatsapp-web.js (jid)
function toJid(phone){
  if(!phone) return null;
  return phone.replace(/\D/g,'') + '@c.us';
}

// pretty order text
function prettyOrder(o){
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

// ----- Shadow & Statum wrappers (axios) -----
// shadowInitiate: sends STK push
async function shadowInitiate(apiKey, apiSecret, accountId, phone, amount, reference, description){
  try{
    const payload = {
      payment_account_id: parseInt(accountId || '0',10),
      phone: phone,
      amount: parseFloat(amount),
      reference: reference,
      description: description
    };
    const res = await axios.post(SHADOW_STK_URL, payload, {
      headers: {
        'X-API-Key': apiKey || '',
        'X-API-Secret': apiSecret || '',
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });
    return res.data;
  }catch(e){
    return { success:false, message: e.response && e.response.data ? JSON.stringify(e.response.data) : e.message };
  }
}

// shadowStatus: check payment status
async function shadowStatus(apiKey, apiSecret, checkout_request_id){
  try{
    const payload = { checkout_request_id: checkout_request_id };
    const res = await axios.post(SHADOW_STATUS_URL, payload, {
      headers: {
        'X-API-Key': apiKey || '',
        'X-API-Secret': apiSecret || '',
        'Content-Type': 'application/json'
      },
      timeout: 20000
    });
    return res.data;
  }catch(e){
    return { success:false, message: e.response && e.response.data ? JSON.stringify(e.response.data) : e.message };
  }
}

// statumSend: deliver airtime
async function statumSend(consumerKey, consumerSecret, phone, amount){
  try{
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    const payload = { phone_number: phone, amount: String(amount) };
    const res = await axios.post(STATUM_AIRTIME_URL, payload, {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });
    return res.data;
  }catch(e){
    return { success:false, message: e.response && e.response.data ? JSON.stringify(e.response.data) : e.message };
  }
}

// ----- Express + Socket.IO server + WhatsApp client -----
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// WhatsApp client init (LocalAuth)
const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'fy-bot', dataPath: SESSION_DIR }),
  puppeteer: { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] }
});

// socket.io connection to send QR image and status
io.on('connection', socket => {
  // send current connection status
  socket.emit('status', { connected: client.info && client.info.wid ? true : false });
});

// deliver admin alerts via WhatsApp
async function alertAdmin(text){
  if(!ADMIN_WHATSAPP) return;
  try{
    const to = toJid(ADMIN_WHATSAPP);
    await client.sendMessage(to, text);
  }catch(e){
    console.error('alertAdmin error', e.message);
  }
}

// ----- WhatsApp events -----
client.on('qr', qr => {
  qrcode.toDataURL(qr).then(url => {
    io.emit('qr', { url });
  }).catch(err => {
    console.error('QR -> toDataURL error', err);
    io.emit('qr', { url: null });
  });
});

client.on('ready', async () => {
  console.log('WhatsApp client ready');
  io.emit('status', { connected: true });
  await alertAdmin(`✅ *FY Bot* is online. (WhatsApp)`);
});

// auth events
client.on('authenticated', () => console.log('WhatsApp authenticated'));
client.on('auth_failure', msg => { console.error('Auth failure', msg); io.emit('status', { connected: false, error: 'auth_failure' }); });
client.on('disconnected', reason => { console.log('Disconnected', reason); io.emit('status', { connected: false }); });

// conversation state (in-memory)
const SESSIONS = new Map();

// utility functions for order lifecycle
function createOrder(payer, recipient, amount, discountPercent) {
  const order = {
    id: uuidv4(),
    order_no: genOrderNo(),
    payer_number: payer,
    recipient_number: recipient,
    amount: parseFloat(amount),
    amount_payable: parseFloat((amount - (amount * (parseFloat(discountPercent || '0')/100))).toFixed(2)),
    discount_percent: parseFloat(discountPercent || '0'),
    status: 'pending_payment',
    checkout_request_id: null,
    merchant_request_id: null,
    transaction_code: null,
    airtime_status: null,
    airtime_response: null,
    created_at: now(),
    updated_at: now()
  };
  ORDERS.unshift(order); // keep newest first
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

function findOrder(order_no) {
  return ORDERS.find(x => x.order_no === order_no) || null;
}

// Polling helper for a specific order (checkout_request_id)
async function pollPayment(checkout_request_id, orderNo, pollSecondsOverride) {
  const apiKey = SETTINGS.shadow_api_key;
  const apiSecret = SETTINGS.shadow_api_secret;
  const timeout = parseInt(pollSecondsOverride ?? SETTINGS.payment_poll_seconds ?? POLL_SECONDS, 10);
  const interval = POLL_INTERVAL;
  const attempts = Math.ceil(timeout / interval);

  let paid = false;
  let tx = null;

  for (let i=0;i<attempts;i++){
    await new Promise(r=>setTimeout(r, interval*1000));
    try{
      const sres = await shadowStatus(apiKey, apiSecret, checkout_request_id);
      // if sres reports success/completed or has transaction_code
      const pstatus = (sres.status || sres.result || '').toString().toLowerCase();
      const tcode = sres.transaction_code || sres.transaction || sres.tx || null;
      if (tcode) tx = tcode;
      if (pstatus === 'completed' || pstatus === 'success' || tx) {
        // mark order paid
        updateOrderByCheckout(checkout_request_id, { status: 'paid', transaction_code: tx || null });
        paid = true;
        break;
      }
      // detect explicit failure
      if (pstatus === 'failed' || (sres.message && sres.message.toString().toLowerCase() === 'failed')) {
        updateOrderByCheckout(checkout_request_id, { status: 'payment_failed' });
        break;
      }
      // otherwise continue polling
    } catch(e){
      console.warn('pollPayment shadowStatus error', e.message);
    }
  }
  return { paid, tx };
}

// Process deliver (call Statum)
async function deliverAirtime(orderNo){
  const ord = findOrder(orderNo);
  if (!ord) return { success:false, message:'Order not found' };
  const statKey = SETTINGS.statum_consumer_key;
  const statSecret = SETTINGS.statum_consumer_secret;
  try {
    const sres = await statumSend(statKey, statSecret, ord.recipient_number, ord.amount);
    // statum returns status_code === 200 in earlier PHP code; here check success flags
    // We'll use heuristic: if response has property status_code 200 OR success===true
    if ((sres.status_code && parseInt(sres.status_code) === 200) || sres.success === true) {
      updateOrderByNo(orderNo, { airtime_status: 'delivered', airtime_response: JSON.stringify(sres) });
      return { success:true, statum: sres };
    } else {
      updateOrderByNo(orderNo, { airtime_status: 'delivery_failed', airtime_response: JSON.stringify(sres) });
      return { success:false, statum: sres };
    }
  } catch(e) {
    updateOrderByNo(orderNo, { airtime_status: 'delivery_failed', airtime_response: e.message });
    return { success:false, message: e.message };
  }
}

// ----- HTTP endpoints (bot + admin) -----
// Public API used by bot flows (we keep them local and file-backed)
app.post('/api/initiate', async (req, res) => {
  try {
    const buy_for = req.body.buy_for || 'self';
    const amount = parseFloat(req.body.amount || 0);
    const min = parseFloat(SETTINGS.min_amount || '1');
    const max = parseFloat(SETTINGS.max_amount || '1500');
    if (!amount || amount < min || amount > max) return res.json({ success:false, message: `Amount must be between KES ${min} and KES ${max}` });

    let payer_raw = req.body.mpesa_number || req.body.payer_number || '';
    let recipient_raw = req.body.recipient_number || payer_raw;

    const payer = normalizePhone(payer_raw);
    const recipient = normalizePhone(recipient_raw);
    if (!/^254[0-9]{9}$/.test(payer) || !/^254[0-9]{9}$/.test(recipient)){
      return res.json({ success:false, message:'Invalid Kenyan phone numbers. Use 07.. or 254.. formats.' });
    }

    // create local order
    const order = createOrder(payer, recipient, amount, SETTINGS.discount_percent || '0');

    // call Shadow STK
    const sres = await shadowInitiate(SETTINGS.shadow_api_key, SETTINGS.shadow_api_secret, SETTINGS.shadow_account_id, payer, order.amount_payable, order.order_no, `Airtime payment ${order.order_no}`);
    if (!sres || !sres.success) {
      updateOrderByNo(order.order_no, { status: 'failed_payment_init', updated_at: now() });
      return res.json({ success:false, message: `Failed to send STK: ${sres && sres.message ? sres.message : 'Unknown'}`, raw: sres });
    }

    // save checkout ids
    const checkout_request_id = sres.checkout_request_id || null;
    const merchant_request_id = sres.merchant_request_id || null;
    updateOrderByNo(order.order_no, { checkout_request_id, merchant_request_id, updated_at: now() });

    // start polling in background
    (async () => {
      const pollTimeout = parseInt(SETTINGS.payment_poll_seconds || POLL_SECONDS, 10);
      const { paid, tx } = await pollPayment(checkout_request_id, order.order_no, pollTimeout);
      if (paid) {
        // deliver airtime
        await alertAdmin(`🔔 Payment confirmed for ${order.order_no}. Delivering airtime...`);
        const dres = await deliverAirtime(order.order_no);
        if (dres.success) {
          await alertAdmin(`✅ Airtime delivered for ${order.order_no}`);
        } else {
          await alertAdmin(`⚠️ Airtime delivery failed for ${order.order_no}`);
        }
      } else {
        // not paid within timeout -> leave as pending or mark failed
        // we keep as pending_payment for user to manually check; optionally mark payment_failed
        const ord = findOrder(order.order_no);
        if (ord && ord.status !== 'paid') {
          updateOrderByNo(order.order_no, { status: 'payment_timeout' });
          await alertAdmin(`⏰ Payment timeout for ${order.order_no}`);
        }
      }
    })();

    return res.json({ success:true, message:'STK push sent', order_no: order.order_no, checkout_request_id, amount_payable: order.amount_payable });
  } catch(e) {
    console.error('initiate error', e);
    return res.json({ success:false, message: e.message });
  }
});

// check status by checkout_request_id
app.post('/api/check_status', async (req, res) => {
  try {
    const checkout = req.body.checkout_request_id || req.body.checkout;
    if (!checkout) return res.json({ success:false, message:'Missing checkout_request_id' });
    const sres = await shadowStatus(SETTINGS.shadow_api_key, SETTINGS.shadow_api_secret, checkout);
    // if paid -> update local order
    const pstatus = (sres.status || sres.result || '').toString().toLowerCase();
    const tx = sres.transaction_code || sres.transaction || null;
    if (pstatus === 'completed' || pstatus === 'success' || tx) {
      updateOrderByCheckout(checkout, { status: 'paid', transaction_code: tx || null });
      return res.json({ success:true, status: 'paid', transaction_code: tx, raw: sres });
    }
    if (pstatus === 'failed' || (sres.message && sres.message.toString().toLowerCase() === 'failed')) {
      updateOrderByCheckout(checkout, { status: 'payment_failed' });
      return res.json({ success:true, status:'payment_failed', raw: sres });
    }
    return res.json({ success:true, status:'pending', raw: sres });
  } catch(e) {
    return res.json({ success:false, message: e.message });
  }
});

// deliver endpoint (force deliver by order_no)
app.post('/api/deliver', async (req, res) => {
  try {
    const order_no = req.body.order_no;
    if (!order_no) return res.json({ success:false, message:'Missing order_no' });
    // mark paid if needed
    const ord = findOrder(order_no);
    if (!ord) return res.json({ success:false, message:'Order not found' });
    if (ord.status !== 'paid') {
      updateOrderByNo(order_no, { status:'paid' });
    }
    const dres = await deliverAirtime(order_no);
    if (dres.success) return res.json({ success:true, message:'Airtime delivered', statum: dres.statum });
    return res.json({ success:false, message:'Delivery failed', statum: dres.statum || dres });
  } catch(e) {
    return res.json({ success:false, message: e.message });
  }
});

// get order
app.post('/api/get_order', (req, res) => {
  try {
    const order_no = req.body.order_no || req.query.order_no;
    if (!order_no) return res.json({ success:false, message:'Missing order_no' });
    const ord = findOrder(order_no);
    if (!ord) return res.json({ success:false, message:'Order not found' });
    return res.json({ success:true, order: ord });
  } catch(e) {
    return res.json({ success:false, message:e.message });
  }
});

// ----- Admin REST (token protected) -----
function adminAuth(req, res, next){
  const token = req.headers['x-admin-token'] || req.query.token || req.body.token;
  if (token === ADMIN_UI_TOKEN) return next();
  return res.status(401).json({ success:false, message:'Unauthorized' });
}

// list orders (filter/search)
app.get('/admin/orders', adminAuth, (req, res) => {
  try {
    const filter = req.query.filter || 'all';
    const q = (req.query.q || '').toLowerCase();
    let list = ORDERS.slice();
    if (filter === 'paid') list = list.filter(x => x.status === 'paid');
    else if (filter === 'pending') list = list.filter(x => x.status && x.status.indexOf('pending') !== -1);
    else if (filter === 'cancelled') list = list.filter(x => ['payment_failed','delivery_failed','failed_payment_init','payment_timeout'].includes(x.status));
    if (q) list = list.filter(o => (o.order_no||'').toLowerCase().includes(q) || (o.transaction_code||'').toLowerCase().includes(q) || (o.payer_number||'').toLowerCase().includes(q));
    return res.json({ success:true, orders: list.slice(0, 1000) });
  } catch(e) {
    return res.json({ success:false, message:e.message });
  }
});

// get single order
app.get('/admin/order/:order_no', adminAuth, (req, res) => {
  const ord = findOrder(req.params.order_no);
  if (!ord) return res.json({ success:false, message:'Not found' });
  return res.json({ success:true, order: ord });
});

// settings read/write
app.get('/admin/settings', adminAuth, (req, res) => { return res.json({ success:true, settings: SETTINGS }); });
app.post('/admin/settings', adminAuth, (req, res) => {
  try {
    const updates = req.body || {};
    Object.keys(updates).forEach(k => { SETTINGS[k] = String(updates[k] ?? ''); });
    saveSettings();
    return res.json({ success:true, message:'Saved' });
  } catch(e) { return res.json({ success:false, message:e.message }); }
});

// admin send alert test
app.post('/admin/alert', adminAuth, async (req, res) => {
  const text = req.body.text || 'Test alert';
  await alertAdmin(text);
  res.json({ success:true });
});

// expose a small health endpoint
app.get('/health', (req,res) => res.json({ ok:true }));

// serve admin UI (static file requires ?token=...)
app.get('/admin', (req,res) => {
  if (req.query.token !== ADMIN_UI_TOKEN) return res.status(401).send('Unauthorized. Provide ?token=ADMIN_UI_TOKEN');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ----- WhatsApp message handler (menu) -----
client.on('message', async msg => {
  try {
    const from = msg.from; // 2547xxx@c.us
    const fromPhone = from.replace('@c.us','').replace('@g.us','');
    const body = (msg.body || '').trim();
    if (!body) return;

    // init session
    if (!SESSIONS.has(fromPhone)) SESSIONS.set(fromPhone, { step: 'MENU', temp: {} });
    const s = SESSIONS.get(fromPhone);

    // support admin commands by whatsapp admin number (direct)
    if (ADMIN_WHATSAPP && fromPhone === ADMIN_WHATSAPP) {
      if (/^\/orders\s*/i.test(body)) {
        const parts = body.split(/\s+/);
        const filter = parts[1] || 'all';
        // reuse admin route
        const arr = ORDERS.filter(o => {
          if (filter === 'paid') return o.status === 'paid';
          if (filter === 'pending') return o.status && o.status.indexOf('pending') !== -1;
          if (filter === 'cancelled') return ['payment_failed','delivery_failed','failed_payment_init','payment_timeout'].includes(o.status);
          return true;
        }).slice(0,50);
        let text = `📋 Orders (${filter}) — showing ${arr.length}\n\n`;
        arr.forEach(o => text += `• ${o.order_no} — KES ${o.amount} — ${o.status} — ${o.created_at}\n`);
        client.sendMessage(from, text);
        return;
      }
      if (/^\/set\s+/i.test(body)) {
        const m = body.replace(/^\/set\s+/i,'');
        const [k, ...vparts] = m.split('=');
        if (!k) { client.sendMessage(from, 'Invalid set format: /set key=value'); return; }
        const key = k.trim(); const val = vparts.join('=').trim();
        SETTINGS[key] = val;
        saveSettings();
        client.sendMessage(from, `✅ Updated ${key}`);
        return;
      }
    }

    // Reset menu
    if (/^menu$/i.test(body) || body === '0') {
      s.step = 'MENU'; s.temp = {};
    }

    switch (s.step) {
      case 'MENU':
        await client.sendMessage(from, `👋 Hello! Welcome to *FY'S Airtime Bot*\nChoose an option:\n\n1️⃣ Buy Airtime (STK push)\n2️⃣ Check Order Status\n3️⃣ Help / Contact\n\nType *0* or *menu* anytime to return here.`);
        s.step = 'AWAITING_MENU';
        break;

      case 'AWAITING_MENU':
        if (body === '1') {
          s.step = 'BUY_AMOUNT'; s.temp = {};
          await client.sendMessage(from, '✳️ *Buy Airtime*\nEnter the *amount* in KES (e.g., 50):');
          return;
        } else if (body === '2') {
          s.step = 'CHECK_ORDER'; s.temp = {};
          await client.sendMessage(from, '🔎 *Check Order Status*\nEnter your order number (e.g., FYS-12345678):');
          return;
        } else if (body === '3') {
          await client.sendMessage(from, `ℹ️ Help\nAdmin alerts: ${ADMIN_WHATSAPP ? '+'+ADMIN_WHATSAPP : 'Not configured'}\nType *menu* to return.`);
          s.step = 'MENU'; return;
        } else {
          await client.sendMessage(from, '❌ Send 1, 2 or 3. Type menu for options.');
          return;
        }

      case 'BUY_AMOUNT':
        {
          const amt = parseFloat(body.replace(/[^0-9.]/g,''));
          if (!amt || amt <= 0) { await client.sendMessage(from, '❌ Enter a valid numeric amount in KES. Example: 100'); return; }
          s.temp.amount = amt;
          s.step = 'BUY_FOR';
          await client.sendMessage(from, 'Who will receive airtime?\n1️⃣ Myself (receive STK prompt)\n2️⃣ Another number');
          return;
        }

      case 'BUY_FOR':
        if (body === '1' || /self|myself/i.test(body)) {
          s.temp.buy_for = 'self';
          const defaultPhone = fromPhone.startsWith('254') ? fromPhone : '';
          s.step = 'BUY_PAYER';
          await client.sendMessage(from, `Enter M-Pesa number to receive STK (07XXXXXXXX or 2547XXXXXXXX):${defaultPhone ? `\nDefault: ${defaultPhone}` : ''}`);
          return;
        } else if (body === '2' || /another/i.test(body)) {
          s.temp.buy_for = 'other';
          s.step = 'BUY_PAYER';
          await client.sendMessage(from, 'Enter Payer (paying) number (07XXXXXXXX or 2547XXXXXXXX):');
          return;
        } else {
          await client.sendMessage(from, '❌ Choose 1 (Myself) or 2 (Another).');
          return;
        }

      case 'BUY_PAYER':
        {
          let payerRaw = body;
          if (/^default$/i.test(body) && fromPhone) payerRaw = fromPhone;
          const p = normalizePhone(payerRaw);
          if (!/^254[0-9]{9}$/.test(p)) { await client.sendMessage(from, '❌ Invalid phone format. Use 07XXXXXXXX or 2547XXXXXXXX.'); return; }
          s.temp.payer = p;
          if (s.temp.buy_for === 'other') {
            s.step = 'BUY_RECIPIENT';
            await client.sendMessage(from, 'Enter recipient number (to receive airtime):');
            return;
          } else {
            s.temp.recipient = s.temp.payer;
            s.step = 'BUY_CONFIRM';
            await client.sendMessage(from, `Confirm:\n• Payer: +${s.temp.payer}\n• Recipient: +${s.temp.recipient}\n• Amount: KES ${parseFloat(s.temp.amount).toFixed(2)}\n\nType *confirm* to send STK or *cancel* to abort.`);
            return;
          }
        }

      case 'BUY_RECIPIENT':
        {
          const recipient = normalizePhone(body);
          if (!/^254[0-9]{9}$/.test(recipient)) { await client.sendMessage(from, '❌ Invalid recipient format. Use 07XXXXXXXX or 2547XXXXXXXX.'); return; }
          s.temp.recipient = recipient;
          s.step = 'BUY_CONFIRM';
          await client.sendMessage(from, `Confirm:\n• Payer: +${s.temp.payer}\n• Recipient: +${s.temp.recipient}\n• Amount: KES ${parseFloat(s.temp.amount).toFixed(2)}\n\nType *confirm* to send STK or *cancel* to abort.`);
          return;
        }

      case 'BUY_CONFIRM':
        if (/^confirm$/i.test(body)) {
          // call local API /api/initiate
          try{
            const resp = await axios.post(`${BASE_URL}/api/initiate`, {
              buy_for: s.temp.buy_for,
              mpesa_number: s.temp.payer,
              payer_number: s.temp.payer,
              recipient_number: s.temp.recipient,
              amount: s.temp.amount
            }, { timeout: 20000 });
            const j = resp.data;
            if (j && j.success) {
              await client.sendMessage(from, `✅ STK Sent!\nOrder: *${j.order_no}*\nWe will check payment for ${SETTINGS.payment_poll_seconds || POLL_SECONDS} seconds. Use option 2 to check status by order number.`);
              await alertAdmin(`🔔 New Order from WhatsApp\n• Order: ${j.order_no}\n• Payer: +${s.temp.payer}\n• Recipient: +${s.temp.recipient}\n• Amount: KES ${parseFloat(s.temp.amount).toFixed(2)}`);
              s.step = 'MENU'; s.temp = {};
              return;
            } else {
              await client.sendMessage(from, `❌ Failed to initiate STK: ${j && j.message ? j.message : 'Unknown'}`);
              s.step = 'MENU'; s.temp = {};
              return;
            }
          }catch(e){
            console.error('buy_confirm error', e.message);
            await client.sendMessage(from, '❌ Network/server error while initiating STK. Try later.');
            s.step = 'MENU'; s.temp = {};
            return;
          }
        } else if (/^cancel$/i.test(body)) {
          await client.sendMessage(from, '❌ Purchase cancelled. Type menu to start again.');
          s.step = 'MENU'; s.temp = {}; return;
        } else {
          await client.sendMessage(from, 'Type *confirm* to proceed or *cancel* to abort.');
          return;
        }

      case 'CHECK_ORDER':
        {
          const orderNo = body.trim();
          if (!orderNo) { await client.sendMessage(from, '❌ Enter order number like FYS-XXXXXXXX'); return; }
          try{
            const resp = await axios.post(`${BASE_URL}/api/get_order`, { order_no: orderNo }, { timeout: 10000 });
            const j = resp.data;
            if (j && j.success && j.order) {
              await client.sendMessage(from, prettyOrder(j.order));
              if (j.order.status && j.order.status.indexOf('pending') !== -1) {
                await client.sendMessage(from, '⌛ Payment not confirmed yet. Wait and check again or contact support.');
              }
            } else {
              await client.sendMessage(from, `❌ Order not found: ${orderNo}`);
            }
          }catch(e){
            console.error('check_order error', e.message);
            await client.sendMessage(from, '❌ Network/server error while checking order.');
          }
          s.step='MENU'; s.temp={}; return;
        }

      default:
        s.step = 'MENU'; s.temp = {}; await client.sendMessage(from, 'Type *menu* for options.'); return;
    }
  } catch(err){
    console.error('message handler error', err);
  }
});

// initialize client
client.initialize().catch(e => console.error('client init error', e));

// serve QR dashboard (public/index.html) and admin UI (public/admin.html)
// public static folder below

// start server
server.listen(PORT, () => console.log(`Server running at ${BASE_URL}`));
