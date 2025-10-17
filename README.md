# FY WhatsApp Airtime Bot

## Overview
A WhatsApp-based airtime bot for Kenya that allows users to purchase airtime via M-Pesa. The bot features an interactive conversational interface, admin panel, and web dashboard for QR code scanning.

**Current Status**: ✅ Fully configured and running on Replit

## Recent Changes (Oct 17, 2025)
- ✅ Configured for Replit environment with port 5000
- ✅ Added Chromium system dependency for WhatsApp Web.js
- ✅ Enhanced bot UI with emojis and number-based confirmations
- ✅ Implemented comprehensive admin panel accessible via WhatsApp
- ✅ Updated web dashboard with secure admin access
- ✅ Configured deployment settings for production

## Project Architecture

### Technology Stack
- **Backend**: Node.js + Express
- **WhatsApp Integration**: whatsapp-web.js (Puppeteer-based)
- **Payment Gateway**: Shadow Pay (M-Pesa STK Push)
- **Airtime Delivery**: Statum API
- **Real-time Updates**: Socket.IO
- **Data Storage**: File-based JSON (orders.json, settings.json)

### Key Components

#### 1. WhatsApp Bot (`server.js`)
- **User Flow**: Interactive menu-based purchasing
- **Admin Panel**: Accessible via WhatsApp for admin number
- **Session Management**: LocalAuth for persistent login
- **QR Code**: Displayed in console and web dashboard

#### 2. Web Dashboard (`public/index.html`)
- QR code display for WhatsApp linking
- Real-time connection status
- Admin UI access with token authentication

#### 3. Admin UI (`public/admin.html`)
- Order management and filtering
- Settings configuration
- Transaction monitoring

#### 4. APIs
- `/api/initiate` - Create order and send M-Pesa STK push
- `/api/get_order` - Retrieve order details
- `/api/check_status` - Check payment status
- `/api/deliver` - Manually trigger airtime delivery
- `/admin/*` - Admin-only endpoints

## Bot Features

### For Regular Users
**Main Menu (Type 'menu' or '0')**:
1. 💸 Buy Airtime - Purchase airtime for self or others
2. 📦 Check Order Status - Track orders by order number
3. ❓ Help & Support - View help information

**Purchase Flow**:
1. Enter amount (KES)
2. Select recipient (self/other)
3. Enter M-Pesa number
4. Confirm with number (1=Yes, 2=No)
5. Complete STK push on phone

### For Admin (WhatsApp)
**Access**: Type `admin` or `9` from main menu (admin number only)

**Admin Menu Options**:
1. View All Orders
2. View Paid Orders
3. View Pending Orders
4. View Failed Orders
5. Check Specific Order
6. View All Settings
7. Update Setting
8. Get Setting Value
9. View QR Code
10. Restart Session
11. Send Test Alert

**Legacy Commands** (still supported):
- `/set key=value` - Update setting
- `/get key` - Get setting value
- `/help` - Show help

## Configuration

### Environment Variables
Set these secrets in Replit:
- `PORT` - Server port (default: 5000)
- `ADMIN_WHATSAPP` - Admin phone number (254XXXXXXXXX format)
- `ADMIN_UI_TOKEN` - Web admin authentication token

### Settings (Configurable via Admin Panel)
- `statum_consumer_key` - Statum API key for airtime delivery
- `statum_consumer_secret` - Statum API secret
- `shadow_api_key` - Shadow Pay API key
- `shadow_api_secret` - Shadow Pay API secret
- `shadow_account_id` - Shadow Pay account ID
- `min_amount` - Minimum airtime amount (KES)
- `max_amount` - Maximum airtime amount (KES)
- `discount_percent` - Discount percentage
- `payment_poll_seconds` - Payment polling timeout

## File Structure
```
.
├── server.js           # Main application server
├── package.json        # Node.js dependencies
├── public/
│   ├── index.html     # QR dashboard
│   └── admin.html     # Admin panel
├── data/              # Auto-created data directory
│   ├── orders.json    # Order records
│   └── settings.json  # Bot settings
├── session/           # WhatsApp session data (auto-created)
└── .gitignore         # Git ignore file
```

## How It Works

### Payment Flow
1. User requests airtime via WhatsApp
2. Bot creates order and sends M-Pesa STK push via Shadow Pay
3. Bot polls payment status for configured timeout
4. On successful payment, bot delivers airtime via Statum API
5. User receives confirmation on WhatsApp
6. Admin receives order notifications

### Admin Features
- Real-time order monitoring via WhatsApp
- Settings management without code changes
- Session restart capability
- QR code retrieval
- Order filtering and search

## Development

### Local Setup
1. Install dependencies: `npm install`
2. Configure environment variables
3. Run server: `npm start`
4. Scan QR code in console or visit web dashboard

### Deployment
- Configured for Replit VM deployment (maintains state)
- WhatsApp session persists across restarts
- File-based storage for orders and settings

## Security Notes
- Admin UI requires token authentication
- Admin WhatsApp number is verified for sensitive commands
- M-Pesa transactions handled securely via Shadow Pay
- Session data is isolated and persistent

## Troubleshooting

### WhatsApp Not Connecting
- Check workflow logs for errors
- Use admin menu option 10 to restart session
- Verify Chromium is installed

### Orders Not Processing
- Verify Shadow Pay and Statum API credentials
- Check admin settings (option 6 in admin menu)
- Review order status via admin panel

### Web Dashboard Issues
- Ensure server is running on port 5000
- Check Socket.IO connection
- Verify admin token for admin UI access

## User Preferences
- **Confirmation Style**: Number-based (1=Yes, 2=No) instead of text
- **UI Style**: Emoji-rich, well-organized menus with clear headers
- **Admin Access**: Comprehensive WhatsApp-based admin panel with all features

## API Integration Details
- **Shadow Pay**: M-Pesa STK push and payment verification
- **Statum**: Airtime delivery to recipient numbers
- **WhatsApp**: Automated customer service and admin control
