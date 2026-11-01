import { ApiError, now } from '../lib/db.mjs';
import * as L from '../lib/logic.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify({ ...body, now: now() }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const ids = (v) => {
  if (!Array.isArray(v) || v.length === 0 || v.length > 300) throw new ApiError(400, 'Nothing selected.');
  return v.map(String);
};

// action -> handler. `ip` is only used by sign-in.
const PUBLIC = {
  login: (b, _a, ip) => L.login(ip, b),
};

// Workers: always their own team.
const WORKER = {
  'w.home': (b, { user, tid }) => L.workerHome(tid, user),
  'w.claim': (b, { user, tid }) => L.claimOrder(tid, user, String(b.id)),
  'w.done': (b, { user, tid }) => L.markDone(tid, user, String(b.id)),
  'w.expired': (b, { user, tid }) => L.markExpired(tid, user, String(b.id)),
  'w.withdraw': (b, { user, tid }) => L.withdraw(tid, user, b),
};

// Admin panel: an admin's own team. The owner may add `as: <admin id>` to work on another team.
const ADMIN = {
  'a.overview': (b, c) => L.adminOverview(c.tid),
  'a.verify': (b, c) => L.adminVerify(c.tid, ids(b.ids), b.decision === 'approve' ? 'approve' : 'reject'),
  'a.addOrders': (b, c) => L.addOrders(c.tid, b.links),
  'a.cancelOrders': (b, c) => L.cancelOrders(c.tid, ids(b.ids)),
  'a.withdrawals': (b, c) => L.adminWithdrawals(c.tid, ids(b.ids), b.decision === 'success' ? 'success' : 'failed'),
  'a.history': (b, c) => L.adminHistory(c.tid, String(b.month || '')),
  'a.workers': (b, c) => L.adminWorkers(c.tid),
  'a.workerAdd': (b, c) => L.workerAdd(c.tid, b),
  'a.workerUpdate': (b, c) => L.workerUpdate(c.tid, b),
  'a.saveSettings': (b, c) => L.saveSettings(c.tid, b),
  'a.changeKey': (b, c) => L.adminChangeKey(c, b),
};

// Owner only: manage the admins.
const OWNER = {
  'o.admins': () => L.ownerAdmins(),
  'o.everyone': () => L.ownerEveryone(),
  'o.adminAdd': (b) => L.ownerAdminAdd(b),
  'o.adminUpdate': (b) => L.ownerAdminUpdate(b),
  'o.adminDelete': (b) => L.ownerAdminDelete(b),
};

export default async (req, context) => {
  try {
    if (req.method === 'GET') {
      const url = new URL(req.url);
      if (url.searchParams.has('health')) return json(await L.health());
      return json({ ok: true });
    }
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

    let body;
    try {
      body = await req.json();
    } catch {
      throw new ApiError(400, 'Bad request.');
    }
    const action = String(body.action || '');
    const ip = (context && context.ip) || req.headers.get('x-nf-client-connection-ip') || 'unknown';

    if (PUBLIC[action]) return json(await PUBLIC[action](body, null, ip));
    if (WORKER[action]) return json(await WORKER[action](body, await L.authWorker(req)));
    if (ADMIN[action]) return json(await ADMIN[action](body, await L.authAdmin(req, body)));
    if (OWNER[action]) return json(await OWNER[action](body, await L.authOwner(req)));
    throw new ApiError(404, 'Unknown action.');
  } catch (e) {
    if (e instanceof ApiError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
};

export const config = { path: '/api' };
