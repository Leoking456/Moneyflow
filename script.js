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
const STORAGE_KEY = 'moneyflow_transactions';

let transactions = [];   // { id, createdAt, type: 'add'|'spend', amount, desc, date|null }
let selectedType = 'add';

const $ = (id) => document.getElementById(id);

const formatMoney = (n) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(n);

const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

async function loadTransactions() {
  try {
    const result = await window.storage.get(STORAGE_KEY, false);
    transactions = result && result.value ? JSON.parse(result.value) : [];
  } catch (err) {
    transactions = [];
  }
  renderAuthArea();
  render();
}

// Saves to this device only (local browser storage). Always runs,
// signed in or not — this is the "automatic save to device" part.
async function saveLocalOnly() {
  try {
    await window.storage.set(STORAGE_KEY, JSON.stringify(transactions), false);
  } catch (err) {
    console.error('Storage error:', err);
  }
}

// Saves locally, and — if signed in — also pushes to the user's
// Google account (Firestore), so other signed-in devices pick it up.
async function saveTransactions() {
  await saveLocalOnly();
  if (firebaseEnabled && currentUser) {
    try {
      await db.collection('moneyflow').doc(currentUser.uid).set({
        transactions,
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

      if (snap.exists && Array.isArray(snap.data().transactions)) {
        // Cloud already has data for this account — treat it as
        // the source of truth and mirror it into local storage.
        transactions = snap.data().transactions;
        await saveLocalOnly();
      } else {
        // First time this Google account has signed in here —
        // push whatever's currently on this device up to the cloud.
        await ref.set({ transactions, updatedAt: Date.now() });
      }

      // Keep listening so changes made from *other* signed-in
      // devices show up here automatically too.
      unsubscribeSnapshot = ref.onSnapshot((docSnap) => {
        if (docSnap.exists && Array.isArray(docSnap.data().transactions)) {
          transactions = docSnap.data().transactions;
          saveLocalOnly();
          render();
        }
      });

      render();
    }
  });
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
    id: Date.now() + Math.random(),
    createdAt: Date.now(),
    type: selectedType,
    amount,
    desc: $('desc').value.trim() || (selectedType === 'add' ? 'Money added' : 'Money spent'),
    date: $('txdate').value || null
  };

  if (selectedType === 'spend' && wouldGoNegative([...transactions, candidate])) {
    showError('That would take your balance below £0. Reduce the amount or add money first.');
    return;
  }

  transactions.push(candidate);
  saveTransactions();

  $('amount').value = '';
  $('desc').value = '';
  $('txdate').value = '';
  render();
};

$('reset').onclick = () => {
  if (transactions.length && confirm('Delete all transactions?')) {
    transactions = [];
    saveTransactions();
    render();
  }
};

function deleteTransaction(id) {
  transactions = transactions.filter((t) => t.id !== id);
  saveTransactions();
  render();
}
window.deleteTransaction = deleteTransaction;

// ---------------------------------------------------------------
// Derived data
// ---------------------------------------------------------------

// Chronological list of transactions, each annotated with the
// running balance ("b") at that point.
function balancePoints() {
  let balance = 0;
  return sortedByTime(transactions).map((t) => {
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
  const points = balancePoints();
  const balance = points.length ? points[points.length - 1].b : 0;

  $('balance').textContent = formatMoney(balance);
  $('balance').className = 'balance ' + (balance > 0 ? 'green' : '');

  $('status').textContent = transactions.length
    ? `${transactions.length} transaction${transactions.length === 1 ? '' : 's'} recorded`
    : 'No transactions yet';

  $('range').textContent = points.length
    ? `${points[0].date ? dateLabelHtml(points[0].date).replace(/<[^>]+>/g, '•') : '•'} → ` +
    `${points[points.length - 1].date ? dateLabelHtml(points[points.length - 1].date).replace(/<[^>]+>/g, '•') : '•'}`
    : 'Waiting for transactions';

  $('openHistory').textContent = transactions.length
    ? `☰ Transaction history (${transactions.length})`
    : '☰ Transaction history';

  renderHistory();
  drawChart(points);
}

function renderHistory() {
  const rows = sortedByTime(transactions).slice().reverse();
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
          <button class="del" onclick="deleteTransaction(${t.id})">×</button>
        </div>
      `).join('');
}

// ---------------------------------------------------------------
// Chart (base implementation — replaced below by the multi-section
// chart code, which reassigns window.drawChart once it loads)
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
loadTransactions();

// ---------------------------------------------------------------
// Charts (multi-section balance view)
//
// This section replaces the drawChart() defined above, and lets
// the user split their balance history into named sections — each
// is a tab with a name the user picks; the chart underneath is the
// same balance-over-time view every time.
//
// Uses transactions, balancePoints() and escapeHtml() from above.
// ---------------------------------------------------------------

const CHARTS_KEY = 'moneyflow_charts';

// Every section shows the same balance-over-time chart — this just
// holds the default name and the message shown with no transactions.
const DEFAULT_CHART_NAME = 'Balance over time';
const EMPTY_MESSAGE = 'Add a transaction to see your balance here';

let charts = [];        // { id, name }
let activeChartId = null;

const GREEN = '#20d879';
const RED = '#ff4d67';
const GRID = 'rgba(130,145,164,.13)';
const AXIS = 'rgba(130,145,164,.35)';
const TEXT = '#718096';

// Short money label for axes: £1,250 rather than £1,250.00
const shortMoney = (n) =>
  (n < 0 ? '-£' : '£') + Math.round(Math.abs(n)).toLocaleString('en-GB');

const activeChart = () => charts.find((c) => c.id === activeChartId) || charts[0];

// ---------------------------------------------------------------
// Saving the user's chart sections
//
// Kept on this device. window.storage is used if it exists (so this
// matches the transaction storage above), otherwise plain browser
// localStorage.
// ---------------------------------------------------------------
async function readStore(key) {
  if (window.storage) {
    const result = await window.storage.get(key, false);
    return result && result.value ? result.value : null;
  }
  return localStorage.getItem(key);
}

async function writeStore(key, value) {
  if (window.storage) return window.storage.set(key, value, false);
  localStorage.setItem(key, value);
}

async function loadCharts() {
  try {
    const saved = await readStore(CHARTS_KEY);
    charts = saved ? JSON.parse(saved) : [];
  } catch (err) {
    charts = [];
  }

  // First run: start off with one section.
  if (!charts.length) {
    charts = [{ id: 1, name: DEFAULT_CHART_NAME }];
  }

  activeChartId = charts[0].id;
  renderTabs();
  drawChart(balancePoints());
}

async function saveCharts() {
  try {
    await writeStore(CHARTS_KEY, JSON.stringify(charts));
  } catch (err) {
    console.error('Could not save your charts:', err);
  }
}

// ---------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------
function renderTabs() {
  const strip = document.getElementById('chartTabs');

  strip.innerHTML = charts.map((c) => `
    <button class="chart-tab ${c.id === activeChartId ? 'active' : ''}" data-id="${c.id}">
      ${escapeHtml(c.name)}
    </button>
  `).join('') + '<button class="chart-tab new" id="newChart">＋ New chart</button>';

  strip.querySelectorAll('.chart-tab[data-id]').forEach((btn) => {
    btn.onclick = () => {
      activeChartId = Number(btn.dataset.id);
      renderTabs();
      drawChart(balancePoints());
    };
  });

  document.getElementById('newChart').onclick = () => openChartModal('new');

  const chart = activeChart();
  document.getElementById('chartTitle').textContent = chart ? chart.name : '';
  document.getElementById('deleteChart').disabled = charts.length < 2;
}

// ---------------------------------------------------------------
// New chart / rename dialog
// ---------------------------------------------------------------
let modalMode = 'new';

function openChartModal(mode) {
  modalMode = mode;

  const chart = activeChart();

  document.getElementById('chartModalTitle').textContent =
    mode === 'new' ? 'New chart' : 'Rename chart';

  document.getElementById('chartName').value = mode === 'rename' ? chart.name : '';

  document.getElementById('chartError').classList.remove('show');
  document.getElementById('chartModalBackdrop').classList.add('open');
  document.getElementById('chartName').focus();
}

function closeChartModal() {
  document.getElementById('chartModalBackdrop').classList.remove('open');
}

function saveChartFromModal() {
  const name = document.getElementById('chartName').value.trim() || DEFAULT_CHART_NAME;

  const clash = charts.some(
    (c) => c.name.toLowerCase() === name.toLowerCase() &&
      !(modalMode === 'rename' && c.id === activeChartId)
  );

  if (clash) {
    const error = document.getElementById('chartError');
    error.textContent = 'You already have a chart called that. Pick another name.';
    error.classList.add('show');
    return;
  }

  if (modalMode === 'new') {
    const chart = { id: Date.now(), name };
    charts.push(chart);
    activeChartId = chart.id;
  } else {
    activeChart().name = name;
  }

  saveCharts();
  closeChartModal();
  renderTabs();
  drawChart(balancePoints());
}

function deleteActiveChart() {
  if (charts.length < 2) return;

  const chart = activeChart();
  if (!confirm(`Remove the "${chart.name}" chart?`)) return;

  charts = charts.filter((c) => c.id !== chart.id);
  activeChartId = charts[0].id;

  saveCharts();
  renderTabs();
  drawChart(balancePoints());
}

document.getElementById('renameChart').onclick = () => openChartModal('rename');
document.getElementById('deleteChart').onclick = deleteActiveChart;
document.getElementById('saveChart').onclick = saveChartFromModal;
document.getElementById('closeChartModal').onclick = closeChartModal;
document.getElementById('chartModalBackdrop').onclick = (e) => {
  if (e.target === document.getElementById('chartModalBackdrop')) closeChartModal();
};
document.getElementById('chartName').onkeydown = (e) => {
  if (e.key === 'Enter') saveChartFromModal();
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeChartModal();
});

// ---------------------------------------------------------------
// Shared canvas setup
// ---------------------------------------------------------------
function setupCanvas() {
  const canvas = document.getElementById('graph');
  const rect = canvas.getBoundingClientRect();
  const dpr = devicePixelRatio || 1;

  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.font = '11px system-ui';

  return { ctx, w: rect.width, h: rect.height };
}

function drawEmpty(ctx, w, h) {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#8190a3';
  ctx.fillText(EMPTY_MESSAGE, w / 2, h / 2);
}

// Horizontal gridlines with money labels down the left.
function drawGrid(ctx, box, min, max) {
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  for (let i = 0; i < 5; i++) {
    const value = min + (max - min) * i / 4;
    const y = box.yAt(value);

    ctx.strokeStyle = GRID;
    ctx.beginPath();
    ctx.moveTo(box.L, y);
    ctx.lineTo(box.R, y);
    ctx.stroke();

    ctx.fillStyle = TEXT;
    ctx.fillText(shortMoney(value), box.L - 8, y);
  }
}

// ---------------------------------------------------------------
// Balance over time — running balance after every transaction
// ---------------------------------------------------------------
function drawBalanceChart(ctx, w, h, points) {
  const L = 55, T = 18, B = h - 32, R = w - 15;
  const plotW = R - L, plotH = B - T;

  const values = points.length ? points.map((p) => p.b) : [0];
  let min = Math.min(0, ...values);
  let max = Math.max(0, ...values);
  if (min === max) max += 10;
  const pad = (max - min) * .12;
  max += pad;
  min = Math.max(0, min - pad);

  const xAt = (i) => L + (points.length <= 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const yAt = (v) => T + ((max - v) / (max - min)) * plotH;

  drawGrid(ctx, { L, R, yAt }, min, max);

  ctx.strokeStyle = AXIS;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(L, yAt(0));
  ctx.lineTo(R, yAt(0));
  ctx.moveTo(L, T);
  ctx.lineTo(L, B);
  ctx.stroke();

  if (!points.length) return drawEmpty(ctx, w, h);

  for (let i = 1; i < points.length; i++) {
    ctx.strokeStyle = points[i].b >= points[i - 1].b ? GREEN : RED;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(xAt(i - 1), yAt(points[i - 1].b));
    ctx.lineTo(xAt(i), yAt(points[i].b));
    ctx.stroke();
  }

  points.forEach((p, i) => {
    ctx.fillStyle = '#070b12';
    ctx.beginPath();
    ctx.arc(xAt(i), yAt(p.b), 5, 0, 7);
    ctx.fill();

    ctx.fillStyle = (i && p.b < points[i - 1].b) ? RED : GREEN;
    ctx.beginPath();
    ctx.arc(xAt(i), yAt(p.b), 3, 0, 7);
    ctx.fill();
  });

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = TEXT;
  const tickCount = Math.min(6, points.length);
  for (let j = 0; j < tickCount; j++) {
    const i = Math.round(j * (points.length - 1) / Math.max(1, tickCount - 1));
    ctx.fillText(axisLabel(points[i]), xAt(i), h - 21);
  }
}

// ---------------------------------------------------------------
// Replaces drawChart() defined earlier in this file
// ---------------------------------------------------------------
window.drawChart = function (points) {
  if (!activeChart()) return;
  const { ctx, w, h } = setupCanvas();
  drawBalanceChart(ctx, w, h, points);
};

loadCharts();
