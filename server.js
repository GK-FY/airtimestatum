/**
 * server.js - FY Bot (no DB)
 * - instant QR: console ASCII + web dashboard + can send QR image to admin on request
 * - admin WhatsApp number can change settings with commands
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

const PORT = process.env.PORT || 5000;
const BASE_URL = process.env.BASE_URL || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : `http://localhost:${PORT}`);
const ADMIN_WHATSAPP = (process.env.ADMIN_WHATSAPP || '').replace(/\D/g, '');
const ADMIN_UI_TOKEN = process.env.ADMIN_UI_TOKEN || 'changeme-strong-token';
const SESSION_DIR = process.env.SESSION_DIR || './session';
const POLL_SECONDS = parseInt(process.env.POLL_SECONDS || '20', 10);
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '5', 10);

// endpoints used
const SHADOW_STK_URL = 'https://shadow-pay.top/api/v2/stkpush.php';
const SHADOW_STATUS_URL = 'https://shadow-pay.top/api/v2/status.php';
const STATUM_AIRTIME_URL = 'https://api.statum.co.ke/api/v2/airtime';

// file-backed storage
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

function readJson(file, fallback){ try{ if(!fs.existsSync(file)){ fs.writeFileSync(file, JSON.stringify(fallback, null, 2)); return fallback; } const raw = fs.readFileSync(file,'utf8'); return JSON.parse(raw || 'null') ?? fallback; } catch(e){ console.error('readJson', e); return fallback; } }
function writeJson(file, obj){ fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }

let ORDERS = readJson(ORDERS_FILE, []);
let SETTINGS = readJson(SETTINGS_FILE, {
  bot_name: 'FY Bot',
  statum_consumer_key: '19554299a04b8d74fefaaa4066766629244',
  statum_consumer_secret: '9Kf3kCFYois2hmaXO1yi195pVAhK',
  shadow_api_key: 'Admin-api1234',
  shadow_api_secret: 'Admin-secret1234',
  shadow_account_id: '17',
  min_amount: '10',
  max_amount: '1500',
  discount_percent: '0',
  payment_poll_seconds: String(POLL_SECONDS)
});
function saveOrders(){ writeJson(ORDERS_FILE, ORDERS); }
function saveSettings(){ writeJson(SETTINGS_FILE, SETTINGS); }

function now(){ return new Date().toISOString().replace('T',' ').replace('Z',''); }
function genOrderNo(){ return 'FYS-' + Math.floor(Math.random() * 1e8).toString().padStart(8,'0'); }
function normalizePhone(p){ if(!p) return ''; let s = String(p).replace(/\D/g,''); if(/^254[0-9]{9}$/.test(s)) return s; if(/^0[0-9]{9}$/.test(s)) return '254'+s.substring(1); if(/^[0-9]{9}$/.test(s)) return '254'+s; return s; }
function toJid(phone){ if(!phone) return null; return phone.replace(/\D/g,'') + '@c.us'; }
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

// Shadow & Statum wrappers
async function shadowInitiate(apiKey, apiSecret, accountId, phone, amount, reference, description){
  try {
    const payload = { payment_account_id: parseInt(accountId||'0',10), phone, amount: parseFloat(amount), reference, description };
    const r = await axios.post(SHADOW_STK_URL, payload, { headers:{ 'X-API-Key': apiKey||'', 'X-API-Secret': apiSecret||'', 'Content-Type':'application/json' }, timeout:30000 });
    return r.data;
  } catch(e) {
    return { success:false, message: e.response && e.response.data ? JSON.stringify(e.response.data) : e.message };
  }
}
async function shadowStatus(apiKey, apiSecret, checkout_request_id){
  try {
    const payload = { checkout_request_id };
    const r = await axios.post(SHADOW_STATUS_URL, payload, { headers:{ 'X-API-Key': apiKey||'', 'X-API-Secret': apiSecret||'', 'Content-Type':'application/json' }, timeout:20000 });
    return r.data;
  } catch(e) {
    return { success:false, message: e.response && e.response.data ? JSON.stringify(e.response.data) : e.message };
  }
}
async function statumSend(consumerKey, consumerSecret, phone, amount){
  try {
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    const payload = { phone_number: phone, amount: String(amount) };
    const r = await axios.post(STATUM_AIRTIME_URL, payload, { headers:{ Authorization:`Basic ${auth}`, 'Content-Type':'application/json' }, timeout:30000 });
    return r.data;
  } catch(e) {
    return { success:false, message: e.response && e.response.data ? JSON.stringify(e.response.data) : e.message };
  }
}

// create and update orders
function createOrder(payer, recipient, amount, discount){
  const order = {
    id: uuidv4(),
    order_no: genOrderNo(),
    payer_number: payer,
    recipient_number: recipient,
    amount: parseFloat(amount),
    amount_payable: parseFloat((amount - (amount * (parseFloat(discount||'0')/100))).toFixed(2)),
    discount_percent: parseFloat(discount||'0'),
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
function updateOrderByCheckout(checkout, data){
  let changed=false;
  for(const o of ORDERS){ if(o.checkout_request_id && o.checkout_request_id===checkout){ Object.assign(o, data); o.updated_at=now(); changed=true; break; } }
  if(changed) saveOrders();
}
function updateOrderByNo(order_no, data){
  for(const o of ORDERS){ if(o.order_no===order_no){ Object.assign(o, data); o.updated_at=now(); saveOrders(); return o; } }
  return null;
}
function findOrder(order_no){ return ORDERS.find(x=>x.order_no===order_no) || null; }

// poll payment and deliver
async function pollPayment(checkout_request_id, orderNo, pollSecondsOverride){
  const apiKey = SETTINGS.shadow_api_key; const apiSecret = SETTINGS.shadow_api_secret;
  const timeout = parseInt(pollSecondsOverride ?? SETTINGS.payment_poll_seconds ?? POLL_SECONDS, 10);
  const attempts = Math.ceil(timeout / POLL_INTERVAL);
  let paid=false; let tx=null;
  for(let i=0;i<attempts;i++){
    await new Promise(r=>setTimeout(r, POLL_INTERVAL*1000));
    try{
      const sres = await shadowStatus(apiKey, apiSecret, checkout_request_id);
      const pstatus = (sres.status || sres.result || '').toString().toLowerCase();
      const tcode = sres.transaction_code || sres.transaction || sres.tx || null;
      if(tcode) tx = tcode;
      if(pstatus==='completed' || pstatus==='success' || tx){
        updateOrderByCheckout(checkout_request_id, { status: 'paid', transaction_code: tx || null });
        paid=true; break;
      }
      if(pstatus==='failed' || (sres.message && sres.message.toString().toLowerCase()==='failed')){
        updateOrderByCheckout(checkout_request_id, { status: 'payment_failed' });
        break;
      }
    } catch(e){ console.warn('pollPayment error', e.message); }
  }
  return { paid, tx };
}
async function deliverAirtime(orderNo){
  const ord = findOrder(orderNo);
  if(!ord) return { success:false, message:'Order not found' };
  try{
    const sres = await statumSend(SETTINGS.statum_consumer_key, SETTINGS.statum_consumer_secret, ord.recipient_number, ord.amount);
    if((sres.status_code && parseInt(sres.status_code)===200) || sres.success===true){
      updateOrderByNo(orderNo, { airtime_status:'delivered', airtime_response: JSON.stringify(sres) });
      return { success:true, statum:sres };
    } else {
      updateOrderByNo(orderNo, { airtime_status:'delivery_failed', airtime_response: JSON.stringify(sres) });
      return { success:false, statum:sres };
    }
  } catch(e){
    updateOrderByNo(orderNo, { airtime_status:'delivery_failed', airtime_response: e.message });
    return { success:false, message: e.message };
  }
}

// ----- Express + Socket.IO & WhatsApp client -----
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(bodyParser.json()); app.use(bodyParser.urlencoded({ extended:true }));
app.use(cors()); app.use(express.static(path.join(__dirname,'public')));

const execSync = require('child_process').execSync;
let chromiumPath;
try {
  chromiumPath = execSync('which chromium').toString().trim();
} catch(e) {
  chromiumPath = undefined;
}

const puppeteerConfig = {
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--disable-gpu'
  ]
};
if (chromiumPath) {
  puppeteerConfig.executablePath = chromiumPath;
}

const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'fy-bot', dataPath: SESSION_DIR }),
  puppeteer: puppeteerConfig
});

// store last QR dataURL and raw QR text for instant reuse
let lastQrDataUrl = null;
let lastQrText = null;

// socket client connect: send current status & last QR if available
io.on('connection', socket => {
  socket.emit('status', { connected: client.info && client.info.wid ? true : false });
  if(lastQrDataUrl) socket.emit('qr', { url: lastQrDataUrl });
});

// helper to send alert to admin whatsapp
async function alertAdmin(text){
  if(!ADMIN_WHATSAPP) return;
  try{
    const to = toJid(ADMIN_WHATSAPP);
    await client.sendMessage(to, text);
  } catch(e){ console.error('alertAdmin', e.message); }
}

// QR events: produce dataURL, print ascii to console immediately, emit via socket, keep lastQr
client.on('qr', async qr => {
  try {
    lastQrText = qr;
    qrcodeTerminal.generate(qr, { small: true });                // ASCII QR in console (instant)
    console.log('Scan the QR in the web dashboard or console (ASCII above).');

    // create a dataURL for web
    const dataUrl = await qrcode.toDataURL(qr);
    lastQrDataUrl = dataUrl;
    io.emit('qr', { url: dataUrl });
  } catch(e) { console.error('qr handling error', e); }
});

client.on('ready', async () => {
  console.log('WhatsApp client ready!');
  io.emit('status', { connected: true });
  await alertAdmin(`✅ *${SETTINGS.bot_name || 'FY Bot'}* is online.`);
});

client.on('authenticated', () => console.log('Authenticated'));
client.on('auth_failure', msg => { console.error('Auth failure', msg); io.emit('status',{connected:false,error:'auth_failure'}); });
client.on('disconnected', reason => { console.log('Disconnected', reason); io.emit('status',{connected:false}); });

// ----- API routes (file-backed) -----
app.post('/api/initiate', async (req, res) => {
  try {
    const buy_for = req.body.buy_for || 'self';
    const amount = parseFloat(req.body.amount || 0);
    const min = parseFloat(SETTINGS.min_amount || '1'); const max = parseFloat(SETTINGS.max_amount || '1500');
    if(!amount || amount < min || amount > max) return res.json({ success:false, message:`Amount must be between KES ${min} and KES ${max}` });

    const payer_raw = req.body.mpesa_number || req.body.payer_number || '';
    const recipient_raw = req.body.recipient_number || payer_raw;
    const payer = normalizePhone(payer_raw);
    const recipient = normalizePhone(recipient_raw);
    if(!/^254[0-9]{9}$/.test(payer) || !/^254[0-9]{9}$/.test(recipient)) return res.json({ success:false, message:'Invalid Kenyan phone numbers.' });

    const order = createOrder(payer, recipient, amount, SETTINGS.discount_percent || '0');

    // call Shadow
    const sres = await shadowInitiate(SETTINGS.shadow_api_key, SETTINGS.shadow_api_secret, SETTINGS.shadow_account_id, payer, order.amount_payable, order.order_no, `Airtime payment ${order.order_no}`);
    if(!sres || !sres.success){
      updateOrderByNo(order.order_no, { status:'failed_payment_init' });
      return res.json({ success:false, message: `Failed to send STK: ${sres && sres.message ? sres.message : 'Unknown'}`, raw: sres });
    }

    const checkout_request_id = sres.checkout_request_id || null;
    const merchant_request_id = sres.merchant_request_id || null;
    updateOrderByNo(order.order_no, { checkout_request_id, merchant_request_id });

    (async ()=>{
      const pollTimeout = parseInt(SETTINGS.payment_poll_seconds || POLL_SECONDS, 10);
      const { paid, tx } = await pollPayment(checkout_request_id, order.order_no, pollTimeout);
      if(paid){
        await alertAdmin(`🔔 Payment confirmed for ${order.order_no}. Delivering airtime...`);
        const dres = await deliverAirtime(order.order_no);
        if(dres.success) await alertAdmin(`✅ Airtime delivered for ${order.order_no}`);
        else await alertAdmin(`⚠️ Airtime delivery failed for ${order.order_no}`);
      } else {
        const ord = findOrder(order.order_no);
        if(ord && ord.status !== 'paid'){ updateOrderByNo(order.order_no, { status:'payment_timeout' }); await alertAdmin(`⏰ Payment timeout for ${order.order_no}`); }
      }
    })();

    return res.json({ success:true, message:'STK push sent', order_no: order.order_no, checkout_request_id, amount_payable: order.amount_payable });
  } catch(e){ console.error('initiate error', e); return res.json({ success:false, message: e.message }); }
});

app.post('/api/get_order', (req, res) => {
  try {
    const order_no = req.body.order_no || req.query.order_no;
    if(!order_no) return res.json({ success:false, message:'Missing order_no' });
    const ord = findOrder(order_no);
    if(!ord) return res.json({ success:false, message:'Order not found' });
    return res.json({ success:true, order: ord });
  } catch(e){ return res.json({ success:false, message: e.message }); }
});

app.post('/api/check_status', async (req, res) => {
  try {
    const checkout = req.body.checkout_request_id || req.body.checkout;
    if(!checkout) return res.json({ success:false, message:'Missing checkout_request_id' });
    const sres = await shadowStatus(SETTINGS.shadow_api_key, SETTINGS.shadow_api_secret, checkout);
    const pstatus = (sres.status || sres.result || '').toString().toLowerCase();
    const tx = sres.transaction_code || sres.transaction || null;
    if(pstatus==='completed' || pstatus==='success' || tx){ updateOrderByCheckout(checkout, { status:'paid', transaction_code: tx || null }); return res.json({ success:true, status:'paid', transaction_code: tx, raw: sres }); }
    if(pstatus==='failed' || (sres.message && sres.message.toString().toLowerCase()==='failed')){ updateOrderByCheckout(checkout, { status:'payment_failed' }); return res.json({ success:true, status:'payment_failed', raw: sres }); }
    return res.json({ success:true, status:'pending', raw: sres });
  } catch(e){ return res.json({ success:false, message: e.message }); }
});

app.post('/api/deliver', async (req, res) => {
  try {
    const order_no = req.body.order_no;
    if(!order_no) return res.json({ success:false, message:'Missing order_no' });
    const ord = findOrder(order_no);
    if(!ord) return res.json({ success:false, message:'Order not found' });
    if(ord.status !== 'paid') updateOrderByNo(order_no, { status:'paid' });
    const dres = await deliverAirtime(order_no);
    if(dres.success) return res.json({ success:true, message:'Airtime delivered', statum: dres.statum });
    return res.json({ success:false, message:'Delivery failed', statum: dres.statum || dres });
  } catch(e){ return res.json({ success:false, message: e.message }); }
});

// ----- Admin endpoints (token protected) -----
function adminAuth(req, res, next){
  const token = req.headers['x-admin-token'] || req.query.token || req.body.token;
  if(token === ADMIN_UI_TOKEN) return next();
  res.status(401).json({ success:false, message:'Unauthorized' });
}

app.get('/admin/orders', adminAuth, (req, res) => {
  try {
    const filter = req.query.filter || 'all';
    const q = (req.query.q||'').toLowerCase();
    let list = ORDERS.slice();
    if(filter==='paid') list = list.filter(x => x.status === 'paid');
    else if(filter==='pending') list = list.filter(x => x.status && x.status.indexOf('pending')!==-1);
    else if(filter==='cancelled') list = list.filter(x => ['payment_failed','delivery_failed','failed_payment_init','payment_timeout'].includes(x.status));
    if(q) list = list.filter(o => (o.order_no||'').toLowerCase().includes(q) || (o.transaction_code||'').toLowerCase().includes(q) || (o.payer_number||'').toLowerCase().includes(q));
    res.json({ success:true, orders: list.slice(0,1000) });
  } catch(e){ res.json({ success:false, message: e.message }); }
});

app.get('/admin/order/:order_no', adminAuth, (req, res) => {
  const ord = findOrder(req.params.order_no);
  if(!ord) return res.json({ success:false, message:'Not found' });
  res.json({ success:true, order: ord });
});

app.get('/admin/settings', adminAuth, (req,res) => res.json({ success:true, settings: SETTINGS }));
app.post('/admin/settings', adminAuth, (req,res) => { Object.keys(req.body||{}).forEach(k=>SETTINGS[k]=String(req.body[k]??'')); saveSettings(); res.json({ success:true, message:'Saved' }); });

app.post('/admin/alert', adminAuth, async (req,res) => { const text = req.body.text || 'Test alert'; await alertAdmin(text); res.json({ success:true }); });

app.get('/admin', (req,res)=> {
  if(req.query.token !== ADMIN_UI_TOKEN) return res.status(401).send('Unauthorized. Provide ?token=ADMIN_UI_TOKEN');
  res.sendFile(path.join(__dirname,'public','admin.html'));
});

// expose basic health
app.get('/health', (req,res)=> res.json({ ok:true }));

// ----- Message handler (admin WhatsApp control + user flows) -----
const SESSIONS = new Map();

client.on('message', async msg => {
  try {
    const from = msg.from; const fromPhone = (from||'').replace('@c.us','').replace('@g.us',''); const body = (msg.body||'').trim();
    if(!body) return;

    // Only respond to private chats, ignore groups
    if(from.endsWith('@g.us')) {
      console.log('Ignoring group message from:', from);
      return;
    }

    // admin WhatsApp special commands (only from configured ADMIN_WHATSAPP)
    if(ADMIN_WHATSAPP && fromPhone === ADMIN_WHATSAPP){
      // Admin menu
      if(/^admin$/i.test(body) || /^\/admin$/i.test(body)){
        const adminMenu = `
╔══════════════════════╗
║   👑 *ADMIN PANEL*   ║
╚══════════════════════╝

*📊 ORDERS MANAGEMENT*
1️⃣ View All Orders
2️⃣ View Paid Orders  
3️⃣ View Pending Orders
4️⃣ View Failed Orders
5️⃣ Check Specific Order

*⚙️ SETTINGS*
6️⃣ View All Settings
7️⃣ Update Setting
8️⃣ Get Setting Value

*🔧 SYSTEM*
9️⃣ View QR Code
🔟 Restart Session
1️⃣1️⃣ Send Test Alert

*Type number to select*
Type *0* to exit admin menu
        `.trim();
        client.sendMessage(from, adminMenu);
        if(!SESSIONS.has(fromPhone)) SESSIONS.set(fromPhone, { step:'ADMIN_MENU', temp:{} });
        else { const s = SESSIONS.get(fromPhone); s.step='ADMIN_MENU'; s.temp={}; }
        return;
      }

      // Handle admin menu selections
      const adminSession = SESSIONS.get(fromPhone);
      if(adminSession && adminSession.step === 'ADMIN_MENU'){
        if(body === '1'){
          let arr = ORDERS.slice();
          if(!arr.length) { client.sendMessage(from, '📭 No orders found'); adminSession.step='ADMIN_MENU'; return; }
          let out = `📋 *ALL ORDERS* (${arr.length} total)\n\n`;
          arr.slice(0,20).forEach((o, i) => out += `${i+1}. ${o.order_no}\n   💰 KES ${o.amount} • ${o.status}\n   ⏰ ${o.created_at}\n\n`);
          if(arr.length > 20) out += `\n_Showing first 20 of ${arr.length} orders_`;
          client.sendMessage(from, out);
          adminSession.step='ADMIN_MENU'; return;
        }
        if(body === '2'){
          let arr = ORDERS.filter(x=>x.status==='paid');
          if(!arr.length) { client.sendMessage(from, '✅ No paid orders found'); adminSession.step='ADMIN_MENU'; return; }
          let out = `✅ *PAID ORDERS* (${arr.length} total)\n\n`;
          arr.slice(0,20).forEach((o, i) => out += `${i+1}. ${o.order_no}\n   💰 KES ${o.amount}\n   📱 ${o.recipient_number}\n   🎫 ${o.transaction_code || 'N/A'}\n\n`);
          if(arr.length > 20) out += `\n_Showing first 20 of ${arr.length} orders_`;
          client.sendMessage(from, out);
          adminSession.step='ADMIN_MENU'; return;
        }
        if(body === '3'){
          let arr = ORDERS.filter(x=>x.status && x.status.indexOf('pending')!==-1);
          if(!arr.length) { client.sendMessage(from, '⏳ No pending orders'); adminSession.step='ADMIN_MENU'; return; }
          let out = `⏳ *PENDING ORDERS* (${arr.length} total)\n\n`;
          arr.slice(0,20).forEach((o, i) => out += `${i+1}. ${o.order_no}\n   💰 KES ${o.amount}\n   📱 ${o.payer_number}\n   ⏰ ${o.created_at}\n\n`);
          if(arr.length > 20) out += `\n_Showing first 20 of ${arr.length} orders_`;
          client.sendMessage(from, out);
          adminSession.step='ADMIN_MENU'; return;
        }
        if(body === '4'){
          let arr = ORDERS.filter(x=>['payment_failed','delivery_failed','failed_payment_init','payment_timeout'].includes(x.status));
          if(!arr.length) { client.sendMessage(from, '❌ No failed orders'); adminSession.step='ADMIN_MENU'; return; }
          let out = `❌ *FAILED ORDERS* (${arr.length} total)\n\n`;
          arr.slice(0,20).forEach((o, i) => out += `${i+1}. ${o.order_no}\n   💰 KES ${o.amount}\n   🚫 ${o.status}\n   ⏰ ${o.created_at}\n\n`);
          if(arr.length > 20) out += `\n_Showing first 20 of ${arr.length} orders_`;
          client.sendMessage(from, out);
          adminSession.step='ADMIN_MENU'; return;
        }
        if(body === '5'){
          adminSession.step='ADMIN_CHECK_ORDER';
          client.sendMessage(from, '🔍 Enter order number (e.g., FYS-12345678):');
          return;
        }
        if(body === '6'){
          let msgText = '⚙️ *CURRENT SETTINGS*\n\n';
          Object.keys(SETTINGS).forEach(k => { if(!k.startsWith('__')) msgText += `🔹 *${k}*\n   ${SETTINGS[k] || '(empty)'}\n\n`; });
          client.sendMessage(from, msgText);
          adminSession.step='ADMIN_MENU'; return;
        }
        if(body === '7'){
          adminSession.step='ADMIN_SET_KEY';
          client.sendMessage(from, '⚙️ Enter setting key to update:');
          return;
        }
        if(body === '8'){
          adminSession.step='ADMIN_GET_KEY';
          client.sendMessage(from, '🔍 Enter setting key to view:');
          return;
        }
        if(body === '9'){
          if(!lastQrDataUrl){
            client.sendMessage(from, '❌ No QR currently available.\n\nℹ️ If already logged in, no QR is needed.\nTo generate new QR, use option 10 (Restart Session).');
            adminSession.step='ADMIN_MENU'; return;
          }
          const idx = lastQrDataUrl.indexOf('base64,');
          if(idx === -1){ client.sendMessage(from, '❌ QR not available'); adminSession.step='ADMIN_MENU'; return; }
          const base64 = lastQrDataUrl.substring(idx + 7);
          const media = new MessageMedia('image/png', base64, 'qr.png');
          client.sendMessage(from, media).then(()=> client.sendMessage(from, '📷 *QR Code sent!*\n\nScan using:\nWhatsApp → Linked Devices → Link a device'));
          adminSession.step='ADMIN_MENU'; return;
        }
        if(body === '10'){
          adminSession.step='ADMIN_CONFIRM_RELOGIN';
          client.sendMessage(from, '⚠️ *WARNING: Session Restart*\n\nThis will:\n• Logout current session\n• Delete session data\n• Generate new QR code\n\n*Confirm?*\n1️⃣ Yes, restart\n2️⃣ No, cancel');
          return;
        }
        if(body === '11'){
          await alertAdmin('🔔 *Test Alert*\n\nThis is a test notification from admin panel.');
          client.sendMessage(from, '✅ Test alert sent!');
          adminSession.step='ADMIN_MENU'; return;
        }
        if(body === '0'){
          adminSession.step='MENU'; adminSession.temp={};
          client.sendMessage(from, '👋 Exited admin panel');
          return;
        }
        client.sendMessage(from, '❌ Invalid option. Type *admin* to see menu again.');
        return;
      }

      // Admin check order
      if(adminSession && adminSession.step === 'ADMIN_CHECK_ORDER'){
        const orderNo = body.trim();
        const ord = findOrder(orderNo);
        if(!ord) { client.sendMessage(from, `❌ Order not found: ${orderNo}`); adminSession.step='ADMIN_MENU'; return; }
        client.sendMessage(from, prettyOrder(ord));
        adminSession.step='ADMIN_MENU'; return;
      }

      // Admin set key
      if(adminSession && adminSession.step === 'ADMIN_SET_KEY'){
        adminSession.temp.setting_key = body.trim();
        adminSession.step='ADMIN_SET_VALUE';
        client.sendMessage(from, `⚙️ Enter new value for *${body.trim()}*:`);
        return;
      }

      // Admin set value
      if(adminSession && adminSession.step === 'ADMIN_SET_VALUE'){
        const key = adminSession.temp.setting_key;
        const value = body.trim();
        SETTINGS[key] = value; saveSettings();
        client.sendMessage(from, `✅ *Setting Updated!*\n\n🔹 *${key}*\n   ${value}`);
        adminSession.step='ADMIN_MENU'; adminSession.temp={};
        return;
      }

      // Admin get key
      if(adminSession && adminSession.step === 'ADMIN_GET_KEY'){
        const key = body.trim();
        const val = SETTINGS[key];
        client.sendMessage(from, `🔍 *${key}*\n\n${val === undefined ? '❌ Not set' : '✅ ' + val}`);
        adminSession.step='ADMIN_MENU'; return;
      }

      // Admin confirm relogin
      if(adminSession && adminSession.step === 'ADMIN_CONFIRM_RELOGIN'){
        if(body === '1'){
          try {
            client.sendMessage(from, '✅ Restarting session...\n\n⏳ Please wait for new QR code...');
            await client.logout();
            try {
              const p = path.resolve(SESSION_DIR);
              if(fs.existsSync(p)) {
                fs.rmSync(p, { recursive:true, force:true });
                console.log('Removed session dir to force fresh login:', p);
              }
            } catch(e) { console.warn('Failed to remove session dir', e.message); }
            setTimeout(()=>{ client.initialize().catch(e=>console.error('re-init error', e)); }, 1500);
            adminSession.step='ADMIN_MENU'; adminSession.temp={};
          } catch(e){
            client.sendMessage(from, `⚠️ Restart failed: ${e.message}`);
            adminSession.step='ADMIN_MENU';
          }
          return;
        }
        if(body === '2'){
          client.sendMessage(from, '❌ Session restart cancelled');
          adminSession.step='ADMIN_MENU'; return;
        }
        client.sendMessage(from, '❌ Invalid choice. Type 1 or 2');
        return;
      }

      // Legacy admin commands (for backward compatibility)
      if(/^\/set\s+/i.test(body)){
        const text = body.replace(/^\/set\s+/i,'').trim();
        const idx = text.indexOf('=');
        if(idx === -1) { client.sendMessage(from, 'Usage: /set key=value'); return; }
        const key = text.substring(0,idx).trim(); const value = text.substring(idx+1).trim();
        SETTINGS[key] = value; saveSettings();
        client.sendMessage(from, `✅ Setting *${key}* updated to:\n\`${value}\``);
        return;
      }
      if(/^\/get\s+/i.test(body)){
        const key = body.replace(/^\/get\s+/i,'').trim();
        const val = SETTINGS[key];
        client.sendMessage(from, `🔎 *${key}* = \`${val === undefined ? 'NOT SET' : val}\``);
        return;
      }
      if(/^\/help$/i.test(body) || /^help$/i.test(body)){
        const h = `👑 *ADMIN COMMANDS*\n\n🎯 Quick Menu: Type *admin*\n\n📝 Legacy Commands:\n• /set key=value — update setting\n• /get key — get setting`;
        client.sendMessage(from, h);
        return;
      }
    } // end admin block

    // ----- regular user conversational menu -----
    if(!SESSIONS.has(fromPhone)) SESSIONS.set(fromPhone, { step:'MENU', temp:{} });
    const s = SESSIONS.get(fromPhone);

    if(/^menu$/i.test(body) || body === '0'){ s.step='MENU'; s.temp={}; }

    switch(s.step){
      case 'MENU':
        const botName = (SETTINGS.bot_name || 'FY Bot').toUpperCase();
        const welcomeMsg = `
╔═══════════════════════════╗
║  🎯 *${botName}*  ║
╚═══════════════════════════╝

*✨ Welcome! What would you like to do?*

1️⃣ 💸 *Buy Airtime* - Quick & Easy
2️⃣ 📦 *Check Order* - Track Status
3️⃣ ❓ *Help* - Get Support
${ADMIN_WHATSAPP && fromPhone === ADMIN_WHATSAPP ? '9️⃣ 👑 *Admin Panel* - Manage Bot\n' : ''}
━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 *Tip:* Type the number to continue
🔄 Type *0* or *menu* anytime to return
        `.trim();
        await client.sendMessage(from, welcomeMsg);
        s.step = 'AWAITING_MENU'; break;

      case 'AWAITING_MENU':
        if(body === '1'){ 
          s.step='BUY_AMOUNT'; s.temp={}; 
          const min = SETTINGS.min_amount || '1';
          const max = SETTINGS.max_amount || '1500';
          await client.sendMessage(from, `💰 *AIRTIME PURCHASE*\n\n💵 Enter the amount in KES\n📊 Min: ${min} | Max: ${max}\n\n✍️ Example: *100*\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💡 Type *0* or *menu* to cancel`); 
          return; 
        }
        if(body === '2'){ 
          s.step='CHECK_ORDER'; s.temp={}; 
          await client.sendMessage(from, '📦 *ORDER TRACKING*\n\n🔍 Enter your order number\n\n✍️ Example: *FYS-12345678*\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💡 Type *0* or *menu* to cancel'); 
          return; 
        }
        if(body === '3'){ 
          const helpMsg = `
╔═══════════════════════════╗
║   ❓ *HELP & SUPPORT*     ║
╚═══════════════════════════╝

📞 *Need Assistance?*
${ADMIN_WHATSAPP ? '📱 WhatsApp: +'+ADMIN_WHATSAPP : '📧 Contact admin for support'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 *How to Buy Airtime*
━━━━━━━━━━━━━━━━━━━━━━━━━━━

1️⃣ Select "Buy Airtime"
2️⃣ Enter amount (KES)
3️⃣ Provide M-Pesa number
4️⃣ Confirm your purchase
5️⃣ Complete the STK push
6️⃣ Get instant airtime! ⚡

━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔒 *100% Safe & Secure*
━━━━━━━━━━━━━━━━━━━━━━━━━━━
All transactions are encrypted
and processed securely.

✨ Type *0* or *menu* to return
          `.trim();
          await client.sendMessage(from, helpMsg); 
          s.step='MENU'; 
          return; 
        }
        if(body === '9' && ADMIN_WHATSAPP && fromPhone === ADMIN_WHATSAPP){
          s.step='ADMIN_MENU';
          const adminMenu = `
╔═══════════════════════════╗
║     👑 *ADMIN PANEL*      ║
╚═══════════════════════════╝

*📊 ORDERS MANAGEMENT*
━━━━━━━━━━━━━━━━━━━━━━━━━━━
1️⃣ View All Orders
2️⃣ View Paid Orders  
3️⃣ View Pending Orders
4️⃣ View Failed Orders
5️⃣ Check Specific Order

*⚙️ BOT SETTINGS*
━━━━━━━━━━━━━━━━━━━━━━━━━━━
6️⃣ View All Settings
7️⃣ Update Setting (inc. bot name)
8️⃣ Get Setting Value

*🔧 SYSTEM TOOLS*
━━━━━━━━━━━━━━━━━━━━━━━━━━━
9️⃣ View QR Code
🔟 Restart Session
1️⃣1️⃣ Send Test Alert

━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 *Quick Tip:* To change bot name
   Use option 7, key: *bot_name*

Type number to select • *0* to exit
          `.trim();
          await client.sendMessage(from, adminMenu);
          return;
        }
        await client.sendMessage(from, '❌ Invalid option\n\nPlease select 1, 2, or 3'); 
        return;

      case 'BUY_AMOUNT':
        {
          const amt = parseFloat(body.replace(/[^0-9.]/g,''));
          const min = parseFloat(SETTINGS.min_amount || '1');
          const max = parseFloat(SETTINGS.max_amount || '1500');
          if(!amt || amt<=0){ 
            await client.sendMessage(from, '❌ Invalid amount\n\n💵 Enter a valid number\nExample: *100*'); 
            return; 
          }
          if(amt < min || amt > max){
            await client.sendMessage(from, `❌ Amount out of range\n\n📊 Valid range:\nMin: KES ${min}\nMax: KES ${max}`);
            return;
          }
          s.temp.amount = amt; 
          s.step='BUY_FOR'; 
          await client.sendMessage(from, `💰 *Amount: KES ${amt.toFixed(2)}*\n\n📱 *Who is this for?*\n\n1️⃣ 👤 For Myself\n2️⃣ 👥 For Someone Else\n\n*Select 1 or 2*`); 
          return;
        }

      case 'BUY_FOR':
        if(body === '1'){ 
          s.temp.buy_for='self'; 
          s.step='BUY_PAYER'; 
          await client.sendMessage(from, '📱 *YOUR M-PESA NUMBER*\n\nEnter your M-Pesa number for payment:\n\n*Format:*\n• 07XXXXXXXX or\n• 2547XXXXXXXX'); 
          return; 
        }
        if(body === '2'){ 
          s.temp.buy_for='other'; 
          s.step='BUY_PAYER'; 
          await client.sendMessage(from, '💳 *PAYER NUMBER*\n\nEnter M-Pesa number for payment:\n\n*Format:*\n• 07XXXXXXXX or\n• 2547XXXXXXXX'); 
          return; 
        }
        await client.sendMessage(from, '❌ Invalid choice\n\nPlease select *1* or *2*'); 
        return;

      case 'BUY_PAYER':
        {
          let payer = body;
          if(/^default$/i.test(body) && fromPhone) payer = fromPhone;
          payer = normalizePhone(payer);
          if(!/^254[0-9]{9}$/.test(payer)){ 
            await client.sendMessage(from, '❌ *Invalid Phone Number*\n\n📱 Use correct format:\n• 0712345678 or\n• 254712345678'); 
            return; 
          }
          s.temp.payer = payer;
          if(s.temp.buy_for === 'other'){ 
            s.step='BUY_RECIPIENT'; 
            await client.sendMessage(from, '📱 *RECIPIENT NUMBER*\n\nEnter phone number to receive airtime:\n\n*Format:*\n• 07XXXXXXXX or\n• 2547XXXXXXXX'); 
            return; 
          }
          s.temp.recipient = s.temp.payer; 
          s.step='BUY_CONFIRM'; 
          const discount = parseFloat(SETTINGS.discount_percent || '0');
          const payable = s.temp.amount - (s.temp.amount * (discount/100));
          const confirmMsg = `
╔══════════════════════╗
║  ✅ *CONFIRM ORDER*  ║
╚══════════════════════╝

💳 *Payer:* +${s.temp.payer}
📱 *Recipient:* +${s.temp.recipient}
💰 *Amount:* KES ${parseFloat(s.temp.amount).toFixed(2)}
💸 *To Pay:* KES ${payable.toFixed(2)}
${discount > 0 ? `🎉 *Discount:* ${discount}%\n` : ''}
*━━━━━━━━━━━━━━━━━━━━*

*Confirm this order?*

1️⃣ ✅ Yes, proceed
2️⃣ ❌ No, cancel
          `.trim();
          await client.sendMessage(from, confirmMsg); 
          return;
        }

      case 'BUY_RECIPIENT':
        {
          const rec = normalizePhone(body);
          if(!/^254[0-9]{9}$/.test(rec)){ 
            await client.sendMessage(from, '❌ *Invalid Phone Number*\n\n📱 Use correct format:\n• 0712345678 or\n• 254712345678'); 
            return; 
          }
          s.temp.recipient = rec; 
          s.step='BUY_CONFIRM'; 
          const discount = parseFloat(SETTINGS.discount_percent || '0');
          const payable = s.temp.amount - (s.temp.amount * (discount/100));
          const confirmMsg = `
╔══════════════════════╗
║  ✅ *CONFIRM ORDER*  ║
╚══════════════════════╝

💳 *Payer:* +${s.temp.payer}
📱 *Recipient:* +${s.temp.recipient}
💰 *Amount:* KES ${parseFloat(s.temp.amount).toFixed(2)}
💸 *To Pay:* KES ${payable.toFixed(2)}
${discount > 0 ? `🎉 *Discount:* ${discount}%\n` : ''}
*━━━━━━━━━━━━━━━━━━━━*

*Confirm this order?*

1️⃣ ✅ Yes, proceed
2️⃣ ❌ No, cancel
          `.trim();
          await client.sendMessage(from, confirmMsg); 
          return;
        }

      case 'BUY_CONFIRM':
        if(body === '1'){
          try{
            const amount = parseFloat(s.temp.amount || 0);
            const min = parseFloat(SETTINGS.min_amount || '1'); 
            const max = parseFloat(SETTINGS.max_amount || '1500');
            
            if(!amount || amount < min || amount > max) {
              await client.sendMessage(from, `❌ *Invalid Amount*\n\nAmount must be between KES ${min} and KES ${max}\n\nType *menu* to try again`);
              s.step='MENU'; s.temp={}; return;
            }

            const payer = normalizePhone(s.temp.payer);
            const recipient = normalizePhone(s.temp.recipient);
            
            if(!/^254[0-9]{9}$/.test(payer) || !/^254[0-9]{9}$/.test(recipient)) {
              await client.sendMessage(from, '❌ *Invalid Phone Numbers*\n\nPlease try again.\n\nType *menu* to return');
              s.step='MENU'; s.temp={}; return;
            }

            const order = createOrder(payer, recipient, amount, SETTINGS.discount_percent || '0');
            
            const sres = await shadowInitiate(SETTINGS.shadow_api_key, SETTINGS.shadow_api_secret, SETTINGS.shadow_account_id, payer, order.amount_payable, order.order_no, `Airtime payment ${order.order_no}`);
            
            if(!sres || !sres.success){
              updateOrderByNo(order.order_no, { status:'failed_payment_init' });
              await client.sendMessage(from, `❌ *ORDER FAILED*\n\n${sres && sres.message ? sres.message : 'Unknown error'}\n\nType *menu* to try again`);
              s.step='MENU'; s.temp={}; return;
            }

            const checkout_request_id = sres.checkout_request_id || null;
            const merchant_request_id = sres.merchant_request_id || null;
            updateOrderByNo(order.order_no, { checkout_request_id, merchant_request_id });

            (async ()=>{
              const pollTimeout = parseInt(SETTINGS.payment_poll_seconds || POLL_SECONDS, 10);
              const { paid, tx } = await pollPayment(checkout_request_id, order.order_no, pollTimeout);
              if(paid){
                await alertAdmin(`🔔 Payment confirmed for ${order.order_no}. Delivering airtime...`);
                const dres = await deliverAirtime(order.order_no);
                if(dres.success) await alertAdmin(`✅ Airtime delivered for ${order.order_no}`);
                else await alertAdmin(`⚠️ Airtime delivery failed for ${order.order_no}`);
              } else {
                const ord = findOrder(order.order_no);
                if(ord && ord.status !== 'paid'){ updateOrderByNo(order.order_no, { status:'payment_timeout' }); await alertAdmin(`⏰ Payment timeout for ${order.order_no}`); }
              }
            })();

            const successMsg = `
✅ *ORDER CREATED!*

📦 *Order Number:*
${order.order_no}

📲 *STK Push Sent!*
Check your phone for M-Pesa prompt

💰 *Amount to Pay:*
KES ${parseFloat(order.amount_payable).toFixed(2)}

⏳ *Please complete payment...*

_You'll receive confirmation once payment is successful_
            `.trim();
            await client.sendMessage(from, successMsg);
            await alertAdmin(`🔔 *New Order*\n\n📦 ${order.order_no}\n💰 KES ${s.temp.amount}\n📱 From WhatsApp: +${s.temp.payer}`);
            s.step='MENU'; s.temp={}; return;
            
          } catch(e){ 
            console.error('BUY_CONFIRM error:', e);
            await client.sendMessage(from, '❌ *Error Processing Order*\n\nPlease try again later.\n\nType *menu* to return'); 
            s.step='MENU'; s.temp={}; return; 
          }
        } else if(body === '2'){ 
          await client.sendMessage(from, '❌ *Order Cancelled*\n\nType *menu* to start over'); 
          s.step='MENU'; s.temp={}; return; 
        } else { 
          await client.sendMessage(from, '❌ Invalid choice\n\nPlease select:\n1️⃣ to confirm\n2️⃣ to cancel'); 
          return; 
        }

      case 'CHECK_ORDER':
        {
          const orderNo = body.trim();
          if(!orderNo){ 
            await client.sendMessage(from, '❌ Please enter order number\n\nExample: *FYS-12345678*'); 
            return; 
          }
          try{
            const ord = findOrder(orderNo);
            if(ord){ 
              await client.sendMessage(from, prettyOrder(ord)); 
            } else { 
              await client.sendMessage(from, `❌ *Order Not Found*\n\n🔍 Order: ${orderNo}\n\nPlease check the number and try again`); 
            }
          } catch(e){ 
            console.error('CHECK_ORDER error:', e);
            await client.sendMessage(from, '❌ *Error retrieving order*\n\nPlease try again later.'); 
          }
          s.step='MENU'; s.temp={}; return;
        }

      default:
        s.step='MENU'; s.temp={}; 
        await client.sendMessage(from, '❓ Unknown command\n\nType *menu* or *0* for main menu'); 
        return;
    }

  } catch(e){ console.error('msg handler error', e); }
});

// initialize WhatsApp client
client.initialize().catch(e => console.error('client init error', e));

// start server
server.listen(PORT, '0.0.0.0', ()=> console.log(`Server running at ${BASE_URL}\nVisit ${BASE_URL}/ to scan QR or use admin UI at ${BASE_URL}/admin?token=${ADMIN_UI_TOKEN}`));
