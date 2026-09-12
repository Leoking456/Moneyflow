// ---------------------------------------------------------------
    // Firebase setup (Google sign-in + Firestore cross-device sync)
    // ---------------------------------------------------------------
    // Setup steps (one-time, takes ~5 minutes):
    // 1. Go to https://console.firebase.google.com -> Add project
    // 2. Build > Authentication > Sign-in method > enable "Google"
    // 3. Build > Firestore Database > Create database (start in test mode)
    // 4. Project settings (gear icon) > General > "Your apps" > add a Web app
    //    -> copy the config object it gives you into firebaseConfig below
    // 5. Authentication > Settings > Authorized domains -> add the domain
    //    this app is actually hosted on (e.g. yourname.github.io)
    //
    // Until you paste in real values, the app just runs in local-only mode
    // (auto-saves to this device, no cloud sync, no sign-in button shown).
    const firebaseConfig = {
      apiKey: "YOUR_API_KEY",
      authDomain: "YOUR_PROJECT.firebaseapp.com",
      projectId: "YOUR_PROJECT_ID",
      storageBucket: "YOUR_PROJECT.appspot.com",
      messagingSenderId: "YOUR_SENDER_ID",
      appId: "YOUR_APP_ID"
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
            <button id="signOutBtn" class="del" title="Sign out">✕</button>
          </div>
          <div class="sync-status on">● Synced to Google account</div>
        `;
        $('signOutBtn').onclick = () => firebase.auth().signOut();
      } else {
        el.innerHTML = `
          <button id="signInBtn" class="google-btn">Sign in with Google</button>
          <div class="sync-status">Saved on this device only</div>
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
    loadTransactions();
