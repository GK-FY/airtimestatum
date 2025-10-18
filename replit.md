# FY WhatsApp Airtime Bot

## Overview
A production-ready WhatsApp bot for selling airtime in Kenya via M-Pesa. Features a comprehensive admin dashboard where ALL settings can be changed including admin number, pricing, discounts, and API credentials - all without touching code.

**Current Status**: ✅ Fully configured with enhanced admin panel

## Recent Changes (Oct 18, 2025)
- ✅ **NEW:** Comprehensive web admin dashboard with beautiful UI
- ✅ **NEW:** All settings editable through admin panel (admin number, min/max, discount, API keys)
- ✅ **NEW:** Environment variable management for admin WhatsApp number
- ✅ **NEW:** Improved QR dashboard with real-time status
- ✅ **NEW:** Deployment configs for Railway, Render, Heroku
- ✅ **NEW:** Complete deployment guide (DEPLOYMENT.md)
- ✅ Enhanced error handling and input validation
- ✅ System information endpoint
- ✅ Better security with token-based admin access

## Key Features

### Admin Dashboard Features
- 🎨 **Beautiful Modern UI** - Gradient design, responsive layout
- ⚙️ **Complete Settings Control:**
  - Change admin WhatsApp number
  - Set min/max airtime amounts
  - Configure discount percentage
  - Update Shadow Pay credentials
  - Update Statum API credentials
  - Change bot name
  - Adjust payment timeout
- 📊 **Order Management:**
  - View all orders with filtering
  - Search by order number, MPesa code, phone
  - Real-time status updates
  - Detailed order information
- 🔧 **System Information:**
  - Platform details
  - Connection status
  - Deployment guidance

### User Features
- Interactive menu-based WhatsApp interface
- Easy airtime purchase flow
- M-Pesa STK push payment
- Automatic airtime delivery
- Order tracking
- Number-based confirmations

## Project Architecture

### Technology Stack
- **Backend**: Node.js + Express
- **WhatsApp**: whatsapp-web.js (Puppeteer)
- **Payment**: Shadow Pay (M-Pesa STK Push)
- **Airtime**: Statum API
- **Real-time**: Socket.IO
- **Storage**: File-based JSON

### File Structure
```
.
├── server.js              # Main server with all logic
├── package.json           # Dependencies
├── public/
│   ├── index.html        # QR dashboard (enhanced)
│   └── admin.html        # Admin dashboard (NEW)
├── data/                 # Auto-created
│   ├── orders.json       # Order records
│   └── settings.json     # Bot settings
├── session/              # WhatsApp session
├── railway.json          # Railway config (NEW)
├── render.yaml           # Render config (NEW)
├── Procfile              # Heroku config (NEW)
├── DEPLOYMENT.md         # Deployment guide (NEW)
├── README.md             # Full documentation (NEW)
└── .gitignore            # Git ignore rules
```

## Configuration

### Environment Variables
Set in Replit Secrets:
- `PORT` - Server port (default: 5000)
- `ADMIN_WHATSAPP` - Admin phone (254XXXXXXXXX format)
- `ADMIN_UI_TOKEN` - Admin dashboard token (strong password)

### Bot Settings (via Admin Panel)
All settings can be changed from the web dashboard:

**Admin Configuration:**
- `admin_whatsapp` - Admin WhatsApp number

**Pricing & Limits:**
- `min_amount` - Minimum airtime (KES)
- `max_amount` - Maximum airtime (KES)
- `discount_percent` - Discount percentage
- `payment_poll_seconds` - Payment timeout

**Shadow Pay (M-Pesa):**
- `shadow_api_key` - API key
- `shadow_api_secret` - API secret
- `shadow_account_id` - Account ID

**Statum (Airtime):**
- `statum_consumer_key` - Consumer key
- `statum_consumer_secret` - Consumer secret

**Bot Settings:**
- `bot_name` - Bot display name

## How to Use

### Initial Setup
1. Set environment variables in Replit Secrets
2. Click "Run" to start the bot
3. Scan QR code with WhatsApp
4. Access admin dashboard
5. Configure all settings
6. Test the bot

### Admin Dashboard Access
1. Go to your bot URL
2. Click "Admin Dashboard"
3. Enter your `ADMIN_UI_TOKEN`
4. You're in! Change any settings you want

### WhatsApp Usage

**For Customers:**
- Send any message to start
- Type `menu` or `0` for main menu
- Select option 1 to buy airtime
- Follow the prompts

**For Admin (WhatsApp):**
- Type `admin` or `9` from main menu
- Access admin panel via WhatsApp
- View orders, settings, system status
- Get QR code, restart session

## Deployment Options

⚠️ **Important:** This bot requires a long-running server with persistent connections. It **CANNOT** run on:
- ❌ Vercel
- ❌ Netlify
- ❌ AWS Lambda
- ❌ Any serverless platform

✅ **Recommended Platforms:**
1. **Railway.app** - Free tier, easy deploy
2. **Render.com** - Free tier available
3. **Heroku** - Reliable, $5/month
4. **DigitalOcean** - Full control, $5/month
5. **Replit** - Current platform (Always-On required)

📖 **See [DEPLOYMENT.md](DEPLOYMENT.md) for detailed instructions**

## Why Not Vercel?

Vercel is for serverless functions that:
- Start and stop for each request
- Have 10-300 second timeouts
- Cannot maintain persistent connections

This WhatsApp bot needs:
- 24/7 browser session (Puppeteer)
- Persistent WebSocket connection
- File system access
- Long-running Node.js process

**Solution:** Use Railway, Render, Heroku, or any VPS/cloud server

## API Endpoints

### Public APIs
- `POST /api/initiate` - Create order, send STK push
- `POST /api/get_order` - Get order details
- `POST /api/check_status` - Check payment status
- `POST /api/deliver` - Deliver airtime

### Admin APIs (Token Required)
- `GET /admin/orders` - List orders
- `GET /admin/order/:order_no` - Get specific order
- `GET /admin/settings` - Get settings
- `POST /admin/settings` - Update settings
- `GET /admin/system-info` - System info
- `POST /admin/alert` - Send test alert

## Security

- ✅ Token-based admin authentication
- ✅ Admin number verification
- ✅ Environment variables for secrets
- ✅ Secure M-Pesa handling
- ✅ Session isolation
- ✅ Input validation
- ✅ Error handling

## Troubleshooting

### Bot Not Connecting
- Check workflow logs
- Verify Chromium installed
- Restart session from admin panel
- Re-scan QR code

### Settings Not Saving
- Verify admin token is correct
- Check file permissions
- Look for errors in logs

### Orders Not Processing
- Verify Shadow Pay credentials
- Verify Statum credentials
- Check API account credits
- Review order in admin dashboard

## User Preferences
- Number-based confirmations (1=Yes, 2=No)
- Emoji-rich menus
- Modern web admin dashboard
- All settings editable via UI
- No code changes needed for configuration

## Development

### Local Setup
```bash
git clone <repo-url>
cd fy-whatsapp-bot
npm install
# Create .env file with variables
npm start
```

### Testing
1. Start server
2. Scan QR code
3. Access admin dashboard
4. Configure settings
5. Send test message to bot
6. Complete test purchase

## Production Checklist

Before deploying to production:
- [ ] Set strong `ADMIN_UI_TOKEN`
- [ ] Configure real Shadow Pay credentials
- [ ] Configure real Statum credentials
- [ ] Set appropriate min/max amounts
- [ ] Test full purchase flow
- [ ] Enable Always-On (Replit) or deploy to proper platform
- [ ] Monitor first few orders
- [ ] Keep data/ folder backed up

## Support

- 📖 Read [DEPLOYMENT.md](DEPLOYMENT.md)
- 📖 Read [README.md](README.md)
- 🐛 Check workflow logs
- 💡 Use admin dashboard for settings

## What's New in This Version

1. **Comprehensive Admin Dashboard**
   - Beautiful modern UI
   - All settings editable
   - Real-time order management
   - System information

2. **Environment Variable Management**
   - Admin number changeable via dashboard
   - Automatic .env file updates
   - Restart notifications

3. **Deployment Ready**
   - Multiple platform configs
   - Detailed deployment guide
   - Platform-specific instructions

4. **Enhanced Documentation**
   - Complete README
   - Deployment guide
   - Clear instructions

5. **Better Error Handling**
   - Input validation
   - User-friendly messages
   - Robust error recovery

---

**Made with ❤️ for easy airtime selling in Kenya**
