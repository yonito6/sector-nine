/* Sector Nine sessions (client side; pairs with the game server's one-session + rejoin rules).
   1. One tab per player: a second tab of the game shows a clean full-screen "already open in another tab" screen and
      stays offline. "Use here instead" moves the game to that tab; the other tab pauses and shows the same screen.
      (BroadcastChannel + a localStorage heartbeat lock; the server also refuses a second connection of the same
      account / browser: the older one gets {k:'kicked'} and is closed. Newest wins.)
   2. Rejoin: the server gives each player a rejoin token per room (kept here in localStorage). Reconnecting after a
      drop, coming back from the room lobby, or joining the room again within 5 minutes puts you back with the same
      id, team, kills, deaths and score. Others see "<nick> left the match" / "<nick> rejoined".
   3. Online matches end ONLY when the server says so (someone reached the room's kill goal, or the host's optional
      time limit). The old 10-minute client clock no longer ends online matches and the client never restarts a match
      (and resets scores) on its own. The host can pick a time limit (default: none) in the room settings.
   Loaded after the main game script; wraps its global functions (srvInit, srvSend, openRoom, startOnlineMatch,
   endMatch, peerEntry, dropPeer, netReceive, toRoomLobby, leaveOnline, renderRoom, renderRoomList, updateAbilities). */
(() => {
  'use strict';
  if (window.S9Session) return;
  const LS = { lock: 'sector9-tab', bid: 'sector9-bid', rj: 'sector9-rejoin', last: 'sector9-last' };
  const BEAT = 1000, STALE = 3500, LAST_OK = 5 * 60e3, TOKEN_OK = 3 * 3600e3;
  const rand = n => { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map(b => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'[b & 63]).join(''); };
  const get = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
  const put = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const tabId = rand(12);
  let bid = null; try { bid = localStorage.getItem(LS.bid); if (!/^[A-Za-z0-9_-]{16,64}$/.test(bid || '')) { bid = rand(22); localStorage.setItem(LS.bid, bid); } } catch (e) { bid = rand(22); }
  const S = { quietLeave: new Set(), active: false, decided: false, blocked: false, why: '', rejoining: false, dropped: new Set(), quiet: new Set(), allowEnd: false, endT: 0 };
  const room = () => (typeof NET !== 'undefined' && NET.on && NET.room) || null;
  const srvRoom = () => { const r = room(); return r && r.server ? r : null; };
  const serverMatch = () => { const r = srvRoom(); return !!(r && r.match && NET.inMatch); };   // the server runs this match (v2)
  const feed = t => { try { if ((state === 'play' || state === 'dead' || state === 'paused') && typeof kfeedText === 'function') kfeedText(t); } catch (e) {} };

  /* ---------------- 1. one tab at a time ---------------- */
  // The lock in localStorage: {id, t (heartbeat), gen (bumped by every "Use here instead"), since (when that tab became active)}.
  // Who plays: the highest gen; for the same gen the tab that was there first. A busy or background tab that misses
  // heartbeats (browsers slow timers in hidden tabs to once a minute) still keeps its place: the BroadcastChannel answers.
  const bc = typeof BroadcastChannel === 'function' ? new BroadcastChannel('sector9-session') : null;
  const lock = () => get(LS.lock);
  const fresh = l => !!(l && l.id && Date.now() - l.t < STALE);
  let myGen = 0, mySince = 0;
  const claim = () => put(LS.lock, { id: tabId, t: Date.now(), gen: myGen, since: mySince });
  const beats = o => o && o.id !== tabId && ((o.gen | 0) > myGen || ((o.gen | 0) === myGen && (o.since || 0) < mySince));   // does that tab outrank me?
  let decide; const decision = new Promise(r => { decide = r; });
  function settle(active) { if (S.decided) return; S.decided = true; if (active) { const l = lock(); myGen = l ? l.gen | 0 : 0; mySince = Date.now(); activate(true); } else deactivate('Sector Nine is already open in another tab', true); decide(); }
  const here = () => bc && bc.postMessage({ k: 'here', id: tabId, gen: myGen, since: mySince });
  if (bc) bc.onmessage = e => {
    const d = e.data || {}; if (!d.id || d.id === tabId) return;
    if (d.k === 'who') { if (S.active) here(); }
    else if (d.k === 'here') { if (!S.decided) settle(false); else if (S.active) { if (beats(d)) deactivate('Sector Nine is already open in another tab'); else here(); } }
    else if (d.k === 'take') { if (!S.decided) settle(false); else if (S.active && (d.gen | 0) >= myGen) deactivate('Sector Nine is already open in another tab'); }
  };
  const check = () => { if (!S.active) return; const l = lock(); if (l && l.id !== tabId && beats(l)) { deactivate('Sector Nine is already open in another tab'); return; } claim(); };
  addEventListener('storage', e => { if (e.key === LS.lock) check(); });
  setInterval(check, BEAT);
  addEventListener('pagehide', () => { const l = lock(); if (S.active && l && l.id === tabId) put(LS.lock, null); });
  // decided once this whole file has run (the blocker screen below must exist first)
  // (a lock that is a bit old, up to 2 minutes, means another tab probably exists but is slowed down: browsers run
  // background-tab timers once a minute. Then wait longer for its answer.)
  // a link from our emails (#confirm= / #reset=) is the player choosing THIS tab: it takes over at once (newest wins),
  // the older tab pauses with "Use here instead". Never block the email link behind the other-tab screen.
  const fromEmail = /^#(confirm|reset)=/.test(location.hash || '');
  Promise.resolve().then(() => { if (fromEmail && !S.decided) { S.decided = true; activate(false); decide(); return; } const l = lock(); if (fresh(l) && l.id !== tabId) settle(false); else { const recent = l && l.id && l.id !== tabId && Date.now() - l.t < 120000; if (bc) bc.postMessage({ k: 'who', id: tabId }); setTimeout(() => { const m = lock(); settle(!(fresh(m) && m.id !== tabId)); }, bc ? (recent ? 4000 : 800) : 0); } });

  function activate(first) {
    if (!first) { const l = lock(); myGen = Math.max(myGen, l ? l.gen | 0 : 0) + 1; mySince = Date.now(); }
    S.active = true; S.blocked = false; S.why = ''; claim(); hideScreen();
    if (first) { here(); return; }
    if (bc) bc.postMessage({ k: 'take', id: tabId, gen: myGen });
    // back online: a room this tab was in reconnects by itself; otherwise go back to the room this browser was playing in
    const r = room(), had = S.hadSocket; S.hadSocket = false;
    if (r && r.server) { if (typeof srvInit === 'function') srvInit(); return; }
    const last = get(LS.last);
    if (!r && last && last.code && Date.now() - last.t < LAST_OK && typeof openRoom === 'function') {
      try { NET.nick = last.nick || NET.nick; $('nick').value = NET.nick; $('onlinePanel').hidden = false; } catch (e) {}
      openRoom(false, last.code); return;
    }
    if (had && typeof srvInit === 'function') srvInit();   // was connected at the menu (friends / account): connect again
  }
  function deactivate(why, first) {
    const was = S.active; S.active = false; S.blocked = true; S.why = why || '';
    showScreen(why);
    if (!first && !was && !S.kickedNow) return;
    S.kickedNow = false;
    try { if (state === 'play') setState('paused'); else if (state === 'dead') P.pauseOnRespawn = true; } catch (e) {}
    try { if (document.pointerLockElement) document.exitPointerLock(); } catch (e) {}
    try { if (typeof SRV !== 'undefined' && SRV.ws) { S.hadSocket = true; if (SRV.ws.readyState === 1 && !S.wasKicked) SRV.ws.send('{"k":"handoff"}'); SRV.ws.close(4002, 'other tab'); } } catch (e) {}   // a hand-off: the others see no "left" / "rejoined"
    S.wasKicked = false;
  }
  // the full-screen blocker
  const css = document.createElement('style');
  css.textContent = `#s9sess{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;background:rgba(6,8,12,.94);backdrop-filter:blur(6px);font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#e9eef5}
#s9sess[hidden]{display:none}#s9sess .card{max-width:440px;width:100%;text-align:center;padding:28px 22px;border-radius:14px;background:#11161e;border:1px solid rgba(255,255,255,.1);box-shadow:0 20px 60px rgba(0,0,0,.6)}
#s9sess .k{font-size:12px;letter-spacing:.18em;text-transform:uppercase;opacity:.6;margin-bottom:10px}#s9sess h2{margin:0 0 10px;font-size:clamp(20px,5vw,26px);line-height:1.25}
#s9sess p{margin:0 0 20px;font-size:15px;line-height:1.5;opacity:.8}#s9sess button{font:700 16px system-ui,sans-serif;padding:13px 22px;border-radius:10px;border:0;cursor:pointer;background:#ff8a3d;color:#111;min-width:200px;max-width:100%}
#s9sess button:hover{filter:brightness(1.08)}#s9sess button:focus-visible{outline:3px solid #fff;outline-offset:2px}`;
  document.head.appendChild(css);
  const scr = document.createElement('div'); scr.id = 's9sess'; scr.hidden = true; scr.setAttribute('role', 'dialog'); scr.setAttribute('aria-modal', 'true');
  scr.innerHTML = '<div class="card"><div class="k">Sector Nine</div><h2 id="s9sessT"></h2><p id="s9sessP"></p><button id="s9sessUse" type="button">Use here instead</button></div>';
  const mount = () => { if (!scr.isConnected) document.body.appendChild(scr); };
  if (document.body) mount(); else addEventListener('DOMContentLoaded', mount);
  scr.querySelector('#s9sessUse').addEventListener('click', () => activate(false));
  for (const ev of ['keydown', 'keyup', 'mousedown', 'wheel']) addEventListener(ev, e => { if (!scr.hidden && !scr.contains(e.target)) { e.stopImmediatePropagation(); if (ev !== 'keyup') e.preventDefault(); } }, true);
  function showScreen(why) {
    mount(); scr.querySelector('#s9sessT').textContent = why || 'Sector Nine is already open in another tab';
    scr.querySelector('#s9sessP').textContent = 'You can play in one tab at a time. Your match and score move with you.';
    scr.hidden = false;
  }
  function hideScreen() { scr.hidden = true; }

  // a blocked tab stops drawing and goes silent (saves the GPU/battery for the tab that plays); 4 cheap ticks a second
  if (typeof frame === 'function') {   // (never during start-up: the game must finish booting first)
    const _frame = frame;
    frame = function (now) { if (!S.blocked || typeof state === 'undefined' || state === 'loading' || !window.__s9) return _frame.apply(this, arguments); try { last = now; } catch (e) {} setTimeout(() => requestAnimationFrame(frame), 250); };
  }
  setInterval(() => { try { if (typeof AU !== 'undefined' && AU.ctx) { if (S.blocked && AU.ctx.state === 'running') AU.ctx.suspend(); else if (!S.blocked && AU.ctx.state === 'suspended' && S.wasMuted) AU.ctx.resume(); S.wasMuted = S.blocked; } } catch (e) {} }, 500);

  /* ---------------- connection: wait for the tab decision, add identity to join/create ---------------- */
  if (typeof srvInit === 'function') {
    const _init = srvInit;
    srvInit = function () { if (!S.decided) return decision.then(() => S.blocked ? false : _init.apply(this, arguments)); if (S.blocked) return Promise.resolve(false); return _init.apply(this, arguments); };
  }
  const tokens = () => { const t = get(LS.rj) || {}; const now = Date.now(); for (const k of Object.keys(t)) if (!t[k] || now - t[k].t > TOKEN_OK) delete t[k]; return t; };
  if (typeof srvSend === 'function') {
    const _send = srvSend;
    srvSend = function (o) {
      if (S.blocked) return;
      if (o && typeof o === 'object') {
        if (o.k === 'join' || o.k === 'create') { o = Object.assign({ pv: 2 }, o); const t = o.k === 'join' && tokens()[String(o.code || '').toUpperCase()]; if (t) o.rj = t.tok; }
        if (o.k === 'create' && o.meta && $('rTime')) o.meta = Object.assign({}, o.meta, { time: +$('rTime').value || 0 });
        if (o.k === 'meta' && o.m && o.m.kills !== undefined && o.m.started === undefined && $('eTime')) o.m = Object.assign({}, o.m, { time: +$('eTime').value || 0 });
      }
      return _send.call(this, o);
    };
  }
  if (typeof openRoom === 'function') { const _open = openRoom; openRoom = async function () { if (!S.decided) await decision; if (S.blocked) { showScreen(S.why); return false; } return _open.apply(this, arguments); }; }
  if (typeof startBrowsing === 'function') { const _br = startBrowsing; startBrowsing = async function () { if (!S.decided) await decision; if (S.blocked) return; return _br.apply(this, arguments); }; }

  // what the server tells us
  if (typeof SRV !== 'undefined' && SRV.on) SRV.on.add(d => {
    if (!d || typeof d !== 'object') return;
    switch (d.k) {
      case 'hello': if (S.active) srvSend({ k: 'sess', b: bid }); break;
      case 'kicked': S.kickedNow = true; S.wasKicked = true; deactivate('Sector Nine is already open in another tab'); break;
      case 'welcome': {
        const code = d.meta && d.meta.code; if (!code) break;
        if (d.rj) { const t = tokens(); t[code] = { tok: d.rj, t: Date.now() }; put(LS.rj, t); }
        put(LS.last, { code, nick: NET.nick, t: Date.now() });
        S.rejoining = !!d.rejoined; break;
      }
      case 'left': if (d.quiet && d.id) { S.quietLeave.add(d.id); setTimeout(() => S.quietLeave.delete(d.id), 5000); } break;   // moved to another tab: no line
      case 'rejoined': if (d.id) { S.quiet.add(d.id); S.dropped.delete(d.id); if (NET.inMatch && !d.quiet) feed(`${String(d.n || 'A player').slice(0, 16)} rejoined`); } break;
      case 'rec': applyRec(d); break;
      case 'mx': onMx(d); break;
    }
  });
  setInterval(() => { const r = room(); if (S.active && r && r.server && r.code) { const l = get(LS.last); if (!l || l.code !== r.code || Date.now() - l.t > 2000) put(LS.last, { code: r.code, nick: NET.nick, t: Date.now() }); } }, 2000);

  /* ---------------- 2. rejoin: take my record back from the server ---------------- */
  function applyRec(d) {
    const r = srvRoom(); if (!r || !NET.inMatch || d.code !== r.code || d.id !== r.myId) return;
    PLAYER_ENT.kills = d.kills | 0; PLAYER_ENT.deaths = d.deaths | 0; PLAYER_ENT.score = Math.max(PLAYER_ENT.score | 0, (d.kills | 0) * 100);
    if (S.rejoining) { S.rejoining = false; if (d.kills || d.deaths) feed('Welcome back: your score was kept'); }
    // Demolition: rejoining in the middle of a round = out until the next round
    if (d.mode === 'demo' && !d.alive && !P.dead && d.phase === 'live') {
      const paused = state === 'paused';
      try { playerDie(null, '', false); $('deathBy').textContent = 'You rejoined mid-round · you play again next round'; } catch (e) {}
      if (paused) setState('paused');
    }
    try { updateHud(); } catch (e) {}
  }
  if (typeof startOnlineMatch === 'function') {
    const _som = startOnlineMatch;
    startOnlineMatch = function () {
      const out = _som.apply(this, arguments);
      G.matchT = Infinity; G.starting = false; S.dropped.clear(); S.endT = 0;
      const r = srvRoom();
      if (r) {
        // coming back into a running match: take my kills/deaths from the newest server view right away (no "0" flicker
        // on the others' scoreboards), then ask the server to confirm
        const v = r.match, q = v && v.phase !== 'over' && Array.isArray(v.pl) && v.pl.find(p => p[0] === r.myId);
        if (q && (q[2] || q[3])) { PLAYER_ENT.kills = q[2] | 0; PLAYER_ENT.deaths = q[3] | 0; PLAYER_ENT.score = Math.max(PLAYER_ENT.score | 0, (q[2] | 0) * 100); }
        if (v && v.mode !== 'demo' && v.end) G.matchT = Math.max(0, (v.end - v.now) / 1000);
        srvSend({ k: 'sync' });          // the server answers with my record (kills/deaths if I was here before)
      }
      return out;
    };
  }
  // other players: "<nick> rejoined" instead of "joined the match", and their deaths shown right after a rejoin
  if (typeof peerEntry === 'function') {
    const _pe = peerEntry;
    peerEntry = function (id, pr) {
      if (NET.peers.has(id)) return _pe.apply(this, arguments);
      const back = S.dropped.has(id), quiet = S.quiet.has(id); S.dropped.delete(id); S.quiet.delete(id);
      if (!back && !quiet) return _pe.apply(this, arguments);
      const kt = kfeedText; kfeedText = () => {};
      let E; try { E = _pe.apply(this, arguments); } finally { kfeedText = kt; }
      if (back && !quiet) feed(`${String((pr && pr.n) || 'A player').slice(0, 16)} rejoined`);
      return E;
    };
  }
  if (typeof dropPeer === 'function') { const _dp = dropPeer; dropPeer = function (id, announce) {
    if (S.quietLeave.has(id)) { S.quietLeave.delete(id); S.quiet.add(id); return _dp.call(this, id, false); }   // tab hand-off: silent
    if (announce && NET.inMatch && NET.peers.has(id)) S.dropped.add(id); return _dp.apply(this, arguments); }; }
  if (typeof netReceive === 'function') { const _nr = netReceive; netReceive = function (E, pr) {
    const k0 = PLAYER_ENT.kills, sm = serverMatch();
    const out = _nr.apply(this, arguments);
    if (sm && PLAYER_ENT.kills !== k0) PLAYER_ENT.kills = k0;     // the kill effects play, but the count comes from the server
    if (E && E.r && pr && Array.isArray(pr.x) && pr.D !== undefined) E.r.deaths = pr.D | 0; return out; }; }

  /* ---------------- 3. online matches end only when the server says so ---------------- */
  if (typeof endMatch === 'function') {
    const _end = endMatch;
    endMatch = function () { if (serverMatch() && !S.allowEnd) return; return _end.apply(this, arguments); };
  }
  const TEAMN = { atk: 'Strike Force', def: 'Sentinels' };
  function onMx(d) {
    const r = srvRoom(); if (!r || !NET.inMatch) return;
    const v = d.v;
    // the host's time limit (if any) drives the match clock; no limit = no clock
    if (v && v.mode !== 'demo') G.matchT = v.end ? Math.max(0, (v.end - v.now) / 1000) : Infinity;
    // my kill count = the server's (it counts every kill from the victims' reports, once). Counting on this screen from
    // the victims' state can miss or double a kill when a victim dies twice between two frames.
    const q = v && Array.isArray(v.pl) && v.pl.find(p => p[0] === r.myId);
    if (q && (q[2] | 0) !== (PLAYER_ENT.kills | 0)) { PLAYER_ENT.score = Math.max(0, (PLAYER_ENT.score | 0) + ((q[2] | 0) - (PLAYER_ENT.kills | 0)) * 100); PLAYER_ENT.kills = q[2] | 0; try { updateHud(); } catch (x) {} }
    for (const e of d.e || []) {
      if (e.k === 'matchEnd') finishFromServer(e, v);
      else if (e.k === 'toLobby' && !window.MODE && typeof toRoomLobby === 'function') toRoomLobby('Match over. The host can change the map or mode and start again.');
    }
  }
  function finishFromServer(e, v) {
    const r = srvRoom(), me = r.myId, rows = e.table || [];
    for (const t of rows) { if (t.id === me) { PLAYER_ENT.kills = t.kills | 0; PLAYER_ENT.deaths = t.deaths | 0; } else { const b = typeof remoteById === 'function' && remoteById(t.id); if (b) { b.kills = t.kills | 0; b.deaths = t.deaths | 0; } } }
    const mode = (v && v.mode) || (r.meta && r.meta.mode) || 'ffa', team = window.MODE && MODE.myTeam ? MODE.myTeam() : null;
    const w = e.winner, draw = w === 'draw' || w === null, mine = w === me || (team && w === team);
    const row = rows.find(t => t.id === w);
    const winner = w === me ? PLAYER_ENT : (typeof remoteById === 'function' && remoteById(w)) || { name: TEAMN[w] || (row && row.n) || 'Nobody', isPlayer: false };
    S.allowEnd = true; try { G.ended = false; endMatch(winner); } finally { S.allowEnd = false; }
    G.starting = true; S.endT = performance.now();     // never start a new match locally: the server brings everyone back to the room
    try {
      $('mendTitle').innerHTML = draw ? 'Draw' : mine ? 'Victory' : 'Defeat';
      $('mendKicker').textContent = mode === 'demo' ? `${TEAMN[w] || 'Nobody'} win ${e.score ? e.score.atk + ' : ' + e.score.def : ''}` : mode === 'tdm' ? (draw ? 'Draw' : `${TEAMN[w]} reached ${KILL_LIMIT} kills`) : draw ? 'Time' : `${w === me ? 'You' : winner.name} reached ${KILL_LIMIT}`;
    } catch (x) {}
  }
  // safety: if the room never answers, go back to the room lobby (never into a fresh local match)
  setInterval(() => { if (S.endT && performance.now() - S.endT > 20000 && state === 'matchend' && NET.on) { S.endT = 0; G.starting = false; if (typeof toRoomLobby === 'function') toRoomLobby('Match over.'); } }, 1000);
  for (const fn of ['toRoomLobby', 'leaveOnline']) if (typeof window[fn] === 'function') { const o = window[fn]; window[fn] = function () { const out = o.apply(this, arguments); G.starting = false; S.endT = 0; return out; }; }
  // "Next match" on the results screen of a server match = back to the room (the host starts the next one)
  const nextBtn = document.getElementById('btnNext');
  if (nextBtn) nextBtn.addEventListener('click', e => { if (NET.on && srvRoom() && (serverMatch() || S.endT)) { e.stopImmediatePropagation(); S.endT = 0; G.starting = false; toRoomLobby('Waiting for the host to start the next match...'); } }, true);
  // the clock: hidden when there is no time limit
  if (typeof updateAbilities === 'function') {
    const _ua = updateAbilities;
    updateAbilities = function () { const out = _ua.apply(this, arguments); const el = document.getElementById('mTime'); if (el) { const none = !isFinite(G.matchT); if (none && el.textContent !== '') el.textContent = ''; el.style.display = none ? 'none' : ''; } return out; };
  }

  /* ---------------- room screens: time limit picker, "Rejoin" in the room list ---------------- */
  const TIMES = [[0, 'No time limit'], [5, '5 minutes'], [10, '10 minutes'], [15, '15 minutes'], [20, '20 minutes'], [30, '30 minutes']];
  function addTime(afterId, id) {
    const ref = document.getElementById(afterId); if (!ref || document.getElementById(id)) return;
    const lab = document.createElement('label'); lab.className = 's9timeLab'; lab.textContent = 'Time limit';
    const sel = document.createElement('select'); sel.id = id; for (const [v, t] of TIMES) { const o = document.createElement('option'); o.value = String(v); o.textContent = t; sel.appendChild(o); }
    lab.appendChild(sel); (ref.closest('label') || ref).insertAdjacentElement('afterend', lab);
    if (id === 'eTime') sel.addEventListener('input', () => { const ed = document.getElementById('oEdit'); if (ed) ed.dataset.dirty = '1'; const m = document.getElementById('oEditMsg'); if (m) m.textContent = 'Unsaved changes'; });
  }
  addTime('rKills', 'rTime'); addTime('eKills', 'eTime');
  if (typeof renderRoom === 'function') {
    const _rr = renderRoom;
    renderRoom = function (m) {
      const out = _rr.apply(this, arguments); if (!m) return out;
      const et = document.getElementById('eTime'), ed = document.getElementById('oEdit');
      if (et && ed && !ed.dataset.dirty && !ed.contains(document.activeElement)) et.value = String(m.time | 0);
      const info = document.getElementById('oRoomInfo'); if (info && !/time limit| min\b/.test(info.textContent)) info.textContent += m.time ? ` · ${m.time} min` : ' · no time limit';
      return out;
    };
  }
  if (typeof renderRoomList === 'function') {
    const _rl = renderRoomList;
    renderRoomList = function (list) {
      const out = _rl.apply(this, arguments), t = tokens();
      for (const b of document.querySelectorAll('#roomList [data-room]')) { const r = (list || []).find(x => x.code === b.dataset.room); if (r && r.started && t[r.code] && !b.disabled) b.textContent = 'Rejoin'; }
      return out;
    };
  }

  window.S9Session = { get active() { return S.active; }, get blocked() { return S.blocked; }, tabId, browserId: bid, takeOver: () => activate(false), ready: decision, _S: S };
})();
