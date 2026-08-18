const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const db = require('./db');
const money = require('./lib/money');
const auth = require('./lib/auth');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- helpers ----------

function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1e6) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks += chunk;
    });
    req.on('end', () => {
      if (!chunks) return resolve({});
      try {
        resolve(JSON.parse(chunks));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function getCurrentUser(req) {
  const cookies = auth.parseCookies(req.headers.cookie);
  return auth.getUserFromToken(cookies.donaro_session);
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    dredit_balance: user.dredit_balance,
    has_used_free_goal: !!user.has_used_free_goal,
  };
}

function publicGoal(goal) {
  return {
    id: goal.id,
    user_id: goal.user_id,
    creator_name: goal.creator_name,
    title: goal.title,
    description: goal.description,
    requested: Number(money.centsToDollarsString(goal.requested_cents)),
    goal_total: Number(money.centsToDollarsString(goal.goal_total_cents)),
    raised: Number(money.centsToDollarsString(goal.raised_cents)),
    progress_pct: goal.goal_total_cents > 0
      ? Math.min(100, Math.round((goal.raised_cents / goal.goal_total_cents) * 1000) / 10)
      : 0,
    status: goal.status,
    created_at: goal.created_at,
  };
}

function adjustDredits(userId, delta, reason, refType, refId) {
  db.prepare('UPDATE users SET dredit_balance = dredit_balance + ? WHERE id = ?').run(delta, userId);
  db.prepare(
    'INSERT INTO dredit_transactions (user_id, delta, reason, ref_type, ref_id) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, delta, reason, refType || null, refId || null);
}

function requireAuth(req, res) {
  const user = getCurrentUser(req);
  if (!user) {
    sendJson(res, 401, { error: 'You need to sign in first.' });
    return null;
  }
  return user;
}

// ---------- API route handlers ----------

const routes = [];
function route(method, pattern, handler) {
  // pattern like /api/goals/:id/donate
  const keys = [];
  const regex = new RegExp(
    '^' + pattern.replace(/:[a-zA-Z]+/g, (m) => {
      keys.push(m.slice(1));
      return '([^/]+)';
    }) + '$'
  );
  routes.push({ method, regex, keys, handler });
}

route('POST', '/api/register', async (req, res) => {
  const body = await readJsonBody(req);
  const { email, name, password } = body;
  if (!email || !name || !password || password.length < 6) {
    return sendJson(res, 400, { error: 'Name, email, and a password of 6+ characters are required.' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (existing) {
    return sendJson(res, 409, { error: 'An account with that email already exists.' });
  }
  const { hash, salt } = auth.hashPassword(password);
  const info = db
    .prepare('INSERT INTO users (email, name, password_hash, password_salt) VALUES (?, ?, ?, ?)')
    .run(email.toLowerCase().trim(), name.trim(), hash, salt);
  const { token, expiresAt } = auth.createSession(info.lastInsertRowid);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  sendJson(res, 201, { user: publicUser(user) }, {
    'Set-Cookie': `donaro_session=${token}; HttpOnly; Path=/; Expires=${new Date(expiresAt).toUTCString()}`,
  });
});

route('POST', '/api/login', async (req, res) => {
  const body = await readJsonBody(req);
  const { email, password } = body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').toLowerCase().trim());
  if (!user || !auth.verifyPassword(password || '', user.password_salt, user.password_hash)) {
    return sendJson(res, 401, { error: 'Incorrect email or password.' });
  }
  const { token, expiresAt } = auth.createSession(user.id);
  sendJson(res, 200, { user: publicUser(user) }, {
    'Set-Cookie': `donaro_session=${token}; HttpOnly; Path=/; Expires=${new Date(expiresAt).toUTCString()}`,
  });
});

route('POST', '/api/logout', async (req, res) => {
  const cookies = auth.parseCookies(req.headers.cookie);
  if (cookies.donaro_session) auth.destroySession(cookies.donaro_session);
  sendJson(res, 200, { ok: true }, {
    'Set-Cookie': 'donaro_session=; HttpOnly; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  });
});

route('GET', '/api/me', async (req, res) => {
  const user = getCurrentUser(req);
  sendJson(res, 200, { user: publicUser(user) });
});

route('GET', '/api/me/transactions', async (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const donations = db
    .prepare(
      `SELECT d.*, g.title as goal_title FROM donations d
       JOIN goals g ON g.id = d.goal_id
       WHERE d.donor_user_id = ? ORDER BY d.created_at DESC`
    )
    .all(user.id);
  const dredits = db
    .prepare('SELECT * FROM dredit_transactions WHERE user_id = ? ORDER BY created_at DESC')
    .all(user.id);
  sendJson(res, 200, {
    donations: donations.map((d) => ({
      id: d.id,
      goal_id: d.goal_id,
      goal_title: d.goal_title,
      amount: Number(money.centsToDollarsString(d.amount_cents)),
      dredits_earned: d.dredits_earned,
      note: d.note,
      created_at: d.created_at,
    })),
    dredit_transactions: dredits,
  });
});

route('GET', '/api/goals', async (req, res) => {
  const goals = db
    .prepare(
      `SELECT goals.*, users.name as creator_name FROM goals
       JOIN users ON users.id = goals.user_id
       ORDER BY goals.created_at DESC`
    )
    .all();
  sendJson(res, 200, { goals: goals.map(publicGoal) });
});

route('GET', '/api/goals/:id', async (req, res, params) => {
  const goal = db
    .prepare(
      `SELECT goals.*, users.name as creator_name FROM goals
       JOIN users ON users.id = goals.user_id WHERE goals.id = ?`
    )
    .get(params.id);
  if (!goal) return sendJson(res, 404, { error: 'Goal not found.' });
  const donations = db
    .prepare(
      `SELECT donations.*, users.name as donor_name FROM donations
       JOIN users ON users.id = donations.donor_user_id
       WHERE goal_id = ? ORDER BY created_at DESC`
    )
    .all(params.id);
  sendJson(res, 200, {
    goal: publicGoal(goal),
    donations: donations.map((d) => ({
      id: d.id,
      donor_name: d.donor_name,
      amount: Number(money.centsToDollarsString(d.amount_cents)),
      note: d.note || null,
      created_at: d.created_at,
    })),
  });
});

route('POST', '/api/goals/preview', async (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const body = await readJsonBody(req);
  try {
    const requestedCents = money.dollarsToCents(body.requested_amount);
    const goalTotalCents = money.computeGoalTotal(requestedCents);
    const freeGoal = !user.has_used_free_goal;
    sendJson(res, 200, {
      requested: Number(money.centsToDollarsString(requestedCents)),
      goal_total: Number(money.centsToDollarsString(goalTotalCents)),
      fee: Number(money.centsToDollarsString(goalTotalCents - requestedCents)),
      cost_dredits: freeGoal ? 0 : money.GOAL_CREATION_COST_DREDITS,
      is_free: freeGoal,
      user_dredit_balance: user.dredit_balance,
      can_afford: freeGoal || user.dredit_balance >= money.GOAL_CREATION_COST_DREDITS,
    });
  } catch (e) {
    sendJson(res, 400, { error: e.message });
  }
});

route('POST', '/api/goals', async (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const body = await readJsonBody(req);
  const title = (body.title || '').trim();
  const description = (body.description || '').trim();
  if (!title) return sendJson(res, 400, { error: 'A goal needs a title.' });

  let requestedCents;
  try {
    requestedCents = money.dollarsToCents(body.requested_amount);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  const goalTotalCents = money.computeGoalTotal(requestedCents);

  const freeGoal = !user.has_used_free_goal;
  if (!freeGoal) {
    if (user.dredit_balance < money.GOAL_CREATION_COST_DREDITS) {
      return sendJson(res, 402, {
        error: `Creating another goal costs ${money.GOAL_CREATION_COST_DREDITS} Dredits. You have ${user.dredit_balance}.`,
      });
    }
  }

  const info = db
    .prepare(
      `INSERT INTO goals (user_id, title, description, requested_cents, goal_total_cents)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(user.id, title, description, requestedCents, goalTotalCents);

  if (freeGoal) {
    db.prepare('UPDATE users SET has_used_free_goal = 1 WHERE id = ?').run(user.id);
  } else {
    adjustDredits(user.id, -money.GOAL_CREATION_COST_DREDITS, 'goal_creation_fee', 'goal', info.lastInsertRowid);
  }

  const goal = db
    .prepare(
      `SELECT goals.*, users.name as creator_name FROM goals
       JOIN users ON users.id = goals.user_id WHERE goals.id = ?`
    )
    .get(info.lastInsertRowid);
  sendJson(res, 201, { goal: publicGoal(goal) });
});

route('POST', '/api/goals/:id/donate', async (req, res, params) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const goal = db.prepare('SELECT * FROM goals WHERE id = ?').get(params.id);
  if (!goal) return sendJson(res, 404, { error: 'Goal not found.' });
  if (goal.status !== 'open') return sendJson(res, 400, { error: 'This goal is no longer accepting donations.' });

  const body = await readJsonBody(req);
  let amountCents;
  try {
    amountCents = money.dollarsToCents(body.amount);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }

  const rawNote = typeof body.note === 'string' ? body.note.trim() : '';
  if (rawNote && !money.noteAllowed(amountCents)) {
    return sendJson(res, 400, {
      error: `Notes are only available on donations of $${money.centsToDollarsString(money.NOTE_MIN_CENTS)} or more.`,
    });
  }
  const note = rawNote || null;

  const { creatorShare, feeShare } = money.splitDonation(amountCents);
  const dredits = money.computeDredits(amountCents);

  db.prepare(
    `INSERT INTO donations (goal_id, donor_user_id, amount_cents, creator_share_cents, fee_share_cents, dredits_earned, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(goal.id, user.id, amountCents, creatorShare, feeShare, dredits, note);

  const newRaised = goal.raised_cents + amountCents;
  const newStatus = newRaised >= goal.goal_total_cents ? 'funded' : goal.status;
  db.prepare(
    `UPDATE goals SET raised_cents = ?, creator_received_cents = creator_received_cents + ?,
     fee_collected_cents = fee_collected_cents + ?, status = ? WHERE id = ?`
  ).run(newRaised, creatorShare, feeShare, newStatus, goal.id);

  if (dredits > 0) {
    adjustDredits(user.id, dredits, 'donation_reward', 'goal', goal.id);
  }

  const updated = db
    .prepare(
      `SELECT goals.*, users.name as creator_name FROM goals
       JOIN users ON users.id = goals.user_id WHERE goals.id = ?`
    )
    .get(goal.id);
  const freshUser = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  sendJson(res, 201, {
    goal: publicGoal(updated),
    dredits_earned: dredits,
    new_dredit_balance: freshUser.dredit_balance,
  });
});

route('POST', '/api/dredits/purchase', async (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const body = await readJsonBody(req);
  let amountCents;
  try {
    amountCents = money.dollarsToCents(body.amount);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  // Simulated payment — in a production build this would only credit
  // Dredits after a real payment provider confirms the charge server-side.
  const dredits = money.computeDredits(amountCents);
  if (dredits <= 0) {
    return sendJson(res, 400, { error: 'That amount is too small to buy any Dredits.' });
  }
  adjustDredits(user.id, dredits, 'purchase', null, null);
  const freshUser = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  sendJson(res, 200, { dredits_purchased: dredits, new_dredit_balance: freshUser.dredit_balance });
});

route('POST', '/api/ads', async (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const body = await readJsonBody(req);
  const goal = db.prepare('SELECT * FROM goals WHERE id = ?').get(body.goal_id);
  if (!goal) return sendJson(res, 404, { error: 'Goal not found.' });
  if (goal.user_id !== user.id) return sendJson(res, 403, { error: 'You can only promote your own goals.' });

  let cost;
  try {
    cost = money.computeAdCost(Number(body.days));
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  if (user.dredit_balance < cost.dreditCost) {
    return sendJson(res, 402, {
      error: `This ad costs ${cost.dreditCost} Dredits. You have ${user.dredit_balance}.`,
    });
  }

  const startsAt = new Date();
  const endsAt = new Date(startsAt.getTime() + Number(body.days) * 24 * 60 * 60 * 1000);
  const info = db
    .prepare(
      `INSERT INTO ads (goal_id, user_id, days, dredit_cost, appearances_total, appearances_remaining, starts_at, ends_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(goal.id, user.id, Number(body.days), cost.dreditCost, cost.appearances, cost.appearances, startsAt.toISOString(), endsAt.toISOString());

  adjustDredits(user.id, -cost.dreditCost, 'ad_purchase', 'ad', info.lastInsertRowid);

  const ad = db.prepare('SELECT * FROM ads WHERE id = ?').get(info.lastInsertRowid);
  sendJson(res, 201, { ad });
});

route('GET', '/api/ads/active', async (req, res) => {
  const ads = db
    .prepare(
      `SELECT ads.*, goals.title as goal_title, goals.id as goal_id FROM ads
       JOIN goals ON goals.id = ads.goal_id
       WHERE ads.ends_at > datetime('now') AND ads.appearances_remaining > 0
       ORDER BY RANDOM() LIMIT 5`
    )
    .all();
  sendJson(res, 200, { ads });
});

// ---------- static file serving ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback for client-side routes
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, indexData) => {
        if (err2) {
          res.writeHead(404);
          return res.end('Not found');
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(indexData);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const match = r.regex.exec(pathname);
      if (!match) continue;
      const params = {};
      r.keys.forEach((key, i) => { params[key] = match[i + 1]; });
      try {
        await r.handler(req, res, params);
      } catch (e) {
        console.error(e);
        sendJson(res, 500, { error: 'Something went wrong on our end.' });
      }
      return;
    }
    return sendJson(res, 404, { error: 'Unknown endpoint.' });
  }

  if (req.method === 'GET') {
    return serveStatic(req, res, pathname);
  }

  res.writeHead(405);
  res.end('Method not allowed');
});

server.listen(PORT, () => {
  console.log(`Donaro server running at http://localhost:${PORT}`);
});
