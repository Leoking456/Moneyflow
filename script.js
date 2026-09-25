const firebaseConfig = {
  apiKey: "AIzaSyD5R8s1isM1awXKbO0KY5azKt2A9yWLZ7Y",
  authDomain: "moneyflow-c2fae.firebaseapp.com",
  projectId: "moneyflow-c2fae",
  storageBucket: "moneyflow-c2fae.firebasestorage.app",
  messagingSenderId: "1045573253870",
  appId: "1:1045573253870:web:7fad0d864799e2b7b751ff"
};

let firebaseEnabled = false;
let db = null;
let currentUser = null;
let unsubscribeSnapshot = null;

try {
  if (firebaseConfig.apiKey !== "YOUR_API_KEY" && typeof firebase !== 'undefined') {
    firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
    firebaseEnabled = true;
  }
} catch (err) {
  console.error('Firebase init failed:', err);
}

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

const formatMoney = (n) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(n);

const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#39;', "'": '&#39;'
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
        tabs = parsed.tabs;
        activeTabId = parsed.activeTabId || tabs[0].id;
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
  if (firebaseEnabled && currentUser) {
    try {
      await db.collection('moneyflow').doc(currentUser.uid).set({
        tabs,
        activeTabId,
        updatedAt: Date.now()
      });
    } catch (err) {
      console.error('Cloud save failed:', err);
    }
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
            <span>${escapeHtml(currentUser.displayName || currentUser.email || 'Signed in')}</span>
            <button id="signOutBtn" class="del" title="Sign out"></button>
          </div>
        `;
    $('signOutBtn').onclick = () => firebase.auth().signOut();
  } else {
    el.innerHTML = `
          <button id="signInBtn" class="google-btn">Sign in with Google</button>
        `;
    $('signInBtn').onclick = () => {
      const provider = new firebase.auth.GoogleAuthProvider();
      firebase.auth().signInWithPopup(provider).catch((err) => {
        console.error('Sign-in failed:', err);
        showError('Sign-in failed: ' + err.message);
      });
    };
  }
}

if (firebaseEnabled) {
  firebase.auth().onAuthStateChanged(async (user) => {
    currentUser = user;
    renderAuthArea();

    if (unsubscribeSnapshot) {
      unsubscribeSnapshot();
      unsubscribeSnapshot = null;
    }

    if (user) {
      const ref = db.collection('moneyflow').doc(user.uid);
      const snap = await ref.get();
      const data = snap.exists ? snap.data() : null;

      if (data && Array.isArray(data.tabs) && data.tabs.length) {
        // Cloud already has tab-based data for this account — treat
        // it as the source of truth and mirror it into local storage.
        tabs = data.tabs;
        activeTabId = data.activeTabId || tabs[0].id;
        await saveLocalOnly();
      } else if (data && Array.isArray(data.transactions)) {
        // Old-format cloud doc from before tabs existed — migrate it.
        tabs = [{ id: newId(), name: 'General', transactions: data.transactions }];
        activeTabId = tabs[0].id;
        await ref.set({ tabs, activeTabId, updatedAt: Date.now() });
        await saveLocalOnly();
      } else {
        // First time this Google account has signed in here —
        // push whatever's currently on this device up to the cloud.
        await ref.set({ tabs, activeTabId, updatedAt: Date.now() });
      }

      // Keep listening so changes made from *other* signed-in
      // devices show up here automatically too.
      unsubscribeSnapshot = ref.onSnapshot((docSnap) => {
        if (docSnap.exists && Array.isArray(docSnap.data().tabs) && docSnap.data().tabs.length) {
          tabs = docSnap.data().tabs;
          if (!tabs.some((t) => t.id === activeTabId)) activeTabId = tabs[0].id;
          saveLocalOnly();
          renderTabs();
          render();
        }
      });

      renderTabs();
      render();
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

// Simulates the running balance through a list of transactions and
// reports whether it ever dips below £0.
function wouldGoNegative(list) {
  let balance = 0;
  for (const t of sortedByTime(list)) {
    balance += t.type === 'add' ? t.amount : -t.amount;
    if (balance < 0) return true;
  }
  return false;
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

  if (selectedType === 'spend' && wouldGoNegative([...tab.transactions, candidate])) {
    showError('That would take this tab\u2019s balance below £0. Reduce the amount or add money first.');
    return;
  }

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
  $('balance').className = 'balance ' + (balance > 0 ? 'green' : '');

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
  min = Math.max(0, min - pad);

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
loadData();
