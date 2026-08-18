const state = { user: null, goalsCache: null };

// ---------- helpers ----------

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtMoney(n) {
  return '$' + Number(n).toFixed(2);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

function navigate(hash) {
  window.location.hash = hash;
}

// ---------- shell ----------

function renderShell() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <header class="site-header">
      <a href="#/board" class="brand">DONARO</a>
      <nav class="main-nav" id="main-nav"></nav>
    </header>
    <main id="main"></main>
    <footer class="site-footer">Every dollar is split and every Dredit is counted, server-side.</footer>
    <div id="modal-root"></div>
  `;
  renderNav();
}

function renderNav() {
  const nav = document.getElementById('main-nav');
  const hash = window.location.hash || '#/board';
  const pill = (href, label) => `<a class="nav-pill ${hash.startsWith(href) ? 'active' : ''}" href="${href}">${label}</a>`;
  let html = pill('#/board', 'Board') + pill('#/create', 'New Goal');
  if (state.user) {
    html += pill('#/dashboard', 'Dashboard');
    html += `<div class="user-chip">${escapeHtml(state.user.name)} · <span class="dredit-badge">${state.user.dredit_balance}◆</span></div>`;
    html += `<button class="btn-ghost" id="logout-btn">Sign out</button>`;
  } else {
    html += `<button class="btn-ghost" id="signin-btn">Sign in</button>`;
  }
  nav.innerHTML = html;
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) logoutBtn.onclick = async () => { await api('POST', '/api/logout'); state.user = null; renderNav(); handleRoute(); };
  const signinBtn = document.getElementById('signin-btn');
  if (signinBtn) signinBtn.onclick = () => openAuthModal();
}

// ---------- auth modal ----------

function openAuthModal(onSuccess) {
  const root = document.getElementById('modal-root');
  let mode = 'login';
  function draw() {
    root.innerHTML = `
      <div class="modal-backdrop" id="modal-backdrop">
        <div class="modal">
          <button class="modal-close" id="modal-close">CLOSE ✕</button>
          <h2>${mode === 'login' ? 'Sign in' : 'Create account'}</h2>
          <div class="modal-tabs">
            <div class="modal-tab ${mode === 'login' ? 'active' : ''}" data-mode="login">Sign in</div>
            <div class="modal-tab ${mode === 'register' ? 'active' : ''}" data-mode="register">Register</div>
          </div>
          <div id="auth-msg"></div>
          <form id="auth-form">
            ${mode === 'register' ? `<div class="field"><label>Name</label><input name="name" required /></div>` : ''}
            <div class="field"><label>Email</label><input name="email" type="email" required /></div>
            <div class="field"><label>Password</label><input name="password" type="password" required minlength="6" /></div>
            <button class="btn btn-primary" type="submit" style="width:100%">${mode === 'login' ? 'Sign in' : 'Create account'}</button>
          </form>
        </div>
      </div>
    `;
    document.getElementById('modal-close').onclick = () => { root.innerHTML = ''; };
    document.getElementById('modal-backdrop').onclick = (e) => { if (e.target.id === 'modal-backdrop') root.innerHTML = ''; };
    root.querySelectorAll('.modal-tab').forEach((tab) => {
      tab.onclick = () => { mode = tab.dataset.mode; draw(); };
    });
    document.getElementById('auth-form').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const payload = Object.fromEntries(fd.entries());
      try {
        const data = await api('POST', mode === 'login' ? '/api/login' : '/api/register', payload);
        state.user = data.user;
        root.innerHTML = '';
        renderNav();
        if (onSuccess) onSuccess(); else handleRoute();
      } catch (err) {
        document.getElementById('auth-msg').innerHTML = `<div class="form-msg error">${escapeHtml(err.message)}</div>`;
      }
    };
  }
  draw();
}

function requireAuthOrPrompt(action) {
  if (state.user) { action(); return; }
  openAuthModal(action);
}

// ---------- board view ----------

function thermoHtml(goal, big) {
  const pct = Math.min(100, goal.progress_pct);
  const funded = goal.status === 'funded' || pct >= 100;
  return `
    <div class="thermo ${big ? 'big-thermo' : ''}">
      <div class="thermo-fill ${funded ? 'funded' : ''}" style="width:${pct}%"></div>
      <div class="thermo-mark" title="Creator's original ask (100%)"></div>
    </div>
  `;
}

async function renderBoard() {
  const main = document.getElementById('main');
  main.innerHTML = `<div class="loading-dot">loading the board…</div>`;

  const [{ goals }, adsResp] = await Promise.all([
    api('GET', '/api/goals'),
    api('GET', '/api/ads/active').catch(() => ({ ads: [] })),
  ]);
  state.goalsCache = goals;

  let adStrip = '';
  if (adsResp.ads && adsResp.ads.length) {
    adStrip = `<div class="ad-strip">${adsResp.ads.map((ad) => `
      <div class="ad-flyer" data-goal="${ad.goal_id}"><b>Sponsored</b> · ${escapeHtml(ad.goal_title)}</div>
    `).join('')}</div>`;
  }

  main.innerHTML = `
    <p class="eyebrow">The corkboard</p>
    <h1 class="page-title">Goals people are backing right now</h1>
    ${adStrip}
    ${goals.length ? `<div class="board-grid">${goals.map(cardHtml).join('')}</div>` : `<div class="empty-state">No goals pinned yet — be the first.</div>`}
  `;
  main.querySelectorAll('.pin-card').forEach((el) => {
    el.onclick = () => navigate(`#/goal/${el.dataset.id}`);
  });
  main.querySelectorAll('.ad-flyer').forEach((el) => {
    el.onclick = () => navigate(`#/goal/${el.dataset.goal}`);
  });
}

function cardHtml(goal) {
  const funded = goal.status === 'funded';
  return `
    <div class="pin-card" data-id="${goal.id}">
      <h3>${escapeHtml(goal.title)}${funded ? '<span class="status-tag funded">Funded</span>' : ''}</h3>
      <div class="creator">pinned by ${escapeHtml(goal.creator_name)}</div>
      <p class="desc">${escapeHtml(goal.description).slice(0, 110)}${goal.description.length > 110 ? '…' : ''}</p>
      ${thermoHtml(goal)}
      <div class="pin-stats"><span>raised</span><b>${fmtMoney(goal.raised)} / ${fmtMoney(goal.goal_total)}</b></div>
    </div>
  `;
}

// ---------- goal detail ----------

async function renderGoalDetail(id) {
  const main = document.getElementById('main');
  main.innerHTML = `<div class="loading-dot">pulling the pin…</div>`;
  let data;
  try {
    data = await api('GET', `/api/goals/${id}`);
  } catch (err) {
    main.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
    return;
  }
  const { goal, donations } = data;

  main.innerHTML = `
    <div class="goal-layout">
      <div class="detail-card">
        <h1>${escapeHtml(goal.title)}${goal.status === 'funded' ? '<span class="status-tag funded">Funded</span>' : ''}</h1>
        <div class="creator">pinned by ${escapeHtml(goal.creator_name)} · ${new Date(goal.created_at).toLocaleDateString()}</div>
        <p class="desc">${escapeHtml(goal.description) || '<em>No description yet.</em>'}</p>
        ${thermoHtml(goal, true)}
        <div class="thermo-labels">
          <span>${fmtMoney(goal.raised)} raised</span>
          <span>goal ${fmtMoney(goal.goal_total)} (incl. 2% fee)</span>
        </div>
        <div class="donor-wall">
          <h4>Donor wall — ${donations.length} donation${donations.length === 1 ? '' : 's'}</h4>
          ${donations.length ? donations.map((d) => `
            <div class="receipt">
              <div class="row"><span>${escapeHtml(d.donor_name)}</span><span>${fmtMoney(d.amount)}</span></div>
              <div class="row" style="opacity:.6"><span>${new Date(d.created_at).toLocaleDateString()}</span></div>
              ${d.note ? `<div class="note">“${escapeHtml(d.note)}”</div>` : ''}
            </div>
          `).join('') : `<div class="empty-state" style="padding:20px 0">No donations yet.</div>`}
        </div>
      </div>
      <div class="side-card">
        <h3>Back this goal</h3>
        <div id="donate-msg"></div>
        <form id="donate-form">
          <div class="field">
            <label>Amount (USD)</label>
            <input name="amount" type="number" min="1" step="0.01" required placeholder="25.00" />
          </div>
          <div class="field">
            <label>Note (optional)</label>
            <textarea name="note" placeholder="Only donations of $100+ can include a note"></textarea>
            <div class="field-hint" id="note-hint">Notes unlock at $100.00 or more.</div>
          </div>
          <button class="btn btn-primary" type="submit" style="width:100%">Send donation</button>
        </form>
      </div>
    </div>
  `;

  const amountInput = document.querySelector('#donate-form input[name=amount]');
  const noteInput = document.querySelector('#donate-form textarea[name=note]');
  const noteHint = document.getElementById('note-hint');
  amountInput.addEventListener('input', () => {
    const val = parseFloat(amountInput.value || '0');
    if (val > 0 && val < 100) {
      noteHint.textContent = `Notes unlock at $100.00 or more — you're at ${fmtMoney(val)}.`;
      noteHint.classList.add('warn');
    } else {
      noteHint.textContent = 'Notes unlock at $100.00 or more.';
      noteHint.classList.remove('warn');
    }
  });

  document.getElementById('donate-form').onsubmit = (e) => {
    e.preventDefault();
    requireAuthOrPrompt(async () => {
      const msg = document.getElementById('donate-msg');
      msg.innerHTML = '';
      try {
        const resp = await api('POST', `/api/goals/${id}/donate`, {
          amount: amountInput.value,
          note: noteInput.value,
        });
        state.user.dredit_balance = resp.new_dredit_balance;
        renderNav();
        msg.innerHTML = `<div class="form-msg success">Thanks! You earned ${resp.dredits_earned} Dredits.</div>`;
        setTimeout(() => renderGoalDetail(id), 700);
      } catch (err) {
        msg.innerHTML = `<div class="form-msg error">${escapeHtml(err.message)}</div>`;
      }
    });
  };
}

// ---------- create goal ----------

function renderCreateGoal() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <p class="eyebrow">Pin something new</p>
    <h1 class="page-title">Create a goal</h1>
    <div class="form-card">
      <div id="create-msg"></div>
      <form id="create-form">
        <div class="field"><label>Title</label><input name="title" required maxlength="80" placeholder="Repair my food cart" /></div>
        <div class="field"><label>Description</label><textarea name="description" rows="4" placeholder="What's this for, and why it matters"></textarea></div>
        <div class="field"><label>Amount you want to receive (USD)</label><input name="requested_amount" type="number" min="1" step="0.01" required placeholder="100.00" /></div>
        <div class="preview-box" id="preview-box">Enter an amount to see the goal total and creation cost.</div>
        <button class="btn btn-primary" type="submit" style="width:100%" id="create-submit">Pin this goal</button>
      </form>
    </div>
  `;

  const amountInput = document.querySelector('#create-form input[name=requested_amount]');
  const previewBox = document.getElementById('preview-box');
  const submitBtn = document.getElementById('create-submit');
  let lastPreview = null;

  async function updatePreview() {
    const val = parseFloat(amountInput.value || '0');
    if (!state.user) {
      previewBox.textContent = 'Sign in to see your exact cost — your first goal is free.';
      return;
    }
    if (!(val > 0)) { previewBox.textContent = 'Enter an amount to see the goal total and creation cost.'; return; }
    try {
      const p = await api('POST', '/api/goals/preview', { requested_amount: val });
      lastPreview = p;
      previewBox.innerHTML = `
        <div class="line"><span>You receive</span><span>${fmtMoney(p.requested)}</span></div>
        <div class="line"><span>Donaro fee (2%)</span><span>${fmtMoney(p.fee)}</span></div>
        <div class="line total"><span>Goal total shown to donors</span><span>${fmtMoney(p.goal_total)}</span></div>
        <div class="line" style="margin-top:6px"><span>Creation cost</span><span>${p.is_free ? 'FREE (first goal)' : p.cost_dredits + ' Dredits'}</span></div>
      `;
      submitBtn.disabled = !p.can_afford;
      submitBtn.textContent = p.can_afford ? 'Pin this goal' : `Need ${p.cost_dredits} Dredits`;
    } catch (err) {
      previewBox.textContent = err.message;
    }
  }
  amountInput.addEventListener('input', updatePreview);

  document.getElementById('create-form').onsubmit = (e) => {
    e.preventDefault();
    requireAuthOrPrompt(async () => {
      await updatePreview();
      const fd = new FormData(e.target);
      const msg = document.getElementById('create-msg');
      try {
        const { goal } = await api('POST', '/api/goals', Object.fromEntries(fd.entries()));
        const me = await api('GET', '/api/me');
        state.user = me.user;
        renderNav();
        navigate(`#/goal/${goal.id}`);
      } catch (err) {
        msg.innerHTML = `<div class="form-msg error">${escapeHtml(err.message)}</div>`;
      }
    });
  };
  updatePreview();
}

// ---------- dashboard ----------

async function renderDashboard() {
  const main = document.getElementById('main');
  main.innerHTML = `<div class="loading-dot">opening your wallet…</div>`;

  const [{ user }, tx, goalsResp] = await Promise.all([
    api('GET', '/api/me'),
    api('GET', '/api/me/transactions'),
    api('GET', '/api/goals'),
  ]);
  state.user = user;
  renderNav();
  const myGoals = goalsResp.goals.filter((g) => g.user_id === user.id);

  main.innerHTML = `
    <p class="eyebrow">Your account</p>
    <h1 class="page-title">Dashboard</h1>
    <div class="dash-grid">
      <div>
        <div class="wallet">
          <div class="label">Dredit balance</div>
          <div class="amount">${user.dredit_balance}◆</div>
          <div class="label">Buy more Dredits</div>
          <div id="buy-msg"></div>
          <div class="buy-row">
            <input id="buy-amount" type="number" min="1" step="0.01" placeholder="$ amount" />
            <button class="btn btn-mint" id="buy-btn" style="font-family:var(--mono);font-size:12.5px;padding:8px 14px;">Buy</button>
          </div>
        </div>
      </div>
      <div>
        <div class="section-card">
          <h3>My goals</h3>
          ${myGoals.length ? myGoals.map((g) => `
            <div class="my-goal-row">
              <div>
                <a href="#/goal/${g.id}" style="font-family:var(--mono);font-weight:600">${escapeHtml(g.title)}</a>
                <div style="font-family:var(--mono);font-size:12px;color:var(--ink-soft)">${fmtMoney(g.raised)} / ${fmtMoney(g.goal_total)}</div>
              </div>
              <form class="ad-form" data-goal="${g.id}">
                <input type="number" min="5" step="1" placeholder="days" name="days" />
                <button class="btn-ghost" type="submit" style="color:var(--ink);border-color:var(--paper-dark)">Run ad (100◆/day)</button>
              </form>
            </div>
          `).join('') : `<div class="field-hint">You haven't pinned any goals yet.</div>`}
        </div>
        <div class="section-card">
          <h3>Dredit ledger</h3>
          ${tx.dredit_transactions.length ? `
            <table class="ledger">
              <thead><tr><th>When</th><th>Reason</th><th style="text-align:right">Δ</th></tr></thead>
              <tbody>
                ${tx.dredit_transactions.map((t) => `
                  <tr>
                    <td>${new Date(t.created_at).toLocaleDateString()}</td>
                    <td>${escapeHtml(t.reason.replace(/_/g, ' '))}</td>
                    <td style="text-align:right" class="${t.delta >= 0 ? 'delta-pos' : 'delta-neg'}">${t.delta >= 0 ? '+' : ''}${t.delta}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          ` : `<div class="field-hint">No Dredit activity yet.</div>`}
        </div>
        <div class="section-card">
          <h3>Donation history</h3>
          ${tx.donations.length ? `
            <table class="ledger">
              <thead><tr><th>When</th><th>Goal</th><th style="text-align:right">Amount</th><th style="text-align:right">Dredits</th></tr></thead>
              <tbody>
                ${tx.donations.map((d) => `
                  <tr>
                    <td>${new Date(d.created_at).toLocaleDateString()}</td>
                    <td>${escapeHtml(d.goal_title)}</td>
                    <td style="text-align:right">${fmtMoney(d.amount)}</td>
                    <td style="text-align:right" class="delta-pos">+${d.dredits_earned}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          ` : `<div class="field-hint">You haven't donated yet.</div>`}
        </div>
      </div>
    </div>
  `;

  document.getElementById('buy-btn').onclick = async () => {
    const amt = document.getElementById('buy-amount').value;
    const msg = document.getElementById('buy-msg');
    try {
      const resp = await api('POST', '/api/dredits/purchase', { amount: amt });
      msg.innerHTML = `<div class="field-hint" style="color:var(--receipt)">+${resp.dredits_purchased} Dredits</div>`;
      state.user.dredit_balance = resp.new_dredit_balance;
      renderNav();
      renderDashboard();
    } catch (err) {
      msg.innerHTML = `<div class="field-hint" style="color:#ffb4ae">${escapeHtml(err.message)}</div>`;
    }
  };

  main.querySelectorAll('.ad-form').forEach((form) => {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const days = form.querySelector('input[name=days]').value;
      try {
        await api('POST', '/api/ads', { goal_id: form.dataset.goal, days: Number(days) });
        renderDashboard();
      } catch (err) {
        alert(err.message);
      }
    };
  });
}

// ---------- router ----------

async function handleRoute() {
  renderNav();
  const hash = window.location.hash || '#/board';
  const parts = hash.replace('#/', '').split('/');
  const view = parts[0] || 'board';
  try {
    if (view === 'board' || !view) await renderBoard();
    else if (view === 'goal' && parts[1]) await renderGoalDetail(parts[1]);
    else if (view === 'create') await renderCreateGoal();
    else if (view === 'dashboard') {
      if (!state.user) { navigate('#/board'); openAuthModal(() => navigate('#/dashboard')); return; }
      await renderDashboard();
    } else await renderBoard();
  } catch (err) {
    document.getElementById('main').innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
  }
}

async function init() {
  renderShell();
  try {
    const { user } = await api('GET', '/api/me');
    state.user = user;
  } catch (e) { /* not signed in */ }
  renderNav();
  window.addEventListener('hashchange', handleRoute);
  handleRoute();
}

init();
