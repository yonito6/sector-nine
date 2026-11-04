/* Touch / phone play (add-on, touch devices only; desktop = no effect). Public: window.S9Touch {ready, active, debug()}.
   Item 69: phone landscape layout (compact menus/HUD/settings/shop) + "rotate your phone" hint in portrait + viewport meta.
   Item 73: on-screen controls (CoD/PUBG Mobile style): floating left stick = move (push past the ring = sprint), drag right half = aim,
   fire (hold = auto fire, drag while holding = aim), jump, crouch/slide, reload, weapon swap, ADS toggle, E (dash; hold = plant/defuse). No pointer lock.
   Item 3: first-run Performance graphics preset; light aim assist (slower aim near an enemy at the crosshair) for touch only;
   phone flag: NET.touch = true and srvSend adds ph:1 to create/join (server field: see touch.INTEGRATE.md).
   Hooks: index.html globals (state via __s9, keys, P, mouseDown, adsHeld, look, startReload, tryDash, switchWeapon, SLOTS, setState, CFG, renderer, camera, robots); wraps srvSend.
   Never edits index.html. Enabled when (pointer:coarse + touch points) or ?touch=1 or localStorage sector9-touch=1; ?touch=0 forces off. */
(function () {
  if (window.S9Touch) return;
  const qs = new URLSearchParams(location.search);
  let force = qs.get('touch'); if (force === null) { try { force = localStorage.getItem('sector9-touch'); } catch (e) {} }
  const real = (navigator.maxTouchPoints > 0 || 'ontouchstart' in window) && matchMedia('(pointer:coarse)').matches;
  const on = force === '0' ? false : (force === '1' || real);
  const API = window.S9Touch = { ready: false, active: on, stick: { x: 0, y: 0 }, assist: 1, debug() { return { active: on, state: window.__s9 && __s9.state, stick: API.stick, assist: API.assist, ads: adsHeld, fire: mouseDown, q: CFG.q }; } };
  if (!on) { API.ready = true; return; }

  // ---- viewport + layout CSS ----
  if (!document.querySelector('meta[name=viewport]')) { const m = document.createElement('meta'); m.name = 'viewport'; m.content = 'width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover'; document.head.appendChild(m); }
  const css = document.createElement('style');
  css.textContent = `
  html,body{overscroll-behavior:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
  .touchnote{display:none!important}
  #s9t{position:fixed;inset:0;z-index:30;pointer-events:none;display:none;touch-action:none;-webkit-tap-highlight-color:transparent}
  #s9t.on{display:block}
  #s9t .b{position:absolute;display:grid;place-items:center;border-radius:50%;background:rgba(20,24,30,.38);border:2px solid rgba(255,255,255,.35);color:rgba(255,255,255,.85);
    font:700 11px/1 'IBM Plex Mono',monospace;letter-spacing:.04em;pointer-events:auto;touch-action:none;text-shadow:none}
  #s9t .b.dn{background:rgba(255,140,40,.5);border-color:rgba(255,200,120,.9)}
  #s9t .b.tg{background:rgba(255,140,40,.45)}
  #s9tFire{right:calc(max(3vw,env(safe-area-inset-right,0px)) + 0px);bottom:14vh;width:22vh;height:22vh;font-size:13px}
  #s9tJump{right:calc(max(3vw,env(safe-area-inset-right,0px)) + 25vh);bottom:7vh;width:15vh;height:15vh}
  #s9tAds{right:calc(max(3vw,env(safe-area-inset-right,0px)) + 25vh);bottom:25vh;width:14vh;height:14vh}
  #s9tCrouch{right:calc(max(3vw,env(safe-area-inset-right,0px)) + 2vh);bottom:46vh;width:12vh;height:12vh}
  #s9tRel{right:calc(max(3vw,env(safe-area-inset-right,0px)) + 17vh);bottom:46vh;width:12vh;height:12vh}
  #s9tSw{right:calc(max(3vw,env(safe-area-inset-right,0px)) + 46vh);bottom:25vh;width:11vh;height:11vh}
  #s9tE{right:calc(max(3vw,env(safe-area-inset-right,0px)) + 52vh);bottom:7vh;width:13vh;height:13vh}
  #s9tPause{top:max(8px,env(safe-area-inset-top,0px));right:max(8px,env(safe-area-inset-right,0px));width:38px;height:38px;border-radius:10px;font-size:14px}
  #s9tBase{position:absolute;left:max(6vw,env(safe-area-inset-left,0px));bottom:max(12vh,20px);width:clamp(90px,28vh,130px);height:clamp(90px,28vh,130px);border-radius:50%;
    border:2px solid rgba(255,255,255,.28);background:rgba(20,24,30,.22)}
  #s9tBase.act{background:rgba(20,24,30,.38)}
  #s9tKnob{position:absolute;left:50%;top:50%;width:46%;height:46%;margin:-23% 0 0 -23%;border-radius:50%;background:rgba(255,255,255,.35);border:2px solid rgba(255,255,255,.55)}
  #s9tRot{position:fixed;inset:0;z-index:2000;display:none;place-items:center;text-align:center;background:#0b0d10;color:#e8eaee;font:600 18px/1.4 'IBM Plex Mono',monospace;padding:24px}
  #s9tRot b{display:block;font-size:54px;margin-bottom:10px;animation:s9tr 2s ease-in-out infinite}
  @keyframes s9tr{0%,30%{transform:rotate(0)}70%,100%{transform:rotate(-90deg)}}
  body.s9port #s9tRot{display:grid}
  /* phone landscape: compact menus, settings, shop, HUD */
  @media (max-height:520px){
    .overlay{padding:6px 10px!important;place-items:start center!important;-webkit-overflow-scrolling:touch}
    .sheet{max-width:min(96vw,780px)!important;font-size:12px!important;margin:0 auto!important;padding:10px 12px!important}
    .sheet h1,.overlay h1{font-size:30px!important;line-height:.95!important;margin:2px 0 6px!important}
    .overlay h2{font-size:16px!important;margin:4px 0!important}
    .huge{font-size:34px!important}.big{font-size:24px!important}
    .overlay .kicker,.overlay .note,.overlay p{font-size:11px!important;margin:3px 0!important}
    .overlay button,.overlay .btn,.overlay select,.overlay input{min-height:36px;font-size:12px!important}
    .overlay label{font-size:11px!important}
    #setMenu,#setPause{display:grid;grid-template-columns:auto 1fr auto;gap:4px 8px}
    #compass{top:6px!important;height:22px!important}
    #matchbar{top:32px!important;font-size:10px!important}
    #fps{font-size:9px!important}
    #kfeed{max-width:36vw;font-size:10px!important}
    #feed{font-size:10px!important}
    #abil{display:none!important}
    #board{font-size:10px!important}
  }`;
  document.head.appendChild(css);

  // ---- DOM ----
  const root = document.createElement('div'); root.id = 's9t';
  root.innerHTML = '<div id="s9tBase"><div id="s9tKnob"></div></div>' +
    '<div class="b" id="s9tFire">FIRE</div><div class="b" id="s9tJump">JUMP</div><div class="b" id="s9tAds">ADS</div><div class="b" id="s9tCrouch">CROUCH</div>' +
    '<div class="b" id="s9tRel">RELOAD</div><div class="b" id="s9tSw">SWAP</div><div class="b" id="s9tE">E</div><div class="b" id="s9tPause">II</div>';
  const rot = document.createElement('div'); rot.id = 's9tRot'; rot.innerHTML = '<div><b>&#128241;</b>Rotate your phone<br><span style="font-weight:400;font-size:13px;opacity:.7">Sector Nine plays in landscape</span></div>';
  const $ = id => document.getElementById(id);
  const add = () => { document.body.appendChild(root); document.body.appendChild(rot); };
  if (document.body) add(); else addEventListener('DOMContentLoaded', add);
  const port = () => { document.body && document.body.classList.toggle('s9port', innerHeight > innerWidth * 1.05); };
  addEventListener('resize', port); addEventListener('orientationchange', port); setInterval(port, 800);

  const playing = () => window.__s9 && __s9.state === 'play';
  const lookTouch = (dx, dy) => { const k = 1.55 * API.assist; try { look(dx * k, dy * k); } catch (e) {} };
  const sk = {};
  const setKeys = (x, y, sprint) => {
    const t = .28, v = { KeyW: y < -t, KeyS: y > t, KeyA: x < -t, KeyD: x > t, ShiftLeft: sprint };
    for (const k in v) if (v[k] !== !!sk[k]) { sk[k] = v[k]; keys[k] = v[k]; }
  };

  // ---- touch routing ----
  const base = () => $('s9tBase'), knob = () => $('s9tKnob');
  const tracks = new Map();   // touch id -> {kind, x, y}
  const R = () => Math.max(40, base().getBoundingClientRect().width * .5);
  let cx = 0, cy = 0, rad0 = 55;
  function stickMove(t) {
    const r = rad0; const dx = t.clientX - cx, dy = t.clientY - cy; const m = Math.hypot(dx, dy) || 1, c = Math.min(m, r);
    const nx = dx / m * c / r, ny = dy / m * c / r; API.stick.x = nx; API.stick.y = ny;
    knob().style.transform = `translate(${nx * r * .8}px,${ny * r * .8}px)`;
    setKeys(nx, ny, m > r * 1.15 && ny < -.5);
  }
  function stickEnd() { knob().style.transform = ''; base().classList.remove('act'); base().style.cssText = ''; setKeys(0, 0, false); API.stick.x = API.stick.y = 0; }
  const btnDown = {
    s9tFire() { mouseDown = true; P.trigReady = true; },
    s9tJump() { P.jumpQ = .15; },
    s9tAds() { if (P.weapon === 'knife') { try { knifeAttack(true); } catch (e) {} } else { adsHeld = !adsHeld; if (adsHeld) try { sfx.adsIn(); } catch (e) {} } },
    s9tCrouch() { if (P.sprint && P.onGround && Math.hypot(P.vel.x, P.vel.z) > 6) startSlide(); else P.crouchHold = !P.crouchHold; },
    s9tRel() { startReload(); },
    s9tSw() { const Sl = SLOTS(); switchWeapon(P.weapon === Sl[0] ? Sl[1] : Sl[0]); },
    s9tE() { keys.KeyE = true; tryDash(); },
    s9tPause() { setState('paused'); }
  };
  const btnUp = { s9tFire() { mouseDown = false; }, s9tE() { keys.KeyE = false; } };
  document.addEventListener('touchstart', e => {
    if (!playing()) return;
    for (const t of e.changedTouches) {
      const el = t.target && t.target.closest ? t.target.closest('.b') : null;
      if (el) {
        tracks.set(t.identifier, { kind: 'btn', id: el.id, x: t.clientX, y: t.clientY, el });
        if (el.id !== 's9tAds' && el.id !== 's9tCrouch') el.classList.add('dn');
        if (btnDown[el.id]) btnDown[el.id]();
      } else if (t.clientX < innerWidth * .46 && ![...tracks.values()].some(v => v.kind === 'stick')) {
        cx = t.clientX; cy = t.clientY; const b = base(); rad0 = R(); b.classList.add('act');
        b.style.left = (cx - rad0) + 'px'; b.style.bottom = 'auto'; b.style.top = (cy - rad0) + 'px';
        tracks.set(t.identifier, { kind: 'stick' }); stickMove(t);
      } else tracks.set(t.identifier, { kind: 'aim', x: t.clientX, y: t.clientY });
    }
    e.preventDefault();
  }, { passive: false });
  document.addEventListener('touchmove', e => {
    if (!tracks.size) return;
    for (const t of e.changedTouches) {
      const k = tracks.get(t.identifier); if (!k) continue;
      if (k.kind === 'stick') stickMove(t);
      else if (k.kind === 'aim' || (k.kind === 'btn' && k.id === 's9tFire')) { if (playing()) lookTouch(t.clientX - k.x, t.clientY - k.y); k.x = t.clientX; k.y = t.clientY; }
    }
    if (playing()) e.preventDefault();
  }, { passive: false });
  const end = e => {
    for (const t of e.changedTouches) {
      const k = tracks.get(t.identifier); if (!k) continue; tracks.delete(t.identifier);
      if (k.kind === 'stick') stickEnd();
      else if (k.kind === 'btn') { if (k.id !== 's9tAds' && k.id !== 's9tCrouch') k.el.classList.remove('dn'); if (btnUp[k.id]) btnUp[k.id](); }
    }
  };
  document.addEventListener('touchend', end); document.addEventListener('touchcancel', end);

  // ---- light aim assist: slow the aim while an enemy is near the crosshair ----
  let projV = null;
  const ally = r => { try { const M = window.MODE; if (!M || !M.teamMode || !M.teamMode()) return false; const t = M.myTeam(); return !!t && M.teamOf(r.netId) === t; } catch (e) { return false; } };
  function assistTick() {
    let f = 1;
    try {
      if (!__s9.THREE) return;
      projV = projV || new __s9.THREE.Vector3();
      const W = innerWidth, H = innerHeight, rad = Math.min(W, H) * .16;
      for (const r of robots) {
        if (!r || r.dead || !r.root) continue;
        if (r.netId && ally(r)) continue;   // never assist toward a teammate (online team modes)
        projV.copy(r.root.position); projV.y += 1.2; projV.project(camera);
        if (projV.z > 1) continue;
        if (Math.hypot((projV.x * .5 + .5) * W - W / 2, (-projV.y * .5 + .5) * H - H / 2) < rad) { f = .55; break; }
      }
    } catch (e) {}
    API.assist = f;
  }
  let wasPlay = false;
  setInterval(() => {
    const p = !!playing();
    if (p !== wasPlay) {
      wasPlay = p; root.classList.toggle('on', p);
      if (!p) { setKeys(0, 0, false); mouseDown = false; keys.KeyE = false; stickEnd(); tracks.clear(); }
      else { try { if (document.documentElement.requestFullscreen && !document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {}); } catch (e) {} }
    }
    if (p) { assistTick(); const a = $('s9tAds'); if (a) a.classList.toggle('tg', !!adsHeld); const c = $('s9tCrouch'); if (c) c.classList.toggle('tg', !!P.crouchHold); }
  }, 60);

  // ---- setup once the game is up ----
  function setup() {
    try { renderer.domElement.requestPointerLock = undefined; } catch (e) {}   // no pointer lock on phones: lock() falls back to noLock mode
    try { if (!localStorage.getItem('sector9-touch-q')) { localStorage.setItem('sector9-touch-q', '1'); CFG.q = 'performance'; saveCfg(); applyQuality(); syncSettings(); } } catch (e) {}
    try { NET.touch = true; } catch (e) {}
    try { const _s = srvSend; srvSend = function (o) { if (o && typeof o === 'object' && (o.k === 'join' || o.k === 'create')) o = Object.assign({ ph: 1 }, o); return _s.call(this, o); }; } catch (e) {}
    port(); API.ready = true;
  }
  const boot = () => { try { if (window.__s9 && renderer) return setup(); } catch (e) {} setTimeout(boot, 200); };
  boot();
})();
