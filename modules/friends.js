// Sector Nine friends, client side: a slide-in Friends panel, live presence, invites, join / follow, toasts, nav badge.
// Self-contained: injects its own CSS + DOM; talks to /api/friends* through S9Account.api and to the game server over the
// game's own WebSocket (SRV / srvSend in index.html) with {k:'fr*'} messages.
// Public: window.S9Friends = { open(), close(), inviteToRoom(code?), list(), onChange(fn), refresh(), isOpen() }
// Security: every nickname / room name goes in through textContent (never innerHTML). No secrets in here.
(function () {
  'use strict';
  if (window.S9Friends) return;

  const ACC = () => window.S9Account || null;
  const token = () => { const a = ACC(); return a && a.token ? a.token() : null; };
  const G = () => window.__s9 || {};
  const hasNet = () => typeof srvSend === 'function' && typeof srvInit === 'function' && typeof SRV !== 'undefined';
  const net = () => (typeof NET !== 'undefined' ? NET : null);
  const room = () => { const n = net(); return n && n.room && n.room.meta ? n.room : null; };
  const now = () => Date.now();

  // ---------------------------------------------------------------- state
  const ST = { me: null, friends: [], incoming: [], outgoing: [], blocked: [], invites: [], followers: [], following: null, loaded: false, linked: false, vis: null, err: '' };
  const subs = new Set();
  const invited = new Map();           // friendId -> until (ms) after we invited them
  const seenReq = new Set();           // incoming request ids already seen (badge)
  const onlineToastAt = new Map();     // friendId -> last "came online" toast
  let inviteMode = null;               // room code while the panel is in "invite friends" mode
  let menuFor = null, confirmFor = null, blockedOpen = false;
  const emit = () => { for (const f of [...subs]) try { f(api.list()); } catch (e) { console.error(e); } };

  // ---------------------------------------------------------------- helpers
  const MODES = { ffa: 'Free for all', tdm: 'Team deathmatch', demo: 'Demolition' };
  const mapName = id => { const M = (G().MAPS) || (typeof MAPS !== 'undefined' ? MAPS : []); const m = M && M.find && M.find(x => x.id === id); return m ? m.name : String(id || ''); };
  const modeName = m => MODES[m] || 'Free for all';
  function ago(t) {
    if (!t) return ''; const s = Math.max(0, (now() - t) / 1000);
    if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + ' min ago'; if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    const d = Math.floor(s / 86400); return d === 1 ? 'yesterday' : d < 30 ? d + ' days ago' : 'a while ago';
  }
  const mmss = msec => { const s = Math.max(0, Math.ceil(msec / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const hue = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };
  const STATUS = {
    match: { label: 'In match', group: 'In a match', c: '#ff9a3c', o: 0 },
    lobby: { label: 'In lobby', group: 'In a lobby', c: '#7fe7ff', o: 1 },
    online: { label: 'Online', group: 'Online', c: '#5cff9d', o: 2 },
    away: { label: 'Away', group: 'Away', c: '#ffcf5a', o: 3 },
    offline: { label: 'Offline', group: 'Offline', c: '#5a5f68', o: 4 },
  };
  const stOf = f => (f.p && STATUS[f.p.st] ? f.p.st : 'offline');
  function doing(p) {
    if (!p) return 'Offline';
    const r = p.room, vis = r && r.vis === 'private' ? 'Private' : r && r.vis === 'friends' ? 'Friends only' : '';
    if (p.st === 'match' && r) return ['In match', modeName(r.mode), mapName(r.map), p.score || ''].filter(Boolean).join(' · ');
    if (p.st === 'lobby' && r) return ['In lobby', r.name, modeName(r.mode), mapName(r.map), (r.n | 0) + '/' + (r.max | 0), vis].filter(Boolean).join(' · ');
    if (p.st === 'away') return r ? 'Away · in ' + r.name : 'Away';
    if (p.st === 'online') return 'Online · in the menu';
    return p.seen ? 'Offline · seen ' + ago(p.seen) : 'Offline';
  }

  // ---------------------------------------------------------------- server
  function send(o) { if (hasNet()) try { srvSend(o); } catch (e) {} }
  function sendAuth() { if (hasNet() && srvOn()) send({ k: 'frAuth', token: token() || null }); }
  let retryT = null, retryMs = 2000;
  async function connect() {
    clearTimeout(retryT);
    if (!token() || !hasNet()) return;
    let okc = false; try { okc = await srvInit(); } catch (e) {}
    if (okc) { retryMs = 2000; sendAuth(); send({ k: 'frVis', hidden: !!document.hidden }); }
    else { retryT = setTimeout(connect, retryMs); retryMs = Math.min(30000, retryMs * 2); }
  }
  async function http(path, body, method) {
    const a = ACC(); if (!a || !a.api) throw new Error('Sign in to add friends.');
    return a.api(path, body !== undefined ? { method: method || 'POST', body } : { method: method || 'GET' });
  }
  let refT = null;
  function refresh() { clearTimeout(refT); return new Promise(res => { refT = setTimeout(async () => { await load(); res(api.list()); }, 120); }); }
  async function load() {
    if (!token()) { reset(); render(); return; }
    try { applyState(await http('/api/friends')); ST.err = ''; }
    catch (e) { ST.err = e.status === 401 ? 'Please sign in again.' : e.message || 'Could not load friends.'; }
    render();
  }
  function reset() { Object.assign(ST, { me: null, friends: [], incoming: [], outgoing: [], blocked: [], invites: [], followers: [], following: null, loaded: false, linked: false, vis: null, err: '' }); for (const t of [...toasts.keys()]) dropToast(t); }
  function applyState(s) {
    if (!s || !s.me) return;
    const first = !ST.loaded;
    ST.me = s.me; ST.friends = s.friends || []; ST.incoming = s.incoming || []; ST.outgoing = s.outgoing || []; ST.blocked = s.blocked || [];
    ST.followers = s.followers || []; ST.following = s.following || null;
    const t = now(); ST.invites = (s.invites || []).map(i => Object.assign({}, i, { until: t + (i.ttl | 0) }));
    ST.loaded = true;
    if (first) for (const r of ST.incoming) if (isOpen()) seenReq.add(r.id);
    for (const i of ST.invites) if (!toasts.has('inv:' + i.id)) inviteToast(i);
    emit();
  }
  function onMsg(d) {
    if (!d || typeof d.k !== 'string') return;
    if (d.k === 'hello') { if (token()) setTimeout(sendAuth, 0); return; }
    if (d.k === '_closed') { ST.linked = false; render(); if (token()) { clearTimeout(retryT); retryT = setTimeout(connect, 2500); } return; }
    if (d.k.slice(0, 2) !== 'fr') return;
    switch (d.k) {
      case 'frAuthed': ST.linked = !!d.id; if (d.id && ST.me) ST.me.code = d.code || ST.me.code; render(); return;
      case 'frState': applyState(d); render(); return;
      case 'frPres': {
        const f = ST.friends.find(x => x.id === d.id);
        if (!f) { refresh(); return; }
        const was = stOf(f); f.p = d.p || { st: 'offline' };
        if (was === 'offline' && f.p.st !== 'offline' && ST.loaded && now() - (onlineToastAt.get(f.id) || 0) > 60000) { onlineToastAt.set(f.id, now()); toast({ kind: 'online', title: f.nick, body: 'came online', ttl: 4500 }); }
        render(); emit(); return;
      }
      case 'frReq': toast({ key: 'req:' + d.from.id, kind: 'req', title: d.from.nick, body: 'wants to be your friend', ttl: 20000, actions: [['Accept', () => answerReq(d.from.id, true), 's9f-pri'], ['Decline', () => answerReq(d.from.id, false)]] }); refresh(); return;
      case 'frAccepted': toast({ kind: 'ok', title: d.by.nick, body: 'accepted your friend request', ttl: 5000 }); refresh(); return;
      case 'frGone': ST.friends = ST.friends.filter(f => f.id !== d.id); render(); emit(); refresh(); return;
      case 'frSync': refresh(); return;
      case 'frInvite': { const i = Object.assign({}, d.inv, { until: now() + (d.inv.ttl | 0) }); ST.invites = ST.invites.filter(x => x.id !== i.id).concat(i); inviteToast(i); render(); emit(); return; }
      case 'frInviteGone': ST.invites = ST.invites.filter(x => x.id !== d.id); dropToast('inv:' + d.id); render(); emit(); return;
      case 'frInviteSent': invited.set(d.to.id, now() + (d.ttl | 0)); toast({ kind: 'ok', title: 'Invite sent', body: 'to ' + d.to.nick + ' · they have 2 minutes to answer', ttl: 3500 }); render(); return;
      case 'frInviteRes': {
        invited.delete(d.to.id); const n = d.to.nick;
        const msg = d.yes ? 'accepted your invite. On the way.' : d.why === 'declined' ? 'declined your invite.' : d.why === 'expired' ? "didn't answer in time." : d.why === 'offline' ? 'went offline.' : '';
        if (msg && d.why !== 'replaced') toast({ kind: d.yes ? 'ok' : 'info', title: n, body: msg, ttl: 4500 }); render(); return;
      }
      case 'frJoin': joinRoom(d.code, d); return;
      case 'frFollowers': {
        const old = new Set(ST.followers.map(f => f.id)); ST.followers = d.list || [];
        for (const f of ST.followers) if (!old.has(f.id)) toast({ kind: 'ok', title: f.nick, body: 'is following you', ttl: 4000 });
        render(); return;
      }
      case 'frFollowEnd': { const why = { offline: 'went offline', left: 'you went to another room', closed: 'the room closed', private: 'their new room is private', friends: 'their new room is for the host’s friends only', gone: 'you are no longer friends', you: '' }[d.why];
        ST.following = null; if (why !== '' && d.nick) toast({ kind: 'info', title: 'Stopped following ' + d.nick, body: why || '', ttl: 4500 }); render(); return; }
      case 'frRoomVis': ST.vis = d; render(); syncLobby(); return;
      case 'frErr': if (d.ref !== 'frVis' && d.ref !== 'frAuth') toast({ kind: 'err', title: 'Friends', body: d.e, ttl: 5000 }); if (d.ref === 'frJoinFriend' || d.ref === 'frFollow') { pendingJoin = null; render(); } return;
    }
  }
  try { if (typeof SRV !== 'undefined' && SRV.on) SRV.on.add(onMsg); } catch (e) {}

  // ---------------------------------------------------------------- actions
  async function answerReq(id, yes) {
    try { await http('/api/friends/' + (yes ? 'accept' : 'decline'), { id }); dropToast('req:' + id); if (yes) { const r = ST.incoming.find(x => x.id === id); toast({ kind: 'ok', title: r ? r.nick : 'Friend', body: 'is now your friend', ttl: 3500 }); } }
    catch (e) { toast({ kind: 'err', title: 'Friends', body: e.message, ttl: 5000 }); }
    await load();
  }
  async function simple(path, id, okMsg) {
    try { await http('/api/friends/' + path, { id }); if (okMsg) toast({ kind: 'info', title: okMsg, ttl: 3000 }); } catch (e) { toast({ kind: 'err', title: 'Friends', body: e.message, ttl: 5000 }); }
    menuFor = confirmFor = null; await load();
  }
  async function addFriend(q) {
    q = String(q || '').trim(); if (!q) return say('Type a nickname or a friend code like NICK#1234.', true);
    try {
      const r = await http('/api/friends/request', { q });
      say(r.state === 'friends' ? 'You and ' + r.player.nick + ' are friends now.' : 'Request sent to ' + r.player.nick + '.', false);
      const inp = panel.querySelector('.s9f-add input'); if (inp) inp.value = '';
    } catch (e) { say(e.message, true); }
    await load();
  }
  async function setPrivacy(patch) {
    try { const r = await http('/api/friends/privacy', patch, 'PUT'); if (ST.me) ST.me.privacy = r.privacy; } catch (e) { toast({ kind: 'err', title: 'Friends', body: e.message, ttl: 5000 }); }
    render();
  }
  function invite(id) { const r = room(); if (!r) return toast({ kind: 'info', title: 'Make a room first', body: 'Open Online, create or join a room, then invite friends.', ttl: 5000 }); send({ k: 'frInvite', to: id, room: r.code }); }
  let pendingJoin = null;
  function joinFriend(id, follow) { pendingJoin = id; send({ k: follow ? 'frFollow' : 'frJoinFriend', id }); render(); setTimeout(() => { if (pendingJoin === id) { pendingJoin = null; render(); } }, 8000); }
  function answerInvite(i, yes) { send({ k: 'frInviteAns', id: i.id, yes }); ST.invites = ST.invites.filter(x => x.id !== i.id); dropToast('inv:' + i.id); render(); emit(); }
  function setVis(v) { send({ k: 'frRoomVis', vis: v }); }

  // join a room the server cleared us for: leave whatever we're in, go to the lobby, join by code
  async function joinRoom(code, d) {
    pendingJoin = null;
    if (!/^[A-Z0-9]{4,8}$/.test(String(code || ''))) return;
    const n = net(); if (!n || typeof openRoom !== 'function') return;
    if (n.room && n.room.code === code) { if (d && d.why === 'follow') ST.following = d.leader || ST.following; render(); return; }
    const who = d && (d.from || d.leader);
    toast({ kind: 'ok', title: d && d.why === 'follow' ? 'Following ' + (who ? who.nick : '') : 'Joining ' + (who ? who.nick + '’s room' : 'room'), body: 'Connecting...', ttl: 2500 });
    if (d && d.why === 'follow') ST.following = d.leader || null;
    try {
      if (n.room && typeof leaveOnline === 'function') leaveOnline();
      if (G().state && G().state !== 'menu' && typeof menuScene === 'function' && typeof setState === 'function') { menuScene(); setState('menu'); }
      const nick = document.getElementById('nick'), p = ACC() && ACC().profile && ACC().profile();
      if (nick && !nick.value && p && p.nick) nick.value = p.nick;
      const op = document.getElementById('onlinePanel'); if (op) op.hidden = false;
      const okj = await openRoom(false, code);
      if (okj) { if (isOpen() && innerWidth < 700) close(); }
    } catch (e) { console.error(e); }
    render();
  }

  // ---------------------------------------------------------------- styles
  const css = `
#s9f-panel,#s9f-toasts,.s9f-nav,#s9f-lobby{--f-bg:var(--bg,#0b0d10);--f-ink:var(--ink,#ece6d8);--f-dim:var(--dim,#8b9097);--f-acc:var(--sodium,#ff9a3c);--f-cy:var(--cyan,#7fe7ff);--f-bad:var(--alert,#ff4a3d);--f-line:var(--line,rgba(236,230,216,.16));--f-disp:var(--display,"Big Shoulders Stencil Display",Impact,"Arial Narrow",sans-serif);--f-mono:var(--mono,"IBM Plex Mono",ui-monospace,Consolas,monospace)}
#s9f-panel *,#s9f-toasts *{box-sizing:border-box}
.s9f-nav{position:relative}
.s9f-nav .s9f-badge{position:absolute;top:-8px;right:-8px;min-width:20px;height:20px;padding:0 5px;display:grid;place-items:center;background:var(--f-acc);color:#14100b;font:700 11px/1 var(--f-mono);clip-path:polygon(4px 0,100% 0,100% calc(100% - 4px),calc(100% - 4px) 100%,0 100%,0 4px);box-shadow:0 0 14px rgba(255,154,60,.55);animation:s9f-pop .35s cubic-bezier(.2,1.6,.4,1)}
.s9f-nav .s9f-badge[hidden]{display:none}
.s9f-nav .s9f-on{display:inline-block;width:7px;height:7px;border-radius:50%;background:#5cff9d;margin-left:8px;vertical-align:1px;box-shadow:0 0 8px #5cff9d}
.s9f-nav .s9f-on[hidden]{display:none}
#s9f-scrim{position:fixed;inset:0;z-index:74;background:rgba(5,6,8,.35);opacity:0;pointer-events:none;transition:opacity .2s}
#s9f-scrim.on{opacity:1;pointer-events:auto}
#s9f-panel{position:fixed;top:0;right:0;bottom:0;z-index:75;width:min(430px,100vw);display:flex;flex-direction:column;color:var(--f-ink);font-family:var(--f-mono);
  background:linear-gradient(180deg,rgba(18,21,26,.96),rgba(9,11,14,.97));border-left:1px solid var(--f-line);box-shadow:-30px 0 80px rgba(0,0,0,.55);
  -webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);transform:translateX(104%);transition:transform .28s cubic-bezier(.2,.9,.25,1);padding-bottom:env(safe-area-inset-bottom,0px)}
#s9f-panel.on{transform:none}
#s9f-panel::before{content:"";position:absolute;inset:0 auto 0 0;width:3px;background:linear-gradient(180deg,var(--f-acc),rgba(255,154,60,0) 40%,rgba(127,231,255,.0) 60%,var(--f-cy));opacity:.8}
#s9f-panel::after{content:"";position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg,rgba(255,255,255,.018) 0 1px,transparent 1px 3px)}
.s9f-head{position:relative;padding:22px 22px 14px;padding-top:calc(22px + env(safe-area-inset-top,0px));border-bottom:1px solid var(--f-line);background:radial-gradient(120% 140% at 100% 0,rgba(255,154,60,.13),transparent 55%)}
.s9f-k{font-size:11px;letter-spacing:.32em;text-transform:uppercase;color:var(--f-acc);display:flex;align-items:center;gap:10px}
.s9f-k i{width:7px;height:7px;background:var(--f-acc);transform:rotate(45deg);box-shadow:0 0 10px var(--f-acc)}
.s9f-h{font-family:var(--f-disp);font-weight:900;font-size:46px;line-height:.86;margin:8px 0 0;text-transform:uppercase;letter-spacing:.01em}
.s9f-h small.none{color:var(--f-dim)}
.s9f-h small{font-family:var(--f-mono);font-weight:600;font-size:12px;letter-spacing:.14em;color:#5cff9d;margin-left:12px;vertical-align:8px;text-transform:uppercase}
.s9f-x{position:absolute;top:calc(14px + env(safe-area-inset-top,0px));right:14px;width:40px;height:40px;border:1px solid var(--f-line);background:rgba(5,6,8,.4);color:var(--f-dim);font:22px/1 var(--f-mono);cursor:pointer}
.s9f-x:hover,.s9f-x:focus-visible{color:var(--f-ink);border-color:var(--f-acc);outline:none}
.s9f-body{position:relative;flex:1;overflow-y:auto;overflow-x:hidden;padding:16px 22px 26px;display:grid;grid-template-columns:minmax(0,1fr);gap:18px;align-content:start;scrollbar-width:thin;scrollbar-color:rgba(236,230,216,.2) transparent}
.s9f-code{display:flex;align-items:center;gap:12px;padding:12px 12px 12px 14px;background:rgba(255,154,60,.07);border:1px solid rgba(255,154,60,.35);clip-path:polygon(0 0,calc(100% - 12px) 0,100% 12px,100% 100%,0 100%)}
.s9f-code .l{font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--f-dim)}
.s9f-code .v{font-family:var(--f-disp);font-weight:900;font-size:28px;line-height:1;letter-spacing:.04em;word-break:break-all}
.s9f-code .v em{font-style:normal;color:var(--f-acc)}
.s9f-code > div{flex:1;min-width:0;display:grid;gap:4px}
.s9f-btn{font:600 11px var(--f-mono);letter-spacing:.16em;text-transform:uppercase;color:var(--f-ink);background:rgba(5,6,8,.5);border:1px solid var(--f-line);padding:9px 12px;cursor:pointer;white-space:nowrap;transition:border-color .12s,background .12s,color .12s;min-height:36px}
.s9f-btn:hover,.s9f-btn:focus-visible{border-color:var(--f-acc);outline:none}
.s9f-btn[disabled]{opacity:.45;cursor:default;border-color:var(--f-line)}
.s9f-btn.s9f-pri{background:var(--f-acc);color:#14100b;border-color:var(--f-acc);clip-path:polygon(0 0,100% 0,100% calc(100% - 8px),calc(100% - 8px) 100%,0 100%)}
.s9f-btn.s9f-pri:hover,.s9f-btn.s9f-pri:focus-visible{filter:brightness(1.12)}
.s9f-btn.s9f-cyb{border-color:rgba(127,231,255,.55);color:var(--f-cy)}
.s9f-btn.s9f-cyb:hover,.s9f-btn.s9f-cyb:focus-visible{background:rgba(127,231,255,.1);border-color:var(--f-cy)}
.s9f-btn.s9f-bad{color:#ffb3ab;border-color:rgba(255,74,61,.5)}
.s9f-btn.s9f-gh{border-color:transparent;background:transparent;color:var(--f-dim)}
.s9f-btn.s9f-gh:hover{color:var(--f-ink);border-color:var(--f-line)}
.s9f-add{display:flex;gap:8px}
.s9f-add input{flex:1;min-width:0;background:rgba(5,6,8,.75);color:var(--f-ink);border:1px solid var(--f-line);font:14px var(--f-mono);padding:10px 12px;outline:none;border-radius:0}
.s9f-add input:focus{border-color:var(--f-acc)}
.s9f-add input::placeholder{color:#6c7178}
.s9f-msg{font-size:12px;line-height:1.5;color:var(--f-cy);min-height:0;margin-top:-10px}
.s9f-msg.err{color:#ffb3ab}
.s9f-msg:empty{display:none}
.s9f-sec{display:grid;grid-template-columns:minmax(0,1fr);gap:8px}
.s9f-st{display:flex;align-items:center;gap:10px;font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:var(--f-dim)}
.s9f-st::after{content:"";flex:1;height:1px;background:var(--f-line)}
.s9f-st b{color:var(--f-ink);font-weight:600}
.s9f-st .dot{width:8px;height:8px;border-radius:50%}
.s9f-row{position:relative;display:grid;grid-template-columns:44px minmax(0,1fr) auto;gap:6px 12px;align-items:center;padding:10px 8px 10px 10px;background:rgba(236,230,216,.035);border:1px solid rgba(236,230,216,.07);transition:border-color .15s,background .15s;animation:s9f-in .25s ease-out both}
.s9f-row:hover{border-color:rgba(236,230,216,.18);background:rgba(236,230,216,.055)}
.s9f-row.off{opacity:.62}
.s9f-row.hl{border-color:rgba(255,154,60,.45);background:rgba(255,154,60,.06)}
.s9f-avw{position:relative;grid-row:1 / span 2;align-self:start;width:44px;height:44px}
.s9f-av{position:relative;width:44px;height:44px;display:grid;place-items:center;font-family:var(--f-disp);font-weight:900;font-size:22px;color:#0b0d10;clip-path:polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%)}
.s9f-dotw{position:absolute;right:-4px;bottom:-3px;width:15px;height:15px;border-radius:50%;border:3px solid #13161a;z-index:1}
.s9f-dotw.pulse{animation:s9f-pulse 1.8s ease-in-out infinite}
.s9f-who{min-width:0;display:grid;gap:3px}
.s9f-nm{display:flex;align-items:baseline;gap:8px;min-width:0}
.s9f-nm b{font-family:var(--f-disp);font-weight:900;font-size:22px;line-height:1;letter-spacing:.03em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.s9f-nm span{font-size:10px;letter-spacing:.12em;color:var(--f-acc);white-space:nowrap}
.s9f-do{font-size:11.5px;line-height:1.4;color:#b9b4a8;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.s9f-do .tag{display:inline-block;font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;padding:1px 5px;margin-right:6px;border:1px solid currentColor;vertical-align:1px}
.s9f-acts{display:flex;gap:6px;align-items:center;justify-content:flex-end;flex-wrap:wrap}
.s9f-row .s9f-acts{grid-column:2 / -1;justify-content:flex-start}
.s9f-row .s9f-more{grid-column:3;grid-row:1;align-self:start}
.s9f-more{width:36px;padding:0;font-size:16px;letter-spacing:0}
.s9f-menu{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding-top:6px;border-top:1px dashed var(--f-line);font-size:12px;color:var(--f-dim)}
.s9f-here{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--f-cy);border:1px solid rgba(127,231,255,.4);padding:6px 8px}
.s9f-empty{padding:18px 16px;border:1px dashed var(--f-line);color:var(--f-dim);font-size:12.5px;line-height:1.6;text-align:center}
.s9f-empty b{display:block;font-family:var(--f-disp);font-size:24px;color:var(--f-ink);letter-spacing:.04em;margin-bottom:4px}
.s9f-card{display:grid;grid-template-columns:minmax(0,1fr);gap:10px;padding:14px;border:1px solid rgba(127,231,255,.3);background:linear-gradient(135deg,rgba(127,231,255,.08),rgba(127,231,255,.02) 60%);clip-path:polygon(0 0,100% 0,100% calc(100% - 12px),calc(100% - 12px) 100%,0 100%)}
.s9f-card .t{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
.s9f-card .t b{font-family:var(--f-disp);font-weight:900;font-size:22px;letter-spacing:.03em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.s9f-card .t span{font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--f-cy);white-space:nowrap}
.s9f-card .s{font-size:12px;color:#b9b4a8;line-height:1.5}
.s9f-seg{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--f-line)}
.s9f-seg button{font:600 11px var(--f-mono);letter-spacing:.12em;text-transform:uppercase;padding:9px 4px;background:transparent;color:var(--f-dim);border:0;border-right:1px solid var(--f-line);cursor:pointer;min-height:36px}
.s9f-seg button:last-child{border-right:0}
.s9f-seg button[aria-pressed=true]{background:var(--f-ink);color:#0b0d10}
.s9f-seg button:not([aria-pressed=true]):hover{color:var(--f-ink);background:rgba(236,230,216,.06)}
.s9f-seg button[disabled]{cursor:default}
.s9f-inv{position:relative;display:grid;gap:8px;padding:12px;border:1px solid rgba(255,154,60,.5);background:rgba(255,154,60,.08);overflow:hidden}
.s9f-inv .t{font-size:13px;line-height:1.45}.s9f-inv .t b{font-family:var(--f-disp);font-size:20px;letter-spacing:.03em}
.s9f-inv .bar,.s9f-toast .bar{position:absolute;left:0;bottom:0;height:3px;background:var(--f-acc);transform-origin:left;transition:transform .25s linear}
.s9f-rq > div:first-child{min-width:0}
.s9f-rq{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;padding:9px 10px;border-left:2px solid var(--f-acc);background:rgba(236,230,216,.04)}
.s9f-rq.out{border-left-color:var(--f-line)}
.s9f-rq b{font-family:var(--f-disp);font-weight:900;font-size:20px;letter-spacing:.03em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}
.s9f-rq span{font-size:11px;color:var(--f-dim)}
.s9f-set{display:grid;gap:10px;padding-top:4px}
.s9f-tg > div:first-child{min-width:0}
.s9f-tg{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12.5px;color:#cfc9bc;cursor:pointer}
.s9f-tg small{display:block;color:var(--f-dim);font-size:11px;margin-top:2px}
.s9f-sw{position:relative;flex:none;width:46px;height:24px;border:1px solid var(--f-line);background:rgba(5,6,8,.6);cursor:pointer;padding:0}
.s9f-sw::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;background:var(--f-dim);transition:transform .18s,background .18s}
.s9f-sw[aria-checked=true]{border-color:var(--f-acc)}
.s9f-sw[aria-checked=true]::after{transform:translateX(22px);background:var(--f-acc)}
.s9f-body.guest{align-content:center;min-height:min(560px,70vh)}
.s9f-guest{display:grid;gap:14px;padding:26px 20px;text-align:center;border:1px dashed rgba(255,154,60,.4);background:radial-gradient(100% 100% at 50% 0,rgba(255,154,60,.08),transparent 70%)}
.s9f-guest b{font-family:var(--f-disp);font-weight:900;font-size:34px;line-height:.9;text-transform:uppercase}
.s9f-guest p{margin:0;font-size:13px;line-height:1.6;color:#c9c3b6}
.s9f-guest .s9f-btn{justify-self:center;font-size:13px;padding:12px 24px}
.s9f-art{height:70px;display:flex;justify-content:center;gap:10px;align-items:flex-end}
.s9f-art i{width:26px;clip-path:polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%);opacity:.85}
#s9f-toasts{position:fixed;z-index:85;top:calc(70px + env(safe-area-inset-top,0px));right:calc(14px + env(safe-area-inset-right,0px));width:min(360px,calc(100vw - 28px));display:grid;gap:10px;pointer-events:none;font-family:var(--f-mono);color:var(--f-ink)}
.s9f-toast{position:relative;pointer-events:auto;display:grid;grid-template-columns:auto 1fr;gap:4px 12px;align-items:center;padding:12px 14px 14px 12px;background:linear-gradient(180deg,rgba(22,25,30,.96),rgba(12,14,17,.96));border:1px solid var(--f-line);border-left:3px solid var(--f-acc);box-shadow:0 18px 50px rgba(0,0,0,.5);overflow:hidden;animation:s9f-tin .32s cubic-bezier(.2,1.2,.3,1) both;clip-path:polygon(0 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%)}
.s9f-toast.out{animation:s9f-tout .22s ease-in forwards}
.s9f-toast .ic{grid-row:1/3;width:30px;height:30px;display:grid;place-items:center;font:900 16px/1 var(--f-disp);color:#0b0d10;clip-path:polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%)}
.s9f-toast .tt{font-family:var(--f-disp);font-weight:900;font-size:20px;line-height:1;letter-spacing:.03em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.s9f-toast .tb{font-size:12px;line-height:1.45;color:#c9c3b6}
.s9f-toast .ta{grid-column:1/-1;display:flex;gap:8px;margin-top:8px;align-items:center}
.s9f-toast .ta .cd{margin-left:auto;font:600 13px var(--f-mono);color:var(--f-acc);letter-spacing:.06em}
.s9f-toast .hint{grid-column:1/-1;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--f-dim);margin-top:4px}
.s9f-toast.k-online{border-left-color:#5cff9d}.s9f-toast.k-online .ic{background:#5cff9d}
.s9f-toast.k-ok{border-left-color:var(--f-cy)}.s9f-toast.k-ok .ic{background:var(--f-cy)}
.s9f-toast.k-req .ic,.s9f-toast.k-inv .ic{background:var(--f-acc)}
.s9f-toast.k-inv{border-left-color:var(--f-acc);background:linear-gradient(135deg,rgba(255,154,60,.16),rgba(12,14,17,.96) 55%)}
.s9f-toast.k-info{border-left-color:var(--f-dim)}.s9f-toast.k-info .ic{background:var(--f-dim)}
.s9f-toast.k-err{border-left-color:var(--f-bad)}.s9f-toast.k-err .ic{background:var(--f-bad)}
@keyframes s9f-in{from{opacity:0;transform:translateX(14px)}to{opacity:1;transform:none}}
@keyframes s9f-tin{from{opacity:0;transform:translateX(40px) scale(.96)}to{opacity:1;transform:none}}
@keyframes s9f-tout{to{opacity:0;transform:translateX(40px)}}
@keyframes s9f-pop{from{transform:scale(.3)}to{transform:none}}
@keyframes s9f-pulse{0%,100%{box-shadow:0 0 0 0 currentColor}50%{box-shadow:0 0 0 5px rgba(0,0,0,0)}}
#s9f-lobby{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;margin:4px 0 2px}
#s9f-lobby[hidden]{display:none}
#s9f-lobby .l{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--dim,#8b9097)}
#s9f-lobby .s9f-seg{min-width:270px;background:rgba(5,6,8,.4)}
#s9f-lobby .s9f-seg button{font:600 11px var(--f-mono);letter-spacing:.12em;color:var(--f-dim)}
#s9f-lobby .s9f-seg button[aria-pressed=true]{color:#0b0d10;background:var(--f-ink)}
html.s9f-popen #s9f-toasts{right:calc(min(430px,100vw) + 14px)}
@media (max-width:700px){html.s9f-popen #s9f-toasts{right:calc(14px + env(safe-area-inset-right,0px))}html.s9f-popen #s9f-toasts .s9f-toast:not(.k-err){display:none}}
@media (max-width:480px){.s9f-head{padding:18px 16px 12px;padding-top:calc(18px + env(safe-area-inset-top,0px))}.s9f-body{padding:14px 16px 24px}.s9f-h{font-size:40px}.s9f-row .s9f-acts .s9f-btn{flex:1}.s9f-do{-webkit-line-clamp:3}.s9f-code .v{font-size:24px}#s9f-toasts{top:auto;bottom:calc(14px + env(safe-area-inset-bottom,0px))}}
@media (prefers-reduced-motion:reduce){#s9f-panel,.s9f-row,.s9f-toast{transition:none;animation:none}}
`;
  const st = document.createElement('style'); st.id = 's9f-css'; st.textContent = css; document.head.appendChild(st);

  // ---------------------------------------------------------------- DOM helper (text only, never HTML strings)
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k]; if (v == null || v === false) continue;
      if (k === 'text') e.textContent = v; else if (k === 'class') e.className = v; else if (k === 'style') e.style.cssText = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return e;
  }
  const btn = (text, cls, fn, extra) => el('button', Object.assign({ type: 'button', class: 's9f-btn ' + (cls || ''), text, onclick: e => { e.stopPropagation(); fn(e); } }, extra || {}));
  function avatar(nick, stKey) {
    const h = hue(nick);
    return [el('div', { class: 's9f-av', style: `background:linear-gradient(140deg,hsl(${h} 85% 66%),hsl(${(h + 40) % 360} 80% 48%))`, text: String(nick || '?').slice(0, 1).toUpperCase(), 'aria-hidden': 'true' }),
      el('i', { class: 's9f-dotw' + (stKey === 'online' || stKey === 'match' ? ' pulse' : ''), style: `background:${STATUS[stKey].c};color:${STATUS[stKey].c}88`, 'aria-hidden': 'true' })];
  }

  // ---------------------------------------------------------------- panel
  const scrim = el('div', { id: 's9f-scrim', onmousedown: () => close() });
  const panel = el('aside', { id: 's9f-panel', role: 'dialog', 'aria-modal': 'false', 'aria-label': 'Friends', 'aria-hidden': 'true' });
  for (const ev of ['mousedown', 'mouseup', 'click', 'wheel', 'contextmenu', 'pointerdown', 'touchstart']) { panel.addEventListener(ev, e => e.stopPropagation()); }
  for (const ev of ['keydown', 'keyup', 'keypress']) addEventListener(ev, e => {
    if (!isOpen()) return;
    if (ev === 'keydown' && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (panel.contains(e.target) || panel.contains(document.activeElement)) {
      e.stopPropagation();   // stopped here (window, capture) so the game never sees it, so Enter in the add box is handled here too
      if (ev === 'keydown' && e.key === 'Enter' && e.target && e.target.matches && e.target.matches('.s9f-add input')) { e.preventDefault(); addFriend(e.target.value); }
    }
  }, true);
  let lastMsg = { t: '', err: false };
  function say(t, isErr) { lastMsg = { t: t || '', err: !!isErr }; const m = panel.querySelector('.s9f-msg'); if (m) { m.textContent = lastMsg.t; m.className = 's9f-msg' + (lastMsg.err ? ' err' : ''); } }
  function isOpen() { return panel.classList.contains('on'); }
  let prevFocus = null;
  function open(o) {
    inviteMode = o && o.invite ? o.invite : null;
    if (!isOpen()) prevFocus = document.activeElement;
    panel.classList.add('on'); document.documentElement.classList.add('s9f-popen'); panel.setAttribute('aria-hidden', 'false'); scrim.classList.add('on');
    for (const r of ST.incoming) seenReq.add(r.id);
    render(); if (token()) { load(); if (!ST.linked) connect(); }
    setTimeout(() => { const x = panel.querySelector('.s9f-add input') || panel.querySelector('.s9f-x'); if (x && innerWidth > 700) try { x.focus({ preventScroll: true }); } catch (e) {} }, 60);
  }
  function close() {
    if (!isOpen()) return; panel.classList.remove('on'); document.documentElement.classList.remove('s9f-popen'); panel.setAttribute('aria-hidden', 'true'); scrim.classList.remove('on'); inviteMode = null; menuFor = confirmFor = null;
    if (prevFocus && prevFocus.focus && document.contains(prevFocus)) try { prevFocus.focus({ preventScroll: true }); } catch (e) {}
    updateBadge();
  }

  function render() {
    updateBadge(); syncLobby();
    if (!isOpen()) return;
    const scroll = panel.querySelector('.s9f-body') ? panel.querySelector('.s9f-body').scrollTop : 0;
    // keep what the user is typing (and the caret) across the rebuild
    const oldInp = panel.querySelector('.s9f-add input'), typed = oldInp ? oldInp.value : '', hadFocus = !!oldInp && document.activeElement === oldInp;
    const selA = hadFocus ? oldInp.selectionStart : 0, selB = hadFocus ? oldInp.selectionEnd : 0;
    panel.textContent = '';
    const nOn = ST.friends.filter(f => stOf(f) !== 'offline').length;
    const head = el('div', { class: 's9f-head' },
      el('div', { class: 's9f-k' }, el('i'), 'Squad link'),
      el('h2', { class: 's9f-h', id: 's9f-title' }, 'Friends', token() && ST.loaded ? el('small', { class: nOn ? '' : 'none', text: nOn + ' online' }) : null),
      el('button', { class: 's9f-x', type: 'button', 'aria-label': 'Close friends', text: '×', onclick: e => { e.stopPropagation(); close(); } }));
    const body = el('div', { class: 's9f-body' });
    panel.append(head, body);
    if (!token()) { body.classList.add('guest'); body.appendChild(guestCard()); return; }
    if (!ST.loaded) { body.appendChild(el('div', { class: 's9f-empty', text: ST.err || 'Loading your friends...' })); return; }
    // friend code + add
    const code = ST.me.code || '', hash = code.lastIndexOf('#');
    body.appendChild(el('div', { class: 's9f-code' },
      el('div', null, el('span', { class: 'l', text: 'Your friend code' }), el('span', { class: 'v' }, code.slice(0, hash), el('em', { text: code.slice(hash) }))),
      btn('Copy', '', () => copy(code), { 'aria-label': 'Copy your friend code' })));
    const inp = el('input', { type: 'text', maxlength: '24', placeholder: 'Nickname or NICK#1234', 'aria-label': 'Add a friend by nickname or friend code', autocomplete: 'off', spellcheck: 'false' });
    body.appendChild(el('div', { class: 's9f-add' }, inp, btn('Add friend', 's9f-pri', () => addFriend(inp.value))));
    body.appendChild(el('div', { class: 's9f-msg' + (lastMsg.err ? ' err' : ''), role: 'status', text: lastMsg.t }));
    if (!ST.linked && hasNet()) body.appendChild(el('div', { class: 's9f-msg err', text: 'Connecting to the game server for live status...' }));
    // room card
    const rc = roomCard(); if (rc) body.appendChild(rc);
    if (ST.following) body.appendChild(el('div', { class: 's9f-rq out' }, el('div', null, el('b', { text: 'Following ' + ST.following.nick }), el('span', { text: 'You go wherever they go, if their room lets you in.' })), btn('Stop', '', () => { send({ k: 'frUnfollow' }); ST.following = null; render(); })));
    // invites to me
    if (ST.invites.length) {
      const s = sec('Invites', ST.invites.length);
      for (const i of ST.invites) s.appendChild(inviteRow(i));
      body.appendChild(s);
    }
    // requests
    if (ST.incoming.length || ST.outgoing.length) {
      const s = sec('Requests', ST.incoming.length);
      for (const r of ST.incoming) s.appendChild(el('div', { class: 's9f-rq' }, el('div', null, el('b', { text: r.nick }), el('span', { text: 'Lv ' + (r.level | 0) + ' · wants to be your friend' })),
        el('div', { class: 's9f-acts' }, btn('Accept', 's9f-pri', () => answerReq(r.id, true)), btn('Decline', '', () => answerReq(r.id, false)))));
      for (const r of ST.outgoing) s.appendChild(el('div', { class: 's9f-rq out' }, el('div', null, el('b', { text: r.nick }), el('span', { text: 'Request sent · waiting' })), btn('Cancel', 's9f-gh', () => simple('cancel', r.id))));
      body.appendChild(s);
    }
    // friends by status
    if (!ST.friends.length) body.appendChild(el('div', { class: 's9f-empty' }, el('b', { text: 'No friends yet' }), 'Share your code ', el('span', { style: 'color:var(--f-acc)', text: code }), ' or add a friend by their nickname. You will see when they are online and can jump into their room.'));
    const groups = {}; for (const f of ST.friends) (groups[stOf(f)] = groups[stOf(f)] || []).push(f);
    for (const k of Object.keys(STATUS).sort((a, b) => STATUS[a].o - STATUS[b].o)) {
      const list = groups[k]; if (!list) continue;
      list.sort((a, b) => k === 'offline' ? ((b.p && b.p.seen) || 0) - ((a.p && a.p.seen) || 0) : a.nick.localeCompare(b.nick));
      const s = sec(STATUS[k].group, list.length, STATUS[k].c);
      for (const f of list) s.appendChild(friendRow(f));
      body.appendChild(s);
    }
    body.appendChild(settings());
    body.scrollTop = scroll;
    if (typed) inp.value = typed;
    if (hadFocus) try { inp.focus({ preventScroll: true }); inp.setSelectionRange(selA, selB); } catch (e) {}
  }
  function sec(title, n, dot) { return el('div', { class: 's9f-sec' }, el('div', { class: 's9f-st' }, dot ? el('i', { class: 'dot', style: `background:${dot};box-shadow:0 0 8px ${dot}` }) : null, el('b', { text: title }), n != null ? String(n) : null)); }
  function guestCard() {
    return el('div', { class: 's9f-guest' },
      el('div', { class: 's9f-art', 'aria-hidden': 'true' }, el('i', { style: 'height:44px;background:#7fe7ff' }), el('i', { style: 'height:62px;background:#ff9a3c' }), el('i', { style: 'height:50px;background:#5cff9d' })),
      el('b', { text: 'Sign in to add friends' }),
      el('p', { text: 'With an account you get your own friend code, see who is online and what they are playing, and invite friends straight into your room.' }),
      btn('Sign in', 's9f-pri', () => { close(); const a = ACC(); if (a && a.open) a.open('signin'); }));
  }
  function roomCard() {
    const r = room(); if (!r) return null;
    const m = r.meta || {}, host = !!r.isHost, vis = (ST.vis && ST.vis.code === r.code && ST.vis.vis) || 'public';
    const label = { public: 'Anyone can join · listed in Open rooms', friends: 'Only your friends can join or follow · not listed', private: 'Invite only · not listed' }[vis];
    const seg = el('div', { class: 's9f-seg', role: 'group', 'aria-label': 'Who can join your room' },
      ...['public', 'friends', 'private'].map(v => el('button', { type: 'button', text: v === 'friends' ? 'Friends' : v[0].toUpperCase() + v.slice(1), 'aria-pressed': String(vis === v), disabled: !host, title: host ? '' : 'Only the host can change this', onclick: e => { e.stopPropagation(); if (host) setVis(v); } })));
    const card = el('div', { class: 's9f-card' + (inviteMode ? ' hl' : '') },
      el('div', { class: 't' }, el('b', { text: m.name || 'Your room' }), el('span', { text: (m.count | 0) + '/' + (m.size | 0) + (m.started ? ' · in match' : ' · lobby') })),
      seg, el('div', { class: 's' }, label + (host ? '' : ' · set by the host')));
    if (ST.followers.length) card.appendChild(el('div', { class: 's' }, el('span', { style: 'color:var(--f-cy)', text: 'Following you: ' }), ST.followers.map(f => f.nick).join(', ')));
    const canInv = ST.friends.filter(f => ['online', 'lobby', 'match', 'away'].includes(stOf(f)) && !(f.p.room && f.p.room.here)).length;
    card.appendChild(el('div', { class: 's' , text: canInv ? 'Press Invite next to a friend below. They get 2 minutes to accept.' : 'No friends online to invite right now.' }));
    return card;
  }
  function inviteRow(i) {
    const left = i.until - now();
    const bar = el('i', { class: 'bar', style: `transform:scaleX(${Math.max(0, Math.min(1, left / 120000))})` });
    const row = el('div', { class: 's9f-inv', 'data-inv': i.id },
      el('div', { class: 't' }, el('b', { text: i.from.nick }), ' invited you to ', el('span', { style: 'color:var(--f-acc)', text: i.room.name }),
        el('div', { style: 'font-size:11px;color:var(--f-dim);margin-top:2px', text: [modeName(i.room.mode), mapName(i.room.map), (i.room.n | 0) + '/' + (i.room.max | 0) + ' players', i.room.started ? 'match running' : 'in lobby'].join(' · ') })),
      el('div', { class: 's9f-acts', style: 'justify-content:flex-start' }, btn('Accept', 's9f-pri', () => answerInvite(i, true)), btn('Decline', '', () => answerInvite(i, false)), el('span', { class: 'cd', style: 'margin-left:auto;color:var(--f-acc);font-weight:600', text: mmss(left) })), bar);
    return row;
  }
  function friendRow(f) {
    const k = stOf(f), p = f.p || { st: 'offline' }, r = p.room;
    const myRoom = room(), inv = invited.get(f.id), invLeft = inv ? inv - now() : 0;
    const acts = el('div', { class: 's9f-acts' });
    if (k !== 'offline') {
      if (r && r.here) acts.appendChild(el('span', { class: 's9f-here', text: 'In your room' }));
      else if (r && r.joinable && r.code) {
        acts.appendChild(btn(pendingJoin === f.id ? 'Joining...' : 'Join', 's9f-pri', () => joinFriend(f.id, false), { disabled: pendingJoin === f.id, 'aria-label': 'Join ' + f.nick }));
        acts.appendChild(btn('Follow', 's9f-cyb', () => joinFriend(f.id, true), { 'aria-label': 'Follow ' + f.nick, title: 'Join now and keep following them to every room' }));
      }
      if (myRoom && !(r && r.here)) acts.appendChild(btn(invLeft > 0 ? 'Invited ' + mmss(invLeft) : 'Invite', invLeft > 0 ? '' : 's9f-cyb', () => invite(f.id), { disabled: invLeft > 0, 'aria-label': 'Invite ' + f.nick, 'data-inv-btn': f.id }));
    }
    const more = btn('⋯', 's9f-gh s9f-more', () => { menuFor = menuFor === f.id ? null : f.id; confirmFor = null; render(); }, { 'aria-label': 'More for ' + f.nick, 'aria-expanded': String(menuFor === f.id) });
    const line = el('div', { class: 's9f-do' });
    line.appendChild(document.createTextNode(doing(p)));
    const row = el('div', { class: 's9f-row' + (k === 'offline' ? ' off' : '') + (inviteMode && k !== 'offline' && !(r && r.here) ? ' hl' : ''), 'data-friend': f.id, 'data-st': k },
      el('div', { class: 's9f-avw' }, ...avatar(f.nick, k)),
      el('div', { class: 's9f-who' }, el('div', { class: 's9f-nm' }, el('b', { text: f.nick }), el('span', { text: 'LV ' + (f.level | 0) + (f.prestige ? ' · P' + (f.prestige | 0) : '') })), line),
      more, acts.childNodes.length ? acts : null);
    if (menuFor === f.id) {
      const m = el('div', { class: 's9f-menu' });
      if (confirmFor === 'remove') m.append('Remove ' + f.nick + '?', btn('Yes, remove', 's9f-bad', () => simple('remove', f.id, 'Removed ' + f.nick)), btn('No', 's9f-gh', () => { confirmFor = null; render(); }));
      else if (confirmFor === 'block') m.append('Block ' + f.nick + '? They can’t find, add, invite or see you.', btn('Yes, block', 's9f-bad', () => simple('block', f.id, 'Blocked ' + f.nick)), btn('No', 's9f-gh', () => { confirmFor = null; render(); }));
      else m.append(btn('Remove friend', '', () => { confirmFor = 'remove'; render(); }), btn('Block', 's9f-bad', () => { confirmFor = 'block'; render(); }), el('span', { text: 'Friends since ' + (f.since ? new Date(f.since).toLocaleDateString() : '') }));
      row.appendChild(m);
    }
    return row;
  }
  function settings() {
    const pv = (ST.me && ST.me.privacy) || { appearOffline: false, invites: 'friends' };
    const sw = el('button', { type: 'button', class: 's9f-sw', role: 'switch', 'aria-checked': String(!!pv.appearOffline), 'aria-label': 'Appear offline', onclick: e => { e.stopPropagation(); setPrivacy({ appearOffline: !pv.appearOffline }); } });
    const invSeg = el('div', { class: 's9f-seg', style: 'grid-template-columns:repeat(2,1fr);min-width:170px', role: 'group', 'aria-label': 'Allow invites from' },
      ...['friends', 'nobody'].map(v => el('button', { type: 'button', text: v === 'friends' ? 'Friends' : 'Nobody', 'aria-pressed': String(pv.invites === v), onclick: e => { e.stopPropagation(); setPrivacy({ invites: v }); } })));
    const s = el('div', { class: 's9f-sec' }, el('div', { class: 's9f-st' }, el('b', { text: 'Privacy' })),
      el('div', { class: 's9f-set' },
        el('div', { class: 's9f-tg' }, el('div', null, 'Appear offline', el('small', { text: 'Friends see you as offline. You can still play and invite.' })), sw),
        el('div', { class: 's9f-tg' }, el('div', null, 'Allow invites from', el('small', { text: pv.invites === 'nobody' ? 'Nobody can invite you right now.' : 'Only friends can ever invite you.' })), invSeg)));
    if (ST.blocked.length) {
      const b = btn((blockedOpen ? 'Hide' : 'Show') + ' blocked players (' + ST.blocked.length + ')', 's9f-gh', () => { blockedOpen = !blockedOpen; render(); }, { style: 'justify-self:start;padding-left:0' });
      s.appendChild(b);
      if (blockedOpen) for (const x of ST.blocked) s.appendChild(el('div', { class: 's9f-rq out' }, el('div', null, el('b', { text: x.nick }), el('span', { text: 'Blocked' })), btn('Unblock', '', () => simple('unblock', x.id, 'Unblocked ' + x.nick))));
    }
    return s;
  }
  function copy(code) {
    const done = () => toast({ kind: 'ok', title: 'Copied', body: code + ' · send it to a friend', ttl: 2500 });
    try { navigator.clipboard.writeText(code).then(done, () => { prompt('Your friend code', code); }); } catch (e) { try { prompt('Your friend code', code); } catch (x) {} }
  }

  // ---------------------------------------------------------------- toasts
  const toastBox = el('div', { id: 's9f-toasts', 'aria-live': 'polite' });
  for (const ev of ['mousedown', 'mouseup', 'click', 'wheel', 'contextmenu', 'pointerdown']) toastBox.addEventListener(ev, e => e.stopPropagation());
  const toasts = new Map(); let tn = 0;
  const ICON = { online: '+', ok: '✓', req: '+', inv: '»', info: 'i', err: '!' };
  function toast(o) {
    const key = o.key || 't' + (++tn);
    if (toasts.has(key)) dropToast(key, true);
    const t = el('div', { class: 's9f-toast k-' + (o.kind || 'info'), role: o.kind === 'inv' || o.kind === 'req' ? 'alertdialog' : 'status', 'data-toast': key },
      el('i', { class: 'ic', text: ICON[o.kind] || 'i', 'aria-hidden': 'true' }), el('div', { class: 'tt', text: o.title || '' }), el('div', { class: 'tb', text: o.body || '' }));
    if (o.actions) t.appendChild(el('div', { class: 'ta' }, ...o.actions.map(a => btn(a[0], a[2] || '', () => { a[1](); dropToast(key); })), o.countdown ? el('span', { class: 'cd' }) : null));
    if (o.countdown) { t.appendChild(el('i', { class: 'bar' })); if (G().state === 'play') t.appendChild(el('div', { class: 'hint', text: 'Press Esc to answer' })); }
    toastBox.appendChild(t);
    const rec = { el: t, until: o.ttl ? now() + o.ttl : 0, total: o.ttl || 0, countdown: !!o.countdown };
    toasts.set(key, rec);
    while (toasts.size > 4) { const first = [...toasts.keys()].find(k => !toasts.get(k).countdown) || toasts.keys().next().value; dropToast(first, true); }
    tickToasts(); return key;
  }
  function inviteToast(i) {
    toast({ key: 'inv:' + i.id, kind: 'inv', title: i.from.nick + ' invited you', body: i.room.name + ' · ' + modeName(i.room.mode) + ' · ' + mapName(i.room.map) + ' · ' + (i.room.n | 0) + '/' + (i.room.max | 0), ttl: Math.max(1000, i.until - now()), countdown: true,
      actions: [['Accept', () => answerInvite(i, true), 's9f-pri'], ['Decline', () => answerInvite(i, false)]] });
  }
  function dropToast(key, fast) {
    const r = toasts.get(key); if (!r) return; toasts.delete(key);
    if (fast) { r.el.remove(); return; }
    r.el.classList.add('out'); setTimeout(() => r.el.remove(), 230);
  }
  let toastT = null;
  function tickToasts() {
    clearTimeout(toastT);
    const t = now();
    for (const [k, r] of [...toasts]) {
      if (r.until && t >= r.until) { dropToast(k); continue; }
      if (r.countdown) { const cd = r.el.querySelector('.cd'), bar = r.el.querySelector('.bar'); if (cd) cd.textContent = mmss(r.until - t); if (bar) bar.style.transform = `scaleX(${Math.max(0, (r.until - t) / 120000)})`; }
    }
    // live countdowns inside the panel
    if (isOpen()) {
      for (const row of panel.querySelectorAll('[data-inv]')) { const i = ST.invites.find(x => x.id === row.dataset.inv); if (!i) continue; const left = i.until - t; const cd = row.querySelector('.cd'), bar = row.querySelector('.bar'); if (cd) cd.textContent = mmss(left); if (bar) bar.style.transform = `scaleX(${Math.max(0, left / 120000)})`; }
      for (const b of panel.querySelectorAll('[data-inv-btn]')) { const u = invited.get(b.dataset.invBtn); if (u && u > t) b.textContent = 'Invited ' + mmss(u - t); else if (u) { invited.delete(b.dataset.invBtn); render(); break; } }
    }
    const before = ST.invites.length; ST.invites = ST.invites.filter(i => i.until > t); if (ST.invites.length !== before) { render(); emit(); }
    if (toasts.size || ST.invites.length || invited.size) toastT = setTimeout(tickToasts, 250);
  }

  // ---------------------------------------------------------------- nav buttons + badge
  const navs = [];
  function makeNav(id) {
    const b = el('button', { class: 'ghost s9f-nav', id, type: 'button', 'aria-label': 'Friends', onclick: e => { e.stopPropagation(); isOpen() ? close() : open(); } }, 'Friends', el('i', { class: 's9f-on', hidden: true, 'aria-hidden': 'true' }), el('span', { class: 's9f-badge', hidden: true }));
    navs.push(b); return b;
  }
  function mountNav() {
    if (document.getElementById('btnFriends')) return;
    let placed = false;
    if (window.S9Menu && typeof window.S9Menu.addNavButton === 'function') {
      try { const r = window.S9Menu.addNavButton({ id: 'btnFriends', label: 'Friends', onClick: () => (isOpen() ? close() : open()) }); if (r && r.nodeType === 1) { r.classList.add('s9f-nav'); r.appendChild(el('i', { class: 's9f-on', hidden: true })); r.appendChild(el('span', { class: 's9f-badge', hidden: true })); navs.push(r); placed = true; } } catch (e) {}
    }
    if (!placed) {
      const after = document.getElementById('btnOnline'), row = after ? after.parentNode : document.querySelector('#menu .row');
      if (row) { const b = makeNav('btnFriends'); after && after.nextSibling ? row.insertBefore(b, after.nextSibling) : row.appendChild(b); }
    }
    const pr = document.querySelector('#pause .row'); if (pr && !document.getElementById('btnFriends2')) { const b2 = makeNav('btnFriends2'); const q = document.getElementById('btnQuit'); q ? pr.insertBefore(b2, q) : pr.appendChild(b2); }
  }
  function unread() { return ST.incoming.filter(r => !seenReq.has(r.id)).length + ST.invites.length; }
  function updateBadge() {
    const n = token() ? unread() : 0, on = token() ? ST.friends.filter(f => stOf(f) !== 'offline').length : 0;
    for (const b of navs) {
      const bd = b.querySelector('.s9f-badge'), dot = b.querySelector('.s9f-on');
      if (bd) { bd.hidden = !n; bd.textContent = n > 9 ? '9+' : String(n); }
      if (dot) dot.hidden = !on || !!n;
      b.setAttribute('aria-label', 'Friends' + (on ? ', ' + on + ' online' : '') + (n ? ', ' + n + ' new' : ''));
    }
  }

  // the online room lobby gets "who can join" + "Invite friends"
  let lobbyBox = null;
  function syncLobby() {
    const oRoom = document.getElementById('oRoom'); if (!oRoom) return;
    if (!lobbyBox) {
      lobbyBox = el('div', { id: 's9f-lobby', hidden: true });
      const row = oRoom.querySelector('.row'); row ? row.parentNode.insertBefore(lobbyBox, row) : oRoom.appendChild(lobbyBox);
    }
    const r = room();
    if (!r || !token() || !hasNet()) { lobbyBox.hidden = true; return; }
    lobbyBox.hidden = false; lobbyBox.textContent = '';
    const vis = (ST.vis && ST.vis.code === r.code && ST.vis.vis) || 'public', host = !!r.isHost;
    lobbyBox.append(el('span', { class: 'l', text: 'Who can join' }),
      el('div', { class: 's9f-seg', role: 'group', 'aria-label': 'Who can join this room' }, ...['public', 'friends', 'private'].map(v => el('button', { type: 'button', text: v === 'friends' ? 'Friends' : v[0].toUpperCase() + v.slice(1), 'aria-pressed': String(vis === v), disabled: !host, onclick: e => { e.stopPropagation(); if (host) setVis(v); } }))),
      el('button', { type: 'button', class: 'ghost', id: 's9f-invbtn', text: 'Invite friends', onclick: e => { e.stopPropagation(); api.inviteToRoom(); } }));
  }

  // keep the panel out of the way of gameplay
  try {
    if (typeof window.setState === 'function') {
      const _ss = window.setState;
      window.setState = function (s) { const out = _ss.apply(this, arguments); if (s === 'play' || s === 'dead') { close(); } return out; };
    }
  } catch (e) {}
  document.addEventListener('visibilitychange', () => { if (ST.linked) send({ k: 'frVis', hidden: !!document.hidden }); });
  // sign in / out
  let lastTok = token();
  function onAccount() {
    const t = token(); if (t === lastTok) return; lastTok = t;
    reset(); if (t) { connect(); load(); } else { send({ k: 'frAuth', token: null }); render(); }
  }

  function mount() {
    if (!document.body) return setTimeout(mount, 50);
    document.body.append(scrim, panel, toastBox);
    mountNav(); updateBadge();
    const a = ACC(); if (a && a.onChange) a.onChange(onAccount);
    if (token()) { connect(); load(); }
    // late account module: hook it when it shows up
    if (!a) { let n = 0; const iv = setInterval(() => { const b = ACC(); if (b && b.onChange) { clearInterval(iv); b.onChange(onAccount); onAccount(); } else if (++n > 40) clearInterval(iv); }, 250); }
    // the main menu can be rebuilt by other modules: re-add the nav button if it disappears
    const menu = document.getElementById('menu'); if (menu) new MutationObserver(() => { if (!document.getElementById('btnFriends')) { navs.length = 0; mountNav(); updateBadge(); } }).observe(menu, { childList: true, subtree: true });
  }
  mount();

  const api = window.S9Friends = {
    open: () => open(),
    close,
    isOpen,
    refresh: () => load().then(() => api.list()),
    // open the panel ready to invite friends into a room (default: the room you're in)
    inviteToRoom(code) {
      const r = room();
      if (!token()) return open();
      if (!r || (code && String(code).toUpperCase() !== r.code)) { open(); toast({ kind: 'info', title: 'Join the room first', body: 'You can invite friends to the room you are in.', ttl: 4000 }); return; }
      open({ invite: r.code });
    },
    // the friends list as plain data: [{id, nick, level, status, doing, room:{name,mode,map,n,max,vis,joinable,code?}|null, seen}]
    list() { return ST.friends.map(f => ({ id: f.id, nick: f.nick, level: f.level, status: stOf(f), doing: doing(f.p), room: f.p && f.p.room ? Object.assign({}, f.p.room) : null, score: f.p && f.p.score || null, seen: f.p && f.p.seen || null })); },
    onChange(fn) { if (typeof fn === 'function') subs.add(fn); return () => subs.delete(fn); },
    state: () => JSON.parse(JSON.stringify({ me: ST.me, incoming: ST.incoming, outgoing: ST.outgoing, blocked: ST.blocked, invites: ST.invites, followers: ST.followers, following: ST.following, linked: ST.linked, vis: ST.vis })),
    invite, join: id => joinFriend(id, false), follow: id => joinFriend(id, true), setVisibility: setVis, toast,
  };
})();
