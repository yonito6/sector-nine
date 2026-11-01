/* Sector Nine lobby ready check (like pro lobbies): every player has a Ready toggle, the lobby shows who is ready, the host
   can start when everyone else is ready (or force it after a confirm), and when ALL players are ready a 5 second countdown
   starts by itself that anyone can cancel by un-readying. The new host after a host leaves is shown with a crown.
   The SERVER keeps the ready state and enforces the start rules (server.js: {k:'ready',on}, meta.players[].rd, meta.rc,
   meta.cd = ms left of the countdown, {k:'meta', m:{started:true}, force:true}); this file only draws it.
   Works on top of the game's own lobby (index.html renderRoom) and the menu.js lobby: it decorates #oPlayers, adds one
   bar to #oRoom and keeps #btnStart honest. Public: window.S9Ready = { sync(), toggle(), force(), state() }
   Security: nicknames are never touched (only icons/labels are added). Loaded after the main script. */
(function () {
  'use strict';
  if (window.S9Ready) return;
  const $ = id => document.getElementById(id);
  const net = () => (typeof NET !== 'undefined' ? NET : null);
  const room = () => { const n = net(); return n && n.room && n.room.meta ? n.room : null; };
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) { const v = attrs[k]; if (v == null || v === false) continue; if (k === 'text') e.textContent = v; else if (k === 'class') e.className = v; else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : String(v)); }
    for (const c of kids) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
    return e;
  }
  const SVG = {
    crown: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z" fill="currentColor"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="square"/></svg>',
    wait: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12M6 21h12M7 3c0 5 5 6 5 9s-5 4-5 9M17 3c0 5-5 6-5 9s5 4 5 9" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  };
  const icon = k => { const s = document.createElement('span'); s.className = 's9r-ic'; s.innerHTML = SVG[k]; return s; };

  /* ---------------------------------------------------------------- style */
  const CSS = `
#s9rBar{--o:#ff9a3c;--o2:#ffb066;--c:#7fe7ff;--g:#5cff9d;--ink:#ece6d8;--dim:#9aa0a8;--ln:rgba(236,230,216,.16);--ln2:rgba(236,230,216,.3);
  margin:14px 0 4px;padding:12px 14px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px 14px;align-items:center;color:var(--ink);font-family:"IBM Plex Mono",ui-monospace,Consolas,monospace;
  background:linear-gradient(120deg,rgba(255,154,60,.09),rgba(127,231,255,.06));border:1px solid var(--ln2);clip-path:polygon(0 0,calc(100% - 14px) 0,100% 14px,100% 100%,14px 100%,0 calc(100% - 14px))}
#s9rBar[hidden]{display:none}
#s9rBar .s9r-cnt{display:grid;gap:6px;min-width:0}
#s9rBar .s9r-cnt b{font-family:"Big Shoulders Stencil Display",Impact,"Arial Narrow",sans-serif;font-weight:900;font-size:26px;line-height:1;letter-spacing:.03em}
#s9rBar .s9r-cnt b small{font-family:"IBM Plex Mono",monospace;font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin-left:8px}
#s9rBar .s9r-pips{display:flex;gap:4px;flex-wrap:wrap}
#s9rBar .s9r-pips i{width:22px;height:6px;background:rgba(236,230,216,.14);transition:background .2s}
#s9rBar .s9r-pips i.on{background:var(--g);box-shadow:0 0 8px rgba(92,255,157,.5)}
#s9rBar .s9r-go{min-width:170px;min-height:46px;padding:0 18px;display:inline-flex;align-items:center;justify-content:center;gap:9px;background:var(--o);border:1px solid var(--o);color:#14100b;font:700 13px "IBM Plex Mono",monospace;letter-spacing:.16em;text-transform:uppercase;cursor:pointer}
#s9rBar .s9r-go:hover{background:var(--o2)}
#s9rBar .s9r-go[aria-pressed=true]{background:rgba(92,255,157,.14);border-color:var(--g);color:var(--g)}
#s9rBar .s9r-go:focus-visible,#s9rBar .s9r-force button:focus-visible{outline:2px solid var(--c);outline-offset:2px}
#s9rBar .s9r-go .s9r-ic,#s9rBar .s9r-chip .s9r-ic{width:16px;height:16px;display:inline-grid}
#s9rBar .s9r-go svg,.s9r-chip svg{width:100%;height:100%}
#s9rBar .s9r-msg{grid-column:1/-1;font-size:12px;line-height:1.5;color:var(--dim);min-height:1px}
#s9rBar .s9r-msg strong{color:var(--ink)}
#s9rBar .s9r-cd{grid-column:1/-1;display:flex;align-items:center;gap:14px;padding:10px 12px;border:1px solid var(--o);background:rgba(255,154,60,.1)}
#s9rBar .s9r-cd[hidden]{display:none}
#s9rBar .s9r-cd b{font-family:"Big Shoulders Stencil Display",Impact,"Arial Narrow",sans-serif;font-weight:900;font-size:44px;line-height:1;color:var(--o2);min-width:30px;text-align:center}
#s9rBar .s9r-cd span{font-size:12px;letter-spacing:.1em;text-transform:uppercase;line-height:1.4}
#s9rBar .s9r-cd span em{display:block;font-style:normal;color:var(--dim);letter-spacing:.06em;text-transform:none}
#s9rBar .s9r-force{grid-column:1/-1;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
#s9rBar .s9r-force button{min-height:40px;padding:0 14px;background:transparent;border:1px solid var(--ln2);color:var(--ink);font:600 11px "IBM Plex Mono",monospace;letter-spacing:.14em;text-transform:uppercase;cursor:pointer}
#s9rBar .s9r-force button:hover{border-color:var(--o);background:rgba(255,154,60,.1)}
#s9rBar .s9r-force button.warn{border-color:#ff5a5a;color:#ffb0b0}
#s9rBar .s9r-force span{font-size:12px;color:var(--dim)}
.oplayer.s9r-row{container-type:inline-size}
.oplayer.s9r-row b{flex:1 1 auto;min-width:44px}
.oplayer.s9r-row em{display:none}   /* the crown says it */
.s9r-crown{flex:none;width:18px;height:18px;color:#ffc64d;display:inline-grid;filter:drop-shadow(0 0 4px rgba(255,198,77,.6))}
.s9r-crown svg{width:100%;height:100%}
.s9r-chip{flex:none;display:inline-flex;align-items:center;gap:5px;margin-left:8px;padding:3px 7px 3px 6px;border:1px solid var(--ln2);font:600 10px "IBM Plex Mono",monospace;letter-spacing:.12em;text-transform:uppercase;white-space:nowrap}
.s9r-chip.ok{color:#5cff9d;border-color:rgba(92,255,157,.55);background:rgba(92,255,157,.08)}
.s9r-chip.no{color:#9aa0a8}
.s9r-chip .s9r-ic{width:12px;height:12px;display:inline-grid}
@container (max-width:290px){.s9r-chip{padding:3px 5px;font-size:0;gap:0}.s9r-chip .s9r-ic{width:14px;height:14px}}
@media (max-width:620px){#s9rBar{grid-template-columns:1fr}#s9rBar .s9r-go{width:100%}.s9r-chip{padding:3px 5px;font-size:0;gap:0}.s9r-chip .s9r-ic{width:14px;height:14px}}
@media (prefers-reduced-motion:reduce){#s9rBar .s9r-pips i{transition:none}}`;
  function injectCss() { if ($('s9rCss')) return; const s = el('style', { id: 's9rCss' }); s.textContent = CSS; document.head.appendChild(s); }

  /* ---------------------------------------------------------------- state from the room */
  const minPlayers = m => m.mode === 'demo' && m.balance !== 'manual' ? 4 : 2;
  let metaSeen = null, cdEnd = 0, pendingOn = null, pendingAt = 0, forceAsk = false, bar = null, nodes = {};
  function state() {
    const r = room(); if (!r) return null; const m = r.meta;
    const pl = Array.isArray(m.players) ? m.players : [], me = pl.find(p => p.id === r.myId) || null;
    const total = pl.length, ready = pl.filter(p => p.rd).length, host = !!r.isHost;
    const others = pl.filter(p => p.id !== m.hostId && !p.rd).length;
    return { on: !!m.rdy && !m.started, started: !!m.started, host, me, total, ready, others, min: minPlayers(m), enough: total >= minPlayers(m), cd: m.cd | 0, meta: m, myReady: pendingOn != null && performance.now() - pendingAt < 2500 ? pendingOn : !!(me && me.rd) };
  }

  /* ---------------------------------------------------------------- actions */
  function toggle() {
    const r = room(), s = state(); if (!r || !s || !s.on || typeof r.send !== 'function') return false;
    pendingOn = !s.myReady; pendingAt = performance.now(); r.send({ k: 'ready', on: pendingOn }); sync(); return true;
  }
  function force() {
    const r = room(), s = state(); if (!r || !s || !s.host || !s.on || !s.enough) return false;
    const extra = window.MODE && typeof MODE.startExtras === 'function' ? MODE.startExtras(r.meta) : {};
    r.send({ k: 'meta', m: Object.assign({ started: true }, extra), force: true }); forceAsk = false; sync(); return true;
  }

  /* ---------------------------------------------------------------- the bar */
  function build() {
    const host = $('oRoom'); if (!host || !$('oPlayers')) return false;
    if (bar && bar.isConnected) return true;
    injectCss();
    const cnt = el('div', { class: 's9r-cnt' }, el('b', { id: 's9rCount', 'aria-live': 'polite' }), el('div', { class: 's9r-pips', id: 's9rPips', 'aria-hidden': 'true' }));
    const go = el('button', { type: 'button', class: 's9r-go', id: 's9rGo', 'aria-pressed': 'false', onclick: () => toggle() });
    const cd = el('div', { class: 's9r-cd', id: 's9rCd', hidden: true, role: 'timer', 'aria-live': 'off' }, el('b', { id: 's9rCdN' }), el('span', null, 'Everyone is ready', el('em', { text: 'Match starts automatically. Press the button to cancel.' })));
    const msg = el('div', { class: 's9r-msg', id: 's9rMsg', role: 'status', 'aria-live': 'polite' });
    const frc = el('div', { class: 's9r-force', id: 's9rForce', hidden: true });
    bar = el('div', { id: 's9rBar', hidden: true }, cnt, go, cd, msg, frc);
    const pl = $('oPlayers'); pl.parentNode.insertBefore(bar, pl.nextSibling);
    nodes = { count: $('s9rCount'), pips: $('s9rPips'), go: $('s9rGo'), cd: $('s9rCd'), cdN: $('s9rCdN'), msg: $('s9rMsg'), force: $('s9rForce') };
    return true;
  }
  function setForce(s) {
    const f = nodes.force; f.textContent = '';
    const show = s.host && s.on && s.enough && s.others > 0 && !s.cd;
    f.hidden = !show; if (!show) { forceAsk = false; return; }
    if (!forceAsk) f.append(el('button', { type: 'button', text: 'Force start', 'aria-label': 'Force start without waiting', onclick: () => { forceAsk = true; sync(); } }), el('span', { text: s.others + ' not ready' }));
    else f.append(el('span', { text: 'Start now without ' + s.others + ' player' + (s.others > 1 ? 's' : '') + '?' }), el('button', { type: 'button', class: 'warn', text: 'Start anyway', onclick: () => force() }), el('button', { type: 'button', text: 'Keep waiting', onclick: () => { forceAsk = false; sync(); } }));
  }
  function tickCd() {
    const left = cdEnd - performance.now();
    if (!bar || !nodes.cd || nodes.cd.hidden) return;
    nodes.cdN.textContent = String(Math.max(0, Math.ceil(left / 1000)));
  }
  function decorate(s) {
    const r = room(), box = $('oPlayers'); if (!r || !box) return;
    const byId = new Map((r.meta.players || []).map(p => [p.id, p]));
    for (const row of box.querySelectorAll('.oplayer')) {
      const pid = row.getAttribute('data-pid'); let p = pid ? byId.get(pid) : null;
      if (!p && !row.classList.contains('empty')) { const nm = (row.querySelector('b') || {}).textContent; p = (r.meta.players || []).find(x => x.n === nm) || null; }
      for (const old of row.querySelectorAll('.s9r-chip,.s9r-crown')) old.remove();
      row.classList.toggle('s9r-row', !!p && !row.classList.contains('empty'));
      if (!p || row.classList.contains('empty')) continue;
      if (p.host || p.id === r.meta.hostId) { const c = el('span', { class: 's9r-crown', title: 'Host', 'aria-label': 'Host' }); c.innerHTML = SVG.crown; const b = row.querySelector('b'); if (b) row.insertBefore(c, b); }
      if (s.on) {
        const rd = p.id === r.myId ? s.myReady : !!p.rd;
        const chip = el('span', { class: 's9r-chip ' + (rd ? 'ok' : 'no'), 'aria-label': rd ? 'Ready' : 'Not ready' }, icon(rd ? 'check' : 'wait'), rd ? 'Ready' : 'Not ready');
        const mv = row.querySelector('.s9m-mv'); if (mv) row.insertBefore(chip, mv); else row.append(chip);
      }
    }
  }
  function sync() {
    if (!build()) return;
    const r = room(), s = state();
    if (!r || !s) { bar.hidden = true; return; }
    const m = r.meta;
    if (m !== metaSeen) { metaSeen = m; cdEnd = performance.now() + (m.cd | 0); if (pendingOn != null && !!(s.me && s.me.rd) === pendingOn) pendingOn = null; }
    if (!s.on) { bar.hidden = true; forceAsk = false; decorate(s); return; }
    bar.hidden = false;
    nodes.count.textContent = ''; nodes.count.append(document.createTextNode(s.ready + '/' + s.total), el('small', { text: 'ready' }));
    nodes.pips.textContent = ''; for (let i = 0; i < s.total; i++) nodes.pips.append(el('i', { class: i < s.ready ? 'on' : '' }));
    nodes.go.setAttribute('aria-pressed', String(s.myReady)); nodes.go.textContent = '';
    nodes.go.append(icon(s.myReady ? 'check' : 'wait'), s.myReady ? 'Ready · tap to cancel' : "I'm ready");
    nodes.cd.hidden = !s.cd; if (s.cd) tickCd();
    nodes.msg.textContent = !s.enough ? (s.min > 2 ? 'Demolition needs ' + s.min + ' players.' : 'Waiting for more players to join.') : s.cd ? '' :
      s.host ? (s.others ? 'Waiting for ' + s.others + ' player' + (s.others > 1 ? 's' : '') + ' to get ready. When everyone (you too) is ready, the match starts in 5 seconds.' : 'Everyone is ready. Press Ready too, or start now.') : (s.myReady ? 'Waiting for the others.' : 'Press Ready when you are set.');
    setForce(s);
    // the host's Start button: only when everyone else is ready (and there are enough players); the game's own rules stay in charge of min players
    const bs = $('btnStart');
    if (bs && s.host && s.enough) {
      if (s.others > 0) { bs.disabled = true; bs.textContent = 'Waiting for ' + s.others + ' to get ready'; }
      else { bs.disabled = false; bs.textContent = s.cd ? 'Start now' : 'Start match'; }
    }
    decorate(s);
  }

  /* ---------------------------------------------------------------- wiring */
  function hookSend() {
    try {
      if (typeof srvSend !== 'function' || srvSend.__s9r) return;
      (0, eval)('srvSend = (function (o) { var w = function (x) { if (x && typeof x === "object" && (x.k === "create" || x.k === "join") && x.rdy === undefined) x = Object.assign({}, x, { rdy: 1 }); return o.call(this, x); }; w.__s9r = true; return w; })(srvSend)');
    } catch (e) { console.warn('ready: srvSend hook', e); }
  }
  let wired = false;
  function wire() {
    if (wired) return; const box = $('oPlayers'); if (!box || !$('oRoom')) return; wired = true;
    hookSend(); build();
    let busy = false;
    new MutationObserver(() => { if (busy) return; busy = true; try { sync(); } finally { setTimeout(() => { busy = false; }, 0); } }).observe(box, { childList: true });
    setInterval(() => { try { sync(); tickCd(); } catch (e) {} }, 250);
    setInterval(tickCd, 100);
    sync();
  }
  function boot() { hookSend(); wire(); if (!wired) { const t = setInterval(() => { wire(); if (wired) clearInterval(t); }, 400); setTimeout(() => clearInterval(t), 60000); } }
  window.S9Ready = { sync, toggle, force, state };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
