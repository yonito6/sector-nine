/* Sector Nine SPECTATE (modules/spectate.js): watch a room without taking a player slot.
   - Room list: a Watch button per room ("Watch instead" when the room is full or the match is running).
   - Spectator view: follows a player's eyes (synced position + look). Click / Left / Right = next / previous, 1-9 = player N,
     Space = free-fly camera (WASD + mouse, Shift fast, Q/E down/up), V = chase camera, Tab = scoreboard (click a row to jump).
     On-screen buttons for phones. Watched player dies -> after 1.5 s the view moves to their killer.
   - Server (sector-nine-server): the spectator joins with {k:'join', spec:1}; no slot, not in scores/teams, never hit, does not spawn.
     Team modes: the server delays the stream by 3 s (no ghosting). Room options: meta.spec (on by default), meta.specMax (4, up to 8).
   - Players see "N watching" in the match and in the scoreboard / lobby.
   Hooks only (no index.html edits): wraps srvSend, setState, startOnlineMatch, beginRoomMatch, leaveOnline, boardHTML,
   MODE_preRender / MODE_postRender. Load AFTER modes, session and menu. See spectate.INTEGRATE.md. */
(function () {
  'use strict';
  if (window.SPECTATE) return;
  const $ = id => document.getElementById(id);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const S = window.SPECTATE = {
    ver: 1, on: false, pending: false, target: null, free: false, chase: false, opt: { on: true, max: 4 },
    watch: code => watch(code), join: () => sit(), next: () => cycle(1), prev: () => cycle(-1), jump: n => jumpTo(n), toggleFree: () => setFree(!S.free),
    info: () => ({ on: S.on, target: S.target, name: nameOf(S.target), free: S.free, chase: S.chase, alive: aliveCount(), players: plist().length, watching: meta() ? meta().watching | 0 : 0, state: typeof state === 'string' ? state : '' }),
  };
  const room = () => (typeof NET !== 'undefined' && NET.room) || null;
  const meta = () => { const r = room(); return r && r.meta || null; };
  const TEAM = { atk: '#ff8a3d', def: '#3dc8ff' };
  const svg = {
    eye: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3.2"/></svg>',
    left: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
    right: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>',
  };

  /* ================= styles ================= */
  const css = document.createElement('style');
  css.textContent = `
body.s9spec .corner.bl,body.s9spec .corner.br,body.s9spec #xh,body.s9spec #s9xh,body.s9spec #abil,body.s9spec #reloadbar,body.s9spec #shieldNote,body.s9spec #dropHint,body.s9spec #combo,body.s9spec #combobar,
body.s9spec #hm,body.s9spec #vig,body.s9spec #dmgdir,body.s9spec #scope,body.s9spec #killbadge,body.s9spec #medals,body.s9spec #hPlace,body.s9spec #hKD,body.s9spec .corner.tr>.label,body.s9spec #hScore,body.s9spec #compass,body.s9spec #mLead,body.s9spec #death{display:none!important}
body.s9spec #board{pointer-events:auto}body.s9spec #board tr[data-spec]{cursor:pointer}body.s9spec #board tr[data-spec]:hover td{background:rgba(127,231,255,.12)}body.s9spec #board tr.me td{color:var(--cyan)}
#s9sTop{position:fixed;left:50%;top:max(66px,calc(env(safe-area-inset-top,0px) + 58px));transform:translateX(-50%);z-index:35;display:flex;flex-direction:column;align-items:center;gap:7px;pointer-events:none;width:min(94vw,640px)}
#s9sTop[hidden],#s9sBot[hidden],#s9eye[hidden],#s9sLobby[hidden]{display:none!important}
.s9sBar{position:relative;display:flex;align-items:center;gap:14px;padding:9px 34px;background:linear-gradient(90deg,rgba(127,231,255,.16),rgba(11,13,16,.86) 26%,rgba(11,13,16,.86) 74%,rgba(127,231,255,.16));
  border:1px solid rgba(127,231,255,.4);clip-path:polygon(16px 0,calc(100% - 16px) 0,100% 50%,calc(100% - 16px) 100%,16px 100%,0 50%);box-shadow:0 0 24px rgba(127,231,255,.18);max-width:100%}
.s9sBar .tag{font:700 10px var(--mono);letter-spacing:.28em;color:var(--cyan);display:flex;align-items:center;gap:7px;white-space:nowrap}
.s9sBar .tag i{width:7px;height:7px;border-radius:50%;background:var(--alert);box-shadow:0 0 8px var(--alert);animation:s9sblink 1.2s infinite}
.s9sBar .nm{font:800 clamp(20px,3.4vw,28px)/1 var(--display);letter-spacing:.07em;text-transform:uppercase;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:48vw;text-shadow:0 0 14px var(--tc,transparent)}
.s9sBar .nm.dead{color:var(--alert);text-decoration:line-through}
@keyframes s9sblink{50%{opacity:.25}}
.s9sInfo{display:flex;gap:14px;align-items:center;font:600 11px var(--mono);letter-spacing:.1em;color:var(--dim);text-transform:uppercase;flex-wrap:wrap;justify-content:center;text-shadow:0 1px 3px #000}
.s9sInfo b{color:var(--ink);font-weight:600}.s9sInfo .hp{width:84px;height:6px;background:rgba(255,255,255,.14);display:inline-block;vertical-align:middle;margin-left:6px;clip-path:polygon(0 0,100% 0,calc(100% - 4px) 100%,0 100%)}.s9sInfo .hp s{display:block;height:100%;background:linear-gradient(90deg,#33e0a1,#7fe7ff);transform-origin:0 50%}
.s9sKeys{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;font:500 10px var(--mono);letter-spacing:.08em;color:var(--dim);text-shadow:0 1px 3px #000}
.s9sKeys kbd{font:600 10px var(--mono);color:var(--cyan);border:1px solid rgba(127,231,255,.4);padding:1px 5px;margin-right:3px;background:rgba(11,13,16,.6)}
.s9sKeys span{white-space:nowrap}
#s9sBot{position:fixed;left:50%;bottom:calc(14px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:35;display:flex;align-items:stretch;gap:6px;width:min(96vw,860px);pointer-events:auto}
#s9sBot button{font:600 12px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--ink);background:rgba(11,13,16,.82);border:1px solid rgba(127,231,255,.35);padding:0 12px;min-height:44px;min-width:44px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;
  clip-path:polygon(8px 0,100% 0,calc(100% - 8px) 100%,0 100%)}
#s9sBot button:hover{background:rgba(127,231,255,.18)}#s9sBot button.on{background:rgba(127,231,255,.28);color:#fff}#s9sBot button.go{border-color:var(--sodium);color:var(--sodium)}#s9sBot button:disabled{opacity:.4;cursor:default}
#s9sBot button.lv{border-color:rgba(255,74,61,.6);color:#ff9a90}
#s9sChips{flex:1;min-width:0;display:flex;gap:5px;overflow-x:auto;scrollbar-width:none;align-items:stretch}#s9sChips::-webkit-scrollbar{display:none}
#s9sChips div{flex:none;display:flex;align-items:center;gap:7px;padding:0 12px;min-height:44px;background:rgba(11,13,16,.78);border:1px solid var(--line);font:600 12px var(--mono);cursor:pointer;white-space:nowrap;max-width:170px;overflow:hidden;text-overflow:ellipsis}
#s9sChips div i{width:9px;height:9px;border-radius:50%;flex:none;background:var(--c,#aaa)}#s9sChips div em{font-style:normal;color:var(--dim);font-size:10px;margin-left:2px}#s9sChips div kbd{font:600 9px var(--mono);color:var(--cyan);opacity:.8}
#s9sChips div.cur{border-color:var(--cyan);background:rgba(127,231,255,.2);box-shadow:0 0 12px rgba(127,231,255,.25)}#s9sChips div.dead{opacity:.45;text-decoration:line-through}
#s9eye{position:fixed;left:50%;bottom:calc(10px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:30;display:flex;align-items:center;gap:6px;padding:4px 12px;border:1px solid rgba(127,231,255,.3);background:rgba(11,13,16,.6);color:var(--cyan);font:600 11px var(--mono);letter-spacing:.12em;text-transform:uppercase;pointer-events:none;clip-path:polygon(8px 0,calc(100% - 8px) 0,100% 50%,calc(100% - 8px) 100%,8px 100%,0 50%)}
.s9watch{margin-top:8px;display:flex;align-items:center;gap:7px;color:var(--cyan);font:600 11px var(--mono);letter-spacing:.12em;text-transform:uppercase}
#s9sLobby{margin:10px 0;padding:10px 12px;border:1px solid rgba(127,231,255,.4);background:rgba(127,231,255,.07);display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:13px}
#s9sLobby b{color:var(--cyan);letter-spacing:.1em;text-transform:uppercase;font-size:12px;display:flex;align-items:center;gap:6px}#s9sLobby span{flex:1 1 180px;color:var(--dim)}
.s9wb{margin-left:6px;background:transparent;border:1px solid rgba(127,231,255,.5);color:var(--cyan);font:600 11px var(--mono);letter-spacing:.08em;text-transform:uppercase;padding:6px 10px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;min-height:32px}
.s9wb:hover{background:rgba(127,231,255,.18)}
@media(max-width:640px){#s9sBot{flex-wrap:wrap}#s9sChips{order:-1;flex:1 0 100%}.s9sKeys .kb{display:none}.s9sBar{padding:8px 26px}#s9sTop{top:max(78px,calc(env(safe-area-inset-top,0px) + 70px))}}`;
  document.head.appendChild(css);

  /* ================= small helpers ================= */
  const peers = () => (typeof NET !== 'undefined' && NET.peers) || new Map();
  function plist() {   // stable order: the room's join order, only players we can see
    const m = meta(), out = [], P2 = peers();
    if (m && m.players) for (const p of m.players) { const E = P2.get(p.id); if (E && E.r) out.push({ id: p.id, n: p.n || E.r.name, team: p.team, E, r: E.r }); }
    for (const [id, E] of P2) if (E && E.r && !out.some(o => o.id === id)) out.push({ id, n: E.r.name, team: null, E, r: E.r });
    return out;
  }
  const isDead = o => !!(o.r.dead || (o.E.pres && o.E.pres.dd));
  const aliveCount = () => plist().filter(o => !isDead(o)).length;
  const nameOf = id => { const o = plist().find(x => x.id === id); return o ? o.n : ''; };
  const colorOf = o => (o.team && TEAM[o.team]) || o.r.cssCol || '#7fe7ff';
  const get = id => plist().find(x => x.id === id) || null;

  /* ================= hooks into the game ================= */
  function hook(name, make) { const f = window[name]; if (typeof f !== 'function' || f.__s9spec) return; const w = make(f); w.__s9spec = true; window[name] = w; }
  function hookAll() {
    hook('srvSend', f => function (o) {
      try { if (o && typeof o === 'object') {
        if (o.k === 'join' && (S.on || S.pending)) o.spec = 1;
        else if (o.k === 'create' && o.meta && typeof o.meta === 'object') { if (o.meta.spec === undefined) o.meta.spec = !!S.opt.on; if (o.meta.specMax === undefined) o.meta.specMax = S.opt.max | 0; }
      } } catch (e) {}
      return f.apply(this, arguments);
    });
    hook('setState', f => function (s) {
      if (S.on && (s === 'play' || s === 'paused')) s = 'dead';   // a spectator is never "playing": the dead state runs the world without a player
      const out = f.call(this, s);
      if (S.on && s === 'dead') settle();
      return out;
    });
    hook('startOnlineMatch', f => function () { const out = f.apply(this, arguments); if (S.on) { settle(); S.target = null; S.free = false; S.cur = null; } return out; });
    hook('beginRoomMatch', f => async function () { const out = await f.apply(this, arguments); if (S.on) { settle(); try { setState('dead'); } catch (e) {} } return out; });
    hook('leaveOnline', f => function () { const out = f.apply(this, arguments); exit(); return out; });
    hook('boardHTML', f => function () {
      const m = meta();
      if (S.on) return boardHTML2();
      const out = f.apply(this, arguments), n = m ? m.watching | 0 : 0;
      return n > 0 ? out + `<div class="s9watch">${svg.eye} ${n} watching</div>` : out;
    });
    const pre = window.MODE_preRender, post = window.MODE_postRender;
    if (!(pre && pre.__s9spec)) { const w = function (dt) { if (pre) pre.apply(this, arguments); if (S.on) try { camTick(dt); } catch (e) { warn(e); } }; w.__s9spec = true; window.MODE_preRender = w; }
    if (!(post && post.__s9spec)) { const w = function () { if (post) post.apply(this, arguments); if (S.on) restoreBodies(); }; w.__s9spec = true; window.MODE_postRender = w; }
  }
  let warned = 0; const warn = e => { if (warned++ < 3) console.warn('[spectate]', e); };

  // keep the player out of the world: dead, no respawn clock
  function settle() { try { P.dead = true; P.dieT = 0; P.shield = 0; P.hp = 100; } catch (e) {} document.body.classList.add('s9spec'); if (document.pointerLockElement && !S.free) { try { document.exitPointerLock(); } catch (e) {} } }

  /* ================= joining ================= */
  async function watch(code) {
    if (S.pending || !code) return false;
    S.pending = true;
    try { const ok = await window.openRoom(false, code); if (!ok) { S.on = false; return false; }
      const m = meta(); if (S.on && m && m.started && !NET.inMatch && !NET.starting && typeof beginRoomMatch === 'function') beginRoomMatch(m);   // a running match: step straight into the view
      return true; }
    finally { S.pending = false; }
  }
  function sit() { const r = room(); if (r && S.on) r.send({ k: 'sit' }); }
  function exit() {
    if (!S.on && !document.body.classList.contains('s9spec')) return;
    S.on = false; S.target = null; S.free = false; document.body.classList.remove('s9spec'); restoreBodies();
    if (document.pointerLockElement) try { document.exitPointerLock(); } catch (e) {}
    showUI(false);
  }
  // the server says who we are
  function onSrv(d) {
    if (d.k === 'welcome') {
      if (d.spec === 1) { S.on = true; S.pending = false; S.target = null; S.free = false; document.body.classList.add('s9spec'); }
      else if (S.on) {   // we took a free slot ("Join game"): become a normal player
        exit();
        setTimeout(() => { const m = meta(); if (m && m.started && typeof beginRoomMatch === 'function') { NET.inMatch = false; beginRoomMatch(m); } else if (typeof toRoomLobby === 'function') toRoomLobby('You joined the game. Waiting for the host to start the match...'); }, 120);
      }
    } else if (d.k === 'note' && S.on && d.e) { toast(d.e); }
  }

  /* ================= camera ================= */
  const hidden = [];   // [mesh, wasVisible] hidden for the first-person view
  function restoreBodies() { while (hidden.length) { const h = hidden.pop(); h[0].visible = h[1]; } if (S.rootHidden) { S.rootHidden.root.visible = true; S.rootHidden = null; } }
  function hideBody(r) {   // first person: hide the watched player's body but keep their gun in view
    const gunSet = new Set(); if (r.gun) r.gun.traverse(o => gunSet.add(o));
    r.root.traverse(o => { if ((o.isMesh || o.isSkinnedMesh || o.isSprite) && !gunSet.has(o) && o.visible) { hidden.push([o, o.visible]); o.visible = false; } });
  }
  const camFrom = { p: null, q: null, t: 1 };
  const FR = { x: 0, y: 3, z: 0, yaw: 0, pitch: 0 };
  const held = new Set();
  const _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _e = new THREE.Euler(0, 0, 0, 'YXZ');
  let deadSince = 0, lastTarget = null;
  function startBlend() { camFrom.t = 0; }
  function setTarget(id) { if (id === S.target) return; S.target = id; deadSince = 0; startBlend(); }
  function pickAlive(excl) { const l = plist(); return l.find(o => o.id !== excl && !isDead(o)) || l.find(o => o.id !== excl) || null; }
  function cycle(dir) {
    const l = plist(); if (!l.length) return; if (S.free) setFree(false);
    let i = l.findIndex(o => o.id === S.target);
    for (let k = 1; k <= l.length; k++) { const o = l[((i < 0 ? (dir > 0 ? -1 : 0) : i) + dir * k + l.length * 4) % l.length]; if (!isDead(o) || k === l.length) { setTarget(o.id); return; } }
  }
  function jumpTo(n) { const l = plist(); const o = l[n - 1]; if (!o) return; if (S.free) setFree(false); setTarget(o.id); }
  function setFree(on) {
    on = !!on; if (on === S.free) return;
    if (on) { const c = camera.position; FR.x = c.x; FR.y = c.y; FR.z = c.z; _e.setFromQuaternion(camera.quaternion, 'YXZ'); FR.yaw = _e.y; FR.pitch = _e.x; S.free = true; held.clear(); try { lock(); } catch (e) {} }
    else { S.free = false; S.cur = { x: FR.x, y: FR.y, z: FR.z, yaw: FR.yaw, p: FR.pitch }; startBlend(); if (document.pointerLockElement) try { document.exitPointerLock(); } catch (e) {} }
    renderUI(true);
  }
  function camTick(dt) {
    if (state !== 'dead') {   // the world must keep running; menu / match end screens are not ours
      if (state === 'play' || state === 'paused') setState('dead');
    }
    P.dead = true; P.dieT = 0;
    if (state !== 'dead') return;
    dt = Math.min(dt || .016, .1); const now = performance.now();
    // pick / repair the target
    let o = S.target && get(S.target);
    if (!o) { const n = pickAlive(); if (n) { S.target = n.id; deadSince = 0; startBlend(); o = n; } }
    if (camera.fov !== 78) { camera.fov = 78; camera.updateProjectionMatrix(); }
    if (S.free) {
      const sp = (held.has('ShiftLeft') || held.has('ShiftRight') ? 24 : 9) * dt;
      const fx = -Math.sin(FR.yaw), fz = -Math.cos(FR.yaw), rx = Math.cos(FR.yaw), rz = -Math.sin(FR.yaw);
      const cp = Math.cos(FR.pitch), mv = { f: (held.has('KeyW') ? 1 : 0) - (held.has('KeyS') ? 1 : 0), r: (held.has('KeyD') ? 1 : 0) - (held.has('KeyA') ? 1 : 0), u: (held.has('KeyE') ? 1 : 0) - (held.has('KeyQ') ? 1 : 0) };
      FR.x += (fx * cp * mv.f + rx * mv.r) * sp; FR.z += (fz * cp * mv.f + rz * mv.r) * sp; FR.y += (Math.sin(FR.pitch) * mv.f + mv.u) * sp;
      const ar = (held.has('ArrowLeft') ? 1 : 0) - (held.has('ArrowRight') ? 1 : 0), au = (held.has('ArrowUp') ? 1 : 0) - (held.has('ArrowDown') ? 1 : 0);
      FR.yaw += ar * 1.8 * dt; FR.pitch = Math.max(-1.5, Math.min(1.5, FR.pitch + au * 1.4 * dt));
      camera.position.set(FR.x, FR.y, FR.z); camera.rotation.set(FR.pitch, FR.yaw, 0, 'YXZ');
      return;
    }
    if (!o) return;
    const r = o.r, e = r.root.position;
    // the watched player went down: after 1.5 s follow whoever got them
    if (isDead(o)) {
      if (!deadSince) deadSince = now;
      else if (now - deadSince > 1500) {
        const kb = o.E.pres && o.E.pres.kb, killer = kb && kb !== 's' && kb !== o.id ? get(kb) : null;
        const n = killer && !isDead(killer) ? killer : pickAlive(o.id);
        if (n) { S.lastKiller = !!(killer && n === killer); setTarget(n.id); return; }
      }
    } else deadSince = 0;
    const yaw = r.aimYaw || 0, pitch = Math.max(-1.45, Math.min(1.45, r.aimPitch || 0)), eyeY = e.y + 1.62 - (r.crouch || 0) * .5;
    let tx = e.x, ty = eyeY, tz = e.z, tyaw = yaw - Math.PI, tp = pitch;
    if (S.chase) { tx -= Math.sin(yaw) * 2.7; tz -= Math.cos(yaw) * 2.7; ty += .55; tp = pitch * .6 - .08; }
    else if (!isDead(o)) hideBody(r);
    // yaw + pitch only (never any roll), eased so remote jitter does not show; slower right after a switch for a smooth cut
    const C = S.cur || (S.cur = { x: tx, y: ty, z: tz, yaw: tyaw, p: tp });
    if (S.snap) { C.x = tx; C.y = ty; C.z = tz; C.yaw = tyaw; C.p = tp; S.snap = false; }
    camFrom.t = Math.min(1, camFrom.t + dt / .3);
    const kk = 1 - Math.exp(-dt * (camFrom.t < 1 ? 9 : 32)), wrap = x => Math.atan2(Math.sin(x), Math.cos(x));
    C.x += (tx - C.x) * kk; C.y += (ty - C.y) * kk; C.z += (tz - C.z) * kk; C.yaw += wrap(tyaw - C.yaw) * kk; C.p += (tp - C.p) * kk;
    camera.position.set(C.x, C.y, C.z); camera.rotation.set(C.p, C.yaw, 0, 'YXZ');
  }

  /* ================= input ================= */
  addEventListener('keydown', e => {
    if (!S.on) return;
    if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (typeof state !== 'undefined' && state !== 'dead') return;
    held.add(e.code);
    if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) setFree(!S.free); }
    else if (e.code === 'KeyV' && !e.repeat) { S.chase = !S.chase; renderUI(true); }
    else if (!S.free && e.code === 'ArrowRight') { e.preventDefault(); cycle(1); }
    else if (!S.free && e.code === 'ArrowLeft') { e.preventDefault(); cycle(-1); }
    else if (/^Digit[1-9]$/.test(e.code)) jumpTo(+e.code.slice(5));
    else if (S.free && e.code.startsWith('Arrow')) e.preventDefault();
  }, true);
  addEventListener('keyup', e => { held.delete(e.code); }, true);
  addEventListener('blur', () => held.clear());
  document.addEventListener('mousemove', e => {
    if (!S.on || !S.free || typeof state === 'undefined' || state !== 'dead' || !document.pointerLockElement) return;
    const s = .0021 * ((typeof CFG !== 'undefined' && CFG.sens) || 1);
    FR.yaw -= Math.max(-300, Math.min(300, e.movementX)) * s; FR.pitch = Math.max(-1.5, Math.min(1.5, FR.pitch - Math.max(-300, Math.min(300, e.movementY)) * s));
  });
  document.addEventListener('mousedown', e => {
    if (!S.on || typeof state === 'undefined' || state !== 'dead') return;
    const row = e.target.closest && e.target.closest('[data-spec]'); if (row) { if (S.free) setFree(false); setTarget(row.dataset.spec); return; }
    if (e.target.closest && e.target.closest('button,input,select,a,#s9sBot,#board,#pause,#menu,#onlinePanel')) return;
    if (S.free) { if (!document.pointerLockElement) try { lock(); } catch (x) {} return; }
    if (e.button === 2) cycle(-1); else if (e.button === 0) cycle(1);
  });
  document.addEventListener('contextmenu', e => { if (S.on && typeof state !== 'undefined' && state === 'dead') e.preventDefault(); });

  /* ================= on-screen UI ================= */
  const top = document.createElement('div'); top.id = 's9sTop'; top.hidden = true;
  top.innerHTML = `<div class="s9sBar"><span class="tag"><i></i><span id="s9sTag">SPECTATING</span></span><span class="nm" id="s9sName">-</span></div><div class="s9sInfo" id="s9sInfo"></div>
    <div class="s9sKeys"><span class="kb"><kbd>&larr;</kbd><kbd>&rarr;</kbd>/click switch</span><span class="kb"><kbd>1-9</kbd>player</span><span class="kb"><kbd>Space</kbd>free cam</span><span class="kb"><kbd>V</kbd>chase</span><span class="kb"><kbd>Tab</kbd>scoreboard</span></div>`;
  const bot = document.createElement('div'); bot.id = 's9sBot'; bot.hidden = true;
  bot.innerHTML = `<div id="s9sChips"></div><button id="s9sPrev" title="Previous player" aria-label="Previous player">${svg.left}</button><button id="s9sNext" title="Next player" aria-label="Next player">${svg.right}</button>
    <button id="s9sFree" title="Free camera (Space)">Free cam</button><button id="s9sJoin" class="go" title="Take a free player slot">Join game</button><button id="s9sLeave" class="lv" title="Stop watching">Leave</button>`;
  const eye = document.createElement('div'); eye.id = 's9eye'; eye.hidden = true;
  document.body.append(top, bot, eye);
  const toastEl = document.createElement('div'); toastEl.style.cssText = 'position:fixed;left:50%;bottom:78px;transform:translateX(-50%);z-index:40;background:rgba(11,13,16,.9);border:1px solid var(--sodium);color:var(--sodium);font:600 12px var(--mono);letter-spacing:.08em;padding:8px 14px;display:none;pointer-events:none';
  document.body.appendChild(toastEl); let toastT = 0;
  function toast(t) { toastEl.textContent = t; toastEl.style.display = 'block'; clearTimeout(toastT); toastT = setTimeout(() => { toastEl.style.display = 'none'; }, 2600); }
  const on = (id, f) => $(id).addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); f(); });
  on('s9sPrev', () => cycle(-1)); on('s9sNext', () => cycle(1)); on('s9sFree', () => setFree(!S.free)); on('s9sJoin', () => sit());
  on('s9sLeave', () => { const b = $('btnQuit'); if (b) b.click(); else if (typeof leaveOnline === 'function') leaveOnline(); });
  $('s9sChips').addEventListener('pointerdown', e => { const c = e.target.closest('[data-spec]'); if (c) { e.preventDefault(); if (S.free) setFree(false); setTarget(c.dataset.spec); } });
  function showUI(v) { top.hidden = bot.hidden = !v; }
  let lastKey = '';
  function renderUI(force) {
    const m = meta(), l = plist(), cur = S.target && get(S.target);
    const inView = S.on && typeof state !== 'undefined' && state === 'dead' && NET.inMatch;
    showUI(inView); if (!inView) return;
    const delay = m && m.specDelay ? m.specDelay / 1000 : 0, w = m ? m.watching | 0 : 0;
    $('s9sTag').textContent = S.free ? 'FREE CAM' : 'SPECTATING' + (S.chase ? ' · CHASE' : '');
    const nm = $('s9sName'); nm.textContent = S.free ? (cur ? 'Roaming' : 'Roaming') : (cur ? cur.n : 'Waiting for players...'); nm.className = 'nm' + (cur && isDead(cur) && !S.free ? ' dead' : ''); nm.style.setProperty('--tc', cur ? colorOf(cur) : 'transparent');
    let info = '';
    if (cur && !S.free) {
      const p = cur.E.pres || {}, wn = (typeof WEAPONS !== 'undefined' && typeof NET_W !== 'undefined' && WEAPONS[NET_W[p.w | 0]]) || null, hp = Math.max(0, Math.min(100, Math.round(cur.r.hp != null ? cur.r.hp : p.hp || 0)));
      info = `<span>${esc(wn ? wn.name : '')}</span><span>HP <b>${hp}</b><span class="hp"><s style="transform:scaleX(${hp / 100})"></s></span></span><span>K <b>${p.K | 0}</b> D <b>${p.D | 0}</b></span>`
        + (isDead(cur) ? `<span style="color:var(--alert)">${S.lastKiller ? 'following killer' : 'eliminated'}</span>` : '');
    }
    info += `<span>${svg.eye.replace('width="14" height="14"', 'width="12" height="12"')} <b>${w}</b> watching</span>` + (delay ? `<span style="color:var(--sodium)">stream delayed ${delay} s</span>` : '');
    const k = info + '|' + force; if ($('s9sInfo').dataset.k !== k) { $('s9sInfo').dataset.k = k; $('s9sInfo').innerHTML = info; }
    // chips
    const chips = l.map((o, i) => `<div data-spec="${esc(o.id)}" class="${o.id === S.target && !S.free ? 'cur' : ''} ${isDead(o) ? 'dead' : ''}" style="--c:${colorOf(o)}"><kbd>${i < 9 ? i + 1 : ''}</kbd><i></i>${esc(o.n)}<em>${o.E.pres ? o.E.pres.K | 0 : 0}</em></div>`).join('');
    if ($('s9sChips').dataset.k !== chips) { $('s9sChips').dataset.k = chips; $('s9sChips').innerHTML = chips || '<div style="cursor:default">No players yet</div>'; }
    $('s9sFree').classList.toggle('on', S.free); $('s9sFree').textContent = S.free ? 'Follow' : 'Free cam';
    const free = m && m.count < m.size, canSit = free && !(m.mode === 'demo' && m.started);
    $('s9sJoin').hidden = !free; $('s9sJoin').disabled = !canSit;
    $('s9sJoin').title = canSit ? 'Take a free player slot' : 'Wait for the round to end';
  }
  // spectators see the table with click-to-jump rows
  function boardHTML2() {
    const l = plist().slice().sort((a, b) => (b.E.pres ? b.E.pres.K | 0 : 0) - (a.E.pres ? a.E.pres.K | 0 : 0) || (a.E.pres ? a.E.pres.D | 0 : 0) - (b.E.pres ? b.E.pres.D | 0 : 0)), m = meta();
    const rows = l.map((o, i) => { const p = o.E.pres || {}, kd = ((p.K | 0) / Math.max(1, p.D | 0)).toFixed(2), ping = o.r.ping | 0;
      return `<tr data-spec="${esc(o.id)}" class="${o.id === S.target ? 'me' : ''}"><td>${i + 1}</td><td><i style="background:${colorOf(o)}"></i>${esc(o.n)}${isDead(o) ? ' (down)' : ''}</td><td>${p.K | 0}</td><td>${p.D | 0}</td><td>${kd}</td><td>${Math.max(0, Math.round(o.r.hp || 0))}</td><td>${ping ? ping + ' ms' : ''}</td></tr>`; }).join('');
    return `<table><thead><tr><th>#</th><th>Player (click to watch)</th><th>K</th><th>D</th><th>K/D</th><th>HP</th><th>Ping</th></tr></thead><tbody>${rows}</tbody></table><div class="s9watch">${svg.eye} ${m ? m.watching | 0 : 0} watching</div>`;
  }

  /* ================= room list: Watch buttons ================= */
  function roomInfo(code) { try { return (LOBBY.srv || []).find(r => r.code === code) || null; } catch (e) { return null; } }
  function decorateRooms() {
    for (const b of document.querySelectorAll('#onlinePanel [data-room], [data-room]')) {
      if (b.dataset.s9w) continue; const code = b.dataset.room; if (!code) continue;
      const info = roomInfo(code); b.dataset.s9w = '1';
      if (info && !info.spec) continue;                                    // the host switched spectating off
      if (info && info.spec && (info.watching | 0) >= (info.specMax | 0 || 4)) continue;   // audience full
      const full = info && info.count >= info.size, live = info && info.started;
      const w = document.createElement('button'); w.className = 's9wb'; w.dataset.watch = code; w.type = 'button';
      w.innerHTML = svg.eye + (full || live ? 'Watch instead' : 'Watch'); w.title = 'Watch without taking a player slot';
      if (info && (info.watching | 0)) w.title += ` (${info.watching} watching)`;
      b.insertAdjacentElement('afterend', w);
    }
  }
  document.addEventListener('click', e => { const b = e.target.closest && e.target.closest('[data-watch]'); if (!b) return; e.preventDefault(); e.stopPropagation(); watch(b.dataset.watch); }, true);
  // the list is re-rendered by the game / menu module: add the buttons again after every change
  let scanQ = 0; const mo = new MutationObserver(() => { if (scanQ) return; scanQ = requestAnimationFrame(() => { scanQ = 0; try { decorateRooms(); } catch (e) {} }); });
  mo.observe(document.body, { childList: true, subtree: true });

  /* ================= room options (create + settings) and the lobby block ================= */
  function optHTML(p) {
    return `<label>Spectators<select id="${p}Spec"><option value="1">Allowed</option><option value="0">Off</option></select></label><label>Max watching<select id="${p}SpecMax">${[1, 2, 3, 4, 5, 6, 7, 8].map(n => `<option>${n}</option>`).join('')}</select></label>`;
  }
  function injectOptions() {
    const c = $('btnCreate'), s = $('btnSaveRoom');
    if (c && !$('rSpec')) { c.insertAdjacentHTML('beforebegin', optHTML('r')); $('rSpec').value = S.opt.on ? '1' : '0'; $('rSpecMax').value = String(S.opt.max);
      const sync = () => { S.opt.on = $('rSpec').value === '1'; S.opt.max = +$('rSpecMax').value || 4; $('rSpecMax').disabled = !S.opt.on; }; $('rSpec').addEventListener('change', sync); $('rSpecMax').addEventListener('change', sync); }
    if (s && !$('eSpec')) { s.insertAdjacentHTML('beforebegin', optHTML('e'));
      for (const id of ['eSpec', 'eSpecMax']) $(id).addEventListener('change', () => { const oe = $('oEdit'); if (oe) { oe.dataset.dirty = '1'; if ($('oEditMsg')) $('oEditMsg').textContent = 'Unsaved changes'; } });
      s.addEventListener('click', () => { const r = room(); if (r && r.isHost) r.send({ k: 'meta', m: { spec: $('eSpec').value === '1', specMax: +$('eSpecMax').value || 4 } }); }, true); }
    const ow = $('oWait');
    if (ow && !$('s9sLobby')) { const d = document.createElement('div'); d.id = 's9sLobby'; d.hidden = true;
      d.innerHTML = `<b>${svg.eye} You are watching</b><span id="s9sLobbyTx"></span><button class="s9wb" id="s9sLobbyJoin" type="button">Join game</button>`; ow.insertAdjacentElement('afterend', d);
      $('s9sLobbyJoin').addEventListener('click', e => { e.preventDefault(); sit(); }); }
  }
  function tick() {
    try {
      injectOptions(); decorateRooms();
      const m = meta(), r = room();
      // edit controls follow the room
      if (m && $('eSpec') && !($('oEdit') && $('oEdit').dataset.dirty) && !($('oEdit') && $('oEdit').contains(document.activeElement))) { $('eSpec').value = m.spec ? '1' : '0'; $('eSpecMax').value = String(m.specMax || 4); $('eSpecMax').disabled = !m.spec; }
      // lobby block for spectators + "N watching" line for everyone
      const lobby = $('s9sLobby');
      if (lobby) {
        const show = !!(S.on && r && m && !NET.inMatch); lobby.hidden = !show;
        if (show) { const free = m.count < m.size; $('s9sLobbyTx').textContent = m.started ? 'The match is running. Press "Rejoin match" to watch it.' : 'Waiting for the host to start. You will see the match from the first second.'; $('s9sLobbyJoin').hidden = !free; $('s9sLobbyJoin').disabled = !(free && !(m.mode === 'demo' && m.started)); }
      }
      const info = $('oRoomInfo'), w = m ? m.watching | 0 : 0;
      if (info && r && m && w > 0 && !/watching/.test(info.textContent)) info.textContent += ` · ${w} watching`;
      // pill for players in a running match
      const inM = !!(r && NET.inMatch && !S.on && typeof state !== 'undefined' && (state === 'play' || state === 'dead' || state === 'paused'));
      eye.hidden = !(inM && w > 0); if (!eye.hidden) { const h = `${svg.eye} ${w} watching`; if (eye.dataset.h !== h) { eye.dataset.h = h; eye.innerHTML = h; } }
      renderUI(false);
    } catch (e) { warn(e); }
  }

  // wait for the game's own wiring (SRV, globals) then hook
  function boot() {
    if (typeof SRV === 'undefined' || typeof NET === 'undefined' || typeof camera === 'undefined') return setTimeout(boot, 100);
    hookAll(); SRV.on.add(onSrv); injectOptions(); setInterval(tick, 200);
  }
  boot();
})();
