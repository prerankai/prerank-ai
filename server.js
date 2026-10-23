/* PreRank AI — live app server (zero-dependency Node.js)
   Auth + plans + orders + reports + thumbnails + generic items + admin panel.
   Data lives in data/db.json (swap for Postgres/Supabase at scale). */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const DB_FILE = path.join(ROOT, 'data', 'db.json');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'owner@prerankai.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Prerank@2026';

/* ---------------- DB ---------------- */
function defaultDB() {
  return {
    users: [], reports: [], orders: [], thumbnails: [], items: [], waitlist: [],
    plans: [
      { id: 'free', name: 'Free', price: 0, reportsPerMonth: 3, thumbnailsPerMonth: 3, channels: 1 },
      { id: 'pro', name: 'Pro', price: 12, reportsPerMonth: 40, thumbnailsPerMonth: 60, channels: 3 },
      { id: 'team', name: 'Team', price: 29, reportsPerMonth: -1, thumbnailsPerMonth: -1, channels: -1 }
    ],
    settings: { announcement: '', supportEmail: 'support@prerankai.com' },
    seq: { order: 1000 }
  };
}
function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { const db = defaultDB(); saveDB(db); return db; }
}
function saveDB(db) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 1));
}
let db = loadDB();

/* ---------------- Auth helpers ---------------- */
const sessions = new Map(); // token -> userId
function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return salt + ':' + hash;
}
function checkPw(pw, stored) {
  const [salt, hash] = (stored || '').split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
}
function seedAdmin() {
  if (!db.users.find(u => u.email === ADMIN_EMAIL)) {
    db.users.push({
      id: 'u_' + crypto.randomBytes(6).toString('hex'), name: 'Owner', email: ADMIN_EMAIL,
      pw: hashPw(ADMIN_PASSWORD), role: 'admin', plan: 'team', status: 'active',
      createdAt: new Date().toISOString()
    });
    saveDB(db);
    console.log('Seeded admin:', ADMIN_EMAIL);
  }
}
seedAdmin();

function currentUser(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/pr_session=([a-f0-9]+)/);
  if (!m) return null;
  const uid = sessions.get(m[1]);
  if (!uid) return null;
  return db.users.find(u => u.id === uid && u.status !== 'deleted') || null;
}
function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, plan: u.plan, status: u.status, createdAt: u.createdAt };
}
function monthKey(d = new Date()) { return d.toISOString().slice(0, 7); }
function usage(userId, kind) {
  const mk = monthKey();
  if (kind === 'reports') return db.reports.filter(r => r.userId === userId && r.createdAt.slice(0, 7) === mk).length;
  if (kind === 'thumbnails') return db.thumbnails.filter(t => t.userId === userId && t.createdAt.slice(0, 7) === mk).length;
  return 0;
}
function planOf(u) { return db.plans.find(p => p.id === u.plan) || db.plans[0]; }
function overLimit(u, kind) {
  const p = planOf(u);
  const lim = kind === 'reports' ? p.reportsPerMonth : p.thumbnailsPerMonth;
  if (lim < 0) return false;
  return usage(u.id, kind) >= lim;
}

/* ---------------- HTTP helpers ---------------- */
function send(res, code, body, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(code, { 'Content-Type': type });
  res.end(data);
}
function readBody(req) {
  return new Promise(resolve => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
  });
}
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

/* ---------------- Server ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  /* ----- Image proxy (same-origin fetch of generated images, enables canvas download) ----- */
  if (p === '/api/img') {
    const target = url.searchParams.get('url') || '';
    if (!/^https:\/\/image\.pollinations\.ai\//.test(target)) { res.writeHead(400); return res.end('Bad image URL'); }
    try {
      const r = await fetch(target);
      if (!r.ok) { res.writeHead(502); return res.end('Image provider error'); }
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(200, { 'Content-Type': r.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' });
      return res.end(buf);
    } catch { res.writeHead(502); return res.end('Image fetch failed'); }
  }

  /* ----- API ----- */
  if (p.startsWith('/api/')) {
    const body = (req.method === 'POST') ? await readBody(req) : {};
    const me = currentUser(req);
    const needAuth = () => { if (!me) { send(res, 401, { error: 'Sign in required' }); return true; } if (me.status === 'suspended') { send(res, 403, { error: 'Account suspended' }); return true; } return false; };
    const needAdmin = () => { if (needAuth()) return true; if (me.role !== 'admin') { send(res, 403, { error: 'Admin access required' }); return true; } return false; };

    if (p === '/api/signup' && req.method === 'POST') {
      const { name, email, password } = body;
      if (!name || !email || !password || password.length < 6) return send(res, 400, { error: 'Name, valid email and a 6+ character password are required.' });
      if (db.users.find(u => u.email === String(email).toLowerCase())) return send(res, 400, { error: 'An account with this email already exists.' });
      const u = { id: 'u_' + crypto.randomBytes(6).toString('hex'), name: String(name).slice(0, 60), email: String(email).toLowerCase(), pw: hashPw(password), role: 'user', plan: 'free', status: 'active', createdAt: new Date().toISOString() };
      db.users.push(u); saveDB(db);
      const token = crypto.randomBytes(24).toString('hex'); sessions.set(token, u.id);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `pr_session=${token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax` });
      return res.end(JSON.stringify({ user: publicUser(u) }));
    }
    if (p === '/api/signin' && req.method === 'POST') {
      const u = db.users.find(x => x.email === String(body.email || '').toLowerCase());
      if (!u || !checkPw(body.password || '', u.pw)) return send(res, 401, { error: 'Wrong email or password.' });
      if (u.status === 'suspended') return send(res, 403, { error: 'This account is suspended. Contact support.' });
      const token = crypto.randomBytes(24).toString('hex'); sessions.set(token, u.id);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `pr_session=${token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax` });
      return res.end(JSON.stringify({ user: publicUser(u) }));
    }
    if (p === '/api/signout' && req.method === 'POST') {
      const m = (req.headers.cookie || '').match(/pr_session=([a-f0-9]+)/);
      if (m) sessions.delete(m[1]);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'pr_session=; HttpOnly; Path=/; Max-Age=0' });
      return res.end('{}');
    }
    if (p === '/api/me' && req.method === 'GET') {
      if (!me) return send(res, 200, { user: null });
      return send(res, 200, { user: publicUser(me), usage: { reports: usage(me.id, 'reports'), thumbnails: usage(me.id, 'thumbnails') }, plan: planOf(me) });
    }
    if (p === '/api/change-password' && req.method === 'POST') {
      if (needAuth()) return;
      if (!checkPw(body.current || '', me.pw)) return send(res, 400, { error: 'Current password is incorrect.' });
      if (!body.next || body.next.length < 6) return send(res, 400, { error: 'New password must be 6+ characters.' });
      me.pw = hashPw(body.next); saveDB(db);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/plans' && req.method === 'GET') return send(res, 200, { plans: db.plans, settings: db.settings });
    if (p === '/api/waitlist' && req.method === 'POST') {
      if (!body.email || !/@/.test(body.email)) return send(res, 400, { error: 'Valid email required.' });
      db.waitlist.push({ email: String(body.email).toLowerCase(), at: new Date().toISOString() }); saveDB(db);
      return send(res, 200, { ok: true });
    }

    /* Reports */
    if (p === '/api/reports' && req.method === 'POST') {
      if (needAuth()) return;
      if (overLimit(me, 'reports')) return send(res, 402, { error: 'LIMIT', message: 'Monthly report limit reached for your plan. Upgrade to continue.' });
      const r = { id: 'r_' + crypto.randomBytes(6).toString('hex'), userId: me.id, idea: String(body.idea || '').slice(0, 500), niche: body.niche || '', score: body.report?.score ?? null, report: body.report || {}, createdAt: new Date().toISOString() };
      db.reports.push(r); saveDB(db);
      return send(res, 200, { report: r, usage: usage(me.id, 'reports') });
    }
    if (p === '/api/reports' && req.method === 'GET') {
      if (needAuth()) return;
      return send(res, 200, { reports: db.reports.filter(r => r.userId === me.id).slice().reverse() });
    }
    if (p.startsWith('/api/reports/') && req.method === 'DELETE') {
      if (needAuth()) return;
      const id = p.split('/')[3];
      db.reports = db.reports.filter(r => !(r.id === id && r.userId === me.id)); saveDB(db);
      return send(res, 200, { ok: true });
    }

    /* Thumbnails (records; images generated client-side via the AI image provider) */
    if (p === '/api/thumbnails' && req.method === 'POST') {
      if (needAuth()) return;
      if (overLimit(me, 'thumbnails')) return send(res, 402, { error: 'LIMIT', message: 'Monthly thumbnail limit reached for your plan. Upgrade to continue.' });
      const t = { id: 't_' + crypto.randomBytes(6).toString('hex'), userId: me.id, mode: body.mode || 'auto', prompt: String(body.prompt || '').slice(0, 20000), imageUrl: String(body.imageUrl || '').slice(0, 2000), ctr: body.ctr ?? null, createdAt: new Date().toISOString() };
      db.thumbnails.push(t); saveDB(db);
      return send(res, 200, { thumbnail: t, usage: usage(me.id, 'thumbnails') });
    }
    if (p === '/api/thumbnails' && req.method === 'GET') {
      if (needAuth()) return;
      return send(res, 200, { thumbnails: db.thumbnails.filter(t => t.userId === me.id).slice().reverse() });
    }

    /* Generic saved items: channels, competitors, calendar, videos, audits */
    if (p === '/api/items' && req.method === 'POST') {
      if (needAuth()) return;
      const it = { id: 'i_' + crypto.randomBytes(6).toString('hex'), userId: me.id, type: String(body.type || 'note'), data: body.data || {}, createdAt: new Date().toISOString() };
      db.items.push(it); saveDB(db);
      return send(res, 200, { item: it });
    }
    if (p === '/api/items' && req.method === 'GET') {
      if (needAuth()) return;
      const type = url.searchParams.get('type');
      return send(res, 200, { items: db.items.filter(i => i.userId === me.id && (!type || i.type === type)).slice().reverse() });
    }
    if (p.startsWith('/api/items/') && req.method === 'DELETE') {
      if (needAuth()) return;
      const id = p.split('/')[3];
      db.items = db.items.filter(i => !(i.id === id && i.userId === me.id)); saveDB(db);
      return send(res, 200, { ok: true });
    }

    /* Checkout (TEST MODE until Stripe keys are configured) */
    if (p === '/api/checkout' && req.method === 'POST') {
      if (needAuth()) return;
      const plan = db.plans.find(x => x.id === body.planId);
      if (!plan || plan.price <= 0) return send(res, 400, { error: 'Choose a paid plan.' });
      db.seq.order += 1;
      const order = { id: 'PR-' + db.seq.order, userId: me.id, email: me.email, plan: plan.id, amount: plan.price, status: 'paid_test', createdAt: new Date().toISOString() };
      db.orders.push(order); me.plan = plan.id; saveDB(db);
      return send(res, 200, { order, user: publicUser(me) });
    }
    if (p === '/api/orders' && req.method === 'GET') {
      if (needAuth()) return;
      return send(res, 200, { orders: db.orders.filter(o => o.userId === me.id).slice().reverse() });
    }

    /* ----- Admin ----- */
    if (p === '/api/admin/overview' && req.method === 'GET') {
      if (needAdmin()) return;
      const paidOrders = db.orders.filter(o => o.status === 'paid_test' || o.status === 'paid');
      const paidUserIds = new Set(paidOrders.map(o => o.userId));
      return send(res, 200, {
        totalUsers: db.users.filter(u => u.status !== 'deleted').length,
        paidSubscribers: [...paidUserIds].filter(id => id !== me.id).length,
        totalReports: db.reports.length, totalThumbnails: db.thumbnails.length,
        totalChannels: db.items.filter(i => i.type === 'channel').length,
        totalAudits: db.items.filter(i => i.type === 'audit').length,
        totalOptimizations: db.items.filter(i => i.type === 'video').length,
        revenue: paidOrders.reduce((s, o) => s + o.amount, 0),
        waitlist: db.waitlist.length,
        recentUsers: db.users.slice().reverse().slice(0, 5).map(publicUser),
        recentOrders: db.orders.slice().reverse().slice(0, 5)
      });
    }
    if (p === '/api/admin/users' && req.method === 'GET') {
      if (needAdmin()) return;
      return send(res, 200, { users: db.users.filter(u => u.status !== 'deleted').map(u => ({ ...publicUser(u), reports: db.reports.filter(r => r.userId === u.id).length, usageThisMonth: usage(u.id, 'reports') })) });
    }
    if (p.startsWith('/api/admin/users/') && req.method === 'POST') {
      if (needAdmin()) return;
      const u = db.users.find(x => x.id === p.split('/')[4]);
      if (!u) return send(res, 404, { error: 'User not found' });
      if (body.plan && db.plans.find(x => x.id === body.plan)) u.plan = body.plan;
      if (body.status && ['active', 'suspended'].includes(body.status)) u.status = body.status;
      if (body.resetUsage) { const mk = monthKey(); db.reports = db.reports.filter(r => !(r.userId === u.id && r.createdAt.slice(0, 7) === mk)); db.thumbnails = db.thumbnails.filter(t => !(t.userId === u.id && t.createdAt.slice(0, 7) === mk)); }
      saveDB(db);
      return send(res, 200, { user: publicUser(u) });
    }
    if (p.startsWith('/api/admin/users/') && req.method === 'DELETE') {
      if (needAdmin()) return;
      const u = db.users.find(x => x.id === p.split('/')[4]);
      if (!u || u.role === 'admin') return send(res, 400, { error: 'Cannot delete this account.' });
      u.status = 'deleted'; saveDB(db);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/admin/orders' && req.method === 'GET') {
      if (needAdmin()) return;
      return send(res, 200, { orders: db.orders.slice().reverse() });
    }
    if (p === '/api/admin/orders.csv' && req.method === 'GET') {
      if (needAdmin()) return;
      const rows = [['id', 'date', 'email', 'plan', 'amount', 'status'], ...db.orders.map(o => [o.id, o.createdAt, o.email, o.plan, o.amount, o.status])];
      return send(res, 200, rows.map(r => r.join(',')).join('\n'), 'text/csv');
    }
    if (p.startsWith('/api/admin/orders/') && req.method === 'POST') {
      if (needAdmin()) return;
      const o = db.orders.find(x => x.id === p.split('/')[4]);
      if (!o) return send(res, 404, { error: 'Order not found' });
      if (['paid', 'paid_test', 'refunded', 'cancelled'].includes(body.status)) o.status = body.status;
      saveDB(db);
      return send(res, 200, { order: o });
    }
    if (p === '/api/admin/plans' && req.method === 'POST') {
      if (needAdmin()) return;
      const plan = db.plans.find(x => x.id === body.id);
      if (!plan) return send(res, 404, { error: 'Plan not found' });
      if (body.name) plan.name = String(body.name).slice(0, 30);
      if (body.price !== undefined) plan.price = Math.max(0, Number(body.price) || 0);
      if (body.reportsPerMonth !== undefined) plan.reportsPerMonth = Number(body.reportsPerMonth);
      if (body.thumbnailsPerMonth !== undefined) plan.thumbnailsPerMonth = Number(body.thumbnailsPerMonth);
      if (body.channels !== undefined) plan.channels = Number(body.channels);
      saveDB(db);
      return send(res, 200, { plans: db.plans });
    }
    if (p === '/api/admin/settings' && req.method === 'POST') {
      if (needAdmin()) return;
      if (body.announcement !== undefined) db.settings.announcement = String(body.announcement).slice(0, 200);
      if (body.supportEmail !== undefined) db.settings.supportEmail = String(body.supportEmail).slice(0, 80);
      saveDB(db);
      return send(res, 200, { settings: db.settings });
    }
    if (p === '/api/admin/waitlist' && req.method === 'GET') {
      if (needAdmin()) return;
      return send(res, 200, { waitlist: db.waitlist });
    }
    return send(res, 404, { error: 'Unknown API route' });
  }

  /* ----- Static ----- */
  let file = p === '/' ? '/index.html' : p;
  const fp = path.join(PUB, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(fp, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUB, 'index.html'), (e2, idx) => {
        if (e2) { res.writeHead(500); return res.end('Server error'); }
        res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(idx);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`PreRank AI live on port ${PORT}`));
