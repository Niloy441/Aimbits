const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'admin1234';

// Realtime Event Bus
const realtimeBus = new EventEmitter();
realtimeBus.setMaxListeners(100);

// Connected SSE Clients
const adminClients = new Set();
const userClients = new Map(); // deviceId -> Set(res)

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Determine writable DB path (supports Vercel serverless /tmp)
const DB_FILE = process.env.VERCEL
  ? path.join('/tmp', 'bitaim_db.json')
  : path.join(__dirname, 'data', 'db.json');

// Default Database Structure
const initialData = {
  users: {
    "AIM-DEMO-VIP": {
      deviceId: "AIM-DEMO-VIP",
      deviceName: "Demo VIP Device (Samsung S23)",
      isPremium: true,
      plan: "Lifetime VIP",
      expireAt: 4102444800000, // Year 2100
      createdAt: Date.now() - 3600000,
      lastSeen: Date.now(),
      isOnline: true
    },
    "AIM-DEMO-FREE": {
      deviceId: "AIM-DEMO-FREE",
      deviceName: "Demo Free Device (Redmi Note 12)",
      isPremium: false,
      plan: "Free",
      expireAt: 0,
      createdAt: Date.now() - 7200000,
      lastSeen: Date.now(),
      isOnline: false
    }
  },
  payments: [],
  activityLogs: [
    {
      id: "LOG-INIT",
      type: "SYSTEM",
      message: "bitAIM + Realtime Engine Started",
      timestamp: Date.now()
    }
  ],
  config: {
    bkashNumber: "01700000000 (Personal - Send Money)",
    nagadNumber: "01800000000 (Personal - Send Money)",
    rocketNumber: "01900000000 (Personal - Send Money)",
    usdtAddress: "TYDzsxdCz9kSdCd9872nK2kd91Hj28 (TRC20)",
    plans: [
      { id: "weekly", name: "7 Days Pass", price: 150, days: 7, popular: false },
      { id: "monthly", name: "1 Month VIP", price: 350, days: 30, popular: true },
      { id: "quarterly", name: "3 Months VIP Pro", price: 800, days: 90, popular: false },
      { id: "lifetime", name: "Lifetime VIP", price: 1499, days: 3650, popular: false }
    ],
    announcement: "🔥 bitAIM + ফুল রিয়েল-টাইম ইঞ্জিন সক্রিয়! এডমিন যে কোনো সময় ১-ক্লিকে প্রিমিয়াম ও ফ্রি করতে পারবেন।",
    firebaseUrl: process.env.FIREBASE_DB_URL || "",
    minVersion: "3.7.04",
    downloadUrl: "https://t.me/your_channel"
  }
};

let db = { ...initialData };

function loadDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      db = JSON.parse(raw);
    } else {
      saveDb();
    }
  } catch (e) {
    console.error("DB Load Error, using memory:", e.message);
  }
}

function saveDb() {
  try {
    const dir = path.dirname(DB_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (e) {
    console.error("DB Save Error:", e.message);
  }
}

loadDb();

// Add Realtime Activity Log
function addActivityLog(type, message, metadata = {}) {
  const log = {
    id: "LOG-" + Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
    type,
    message,
    metadata,
    timestamp: Date.now()
  };
  if (!db.activityLogs) db.activityLogs = [];
  db.activityLogs.unshift(log);
  if (db.activityLogs.length > 100) db.activityLogs.pop();
  saveDb();
  broadcastToAdmins('ACTIVITY_LOG', log);
  return log;
}

// Optional Firebase Realtime DB Sync Helper
async function syncToFirebase(pathUrl, data) {
  if (!db.config.firebaseUrl) return;
  try {
    let baseUrl = db.config.firebaseUrl.trim().replace(/\/+$/, '');
    if (!baseUrl.startsWith('http')) baseUrl = 'https://' + baseUrl;
    const url = `${baseUrl}/${pathUrl}.json`;
    await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  } catch (err) {
    console.warn("Firebase sync warning:", err.message);
  }
}

// Admin Authorization Middleware
function requireAdmin(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '') || req.headers['x-admin-secret'] || req.query.admin_secret;
  const currentSecret = process.env.ADMIN_SECRET || ADMIN_SECRET;
  if (token === currentSecret) {
    return next();
  }
  return res.status(401).json({ error: "Unauthorized. Incorrect Admin Secret." });
}

// ==========================================
// ⚡ 100% REALTIME SERVER-SENT EVENTS (SSE)
// ==========================================

function broadcastToAdmins(type, data) {
  const payload = `data: ${JSON.stringify({ type, data, timestamp: Date.now() })}\n\n`;
  for (const client of adminClients) {
    try {
      client.write(payload);
    } catch (e) {
      adminClients.delete(client);
    }
  }
}

function broadcastToUser(deviceId, type, data) {
  const clients = userClients.get(deviceId);
  if (!clients || clients.size === 0) return;
  const payload = `data: ${JSON.stringify({ type, data, timestamp: Date.now() })}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch (e) {
      clients.delete(client);
    }
  }
}

function broadcastToAllUsers(type, data) {
  const payload = `data: ${JSON.stringify({ type, data, timestamp: Date.now() })}\n\n`;
  for (const [deviceId, clients] of userClients.entries()) {
    for (const client of clients) {
      try {
        client.write(payload);
      } catch (e) {
        clients.delete(client);
      }
    }
  }
}

// SSE: Admin Realtime Stream
app.get('/api/realtime/admin', requireAdmin, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive'
  });
  res.write(':connected\n\n');

  adminClients.add(res);

  // Send initial snapshot
  const initialPayload = JSON.stringify({
    type: 'SNAPSHOT',
    data: {
      stats: getStats(),
      onlineUsers: Array.from(userClients.keys()),
      activityLogs: db.activityLogs || []
    }
  });
  res.write(`data: ${initialPayload}\n\n`);

  // Heartbeat ping every 15 seconds
  const pingInterval = setInterval(() => {
    try {
      res.write(':ping\n\n');
    } catch (e) {
      clearInterval(pingInterval);
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(pingInterval);
    adminClients.delete(res);
  });
});

// SSE: User Device Realtime Stream
app.get('/api/realtime/user/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const cleanId = String(deviceId).trim();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive'
  });
  res.write(':connected\n\n');

  if (!userClients.has(cleanId)) {
    userClients.set(cleanId, new Set());
  }
  userClients.get(cleanId).add(res);

  // Update user online status
  let user = db.users[cleanId];
  if (user) {
    user.isOnline = true;
    user.lastSeen = Date.now();
    saveDb();
  }

  // Notify admins that user is live
  broadcastToAdmins('USER_CONNECTED', {
    deviceId: cleanId,
    deviceName: user ? user.deviceName : "Unknown",
    timestamp: Date.now()
  });

  addActivityLog('USER_CONNECT', `📱 ইউজার ${cleanId} রিয়েল-টাইমে কানেক্ট হয়েছে`);

  // Send initial subscription status to device
  const now = Date.now();
  const isVip = Boolean(user && user.isPremium && (user.expireAt === 0 || user.expireAt > now));
  res.write(`data: ${JSON.stringify({
    type: 'STATUS_SYNC',
    data: {
      deviceId: cleanId,
      isPremium: isVip,
      plan: user ? user.plan : "Free",
      expireAt: user ? user.expireAt : 0,
      notice: db.config.announcement
    }
  })}\n\n`);

  // Heartbeat ping every 15 seconds
  const pingInterval = setInterval(() => {
    try {
      res.write(':ping\n\n');
    } catch (e) {
      clearInterval(pingInterval);
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(pingInterval);
    const clients = userClients.get(cleanId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) {
        userClients.delete(cleanId);
        if (db.users[cleanId]) {
          db.users[cleanId].isOnline = false;
          saveDb();
        }
        broadcastToAdmins('USER_DISCONNECTED', { deviceId: cleanId });
      }
    }
  });
});

function getStats() {
  const users = Object.values(db.users);
  const now = Date.now();
  const totalUsers = users.length;
  const premiumUsers = users.filter(u => u.isPremium && (u.expireAt === 0 || u.expireAt > now)).length;
  const freeUsers = totalUsers - premiumUsers;
  const pendingPayments = db.payments.filter(p => p.status === 'pending').length;
  const totalRevenue = db.payments
    .filter(p => p.status === 'approved')
    .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  const onlineCount = userClients.size;

  return {
    totalUsers,
    premiumUsers,
    freeUsers,
    pendingPayments,
    totalRevenue,
    onlineCount
  };
}

// ==========================================
// 📱 CLIENT (ANDROID APP) API ENDPOINTS
// ==========================================

// Health Check
app.get('/api/status', (req, res) => {
  res.json({
    status: "online",
    server: "bitAIM + Cloud Controller (Realtime Active)",
    timestamp: Date.now(),
    usersCount: Object.keys(db.users).length,
    realtimeOnlineCount: userClients.size
  });
});

// App Config & Payment Details
app.get('/api/config', (req, res) => {
  res.json({
    success: true,
    config: db.config
  });
});

// Device Sync & Subscription Status
app.post('/api/user/sync', (req, res) => {
  const { deviceId, deviceName, appVersion } = req.body;
  if (!deviceId) {
    return res.status(400).json({ error: "deviceId is required" });
  }

  const cleanId = String(deviceId).trim();
  let user = db.users[cleanId];
  const now = Date.now();
  let isNew = false;

  if (!user) {
    isNew = true;
    user = {
      deviceId: cleanId,
      deviceName: deviceName || "Android Device",
      appVersion: appVersion || "3.7.04",
      isPremium: false,
      plan: "Free",
      expireAt: 0,
      createdAt: now,
      lastSeen: now,
      isOnline: userClients.has(cleanId)
    };
    db.users[cleanId] = user;
    saveDb();
    syncToFirebase(`users/${cleanId}`, user);
    addActivityLog('NEW_USER', `🎉 নতুন ডিভাইস রেজিস্টার হয়েছে: ${cleanId} (${user.deviceName})`);
    broadcastToAdmins('USER_REGISTERED', user);
  } else {
    user.lastSeen = now;
    user.isOnline = userClients.has(cleanId);
    if (deviceName) user.deviceName = deviceName;
    if (appVersion) user.appVersion = appVersion;

    if (user.isPremium && user.expireAt > 0 && user.expireAt < now) {
      user.isPremium = false;
      user.plan = "Expired (Free)";
      addActivityLog('EXPIRED', `⏳ ইউজার ${cleanId}-এর সাবস্ক্রিপশন মেয়াদ শেষ হয়েছে`);
    }
    saveDb();
  }

  const isVip = Boolean(user.isPremium && (user.expireAt === 0 || user.expireAt > now));

  // Push realtime update to Admins
  broadcastToAdmins('USER_UPDATED', user);
  broadcastToAdmins('STATS_UPDATED', getStats());

  res.json({
    success: true,
    deviceId: user.deviceId,
    isPremium: isVip,
    plan: user.plan,
    expireAt: user.expireAt,
    expireFormatted: user.expireAt === 0 
      ? (isVip ? "Lifetime VIP" : "Never")
      : (user.expireAt > now ? new Date(user.expireAt).toLocaleString('bn-BD') : "Expired"),
    features: {
      aimLines: isVip ? 4 : 2,
      laserLine: isVip,
      autoDetection: isVip,
      cushionBounce: isVip,
      adFree: isVip,
      maxSessionMinutes: isVip ? 999999 : 5
    },
    notice: db.config.announcement,
    serverTime: now
  });
});

// Submit Payment (bKash / Nagad / Rocket / USDT)
app.post('/api/payment/submit', (req, res) => {
  const { deviceId, senderPhone, trxId, method, plan, amount } = req.body;
  if (!deviceId || !trxId || !senderPhone) {
    return res.status(400).json({ error: "deviceId, trxId and senderPhone are required" });
  }

  const cleanTrx = String(trxId).trim().toUpperCase();
  const cleanDevice = String(deviceId).trim();

  // Check duplicate TrxID
  const duplicate = db.payments.find(p => p.trxId === cleanTrx);
  if (duplicate) {
    return res.status(400).json({
      error: "এই TrxID টি ইতিমধ্যেই জমা দেওয়া হয়েছে! অনুগ্রহ করে এডমিনের অনুমোদনের অপেক্ষা করুন।"
    });
  }

  const paymentRecord = {
    id: "PAY-" + Date.now().toString(36).toUpperCase(),
    deviceId: cleanDevice,
    senderPhone: String(senderPhone).trim(),
    trxId: cleanTrx,
    method: method || "bKash",
    plan: plan || "1 Month VIP",
    amount: Number(amount) || 350,
    status: "pending", // pending, approved, rejected
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  db.payments.unshift(paymentRecord);
  saveDb();
  syncToFirebase(`payments/${paymentRecord.id}`, paymentRecord);

  addActivityLog('NEW_PAYMENT', `💰 নতুন পেমেন্ট: ৳${paymentRecord.amount} (${paymentRecord.method}) TrxID: ${paymentRecord.trxId} - ডিভাইস: ${paymentRecord.deviceId}`);

  // ⚡ 100% REALTIME BROADCAST TO ADMIN DASHBOARDS!
  broadcastToAdmins('PAYMENT_NEW', paymentRecord);
  broadcastToAdmins('STATS_UPDATED', getStats());

  res.json({
    success: true,
    paymentId: paymentRecord.id,
    message: "পেমেন্ট সফলভাবে সাবমিট হয়েছে! এডমিন দ্রুত ভেরিফাই করে আপনার ডিভাইস প্রিমিয়াম একটিভ করবে।"
  });
});

// Payment History for a Device
app.get('/api/payment/history', (req, res) => {
  const { deviceId } = req.query;
  if (!deviceId) {
    return res.status(400).json({ error: "deviceId is required" });
  }
  const cleanId = String(deviceId).trim();
  const list = db.payments.filter(p => p.deviceId === cleanId);
  res.json({
    success: true,
    payments: list
  });
});

// ==========================================
// 🛡️ ADMIN PANEL API ENDPOINTS
// ==========================================

// Admin Login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  const currentSecret = process.env.ADMIN_SECRET || ADMIN_SECRET;
  if (password === currentSecret) {
    return res.json({ success: true, token: currentSecret });
  }
  return res.status(401).json({ error: "ভুল পাসওয়ার্ড! অনুগ্রহ করে সঠিক এডমিন সিক্রেট দিন।" });
});

// Dashboard Stats
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  res.json({
    success: true,
    stats: getStats()
  });
});

// Get All Users (with Search & Filter)
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const { query, filter } = req.query;
  let list = Object.values(db.users);
  const now = Date.now();

  list.forEach(u => {
    u.isOnline = userClients.has(u.deviceId);
  });

  if (query) {
    const q = query.toLowerCase();
    list = list.filter(u => 
      u.deviceId.toLowerCase().includes(q) || 
      (u.deviceName && u.deviceName.toLowerCase().includes(q))
    );
  }

  if (filter === 'premium') {
    list = list.filter(u => u.isPremium && (u.expireAt === 0 || u.expireAt > now));
  } else if (filter === 'free') {
    list = list.filter(u => !u.isPremium || (u.expireAt > 0 && u.expireAt <= now));
  } else if (filter === 'online') {
    list = list.filter(u => u.isOnline);
  }

  list.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));

  res.json({
    success: true,
    users: list,
    onlineDevices: Array.from(userClients.keys())
  });
});

// ⚡ CORE REQUIREMENT: TOGGLE USER BETWEEN FREE AND PREMIUM (REALTIME PUSH TO USER & ADMIN!)
app.post('/api/admin/user/toggle', requireAdmin, (req, res) => {
  const { deviceId, isPremium, durationDays, plan } = req.body;
  if (!deviceId) {
    return res.status(400).json({ error: "deviceId is required" });
  }

  const cleanId = String(deviceId).trim();
  let user = db.users[cleanId];

  if (!user) {
    user = {
      deviceId: cleanId,
      deviceName: "Manual Added Device",
      createdAt: Date.now(),
      lastSeen: Date.now(),
      isOnline: userClients.has(cleanId)
    };
    db.users[cleanId] = user;
  }

  const targetPremium = Boolean(isPremium);
  const now = Date.now();

  if (targetPremium) {
    user.isPremium = true;
    user.plan = plan || (durationDays ? `${durationDays} Days VIP` : "1 Month VIP");
    const days = Number(durationDays) || 30;
    if (days >= 3650) {
      user.expireAt = 0; // Lifetime
      user.plan = "Lifetime VIP";
    } else {
      user.expireAt = now + (days * 24 * 60 * 60 * 1000);
    }
  } else {
    user.isPremium = false;
    user.plan = "Free";
    user.expireAt = 0;
  }

  user.updatedAt = now;
  saveDb();
  syncToFirebase(`users/${cleanId}`, user);

  addActivityLog(
    targetPremium ? 'UPGRADE_VIP' : 'DOWNGRADE_FREE',
    targetPremium 
      ? `👑 এডমিন ইউজার ${cleanId}-কে প্রিমিয়াম VIP বানিয়েছেন (${user.plan})`
      : `⚪ এডমিন ইউজার ${cleanId}-কে ফ্রি ইউজার বানিয়েছেন`
  );

  // ⚡ INSTANT REALTIME BROADCAST TO TARGET ANDROID DEVICE!
  broadcastToUser(cleanId, 'STATUS_CHANGED', {
    deviceId: cleanId,
    isPremium: user.isPremium,
    plan: user.plan,
    expireAt: user.expireAt,
    message: targetPremium
      ? "🎉 Congratulations! Admin has upgraded your account to VIP Premium! 4-Line Aim and Laser are active!"
      : "⚠️ Your subscription status has been changed to Free mode."
  });

  // ⚡ INSTANT REALTIME BROADCAST TO ALL ADMIN SCREENS!
  broadcastToAdmins('USER_UPDATED', user);
  broadcastToAdmins('STATS_UPDATED', getStats());

  res.json({
    success: true,
    message: targetPremium
      ? `✅ ইউজার ${cleanId} কে সফলভাবে প্রিমিয়াম করা হয়েছে! (রিয়েল-টাইম পুশ পাঠানো হয়েছে)`
      : `⚪ ইউজার ${cleanId} কে ফ্রি ইউজার করা হয়েছে! (রিয়েল-টাইম পুশ পাঠানো হয়েছে)`,
    user
  });
});

// Set Custom Expiry or Plan for a User
app.post('/api/admin/user/set-plan', requireAdmin, (req, res) => {
  const { deviceId, days, planName } = req.body;
  if (!deviceId) return res.status(400).json({ error: "deviceId is required" });

  const cleanId = String(deviceId).trim();
  let user = db.users[cleanId];
  if (!user) return res.status(404).json({ error: "User not found" });

  const numDays = Number(days);
  const now = Date.now();

  if (numDays === 0 || numDays >= 3650) {
    user.isPremium = true;
    user.plan = planName || "Lifetime VIP";
    user.expireAt = 0;
  } else {
    user.isPremium = true;
    user.plan = planName || `${numDays} Days VIP`;
    const baseTime = (user.expireAt && user.expireAt > now) ? user.expireAt : now;
    user.expireAt = baseTime + (numDays * 24 * 60 * 60 * 1000);
  }

  user.updatedAt = now;
  saveDb();
  syncToFirebase(`users/${cleanId}`, user);

  addActivityLog('EXTEND_PLAN', `⏰ ইউজার ${cleanId}-এর মেয়াদ ${days >= 3650 ? 'লাইফটাইম' : days + ' দিন'} বাড়ানো হয়েছে`);

  // Realtime push
  broadcastToUser(cleanId, 'STATUS_CHANGED', {
    deviceId: cleanId,
    isPremium: user.isPremium,
    plan: user.plan,
    expireAt: user.expireAt,
    message: `মেয়াদ বৃদ্ধি করা হয়েছে: ${user.plan}`
  });
  broadcastToAdmins('USER_UPDATED', user);
  broadcastToAdmins('STATS_UPDATED', getStats());

  res.json({
    success: true,
    message: `মেয়াদ সফলভাবে আপডেট হয়েছে!`,
    user
  });
});

// Delete User
app.post('/api/admin/user/delete', requireAdmin, (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ error: "deviceId is required" });
  delete db.users[deviceId];
  saveDb();
  syncToFirebase(`users/${deviceId}`, null);

  addActivityLog('DELETE_USER', `🗑️ ইউজার ${deviceId} মুছে ফেলা হয়েছে`);
  broadcastToAdmins('USER_DELETED', { deviceId });
  broadcastToAdmins('STATS_UPDATED', getStats());

  res.json({ success: true, message: "ইউজার মুছে ফেলা হয়েছে" });
});

// Get Payments
app.get('/api/admin/payments', requireAdmin, (req, res) => {
  res.json({
    success: true,
    payments: db.payments
  });
});

// Approve or Reject Payment
app.post('/api/admin/payment/update', requireAdmin, (req, res) => {
  const { paymentId, status, rejectReason } = req.body;
  if (!paymentId || !['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: "Valid paymentId and status ('approved' or 'rejected') required" });
  }

  const payment = db.payments.find(p => p.id === paymentId);
  if (!payment) {
    return res.status(404).json({ error: "Payment record not found" });
  }

  payment.status = status;
  payment.updatedAt = Date.now();
  if (rejectReason) payment.rejectReason = rejectReason;

  // If approved -> Automatically upgrade user to Premium!
  if (status === 'approved') {
    let user = db.users[payment.deviceId];
    if (!user) {
      user = {
        deviceId: payment.deviceId,
        deviceName: "Auto Created via Payment",
        createdAt: Date.now(),
        lastSeen: Date.now(),
        isOnline: userClients.has(payment.deviceId)
      };
      db.users[payment.deviceId] = user;
    }

    let daysToAdd = 30;
    const planStr = String(payment.plan).toLowerCase();
    if (planStr.includes('week') || planStr.includes('7')) daysToAdd = 7;
    else if (planStr.includes('3 month') || planStr.includes('90')) daysToAdd = 90;
    else if (planStr.includes('life')) daysToAdd = 3650;

    const now = Date.now();
    user.isPremium = true;
    user.plan = payment.plan;

    if (daysToAdd >= 3650) {
      user.expireAt = 0; // Lifetime
    } else {
      const baseTime = (user.expireAt && user.expireAt > now) ? user.expireAt : now;
      user.expireAt = baseTime + (daysToAdd * 24 * 60 * 60 * 1000);
    }

    user.updatedAt = now;
    syncToFirebase(`users/${user.deviceId}`, user);

    addActivityLog('PAYMENT_APPROVED', `✅ পেমেন্ট অনুমোদিত: ৳${payment.amount} (TrxID: ${payment.trxId}) -> ইউজার ${user.deviceId} এখন VIP!`);

    // ⚡ REALTIME PUSH TO USER APP: VIP UNLOCKED INSTANTLY!
    broadcastToUser(user.deviceId, 'STATUS_CHANGED', {
      deviceId: user.deviceId,
      isPremium: true,
      plan: user.plan,
      expireAt: user.expireAt,
      message: "🎉 Payment Verified! Your account is now VIP Premium! Enjoy 4-Line Trajectories & Laser Assist!"
    });
    broadcastToAdmins('USER_UPDATED', user);
  } else {
    addActivityLog('PAYMENT_REJECTED', `❌ পেমেন্ট বাতিল: TrxID ${payment.trxId} (${rejectReason || 'Invalid'})`);
    broadcastToUser(payment.deviceId, 'PAYMENT_REJECTED', {
      paymentId: payment.id,
      trxId: payment.trxId,
      reason: rejectReason || "Invalid TrxID"
    });
  }

  saveDb();
  syncToFirebase(`payments/${payment.id}`, payment);

  // Broadcast payment update to Admins
  broadcastToAdmins('PAYMENT_UPDATED', payment);
  broadcastToAdmins('STATS_UPDATED', getStats());

  res.json({
    success: true,
    message: status === 'approved' 
      ? `✅ পেমেন্ট অনুমোদন করা হয়েছে এবং ইউজার ${payment.deviceId} এখন প্রিমিয়াম VIP!`
      : `❌ পেমেন্ট বাতিল করা হয়েছে।`,
    payment
  });
});

// Update System Settings & Payment Numbers
app.post('/api/admin/config', requireAdmin, (req, res) => {
  const { bkashNumber, nagadNumber, rocketNumber, usdtAddress, announcement, firebaseUrl, plans } = req.body;

  if (bkashNumber !== undefined) db.config.bkashNumber = bkashNumber;
  if (nagadNumber !== undefined) db.config.nagadNumber = nagadNumber;
  if (rocketNumber !== undefined) db.config.rocketNumber = rocketNumber;
  if (usdtAddress !== undefined) db.config.usdtAddress = usdtAddress;
  if (announcement !== undefined) {
    db.config.announcement = announcement;
    // Broadcast live notice update to all users
    broadcastToAllUsers('NOTICE_UPDATED', { notice: announcement });
  }
  if (firebaseUrl !== undefined) db.config.firebaseUrl = firebaseUrl;
  if (plans && Array.isArray(plans)) db.config.plans = plans;

  saveDb();
  syncToFirebase('config', db.config);

  addActivityLog('CONFIG_UPDATE', "⚙️ সার্ভার সেটিংস ও পেমেন্ট নম্বর আপডেট করা হয়েছে");
  broadcastToAdmins('CONFIG_UPDATED', db.config);

  res.json({
    success: true,
    message: "সার্ভার কনফিগারেশন সফলভাবে সেভ হয়েছে!",
    config: db.config
  });
});

// ⚡ REALTIME POPUP BROADCAST TO ALL ACTIVE APP USERS!
app.post('/api/admin/broadcast', requireAdmin, (req, res) => {
  const { title, message } = req.body;
  if (!message) return res.status(400).json({ error: "Message is required" });

  const alertData = {
    title: title || "📢 অ্যাডমিন নোটিশ",
    message: String(message).trim(),
    timestamp: Date.now()
  };

  broadcastToAllUsers('BROADCAST_ALERT', alertData);
  addActivityLog('BROADCAST', `📢 সমস্ত সক্রিয় অ্যাপে বার্তা পাঠানো হয়েছে: "${alertData.message}"`);

  res.json({
    success: true,
    message: "সমস্ত সক্রিয় অ্যাপে নোটিফিকেশন পাঠানো হয়েছে!",
    onlineReceivers: userClients.size
  });
});

// Fallback to SPA index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`===============================================`);
    console.log(`🚀 bitAIM + Admin Server running on port ${PORT}`);
    console.log(`⚡ 100% Realtime Server-Sent Events Active!`);
    console.log(`🔑 Admin Secret: ${process.env.ADMIN_SECRET || ADMIN_SECRET}`);
    console.log(`🌐 Dashboard URL: http://localhost:${PORT}`);
    console.log(`===============================================`);
  });
}

module.exports = app;
