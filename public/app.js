// bitAIM + 100% Realtime Admin Dashboard Client Logic
let adminToken = localStorage.getItem('bitaim_admin_token') || '';
let currentTab = 'overview';
let allUsers = [];
let allPayments = [];
let allLogs = [];
let onlineDevices = new Set();
let userFilter = 'all';
let sseConnection = null;
let soundEnabled = localStorage.getItem('bitaim_sound') !== 'false';

// Web Audio API Synthesizer (Zero external file dependencies)
function playChime(type = 'success') {
  if (!soundEnabled) return;
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    if (type === 'payment') {
      // High pitch double-ding for payment!
      osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
      osc.frequency.setValueAtTime(880.00, ctx.currentTime + 0.12); // A5
    } else if (type === 'vip') {
      osc.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
      osc.frequency.setValueAtTime(659.25, ctx.currentTime + 0.1); // E5
      osc.frequency.setValueAtTime(783.99, ctx.currentTime + 0.2); // G5
    } else {
      osc.frequency.setValueAtTime(440, ctx.currentTime);
    }

    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.42);
  } catch (e) {}
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  localStorage.setItem('bitaim_sound', soundEnabled);
  const btn = document.getElementById('soundToggleBtn');
  btn.innerHTML = soundEnabled ? '<i class="fa-solid fa-volume-high"></i>' : '<i class="fa-solid fa-volume-xmark text-slate-500"></i>';
  showToast(soundEnabled ? "সাউন্ড অন করা হয়েছে" : "সাউন্ড মিউট করা হয়েছে", "info");
}

// Toast Notification
function showToast(msg, type = 'success') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  const bgClass = type === 'success' ? 'bg-emerald-600 text-white' : (type === 'error' ? 'bg-rose-600 text-white' : 'bg-slate-800 text-slate-200');
  toast.className = `px-4 py-3 rounded-xl shadow-xl font-medium text-xs flex items-center gap-2 transform transition-all duration-300 pointer-events-auto border border-white/10 ${bgClass}`;
  toast.innerHTML = `<i class="fa-solid ${type === 'success' ? 'fa-circle-check' : 'fa-circle-exclamation'}"></i> <span>${msg}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// Check Authentication & Start Realtime
function checkAuth() {
  const modal = document.getElementById('loginModal');
  if (!adminToken) {
    modal.classList.remove('hidden');
  } else {
    modal.classList.add('hidden');
    loadAllData();
    initRealtimeSSE();
  }
}

// Handle Login
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const secret = document.getElementById('adminSecretInput').value.trim();
  const errElem = document.getElementById('loginError');

  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: secret })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      adminToken = data.token;
      localStorage.setItem('bitaim_admin_token', adminToken);
      document.getElementById('loginModal').classList.add('hidden');
      errElem.classList.add('hidden');
      showToast("লগইন সফল হয়েছে!", "success");
      loadAllData();
      initRealtimeSSE();
    } else {
      errElem.textContent = data.error || "পাসওয়ার্ড সঠিক নয়!";
      errElem.classList.remove('hidden');
    }
  } catch (err) {
    errElem.textContent = "সার্ভার কানেকশন এরর: " + err.message;
    errElem.classList.remove('hidden');
  }
});

function logout() {
  localStorage.removeItem('bitaim_admin_token');
  adminToken = '';
  if (sseConnection) sseConnection.close();
  location.reload();
}

// Authenticated Fetch Helper
async function authFetch(url, options = {}) {
  options.headers = options.headers || {};
  options.headers['Authorization'] = `Bearer ${adminToken}`;
  const res = await fetch(url, options);
  if (res.status === 401) {
    logout();
    throw new Error("Unauthorized");
  }
  return res.json();
}

// ==========================================
// ⚡ NATIVE REALTIME SERVER-SENT EVENTS (SSE)
// ==========================================

function initRealtimeSSE() {
  if (sseConnection) {
    try { sseConnection.close(); } catch (e) {}
  }

  const sseUrl = `/api/realtime/admin?admin_secret=${encodeURIComponent(adminToken)}`;
  sseConnection = new EventSource(sseUrl);

  const dot = document.getElementById('realtimeStatusDot');
  const text = document.getElementById('realtimeStatusText');

  sseConnection.onopen = () => {
    if (dot) dot.className = "w-2 h-2 rounded-full bg-emerald-400 pulse-ring";
    if (text) text.textContent = "100% Realtime Live";
  };

  sseConnection.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleRealtimeEvent(msg);
    } catch (e) {}
  };

  sseConnection.onerror = () => {
    if (dot) dot.className = "w-2 h-2 rounded-full bg-amber-400";
    if (text) text.textContent = "Reconnecting...";
  };
}

function handleRealtimeEvent(msg) {
  const { type, data } = msg;

  if (type === 'SNAPSHOT') {
    if (data.onlineUsers) {
      onlineDevices = new Set(data.onlineUsers);
      updateOnlineCounter();
    }
    if (data.activityLogs) {
      allLogs = data.activityLogs;
      renderActivityFeed();
    }
    if (data.stats) updateStatsDOM(data.stats);
  }

  else if (type === 'USER_CONNECTED') {
    onlineDevices.add(data.deviceId);
    updateOnlineCounter();
    renderUsersTable();
  }

  else if (type === 'USER_DISCONNECTED') {
    onlineDevices.delete(data.deviceId);
    updateOnlineCounter();
    renderUsersTable();
  }

  else if (type === 'USER_UPDATED' || type === 'USER_REGISTERED') {
    const idx = allUsers.findIndex(u => u.deviceId === data.deviceId);
    if (idx !== -1) {
      allUsers[idx] = data;
    } else {
      allUsers.unshift(data);
    }
    renderUsersTable();
  }

  else if (type === 'USER_DELETED') {
    allUsers = allUsers.filter(u => u.deviceId !== data.deviceId);
    renderUsersTable();
  }

  else if (type === 'PAYMENT_NEW') {
    playChime('payment');
    showToast(`🔔 নতুন পেমেন্ট সাবমিট হয়েছে! ৳${data.amount} (${data.method}) TrxID: ${data.trxId}`, 'success');
    allPayments.unshift(data);
    renderPaymentsTable(allPayments);
  }

  else if (type === 'PAYMENT_UPDATED') {
    const idx = allPayments.findIndex(p => p.id === data.id);
    if (idx !== -1) allPayments[idx] = data;
    renderPaymentsTable(allPayments);
  }

  else if (type === 'STATS_UPDATED') {
    updateStatsDOM(data);
  }

  else if (type === 'ACTIVITY_LOG') {
    allLogs.unshift(data);
    if (allLogs.length > 100) allLogs.pop();
    renderActivityFeed();
  }
}

function updateOnlineCounter() {
  const topElem = document.getElementById('statOnlineUsersTop');
  if (topElem) topElem.textContent = onlineDevices.size;
}

function updateStatsDOM(stats) {
  if (!stats) return;
  document.getElementById('statTotalUsers').textContent = stats.totalUsers || 0;
  document.getElementById('statPremiumUsers').textContent = stats.premiumUsers || 0;
  document.getElementById('statFreeUsers').textContent = stats.freeUsers || 0;
  document.getElementById('statPendingPayments').textContent = stats.pendingPayments || 0;
  document.getElementById('statRevenue').textContent = (stats.totalRevenue || 0).toLocaleString('en-IN');
  document.getElementById('badgeUsersCount').textContent = stats.totalUsers || 0;

  const badgePending = document.getElementById('badgePendingPayments');
  if (stats.pendingPayments > 0) {
    badgePending.textContent = stats.pendingPayments;
    badgePending.classList.remove('hidden');
  } else {
    badgePending.classList.add('hidden');
  }
}

// Activity Feed Rendering
function renderActivityFeed() {
  const container = document.getElementById('activityFeedContainer');
  const fullContainer = document.getElementById('fullActivityLogContainer');

  const html = allLogs.slice(0, 15).map(log => {
    let icon = "fa-bell text-slate-400";
    if (log.type === 'UPGRADE_VIP') icon = "fa-crown text-emerald-400";
    else if (log.type === 'DOWNGRADE_FREE') icon = "fa-user text-slate-400";
    else if (log.type === 'NEW_PAYMENT') icon = "fa-money-bill-wave text-amber-400";
    else if (log.type === 'PAYMENT_APPROVED') icon = "fa-check-circle text-emerald-400";
    else if (log.type === 'USER_CONNECT') icon = "fa-mobile-screen text-cyan-400";
    else if (log.type === 'BROADCAST') icon = "fa-bullhorn text-blue-400";

    const timeStr = new Date(log.timestamp).toLocaleTimeString();

    return `
      <div class="flex items-center gap-2 p-2 bg-slate-900/60 rounded-xl border border-slate-800/60">
        <i class="fa-solid ${icon} text-xs"></i>
        <span class="text-slate-300 flex-1">${log.message}</span>
        <span class="text-[10px] text-slate-500 mono">${timeStr}</span>
      </div>
    `;
  }).join('');

  if (container) container.innerHTML = html || `<div class="text-slate-500 py-3 text-center">কোন ইভেন্ট নেই</div>`;
  if (fullContainer) fullContainer.innerHTML = html;
}

// Tab Switching
function switchTab(tabId) {
  currentTab = tabId;
  const tabs = ['overview', 'users', 'payments', 'activity', 'settings', 'firebase'];
  tabs.forEach(t => {
    const section = document.getElementById(`tab-${t}`);
    const btn = document.getElementById(`tabBtn-${t}`);
    if (t === tabId) {
      if (section) section.classList.remove('hidden');
      if (btn) btn.className = "w-full flex items-center space-x-3 px-4 py-3 rounded-xl font-medium text-sm transition bg-cyan-500/10 text-cyan-300 border border-cyan-500/30";
    } else {
      if (section) section.classList.add('hidden');
      if (btn) btn.className = "w-full flex items-center space-x-3 px-4 py-3 rounded-xl font-medium text-sm transition text-slate-400 hover:text-white hover:bg-slate-800/60";
    }
  });

  if (tabId === 'users') loadUsers();
  if (tabId === 'payments') loadPayments();
  if (tabId === 'activity') renderActivityFeed();
  if (tabId === 'settings' || tabId === 'firebase') loadConfig();
}

// Load All Data
async function loadAllData() {
  await Promise.all([loadStats(), loadUsers(), loadPayments(), loadConfig()]);
}

async function loadStats() {
  try {
    const data = await authFetch('/api/admin/stats');
    if (data.success) {
      updateStatsDOM(data.stats);
    }
  } catch (e) {}
}

// ===============================================
// 👥 USERS MANAGEMENT (TOGGLE FREE <-> PREMIUM)
// ===============================================

async function loadUsers() {
  try {
    const data = await authFetch('/api/admin/users');
    if (data.success) {
      allUsers = data.users || [];
      if (data.onlineDevices) onlineDevices = new Set(data.onlineDevices);
      updateOnlineCounter();
      renderUsersTable();
    }
  } catch (e) {}
}

function renderUsersTable() {
  const tbody = document.getElementById('usersTableBody');
  if (!tbody) return;
  const now = Date.now();
  const search = (document.getElementById('userSearchInput')?.value || '').toLowerCase().trim();

  let list = allUsers.filter(u => {
    const matchSearch = u.deviceId.toLowerCase().includes(search) || 
                        (u.deviceName && u.deviceName.toLowerCase().includes(search));
    const isVip = u.isPremium && (u.expireAt === 0 || u.expireAt > now);
    const isOnline = onlineDevices.has(u.deviceId);
    if (!matchSearch) return false;
    if (userFilter === 'premium') return isVip;
    if (userFilter === 'free') return !isVip;
    if (userFilter === 'online') return isOnline;
    return true;
  });

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center py-10 text-slate-500">কোন ইউজার পাওয়া যায়নি</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(u => {
    const isVip = u.isPremium && (u.expireAt === 0 || u.expireAt > now);
    const isOnline = onlineDevices.has(u.deviceId);

    let expiryText = "ফ্রি (কোন মেয়াদ নেই)";
    if (isVip) {
      if (u.expireAt === 0) {
        expiryText = `<span class="text-amber-400 font-bold"><i class="fa-solid fa-infinity"></i> লাইফটাইম VIP</span>`;
      } else {
        const d = new Date(u.expireAt);
        const diffDays = Math.ceil((u.expireAt - now) / (1000 * 60 * 60 * 24));
        expiryText = `<span class="text-emerald-400 font-semibold">${d.toLocaleDateString()} (${diffDays} দিন বাকি)</span>`;
      }
    }

    return `
      <tr class="hover:bg-slate-800/40 transition">
        <td class="py-3 px-4">
          <div class="flex items-center gap-2">
            <span class="w-2 h-2 rounded-full ${isOnline ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}" title="${isOnline ? 'লাইভ অনলাইন' : 'অফলাইন'}"></span>
            <span class="font-bold text-white mono text-xs">${u.deviceId}</span>
          </div>
          <div class="text-[11px] text-slate-500 pl-4">${new Date(u.lastSeen || u.createdAt).toLocaleTimeString()} শেষ সক্রিয়</div>
        </td>
        <td class="py-3 px-4">
          <div class="text-slate-300 text-xs">${u.deviceName || 'অ্যান্ড্রয়েড ফোন'}</div>
          <div class="text-[11px] text-slate-500">v${u.appVersion || '3.7.04'}</div>
        </td>
        <td class="py-3 px-4">
          ${isVip 
            ? `<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 flex items-center gap-1 w-max">
                 <i class="fa-solid fa-crown text-[10px]"></i> VIP PREMIUM
               </span>`
            : `<span class="px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-800 text-slate-400 border border-slate-700 flex items-center gap-1 w-max">
                 <i class="fa-solid fa-user text-[10px]"></i> FREE USER
               </span>`
          }
        </td>
        <td class="py-3 px-4 text-xs">
          <div>${u.plan || 'Free'}</div>
          <div class="text-[11px] mt-0.5">${expiryText}</div>
        </td>
        <td class="py-3 px-4 text-center">
          <!-- ⚡ ONE-CLICK SWITCH BUTTON (REALTIME PUSH) -->
          <button onclick="toggleUserPremium('${u.deviceId}', ${!isVip})" 
            class="px-3.5 py-1.5 rounded-xl text-xs font-bold transition shadow-sm ${
              isVip
                ? 'bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30'
                : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black glow-green'
            }">
            ${isVip 
              ? '<i class="fa-solid fa-ban mr-1"></i> ফ্রি করুন (Make Free)' 
              : '<i class="fa-solid fa-crown mr-1"></i> প্রিমিয়াম করুন (Make VIP)'
            }
          </button>
        </td>
        <td class="py-3 px-4 text-right">
          <div class="flex items-center justify-end gap-1.5">
            <button onclick="quickExtend('${u.deviceId}', 7)" title="+৭ দিন বাড়ান"
              class="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] rounded-lg border border-slate-700">
              +7d
            </button>
            <button onclick="quickExtend('${u.deviceId}', 30)" title="+৩০ দিন বাড়ান"
              class="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] rounded-lg border border-slate-700">
              +30d
            </button>
            <button onclick="quickExtend('${u.deviceId}', 3650)" title="লাইফটাইম VIP দিন"
              class="px-2 py-1 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 text-[11px] rounded-lg border border-amber-500/30">
              <i class="fa-solid fa-infinity"></i>
            </button>
            <button onclick="deleteUser('${u.deviceId}')" title="ইউজার ডিলিট করুন"
              class="p-1.5 hover:bg-rose-500/20 text-slate-500 hover:text-rose-400 rounded-lg transition ml-1">
              <i class="fa-solid fa-trash-can"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// ⚡ CORE TOGGLE FUNCTION
async function toggleUserPremium(deviceId, targetIsPremium) {
  try {
    const res = await authFetch('/api/admin/user/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: deviceId,
        isPremium: targetIsPremium,
        durationDays: 30
      })
    });

    if (res.success) {
      playChime(targetIsPremium ? 'vip' : 'default');
      showToast(res.message, targetIsPremium ? 'success' : 'info');
      await loadAllData();
    } else {
      showToast(res.error || "সমস্যা হয়েছে", "error");
    }
  } catch (err) {
    showToast("ত্রুটি: " + err.message, "error");
  }
}

// Quick Extend Days
async function quickExtend(deviceId, days) {
  try {
    const res = await authFetch('/api/admin/user/set-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: deviceId,
        days: days,
        planName: days >= 3650 ? "Lifetime VIP" : `${days} Days VIP`
      })
    });
    if (res.success) {
      playChime('vip');
      showToast(`ইউজার ${deviceId}-এর মেয়াদ ${days >= 3650 ? 'লাইফটাইম' : days + ' দিন'} বাড়ানো হয়েছে!`, "success");
      await loadAllData();
    }
  } catch (err) {
    showToast("ত্রুটি: " + err.message, "error");
  }
}

// Delete User
async function deleteUser(deviceId) {
  if (!confirm(`আপনি কি নিশ্চিত যে ইউজার ${deviceId} মুছে ফেলতে চান?`)) return;
  try {
    const res = await authFetch('/api/admin/user/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId })
    });
    if (res.success) {
      showToast("ইউজার মুছে ফেলা হয়েছে", "info");
      await loadAllData();
    }
  } catch (err) {
    showToast("ত্রুটি: " + err.message, "error");
  }
}

function setUserFilter(type) {
  userFilter = type;
  ['all', 'premium', 'free', 'online'].forEach(f => {
    const btn = document.getElementById(`filterBtn-${f}`);
    if (btn) {
      if (f === type) {
        btn.className = "flex-1 sm:flex-none px-3 py-1.5 rounded-lg text-xs font-semibold bg-cyan-500/20 text-cyan-300 border border-cyan-500/40";
      } else {
        btn.className = "flex-1 sm:flex-none px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-white hover:bg-slate-800";
      }
    }
  });
  renderUsersTable();
}

function filterUsers() {
  renderUsersTable();
}

// Add User Modal
function openAddUserModal() {
  document.getElementById('addUserModal').classList.remove('hidden');
}
function closeAddUserModal() {
  document.getElementById('addUserModal').classList.add('hidden');
}

async function handleAddUser(e) {
  e.preventDefault();
  const deviceId = document.getElementById('newDeviceId').value.trim();
  const deviceName = document.getElementById('newDeviceName').value.trim();
  const status = document.getElementById('newStatus').value;
  const duration = Number(document.getElementById('newDuration').value);

  if (!deviceId) return;

  try {
    const res = await authFetch('/api/admin/user/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: deviceId,
        deviceName: deviceName || "Manual Added",
        isPremium: status === 'premium',
        durationDays: duration,
        plan: duration >= 3650 ? "Lifetime VIP" : `${duration} Days VIP`
      })
    });

    if (res.success) {
      showToast(res.message, "success");
      closeAddUserModal();
      document.getElementById('addUserForm').reset();
      await loadAllData();
    }
  } catch (err) {
    showToast("ত্রুটি: " + err.message, "error");
  }
}

// ===============================================
// 💳 PAYMENTS MANAGEMENT (APPROVE / REJECT)
// ===============================================

async function loadPayments() {
  try {
    const data = await authFetch('/api/admin/payments');
    if (data.success) {
      allPayments = data.payments || [];
      renderPaymentsTable(allPayments);
    }
  } catch (e) {}
}

function renderPaymentsTable(payments) {
  const tbody = document.getElementById('paymentsTableBody');
  if (!tbody) return;
  if (payments.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center py-10 text-slate-500">কোন পেমেন্ট রিকোয়েস্ট নেই</td></tr>`;
    return;
  }

  tbody.innerHTML = payments.map(p => {
    let statusBadge = '';
    if (p.status === 'pending') {
      statusBadge = `<span class="px-2 py-0.5 rounded-full text-xs font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40">পেন্ডিং ⏳</span>`;
    } else if (p.status === 'approved') {
      statusBadge = `<span class="px-2 py-0.5 rounded-full text-xs font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/40">অনুমোদিত ✅</span>`;
    } else {
      statusBadge = `<span class="px-2 py-0.5 rounded-full text-xs font-bold bg-rose-500/20 text-rose-400 border border-rose-500/40">বাতিল ❌</span>`;
    }

    return `
      <tr class="hover:bg-slate-800/40 transition">
        <td class="py-3 px-4">
          <div class="text-xs font-bold text-white mono">${p.id}</div>
          <div class="text-[11px] text-slate-500">${new Date(p.createdAt).toLocaleString('bn-BD')}</div>
        </td>
        <td class="py-3 px-4">
          <div class="text-xs font-semibold text-slate-200 mono">${p.deviceId}</div>
        </td>
        <td class="py-3 px-4">
          <div class="text-xs font-bold text-cyan-300">${p.method}</div>
          <div class="text-xs text-slate-400 mono">${p.senderPhone}</div>
        </td>
        <td class="py-3 px-4">
          <div class="text-xs font-bold text-amber-300 mono bg-slate-900 px-2 py-1 rounded border border-slate-700/60 inline-block">${p.trxId}</div>
        </td>
        <td class="py-3 px-4">
          <div class="text-xs font-bold text-emerald-400">৳${p.amount}</div>
          <div class="text-[11px] text-slate-400">${p.plan}</div>
        </td>
        <td class="py-3 px-4">${statusBadge}</td>
        <td class="py-3 px-4 text-right">
          ${p.status === 'pending' ? `
            <div class="flex items-center justify-end gap-2">
              <button onclick="updatePayment('${p.id}', 'approved')" 
                class="px-3 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs rounded-xl shadow transition">
                <i class="fa-solid fa-check mr-1"></i> অনুমোদন করুন
              </button>
              <button onclick="updatePayment('${p.id}', 'rejected')" 
                class="px-2.5 py-1.5 bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 text-xs rounded-xl border border-rose-500/30 transition">
                <i class="fa-solid fa-xmark"></i>
              </button>
            </div>
          ` : `
            <span class="text-xs text-slate-500">সম্পন্ন</span>
          `}
        </td>
      </tr>
    `;
  }).join('');
}

async function updatePayment(paymentId, status) {
  try {
    const res = await authFetch('/api/admin/payment/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentId, status })
    });
    if (res.success) {
      playChime(status === 'approved' ? 'vip' : 'default');
      showToast(res.message, status === 'approved' ? 'success' : 'info');
      await loadAllData();
    }
  } catch (err) {
    showToast("ত্রুটি: " + err.message, "error");
  }
}

// ===============================================
// 📢 REALTIME BROADCAST MODAL
// ===============================================

function openBroadcastModal() {
  document.getElementById('broadcastModal').classList.remove('hidden');
}
function closeBroadcastModal() {
  document.getElementById('broadcastModal').classList.add('hidden');
}

async function handleSendBroadcast(e) {
  e.preventDefault();
  const title = document.getElementById('broadcastTitle').value.trim();
  const message = document.getElementById('broadcastMsg').value.trim();

  try {
    const res = await authFetch('/api/admin/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, message })
    });
    if (res.success) {
      showToast("📢 বার্তা সমস্ত সক্রিয় অ্যাপে সাথে সাথে পাঠানো হয়েছে!", "success");
      closeBroadcastModal();
    }
  } catch (err) {
    showToast("ত্রুটি: " + err.message, "error");
  }
}

// CSV Export
function exportUsersCSV() {
  if (allUsers.length === 0) return showToast("কোন ইউজার ডাটা নেই", "info");
  const headers = ["Device ID", "Device Name", "Status", "Plan", "Expire At", "Created At"];
  const rows = allUsers.map(u => [
    u.deviceId,
    `"${(u.deviceName || '').replace(/"/g, '""')}"`,
    u.isPremium ? "PREMIUM" : "FREE",
    u.plan || "Free",
    u.expireAt ? new Date(u.expireAt).toISOString() : "Never",
    new Date(u.createdAt).toISOString()
  ]);
  const csvContent = "data:text/csv;charset=utf-8," + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `bitaim_users_${Date.now()}.csv`);
  document.body.appendChild(link);
  link.click();
  link.remove();
}

// ===============================================
// ⚙️ SETTINGS & APP CONFIG
// ===============================================

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    if (data.success && data.config) {
      const c = data.config;
      document.getElementById('cfgBkash').value = c.bkashNumber || '';
      document.getElementById('cfgNagad').value = c.nagadNumber || '';
      document.getElementById('cfgRocket').value = c.rocketNumber || '';
      document.getElementById('cfgUsdt').value = c.usdtAddress || '';
      document.getElementById('cfgAnnouncement').value = c.announcement || '';
      document.getElementById('overviewAnnouncement').textContent = c.announcement || 'কোন ঘোষণা নেই';
      document.getElementById('cfgFirebaseUrl').value = c.firebaseUrl || '';
    }
  } catch (e) {}
}

async function saveConfig(e) {
  e.preventDefault();
  try {
    const body = {
      bkashNumber: document.getElementById('cfgBkash').value.trim(),
      nagadNumber: document.getElementById('cfgNagad').value.trim(),
      rocketNumber: document.getElementById('cfgRocket').value.trim(),
      usdtAddress: document.getElementById('cfgUsdt').value.trim(),
      announcement: document.getElementById('cfgAnnouncement').value.trim()
    };

    const res = await authFetch('/api/admin/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (res.success) {
      showToast("সেটিংস সফলভাবে সেভ হয়েছে!", "success");
      loadConfig();
    }
  } catch (err) {
    showToast("ত্রুটি: " + err.message, "error");
  }
}

async function saveFirebaseConfig() {
  const url = document.getElementById('cfgFirebaseUrl').value.trim();
  try {
    const res = await authFetch('/api/admin/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firebaseUrl: url })
    });
    if (res.success) {
      showToast("ফায়ারবেজ লিঙ্ক সেভ হয়েছে!", "success");
    }
  } catch (err) {
    showToast("ত্রুটি: " + err.message, "error");
  }
}

window.addEventListener('DOMContentLoaded', () => {
  checkAuth();
});
