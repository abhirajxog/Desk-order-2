(() => {
  'use strict';

  const $app = document.getElementById('app');
  const $toasts = document.getElementById('toasts');
  const $dlg = document.getElementById('dlg');

  // ------------------------------------------------------------------ state
  const freshAdmin = () => ({
    tab: 'verify', data: null, workers: null, history: null, month: '', filter: 'all',
    as: null, asName: '', admins: null, everyone: null,
  });
  const S = {
    role: null,
    token: null,
    skew: 0,
    tab: 'orders', // worker tab
    data: null, // worker data
    draft: {},
    notice: '',
    animate: false, // set before a render that should play the entrance animation
    entering: false, // true while that render is being built
    shownBalance: null, // balance on screen, used for the count-up
    seen: new Set(), // ids already shown, so only new ones pop in
    admin: freshAdmin(),
  };

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  // --------------------------------------------------------------- helpers
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    const add = (c) => {
      if (c === null || c === undefined || c === false) return;
      if (Array.isArray(c)) return c.forEach(add);
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    };
    kids.forEach(add);
    return el;
  }

  const NS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs, ...kids) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) el.setAttribute(k, v);
    kids.forEach((c) => c && el.append(c));
    return el;
  }

  // Line icons (Lucide, ISC license), see icons.js
  const ICONS = {"ticket":[["path",{"d":"M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"}],["path",{"d":"M13 5v2"}],["path",{"d":"M13 17v2"}],["path",{"d":"M13 11v2"}]],"wallet":[["path",{"d":"M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"}],["path",{"d":"M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"}]],"history":[["path",{"d":"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"}],["path",{"d":"M3 3v5h5"}],["path",{"d":"M12 7v5l4 2"}]],"checkCircle":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"m9 12 2 2 4-4"}]],"xCircle":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"m15 9-6 6"}],["path",{"d":"m9 9 6 6"}]],"rupee":[["path",{"d":"M6 3h12"}],["path",{"d":"M6 8h12"}],["path",{"d":"m6 13 8.5 8"}],["path",{"d":"M6 13h3"}],["path",{"d":"M9 13c6.667 0 6.667-10 0-10"}]],"users":[["path",{"d":"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"}],["circle",{"cx":"9","cy":"7","r":"4"}],["path",{"d":"M22 21v-2a4 4 0 0 0-3-3.87"}],["path",{"d":"M16 3.13a4 4 0 0 1 0 7.75"}]],"sliders":[["line",{"x1":"21","x2":"14","y1":"4","y2":"4"}],["line",{"x1":"10","x2":"3","y1":"4","y2":"4"}],["line",{"x1":"21","x2":"12","y1":"12","y2":"12"}],["line",{"x1":"8","x2":"3","y1":"12","y2":"12"}],["line",{"x1":"21","x2":"16","y1":"20","y2":"20"}],["line",{"x1":"12","x2":"3","y1":"20","y2":"20"}],["line",{"x1":"14","x2":"14","y1":"2","y2":"6"}],["line",{"x1":"8","x2":"8","y1":"10","y2":"14"}],["line",{"x1":"16","x2":"16","y1":"18","y2":"22"}]],"shield":[["path",{"d":"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"}],["path",{"d":"m9 12 2 2 4-4"}]],"globe":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"}],["path",{"d":"M2 12h20"}]],"copy":[["rect",{"width":"14","height":"14","x":"8","y":"8","rx":"2","ry":"2"}],["path",{"d":"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"}]],"external":[["path",{"d":"M15 3h6v6"}],["path",{"d":"M10 14 21 3"}],["path",{"d":"M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"}]],"logout":[["path",{"d":"M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"}],["polyline",{"points":"16 17 21 12 16 7"}],["line",{"x1":"21","x2":"9","y1":"12","y2":"12"}]],"plus":[["path",{"d":"M5 12h14"}],["path",{"d":"M12 5v14"}]],"key":[["path",{"d":"M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"}],["circle",{"cx":"16.5","cy":"7.5","r":".5","fill":"currentColor"}]],"ban":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"m4.9 4.9 14.2 14.2"}]],"trash":[["path",{"d":"M3 6h18"}],["path",{"d":"M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"}],["path",{"d":"M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"}],["line",{"x1":"10","x2":"10","y1":"11","y2":"17"}],["line",{"x1":"14","x2":"14","y1":"11","y2":"17"}]],"clock":[["circle",{"cx":"12","cy":"12","r":"10"}],["polyline",{"points":"12 6 12 12 16 14"}]],"hourglass":[["path",{"d":"M5 22h14"}],["path",{"d":"M5 2h14"}],["path",{"d":"M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"}],["path",{"d":"M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"}]],"sparkles":[["path",{"d":"M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"}],["path",{"d":"M20 3v4"}],["path",{"d":"M22 5h-4"}],["path",{"d":"M4 17v2"}],["path",{"d":"M5 18H3"}]],"eye":[["path",{"d":"M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"}],["circle",{"cx":"12","cy":"12","r":"3"}]],"eyeOff":[["path",{"d":"M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"}],["path",{"d":"M14.084 14.158a3 3 0 0 1-4.242-4.242"}],["path",{"d":"M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"}],["path",{"d":"m2 2 20 20"}]],"check":[["path",{"d":"M20 6 9 17l-5-5"}]],"x":[["path",{"d":"M18 6 6 18"}],["path",{"d":"m6 6 12 12"}]],"qr":[["rect",{"width":"5","height":"5","x":"3","y":"3","rx":"1"}],["rect",{"width":"5","height":"5","x":"16","y":"3","rx":"1"}],["rect",{"width":"5","height":"5","x":"3","y":"16","rx":"1"}],["path",{"d":"M21 16h-3a2 2 0 0 0-2 2v3"}],["path",{"d":"M21 21v.01"}],["path",{"d":"M12 7v3a2 2 0 0 1-2 2H7"}],["path",{"d":"M3 12h.01"}],["path",{"d":"M12 3h.01"}],["path",{"d":"M12 16v.01"}],["path",{"d":"M16 12h1"}],["path",{"d":"M21 12v.01"}],["path",{"d":"M12 21v-1"}]],"inbox":[["polyline",{"points":"22 12 16 12 14 15 10 15 8 12 2 12"}],["path",{"d":"M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"}]],"clipboard":[["rect",{"width":"8","height":"4","x":"8","y":"2","rx":"1","ry":"1"}],["path",{"d":"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"}],["path",{"d":"m9 14 2 2 4-4"}]],"banknote":[["rect",{"width":"20","height":"12","x":"2","y":"6","rx":"2"}],["circle",{"cx":"12","cy":"12","r":"2"}],["path",{"d":"M6 12h.01M18 12h.01"}]],"chevron":[["path",{"d":"m9 18 6-6-6-6"}]],"timer":[["line",{"x1":"10","x2":"14","y1":"2","y2":"2"}],["line",{"x1":"12","x2":"15","y1":"14","y2":"11"}],["circle",{"cx":"12","cy":"14","r":"8"}]],"checkAll":[["path",{"d":"M18 6 7 17l-5-5"}],["path",{"d":"m22 10-7.5 7.5L13 16"}]],"userPlus":[["path",{"d":"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"}],["circle",{"cx":"9","cy":"7","r":"4"}],["line",{"x1":"19","x2":"19","y1":"8","y2":"14"}],["line",{"x1":"22","x2":"16","y1":"11","y2":"11"}]],"zap":[["path",{"d":"M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"}]],"at":[["circle",{"cx":"12","cy":"12","r":"4"}],["path",{"d":"M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"}]],"link":[["path",{"d":"M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"}],["path",{"d":"M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"}]],"lock":[["rect",{"width":"18","height":"11","x":"3","y":"11","rx":"2","ry":"2"}],["path",{"d":"M7 11V7a5 5 0 0 1 10 0v4"}]],"phone":[["rect",{"width":"14","height":"20","x":"5","y":"2","rx":"2","ry":"2"}],["path",{"d":"M12 18h.01"}]],"party":[["path",{"d":"M5.8 11.3 2 22l10.7-3.79"}],["path",{"d":"M4 3h.01"}],["path",{"d":"M22 8h.01"}],["path",{"d":"M15 2h.01"}],["path",{"d":"M22 20h.01"}],["path",{"d":"m22 2-2.24.75a2.9 2.9 0 0 0-1.96 3.12c.1.86-.57 1.63-1.45 1.63h-.38c-.86 0-1.6.6-1.76 1.44L14 10"}],["path",{"d":"m22 13-.82-.33c-.86-.34-1.82.2-1.98 1.11c-.11.7-.72 1.22-1.43 1.22H17"}],["path",{"d":"m11 2 .33.82c.34.86-.2 1.82-1.11 1.98C9.52 4.9 9 5.52 9 6.23V7"}],["path",{"d":"M11 13c1.93 1.93 2.83 4.17 2 5-.83.83-3.07-.07-5-2-1.93-1.93-2.83-4.17-2-5 .83-.83 3.07.07 5 2Z"}]]};
  function icon(name, size = 20, cls = '') {
    const s = svg('svg', {
      viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 2,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'ico ' + cls,
    });
    for (const [tag, attr] of ICONS[name] || []) s.append(svg(tag, attr));
    return s;
  }

  // A QR-code look-alike used as the brand motif. Same seed gives the same picture.
  function qrArt(cells = 13, seed = 7, cls = '') {
    let x = seed * 9301 + 49297;
    const rnd = () => ((x = (x * 9301 + 49297) % 233280) / 233280);
    const g = svg('g', { fill: 'currentColor' });
    const inFinder = (cx, cy) => (cx < 7 && cy < 7) || (cx >= cells - 7 && cy < 7) || (cx < 7 && cy >= cells - 7);
    for (let cy = 0; cy < cells; cy++) {
      for (let cx = 0; cx < cells; cx++) {
        if (!inFinder(cx, cy) && rnd() > 0.52) g.append(svg('rect', { x: cx + 0.08, y: cy + 0.08, width: 0.84, height: 0.84, rx: 0.22 }));
      }
    }
    for (const [fx, fy] of [[0, 0], [cells - 7, 0], [0, cells - 7]]) {
      g.append(svg('rect', { x: fx + 0.5, y: fy + 0.5, width: 6, height: 6, rx: 1.4, fill: 'none', stroke: 'currentColor', 'stroke-width': 1 }));
      g.append(svg('rect', { x: fx + 2, y: fy + 2, width: 3, height: 3, rx: 0.8 }));
    }
    return svg('svg', { viewBox: `0 0 ${cells} ${cells}`, class: 'qrart ' + cls, 'aria-hidden': 'true' }, g);
  }

  function logoMark(size = 36) {
    const s = svg('svg', { viewBox: '0 0 32 32', width: size, height: size, 'aria-hidden': 'true', class: 'logomark' });
    s.append(svg('rect', { width: 32, height: 32, rx: 9, fill: '#E3B965' }));
    for (const [x, y] of [[6, 6], [18, 6], [6, 18]]) {
      s.append(svg('rect', { x, y, width: 8, height: 8, rx: 2, fill: '#0A1530' }));
      s.append(svg('rect', { x: x + 2.5, y: y + 2.5, width: 3, height: 3, rx: 0.8, fill: '#E3B965' }));
    }
    s.append(svg('rect', { x: 19, y: 19, width: 3.4, height: 3.4, rx: 1, fill: '#0A1530' }));
    s.append(svg('rect', { x: 23.6, y: 23.6, width: 3.4, height: 3.4, rx: 1, fill: '#0A1530' }));
    return s;
  }
  const brand = (label) => h('div', { class: 'brand' }, logoMark(34), h('span', {}, label));

  const nowS = () => Date.now() + S.skew;
  const inr = (n) => {
    const x = Number(n) || 0;
    return '₹' + x.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: Number.isInteger(x) ? 0 : 2 });
  };
  const clockText = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  const when = (ts) =>
    ts ? new Date(ts).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
  const ago = (ts) => {
    const m = Math.max(0, Math.round((nowS() - ts) / 60000));
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const hr = Math.floor(m / 60);
    return hr < 24 ? `${hr} h ago` : when(ts);
  };
  const safeUrl = (u) => (/^https?:\/\//i.test(u) ? u : '#');
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const clamp01 = (n) => Math.max(0, Math.min(1, n));

  // Round avatar with the person's initial. The colour comes from the name.
  function avatar(name, size = '') {
    const s = String(name || '?').trim();
    let n = 0;
    for (const ch of s) n = (n * 31 + ch.codePointAt(0)) % 6;
    return h('span', { class: `av c${n} ${size}`, 'aria-hidden': 'true' }, s.charAt(0).toUpperCase());
  }

  // Remembers which ids were already on screen: only new ones play the pop-in.
  function isNew(id) {
    const key = String(id);
    const fresh = !S.seen.has(key);
    S.seen.add(key);
    return fresh && !S.entering;
  }

  function toast(msg, kind) {
    const ic = kind === 'bad' ? 'xCircle' : kind === 'good' ? 'checkCircle' : 'sparkles';
    const t = h('div', { class: 'toast ' + (kind || '') }, icon(ic, 20), h('span', {}, msg));
    $toasts.append(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 260); }, kind === 'bad' ? 5200 : 3200);
  }

  function ask({ title, body, ok = 'OK', cancel = 'Cancel', danger = false, input = null }) {
    return new Promise((resolve) => {
      let field = null;
      const finish = (v) => {
        $dlg.oncancel = null;
        if ($dlg.open) $dlg.close();
        resolve(v);
      };
      $dlg.replaceChildren(...[
        h('div', { class: 'dlg-ico ' + (danger ? 'red' : '') }, icon(danger ? 'ban' : 'sparkles', 22)),
        h('h3', {}, title),
        body && h('p', { class: 'muted' }, body),
        input && (field = h('input', { class: 'input', type: input.type || 'text', placeholder: input.placeholder || '', style: 'margin-top:14px', autocomplete: 'off' })),
        h('div', { class: 'btns' },
          h('button', { class: 'btn quiet', onclick: () => finish(input ? null : false) }, cancel),
          h('button', {
            class: 'btn ' + (danger ? 'red' : ''),
            onclick: () => {
              if (input) {
                if (!field.value.trim()) return field.focus();
                return finish(field.value);
              }
              finish(true);
            },
          }, ok)),
      ].filter(Boolean));
      $dlg.oncancel = () => { $dlg.oncancel = null; resolve(input ? null : false); };
      $dlg.showModal();
      if (field) field.focus();
    });
  }

  function isTyping() {
    const a = document.activeElement;
    return !!a && $app.contains(a) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName);
  }

  // -------------------------------------------------------------------- api
  async function api(action, body = {}) {
    let res;
    try {
      const as = S.role === 'owner' && S.admin.as && action.startsWith('a.') ? { as: S.admin.as } : {};
      res = await fetch('/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(S.token ? { authorization: 'Bearer ' + S.token } : {}) },
        body: JSON.stringify({ action, ...body, ...as }),
      });
    } catch {
      throw new Error('No internet. Check your connection and try again.');
    }
    let data = {};
    try { data = await res.json(); } catch { /* not json */ }
    if (data.now) S.skew = data.now - Date.now();
    if ((res.status === 401 || res.status === 403) && S.token) {
      S.notice = data.error || 'Please sign in again.';
      logout();
      throw new Error(S.notice);
    }
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    return data;
  }

  function logout() {
    S.role = null; S.token = null; S.data = null; S.draft = {}; S.shownBalance = null; S.seen = new Set();
    S.admin = freshAdmin();
    store.del('od.token'); store.del('od.role');
    document.title = 'Order Desk';
    S.animate = true;
    render();
  }

  async function busy(btn, fn) {
    if (btn) btn.disabled = true;
    try { return await fn(); } finally { if (btn && btn.isConnected) btn.disabled = false; }
  }

  // ---------------------------------------------------------------- refresh
  let polling = false;
  async function refresh(force = false) {
    if (!S.role || polling) return;
    polling = true;
    try {
      if (S.role === 'worker') {
        const next = await api('w.home');
        if (S.shownBalance !== null && next.me.balance > S.shownBalance) S.celebrate = true;
        S.data = next;
      } else {
        S.admin.data = await api('a.overview');
      }
    } catch (e) {
      polling = false;
      if (S.role && force) toast(e.message, 'bad');
      return;
    }
    polling = false;
    updateTitle();
    if (force || !isTyping()) render(); else tick();
  }

  function updateTitle() {
    let n = 0;
    if (S.role === 'worker' && S.data) n = S.data.mine.some((o) => o.status === 'claimed') ? 0 : S.data.openCount;
    if (S.role !== 'worker' && S.admin.data) n = S.admin.data.pending.length + S.admin.data.withdrawals.length;
    document.title = (n ? `(${n}) ` : '') + 'Order Desk';
  }

  async function loadHistory(month) {
    try {
      S.admin.history = await api('a.history', { month: month || S.admin.month || '' });
      S.admin.month = S.admin.history.month;
      if (!isTyping()) render();
    } catch (e) { toast(e.message, 'bad'); }
  }
  async function loadWorkers() {
    try {
      S.admin.workers = (await api('a.workers')).workers;
      if (!isTyping()) render();
    } catch (e) { toast(e.message, 'bad'); }
  }
  async function loadAdmins() {
    try {
      S.admin.admins = (await api('o.admins')).admins;
      if (!isTyping()) render();
    } catch (e) { toast(e.message, 'bad'); }
  }
  async function loadEveryone() {
    try {
      S.admin.everyone = (await api('o.everyone')).workers;
      if (!isTyping()) render();
    } catch (e) { toast(e.message, 'bad'); }
  }
  function setAdminTab(t) {
    S.admin.tab = t;
    S.animate = true;
    render();
    window.scrollTo(0, 0);
    if (t === 'workers') loadWorkers();
    if (t === 'orders' || t === 'withdrawals') loadHistory();
    if (t === 'admins') loadAdmins();
    if (t === 'everyone') loadEveryone();
  }

  // ------------------------------------------------------------ countdowns
  let lastExpiryRefresh = 0;
  function tick() {
    const t = nowS();
    let over = false;
    document.querySelectorAll('.cd[data-until]').forEach((el) => {
      const left = Number(el.dataset.until) - t;
      el.textContent = left <= 0 ? 'Time is up' : (el.dataset.pre || '') + clockText(left);
      el.classList.toggle('low', left < 60000);
      if (left <= 0) over = true;
    });
    document.querySelectorAll('.bar[data-until]').forEach((el) => {
      const left = Number(el.dataset.until) - t;
      el.firstElementChild.style.width = clamp01(left / Number(el.dataset.total)) * 100 + '%';
      el.classList.toggle('low', left < 60000);
    });
    document.querySelectorAll('.ring[data-until]').forEach((el) => {
      const left = Number(el.dataset.until) - t;
      const pct = clamp01(left / Number(el.dataset.total));
      el.querySelector('.prog').style.strokeDashoffset = String(Number(el.dataset.c) * (1 - pct));
      el.classList.toggle('low', left < 60000);
      el.classList.toggle('mid', left >= 60000 && pct < 0.5);
    });
    if (over && Date.now() - lastExpiryRefresh > 4000 && !document.hidden) {
      lastExpiryRefresh = Date.now();
      setTimeout(() => refresh(), 900);
    }
  }
  setInterval(tick, 1000);
  setInterval(() => { if (!document.hidden && S.role) refresh(); }, 40000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.role) refresh(); });

  // --------------------------------------------------------------- motion
  function countTo(el, from, to) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || from === to) { el.textContent = inr(to); return; }
    const t0 = performance.now();
    const dur = Math.min(1100, 500 + Math.abs(to - from) * 6);
    el.textContent = inr(from);
    const step = (t) => {
      const p = clamp01((t - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      el.textContent = inr(Math.round((from + (to - from) * e) * 100) / 100);
      if (p < 1 && el.isConnected) requestAnimationFrame(step); else el.textContent = inr(to);
    };
    requestAnimationFrame(step);
  }

  function celebrate(anchor) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || !anchor) return;
    const box = h('div', { class: 'confetti', 'aria-hidden': 'true' });
    const colors = ['#E3B965', '#F2D48F', '#FFFFFF', '#1E9E6E', '#7AD8B5'];
    for (let i = 0; i < 26; i++) {
      const a = (Math.PI * 2 * i) / 26 + Math.random() * 0.4;
      const d = 70 + Math.random() * 110;
      box.append(h('i', {
        style: `--dx:${Math.cos(a) * d}px;--dy:${Math.sin(a) * d - 30}px;--r:${Math.random() * 540 - 270}deg;--c:${colors[i % colors.length]};--s:${6 + Math.random() * 6}px;animation-delay:${Math.random() * 120}ms`,
      }));
    }
    anchor.append(box);
    setTimeout(() => box.remove(), 1500);
  }

  // ------------------------------------------------------------------ login
  // One box: the key. The server tells us if it belongs to the owner, an admin or a worker.
  function loginView() {
    const err = h('div', { class: 'error', role: 'alert' }, S.notice || '');
    S.notice = '';
    const key = h('input', {
      class: 'input with-icon', type: 'password', required: true, value: S.draft.key || '', placeholder: 'Your key',
      autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', maxlength: '40',
      oninput: (e) => (S.draft.key = e.target.value),
    });
    const show = h('button', {
      type: 'button', class: 'eye', 'aria-label': 'Show key',
      onclick: () => {
        const hidden = key.type === 'password';
        key.type = hidden ? 'text' : 'password';
        show.replaceChildren(icon(hidden ? 'eyeOff' : 'eye', 20));
        show.setAttribute('aria-label', hidden ? 'Hide key' : 'Show key');
      },
    }, icon('eye', 20));
    const submit = h('button', { class: 'btn block big', type: 'submit' }, 'Log in');

    const form = h('form', {
      class: 'auth-card rise',
      style: '--i:2',
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        await busy(submit, async () => {
          try {
            const data = await api('login', { key: key.value });
            S.token = data.token; S.role = data.role; S.draft = {};
            store.set('od.token', data.token); store.set('od.role', data.role);
            S.tab = 'orders';
            S.admin.as = null;
            S.admin.tab = data.role === 'owner' ? 'admins' : 'verify';
            S.animate = true;
            await refresh(true);
            if (S.role === 'owner') loadAdmins();
          } catch (ex) {
            err.textContent = ex.message;
            form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
          }
        });
      },
    },
      h('h2', {}, 'Welcome back'),
      h('p', { class: 'muted' }, 'Enter the key your admin gave you.'),
      h('label', { class: 'field' }, 'Your key',
        h('span', { class: 'inwrap' }, icon('key', 20, 'lead'), key, show),
        h('span', { class: 'hint' }, 'Keys are case sensitive.')),
      err,
      submit,
    );

    const perk = (ic, title, text) => h('li', {}, h('span', { class: 'perk-ico' }, icon(ic, 20)), h('div', {}, h('b', {}, title), h('span', {}, text)));
    return h('main', { class: 'auth' },
      h('section', { class: 'auth-hero' },
        qrArt(15, 11, 'hero-qr'),
        h('i', { class: 'coin c1' }, '₹'), h('i', { class: 'coin c2' }, '₹'), h('i', { class: 'coin c3' }, '₹'),
        h('div', { class: 'hero-in rise' },
          brand('Order Desk'),
          h('h1', {}, 'Small tasks.', h('br'), 'Real money.'),
          h('p', {}, 'Claim an order, finish it in minutes, and get paid straight to your UPI.'),
          h('ul', { class: 'perks' },
            perk('zap', 'Quick orders', 'Each one takes just a few minutes'),
            perk('shield', 'Checked by your admin', 'You are paid for every approved order'),
            perk('rupee', 'Paid on UPI', 'Withdraw whenever you reach the minimum')))),
      h('section', { class: 'auth-side' }, form),
    );
  }

  // ----------------------------------------------------------------- worker
  const bar = (until, total) => h('div', { class: 'bar', 'data-until': until, 'data-total': total }, h('i'));

  const LEDGER = {
    order_done: ['hourglass', 'amber', 'sent for checking', 'Waiting for the admin'],
    order_ok: ['checkCircle', 'mint', 'approved', 'Added to your balance'],
    order_no: ['xCircle', 'coral', 'marked false', 'No money for this one'],
    order_exp: ['ban', 'grey', 'QR expired', 'Closed, no money'],
    order_timeout: ['clock', 'grey', 'time ran out', 'It went back to the pool'],
    wd_req: ['rupee', 'amber', null, null],
    wd_ok: ['check', 'mint', null, null],
    wd_fail: ['xCircle', 'coral', null, null],
  };
  const ledgerText = (e) => {
    const o = e.ord ? `Order #${e.ord}` : '';
    const l = LEDGER[e.type];
    if (l && l[2]) return [`${o} ${l[2]}`, l[3]];
    switch (e.type) {
      case 'wd_req': return ['Withdrawal requested', 'To ' + e.note];
      case 'wd_ok': return ['Withdrawal paid', 'Sent to ' + e.note];
      case 'wd_fail': return ['Withdrawal failed', 'Money is back in your balance'];
      default: return [e.type, ''];
    }
  };

  function ledgerList(entries, empty) {
    if (!entries.length) return emptyState('Nothing here yet', empty);
    return h('div', { class: 'tl' }, entries.map((e, i) => {
      const [t, d] = ledgerText(e);
      const l = LEDGER[e.type] || ['sparkles', 'grey'];
      return h('div', { class: 'tl-item rise', style: `--i:${Math.min(i, 8)}` },
        h('span', { class: 'tl-ico ' + l[1] }, icon(l[0], 18)),
        h('div', { class: 'tl-text' }, h('b', {}, t), h('span', {}, `${d}. ${when(e.ts)}`)),
        e.amt ? h('span', { class: 'tl-amt ' + (e.amt > 0 ? 'pos' : 'neg') }, (e.amt > 0 ? '+' : '−') + inr(Math.abs(e.amt))) : null);
    }));
  }

  function emptyState(title, text) {
    return h('div', { class: 'empty' }, qrArt(15, 3, 'empty-qr'), h('b', {}, title), h('span', {}, text));
  }

  async function doClaim(id, btn) {
    await busy(btn, async () => {
      try { await api('w.claim', { id }); toast('Order claimed. Open the link now.', 'good'); }
      catch (e) { toast(e.message, 'bad'); }
      S.animate = true;
      await refresh(true);
    });
  }
  async function doDone(id, btn) {
    const yes = await ask({
      title: 'Did the link open?',
      body: 'Tap yes only if the link opened properly. The admin checks every order before you are paid.',
      ok: 'Yes, it opened',
    });
    if (!yes) return;
    await busy(btn, async () => {
      try { await api('w.done', { id }); toast('Sent to the admin for checking.', 'good'); }
      catch (e) { toast(e.message, 'bad'); }
      await refresh(true);
    });
  }
  async function doExpired(id, btn) {
    const yes = await ask({
      title: 'Mark this QR as expired?',
      body: 'Use this only if the link did not open or the QR shows as expired. The order closes and no money is added.',
      ok: 'Yes, QR expired', danger: true,
    });
    if (!yes) return;
    await busy(btn, async () => {
      try { await api('w.expired', { id }); toast('Marked as QR expired.'); }
      catch (e) { toast(e.message, 'bad'); }
      await refresh(true);
    });
  }

  function activeCard(o, st) {
    const total = st.workTimeMin * 60000;
    const R = 52;
    const C = 2 * Math.PI * R;
    const pct = clamp01((o.claimUntil - nowS()) / total);
    const link = h('div', { class: 'linkbox' },
      icon('qr', 20),
      h('span', { class: 'url' }, o.link),
      h('button', { class: 'icon-btn sm', 'aria-label': 'Copy link', onclick: () => copyText(o.link) }, icon('copy', 18)));
    const step = (n, t) => h('li', {}, h('i', {}, n), h('span', {}, t));
    return h('article', { class: 'active-card rise' + (isNew('active' + o.id) ? ' pop' : '') },
      h('div', { class: 'ac-head' },
        h('div', {}, h('h3', {}, `Order #${o.id}`), h('span', { class: 'muted small' }, 'You have this one')),
        h('span', { class: 'live-pill' }, h('i'), 'In progress')),
      h('div', {
        class: 'ring' + (pct < 0.5 ? ' mid' : ''), 'data-until': o.claimUntil, 'data-total': total, 'data-c': C,
      },
      svg('svg', { viewBox: '0 0 120 120', class: 'ring-svg', 'aria-hidden': 'true' },
        svg('circle', { class: 'track', cx: 60, cy: 60, r: R, fill: 'none', 'stroke-width': 10 }),
        svg('circle', {
          class: 'prog', cx: 60, cy: 60, r: R, fill: 'none', 'stroke-width': 10, 'stroke-linecap': 'round',
          'stroke-dasharray': C, style: `stroke-dashoffset:${C * (1 - pct)}`,
        })),
      h('div', { class: 'center' },
        h('span', { class: 'time cd', 'data-until': o.claimUntil }, clockText(o.claimUntil - nowS())),
        h('span', { class: 'earn' }, `${inr(o.reward)} you earn`))),
      h('a', { class: 'btn big block open', href: safeUrl(o.link), target: '_blank', rel: 'noopener noreferrer' }, icon('external', 20), 'Open link'),
      link,
      h('ol', { class: 'steps' }, step(1, 'Open it'), step(2, 'Check it'), step(3, 'Tap result')),
      h('div', { class: 'btns' },
        h('button', { class: 'btn green big', onclick: (e) => doDone(o.id, e.currentTarget) }, 'I done ✅'),
        h('button', { class: 'btn line red big', onclick: (e) => doExpired(o.id, e.currentTarget) }, 'QR expired 🚫')));
  }

  function openCard(o, st, canClaim, i) {
    const fresh = isNew('open' + o.id);
    return h('article', { class: 'o-card rise' + (fresh ? ' pop' : ''), style: `--i:${Math.min(i, 8)}` },
      h('div', { class: 'o-amt' }, inr(o.reward)),
      h('div', { class: 'o-meta' },
        h('b', {}, `Order #${o.id}`),
        h('span', { class: 'cd', 'data-until': o.availUntil, 'data-pre': 'Gone in ' }),
        bar(o.availUntil, st.claimWindowMin * 60000)),
      h('button', { class: 'btn yellow sm', disabled: !canClaim, onclick: (e) => doClaim(o.id, e.currentTarget) }, 'Claim order'));
  }

  function workerOrders(d) {
    const st = d.settings;
    const active = d.mine.filter((o) => o.status === 'claimed');
    const waiting = d.mine.filter((o) => o.status === 'processing');
    const full = active.length >= st.maxActive;
    return h('div', {},
      active.map((o) => activeCard(o, st)),
      waiting.length > 0 && h('section', { class: 'section' },
        h('header', {}, h('h3', {}, 'Waiting for the admin')),
        h('div', { class: 'stack' }, waiting.map((o) => h('div', { class: 'wait-card rise' },
          h('span', { class: 'spin-ico' }, icon('hourglass', 20)),
          h('div', {}, h('b', {}, `Order #${o.id}`), h('span', {}, `Sent ${ago(o.doneAt)}. Money is added when the admin marks it true.`)),
          h('b', { class: 'num' }, inr(o.reward)))))),
      h('section', { class: 'section' },
        h('header', {},
          h('h3', {}, 'Available orders'),
          h('span', { class: 'live' }, h('i'), plural(d.openCount, 'order'))),
        full && d.open.length > 0 && h('p', { class: 'note' }, icon('timer', 18),
          `You can hold ${plural(st.maxActive, 'order')} at a time. Finish your current order to claim another.`),
        d.open.length
          ? h('div', { class: 'stack' }, d.open.map((o, i) => openCard(o, st, !full, i)))
          : emptyState('No orders right now', 'New orders show up here the moment your admin adds them. This page refreshes by itself.')),
    );
  }

  function withdrawSteps(wd) {
    const step = (state, label) => h('li', { class: state }, h('i', {}, state === 'done' ? icon('check', 16) : null), h('span', {}, label));
    return h('ol', { class: 'wd-steps' }, step('done', 'Requested'), step('now', 'Admin pays you'), step('todo', 'Money received'));
  }

  function workerWallet(d) {
    const me = d.me;
    const st = d.settings;
    let body;
    if (me.wd) {
      body = h('div', { class: 'card wd-card rise' },
        h('div', { class: 'wd-top' }, h('span', { class: 'tl-ico amber' }, icon('rupee', 20)),
          h('div', {}, h('b', {}, `${inr(me.wd.amount)} withdrawal is waiting`),
            h('span', { class: 'muted small' }, `To ${me.wd.upi}, requested ${ago(me.wd.at)}.`))),
        withdrawSteps(me.wd),
        h('p', { class: 'muted small' }, 'The admin will pay it and mark it done. You do not need to do anything.'));
    } else {
      const upi = h('input', {
        class: 'input with-icon', value: S.draft.upi ?? me.upi ?? '', placeholder: 'name@bank', autocapitalize: 'none',
        spellcheck: 'false', autocomplete: 'off', required: true, oninput: (e) => (S.draft.upi = e.target.value),
      });
      const amount = h('input', {
        class: 'input with-icon', type: 'number', inputmode: 'decimal', min: String(st.minWithdraw), step: 'any',
        value: S.draft.amount ?? '', placeholder: `Minimum ${inr(st.minWithdraw)}`, required: true,
        oninput: (e) => (S.draft.amount = e.target.value),
      });
      const setAmt = (v) => { amount.value = v; S.draft.amount = String(v); };
      const submit = h('button', { class: 'btn big block', type: 'submit', disabled: me.balance < st.minWithdraw }, icon('rupee', 20), 'Request withdrawal');
      const quick = [
        ['Minimum', st.minWithdraw], ['Half', Math.floor(me.balance / 2)], ['Full balance', me.balance],
      ].filter(([, v]) => v >= st.minWithdraw && v <= me.balance);
      body = h('form', {
        class: 'card form rise',
        onsubmit: async (e) => {
          e.preventDefault();
          await busy(submit, async () => {
            try {
              await api('w.withdraw', { upi: upi.value, amount: amount.value });
              S.draft.amount = '';
              toast('Withdrawal requested. The admin will pay you on UPI.', 'good');
            } catch (ex) { toast(ex.message, 'bad'); }
            await refresh(true);
          });
        },
      },
        h('h3', {}, 'Withdraw to UPI'),
        me.balance < st.minWithdraw && h('p', { class: 'note' }, icon('wallet', 18),
          `You can withdraw once your balance reaches ${inr(st.minWithdraw)}. You have ${inr(me.balance)}.`),
        h('label', { class: 'field' }, 'Your UPI ID', h('span', { class: 'inwrap' }, icon('at', 20, 'lead'), upi)),
        h('label', { class: 'field' }, 'Amount',
          h('span', { class: 'inwrap' }, h('b', { class: 'lead rs' }, '₹'), amount),
          quick.length > 0 && h('span', { class: 'chips' }, quick.map(([l, v]) =>
            h('button', { type: 'button', class: 'chip', onclick: () => setAmt(v) }, `${l} ${inr(v)}`)))),
        submit);
    }
    const money = d.ledger.filter((e) => ['order_ok', 'wd_req', 'wd_ok', 'wd_fail'].includes(e.type));
    return h('div', {}, body, h('section', { class: 'section' }, h('header', {}, h('h3', {}, 'Money history')), ledgerList(money, 'No money movements yet.')));
  }

  function workerHistory(d) {
    const c = d.me.counters;
    const tile = (ic, tone, v, l) => h('div', { class: 'stat rise' }, h('span', { class: 'tl-ico ' + tone }, icon(ic, 20)), h('b', { class: 'num' }, v), h('span', {}, l));
    return h('div', {},
      h('div', { class: 'stats' },
        tile('checkCircle', 'mint', c.approved, 'Approved'),
        tile('hourglass', 'amber', d.mine.filter((o) => o.status === 'processing').length, 'Waiting'),
        tile('ban', 'grey', c.expired, 'QR expired'),
        tile('xCircle', 'coral', c.rejected, 'Marked false')),
      h('section', { class: 'section' }, h('header', {}, h('h3', {}, 'Everything you did')),
        ledgerList(d.ledger, 'Nothing yet. Claim your first order.')));
  }

  function walletCard(d) {
    const me = d.me;
    const min = d.settings.minWithdraw;
    const waitingAmt = d.mine.filter((o) => o.status === 'processing').reduce((s, o) => s + (o.reward || 0), 0);
    const pct = clamp01(me.balance / min);
    const can = me.balance >= min;
    return h('section', { class: 'wallet balance rise', style: '--i:1' },
      h('div', { class: 'wm-box' }, qrArt(13, 5, 'wm')),
      h('p', { class: 'label' }, 'Your balance'),
      h('div', { class: 'wrow' },
        h('span', { class: 'amt num', 'data-count': me.balance }, inr(me.balance)),
        h('button', { class: 'btn dark sm', onclick: () => { S.tab = 'wallet'; S.animate = true; render(); window.scrollTo(0, 0); } }, icon('rupee', 18), 'Withdraw')),
      can
        ? h('p', { class: 'wnote ok' }, icon('checkCircle', 18), 'You can withdraw now')
        : h('div', { class: 'wprog' },
          h('div', { class: 'wbar' }, h('i', { style: `width:${pct * 100}%` })),
          h('p', { class: 'wnote' }, `${inr(min - me.balance)} more to withdraw. Minimum is ${inr(min)}.`)),
      waitingAmt > 0 && h('p', { class: 'wchip' }, icon('hourglass', 16), `${inr(waitingAmt)} is waiting for the admin to check.`));
  }

  function workerView() {
    const d = S.data;
    if (!d) return skeleton();
    const me = d.me;
    const hasActive = d.mine.some((o) => o.status === 'claimed');
    const tabs = [['orders', 'Orders', 'ticket'], ['wallet', 'Wallet', 'wallet'], ['history', 'History', 'history']];
    return h('div', { class: 'shell worker' },
      h('header', { class: 'w-top' },
        qrArt(13, 9, 'w-qr'),
        h('div', { class: 'w-bar' },
          logoMark(34),
          h('div', { class: 'hello' }, h('span', {}, 'Hello'), h('b', {}, me.name)),
          h('button', { class: 'icon-btn light', 'aria-label': 'Log out', onclick: logout }, icon('logout', 20), h('span', { class: 'sr' }, 'Log out')))),
      walletCard(d),
      h('main', { class: 'w-main' }, S.tab === 'orders' ? workerOrders(d) : S.tab === 'wallet' ? workerWallet(d) : workerHistory(d)),
      h('nav', { class: 'nav', 'aria-label': 'Sections' }, h('div', { class: 'in' },
        tabs.map(([k, l, ic]) => h('button', {
          'aria-current': S.tab === k ? 'page' : null,
          onclick: () => { S.tab = k; S.animate = true; render(); window.scrollTo(0, 0); },
        }, h('span', { class: 'nav-ico' }, icon(ic, 22)), l,
        k === 'orders' && hasActive && S.tab !== 'orders' ? h('span', { class: 'dot', title: 'You have an active order' }) : null)))));
  }

  function skeleton() {
    return h('div', { class: 'shell worker' },
      h('div', { class: 'w-top skel-top' }),
      h('div', { class: 'wallet skel' }),
      h('div', { class: 'w-main' }, h('div', { class: 'skel line' }), h('div', { class: 'skel line' }), h('div', { class: 'skel line short' })));
  }

  // ------------------------------------------------------------------ admin
  const th = (...c) => h('thead', {}, h('tr', {}, c.map((x) => (Array.isArray(x) ? h('th', { class: x[1] }, x[0]) : h('th', {}, x)))));
  const td = (label, content, cls) => h('td', { 'data-label': label, class: cls || null }, content);
  const workerName = (o) => o.workerName || o.worker || '-';
  const person = (name, extra) => h('span', { class: 'person' }, avatar(name), h('span', {}, name, extra ? [' ', extra] : null));
  const pill = (status) => h('span', { class: 'pill ' + status }, status);

  function copyText(text) {
    const done = () => toast('Copied', 'good');
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, () => toast('Could not copy', 'bad'));
    else toast('Copy is not available here', 'bad');
  }
  function keyCell(k) {
    return h('span', { class: 'keycell' }, h('code', { class: 'keybox' }, k),
      h('button', { class: 'icon-btn sm', 'aria-label': 'Copy key', onclick: () => copyText(k) }, icon('copy', 16)));
  }

  async function verify(ids, decision, btn) {
    if (decision === 'reject') {
      const yes = await ask({
        title: ids.length > 1 ? `Mark ${ids.length} orders false?` : 'Mark this order false?',
        body: 'No money will be added and the order closes.', ok: 'Mark false', danger: true,
      });
      if (!yes) return;
    }
    await busy(btn, async () => {
      try {
        const r = await api('a.verify', { ids, decision });
        toast(decision === 'approve' ? `Marked true. ${inr(r.amount)} added to balances.` : `Marked false (${r.count}).`, decision === 'approve' ? 'good' : '');
      } catch (e) { toast(e.message, 'bad'); }
      await refresh(true);
    });
  }

  function adminVerify(d) {
    const rows = d.pending;
    if (!rows.length) {
      return emptyState('Nothing to verify', 'When a worker taps I done, the order shows up here.');
    }
    return h('div', {},
      h('div', { class: 'toolbar' },
        h('h2', { class: 'grow' }, `${plural(rows.length, 'order')} to verify`),
        h('button', {
          class: 'btn green sm',
          onclick: async (e) => {
            const yes = await ask({ title: `Mark all ${rows.length} true?`, body: `${inr(rows.reduce((s, o) => s + o.reward, 0))} will be added to the workers' balances.`, ok: 'Mark all true' });
            if (yes) verify(rows.map((o) => o.id), 'approve', e.currentTarget);
          },
        }, icon('checkAll', 18), 'Mark all true')),
      h('table', { class: 'table' },
        th('Order', 'Worker', ['Amount', 'r'], 'Link', 'Sent', ''),
        h('tbody', {}, rows.map((o) => h('tr', { class: isNew('pend' + o.id) ? 'pop' : '' },
          td('Order', `#${o.id}`, 'num'),
          td('Worker', person(workerName(o))),
          td('Amount', h('b', {}, inr(o.reward))),
          td('Link', h('a', { class: 'url', href: safeUrl(o.link), target: '_blank', rel: 'noopener noreferrer' }, o.link, icon('external', 14)), 'wide'),
          td('Sent', ago(o.doneAt)),
          td('', h('div', { class: 'actions' },
            h('button', { class: 'btn green sm', onclick: (e) => verify([o.id], 'approve', e.currentTarget) }, icon('check', 16), 'True'),
            h('button', { class: 'btn line red sm', onclick: (e) => verify([o.id], 'reject', e.currentTarget) }, icon('x', 16), 'False')), 'actions-cell nolabel')))))
    );
  }

  function historyBar(kind) {
    const hs = S.admin.history;
    if (!hs) return h('p', { class: 'muted' }, 'Loading history…');
    const statuses = kind === 'orders' ? ['all', 'approved', 'rejected', 'expired', 'missed', 'cancelled'] : ['all', 'success', 'failed'];
    return h('div', { class: 'toolbar' },
      h('select', { class: 'input slim', 'aria-label': 'Month', onchange: (e) => loadHistory(e.target.value) },
        hs.months.map((m) => h('option', { value: m, selected: m === hs.month }, m))),
      h('div', { class: 'chips' }, statuses.map((s) => h('button', {
        class: 'chip', 'aria-pressed': String(S.admin.filter === s),
        onclick: () => { S.admin.filter = s; render(); },
      }, s === 'all' ? 'All' : s[0].toUpperCase() + s.slice(1)))));
  }

  async function addAgain(links, btn) {
    await busy(btn, async () => {
      try { const r = await api('a.addOrders', { links }); toast(`${plural(r.added, 'order')} added again.`, 'good'); }
      catch (e) { toast(e.message, 'bad'); }
      await refresh(true);
      loadHistory();
    });
  }

  function adminOrders(d) {
    const st = d.settings;
    const ta = h('textarea', {
      class: 'input', placeholder: 'https://example.com/link-1\nhttps://example.com/link-2', value: S.draft.links || '',
      spellcheck: 'false', autocapitalize: 'none',
    });
    const count = h('span', { class: 'muted small' }, '');
    const submit = h('button', { class: 'btn', type: 'submit' }, icon('plus', 18), 'Add orders');
    const upd = () => {
      S.draft.links = ta.value;
      const n = ta.value.split('\n').map((x) => x.trim()).filter((x) => /^https?:\/\/\S+$/i.test(x)).length;
      count.textContent = n ? `${plural(n, 'link')} ready to add` : '';
    };
    ta.addEventListener('input', upd);
    upd();

    const add = h('form', {
      class: 'card form',
      onsubmit: async (e) => {
        e.preventDefault();
        await busy(submit, async () => {
          try {
            const r = await api('a.addOrders', { links: ta.value.split('\n') });
            S.draft.links = '';
            const extra = [r.duplicates && `${r.duplicates} already live`, r.invalid && `${r.invalid} not a valid link`].filter(Boolean).join(', ');
            toast(`${plural(r.added, 'order')} added${extra ? ` (${extra})` : ''}.`, 'good');
          } catch (ex) { toast(ex.message, 'bad'); }
          await refresh(true);
        });
      },
    },
      h('h3', {}, 'Add new orders'),
      h('label', { class: 'field' }, 'Paste links, one per line', ta),
      h('p', { class: 'hint' }, `Each link becomes one order worth ${inr(st.reward)}. If nobody claims it in ${plural(st.claimWindowMin, 'minute')}, it disappears. After claiming, the worker has ${plural(st.workTimeMin, 'minute')}.`),
      h('div', { class: 'toolbar' }, submit, count));

    const live = h('div', {},
      h('section', { class: 'section' }, h('header', {}, h('h3', {}, `Open now (${d.open.length})`)),
        d.open.length ? h('table', { class: 'table' }, th('Order', 'Link', 'Gone in', ''),
          h('tbody', {}, d.open.map((o) => h('tr', {},
            td('Order', `#${o.id}`, 'num'),
            td('Link', h('span', { class: 'url' }, o.link), 'wide'),
            td('Gone in', h('span', { class: 'cd', 'data-until': o.availUntil })),
            td('', h('div', { class: 'actions' }, h('button', {
              class: 'btn quiet sm',
              onclick: async (e) => {
                if (!(await ask({ title: `Remove order #${o.id}?`, body: 'Workers will no longer see it.', ok: 'Remove', danger: true }))) return;
                await busy(e.currentTarget, async () => {
                  try { await api('a.cancelOrders', { ids: [o.id] }); toast('Order removed.'); } catch (ex) { toast(ex.message, 'bad'); }
                  await refresh(true);
                });
              },
            }, icon('trash', 16), 'Remove')), 'actions-cell nolabel')))))
          : h('p', { class: 'muted' }, 'No open orders.')),
      h('section', { class: 'section' }, h('header', {}, h('h3', {}, `With workers (${d.claimed.length})`)),
        d.claimed.length ? h('table', { class: 'table' }, th('Order', 'Worker', 'Time left'),
          h('tbody', {}, d.claimed.map((o) => h('tr', {},
            td('Order', `#${o.id}`, 'num'), td('Worker', person(workerName(o))),
            td('Time left', h('span', { class: 'cd', 'data-until': o.claimUntil }))))))
          : h('p', { class: 'muted' }, 'No order is being worked on right now.')));

    const hs = S.admin.history;
    const f = S.admin.filter;
    const list = hs ? hs.orders.filter((o) => f === 'all' || o.status === f) : [];
    const hist = h('section', { class: 'section' },
      h('header', {}, h('h3', {}, 'Finished orders')),
      historyBar('orders'),
      hs && (list.length
        ? h('table', { class: 'table' }, th('Order', 'Worker', 'Result', ['Amount', 'r'], 'Finished', ''),
          h('tbody', {}, list.slice(0, 200).map((o) => h('tr', {},
            td('Order', `#${o.id}`, 'num'),
            td('Worker', o.worker ? person(workerName(o)) : '-'),
            td('Result', pill(o.status)),
            td('Amount', o.status === 'approved' ? inr(o.reward) : '-'),
            td('Finished', when(o.finalAt)),
            td('', ['missed', 'cancelled'].includes(o.status)
              ? h('div', { class: 'actions' }, h('button', { class: 'btn quiet sm', onclick: (e) => addAgain([o.link], e.currentTarget) }, 'Add again'))
              : null, 'actions-cell nolabel')))))
        : h('p', { class: 'muted' }, 'Nothing here for this month and filter.')));

    return h('div', { class: 'cols' }, h('div', {}, add, live), hist);
  }

  async function payout(ids, decision, btn) {
    await busy(btn, async () => {
      try {
        const r = await api('a.withdrawals', { ids, decision });
        toast(decision === 'success' ? `Marked success (${inr(r.amount)}).` : `Marked failed. ${inr(r.amount)} went back to the worker.`, decision === 'success' ? 'good' : '');
      } catch (e) { toast(e.message, 'bad'); }
      await refresh(true);
      loadHistory();
    });
  }

  function adminWithdrawals(d) {
    const rows = d.withdrawals;
    const hs = S.admin.history;
    const f = S.admin.filter;
    const list = hs ? hs.withdrawals.filter((w) => f === 'all' || w.status === f) : [];
    return h('div', {},
      h('div', { class: 'toolbar' }, h('h2', { class: 'grow' }, rows.length ? `${plural(rows.length, 'request')} waiting` : 'Withdrawal requests')),
      rows.length
        ? h('table', { class: 'table' }, th('Worker', ['Amount', 'r'], 'UPI ID', 'Asked', ''),
          h('tbody', {}, rows.map((w) => h('tr', { class: isNew('wd' + w.id) ? 'pop' : '' },
            td('Worker', person(w.name || w.worker)),
            td('Amount', h('b', { class: 'num' }, inr(w.amount))),
            td('UPI ID', h('span', { class: 'keycell' }, w.upi, h('button', { class: 'icon-btn sm', 'aria-label': 'Copy UPI ID', onclick: () => copyText(w.upi) }, icon('copy', 16)))),
            td('Asked', ago(w.at)),
            td('', h('div', { class: 'actions' },
              h('a', { class: 'btn quiet sm', href: `upi://pay?pa=${encodeURIComponent(w.upi)}&pn=${encodeURIComponent(w.name || w.worker)}&am=${w.amount}&cu=INR&tn=${encodeURIComponent('Order Desk payout')}` }, icon('phone', 16), 'Pay in UPI app'),
              h('button', { class: 'btn green sm', onclick: (e) => payout([w.id], 'success', e.currentTarget) }, icon('check', 16), 'Success'),
              h('button', { class: 'btn line red sm', onclick: async (e) => {
                const b = e.currentTarget;
                if (await ask({ title: 'Mark as failed?', body: `${inr(w.amount)} goes back to ${w.name || w.worker}'s balance.`, ok: 'Mark failed', danger: true })) payout([w.id], 'failed', b);
              } }, icon('x', 16), 'Failed')), 'actions-cell nolabel')))))
        : emptyState('No withdrawal requests', 'Requests appear here with the worker’s UPI ID.'),
      h('section', { class: 'section' }, h('header', {}, h('h3', {}, 'Past withdrawals')),
        historyBar('withdrawals'),
        hs && (list.length
          ? h('table', { class: 'table' }, th('Worker', ['Amount', 'r'], 'UPI ID', 'Result', 'Finished'),
            h('tbody', {}, list.map((w) => h('tr', {},
              td('Worker', person(w.name || w.worker)), td('Amount', inr(w.amount)), td('UPI ID', w.upi),
              td('Result', pill(w.status)), td('Finished', when(w.finalAt))))))
          : h('p', { class: 'muted' }, 'Nothing here for this month and filter.'))));
  }

  function adminWorkers() {
    const ws = S.admin.workers;
    if (!ws) return h('p', { class: 'muted' }, 'Loading workers…');

    const name = h('input', {
      class: 'input', placeholder: 'Worker name, like Ravi', maxlength: '30', autocomplete: 'off', required: true,
      value: S.draft.wname || '', oninput: (e) => (S.draft.wname = e.target.value),
    });
    const key = h('input', {
      class: 'input', placeholder: 'Key, like @ravi001', maxlength: '40', autocomplete: 'off', autocapitalize: 'none',
      spellcheck: 'false', required: true, value: S.draft.wkey || '', oninput: (e) => (S.draft.wkey = e.target.value),
    });
    const add = h('button', { class: 'btn', type: 'submit' }, icon('userPlus', 18), 'Add worker');
    const form = h('form', {
      class: 'card form',
      onsubmit: async (e) => {
        e.preventDefault();
        await busy(add, async () => {
          const n = name.value.trim(); const k = key.value.trim();
          try {
            await api('a.workerAdd', { name: n, key: k });
            S.draft.wname = ''; S.draft.wkey = '';
            toast(`${n} added. Give them the key ${k}`, 'good');
          } catch (ex) { toast(ex.message, 'bad'); return; }
          await loadWorkers();
        });
      },
    },
      h('h3', {}, 'Add a worker'),
      h('p', { class: 'hint' }, 'You choose the key and tell it to the worker. They log in with only this key, so pick something that only they know.'),
      h('div', { class: 'row2' }, h('label', { class: 'field' }, 'Name', name), h('label', { class: 'field' }, 'Key', key)),
      add);

    const tot = ws.reduce((a, w) => ({ bal: a.bal + w.balance, paid: a.paid + w.counters.withdrawn }), { bal: 0, paid: 0 });
    const list = ws.length
      ? h('div', {},
        h('div', { class: 'toolbar' },
          h('h2', { class: 'grow' }, plural(ws.length, 'worker')),
          h('span', { class: 'muted' }, `Owed to workers ${inr(tot.bal)}. Paid out ${inr(tot.paid)}.`)),
        h('div', { class: 'team-grid' }, ws.map((w, i) => h('article', { class: 'team-card rise', style: `--i:${Math.min(i, 8)}` },
          h('header', {},
            avatar(w.name, 'lg'),
            h('div', {}, h('b', {}, w.name), keyCell(w.key)),
            w.blocked ? h('span', { class: 'pill blocked' }, 'blocked') : null),
          h('div', { class: 'wk-bal' }, h('span', {}, 'Balance'), h('b', { class: 'num' }, inr(w.balance))),
          h('div', { class: 'tstats' },
            ...[['Sent', w.counters.submitted], ['Approved', w.counters.approved], ['False', w.counters.rejected],
              ['QR expired', w.counters.expired], ['Timed out', w.counters.timeout], ['Withdrawn', inr(w.counters.withdrawn)]]
              .map(([l, v]) => h('div', {}, h('b', { class: 'num' }, v), h('span', {}, l)))),
          h('p', { class: 'muted small' }, `Last login ${w.lastLogin ? when(w.lastLogin) : 'never'}`),
          h('div', { class: 'actions' },
            h('button', { class: 'btn quiet sm', onclick: async () => {
              const k = await ask({ title: `New key for ${w.name}`, body: 'The old key stops working at once and they are logged out. Tell the worker the new key.', ok: 'Change key', input: { type: 'text', placeholder: 'New key, like @ravi002' } });
              if (!k) return;
              try { await api('a.workerUpdate', { username: w.username, newKey: k }); toast('Key changed.', 'good'); } catch (e) { toast(e.message, 'bad'); }
              loadWorkers();
            } }, icon('key', 16), 'Change key'),
            h('button', { class: 'btn quiet sm', onclick: async (e) => {
              await busy(e.currentTarget, async () => {
                try { await api('a.workerUpdate', { username: w.username, blocked: !w.blocked }); toast(w.blocked ? 'Worker unblocked.' : 'Worker blocked.'); } catch (ex) { toast(ex.message, 'bad'); }
                loadWorkers();
              });
            } }, icon('ban', 16), w.blocked ? 'Unblock' : 'Block'))))))
      : emptyState('No workers yet', 'Add your first worker above. They can log in as soon as you give them the key.');
    return h('div', {}, form, h('div', { class: 'section' }, list));
  }

  // ------------------------------------------------------------- owner only
  function openTeam(id, name) {
    S.admin.as = id === 'main' ? null : id;
    S.admin.asName = name;
    S.admin.data = null; S.admin.workers = null; S.admin.history = null; S.admin.filter = 'all';
    S.admin.tab = 'verify';
    S.animate = true;
    render();
    refresh(true);
  }
  function backToAdmins() {
    S.admin.as = null; S.admin.asName = '';
    S.admin.data = null; S.admin.workers = null; S.admin.history = null; S.admin.filter = 'all';
    S.admin.tab = 'admins';
    S.animate = true;
    render();
    refresh(true);
    loadAdmins();
  }

  function adminAdmins() {
    const list = S.admin.admins;
    if (!list) return h('p', { class: 'muted' }, 'Loading admins…');
    const name = h('input', {
      class: 'input', placeholder: 'Admin name, like Rahul team', maxlength: '30', autocomplete: 'off', required: true,
      value: S.draft.aname || '', oninput: (e) => (S.draft.aname = e.target.value),
    });
    const key = h('input', {
      class: 'input', placeholder: 'Key, like @rahul77', maxlength: '40', autocomplete: 'off', autocapitalize: 'none',
      spellcheck: 'false', required: true, value: S.draft.akey || '', oninput: (e) => (S.draft.akey = e.target.value),
    });
    const add = h('button', { class: 'btn', type: 'submit' }, icon('userPlus', 18), 'Add admin');
    const form = h('form', {
      class: 'card form',
      onsubmit: async (e) => {
        e.preventDefault();
        await busy(add, async () => {
          const n = name.value.trim(); const k = key.value.trim();
          try {
            await api('o.adminAdd', { name: n, key: k });
            S.draft.aname = ''; S.draft.akey = '';
            toast(`${n} added. Give them the key ${k}`, 'good');
          } catch (ex) { toast(ex.message, 'bad'); return; }
          await loadAdmins();
        });
      },
    },
      h('h3', {}, 'Add an admin'),
      h('p', { class: 'hint' }, 'The admin logs in with this key and then adds their own workers, orders and settings. Their team is separate from every other team.'),
      h('div', { class: 'row2' }, h('label', { class: 'field' }, 'Name', name), h('label', { class: 'field' }, 'Key', key)),
      add);

    const tot = list.reduce((a, x) => ({ w: a.w + x.workers, owed: a.owed + x.owed, paid: a.paid + x.paid }), { w: 0, owed: 0, paid: 0 });
    const stat = (l, v) => h('div', {}, h('b', { class: 'num' }, v), h('span', {}, l));
    return h('div', {},
      form,
      h('section', { class: 'section' },
        h('div', { class: 'toolbar' },
          h('h2', { class: 'grow' }, `${plural(list.length - 1, 'admin')}, ${plural(tot.w, 'worker')}`),
          h('span', { class: 'muted' }, `Owed to workers ${inr(tot.owed)}. Paid out ${inr(tot.paid)}.`)),
        h('div', { class: 'team-grid' }, list.map((a, i) => h('article', { class: 'team-card rise', style: `--i:${Math.min(i, 8)}` },
          h('header', {},
            avatar(a.name, 'lg'),
            h('div', {}, h('b', {}, a.name), a.isMain ? h('span', { class: 'muted small' }, 'You, the main admin') : keyCell(a.key)),
            a.blocked ? h('span', { class: 'pill blocked' }, 'blocked') : null),
          h('div', { class: 'tstats' },
            stat('Workers', a.workers), stat('To verify', a.waitingVerify), stat('To pay', a.waitingPay),
            stat('Owed', inr(a.owed)), stat('Paid out', inr(a.paid))),
          h('p', { class: 'muted small' }, a.isMain ? 'Your own team' : `Last login ${a.lastLogin ? when(a.lastLogin) : 'never'}`),
          h('div', { class: 'actions' },
            h('button', { class: 'btn sm wide', onclick: () => openTeam(a.id, a.name) }, icon('external', 16), 'Open panel'),
            !a.isMain && h('button', { class: 'btn quiet sm', onclick: async () => {
              const k = await ask({ title: `New key for ${a.name}`, body: 'The old key stops working at once and the admin is logged out. Their workers keep their own keys.', ok: 'Change key', input: { type: 'text', placeholder: 'New key, like @rahul99' } });
              if (!k) return;
              try { await api('o.adminUpdate', { id: a.id, newKey: k }); toast('Key changed.', 'good'); } catch (e) { toast(e.message, 'bad'); }
              loadAdmins();
            } }, icon('key', 16), 'Change key'),
            !a.isMain && h('button', { class: 'btn quiet sm', onclick: async (e) => {
              if (!a.blocked && !(await ask({ title: `Block ${a.name}?`, body: 'The admin and all their workers are paused until you unblock.', ok: 'Block', danger: true }))) return;
              await busy(e.currentTarget, async () => {
                try { await api('o.adminUpdate', { id: a.id, blocked: !a.blocked }); toast(a.blocked ? 'Admin unblocked.' : 'Admin blocked.'); } catch (ex) { toast(ex.message, 'bad'); }
                loadAdmins();
              });
            } }, icon('ban', 16), a.blocked ? 'Unblock' : 'Block'),
            !a.isMain && h('button', { class: 'btn line red sm', onclick: async () => {
              const typed = await ask({
                title: `Delete ${a.name}?`,
                body: `This removes the admin, their ${plural(a.workers, 'worker')}, and all their orders and records.${a.owed ? ` Workers in this team are owed ${inr(a.owed)} in total.` : ''} All their keys stop working. This cannot be undone.`,
                ok: 'Delete admin', danger: true, input: { type: 'text', placeholder: `Type ${a.name} to confirm` },
              });
              if (!typed) return;
              if (typed.trim().toLowerCase() !== a.name.toLowerCase()) return toast('The name did not match, nothing was deleted.', 'bad');
              try { await api('o.adminDelete', { id: a.id }); toast(`${a.name} deleted.`); } catch (e) { toast(e.message, 'bad'); }
              loadAdmins();
            } }, icon('trash', 16), 'Delete')))))));
  }

  function adminEveryone() {
    const ws = S.admin.everyone;
    if (!ws) return h('p', { class: 'muted' }, 'Loading everyone…');
    if (!ws.length) return emptyState('No workers yet', 'Workers of every team will be listed here with their keys.');
    return h('div', {},
      h('div', { class: 'toolbar' }, h('h2', { class: 'grow' }, plural(ws.length, 'worker') + ' in all teams')),
      h('table', { class: 'table' },
        th('Worker', 'Key', 'Team', ['Balance', 'r'], ['Sent', 'r'], ['Approved', 'r'], ['QR expired', 'r'], 'Last login'),
        h('tbody', {}, ws.map((w) => h('tr', {},
          td('Worker', person(w.name, w.blocked ? h('span', { class: 'pill blocked' }, 'blocked') : null)),
          td('Key', keyCell(w.key)), td('Team', w.team),
          td('Balance', h('b', { class: 'num' }, inr(w.balance)), 'r'),
          td('Sent', w.counters.submitted, 'r'), td('Approved', w.counters.approved, 'r'), td('QR expired', w.counters.expired, 'r'),
          td('Last login', w.lastLogin ? when(w.lastLogin) : 'Never'))))));
  }

  function adminSettings(d) {
    const st = d.settings;
    const f = {};
    const field = (key, label, hint, props = {}) => {
      f[key] = h('input', { class: 'input', type: 'number', inputmode: 'decimal', required: true, value: String(st[key]), step: 'any', ...props });
      return h('label', { class: 'field' }, label, f[key], hint && h('span', { class: 'hint' }, hint));
    };
    const save = h('button', { class: 'btn', type: 'submit' }, icon('check', 18), 'Save settings');

    const reward = field('reward', 'Reward per order (₹)', 'The same amount is paid for every order. Workers get the amount that was set when they claimed it.');
    const chips = h('div', { class: 'chips' }, [15, 20, 25].map((v) => h('button', { type: 'button', class: 'chip', onclick: () => (f.reward.value = v) }, '₹' + v)));

    const pwOld = h('input', { class: 'input', type: 'password', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
    const pwNew = h('input', { class: 'input', type: 'text', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: 'At least 6 characters, no spaces' });
    const pwBtn = h('button', { class: 'btn quiet', type: 'submit' }, icon('key', 18), 'Change my key');
    const health = h('p', { class: 'small muted' }, '');
    const mine = !S.admin.as;

    return h('div', { class: 'cols' },
      h('form', {
        class: 'card form',
        onsubmit: async (e) => {
          e.preventDefault();
          await busy(save, async () => {
            try {
              await api('a.saveSettings', {
                reward: f.reward.value, claimWindowMin: f.claimWindowMin.value, workTimeMin: f.workTimeMin.value,
                minWithdraw: f.minWithdraw.value, maxActive: f.maxActive.value,
              });
              toast('Settings saved.', 'good');
            } catch (ex) { toast(ex.message, 'bad'); }
            await refresh(true);
          });
        },
      },
        h('h3', {}, 'Orders and payments'),
        h('p', { class: 'hint' }, `These settings are only for ${d.team.name}. Other teams have their own.`),
        reward, chips,
        field('claimWindowMin', 'Order stays available for (minutes)', 'If nobody claims an order in this time, it disappears. Default 5.', { step: '1', min: '1' }),
        field('workTimeMin', 'Time to finish after claiming (minutes)', 'After this, the order goes back to the pool and the worker cannot send it. Default 5.', { step: '1', min: '1' }),
        field('minWithdraw', 'Minimum withdrawal (₹)', null, { min: '1' }),
        field('maxActive', 'Orders one worker can hold at a time', 'Stops one worker from grabbing every order. Default 1.', { step: '1', min: '1' }),
        save),
      h('div', { class: 'stack' },
        mine && h('form', {
          class: 'card form',
          onsubmit: async (e) => {
            e.preventDefault();
            await busy(pwBtn, async () => {
              try {
                const r = await api('a.changeKey', { old: pwOld.value, next: pwNew.value });
                S.token = r.token; store.set('od.token', r.token); pwOld.value = ''; pwNew.value = '';
                toast('Your key was changed. Use the new key next time.', 'good');
              } catch (ex) { toast(ex.message, 'bad'); }
            });
          },
        },
          h('h3', {}, S.role === 'owner' ? 'Your owner key' : 'Your admin key'),
          h('label', { class: 'field' }, 'Current key', pwOld),
          h('label', { class: 'field' }, 'New key', pwNew),
          pwBtn),
        h('div', { class: 'card form' },
          h('h3', {}, 'Database check'),
          h('p', { class: 'small muted' }, 'Confirms that saving and claiming work correctly on this site.'),
          h('button', {
            class: 'btn quiet', type: 'button',
            onclick: async (e) => {
              await busy(e.currentTarget, async () => {
                try {
                  const r = await (await fetch('/api?health=1')).json();
                  health.textContent = r.ok ? 'Database is working correctly.' : 'Problem: ' + JSON.stringify(r.checks);
                  health.className = 'small ' + (r.ok ? 'pos' : 'neg');
                } catch { health.textContent = 'Could not reach the server.'; health.className = 'small neg'; }
              });
            },
          }, icon('zap', 18), 'Run check'),
          health)));
  }

  const TITLES = {
    admins: ['Admins', 'Everyone who runs a team, with their keys and totals.'],
    verify: ['Verify orders', 'Check the work and mark each order true or false.'],
    orders: ['Orders', 'Add new links and see what is live.'],
    withdrawals: ['Withdrawals', 'Pay your workers on UPI, then mark the request done.'],
    workers: ['Workers', 'Add workers and give each one a key.'],
    settings: ['Settings', 'Rewards, timers and your own key.'],
    everyone: ['Everyone', 'Every worker in every team.'],
  };

  function adminView() {
    const d = S.admin.data;
    const owner = S.role === 'owner';
    if (!d) return skeleton();
    const tabs = [
      ...(owner ? [['admins', 'Admins', 'shield', 0]] : []),
      ['verify', 'Verify', 'clipboard', d.pending.length], ['orders', 'Orders', 'ticket', 0],
      ['withdrawals', 'Withdrawals', 'rupee', d.withdrawals.length], ['workers', 'Workers', 'users', 0], ['settings', 'Settings', 'sliders', 0],
      ...(owner ? [['everyone', 'Everyone', 'globe', 0]] : []),
    ];
    const t = S.admin.tab;
    const viewing = owner && S.admin.as;
    const teamTab = !['admins', 'everyone'].includes(t);
    const navBtn = (cls) => ([k, l, ic, n]) => h('button', {
      class: cls, 'aria-current': t === k ? 'page' : null, onclick: () => setAdminTab(k),
    }, icon(ic, 20), h('span', {}, l), n ? h('span', { class: 'badge' }, n) : null);

    const kpi = (ic, tone, v, l, tab) => h('button', { class: 'kpi rise', onclick: () => setAdminTab(tab) },
      h('span', { class: 'tl-ico ' + tone }, icon(ic, 22)), h('div', {}, h('b', { class: 'num' }, v), h('span', {}, l)));
    const owed = d.withdrawals.reduce((s, w) => s + w.amount, 0);
    const [title, sub] = TITLES[t];

    return h('div', { class: 'a-shell' },
      h('aside', { class: 'side' },
        brand('Order Desk'),
        h('div', { class: 'whoami' }, avatar(owner ? 'Main admin' : d.team.name, 'lg'),
          h('div', {}, h('b', {}, owner ? 'Main admin' : d.team.name), h('span', {}, owner ? 'Owner' : 'Admin'))),
        h('nav', { 'aria-label': 'Admin sections' }, tabs.map(navBtn('nav-item'))),
        h('button', { class: 'nav-item out', onclick: logout }, icon('logout', 20), h('span', {}, 'Log out'))),
      h('div', { class: 'a-col' },
        h('header', { class: 'topbar' },
          brand('Order Desk'),
          h('div', { class: 'who' }, h('span', { class: 'small' }, owner ? 'Owner' : d.team.name),
            h('button', { class: 'icon-btn light', 'aria-label': 'Log out', onclick: logout }, icon('logout', 20), h('span', { class: 'sr' }, 'Log out')))),
        h('nav', { class: 'm-tabs', 'aria-label': 'Admin sections' }, tabs.map(navBtn('m-tab'))),
        h('main', { class: 'a-main' },
          viewing && h('div', { class: 'banner rise' }, icon('shield', 20),
            h('span', {}, `You are inside ${d.team.name}'s panel. Everything you do here is for that team.`),
            h('button', { class: 'btn dark sm', onclick: backToAdmins }, 'Back to Admins')),
          h('div', { class: 'page-head rise' }, h('h1', {}, title), h('p', {}, sub)),
          teamTab && h('div', { class: 'kpis' },
            kpi('clipboard', 'amber', d.pending.length, 'To verify', 'verify'),
            kpi('ticket', 'mint', d.open.length, 'Open orders', 'orders'),
            kpi('users', 'blue', d.claimed.length, 'With workers', 'orders'),
            kpi('rupee', 'coral', d.withdrawals.length ? `${d.withdrawals.length} · ${inr(owed)}` : '0', 'Payouts waiting', 'withdrawals')),
          h('div', { class: 'a-body rise', style: '--i:2' },
            t === 'admins' ? adminAdmins() : t === 'everyone' ? adminEveryone()
              : t === 'verify' ? adminVerify(d) : t === 'orders' ? adminOrders(d) : t === 'withdrawals' ? adminWithdrawals(d)
                : t === 'workers' ? adminWorkers() : adminSettings(d)))));
  }

  // ----------------------------------------------------------------- render
  function render() {
    const y = window.scrollY;
    S.entering = S.animate;
    S.animate = false;
    $app.classList.toggle('animate', S.entering);
    $app.replaceChildren(S.role === 'worker' ? workerView() : S.role ? adminView() : loginView());
    S.entering = false;
    tick();
    afterRender();
    window.scrollTo(0, y);
  }

  function afterRender() {
    const tabs = $app.querySelector('.m-tabs');
    const cur = tabs && tabs.querySelector('[aria-current]');
    if (cur) tabs.scrollLeft = cur.offsetLeft - (tabs.clientWidth - cur.offsetWidth) / 2;
    $app.querySelectorAll('table.table').forEach((t) => { const w = h('div', { class: 'tablewrap' }); t.replaceWith(w); w.append(t); });
    const el = $app.querySelector('.wallet .amt[data-count]');
    if (!el) return;
    const to = Number(el.dataset.count);
    const from = S.shownBalance === null ? 0 : S.shownBalance;
    if (from !== to) countTo(el, from, to);
    if (S.celebrate) { S.celebrate = false; celebrate($app.querySelector('.wallet')); toast('Money added to your balance', 'good'); }
    S.shownBalance = to;
  }

  // ------------------------------------------------------------------ start
  (async function boot() {
    const token = store.get('od.token');
    const role = store.get('od.role');
    if (token && (role === 'worker' || role === 'admin' || role === 'owner')) {
      S.token = token; S.role = role;
      if (role !== 'worker') S.admin.tab = role === 'owner' ? 'admins' : 'verify';
      S.animate = true;
      render();
      await refresh(true);
      if (!S.role) return;
      if (S.role === 'owner') loadAdmins();
    } else {
      S.animate = true;
      render();
    }
  })();
})();
