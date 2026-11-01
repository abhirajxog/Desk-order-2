import { ApiError, getJSON, create, update, remove, listKeys, now } from './db.mjs';
import {
  DEFAULT_ADMIN,
  hashPassword,
  checkPassword,
  signToken,
  readToken,
  rlCheck,
  rlFail,
  rlClear,
  sha256,
  randomId,
} from './auth.mjs';

// ---------------------------------------------------------------------------
// People: one owner, many admins, many workers.
//   owner   signs in with the owner key. Manages admins. Also has an own team.
//   admin   signs in with a key the owner made. Runs a team of workers.
//   worker  signs in with a key their admin made.
// Every team keeps its own orders, settings, workers and withdrawals under
// "t/<team id>/". The owner's own team id is "main".
// ---------------------------------------------------------------------------

const MIN = 60000;
const DAY = 24 * 60 * MIN;
const EMPTY_ORDERS = { orders: {} };
const EMPTY_WD = { items: {} };
export const MAIN = 'main';

export const DEFAULTS = {
  claimWindowMin: 5, // how long an unclaimed order stays visible
  workTimeMin: 5, // how long a worker has after claiming
  reward: 20, // rupees per order (same for every order of the team)
  minWithdraw: 100,
  maxActive: 1, // orders one worker can hold at the same time
  orderSeq: 0,
};

const K = {
  settings: (t) => `t/${t}/settings`,
  orders: (t) => `t/${t}/active-orders`,
  wd: (t) => `t/${t}/active-wd`,
  finalOrders: (t, m) => `t/${t}/final-orders/${m}`,
  finalWd: (t, m) => `t/${t}/final-wd/${m}`,
  user: (t, u) => `t/${t}/users/${u}`,
  users: (t) => `t/${t}/users/`,
  admin: (t) => `admins/${t}`,
  key: (k) => `keys/${sha256(k)}`,
};

const money = (n) => Math.round(Number(n) * 100) / 100;
const str = (v) => (v === undefined || v === null ? '' : String(v));
// Month bucket in India time, used to archive finished records.
const ym = (t) => {
  const d = new Date(t + 330 * MIN);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const clone = (x) => JSON.parse(JSON.stringify(x));
const ADMIN_ID_RE = /^a[0-9a-f]{8}$/;

// ---------------------------------------------------------------- settings

export async function getSettings(tid) {
  return { ...DEFAULTS, ...((await getJSON(K.settings(tid))) || {}) };
}

const publicSettings = (s) => ({
  claimWindowMin: s.claimWindowMin,
  workTimeMin: s.workTimeMin,
  reward: s.reward,
  minWithdraw: s.minWithdraw,
  maxActive: s.maxActive,
});

function num(v, min, max, label, int = false) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) {
    throw new ApiError(400, `${label} must be ${int ? 'a whole number ' : 'a number '}between ${min} and ${max}.`);
  }
  return int ? n : money(n);
}

export async function saveSettings(tid, b) {
  const next = {
    claimWindowMin: num(b.claimWindowMin, 1, 1440, 'Order available time', true),
    workTimeMin: num(b.workTimeMin, 1, 1440, 'Time to finish an order', true),
    reward: num(b.reward, 0.5, 10000, 'Reward per order'),
    minWithdraw: num(b.minWithdraw, 1, 1000000, 'Minimum withdrawal'),
    maxActive: num(b.maxActive, 1, 20, 'Orders at a time', true),
  };
  await update(K.settings(tid), {}, (s) => Object.assign(s, next));
  return { settings: next };
}

// ------------------------------------------------------------- keys & names
// A key is the whole login. The person who creates an account types the key
// (like @ramo122) and tells it to the new person. Keys are case sensitive and
// unique across the whole site.

const KEY_RE = /^[\x21-\x7e]{6,40}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{1,29}$/;
const KEY_TAKEN = 'That key is already in use. Choose a different one.';

function checkKey(k) {
  if (!KEY_RE.test(k)) throw new ApiError(400, 'A key must be 6 to 40 characters with no spaces, like @ramo122.');
}

const slug = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

function cleanName(v, who) {
  const n = str(v).trim().replace(/\s+/g, ' ');
  if (!NAME_RE.test(n) || slug(n).length < 2) {
    throw new ApiError(400, `${who} name must be 2 to 30 letters or numbers.`);
  }
  return n;
}

async function getOwner() {
  const o = (await getJSON('owner')) || {};
  return { salt: o.salt || DEFAULT_ADMIN.salt, hash: o.hash || DEFAULT_ADMIN.hash, v: o.v || 1 };
}

// Reserve a key for a new owner of it. Throws when somebody already uses it.
async function claimKey(key, rec) {
  checkKey(key);
  const owner = await getOwner();
  if (checkPassword(key, owner.salt, owner.hash)) throw new ApiError(409, KEY_TAKEN);
  if (!(await create(K.key(key), rec))) throw new ApiError(409, KEY_TAKEN);
}
const releaseKey = (key) => remove(K.key(key));

// -------------------------------------------------------------------- users

function newWorker(tid, name, key, t) {
  return {
    username: slug(name),
    name,
    tid,
    key,
    pv: 1,
    createdAt: t,
    lastLogin: null,
    blocked: false,
    balance: 0,
    pendingWd: 0,
    wd: null,
    upi: '',
    counters: { submitted: 0, approved: 0, rejected: 0, expired: 0, timeout: 0, earned: 0, withdrawn: 0 },
    ledger: [],
  };
}

export const userView = (u) => ({
  username: u.username,
  name: u.name,
  balance: u.balance,
  counters: u.counters,
  upi: u.upi,
  wd: u.wd,
  createdAt: u.createdAt,
});

const workerRow = (u) => ({
  username: u.username,
  name: u.name,
  key: u.key,
  blocked: u.blocked,
  balance: u.balance,
  counters: u.counters,
  pendingWd: u.pendingWd,
  upi: u.upi,
  createdAt: u.createdAt,
  lastLogin: u.lastLogin,
});

async function teamName(tid) {
  if (tid === MAIN) return 'Your own team';
  const a = await getJSON(K.admin(tid));
  return a ? a.name : 'Unknown team';
}

// A team stops working when its admin is blocked or deleted.
async function assertTeamActive(tid) {
  if (tid === MAIN) return;
  const a = await getJSON(K.admin(tid));
  if (!a || a.blocked) throw new ApiError(403, 'Your team is paused. Contact your admin.');
}

// ------------------------------------------------------------------- login

export async function login(ip, b) {
  const key = str(b.key).trim();
  await rlCheck('login', ip);
  const fail = async () => {
    await rlFail('login', ip, 10, 15 * MIN);
    throw new ApiError(401, 'Wrong key. Check it and try again.');
  };
  if (!KEY_RE.test(key)) return fail();
  const t = now();
  const idx = await getJSON(K.key(key));

  if (!idx) {
    const owner = await getOwner();
    if (!checkPassword(key, owner.salt, owner.hash)) return fail();
    await rlClear('login', ip);
    const token = await signToken({ r: 'owner', t: MAIN, av: owner.v, exp: t + 12 * 60 * MIN });
    return { token, role: 'owner', name: 'Main admin' };
  }

  if (idx.t === 'admin') {
    const a = await getJSON(K.admin(idx.tid));
    if (!a || a.key !== key) return fail();
    if (a.blocked) throw new ApiError(403, 'This key is blocked. Contact the main admin.');
    await rlClear('login', ip);
    await update(K.admin(a.id), null, (r) => {
      if (r) r.lastLogin = t;
    });
    const token = await signToken({ r: 'admin', t: a.id, kv: a.kv, exp: t + 7 * DAY });
    return { token, role: 'admin', name: a.name };
  }

  const u = await getJSON(K.user(idx.tid, idx.u));
  if (!u || u.key !== key) return fail();
  if (u.blocked) throw new ApiError(403, 'This key is blocked. Contact your admin.');
  await assertTeamActive(idx.tid);
  await rlClear('login', ip);
  await update(K.user(idx.tid, idx.u), null, (r) => {
    if (r) r.lastLogin = t;
  });
  const token = await signToken({ r: 'worker', t: idx.tid, u: u.username, pv: u.pv, exp: t + 30 * DAY });
  return { token, role: 'worker', name: u.name };
}

async function readBearer(req) {
  const h = req.headers.get('authorization') || '';
  return readToken(h.startsWith('Bearer ') ? h.slice(7) : '');
}
const signedOut = () => new ApiError(401, 'Please sign in again.');

export async function authWorker(req) {
  const p = await readBearer(req);
  if (!p || p.r !== 'worker') throw signedOut();
  const user = await getJSON(K.user(p.t, p.u));
  if (!user || user.pv !== p.pv) throw signedOut();
  if (user.blocked) throw new ApiError(403, 'This key is blocked. Contact your admin.');
  await assertTeamActive(p.t);
  return { user, tid: p.t };
}

// Admin panel calls: an admin works on their own team. The owner works on
// their own team, or on any admin's team by sending `as`.
export async function authAdmin(req, body = {}) {
  const p = await readBearer(req);
  if (!p) throw signedOut();
  if (p.r === 'owner') {
    const owner = await getOwner();
    if (p.av !== owner.v) throw signedOut();
    let tid = MAIN;
    const as = str(body.as);
    if (as && as !== MAIN) {
      if (!ADMIN_ID_RE.test(as) || !(await getJSON(K.admin(as)))) throw new ApiError(404, 'That admin no longer exists.');
      tid = as;
    }
    return { role: 'owner', tid, self: null };
  }
  if (p.r !== 'admin') throw signedOut();
  const a = await getJSON(K.admin(p.t));
  if (!a || a.kv !== p.kv) throw signedOut();
  if (a.blocked) throw new ApiError(403, 'This key is blocked. Contact the main admin.');
  return { role: 'admin', tid: a.id, self: a };
}

export async function authOwner(req) {
  const p = await readBearer(req);
  if (!p || p.r !== 'owner') throw signedOut();
  const owner = await getOwner();
  if (p.av !== owner.v) throw signedOut();
  return { role: 'owner', tid: MAIN };
}

// Change the key you are signed in with (admin or owner).
export async function adminChangeKey(ctx, b) {
  const old = str(b.old).trim();
  const next = str(b.next).trim();
  checkKey(next);
  if (ctx.role === 'owner') {
    const owner = await getOwner();
    if (!checkPassword(old, owner.salt, owner.hash)) throw new ApiError(400, 'Your current key is wrong.');
    if (await getJSON(K.key(next))) throw new ApiError(409, KEY_TAKEN);
    const h = hashPassword(next);
    const av = await update('owner', {}, (o) => {
      o.salt = h.salt;
      o.hash = h.hash;
      o.v = (o.v || 1) + 1;
      return o.v;
    });
    return { token: await signToken({ r: 'owner', t: MAIN, av, exp: now() + 12 * 60 * MIN }) };
  }
  const a = ctx.self;
  if (old !== a.key) throw new ApiError(400, 'Your current key is wrong.');
  if (next === a.key) throw new ApiError(400, 'That is already your key.');
  await claimKey(next, { t: 'admin', tid: a.id });
  const kv = await update(K.admin(a.id), null, (r) => {
    r.key = next;
    r.kv += 1;
    return r.kv;
  });
  await releaseKey(old);
  return { token: await signToken({ r: 'admin', t: a.id, kv, exp: now() + 7 * DAY }) };
}

// ------------------------------------------------------------------- wallet
// Every balance change goes through here. Each entry has a unique `ref`, so
// repeating the same call (after a crash or a double click) never pays twice.

export async function walletApply(tid, username, entries) {
  const t = now();
  return update(K.user(tid, username), null, (u) => {
    if (!u) throw new ApiError(404, 'Worker not found.');
    for (const e of entries) {
      if (u.ledger.some((x) => x.ref === e.ref)) continue;
      if (e.unless && u.ledger.some((x) => x.ref === e.unless)) {
        throw new ApiError(409, 'This was already decided the other way.');
      }
      if (e.needNoPending && u.pendingWd > 0) {
        throw new ApiError(409, 'You already have a withdrawal waiting for the admin.');
      }
      if (e.amt < 0 && u.balance + e.amt < -0.001) throw new ApiError(400, 'Not enough balance.');
      u.balance = money(u.balance + e.amt);
      for (const [k, v] of Object.entries(e.counters || {})) u.counters[k] = money((u.counters[k] || 0) + v);
      if (e.pending) u.pendingWd = Math.max(0, u.pendingWd + e.pending);
      if ('wd' in e) u.wd = e.wd;
      if (e.upi) u.upi = e.upi;
      u.ledger.push({ ts: t, type: e.type, amt: e.amt, ref: e.ref, ord: e.ord || null, note: e.note || '' });
    }
    if (u.ledger.length > 300) u.ledger.splice(0, u.ledger.length - 300);
    return u.balance;
  });
}

// ------------------------------------------------------------------- orders

// Applies the clock to the active list. Mutates `a` and reports what changed:
//  - claimed orders whose work time ran out go back to the pool
//  - unclaimed orders whose window ran out disappear ("missed")
export function sweep(a, st, t) {
  const missed = [];
  const released = [];
  for (const o of Object.values(a.orders)) {
    if (o.status === 'claimed' && t > o.claimUntil) {
      released.push({ id: o.id, worker: o.worker, claimedAt: o.claimedAt });
      o.timeouts = (o.timeouts || 0) + 1;
      o.status = 'open';
      o.availUntil = o.claimUntil + st.claimWindowMin * MIN;
      o.worker = null;
      o.workerName = null;
      o.claimedAt = null;
      o.claimUntil = null;
      o.reward = null;
    }
    if (o.status === 'open' && t > o.availUntil) {
      missed.push({ ...o, status: 'missed', finalAt: o.availUntil });
      delete a.orders[o.id];
    }
  }
  return { missed, released };
}

async function archiveOrders(tid, list) {
  const groups = {};
  for (const o of list) (groups[ym(o.finalAt)] ||= []).push(o);
  for (const [m, arr] of Object.entries(groups)) {
    await update(K.finalOrders(tid, m), EMPTY_ORDERS, (f) => {
      for (const o of arr) f.orders[o.id] = o;
    });
  }
}

async function afterSweep(tid, sw) {
  if (!sw) return;
  try {
    if (sw.missed.length) await archiveOrders(tid, sw.missed);
    for (const r of sw.released) {
      await walletApply(tid, r.worker, [
        { ref: `to:${r.id}:${r.claimedAt}`, type: 'order_timeout', amt: 0, counters: { timeout: 1 }, ord: r.id },
      ]);
    }
  } catch (e) {
    console.error('afterSweep failed', e);
  }
}

// Read-only view of the clock applied to a copy (nothing is written).
const effective = (active, st, t) => {
  const a = clone(active || EMPTY_ORDERS);
  sweep(a, st, t);
  return a;
};

export async function workerHome(tid, user) {
  const [st, active] = await Promise.all([getSettings(tid), getJSON(K.orders(tid))]);
  const t = now();
  const orders = Object.values(effective(active, st, t).orders);
  const openAll = orders
    .filter((o) => o.status === 'open')
    .sort((x, y) => x.createdAt - y.createdAt || Number(x.id) - Number(y.id));
  return {
    me: userView(user),
    settings: publicSettings(st),
    openCount: openAll.length,
    open: openAll.slice(0, 60).map((o) => ({ id: o.id, availUntil: o.availUntil, reward: st.reward })),
    mine: orders
      .filter((o) => o.worker === user.username)
      .map((o) => ({
        id: o.id,
        status: o.status,
        link: o.link,
        claimedAt: o.claimedAt,
        claimUntil: o.claimUntil,
        doneAt: o.doneAt,
        reward: o.reward,
      })),
    ledger: user.ledger.slice(-80).reverse(),
  };
}

export async function claimOrder(tid, user, id) {
  const st = await getSettings(tid);
  const t = now();
  const { order, sw } = await update(K.orders(tid), EMPTY_ORDERS, (a) => {
    const sw = sweep(a, st, t);
    const o = a.orders[id];
    if (!o || o.status !== 'open') throw new ApiError(409, 'Too late. Someone else took this order or it expired.');
    const held = Object.values(a.orders).filter((x) => x.worker === user.username && x.status === 'claimed').length;
    if (held >= st.maxActive) {
      throw new ApiError(409, `Finish your current order first. You can hold ${st.maxActive} at a time.`);
    }
    o.status = 'claimed';
    o.worker = user.username;
    o.workerName = user.name;
    o.claimedAt = t;
    o.claimUntil = t + st.workTimeMin * MIN;
    o.reward = st.reward;
    return { order: clone(o), sw };
  });
  await afterSweep(tid, sw);
  return { order };
}

export async function markDone(tid, user, id) {
  const st = await getSettings(tid);
  const t = now();
  const { order, sw, again } = await update(K.orders(tid), EMPTY_ORDERS, (a) => {
    const sw = sweep(a, st, t);
    const o = a.orders[id];
    if (!o || o.worker !== user.username) {
      throw new ApiError(409, 'This order is no longer yours. Your time ran out and it went back to the pool.');
    }
    if (o.status === 'processing') return { order: clone(o), sw, again: true };
    o.status = 'processing';
    o.doneAt = t;
    return { order: clone(o), sw, again: false };
  });
  await afterSweep(tid, sw);
  if (!again) {
    await walletApply(tid, user.username, [
      { ref: `done:${id}:${order.claimedAt}`, type: 'order_done', amt: 0, counters: { submitted: 1 }, ord: id },
    ]);
  }
  return { order };
}

export async function markExpired(tid, user, id) {
  const st = await getSettings(tid);
  const t = now();
  const { fin, sw } = await update(K.orders(tid), EMPTY_ORDERS, (a) => {
    const sw = sweep(a, st, t);
    const o = a.orders[id];
    if (!o || o.worker !== user.username || o.status !== 'claimed') {
      throw new ApiError(409, 'This order is no longer yours. Your time ran out and it went back to the pool.');
    }
    delete a.orders[id];
    return { fin: { ...clone(o), status: 'expired', doneAt: t, finalAt: t }, sw };
  });
  await archiveOrders(tid, [fin]);
  await walletApply(tid, user.username, [
    { ref: `exp:${id}:${fin.claimedAt}`, type: 'order_exp', amt: 0, counters: { expired: 1 }, ord: id },
  ]);
  await afterSweep(tid, sw);
  return { ok: true };
}

// -------------------------------------------------------------- withdrawals

const UPI_RE = /^[a-z0-9][a-z0-9._-]{1,63}@[a-z][a-z0-9]{1,31}$/i;

export async function withdraw(tid, user, b) {
  const st = await getSettings(tid);
  const upi = str(b.upi).trim().toLowerCase();
  const amount = money(b.amount);
  if (!UPI_RE.test(upi)) throw new ApiError(400, 'Enter a valid UPI ID, like name@bank.');
  if (!(amount > 0)) throw new ApiError(400, 'Enter an amount.');
  if (amount < st.minWithdraw) throw new ApiError(400, `Minimum withdrawal is ₹${st.minWithdraw}.`);
  if (amount > user.balance + 0.001) throw new ApiError(400, 'You do not have that much balance.');
  const t = now();
  const id = `W${t.toString(36).toUpperCase()}${Math.floor(Math.random() * 36 ** 2).toString(36).toUpperCase()}`;
  await walletApply(tid, user.username, [
    {
      ref: `wd:${id}`,
      type: 'wd_req',
      amt: -amount,
      note: upi,
      pending: 1,
      needNoPending: true,
      upi,
      wd: { id, amount, upi, at: t },
    },
  ]);
  try {
    await update(K.wd(tid), EMPTY_WD, (d) => {
      d.items[id] = { id, worker: user.username, name: user.name, amount, upi, at: t, status: 'pending' };
    });
  } catch (e) {
    await walletApply(tid, user.username, [
      { ref: `wdfail:${id}`, type: 'wd_fail', amt: amount, pending: -1, wd: null, note: 'Could not be submitted' },
    ]);
    throw e;
  }
  return { id };
}

export async function adminWithdrawals(tid, ids, decision) {
  const t = now();
  const ok = decision === 'success';
  const d = (await getJSON(K.wd(tid))) || EMPTY_WD;
  const sel = ids.map((id) => d.items[id]).filter((x) => x && x.status === 'pending');
  if (!sel.length) throw new ApiError(409, 'Nothing to update. It may already be processed.');
  for (const w of sel) {
    await walletApply(tid, w.worker, [
      ok
        ? { ref: `wdok:${w.id}`, unless: `wdfail:${w.id}`, type: 'wd_ok', amt: 0, counters: { withdrawn: w.amount }, pending: -1, wd: null, note: w.upi }
        : { ref: `wdfail:${w.id}`, unless: `wdok:${w.id}`, type: 'wd_fail', amt: w.amount, pending: -1, wd: null, note: w.upi },
    ]);
  }
  await update(K.finalWd(tid, ym(t)), EMPTY_WD, (f) => {
    for (const w of sel) f.items[w.id] = { ...w, status: ok ? 'success' : 'failed', finalAt: t };
  });
  await update(K.wd(tid), EMPTY_WD, (x) => {
    for (const w of sel) delete x.items[w.id];
  });
  return { count: sel.length, amount: money(sel.reduce((s, w) => s + w.amount, 0)) };
}

// -------------------------------------------------------------- admin: team

export async function adminOverview(tid) {
  const st = await getSettings(tid);
  const t = now();
  const { snap, sw } = await update(K.orders(tid), EMPTY_ORDERS, (a) => {
    const sw = sweep(a, st, t);
    return { sw, snap: clone(a) };
  });
  await afterSweep(tid, sw);
  const orders = Object.values(snap.orders);
  const wd = Object.values(((await getJSON(K.wd(tid))) || EMPTY_WD).items);
  const byTime = (k) => (x, y) => x[k] - y[k];
  return {
    team: { id: tid, name: await teamName(tid) },
    settings: publicSettings(st),
    pending: orders.filter((o) => o.status === 'processing').sort(byTime('doneAt')),
    claimed: orders.filter((o) => o.status === 'claimed').sort(byTime('claimUntil')),
    open: orders.filter((o) => o.status === 'open').sort((x, y) => Number(x.id) - Number(y.id)),
    withdrawals: wd.filter((w) => w.status === 'pending').sort(byTime('at')),
  };
}

export async function adminVerify(tid, ids, decision) {
  const t = now();
  const approve = decision === 'approve';
  const a = (await getJSON(K.orders(tid))) || EMPTY_ORDERS;
  const sel = ids.map((id) => a.orders[id]).filter((o) => o && o.status === 'processing');
  if (!sel.length) throw new ApiError(409, 'Nothing to verify. It may already be done.');
  const byWorker = {};
  for (const o of sel) (byWorker[o.worker] ||= []).push(o);
  for (const [w, list] of Object.entries(byWorker)) {
    await walletApply(
      tid,
      w,
      list.map((o) =>
        approve
          ? { ref: `ord:${o.id}`, unless: `ordx:${o.id}`, type: 'order_ok', amt: o.reward, counters: { approved: 1, earned: o.reward }, ord: o.id }
          : { ref: `ordx:${o.id}`, unless: `ord:${o.id}`, type: 'order_no', amt: 0, counters: { rejected: 1 }, ord: o.id },
      ),
    );
  }
  await archiveOrders(tid, sel.map((o) => ({ ...o, status: approve ? 'approved' : 'rejected', finalAt: t })));
  await update(K.orders(tid), EMPTY_ORDERS, (x) => {
    for (const o of sel) if (x.orders[o.id] && x.orders[o.id].status === 'processing') delete x.orders[o.id];
  });
  return { count: sel.length, amount: approve ? money(sel.reduce((s, o) => s + o.reward, 0)) : 0 };
}

export async function addOrders(tid, links) {
  const st = await getSettings(tid);
  const raw = [...new Set((Array.isArray(links) ? links : []).map((l) => str(l).trim()).filter(Boolean))];
  if (raw.length > 300) throw new ApiError(400, 'Add up to 300 links at a time.');
  const valid = raw.filter((l) => /^https?:\/\/\S{3,2000}$/i.test(l));
  const a0 = (await getJSON(K.orders(tid))) || EMPTY_ORDERS;
  const inUse = new Set(Object.values(a0.orders).map((o) => o.link));
  const fresh = valid.filter((l) => !inUse.has(l));
  if (!fresh.length) {
    throw new ApiError(400, valid.length ? 'These links are already live.' : 'No valid links found. Each link must start with http:// or https://');
  }
  const start = await update(K.settings(tid), {}, (s) => {
    const base = s.orderSeq || 0;
    s.orderSeq = base + fresh.length;
    return base + 1;
  });
  const t = now();
  const sw = await update(K.orders(tid), EMPTY_ORDERS, (a) => {
    const sw = sweep(a, st, t);
    fresh.forEach((link, i) => {
      const id = String(start + i);
      a.orders[id] = {
        id, link, status: 'open', createdAt: t, availUntil: t + st.claimWindowMin * MIN,
        worker: null, workerName: null, claimedAt: null, claimUntil: null, reward: null, doneAt: null, timeouts: 0,
      };
    });
    return sw;
  });
  await afterSweep(tid, sw);
  return { added: fresh.length, duplicates: valid.length - fresh.length, invalid: raw.length - valid.length };
}

export async function cancelOrders(tid, ids) {
  const st = await getSettings(tid);
  const t = now();
  const { fin, sw } = await update(K.orders(tid), EMPTY_ORDERS, (a) => {
    const sw = sweep(a, st, t);
    const fin = [];
    for (const id of ids) {
      const o = a.orders[id];
      if (o && o.status === 'open') {
        delete a.orders[id];
        fin.push({ ...clone(o), status: 'cancelled', finalAt: t });
      }
    }
    return { fin, sw };
  });
  await archiveOrders(tid, fin);
  await afterSweep(tid, sw);
  return { cancelled: fin.length };
}

export async function adminHistory(tid, month) {
  const oKeys = await listKeys(`t/${tid}/final-orders/`);
  const wKeys = await listKeys(`t/${tid}/final-wd/`);
  const months = [...new Set([...oKeys, ...wKeys].map((k) => k.split('/')[3]))].sort().reverse();
  const m = months.includes(month) ? month : months[0] || ym(now());
  const [fo, fw] = await Promise.all([getJSON(K.finalOrders(tid, m)), getJSON(K.finalWd(tid, m))]);
  const desc = (x, y) => y.finalAt - x.finalAt;
  return {
    month: m,
    months: months.length ? months : [m],
    orders: Object.values((fo || EMPTY_ORDERS).orders).sort(desc).slice(0, 500),
    withdrawals: Object.values((fw || EMPTY_WD).items).sort(desc).slice(0, 500),
  };
}

async function teamUsers(tid) {
  const keys = await listKeys(K.users(tid));
  return (await Promise.all(keys.map((k) => getJSON(k)))).filter(Boolean);
}

export async function adminWorkers(tid) {
  const users = await teamUsers(tid);
  return { workers: users.map(workerRow).sort((x, y) => x.name.localeCompare(y.name)) };
}

export async function workerAdd(tid, b) {
  const name = cleanName(b.name, 'Worker');
  const key = str(b.key).trim();
  checkKey(key);
  const user = newWorker(tid, name, key, now());
  await claimKey(key, { t: 'worker', tid, u: user.username });
  try {
    if (!(await create(K.user(tid, user.username), user))) {
      throw new ApiError(409, 'You already have a worker with that name. Add a number, like Ravi 2.');
    }
  } catch (e) {
    await releaseKey(key);
    throw e;
  }
  return { worker: workerRow(user) };
}

export async function workerUpdate(tid, b) {
  const username = str(b.username).trim().toLowerCase();
  const u0 = await getJSON(K.user(tid, username));
  if (!u0) throw new ApiError(404, 'Worker not found.');
  let newKey = b.newKey === undefined ? null : str(b.newKey).trim();
  if (newKey !== null) {
    checkKey(newKey);
    if (newKey === u0.key) newKey = null;
  }
  if (newKey) await claimKey(newKey, { t: 'worker', tid, u: username });
  let oldKey = null;
  try {
    await update(K.user(tid, username), null, (u) => {
      if (!u) throw new ApiError(404, 'Worker not found.');
      if (typeof b.blocked === 'boolean') u.blocked = b.blocked;
      if (newKey) {
        oldKey = u.key;
        u.key = newKey;
        u.pv += 1;
      }
    });
  } catch (e) {
    if (newKey) await releaseKey(newKey);
    throw e;
  }
  if (oldKey) await releaseKey(oldKey);
  return { ok: true };
}

// ------------------------------------------------------------- owner: admins

async function teamStats(tid) {
  const [users, ao, aw] = await Promise.all([teamUsers(tid), getJSON(K.orders(tid)), getJSON(K.wd(tid))]);
  const t = now();
  const orders = Object.values((ao || EMPTY_ORDERS).orders);
  const sum = (f) => money(users.reduce((s, u) => s + f(u), 0));
  return {
    workers: users.length,
    owed: sum((u) => u.balance),
    paid: sum((u) => u.counters.withdrawn),
    approved: sum((u) => u.counters.approved),
    expired: sum((u) => u.counters.expired),
    waitingVerify: orders.filter((o) => o.status === 'processing').length,
    waitingPay: Object.values((aw || EMPTY_WD).items).filter((w) => w.status === 'pending').length,
    open: orders.filter((o) => o.status === 'open' && o.availUntil >= t).length,
  };
}

async function allAdmins() {
  const keys = await listKeys('admins/');
  return (await Promise.all(keys.map((k) => getJSON(k)))).filter(Boolean).sort((x, y) => x.createdAt - y.createdAt);
}

export async function ownerAdmins() {
  const admins = await allAdmins();
  const rows = [{ id: MAIN, name: 'Your own team', isMain: true }, ...admins];
  const out = await Promise.all(
    rows.map(async (a) => ({
      id: a.id,
      name: a.name,
      isMain: !!a.isMain,
      key: a.isMain ? null : a.key,
      blocked: !!a.blocked,
      createdAt: a.createdAt || null,
      lastLogin: a.lastLogin || null,
      ...(await teamStats(a.id)),
    })),
  );
  return { admins: out };
}

export async function ownerEveryone() {
  const admins = await allAdmins();
  const teams = [{ id: MAIN, name: 'Your own team' }, ...admins];
  const lists = await Promise.all(teams.map(async (t) => (await teamUsers(t.id)).map((u) => ({ ...workerRow(u), team: t.name, teamId: t.id }))));
  return { workers: lists.flat().sort((x, y) => x.team.localeCompare(y.team) || x.name.localeCompare(y.name)) };
}

export async function ownerAdminAdd(b) {
  const name = cleanName(b.name, 'Admin');
  const key = str(b.key).trim();
  checkKey(key);
  const id = randomId();
  const rec = { id, name, key, kv: 1, blocked: false, createdAt: now(), lastLogin: null };
  await claimKey(key, { t: 'admin', tid: id });
  try {
    await create(K.admin(id), rec);
  } catch (e) {
    await releaseKey(key);
    throw e;
  }
  return { admin: { id, name, key } };
}

function adminIdOf(b) {
  const id = str(b.id);
  if (!ADMIN_ID_RE.test(id)) throw new ApiError(400, 'Unknown admin.');
  return id;
}

export async function ownerAdminUpdate(b) {
  const id = adminIdOf(b);
  const a0 = await getJSON(K.admin(id));
  if (!a0) throw new ApiError(404, 'That admin no longer exists.');
  let newKey = b.newKey === undefined ? null : str(b.newKey).trim();
  if (newKey !== null) {
    checkKey(newKey);
    if (newKey === a0.key) newKey = null;
  }
  const newName = b.name === undefined ? null : cleanName(b.name, 'Admin');
  if (newKey) await claimKey(newKey, { t: 'admin', tid: id });
  let oldKey = null;
  try {
    await update(K.admin(id), null, (a) => {
      if (!a) throw new ApiError(404, 'That admin no longer exists.');
      if (typeof b.blocked === 'boolean') a.blocked = b.blocked;
      if (newName) a.name = newName;
      if (newKey) {
        oldKey = a.key;
        a.key = newKey;
        a.kv += 1;
      }
    });
  } catch (e) {
    if (newKey) await releaseKey(newKey);
    throw e;
  }
  if (oldKey) await releaseKey(oldKey);
  return { ok: true };
}

// Removes the admin, every worker of that team and all of the team's records.
export async function ownerAdminDelete(b) {
  const id = adminIdOf(b);
  const a = await getJSON(K.admin(id));
  if (!a) throw new ApiError(404, 'That admin no longer exists.');
  const users = await teamUsers(id);
  // Admin first: from this moment nobody in the team can sign in or act.
  await remove(K.admin(id));
  await releaseKey(a.key);
  for (const u of users) await releaseKey(u.key);
  const all = await listKeys(`t/${id}/`);
  for (let i = 0; i < all.length; i += 20) await Promise.all(all.slice(i, i + 20).map((k) => remove(k)));
  return { deleted: true, workers: users.length };
}

// ------------------------------------------------------------------- health
// Open /api?health=1 after deploying to confirm the database works.
export async function health() {
  const key = 'health/probe';
  const checks = {};
  try {
    await update(key, { n: 0 }, (d) => {
      d.n = 0;
    });
    const a = await create(key, { n: 1 });
    checks.createOnlyIfNew = a === false; // must refuse: key already exists
    const n = await update(key, { n: 0 }, (d) => {
      d.n += 1;
      return d.n;
    });
    checks.updateWorks = n === 1;
    const parallel = await Promise.all(
      Array.from({ length: 8 }, () => update(key, { n: 0 }, (d) => { d.n += 1; return d.n; })),
    );
    checks.noLostUpdates = new Set(parallel).size === 8;
  } catch (e) {
    checks.error = String(e && e.message);
  }
  const ok = checks.createOnlyIfNew === true && checks.updateWorks === true && checks.noLostUpdates === true;
  return { ok, checks };
}
