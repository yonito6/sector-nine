/* Sector Nine add-on: BR-6 Obelisk, the bolt-action rail sniper (modules/w_obelisk.js)
   The numbers live in index.html WEAPONS.obelisk (so the server anti-cheat reads them like every core gun): one shot, then a
   1.2 s bolt cycle (P.boltT), head, body or arm shot kills, legs leave ~18 HP, the scope is a 1.75x lens (no full-screen zoom). This add-on brings:
   - the model (Blender, render/weapons/obelisk/obelisk.py -> assets/models/weapons/obelisk/obelisk.js): registered as a
     "unique gun" (KIT g_obelisk / g_obelisk_sight + GMETA) so the game's own buildGunVM / rifleTP make the first-person
     viewmodel (hands, reticle, flash) and the third-person gun (bots, online players, drops);
   - the BOLT: a separate part animated through the cycle (lift, pull back, push, lock) in first person (from P.boltT) and in
     third person (bots: when they fire; online players: on their shot event, so everyone sees the same cycle);
   - its own scope (Cryzen style): a round 1.75x lens in the middle of an un-zoomed, dimmed screen (picture-in-picture inside the post
     chain), black ring, posts, mil lines and a bright centre dot inside the lens. The scope snaps in / out on the same frame (WEAPONS.obelisk.scopeSnap,
     no zoom tween, no sway), drops while the bolt cycles and comes back if you still hold aim (index.html adsT); a weapon switch
     cancels the bolt (draw 0.4 s: quick-switch);
   - bots: half of the sniper bots carry the Obelisk (BOTW.obelisk in index.html).
   API: window.S9Obelisk = { ready, model, stats, boltPhase(u), tpBolts() }.  Hooks: buildGunVM, rifleTP, updateViewmodel,
   botShoot, netReceive, buildBot. Shaders compile at load (renderer.compile), never mid-match. */
(function () {
  'use strict';
  const ID = 'obelisk';
  if (window.S9Obelisk || typeof WEAPONS === 'undefined' || !WEAPONS[ID] || typeof THREE === 'undefined') return;
  const OB = window.S9Obelisk = { ready: false, model: false, errors: [], stats: { vmBuilt: 0, tpBuilt: 0, tpCycles: 0, remoteCycles: 0, botSwaps: 0 } };
  // network weapon index: appended at the very END (after every other add-on's ids), so no live gun's index moves
  if (typeof NET_W !== 'undefined' && !NET_W.includes(ID)) NET_W.push(ID);
  const warn = e => { if (OB.errors.length < 20) OB.errors.push(String(e && e.stack || e)); try { console.warn('[obelisk]', e); } catch (x) {} };
  let META = { muzzle: [0, 0, -1.07], fore: [0, -.17, -.38], fore_style: 'under', bolt: { pivot: [0, .018, 0], travel: .075, lift: 1.05 } };

  /* ---------- bolt cycle keyframes: u = 0..1 over the cycle -> { lift 0..1, back 0..1 } ---------- */
  const ez = t => t * t * (3 - 2 * t), seg = (u, a, b) => ez(Math.max(0, Math.min(1, (u - a) / (b - a))));
  function boltPhase(u) {
    if (!(u > 0 && u < 1)) return { lift: 0, back: 0 };
    const lift = u < .5 ? seg(u, .02, .2) : 1 - seg(u, .72, .88);   // handle up, then down to lock
    const back = u < .5 ? seg(u, .2, .42) : 1 - seg(u, .5, .7);      // pull back (casing out), push forward
    return { lift, back };
  }
  OB.boltPhase = boltPhase;
  function poseBolt(b, u, tp) {
    if (!b) return; const ph = boltPhase(u), B = META.bolt, s = tp ? .6 : 1;
    b.rotation.z = ph.lift * B.lift;                                        // own bore axis (the third-person part is also turned 180 deg about y: Rz applies first)
    b.position.z = b.userData.z0 + ph.back * B.travel * s * (tp ? -1 : 1);
  }

  /* ---------- model -> KIT parts (same format as index.html kitInit: merged geometry per material) ---------- */
  function kitFrom(scene) {
    scene.updateMatrixWorld(true); const by = {};
    scene.traverse(o => { if (!o.isMesh) return;
      const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
      for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
      if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
      const g2 = g.index ? g.toNonIndexed() : g, mn = String(o.material && o.material.name || 's9_dark').replace(/\.\d+$/, ''); (by[mn] = by[mn] || []).push(g2); });
    return Object.entries(by).map(([m, list]) => { const geo = THREE.BufferGeometryUtils.mergeBufferGeometries(list); geo.setAttribute('uv2', geo.attributes.uv); return { m, geo }; });
  }
  function register(A) {
    const L = new THREE.GLTFLoader(), parse = j => new Promise((res, rej) => L.parse(JSON.stringify(j), '', g => res(g), rej));
    return Promise.all([parse(A.body), parse(A.sight), parse(A.bolt)]).then(([b, s, k]) => {
      KIT.g_obelisk = kitFrom(b.scene); KIT.g_obelisk_sight = kitFrom(s.scene); KIT.g_obelisk_bolt = kitFrom(k.scene);
      if (A.meta) META = Object.assign({}, META, A.meta);
      GMETA[ID] = { muzzle: META.muzzle, fore: META.fore, fs: META.fore_style || 'under', a: {} };
      if (typeof GPAINT !== 'undefined' && !GPAINT[ID]) GPAINT[ID] = 0x2b3d42;
      OB.model = true; if (window.S9A) window.S9A.obelisk = null;
      rebuild();
    });
  }
  function loadModel() {
    if (window.S9A && window.S9A.obelisk) return register(window.S9A.obelisk).catch(warn);
    const s = document.createElement('script'); s.src = 'assets/models/weapons/obelisk/obelisk.js';
    s.onload = () => { if (window.S9A && window.S9A.obelisk) register(window.S9A.obelisk).catch(warn); else warn('model script had no data'); };
    s.onerror = () => warn('model failed to load'); document.head.appendChild(s);
  }

  /* ---------- first person: the game's unique-gun viewmodel + the bolt part ---------- */
  function addBolt(g, tp) {
    if (!KIT.g_obelisk_bolt) return null;
    const glow = new THREE.MeshBasicMaterial({ color: new THREE.Color(...WEAPONS[ID].glow) }), b = kitPart('g_obelisk_bolt', tp, null, glow), s = tp ? .6 : 1, pv = META.bolt.pivot;
    b.scale.setScalar(s); if (tp) b.rotation.y = Math.PI;
    b.position.set(tp ? -pv[0] * s : pv[0], pv[1] * s, tp ? -pv[2] * s : pv[2]); b.userData.z0 = b.position.z; b.userData.noProbe = true; b.name = 'obBolt';
    g.add(b); return b;
  }
  { const _b = buildGunVM; buildGunVM = function (id) {
      const vm = _b.apply(this, arguments);
      if (id === ID && vm && vm.group && OB.model) { try { vm.obBolt = addBolt(vm.group, false); if (vm.hip) vm.hip.set(.19, -.215, -.52); OB.stats.vmBuilt++; } catch (e) { warn(e); } }   // a little further out: the long receiver + bolt stay in view
      return vm; }; }
  function rebuild() {   // the viewmodel made at boot (before the model arrived) is the generic fallback: build the real one now
    try {
      if (typeof WM !== 'undefined' && WM[ID] && WM[ID].group) { const old = WM[ID].group; if (old.parent) old.parent.remove(old); }
      if (typeof WM !== 'undefined' && Object.keys(WM).length) { WM[ID] = buildGunVM(ID); WM[ID].group.visible = false;
        if (typeof P !== 'undefined' && P.weapon === ID && typeof setModel === 'function') setModel(ID); }
      warm(); OB.ready = true;
    } catch (e) { warn(e); }
  }
  function warm() {   // compile the Obelisk materials up front (gun pass + world pass for the third-person gun)
    try {
      const vm = WM[ID]; if (vm && vm.group) { const v = vm.group.visible; vm.group.visible = true; renderer.compile(gunScene, gunCam); vm.group.visible = v; }
      const tp = rifleTP(ID); tp.position.set(0, -200, 0); scene.add(tp); renderer.compile(scene, camera); scene.remove(tp);
      if (OB.lensWarm) OB.lensWarm();   // the lens composite shader
    } catch (e) { warn(e); }
  }

  /* ---------- third person: bots, online players, drops ---------- */
  const TPB = new Set();   // { bolt, t0 } running third-person cycles
  { const _tp = rifleTP; rifleTP = function (kind) {
      const g = _tp.apply(this, arguments);
      if (kind === ID && OB.model && g) { try { const inner = g.children[0] || g; g.userData.obBolt = addBolt(inner, true); OB.stats.tpBuilt++; } catch (e) { warn(e); } }
      return g; }; }
  // found by name: third-person guns are often cloned (clone() deep-copies userData through JSON, so a part reference does not survive)
  function boltOf(r) { const g = r && r.gun; if (!g) return null; const b = g.getObjectByName('obBolt'); if (b && b.userData.z0 === undefined) b.userData.z0 = b.position.z; return b; }
  function startTP(r, remote) { const b = boltOf(r); if (!b) return; for (const x of TPB) if (x.bolt === b) TPB.delete(x); TPB.add({ bolt: b, t0: G.time, r }); OB.stats.tpCycles++; if (remote) OB.stats.remoteCycles++; }
  OB.tpBolts = () => [...TPB].map(x => ({ name: x.r && x.r.name, u: (G.time - x.t0) / (WEAPONS[ID].bolt || 1.2) }));
  { const _bs = botShoot; botShoot = function (r) { const out = _bs.apply(this, arguments); try { if (r && r.weapon === ID) startTP(r, false); } catch (e) { warn(e); } return out; }; }
  { const _nr = netReceive; netReceive = function (E, pr) {
      const before = E && E.last ? E.last.shot : 0, out = _nr.apply(this, arguments);
      try { if (E && E.last && E.last.shot > before && pr && (pr.wid === ID || (typeof NET_W !== 'undefined' && NET_W[pr.w | 0] === ID))) startTP(E.r, true); } catch (e) { warn(e); }
      return out; }; }
  // half of the sniper bots carry the Obelisk (profile only; the rest of the bot logic treats it as a sniper)
  { const _bb = buildBot; buildBot = function (profile) {
      if (profile && profile.weapon === 'sniper' && !OB.noBots && (OB.forceBots || Math.random() < .5)) { profile = Object.assign({}, profile, { weapon: ID }); OB.stats.botSwaps++; }
      return _bb.call(this, profile); }; }

  /* ---------- scope: Cryzen style lens (2026-11-10, owner) ----------
     The screen keeps the NORMAL view (WEAPONS.obelisk.adsFov = the hip 78: no zoom, slightly dimmed around the scope); only a round lens
     in the middle (LENS.r = 30 % of the screen height as radius, i.e. 60 % diameter) shows the view magnified LENS.mag (1.75x). The lens
     is a picture-in-picture: the scene is drawn from the same eye with a narrower FOV into a small render target (LENS.scale = 0.6 of
     the lens's pixel size), then composited in a circle INSIDE the post chain (after the world + gun pass, before bloom and the colour
     grade), so the lens gets the same bloom / tone mapping as the rest of the frame for free. The crosshair is the lens centre = the
     screen centre = where shots go. It opens on the same frame as aim (scopeSnap), no zoom animation; the gun model is hidden. */
  const LENS = OB.lens = { r: .3, mag: WEAPONS[ID].lens || 1.75, scale: .6, on: false, frames: 0, px: 0, cssR: 0, fov: 0, magNow: 0, probe: false, ms: 0 };
  const lensCam = new THREE.PerspectiveCamera(20, 1, camera.near, camera.far);
  const lensRT = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType });
  const lensMat = new THREE.ShaderMaterial({ uniforms: { tLens: { value: lensRT.texture }, uC: { value: new THREE.Vector2() }, uR: { value: 1 } },
    vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0., 1.); }',
    fragmentShader: 'uniform sampler2D tLens; uniform vec2 uC; uniform float uR; void main(){ vec2 d = (gl_FragCoord.xy - uC) / uR; if (dot(d, d) > 1.) discard; gl_FragColor = vec4(texture2D(tLens, d * .5 + .5).rgb, 1.); }',
    depthTest: false, depthWrite: false });
  const lensQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), lensMat), lensScene = new THREE.Scene(), quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  lensQuad.frustumCulled = false; lensScene.add(lensQuad);
  const lensWanted = () => typeof P !== 'undefined' && P.weapon === ID && P.ads > .85 && !P.dead && state === 'play' && !(typeof REC !== 'undefined' && REC.on);
  class LensPass extends THREE.Pass {
    constructor() { super(); this.needsSwap = false; }
    render(r, w, read) {
      LENS.on = lensWanted(); if (!LENS.on) return;
      try {
        const t0 = LENS.probe ? (r.getContext().finish(), performance.now()) : 0;
        const H = read.height, W = read.width, R = LENS.r * H, px = Math.max(64, Math.round(2 * R * LENS.scale));
        if (lensRT.width !== px) lensRT.setSize(px, px);
        // same eye as the game camera (incl. render-only kicks), narrower FOV: tan(lens/2) = (lens diameter / screen height) x tan(main/2) / mag
        camera.updateMatrixWorld(); lensCam.position.setFromMatrixPosition(camera.matrixWorld); lensCam.quaternion.setFromRotationMatrix(camera.matrixWorld);
        const tanM = 1 / camera.projectionMatrix.elements[5], tanL = 2 * LENS.r * tanM / LENS.mag;
        lensCam.fov = 2 * Math.atan(tanL) * 180 / Math.PI; lensCam.near = camera.near; lensCam.far = camera.far; lensCam.updateProjectionMatrix(); lensCam.updateMatrixWorld();
        LENS.fov = lensCam.fov; LENS.magNow = 2 * LENS.r * tanM / (1 / lensCam.projectionMatrix.elements[5]); LENS.px = px; LENS.cssR = R * innerHeight / H;
        // particles size themselves from the camera's pixels-per-radian: give them the lens's for this pass
        const sc = px / (2 * tanL), mats = [typeof FX !== 'undefined' && FX.mat, typeof SMOKE !== 'undefined' && SMOKE.mat, typeof DUST !== 'undefined' && DUST].filter(m => m && m.uniforms && m.uniforms.uScale), keep = mats.map(m => m.uniforms.uScale.value);
        mats.forEach(m => { m.uniforms.uScale.value = sc; });
        const au = r.shadowMap.autoUpdate; r.shadowMap.autoUpdate = false;   // the lens reuses this frame's shadow maps
        r.setRenderTarget(lensRT); r.clear(); r.render(scene, lensCam);
        r.shadowMap.autoUpdate = au; mats.forEach((m, i) => { m.uniforms.uScale.value = keep[i]; });
        lensMat.uniforms.uC.value.set(W / 2, H / 2); lensMat.uniforms.uR.value = R;
        r.setRenderTarget(read); r.render(lensScene, quadCam); LENS.frames++;
        if (LENS.probe) { r.getContext().finish(); LENS.ms = performance.now() - t0; }
      } catch (e) { warn(e); }
    }
  }
  OB.lensWarm = () => { try { renderer.compile(lensScene, quadCam); } catch (e) { warn(e); } };
  try { const gi = composer.passes.findIndex(p => p && p.constructor && p.constructor.name === 'GunPass'); composer.insertPass(new LensPass(), gi >= 0 ? gi + 1 : 2); } catch (e) { warn(e); }
  const css = document.createElement('style');
  // overlay: dim (not black) outside the lens, a black scope ring at the lens edge with a soft inner shade, posts + mil lines + dot
  // inside the lens only. .oblens = the lens circle itself (transparent: geometry for tests / layout).
  css.textContent = '#scope.ob{background:radial-gradient(circle at center,transparent 0 24vh,rgba(0,0,0,.32) calc(30vh - 1px),#000 30vh,#000 31.6vh,rgba(0,0,0,.55) 32.6vh,rgba(0,0,0,.26) 38vh)}' +
    '#scope .oblens{display:none}#scope.ob .oblens{display:block;left:50%;top:50%;width:60vh;height:60vh;margin:-30vh 0 0 -30vh;border-radius:50%;background:none}' +
    '#scope.ob .h{left:calc(50% - 30vh);right:auto;width:60vh}#scope.ob .v{top:calc(50% - 30vh);bottom:auto;height:60vh}' +
    '#scope.ob .tl{left:calc(50% - 30vh);width:22vh;height:6px;margin-top:-3px}#scope.ob .tr{right:calc(50% - 30vh);width:22vh;height:6px;margin-top:-3px}' +
    '#scope.ob .tb{bottom:calc(50% - 30vh);height:22vh;width:6px;margin-left:-3px}#scope .tt{display:none}#scope.ob .tt{display:block;top:calc(50% - 30vh);height:22vh;left:50%;width:6px;margin-left:-3px}' +
    '#scope .obx,#scope .oby{display:none}#scope.ob .obx{display:block;left:calc(50% - 8vh);width:16vh;top:50%;height:9px;margin-top:-4.5px;background:repeating-linear-gradient(90deg,#000 0 1px,transparent 1px 1.6vh);background-position:center;-webkit-mask:linear-gradient(90deg,#000 0 47%,transparent 47% 53%,#000 53%);mask:linear-gradient(90deg,#000 0 47%,transparent 47% 53%,#000 53%)}' +
    '#scope.ob .oby{display:block;top:calc(50% - 8vh);height:16vh;left:50%;width:9px;margin-left:-4.5px;background:repeating-linear-gradient(0deg,#000 0 1px,transparent 1px 1.6vh);background-position:center;-webkit-mask:linear-gradient(0deg,#000 0 47%,transparent 47% 53%,#000 53%);mask:linear-gradient(0deg,#000 0 47%,transparent 47% 53%,#000 53%)}' +
    '#scope.ob .dot{width:3px;height:3px;margin:-1.5px 0 0 -1.5px;background:#d8fbff;box-shadow:0 0 5px #6fdcff}';
  document.head.appendChild(css);
  { const sc = document.getElementById('scope'); if (sc) { const l = document.createElement('i'); l.className = 'oblens'; sc.prepend(l); for (const c of ['tt', 'obx', 'oby']) { const i = document.createElement('i'); i.className = c; sc.appendChild(i); } } }
  let scopeOn = null;

  /* ---------- per frame (once): first-person bolt, third-person cycles, scope style ---------- */
  { const _uv = updateViewmodel; updateViewmodel = function (dt) {
      const out = _uv.apply(this, arguments);
      try {
        const mine = typeof P !== 'undefined' && P.weapon === ID;
        if (mine !== scopeOn) { scopeOn = mine; const sc = document.getElementById('scope'); if (sc) sc.classList.toggle('ob', mine); }
        const vm = typeof WM !== 'undefined' && WM[ID];
        const u = mine && P.boltT > 0 ? 1 - P.boltT / (P.boltDur || WEAPONS[ID].bolt) : 0;
        if (vm && vm.obBolt) poseBolt(vm.obBolt, u, false);
        // present the bolt like a real bolt-action viewmodel: the gun rolls its right side up and comes in a bit (the core sets the transform every frame)
        if (mine && u > 0 && vm && vm.group === gun) { const k = Math.sin(Math.PI * Math.min(1, u / .9)) * (1 - P.ads); gun.rotation.z += .38 * k; gun.rotation.y += .1 * k; gun.position.x -= .035 * k; gun.position.y += .03 * k; gun.position.z += .03 * k; }
        if (TPB.size) { const cyc = WEAPONS[ID].bolt || 1.2;
          for (const x of TPB) { const u = (G.time - x.t0) / cyc; if (u >= 1 || u < 0 || !x.bolt.parent) { poseBolt(x.bolt, 0, true); TPB.delete(x); } else poseBolt(x.bolt, u, true); } }
      } catch (e) { warn(e); }
      return out; }; }

  loadModel();
})();
