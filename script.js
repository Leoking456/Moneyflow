// =====================================================================
// FIREBASE SETUP — paste YOUR OWN config here (see SETUP.md, step 6).
// Leave the "YOUR_..." placeholders and the app still works, but it
// only saves on this device (no Google sign-in / cloud sync).
// =====================================================================
const firebaseConfig = {
  apiKey: "AIzaSyCMsifis_E4o3gkAUypttOK6VsH7vkONig",
  authDomain: "moneychart-7ea74.firebaseapp.com",
  projectId: "moneychart-7ea74",
  storageBucket: "moneychart-7ea74.firebasestorage.app",
  messagingSenderId: "968402886264",
  appId: "1:968402886264:web:80afab2399e865bac2978d",
  measurementId: "G-Y405GRYZVT"
};

let firebaseEnabled = false;
let db = null;
let currentUser = null;
let unsubscribeSnapshot = null;

try {
  const configured = !String(firebaseConfig.apiKey).startsWith('YOUR_');
  if (configured && typeof firebase !== 'undefined') {
    firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
    firebaseEnabled = true;
  }
} catch (err) {
  console.error('Firebase init failed:', err);
}

// ---------------------------------------------------------------
// Sync status badge (top bar). Click it for the full detail.
// ---------------------------------------------------------------
let lastSyncDetail = '';

function setSync(state, text, detail) {
  const el = document.getElementById('syncStatus');
  if (!el) return;
  el.className = 'syncbadge ' + state;
  el.textContent = text;
  lastSyncDetail = detail || text;
  el.title = lastSyncDetail;
}

function describeFirebaseError(err) {
  const code = (err && (err.code || '')) + '';
  const msg = (err && err.message) || String(err);
  const map = {
    'permission-denied': ['Sync blocked (rules)', 'Firestore refused the write. Open Firebase console → Firestore Database → Rules and publish the rules from SETUP.md (step 5).'],
    'not-found': ['No Firestore database', 'Firestore database not found. Create it in Firebase console → Firestore Database → Create database (SETUP.md step 4).'],
    'unavailable': ['Offline — will retry', 'Could not reach Google right now. Changes are saved on this device and will sync when you are back online.'],
    'auth/unauthorized-domain': ['Domain not authorised', 'This website address is not authorised for sign-in. Add it in Firebase console → Authentication → Settings → Authorized domains (SETUP.md step 3).'],
    'auth/operation-not-allowed': ['Google sign-in is off', 'Enable Google in Firebase console → Authentication → Sign-in method (SETUP.md step 2).'],
    'auth/invalid-api-key': ['Bad API key', 'The apiKey in script.js is wrong. Re-copy firebaseConfig from Project settings (SETUP.md step 6).'],
    'auth/api-key-not-valid': ['Bad API key', 'The apiKey in script.js is wrong. Re-copy firebaseConfig from Project settings (SETUP.md step 6).'],
    'auth/network-request-failed': ['Network error', 'Network request failed. Check your connection and try again.']
  };
  const hit = map[code] || map[code.replace('firestore/', '')];
  return hit
    ? { short: hit[0], detail: hit[1] + (code ? ` (${code})` : '') }
    : { short: 'Sync error', detail: msg + (code ? ` (${code})` : '') };
}

function reportSyncError(err) {
  console.error('Sync error:', err);
  const d = describeFirebaseError(err);
  setSync('err', d.short, d.detail);
}

window.addEventListener('offline', () => {
  if (firebaseEnabled && currentUser) setSync('err', 'Offline — saved locally', 'You are offline. Changes are saved on this device and will sync when you reconnect.');
});
window.addEventListener('online', () => {
  if (firebaseEnabled && currentUser) saveData();
});

// ---------------------------------------------------------------
// gbp to lkr conversion
// ---------------------------------------------------------------

let gbpToLkr = null;
const $balance = document.getElementById("balance");
const $lkr = document.getElementById("lkrBalance");

async function updateExchangeRate() {
  try {
    const { rate } = await (await fetch("https://api.frankfurter.dev/v2/rate/gbp/lkr")).json();
    gbpToLkr = rate;
    updateLKR();
  } catch {
    $lkr.textContent = "LKR rate unavailable";
  }
}

function updateLKR() {
  if (!gbpToLkr) return;
  const gbp = parseFloat($balance.textContent.replace(/[£,]/g, "")) || 0;
  $lkr.textContent = `≈ Rs ${(gbp * gbpToLkr).toLocaleString("en-LK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (ECB daily rate)`;
}

updateExchangeRate();
setInterval(updateExchangeRate, 6 * 60 * 60 * 1000); // refetch every 6h — the source only changes once/day anyway
new MutationObserver(updateLKR).observe($balance, { childList: true, characterData: true, subtree: true });

// ---------------------------------------------------------------
// State + storage
// ---------------------------------------------------------------
const STORAGE_KEY = 'moneyflow_tabs_v2';
const OLD_STORAGE_KEY = 'moneyflow_transactions'; // pre-tabs format, used for one-time migration

// tabs: [{ id, name, transactions: [{ id, createdAt, type:'add'|'spend', amount, desc, date|null }] }]
let tabs = [];
let activeTabId = null;
let selectedType = 'add';

const $ = (id) => document.getElementById(id);

const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Guards against corrupted/legacy tab data (from Firestore, old
// localStorage, or a stale client) ever reaching render(): strips
// malformed entries, backfills missing fields, and coerces every id
// to a string so old numeric/legacy ids still compare correctly
// against activeTabId. Always returns at least one valid tab.
function sanitizeTabs(rawTabs, rawActiveId) {
  const cleaned = (Array.isArray(rawTabs) ? rawTabs : [])
    .filter((t) => t && typeof t === 'object')
    .map((t) => ({
      id: String(t.id ?? newId()),
      name: (typeof t.name === 'string' && t.name.trim()) ? t.name : 'General',
      transactions: Array.isArray(t.transactions) ? t.transactions : []
    }));

  if (!cleaned.length) {
    cleaned.push({ id: newId(), name: 'General', transactions: [] });
  }

  const droppedCount = (Array.isArray(rawTabs) ? rawTabs.length : 0) - cleaned.length;
  if (droppedCount > 0) {
    console.warn(`sanitizeTabs: dropped ${droppedCount} malformed tab entrie(s).`);
  }

  const wantedActiveId = String(rawActiveId ?? '');
  const activeTabId = cleaned.some((t) => t.id === wantedActiveId)
    ? wantedActiveId
    : cleaned[0].id;

  return { tabs: cleaned, activeTabId };
}

const formatMoney = (n) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(n);

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

function currentTab() {
  return tabs.find((t) => t.id === activeTabId) || tabs[0];
}

// Thin wrapper around localStorage so the rest of the app doesn't
// care about the underlying API, and a bad/blocked storage access
// (private browsing, storage disabled, etc.) never crashes the page.
function storageGet(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : { value: raw };
  } catch (err) {
    console.error('Storage read failed:', err);
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    console.error('Storage write failed:', err);
    return false;
  }
}

async function loadData() {
  try {
    const result = storageGet(STORAGE_KEY);
    if (result && result.value) {
      const parsed = JSON.parse(result.value);
      if (Array.isArray(parsed.tabs) && parsed.tabs.length) {
        ({ tabs, activeTabId } = sanitizeTabs(parsed.tabs, parsed.activeTabId));
      }
    }
  } catch (err) {
    tabs = [];
  }

  if (!tabs.length) {
    // One-time migration from the old single-list storage format.
    let migrated = [];
    try {
      const old = storageGet(OLD_STORAGE_KEY);
      if (old && old.value) migrated = JSON.parse(old.value) || [];
    } catch (err) {
      migrated = [];
    }
    tabs = [{ id: newId(), name: 'General', transactions: migrated }];
    activeTabId = tabs[0].id;
    await saveLocalOnly();
  }

  renderAuthArea();
  renderTabs();
  render();
  if (!firebaseEnabled) {
    setSync('local', 'This device only', 'Cloud sync is not set up. Data is saved on this device only. See SETUP.md to enable Google sync.');
  } else if (!currentUser) {
    setSync('local', 'This device only', 'Not signed in. Sign in with Google to save to your account and sync devices.');
  }
}

// Saves to this device only (local browser storage). Always runs,
// signed in or not — this is the "automatic save to device" part.
async function saveLocalOnly() {
  storageSet(STORAGE_KEY, JSON.stringify({ tabs, activeTabId }));
}

// Saves locally, and — if signed in — also pushes to the user's
// Google account (Firestore), so other signed-in devices pick it up.
async function saveData() {
  await saveLocalOnly();
  if (!(firebaseEnabled && currentUser)) return;
  setSync('syncing', 'Syncing…');
  try {
    await db.collection('moneyflow').doc(currentUser.uid).set({
      tabs,
      activeTabId,
      updatedAt: Date.now()
    });
    setSync('ok', 'Synced to Google', 'Saved to your Google account at ' + new Date().toLocaleTimeString());
  } catch (err) {
    reportSyncError(err);
  }
}

// ---------------------------------------------------------------
// Google sign-in
// ---------------------------------------------------------------
function renderAuthArea() {
  const el = $('authArea');
  if (!el) return;

  if (!firebaseEnabled) {
    el.innerHTML = '<span class="sync-status">Cloud sync not set up yet</span>';
    return;
  }

  if (currentUser) {
    el.innerHTML = `
          <div class="user-chip">
            ${currentUser.photoURL ? `<img src="${currentUser.photoURL}" alt="">` : ''}
            <span class="user-name">${escapeHtml(currentUser.displayName || currentUser.email || 'Signed in')}</span>
            <button id="signOutBtn" class="del" title="Sign out">×</button>
          </div>
        `;
    $('signOutBtn').onclick = () => firebase.auth().signOut();
  } else {
    el.innerHTML = `
          <button id="signInBtn" class="google-btn">Sign in with Google</button>
        `;
    $('signInBtn').onclick = async () => {
      if (location.protocol === 'file:') {
        alert('Google sign-in cannot run from a local file.\n\nHost the folder (Netlify / GitHub Pages / Firebase Hosting) or run a local server, e.g.\n  python -m http.server 8000\nthen open http://localhost:8000');
        return;
      }
      const provider = new firebase.auth.GoogleAuthProvider();
      try {
        await firebase.auth().signInWithPopup(provider);
      } catch (err) {
        if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') return;
        if (err.code === 'auth/popup-blocked' || err.code === 'auth/operation-not-supported-in-this-environment') {
          firebase.auth().signInWithRedirect(provider);
          return;
        }
        reportSyncError(err);
        alert('Sign-in failed: ' + describeFirebaseError(err).detail);
      }
    };
  }
}

if (firebaseEnabled) {
  // Picks up errors from the redirect sign-in flow (used when popups are blocked).
  firebase.auth().getRedirectResult().catch((err) => reportSyncError(err));

  firebase.auth().onAuthStateChanged(async (user) => {
    currentUser = user;
    renderAuthArea();

    if (unsubscribeSnapshot) {
      unsubscribeSnapshot();
      unsubscribeSnapshot = null;
    }

    if (!user) {
      setSync('local', 'This device only', 'Not signed in. Sign in with Google to save to your account and sync devices.');
      return;
    }

    setSync('syncing', 'Connecting…');
    try {
      const ref = db.collection('moneyflow').doc(user.uid);
      const snap = await ref.get();
      const data = snap.exists ? snap.data() : null;

      if (data && Array.isArray(data.tabs) && data.tabs.length) {
        // Cloud already has data for this account — it is the source of truth.
        ({ tabs, activeTabId } = sanitizeTabs(data.tabs, data.activeTabId));
        await saveLocalOnly();
      } else if (data && Array.isArray(data.transactions)) {
        // Old single-list cloud doc from before tabs existed — migrate it.
        tabs = [{ id: newId(), name: 'General', transactions: data.transactions }];
        activeTabId = tabs[0].id;
        await ref.set({ tabs, activeTabId, updatedAt: Date.now() });
        await saveLocalOnly();
      } else {
        // First time this account signs in — upload what is on this device.
        await ref.set({ tabs, activeTabId, updatedAt: Date.now() });
      }

      // Live updates from your other signed-in devices.
      unsubscribeSnapshot = ref.onSnapshot((docSnap) => {
        if (docSnap.metadata.hasPendingWrites) return; // our own in-flight write
        const d = docSnap.exists ? docSnap.data() : null;
        if (d && Array.isArray(d.tabs) && d.tabs.length) {
          ({ tabs, activeTabId } = sanitizeTabs(d.tabs, d.activeTabId));
          saveLocalOnly();
          renderTabs();
          render();
        }
      }, (err) => reportSyncError(err));

      renderTabs();
      render();
      setSync('ok', 'Synced to Google', 'Connected. Saved to your Google account at ' + new Date().toLocaleTimeString());
    } catch (err) {
      reportSyncError(err);
    }
  });
}

// ---------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------
function renderTabs() {
  const el = $('tabbar');
  if (!el) return;

  el.innerHTML = tabs.map((t) => `
        <div class="tab ${t.id === activeTabId ? 'active' : ''}" data-id="${t.id}" title="Double-click to rename">
          <span class="tab-name">${escapeHtml(t.name)}</span>
          ${tabs.length > 1 ? `<button class="tab-close" data-id="${t.id}" title="Delete tab">×</button>` : ''}
        </div>
      `).join('') + '<button class="tab-add" id="addTab" title="New tab">＋ New tab</button>';

  el.querySelectorAll('.tab').forEach((tabEl) => {
    tabEl.addEventListener('click', (e) => {
      if (e.target.classList.contains('tab-close')) return;
      switchTab(tabEl.dataset.id);
    });
    tabEl.addEventListener('dblclick', (e) => {
      if (e.target.classList.contains('tab-close')) return;
      renameTab(tabEl.dataset.id);
    });
  });
  el.querySelectorAll('.tab-close').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteTab(btn.dataset.id);
    });
  });
  $('addTab').onclick = addTab;
}

function switchTab(id) {
  if (id === activeTabId) return;
  activeTabId = id;
  saveData();
  renderTabs();
  hideError();
  render();
}

function addTab() {
  const name = prompt('Name this tab (e.g. "Freelance", "Savings"):', '');
  if (name === null) return;
  const clean = name.trim().slice(0, 30);
  if (!clean) return;
  const tab = { id: newId(), name: clean, transactions: [] };
  tabs.push(tab);
  activeTabId = tab.id;
  saveData();
  renderTabs();
  render();
}

function renameTab(id) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  const name = prompt('Rename tab:', tab.name);
  if (name === null) return;
  const clean = name.trim().slice(0, 30);
  if (!clean) return;
  tab.name = clean;
  saveData();
  renderTabs();
  render();
}

function deleteTab(id) {
  if (tabs.length <= 1) return;
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  if (!confirm(`Delete "${tab.name}" and all ${tab.transactions.length} of its transactions? This can't be undone.`)) return;
  tabs = tabs.filter((t) => t.id !== id);
  if (activeTabId === id) activeTabId = tabs[0].id;
  saveData();
  renderTabs();
  render();
}

// ---------------------------------------------------------------
// History modal open/close
// ---------------------------------------------------------------
function openHistory() {
  $('modalBackdrop').classList.add('open');
}

function closeHistory() {
  $('modalBackdrop').classList.remove('open');
}

$('openHistory').onclick = openHistory;
$('closeHistory').onclick = closeHistory;
$('modalBackdrop').onclick = (e) => {
  if (e.target === $('modalBackdrop')) closeHistory();
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('modalBackdrop').classList.contains('open')) closeHistory();
});

// ---------------------------------------------------------------
// Form: add / spend toggle + validation
// ---------------------------------------------------------------
function setType(type) {
  selectedType = type;

  document.querySelectorAll('.types button').forEach((b) => b.classList.remove('active'));
  document.querySelector('.types .' + type).classList.add('active');

  const submitBtn = $('submit');
  submitBtn.className = 'submit ' + (type === 'spend' ? 'spend' : '');
  submitBtn.textContent = type === 'add' ? '＋ Add money' : '− Spend money';

  hideError();
}

document.querySelectorAll('.types button').forEach((b) => {
  b.onclick = () => setType(b.dataset.type);
});

function showError(message) {
  $('error').textContent = message;
  $('error').classList.add('show');
}

function hideError() {
  $('error').textContent = '';
  $('error').classList.remove('show');
}

// A transaction's position in time: its chosen date, or the moment
// it was created if no date was given (so undated entries still
// slot in chronologically rather than always landing at the end).
function sortKey(t) {
  return t.date ? new Date(t.date + 'T12:00:00').getTime() : t.createdAt;
}

function sortedByTime(list) {
  return [...list].sort((a, b) => sortKey(a) - sortKey(b) || a.createdAt - b.createdAt);
}

$('submit').onclick = () => {
  hideError();

  let amount = Number($('amount').value);
  if (!amount || amount <= 0) {
    showError('Enter an amount greater than £0.');
    return;
  }
  amount = Math.round(amount * 100) / 100;

  const candidate = {
    id: newId(),
    createdAt: Date.now(),
    type: selectedType,
    amount,
    desc: $('desc').value.trim() || (selectedType === 'add' ? 'Money added' : 'Money spent'),
    date: $('txdate').value || null
  };

  const tab = currentTab();

  tab.transactions.push(candidate);
  saveData();

  $('amount').value = '';
  $('desc').value = '';
  $('txdate').value = '';
  render();
};

$('reset').onclick = () => {
  const tab = currentTab();
  if (tab.transactions.length && confirm(`Delete all transactions in "${tab.name}"?`)) {
    tab.transactions = [];
    saveData();
    render();
  }
};

function deleteTransaction(id) {
  const tab = currentTab();
  tab.transactions = tab.transactions.filter((t) => String(t.id) !== String(id));
  saveData();
  render();
}
window.deleteTransaction = deleteTransaction;

// ---------------------------------------------------------------
// Derived data
// ---------------------------------------------------------------

// Chronological list of the active tab's transactions, each
// annotated with the running balance ("b") at that point.
function balancePoints() {
  let balance = 0;
  return sortedByTime(currentTab().transactions).map((t) => {
    balance += t.type === 'add' ? t.amount : -t.amount;
    return { ...t, b: balance };
  });
}

function dateLabelHtml(date) {
  return date
    ? new Date(date + 'T12:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    : '<span class="dot" title="No date given"></span>';
}

function axisLabel(t) {
  return t.date
    ? new Date(t.date + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    : '•';
}

// ---------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------
function render() {
  const tab = currentTab();
  const points = balancePoints();
  const balance = points.length ? points[points.length - 1].b : 0;

  if ($('balanceLabel')) $('balanceLabel').textContent = `Current balance — ${tab.name}`;

  $('balance').textContent = formatMoney(balance);
  $('balance').className = 'balance ' + (balance > 0 ? 'green' : balance < 0 ? 'red' : '');

  $('status').textContent = tab.transactions.length
    ? `${tab.transactions.length} transaction${tab.transactions.length === 1 ? '' : 's'} recorded`
    : 'No transactions yet';

  $('range').textContent = points.length
    ? `${points[0].date ? dateLabelHtml(points[0].date).replace(/<[^>]+>/g, '•') : '•'} → ` +
    `${points[points.length - 1].date ? dateLabelHtml(points[points.length - 1].date).replace(/<[^>]+>/g, '•') : '•'}`
    : 'Waiting for transactions';

  $('openHistory').textContent = tab.transactions.length
    ? `☰ Transaction history (${tab.transactions.length})`
    : '☰ Transaction history';

  renderHistory();
  drawChart(points);
}

function renderHistory() {
  const rows = sortedByTime(currentTab().transactions).slice().reverse();
  const el = $('history');
  el.className = 'history';

  if (!rows.length) {
    el.innerHTML = '<div class="empty">No transactions yet.</div>';
    return;
  }

  el.innerHTML = rows.map((t) => `
        <div class="tx">
          <div class="icon ${t.type === 'add' ? 'green' : 'red'}">${t.type === 'add' ? '↑' : '↓'}</div>
          <div>
            <b>${escapeHtml(t.desc)}</b>
            <div class="muted">${dateLabelHtml(t.date)}</div>
          </div>
          <div class="amount ${t.type === 'add' ? 'green' : 'red'}">${t.type === 'add' ? '+' : '−'}${formatMoney(t.amount)}</div>
          <button class="del" onclick="deleteTransaction('${t.id}')">×</button>
        </div>
      `).join('');
}

// ---------------------------------------------------------------
// Chart
// ---------------------------------------------------------------
function drawChart(points) {
  const canvas = $('graph');
  const rect = canvas.getBoundingClientRect();
  const dpr = devicePixelRatio || 1;

  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const w = rect.width, h = rect.height;
  ctx.clearRect(0, 0, w, h);

  // plot area margins
  const L = 55, R = 15, T = 18, B = 32;
  const plotW = w - L - R, plotH = h - T - B;

  // y-axis range (always includes £0, padded a bit)
  const values = points.length ? points.map((p) => p.b) : [0];
  let min = Math.min(0, ...values);
  let max = Math.max(0, ...values);
  if (min === max) max += 10;
  const pad = (max - min) * .12;
  max += pad;
  min = min - pad;

  const xAt = (i) => L + (points.length <= 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const yAt = (v) => T + ((max - v) / (max - min)) * plotH;

  // gridlines + y-axis value labels — drawn even with no data
  ctx.font = '11px system-ui';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < 5; i++) {
    const v = min + (max - min) * i / 4;
    const y = yAt(v);
    ctx.strokeStyle = 'rgba(130,145,164,.13)';
    ctx.beginPath();
    ctx.moveTo(L, y);
    ctx.lineTo(w - R, y);
    ctx.stroke();
    ctx.fillStyle = '#718096';
    ctx.fillText(formatMoney(v), L - 8, y);
  }

  // baseline (£0 line) and y-axis — always drawn so the chart is never blank
  ctx.strokeStyle = 'rgba(130,145,164,.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(L, yAt(0));
  ctx.lineTo(w - R, yAt(0));
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(L, T);
  ctx.lineTo(L, h - B);
  ctx.stroke();

  if (!points.length) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#8190a3';
    ctx.fillText('Add a transaction to see your balance here', (L + w - R) / 2, T + plotH / 2);
    return;
  }

  // balance line
  for (let i = 1; i < points.length; i++) {
    ctx.strokeStyle = points[i].b >= points[i - 1].b ? '#20d879' : '#ff4d67';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(xAt(i - 1), yAt(points[i - 1].b));
    ctx.lineTo(xAt(i), yAt(points[i].b));
    ctx.stroke();
  }

  // point markers
  points.forEach((p, i) => {
    ctx.fillStyle = '#070b12';
    ctx.beginPath();
    ctx.arc(xAt(i), yAt(p.b), 5, 0, 7);
    ctx.fill();

    ctx.fillStyle = (i && p.b < points[i - 1].b) ? '#ff4d67' : '#20d879';
    ctx.beginPath();
    ctx.arc(xAt(i), yAt(p.b), 3, 0, 7);
    ctx.fill();
  });

  // x-axis date labels (thinned to a handful of ticks)
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#718096';
  const tickCount = Math.min(6, points.length);
  for (let j = 0; j < tickCount; j++) {
    const i = Math.round(j * (points.length - 1) / Math.max(1, tickCount - 1));
    ctx.fillText(axisLabel(points[i]), xAt(i), h - 21);
  }
}

window.onresize = () => drawChart(balancePoints());

// ---------------------------------------------------------------
// Export / import transaction history as a .txt file
//
// File format (human-readable, hand-editable):
//
//   # MoneyFlow export v1
//   [TAB] General
//   add | 2026-11-01 | 25.00 | Birthday money
//   spend | none | 3.50 | Coffee
//
//   - one "[TAB] name" line starts each tab
//   - each transaction: type | date | amount | description
//   - type is "add" or "spend"; date is YYYY-MM-DD or "none"
//   - lines starting with # and blank lines are ignored
// ---------------------------------------------------------------
const EXPORT_HEADER = 'MoneyFlow export v1';
let importMode = 'merge';

const oneLine = (s) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim();

function buildExportText() {
  const lines = [
    '# ' + EXPORT_HEADER,
    '# Exported: ' + new Date().toISOString(),
    '# Format: type | date (YYYY-MM-DD or none) | amount (GBP) | description',
    '# type is "add" or "spend". Lines starting with # are ignored.',
    ''
  ];
  tabs.forEach((tab) => {
    lines.push('[TAB] ' + (oneLine(tab.name) || 'General'));
    sortedByTime(tab.transactions).forEach((t) => {
      lines.push([
        t.type === 'spend' ? 'spend' : 'add',
        t.date || 'none',
        (Math.round(Number(t.amount) * 100) / 100).toFixed(2),
        oneLine(t.desc)
      ].join(' | '));
    });
    lines.push('');
  });
  return lines.join('\r\n');
}

function ioMessage(text, kind) {
  const el = $('ioMsg');
  el.textContent = text;
  el.className = 'io-msg' + (text ? ' show ' + (kind || '') : '');
}

function exportToTxt() {
  const total = tabs.reduce((n, t) => n + t.transactions.length, 0);
  const blob = new Blob([buildExportText()], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `moneyflow-${new Date().toISOString().slice(0, 10)}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  ioMessage(`Exported ${total} transaction${total === 1 ? '' : 's'} from ${tabs.length} tab${tabs.length === 1 ? '' : 's'}.`, 'ok');
}

function validDate(str) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(str + 'T12:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === str;
}

function parseExportText(text) {
  const result = { tabs: [], errors: [], count: 0 };
  let cur = null;

  text.replace(/^\uFEFF/, '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;

    const tabMatch = line.match(/^\[TAB\]\s*(.*)$/i);
    if (tabMatch) {
      cur = { name: tabMatch[1].trim().slice(0, 30) || 'General', transactions: [] };
      result.tabs.push(cur);
      return;
    }

    const parts = line.split('|');
    if (parts.length < 3) {
      result.errors.push(`Line ${i + 1}: expected "type | date | amount | description"`);
      return;
    }

    const type = parts[0].trim().toLowerCase();
    const dateRaw = parts[1].trim().toLowerCase();
    const amount = Math.round(Number(parts[2].trim().replace(/[£,]/g, '')) * 100) / 100;
    const desc = parts.slice(3).join('|').trim().slice(0, 60);

    if (type !== 'add' && type !== 'spend') {
      result.errors.push(`Line ${i + 1}: type must be "add" or "spend"`);
      return;
    }
    let date = null;
    if (dateRaw && dateRaw !== 'none' && dateRaw !== '-') {
      if (!validDate(dateRaw)) {
        result.errors.push(`Line ${i + 1}: date must be YYYY-MM-DD or "none"`);
        return;
      }
      date = dateRaw;
    }
    if (!isFinite(amount) || amount <= 0) {
      result.errors.push(`Line ${i + 1}: amount must be a number above 0`);
      return;
    }

    if (!cur) {
      cur = { name: 'Imported', transactions: [] };
      result.tabs.push(cur);
    }
    cur.transactions.push({
      type, date, amount,
      desc: desc || (type === 'add' ? 'Money added' : 'Money spent')
    });
    result.count++;
  });

  return result;
}

// Gives each imported transaction a createdAt that keeps the file's
// order (matters for undated entries, which are placed by createdAt).
function assignCreatedAt(list) {
  const base = Date.now();
  const keys = list.map((t) => (t.date ? new Date(t.date + 'T12:00:00').getTime() : null));
  let prev = null;
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] !== null) prev = keys[i];
    else if (prev !== null) keys[i] = prev;
  }
  let next = null;
  for (let i = keys.length - 1; i >= 0; i--) {
    if (keys[i] !== null) next = keys[i];
    else if (next !== null) keys[i] = next - 1;
    else keys[i] = base;
  }
  return keys;
}

const txSignature = (t) => `${t.type}|${t.date || ''}|${(Math.round(Number(t.amount) * 100) / 100).toFixed(2)}|${t.desc}`;

function applyImport(parsed, mode) {
  if (mode === 'replace') tabs = [];

  let added = 0, skipped = 0;
  const seen = new Map(); // tab id -> Map(signature -> count) of what existed BEFORE the import

  parsed.tabs.forEach((pt) => {
    let tab = tabs.find((t) => t.name.toLowerCase() === pt.name.toLowerCase());
    if (!tab) {
      tab = { id: newId(), name: pt.name, transactions: [] };
      tabs.push(tab);
    }
    if (!seen.has(tab.id)) {
      const counts = new Map();
      tab.transactions.forEach((t) => counts.set(txSignature(t), (counts.get(txSignature(t)) || 0) + 1));
      seen.set(tab.id, counts);
    }
    const existing = seen.get(tab.id);
    const keys = assignCreatedAt(pt.transactions);

    pt.transactions.forEach((t, i) => {
      const sig = txSignature(t);
      if (existing.get(sig) > 0) { // already in this tab — skip the duplicate
        existing.set(sig, existing.get(sig) - 1);
        skipped++;
        return;
      }
      tab.transactions.push({
        id: newId(),
        createdAt: keys[i],
        type: t.type,
        amount: t.amount,
        desc: t.desc,
        date: t.date
      });
      added++;
    });
  });

  if (!tabs.length) tabs = [{ id: newId(), name: 'General', transactions: [] }];
  if (mode === 'replace' || !tabs.some((t) => t.id === activeTabId)) activeTabId = tabs[0].id;

  saveData();
  renderTabs();
  render();
  return { added, skipped };
}

async function handleImportFile(file) {
  ioMessage('');
  if (!file) return;
  let text;
  try {
    text = await file.text();
  } catch (err) {
    ioMessage('Could not read that file.', 'err');
    return;
  }

  const parsed = parseExportText(text);
  if (!parsed.count) {
    ioMessage(
      'No valid transactions found. Expected lines like "add | 2026-11-01 | 25.00 | Birthday money".' +
      (parsed.errors.length ? ' First problem: ' + parsed.errors[0] : ''),
      'err'
    );
    return;
  }

  const summary = `${parsed.count} transaction${parsed.count === 1 ? '' : 's'} in ${parsed.tabs.length} tab${parsed.tabs.length === 1 ? '' : 's'}`;
  const ok = importMode === 'replace'
    ? confirm(`Replace ALL your current tabs and transactions with the ${summary} from "${file.name}"?\n\nThis can't be undone.`)
    : confirm(`Add the ${summary} from "${file.name}" to your existing data?\n\nExact duplicates already in a tab are skipped.`);
  if (!ok) return;

  const { added, skipped } = applyImport(parsed, importMode);
  let msg = `Imported ${added} transaction${added === 1 ? '' : 's'}`;
  if (skipped) msg += `, skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}`;
  if (parsed.errors.length) msg += `. ${parsed.errors.length} line${parsed.errors.length === 1 ? '' : 's'} ignored (${parsed.errors[0]}${parsed.errors.length > 1 ? ', …' : ''})`;
  ioMessage(msg + '.', parsed.errors.length ? 'warn' : 'ok');
}

$('exportBtn').onclick = exportToTxt;
$('importMergeBtn').onclick = () => { importMode = 'merge'; $('importFile').click(); };
$('importReplaceBtn').onclick = () => { importMode = 'replace'; $('importFile').click(); };
$('importFile').onchange = async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // lets you pick the same file again later
  await handleImportFile(file);
};
$('syncStatus').onclick = () => { if (lastSyncDetail) alert(lastSyncDetail); };

// ---------------------------------------------------------------
loadData();
