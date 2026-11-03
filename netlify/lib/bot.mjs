// Telegram order bot. All state lives in Netlify Blobs through db.mjs (compare-and-set), so two
// people tapping at the same moment can never double-claim an order or double-credit a balance.
//
// createBot({ tg, adminId }) -> { handleUpdate, sweep, drain }
//   tg(method, params) must resolve to Telegram's JSON reply ({ ok, result, error_code, ... }).
import { createHash } from 'node:crypto';
import { getJSON, create, update, listKeys, remove, now, ApiError } from './db.mjs';

export const DEFAULT_ADMIN = '6568873080';
const IST = 19800000;
const GRACE = 5000; // a claimed order may still be submitted this long after the deadline
const REMIND = 90000; // reminder goes out when <= 90s are left (the 1 minute scheduler makes it 30-90s)
const MAX_WORKERS = 50;
const MAX_LINKS = 30;
const MAX_PENDING = 30;
const REJECT_COOLDOWN = 3600000;

const CFG0 = {
  orderSecs: 300,
  minClaimSecs: 30,
  minWd: 100,
  warnAfter: 2,
  banAfter: 4,
  maxActive: 1,
  rewards: [15, 20, 25],
  orderSeq: 0,
  wSeq: 0,
  lastPost: '',
  lbResetAt: 0,
};

const W_ORD = '📋 Orders';
const W_WAL = '💰 Wallet';
const W_LB = '🏆 Leaderboard';
const W_HIS = '🧾 History';
const A_VER = '✅ Verify';
const A_ADD = '➕ Add orders';
const A_WD = '💸 Withdrawals';
const A_WK = '👥 Workers';
const A_SET = '⚙️ Settings';
const A_REP = '📊 Report';
const LABELS = new Set([W_ORD, W_WAL, W_LB, W_HIS, A_VER, A_ADD, A_WD, A_WK, A_SET, A_REP]);

const SETTINGS = {
  orderMin: { label: 'Order time (minutes)', min: 0.5, max: 180, ask: 'Send the order time in minutes (for example 5).' },
  minClaim: { label: 'Min time left to claim (seconds)', min: 0, max: 600, ask: 'Send the minimum seconds that must be left to claim (for example 30).' },
  minWd: { label: 'Minimum withdrawal (₹)', min: 1, max: 100000, ask: 'Send the minimum withdrawal amount in ₹.' },
  warnAfter: { label: 'Warn after N false in a row', min: 1, max: 50, ask: 'Send how many false results in a row should trigger a warning.' },
  banAfter: { label: 'Ban after N false in a row', min: 2, max: 100, ask: 'Send how many false results in a row should ban a worker.' },
  maxActive: { label: 'Orders a worker can hold at once', min: 1, max: 10, ask: 'Send how many orders one worker may hold at the same time.' },
  rewards: { label: 'Reward buttons (₹)', list: true, ask: 'Send the reward buttons separated by commas, for example 15,20,25 (up to 6).' },
};

class Skip extends Error {}
const skip = () => {
  throw new Skip();
};
async function cas(key, init, fn) {
  try {
    return await update(key, init, fn);
  } catch (e) {
    if (e instanceof Skip) return null;
    throw e;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (n) => String(Math.round(n * 100) / 100);
const money = (n) => '₹' + num(n);
const istDate = (t) => new Date(t + IST).toISOString().slice(0, 10);
const istHour = (t) => new Date(t + IST).getUTCHours();
const istHM = (t) => new Date(t + IST).toISOString().slice(11, 16);
const left = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return `${s} sec`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} min ${r} sec` : `${m} min`;
};
const mins = (secs) => `${num(secs / 60)} min`;
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const btn = (text, data) => ({ text, callback_data: data });
const ik = (rows) => ({ inline_keyboard: rows });
const medal = (i) => ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;

const O = (id) => `bot/o/${id}`;
const U = (id) => `bot/u/${id}`;
const WK = (id) => `bot/w/${id}`;

export function createBot({ tg, adminId = DEFAULT_ADMIN, pace = 900, kick = null }) {
  const A = String(adminId);

  // ---------- Telegram helpers ----------
  async function call(method, p) {
    try {
      let r = await tg(method, p);
      if (r && r.ok === false && r.error_code === 429) {
        await sleep(Math.min(4000, ((r.parameters && r.parameters.retry_after) || 1) * 1000));
        r = await tg(method, p);
      }
      return r || { ok: false };
    } catch {
      return { ok: false };
    }
  }
  const send = async (chat, text, extra = {}) => {
    const r = await call('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
    return r.ok ? r.result.message_id : null;
  };
  const edit = (chat, mid, text, kb) =>
    call('editMessageText', {
      chat_id: chat,
      message_id: mid,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: kb || { inline_keyboard: [] },
    });
  const ans = (id, text, alert) => (id ? call('answerCallbackQuery', { callback_query_id: id, text, show_alert: !!alert }) : null);
  async function many(items, fn, size = 25) {
    const out = [];
    for (let i = 0; i < items.length; i += size) {
      const t0 = Date.now();
      out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
      if (i + size < items.length && pace) {
        const w = pace - (Date.now() - t0);
        if (w > 0) await sleep(w);
      }
    }
    return out;
  }

  // ---------- storage helpers ----------
  const getCfg = async () => ({ ...CFG0, ...((await getJSON('bot/cfg')) || {}) });
  const updCfg = (fn) => update('bot/cfg', CFG0, fn);
  const getUser = (id) => getJSON(U(id));
  const updU = (id, fn) =>
    cas(U(id), { _m: 1 }, (d) => {
      if (d._m) skip();
      return fn(d);
    });
  const updO = (id, fn) =>
    cas(O(id), { _m: 1 }, (d) => {
      if (d._m) skip();
      return fn(d);
    });
  const liveAdd = (ids) =>
    update('bot/live', { ids: [] }, (d) => {
      for (const id of ids) if (!d.ids.includes(id)) d.ids.push(id);
    });
  const liveDel = (id) =>
    update('bot/live', { ids: [] }, (d) => {
      d.ids = d.ids.filter((x) => x !== id);
    });

  async function allUsers() {
    const keys = await listKeys('bot/u/');
    const rows = await Promise.all(keys.map((k) => getJSON(k)));
    return rows.filter(Boolean);
  }
  const approvedIds = async () => (await allUsers()).filter((u) => u.status === 'approved').map((u) => u.id);

  const nameOf = (from) => {
    const n = [from.first_name, from.last_name].filter(Boolean).join(' ').trim() || from.username || String(from.id);
    return clip(n, 40);
  };

  // ---------- stats / leaderboards ----------
  async function bump(uid, name, d = {}, t = {}) {
    const day = istDate(now());
    const add = (x) => {
      if (!uid) return;
      const r = (x.u[uid] = x.u[uid] || { n: name, ok: 0, fail: 0, exp: 0, earn: 0 });
      r.n = name;
      for (const k of Object.keys(d)) r[k] = (r[k] || 0) + d[k];
    };
    await update(`bot/day/${day}`, { u: {}, t: {} }, (x) => {
      add(x);
      for (const k of Object.keys(t)) x.t[k] = (x.t[k] || 0) + t[k];
    });
    if (uid && Object.keys(d).length) await update('bot/lbAll', { u: {} }, add);
  }

  async function boardData(kind) {
    if (kind === 'all') return ((await getJSON('bot/lbAll')) || { u: {} }).u;
    const t = now();
    const day = istDate(t);
    const dow = (new Date(t + IST).getUTCDay() + 6) % 7;
    const weekStart = istDate(t - dow * 86400000);
    const keys = (await listKeys('bot/day/')).filter((k) => {
      const d = k.slice(8);
      return kind === 'today' ? d === day : kind === 'week' ? d >= weekStart && d <= day : d.startsWith(day.slice(0, 7));
    });
    const docs = await Promise.all(keys.map((k) => getJSON(k)));
    const out = {};
    for (const doc of docs) {
      if (!doc) continue;
      for (const [uid, r] of Object.entries(doc.u)) {
        const o = (out[uid] = out[uid] || { n: r.n, ok: 0, fail: 0, exp: 0, earn: 0 });
        o.n = r.n;
        o.ok += r.ok;
        o.fail += r.fail;
        o.exp += r.exp;
        o.earn += r.earn;
      }
    }
    return out;
  }
  const TITLES = { today: 'Today', week: 'This week', month: 'This month', all: 'All time' };
  const rank = (rows) => rows.sort((a, b) => b[1].ok - a[1].ok || b[1].earn - a[1].earn || a[1].n.localeCompare(b[1].n));

  async function boardText(kind, forUid) {
    const data = await boardData(kind);
    const rows = rank(Object.entries(data).filter(([, r]) => r.ok > 0));
    const sub = kind === 'today' ? ` · ${istDate(now())}` : '';
    let t = `🏆 <b>${TITLES[kind]}</b>${sub}\n`;
    if (!rows.length) t += '\nNo approved QR yet.';
    rows.slice(0, 10).forEach(([uid, r], i) => {
      const me = uid === forUid ? ' 👈' : '';
      t += `\n${medal(i)} ${esc(r.n)} — <b>${r.ok}</b> QR · ${money(r.earn)}${me}`;
    });
    const mine = rows.findIndex(([uid]) => uid === forUid);
    if (mine >= 10) t += `\n\nYou: #${mine + 1} · ${rows[mine][1].ok} QR · ${money(rows[mine][1].earn)}`;
    if (forUid && mine < 0 && forUid !== A) t += '\n\nYou have no approved QR in this period yet.';
    return t;
  }
  const boardKb = (isAdmin) => {
    const rows = [[btn('Today', 'lb:today'), btn('Week', 'lb:week'), btn('Month', 'lb:month'), btn('All time', 'lb:all')]];
    if (isAdmin) rows.push([btn('❌ Failed today', 'lbf'), btn('♻️ Reset leaderboard', 'rl')]);
    return ik(rows);
  };
  async function failedText() {
    const data = await boardData('today');
    const rows = Object.entries(data)
      .filter(([, r]) => r.fail > 0 || r.exp > 0)
      .sort((a, b) => b[1].fail - a[1].fail || b[1].exp - a[1].exp);
    let t = `❌ <b>Failed today</b> · ${istDate(now())}\n`;
    if (!rows.length) return t + '\nNobody failed an order today.';
    for (const [, r] of rows) t += `\n• ${esc(r.n)} — <b>${r.fail}</b> false${r.exp ? ` · ${r.exp} QR expired` : ''}`;
    return t;
  }

  // ---------- menus ----------
  const workerKb = () => ({ keyboard: [[{ text: W_ORD }, { text: W_WAL }], [{ text: W_LB }, { text: W_HIS }]], resize_keyboard: true, is_persistent: true });
  const adminKb = () => ({
    keyboard: [[{ text: A_VER }, { text: A_ADD }], [{ text: A_WD }, { text: A_WK }], [{ text: W_LB }, { text: A_SET }], [{ text: A_REP }]],
    resize_keyboard: true,
    is_persistent: true,
  });
  const setState = (id, state) => updU(id, (u) => void (u.state = state));

  // ---------- orders: text ----------
  const rewardLine = (o) => `💰 Reward: <b>${money(o.reward)}</b>`;
  function openText(o) {
    return `🆕 <b>New order #${o.id}</b>\n${rewardLine(o)}\n⏳ Time: ${mins(o.secs)} (closes ${istHM(o.deadline)} IST)\n\nTap <b>Claim</b> to take it. The first one to tap gets it.`;
  }
  const openKb = (o) => ik([[btn('Claim ✅', `cl:${o.id}`)]]);
  function closedText(o) {
    if (o.status === 'missed') return `⌛ <b>Order #${o.id}</b> closed — nobody claimed it.`;
    if (o.status === 'cancelled') return `🚫 <b>Order #${o.id}</b> was cancelled by the admin.`;
    return `🔒 <b>Order #${o.id}</b> — claimed by ${esc(o.claimName || 'another user')}.`;
  }
  function activeText(o) {
    const l = o.deadline - now();
    return (
      `📌 <b>Your order #${o.id}</b>\n${rewardLine(o)}\n\n🔗 ${esc(o.link)}\n\n` +
      (l > 0 ? `⏳ <b>${left(l)}</b> left to complete this order` : '⌛ Time is over') +
      '\n\nWhen you are finished tap <b>I done</b>. If the QR does not work tap <b>QR expired</b>.'
    );
  }
  const activeKb = (o) => ik([[btn('I done ✅', `dn:${o.id}`), btn('QR expired 🚫', `ex:${o.id}`)]]);

  // ---------- orders: creating + broadcasting ----------
  async function addOrders(links, reward) {
    const cfg = await updCfg((c) => {
      const start = c.orderSeq + 1;
      c.orderSeq += links.length;
      return { start, secs: c.orderSecs };
    });
    const t = now();
    const workers = await approvedIds();
    const ids = [];
    for (let i = 0; i < links.length; i++) {
      const id = String(cfg.start + i);
      await create(O(id), {
        id,
        link: links[i],
        reward,
        secs: cfg.secs,
        at: t,
        deadline: t + cfg.secs * 1000,
        status: 'open',
        claimedBy: null,
        claimName: '',
        msgs: {},
        pendingTo: workers,
        reminded: false,
      });
      ids.push(id);
    }
    await liveAdd(ids);
    await bump(null, '', {}, { added: ids.length });
    return { ids, workers: workers.length };
  }

  // Sends the "new order" message to every worker. Runs under a short lease so two invocations
  // never send the same order twice; whatever is left is picked up by kick / the 1 minute scheduler.
  async function drain(budgetMs = 6500) {
    const t0 = Date.now();
    {
      // cheap check first so ordinary messages do not touch the lease at all
      const live0 = (await getJSON('bot/live')) || { ids: [] };
      let any = false;
      for (const id of live0.ids) {
        const o = await getJSON(O(id));
        if (o && o.status === 'open' && o.pendingTo.length && o.deadline > now()) any = true;
      }
      if (!any) return { left: 0 };
    }
    const got = await cas('bot/lease', { until: 0 }, (d) => {
      if (d.until > now()) skip();
      d.until = now() + 20000;
      return true;
    });
    if (!got) return { left: -1 };
    let remaining = 0;
    try {
      for (;;) {
        const live = (await getJSON('bot/live')) || { ids: [] };
        let job = null;
        remaining = 0;
        for (const id of live.ids) {
          const o = await getJSON(O(id));
          if (o && o.status === 'open' && o.pendingTo.length && o.deadline > now()) {
            remaining += o.pendingTo.length;
            if (!job) job = o;
          }
        }
        if (!job || Date.now() - t0 > budgetMs) break;
        const chunk = job.pendingTo.slice(0, 25);
        const sent = await many(chunk, async (uid) => [uid, await send(uid, openText(job), { reply_markup: openKb(job) })], 25);
        const res = await updO(job.id, (o) => {
          o.pendingTo = o.pendingTo.filter((x) => !chunk.includes(x));
          for (const [uid, mid] of sent) if (mid) o.msgs[uid] = mid;
          return { ...o };
        });
        if (res && res.status !== 'open') {
          // it was claimed while we were sending: fix the messages we just delivered
          await many(sent.filter(([, m]) => m), ([uid, mid]) => edit(uid, mid, closedText(res)));
        }
        remaining -= chunk.length;
        if (pace && sent.length === 25) await sleep(Math.max(0, pace - 300));
      }
    } finally {
      await cas('bot/lease', { until: 0 }, (d) => void (d.until = 0));
    }
    return { left: Math.max(0, remaining) };
  }

  async function closeBroadcast(o, exceptUid) {
    const entries = Object.entries(o.msgs || {}).filter(([uid]) => uid !== exceptUid);
    await many(entries, ([uid, mid]) => edit(uid, mid, closedText(o)));
  }

  // ---------- claim / done / expired ----------
  async function claim(uid, oid, cb) {
    const cfg = await getCfg();
    const u = await getUser(uid);
    if (!u || u.status !== 'approved') return ans(cb.id, 'You do not have access.', true);
    const o0 = await getJSON(O(oid));
    if (!o0) return ans(cb.id, 'This order no longer exists.', true);
    if (o0.status !== 'open') {
      return ans(cb.id, o0.status === 'missed' || o0.status === 'cancelled' ? 'This order is closed.' : 'Claimed by another user. Try the next order.', true);
    }
    const leftMs = o0.deadline - now();
    if (leftMs <= 0 || leftMs < cfg.minClaimSecs * 1000) {
      return ans(cb.id, `Too late — less than ${left(Math.max(cfg.minClaimSecs * 1000, 1000))} left for this order.`, true);
    }
    // 1) reserve a slot for this worker
    const slot = await updU(uid, (d) => {
      if (d.status !== 'approved') skip();
      if (d.active.length >= cfg.maxActive) throw new ApiError(409, 'FULL');
      d.active.push(oid);
      return true;
    }).catch((e) => (e instanceof ApiError && e.message === 'FULL' ? 'FULL' : Promise.reject(e)));
    if (slot === 'FULL') return ans(cb.id, 'Finish your current order first.', true);
    if (!slot) return ans(cb.id, 'You do not have access.', true);
    // 2) take the order (first writer wins)
    const won = await updO(oid, (o) => {
      if (o.status !== 'open' || o.deadline <= now()) skip();
      o.status = 'claimed';
      o.claimedBy = uid;
      o.claimName = u.name;
      o.claimedAt = now();
      o.pendingTo = [];
      o.reminded = o.deadline - now() <= REMIND;
      return { ...o };
    });
    if (!won) {
      await updU(uid, (d) => void (d.active = d.active.filter((x) => x !== oid)));
      return ans(cb.id, 'Claimed by another user. Try the next order.', true);
    }
    // the winner gets their answer first, everybody else is updated afterwards
    await ans(cb.id, `Order #${oid} is yours!`);
    const chat = cb.message ? cb.message.chat.id : uid;
    const mid = cb.message ? cb.message.message_id : null;
    if (mid) await edit(chat, mid, activeText(won), activeKb(won));
    else await send(uid, activeText(won), { reply_markup: activeKb(won) });
    await closeBroadcast(won, uid);
    await bump(uid, u.name, {}, { claimed: 1 });
  }

  async function onDone(uid, oid, cb, yes) {
    const o = await getJSON(O(oid));
    if (!o || o.claimedBy !== uid || o.status !== 'claimed') {
      return ans(cb.id, o && o.status === 'timeout' ? 'Time is over for this order.' : 'This order is not active any more.', true);
    }
    if (now() > o.deadline + GRACE) {
      await timeoutOrder(oid);
      return ans(cb.id, 'Time is over for this order.', true);
    }
    const chat = cb.message.chat.id;
    const mid = cb.message.message_id;
    if (!yes) {
      await ans(cb.id);
      return edit(chat, mid, `Did you finish order #${oid} (${money(o.reward)})?`, ik([[btn('Yes, I done ✅', `dy:${oid}`), btn('⬅️ Back', `bk:${oid}`)]]));
    }
    const done = await updO(oid, (d) => {
      if (d.status !== 'claimed' || d.claimedBy !== uid) skip();
      d.status = 'processing';
      d.doneAt = now();
      return { ...d };
    });
    if (!done) return ans(cb.id, 'This order is not active any more.', true);
    await updU(uid, (u) => {
      u.active = u.active.filter((x) => x !== oid);
      hist(u, oid, o.reward, 'checking');
    });
    await ans(cb.id, 'Sent for checking ✅');
    await edit(chat, mid, `⏳ <b>Order #${oid}</b> submitted.\nWaiting for the admin to check it (${money(o.reward)}).`);
    const am = await send(A, verifyText(done), { reply_markup: verifyKb(done) });
    if (am) await updO(oid, (d) => void (d.adminMsg = am));
  }

  async function onExpired(uid, oid, cb, yes) {
    const o = await getJSON(O(oid));
    if (!o || o.claimedBy !== uid || o.status !== 'claimed') return ans(cb.id, 'This order is not active any more.', true);
    const chat = cb.message.chat.id;
    const mid = cb.message.message_id;
    if (!yes) {
      await ans(cb.id);
      return edit(chat, mid, `Is the QR of order #${oid} really expired?`, ik([[btn('Yes, QR expired 🚫', `ey:${oid}`), btn('⬅️ Back', `bk:${oid}`)]]));
    }
    const done = await updO(oid, (d) => {
      if (d.status !== 'claimed' || d.claimedBy !== uid) skip();
      d.status = 'expired';
      d.doneAt = now();
      return { ...d };
    });
    if (!done) return ans(cb.id, 'This order is not active any more.', true);
    const u = await updU(uid, (x) => {
      x.active = x.active.filter((i) => i !== oid);
      x.exp += 1;
      hist(x, oid, o.reward, 'expired');
      return { ...x };
    });
    await liveDel(oid);
    await ans(cb.id, 'Marked as expired 🚫');
    await edit(chat, mid, `🚫 <b>Order #${oid}</b> marked as QR expired.`);
    await bump(uid, u.name, { exp: 1 }, { exp: 1 });
    await send(A, `🚫 QR expired — order #${oid} · ${esc(u.name)} · ${money(o.reward)}`, { disable_notification: true });
  }

  function hist(u, id, reward, st) {
    const h = u.hist || (u.hist = []);
    const i = h.findIndex((x) => x.id === id);
    if (i >= 0) h[i].s = st;
    else h.unshift({ id, r: reward, s: st, t: now() });
    if (h.length > 15) h.length = 15;
  }

  // ---------- verification ----------
  const verifyText = (o) =>
    `🔎 <b>Verify order #${o.id}</b>\n👤 ${esc(o.claimName)}\n${rewardLine(o)}\n🔗 ${esc(o.link)}\n🕒 Submitted ${istHM(o.doneAt)} IST`;
  const verifyKb = (o) => ik([[btn('True ✅', `vt:${o.id}`), btn('False ❌', `vf:${o.id}`)]]);

  async function processing() {
    const live = (await getJSON('bot/live')) || { ids: [] };
    const rows = await Promise.all(live.ids.map((id) => getJSON(O(id))));
    return rows.filter((o) => o && o.status === 'processing').sort((a, b) => a.doneAt - b.doneAt);
  }

  async function approveOrder(oid) {
    const o = await updO(oid, (d) => {
      if (d.status !== 'processing') skip();
      d.status = 'approved';
      d.verifiedAt = now();
      return { ...d };
    });
    if (!o) return null;
    const uid = o.claimedBy;
    const u = await updU(uid, (x) => {
      const ref = `o:${oid}`;
      if (!x.refs.includes(ref)) {
        x.refs.push(ref);
        if (x.refs.length > 80) x.refs.shift();
        x.balance = Math.round((x.balance + o.reward) * 100) / 100;
        x.earned = Math.round((x.earned + o.reward) * 100) / 100;
        x.ok += 1;
        x.streak = 0;
        hist(x, oid, o.reward, 'approved');
      }
      return { ...x };
    });
    await liveDel(oid);
    if (u) {
      await bump(uid, u.name, { ok: 1, earn: o.reward }, { ok: 1, earn: o.reward });
      await send(uid, `✅ <b>Order #${oid} approved</b>\n+${money(o.reward)} added to your wallet.\nBalance: <b>${money(u.balance)}</b>`);
    }
    if (o.adminMsg) await edit(A, o.adminMsg, `✅ <b>True</b> — order #${oid} · ${esc(o.claimName)} · ${money(o.reward)}`);
    return o;
  }

  async function rejectOrder(oid) {
    const o = await updO(oid, (d) => {
      if (d.status !== 'processing') skip();
      d.status = 'rejected';
      d.verifiedAt = now();
      return { ...d };
    });
    if (!o) return null;
    const cfg = await getCfg();
    const uid = o.claimedBy;
    let banned = false;
    let warned = false;
    const u = await updU(uid, (x) => {
      x.bad += 1;
      x.streak += 1;
      hist(x, oid, o.reward, 'false');
      if (x.streak >= cfg.banAfter && x.status === 'approved') {
        x.status = 'blocked';
        banned = true;
      } else if (x.streak >= cfg.warnAfter && x.status === 'approved') warned = true;
      return { ...x };
    });
    await liveDel(oid);
    if (u) {
      await bump(uid, u.name, { fail: 1 }, { fail: 1 });
      await send(uid, `❌ <b>Order #${oid} was marked false</b> by the admin.\nNo payment for this order.`);
      if (warned) {
        await send(uid, `⚠️ <b>Warning</b>\nYou have ${u.streak} false orders in a row. After ${cfg.banAfter} in a row your access will be blocked. Please complete orders carefully.`);
        await send(A, `⚠️ ${esc(u.name)} has ${u.streak} false in a row (ban at ${cfg.banAfter}). The worker was warned.`);
      }
      if (banned) {
        await send(uid, `⛔ <b>You are blocked</b> after ${u.streak} false orders in a row. Contact the admin.`, { reply_markup: { remove_keyboard: true } });
        await send(A, `⛔ ${esc(u.name)} was <b>auto-blocked</b> after ${u.streak} false in a row.`, { reply_markup: ik([[btn('Unblock', `ub:${u.id}`)]]) });
      }
    }
    if (o.adminMsg) await edit(A, o.adminMsg, `❌ <b>False</b> — order #${oid} · ${esc(o.claimName)} · ${money(o.reward)}`);
    return o;
  }

  // ---------- timeouts / sweeping ----------
  async function timeoutOrder(oid) {
    const o = await updO(oid, (d) => {
      if (d.status !== 'claimed') skip();
      d.status = 'timeout';
      return { ...d };
    });
    if (!o) return;
    const u = await updU(o.claimedBy, (x) => {
      x.active = x.active.filter((i) => i !== oid);
      x.to = (x.to || 0) + 1;
      hist(x, oid, o.reward, 'timeout');
      return { ...x };
    });
    await liveDel(oid);
    await bump(null, '', {}, { timeout: 1 });
    await send(o.claimedBy, `⌛ <b>Time is over for order #${oid}.</b>\nIt was closed and is not paid. Claim the next one in time.`);
    await send(A, `⌛ Timeout — order #${oid} · ${esc(u ? u.name : o.claimName)} did not finish in time.`, { disable_notification: true });
  }

  async function missOrder(oid) {
    const o = await updO(oid, (d) => {
      if (d.status !== 'open') skip();
      d.status = 'missed';
      d.pendingTo = [];
      return { ...d };
    });
    if (!o) return;
    await liveDel(oid);
    await bump(null, '', {}, { missed: 1 });
    await closeBroadcast(o);
    await send(A, `⌛ Order #${oid} (${money(o.reward)}) closed — nobody claimed it.`, { disable_notification: true });
  }

  async function sweep() {
    const t = now();
    const live = (await getJSON('bot/live')) || { ids: [] };
    for (const id of live.ids) {
      const o = await getJSON(O(id));
      if (!o) {
        await liveDel(id);
        continue;
      }
      if (o.status === 'open' && o.deadline <= t) await missOrder(id);
      else if (o.status === 'claimed' && t >= o.deadline + GRACE) await timeoutOrder(id);
      else if (o.status === 'claimed' && !o.reminded && o.deadline - t <= REMIND) {
        const r = await updO(id, (d) => {
          if (d.status !== 'claimed' || d.reminded) skip();
          d.reminded = true;
          return { ...d };
        });
        if (r) await send(r.claimedBy, `⏰ <b>About 1 minute left</b> for order #${id}!\nTap I done when you finish.`);
      }
    }
    await drain(5000);
    await dailyPost();
  }

  async function dailyPost() {
    const t = now();
    if (istHour(t) < 21) return;
    const day = istDate(t);
    const won = await updCfg((c) => {
      if (c.lastPost === day) skip();
      c.lastPost = day;
      return true;
    }).catch((e) => (e instanceof Skip ? null : Promise.reject(e)));
    if (!won) return;
    const board = await boardText('today', null);
    const workers = await approvedIds();
    await many(workers, (uid) => send(uid, `${board}\n\nGreat work today! 👏`, { reply_markup: boardKb(false) }));
    await send(A, `📅 <b>Daily summary</b>\n\n${await reportText()}\n\n${await failedText()}`);
    // keep storage small: drop day documents older than 40 days (the all-time board is kept separately)
    const cutoff = istDate(t - 40 * 86400000);
    for (const k of await listKeys('bot/day/')) if (k.slice(8) < cutoff) await remove(k);
  }

  async function reportText() {
    const day = (await getJSON(`bot/day/${istDate(now())}`)) || { u: {}, t: {} };
    const x = day.t;
    const users = await allUsers();
    const pendingV = (await processing()).length;
    const wds = await pendingWithdrawals();
    const approved = users.filter((u) => u.status === 'approved').length;
    return (
      `📊 <b>Today</b> · ${istDate(now())}\n` +
      `Orders added: ${x.added || 0}\nClaimed: ${x.claimed || 0}\n✅ True: ${x.ok || 0} (${money(x.earn || 0)})\n❌ False: ${x.fail || 0}\n🚫 QR expired: ${x.exp || 0}\n⌛ Timeout: ${x.timeout || 0}\n💤 Nobody claimed: ${x.missed || 0}\n\n` +
      `To verify now: ${pendingV}\nPending withdrawals: ${wds.length} (${money(wds.reduce((s, w) => s + w.amount, 0))})\n` +
      `Workers: ${approved} approved · ${users.filter((u) => u.status === 'pending').length} waiting · ${users.filter((u) => u.status === 'blocked').length} blocked`
    );
  }

  // ---------- withdrawals ----------
  const wdText = (w) => `💸 <b>Withdrawal #${w.id}</b>\n👤 ${esc(w.name)}\nAmount: <b>${money(w.amount)}</b>\nUPI: <code>${esc(w.upi)}</code>`;
  const wdKb = (w) => ik([[btn('Paid ✅', `wp:${w.id}`), btn('Failed ❌', `wf:${w.id}`)]]);
  async function pendingWithdrawals() {
    const keys = await listKeys('bot/w/');
    const rows = await Promise.all(keys.map((k) => getJSON(k)));
    return rows.filter((w) => w && w.status === 'pending').sort((a, b) => a.at - b.at);
  }
  async function requestWithdraw(u, amount) {
    const cfg = await getCfg();
    if (!(amount >= cfg.minWd)) return `The minimum withdrawal is ${money(cfg.minWd)}.`;
    if (amount > u.balance + 1e-9) return 'You do not have that much balance.';
    if (u.pendingW) return 'You already have a withdrawal waiting for payment.';
    const wid = String(await updCfg((c) => ++c.wSeq));
    const ok = await updU(u.id, (x) => {
      if (x.status !== 'approved') skip();
      if (x.pendingW) throw new ApiError(409, 'PENDING');
      if (amount > x.balance + 1e-9) throw new ApiError(409, 'LOW');
      x.balance = Math.round((x.balance - amount) * 100) / 100;
      x.pendingW = wid;
      x.state = null;
      return { ...x };
    }).catch((e) => (e instanceof ApiError ? e.message : Promise.reject(e)));
    if (ok === 'PENDING') return 'You already have a withdrawal waiting for payment.';
    if (ok === 'LOW') return 'You do not have that much balance.';
    if (!ok) return 'You do not have access.';
    const w = { id: wid, uid: u.id, name: u.name, upi: ok.upi, amount, status: 'pending', at: now() };
    await create(WK(wid), w);
    await send(A, wdText(w), { reply_markup: wdKb(w) });
    return null;
  }
  async function settleWithdraw(wid, paid, cb) {
    const w = await cas(WK(wid), { _m: 1 }, (d) => {
      if (d._m || d.status !== 'pending') skip();
      d.status = paid ? 'paid' : 'failed';
      d.doneAt = now();
      return { ...d };
    });
    if (!w) return ans(cb.id, 'Already handled.', true);
    const u = await updU(w.uid, (x) => {
      x.pendingW = null;
      if (paid) x.paid = Math.round((x.paid + w.amount) * 100) / 100;
      else {
        const ref = `w:${wid}`;
        if (!x.refs.includes(ref)) {
          x.refs.push(ref);
          x.balance = Math.round((x.balance + w.amount) * 100) / 100;
        }
      }
      return { ...x };
    });
    await ans(cb.id, paid ? 'Marked as paid' : 'Marked as failed (refunded)');
    await edit(A, cb.message.message_id, `${paid ? '✅ <b>Paid</b>' : '❌ <b>Failed — refunded</b>'}\n${wdText(w).split('\n').slice(1).join('\n')}`);
    if (u) {
      await send(
        w.uid,
        paid
          ? `✅ <b>Withdrawal paid</b>\n${money(w.amount)} was sent to <code>${esc(w.upi)}</code>.`
          : `❌ <b>Withdrawal failed</b>\n${money(w.amount)} was returned to your wallet (balance ${money(u.balance)}). Check your UPI ID and try again.`
      );
    }
    await bump(null, '', {}, paid ? { paid: w.amount } : {});
  }

  // ---------- worker screens ----------
  async function walletScreen(u) {
    const cfg = await getCfg();
    const t =
      `💰 <b>Wallet</b>\nBalance: <b>${money(u.balance)}</b>\n` +
      (u.pendingW ? `Withdrawal waiting for payment ✔ (#${u.pendingW})\n` : '') +
      `\nTotal earned: ${money(u.earned)}\nPaid out: ${money(u.paid)}\n\n✅ Approved: ${u.ok}   ❌ False: ${u.bad}   🚫 Expired: ${u.exp}` +
      (u.upi ? `\nUPI: <code>${esc(u.upi)}</code>` : '') +
      `\n\nMinimum withdrawal: ${money(cfg.minWd)}`;
    return { text: t, kb: ik([[btn('Withdraw 💸', 'wd')]]) };
  }

  async function ordersScreen(u) {
    const live = (await getJSON('bot/live')) || { ids: [] };
    const rows = (await Promise.all(live.ids.map((id) => getJSON(O(id))))).filter(Boolean);
    const mine = rows.filter((o) => o.status === 'claimed' && o.claimedBy === u.id);
    for (const o of mine) await send(u.id, activeText(o), { reply_markup: activeKb(o) });
    const open = rows.filter((o) => o.status === 'open' && o.deadline > now());
    if (!open.length && !mine.length) return send(u.id, 'No orders right now. You will get a message the moment a new one is added. 🔔');
    if (open.length) {
      const kb = open.slice(0, 10).map((o) => [btn(`Claim #${o.id} · ${money(o.reward)} · ${left(o.deadline - now())} left`, `cl:${o.id}`)]);
      await send(u.id, `📋 <b>${open.length} open order${open.length > 1 ? 's' : ''}</b>`, { reply_markup: ik(kb) });
    }
  }

  function historyText(u) {
    if (!u.hist || !u.hist.length) return '🧾 No orders yet.';
    const icon = { approved: '✅', false: '❌', expired: '🚫', timeout: '⌛', checking: '⏳' };
    return '🧾 <b>Your last orders</b>\n\n' + u.hist.map((h) => `${icon[h.s] || '•'} #${h.id} · ${money(h.r)} · ${h.s} · ${istHM(h.t)}`).join('\n');
  }

  // ---------- joining ----------
  async function onStartWorker(from, chatId) {
    const id = String(from.id);
    let u = await getUser(id);
    if (!u) {
      const all = await allUsers();
      if (all.filter((x) => x.status === 'pending').length >= MAX_PENDING) return send(id, 'Too many requests right now. Please try again later.');
      u = {
        id,
        name: nameOf(from),
        uname: from.username || '',
        status: 'pending',
        at: now(),
        balance: 0,
        earned: 0,
        paid: 0,
        ok: 0,
        bad: 0,
        exp: 0,
        to: 0,
        streak: 0,
        upi: '',
        pendingW: null,
        active: [],
        state: null,
        refs: [],
        hist: [],
      };
      if (!(await create(U(id), u))) u = await getUser(id);
      else return requestApproval(u);
    }
    if (u.status === 'approved') return send(id, 'Welcome back! Use the menu below. 👇', { reply_markup: workerKb() });
    if (u.status === 'blocked') return send(id, '⛔ You are blocked. Please contact the admin.');
    if (u.status === 'rejected') {
      if (now() - (u.rejectedAt || 0) < REJECT_COOLDOWN) return send(id, 'Your request was not approved. You can ask again after about an hour.');
      await updU(id, (x) => {
        x.status = 'pending';
        x.name = nameOf(from);
      });
      return requestApproval({ ...u, name: nameOf(from) });
    }
    return send(id, '⏳ Your request is waiting for the admin to approve it. You will get a message here.');
  }
  async function requestApproval(u) {
    await send(u.id, '👋 Welcome! Your request was sent to the admin.\n⏳ Please wait until it is approved. You will get a message here.');
    await send(A, `🆕 <b>Join request</b>\n${esc(u.name)}${u.uname ? ' (@' + esc(u.uname) + ')' : ''}\nID: <code>${u.id}</code>`, {
      reply_markup: ik([[btn('Approve ✅', `ap:${u.id}`), btn('Reject ❌', `rj:${u.id}`)]]),
    });
  }

  // ---------- admin screens ----------
  async function settingsScreen() {
    const c = await getCfg();
    const t =
      `⚙️ <b>Settings</b>\n\nOrder time: <b>${mins(c.orderSecs)}</b> (the same clock for claiming and working)\n` +
      `Min time left to claim: <b>${c.minClaimSecs} sec</b>\nMinimum withdrawal: <b>${money(c.minWd)}</b>\n` +
      `Warn after: <b>${c.warnAfter}</b> false in a row\nBan after: <b>${c.banAfter}</b> false in a row\n` +
      `Orders per worker at once: <b>${c.maxActive}</b>\nReward buttons: <b>${c.rewards.map(money).join(', ')}</b>\n\nTap a setting to change it.`;
    const kb = Object.entries(SETTINGS).map(([k, s]) => [btn(s.label, `st:${k}`)]);
    return { text: t, kb: ik(kb) };
  }
  async function applySetting(key, raw) {
    const s = SETTINGS[key];
    const c = await getCfg();
    if (s.list) {
      const list = raw.split(/[ ,]+/).map(Number).filter((n) => n > 0 && n <= 100000);
      if (!list.length || list.length > 6) return 'Send 1 to 6 amounts, for example 15,20,25.';
      await updCfg((x) => void (x.rewards = list));
      return null;
    }
    const v = Number(raw.replace(/[₹, ]/g, ''));
    if (!Number.isFinite(v) || v < s.min || v > s.max) return `Please send a number between ${s.min} and ${s.max}.`;
    if (key === 'banAfter' && v <= c.warnAfter) return `Ban must be higher than the warning count (${c.warnAfter}).`;
    if (key === 'warnAfter' && v >= c.banAfter) return `Warning must be lower than the ban count (${c.banAfter}).`;
    if (key === 'minClaim' && v >= c.orderSecs) return 'That is longer than the order time.';
    if (key === 'orderMin' && v * 60 <= c.minClaimSecs) return `That is not longer than the minimum claim time (${c.minClaimSecs} sec).`;
    await updCfg((x) => {
      if (key === 'orderMin') x.orderSecs = Math.round(v * 60);
      else if (key === 'minClaim') x.minClaimSecs = Math.round(v);
      else if (key === 'minWd') x.minWd = v;
      else if (key === 'warnAfter') x.warnAfter = Math.round(v);
      else if (key === 'banAfter') x.banAfter = Math.round(v);
      else if (key === 'maxActive') x.maxActive = Math.round(v);
    });
    return null;
  }

  async function workersScreen() {
    const users = (await allUsers()).filter((u) => u.id !== A);
    const by = (s) => users.filter((u) => u.status === s);
    const kb = [];
    if (by('pending').length) kb.push([btn(`🕒 Join requests (${by('pending').length})`, 'pl')]);
    const list = [...by('approved'), ...by('blocked')];
    for (let i = 0; i < list.length; i += 2) {
      kb.push(list.slice(i, i + 2).map((u) => btn(`${u.status === 'blocked' ? '⛔ ' : ''}${clip(u.name, 16)} · ${money(u.balance)}`, `wk:${u.id}`)));
    }
    return {
      text: `👥 <b>Workers</b>\n${by('approved').length}/${MAX_WORKERS} approved · ${by('pending').length} waiting · ${by('blocked').length} blocked`,
      kb: ik(kb),
    };
  }
  function workerCard(u) {
    const t =
      `👤 <b>${esc(u.name)}</b>${u.uname ? ' (@' + esc(u.uname) + ')' : ''}\nID: <code>${u.id}</code>\nStatus: <b>${u.status}</b>\n\n` +
      `Balance: ${money(u.balance)} · Earned: ${money(u.earned)} · Paid: ${money(u.paid)}\n✅ ${u.ok}  ❌ ${u.bad}  🚫 ${u.exp}  ⌛ ${u.to || 0}\nFalse in a row: ${u.streak}` +
      (u.upi ? `\nUPI: <code>${esc(u.upi)}</code>` : '');
    const kb = [[u.status === 'blocked' ? btn('Unblock ✅', `ub:${u.id}`) : btn('Block ⛔', `bl:${u.id}`), btn('Remove 🗑', `rm:${u.id}`)], [btn('⬅️ Workers', 'wl')]];
    return { text: t, kb: ik(kb) };
  }

  // ---------- message router ----------
  async function onMessage(m) {
    if (!m.chat || m.chat.type !== 'private' || !m.from || m.from.is_bot) return;
    const uid = String(m.from.id);
    const text = (m.text || '').trim();
    if (uid === A) return adminMessage(m, text);
    return workerMessage(m, uid, text);
  }

  async function workerMessage(m, uid, text) {
    const u = await getUser(uid);
    if (!u || u.status !== 'approved' || text.startsWith('/start')) return onStartWorker(m.from, uid);
    if (text === '/menu' || text === '/help') return send(uid, 'Use the menu below. 👇', { reply_markup: workerKb() });
    if (text === '/cancel') {
      await setState(uid, null);
      return send(uid, 'Cancelled.', { reply_markup: workerKb() });
    }
    if (LABELS.has(text) && u.state) await setState(uid, null);
    if (text === W_ORD) return ordersScreen(u);
    if (text === W_WAL) {
      const s = await walletScreen(u);
      return send(uid, s.text, { reply_markup: s.kb });
    }
    if (text === W_LB) return send(uid, await boardText('today', uid), { reply_markup: boardKb(false) });
    if (text === W_HIS) return send(uid, historyText(u));
    if (u.state && u.state.t === 'upi') {
      const upi = text.replace(/\s/g, '');
      if (!/^[\w.\-]{2,64}@[A-Za-z][A-Za-z0-9]{1,32}$/.test(upi)) return send(uid, 'That does not look like a UPI ID. Example: name@okhdfcbank\nSend it again, or /cancel.');
      await updU(uid, (x) => {
        x.upi = upi;
        x.state = { t: 'amt' };
      });
      return send(uid, `Saved <code>${esc(upi)}</code>.\nNow send the amount to withdraw (your balance is ${money(u.balance)}).`);
    }
    if (u.state && u.state.t === 'amt') {
      const amount = Number(text.replace(/[₹, ]/g, ''));
      if (!Number.isFinite(amount) || amount <= 0) return send(uid, 'Send the amount as a number, for example 150. Or /cancel.');
      const err = await requestWithdraw(u, Math.round(amount * 100) / 100);
      if (err) return send(uid, `${err}\nSend another amount or /cancel.`);
      return send(uid, `✅ Withdrawal of ${money(amount)} requested. The admin will pay it to <code>${esc(u.upi)}</code>. You will get a message here.`, { reply_markup: workerKb() });
    }
    return send(uid, 'Use the menu below. 👇', { reply_markup: workerKb() });
  }

  async function adminMessage(m, text) {
    let a = await getUser(A);
    if (!a) {
      await create(U(A), { id: A, name: 'Admin', status: 'admin', state: null, active: [], refs: [], hist: [], balance: 0 });
      a = await getUser(A);
    }
    if (text.startsWith('/start') || text === '/menu' || text === '/help') {
      await setState(A, null);
      return send(
        A,
        '👑 <b>Admin panel</b>\nUse the menu below.\n\nCommands:\n/broadcast <i>message</i> — send a message to all workers\n/cancel — cancel what you are typing',
        { reply_markup: adminKb() }
      );
    }
    if (text === '/cancel') {
      await setState(A, null);
      return send(A, 'Cancelled.', { reply_markup: adminKb() });
    }
    if (text.startsWith('/broadcast')) {
      const body = text.slice(10).trim();
      if (!body) return send(A, 'Write it like this:\n/broadcast Server will be slow tonight');
      const workers = await approvedIds();
      await many(workers, (uid) => send(uid, `📢 <b>Announcement</b>\n\n${esc(body)}`));
      return send(A, `📢 Sent to ${workers.length} workers.`);
    }
    if (LABELS.has(text) && a.state) {
      await setState(A, null);
      a.state = null;
    }
    if (text === A_VER) {
      const q = await processing();
      if (!q.length) return send(A, '✅ Nothing waiting to be verified.');
      await send(A, `🔎 <b>${q.length} order${q.length > 1 ? 's' : ''} to verify</b>`, { reply_markup: ik([[btn(`Mark all true (${q.length}) ✅`, 'va')]]) });
      for (const o of q.slice(0, 15)) {
        const id = await send(A, verifyText(o), { reply_markup: verifyKb(o) });
        if (id) await updO(o.id, (d) => void (d.adminMsg = id));
      }
      return null;
    }
    if (text === A_ADD) {
      const c = await getCfg();
      const kb = [c.rewards.map((r) => btn(money(r), `ar:${r}`)), [btn('Other amount', 'ar:c')]];
      return send(A, `➕ <b>Add orders</b>\nOrder time is ${mins(c.orderSecs)}.\n\nChoose the reward for these orders:`, { reply_markup: ik(kb) });
    }
    if (text === A_WD) {
      const list = await pendingWithdrawals();
      if (!list.length) return send(A, '💸 No withdrawals waiting.');
      for (const w of list.slice(0, 20)) await send(A, wdText(w), { reply_markup: wdKb(w) });
      return null;
    }
    if (text === A_WK) {
      const s = await workersScreen();
      return send(A, s.text, { reply_markup: s.kb });
    }
    if (text === W_LB) return send(A, await boardText('today', null), { reply_markup: boardKb(true) });
    if (text === A_SET) {
      const s = await settingsScreen();
      return send(A, s.text, { reply_markup: s.kb });
    }
    if (text === A_REP) {
      const live = (await getJSON('bot/live')) || { ids: [] };
      const rows = (await Promise.all(live.ids.map((id) => getJSON(O(id))))).filter((o) => o && (o.status === 'open' || o.status === 'claimed'));
      const kb = rows.filter((o) => o.status === 'open').slice(0, 10).map((o) => [btn(`Cancel open order #${o.id}`, `oc:${o.id}`)]);
      const lines = rows.map((o) => `#${o.id} · ${money(o.reward)} · ${o.status}${o.status === 'claimed' ? ' by ' + esc(o.claimName) : ''} · ${left(o.deadline - now())} left`);
      return send(A, `${await reportText()}${lines.length ? '\n\n<b>Live orders</b>\n' + lines.join('\n') : ''}`, { reply_markup: kb.length ? ik(kb) : undefined });
    }
    // typed input for the current step
    const st = a.state;
    if (st && st.t === 'creward') {
      const v = Number(text.replace(/[₹, ]/g, ''));
      if (!Number.isFinite(v) || v <= 0 || v > 100000) return send(A, 'Send the reward as a number, for example 30. Or /cancel.');
      await setState(A, { t: 'links', reward: v });
      return send(A, `Reward ${money(v)}.\nNow paste the links, <b>one per line</b> (up to ${MAX_LINKS}).`);
    }
    if (st && st.t === 'links') {
      const links = [...new Set(text.split('\n').map((x) => x.trim()).filter(Boolean))].map((x) => clip(x, 500));
      if (!links.length) return send(A, 'Paste at least one link. Or /cancel.');
      if (links.length > MAX_LINKS) return send(A, `Too many at once — send up to ${MAX_LINKS} links per message.`);
      await setState(A, null);
      const r = await addOrders(links, st.reward);
      if (!r.workers) await send(A, '⚠️ There are no approved workers yet, so nobody was notified.');
      else await send(A, `✅ Added ${r.ids.length} order${r.ids.length > 1 ? 's' : ''} (${money(st.reward)} each). Sending to ${r.workers} workers…`, { reply_markup: adminKb() });
      const d = await drain(6500);
      if (d.left > 0 && kick) await kick();
      return null;
    }
    if (st && st.t === 'set') {
      const err = await applySetting(st.key, text);
      if (err) return send(A, `${err}\nTry again or /cancel.`);
      await setState(A, null);
      const s = await settingsScreen();
      return send(A, `✅ Saved.\n\n${s.text}`, { reply_markup: s.kb });
    }
    return send(A, 'Use the menu below. 👇', { reply_markup: adminKb() });
  }

  // ---------- callback router ----------
  const ADMIN_KEYS = new Set(['ap', 'rj', 'bl', 'ub', 'rm', 'rmy', 'vt', 'vf', 'va', 'vay', 'vac', 'wp', 'wf', 'st', 'ar', 'rl', 'rly', 'lbf', 'oc', 'pl', 'wk', 'wl']);

  async function onCallback(cb) {
    const uid = String(cb.from.id);
    const [k, a] = String(cb.data || '').split(':');
    const msg = cb.message;
    if (ADMIN_KEYS.has(k) && uid !== A) return ans(cb.id, 'Not allowed.', true);
    switch (k) {
      case 'cl':
        return claim(uid, a, cb);
      case 'dn':
        return onDone(uid, a, cb, false);
      case 'dy':
        return onDone(uid, a, cb, true);
      case 'ex':
        return onExpired(uid, a, cb, false);
      case 'ey':
        return onExpired(uid, a, cb, true);
      case 'bk': {
        const o = await getJSON(O(a));
        if (!o || o.claimedBy !== uid || o.status !== 'claimed') return ans(cb.id, 'This order is not active any more.', true);
        await ans(cb.id);
        return edit(msg.chat.id, msg.message_id, activeText(o), activeKb(o));
      }
      case 'lb': {
        if (!TITLES[a]) return ans(cb.id);
        await ans(cb.id);
        const isA = uid === A;
        return edit(msg.chat.id, msg.message_id, await boardText(a, isA ? null : uid), boardKb(isA));
      }
      case 'wd': {
        const u = await getUser(uid);
        if (!u || u.status !== 'approved') return ans(cb.id, 'You do not have access.', true);
        const c = await getCfg();
        if (u.pendingW) return ans(cb.id, 'You already have a withdrawal waiting for payment.', true);
        if (u.balance < c.minWd) return ans(cb.id, `Minimum withdrawal is ${money(c.minWd)}. Your balance is ${money(u.balance)}.`, true);
        await ans(cb.id);
        if (u.upi) {
          await setState(uid, { t: 'amt' });
          return send(uid, `Withdraw to <code>${esc(u.upi)}</code>?\nSend the amount (${money(c.minWd)} – ${money(u.balance)}), or change the UPI ID.`, { reply_markup: ik([[btn('Change UPI ID', 'wu')]]) });
        }
        await setState(uid, { t: 'upi' });
        return send(uid, 'Send your <b>UPI ID</b> (example: name@okhdfcbank). Or /cancel.');
      }
      case 'wu':
        await setState(uid, { t: 'upi' });
        await ans(cb.id);
        return send(uid, 'Send your new <b>UPI ID</b>. Or /cancel.');
      // ----- admin -----
      case 'ap': {
        const users = await allUsers();
        if (users.filter((x) => x.status === 'approved').length >= MAX_WORKERS) return ans(cb.id, `Worker limit (${MAX_WORKERS}) reached.`, true);
        const u = await updU(a, (x) => {
          if (x.status === 'approved') skip();
          x.status = 'approved';
          x.streak = 0;
          return { ...x };
        });
        if (!u) return ans(cb.id, 'Already approved.', true);
        await ans(cb.id, 'Approved ✅');
        await edit(msg.chat.id, msg.message_id, `✅ Approved <b>${esc(u.name)}</b>`);
        return send(a, '✅ <b>You are approved!</b>\nNew orders will arrive here the moment they are added. Keep notifications on. 🔔', { reply_markup: workerKb() });
      }
      case 'rj': {
        const u = await updU(a, (x) => {
          if (x.status === 'rejected' || x.status === 'blocked') skip();
          x.status = 'rejected';
          x.rejectedAt = now();
          return { ...x };
        });
        if (!u) return ans(cb.id, 'Already done.', true);
        await ans(cb.id, 'Rejected');
        await edit(msg.chat.id, msg.message_id, `❌ Rejected <b>${esc(u.name)}</b>`);
        return send(a, 'Sorry, your request was not approved.', { reply_markup: { remove_keyboard: true } });
      }
      case 'bl':
      case 'ub': {
        const block = k === 'bl';
        const u = await updU(a, (x) => {
          if (block ? x.status !== 'approved' : x.status !== 'blocked') skip();
          x.status = block ? 'blocked' : 'approved';
          if (!block) x.streak = 0;
          return { ...x };
        });
        if (!u) return ans(cb.id, block ? 'Not an active worker.' : 'Not blocked.', true);
        await ans(cb.id, block ? 'Blocked' : 'Unblocked');
        const c = workerCard(u);
        await edit(msg.chat.id, msg.message_id, c.text, c.kb);
        return send(a, block ? '⛔ You were blocked by the admin.' : '✅ You were unblocked. Welcome back!', block ? { reply_markup: { remove_keyboard: true } } : { reply_markup: workerKb() });
      }
      case 'rm':
        await ans(cb.id);
        return edit(msg.chat.id, msg.message_id, 'Remove this worker? They can ask to join again after an hour. Their balance stays saved.', ik([[btn('Yes, remove', `rmy:${a}`), btn('Cancel', `wk:${a}`)]]));
      case 'rmy': {
        const u = await updU(a, (x) => {
          x.status = 'rejected';
          x.rejectedAt = now();
          return { ...x };
        });
        await ans(cb.id, 'Removed');
        if (u) await send(a, 'You were removed by the admin.', { reply_markup: { remove_keyboard: true } });
        const s = await workersScreen();
        return edit(msg.chat.id, msg.message_id, s.text, s.kb);
      }
      case 'wl': {
        await ans(cb.id);
        const s = await workersScreen();
        return edit(msg.chat.id, msg.message_id, s.text, s.kb);
      }
      case 'wk': {
        const u = await getUser(a);
        if (!u) return ans(cb.id, 'Not found.', true);
        await ans(cb.id);
        const c = workerCard(u);
        return edit(msg.chat.id, msg.message_id, c.text, c.kb);
      }
      case 'pl': {
        await ans(cb.id);
        const pend = (await allUsers()).filter((x) => x.status === 'pending');
        if (!pend.length) return send(A, 'No join requests waiting.');
        for (const u of pend.slice(0, 15)) await requestApprovalCard(u);
        return null;
      }
      case 'vt':
      case 'vf': {
        const o = k === 'vt' ? await approveOrder(a) : await rejectOrder(a);
        return ans(cb.id, o ? (k === 'vt' ? 'True ✅' : 'False ❌') : 'Already checked.', !o);
      }
      case 'va': {
        const q = await processing();
        if (!q.length) return ans(cb.id, 'Nothing to verify.', true);
        await ans(cb.id);
        return edit(msg.chat.id, msg.message_id, `Mark all ${q.length} orders as <b>True</b> and pay the workers?`, ik([[btn('Yes, mark all true ✅', 'vay'), btn('Cancel', 'vac')]]));
      }
      case 'vac':
        await ans(cb.id);
        return edit(msg.chat.id, msg.message_id, 'Cancelled.');
      case 'vay': {
        await ans(cb.id, 'Working…');
        const q = await processing();
        let n = 0;
        await many(q, async (o) => void ((await approveOrder(o.id)) && n++), 10);
        return edit(msg.chat.id, msg.message_id, `✅ Marked ${n} order${n === 1 ? '' : 's'} as true.`);
      }
      case 'wp':
        return settleWithdraw(a, true, cb);
      case 'wf':
        return settleWithdraw(a, false, cb);
      case 'st': {
        const s = SETTINGS[a];
        if (!s) return ans(cb.id);
        await setState(A, { t: 'set', key: a });
        await ans(cb.id);
        return send(A, `${s.ask}\n\n/cancel to stop.`);
      }
      case 'ar': {
        await ans(cb.id);
        if (a === 'c') {
          await setState(A, { t: 'creward' });
          return edit(msg.chat.id, msg.message_id, 'Send the reward amount in ₹ (for example 30).');
        }
        const v = Number(a);
        await setState(A, { t: 'links', reward: v });
        return edit(msg.chat.id, msg.message_id, `Reward <b>${money(v)}</b>.\nNow paste the links, <b>one per line</b> (up to ${MAX_LINKS}).`);
      }
      case 'lbf':
        await ans(cb.id);
        return edit(msg.chat.id, msg.message_id, await failedText(), boardKb(true));
      case 'rl':
        await ans(cb.id);
        return edit(msg.chat.id, msg.message_id, '♻️ <b>Reset the leaderboard?</b>\nThis clears the rankings (today, week, month, all time). Balances, payments and history are NOT touched.', ik([[btn('Yes, reset', 'rly'), btn('Cancel', 'lb:today')]]));
      case 'rly': {
        for (const key of await listKeys('bot/day/')) await remove(key);
        await update('bot/lbAll', { u: {} }, (d) => void (d.u = {}));
        await updCfg((c) => void (c.lbResetAt = now()));
        await ans(cb.id, 'Leaderboard reset');
        return edit(msg.chat.id, msg.message_id, '♻️ Leaderboard was reset. Balances and history are unchanged.', boardKb(true));
      }
      case 'oc': {
        const o = await updO(a, (d) => {
          if (d.status !== 'open') skip();
          d.status = 'cancelled';
          d.pendingTo = [];
          return { ...d };
        });
        if (!o) return ans(cb.id, 'That order is not open any more.', true);
        await liveDel(a);
        await ans(cb.id, 'Cancelled');
        await edit(msg.chat.id, msg.message_id, `🚫 Order #${a} cancelled.`);
        return closeBroadcast(o);
      }
      default:
        return ans(cb.id);
    }
  }
  const requestApprovalCard = (u) =>
    send(A, `🆕 <b>Join request</b>\n${esc(u.name)}${u.uname ? ' (@' + esc(u.uname) + ')' : ''}\nID: <code>${u.id}</code>`, {
      reply_markup: ik([[btn('Approve ✅', `ap:${u.id}`), btn('Reject ❌', `rj:${u.id}`)]]),
    });

  // ---------- entry point ----------
  const seen = new Set();
  async function handleUpdate(upd) {
    if (!upd || typeof upd.update_id !== 'number') return;
    if (seen.has(upd.update_id)) return;
    seen.add(upd.update_id);
    if (seen.size > 500) seen.delete(seen.values().next().value);
    try {
      if (upd.callback_query) await onCallback(upd.callback_query);
      else if (upd.message) await onMessage(upd.message);
    } catch (e) {
      console.error('bot error:', e && e.message);
      if (upd.callback_query) await ans(upd.callback_query.id, 'Something went wrong. Please try again.', true);
    }
    // housekeeping rides along with every message: expired orders, reminders, daily post
    try {
      await sweep();
    } catch (e) {
      console.error('sweep error:', e && e.message);
    }
  }

  return { handleUpdate, sweep, drain, _t: { addOrders, boardText, reportText } };
}

// Real Telegram client for the Netlify functions. The token is only read from the environment.
export function botFromEnv(origin) {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error('BOT_TOKEN is not set');
  const tg = async (method, params) => {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params || {}),
    });
    return r.json();
  };
  const base = process.env.URL || origin;
  const kick = base
    ? async () => {
        try {
          await fetch(`${base}/tg?kick=1`, { headers: { 'x-kick': webhookSecret(token) }, signal: AbortSignal.timeout(1500) });
        } catch {}
      }
    : null;
  return { tg, kick, bot: createBot({ tg, adminId: process.env.ADMIN_CHAT_ID || DEFAULT_ADMIN, kick }) };
}

export const webhookSecret = (token) => createHash('sha256').update(token).digest('hex').slice(0, 32);
