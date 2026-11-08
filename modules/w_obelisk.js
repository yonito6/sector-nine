/* Sector Nine add-on: BR-6 Obelisk, the bolt-action rail sniper (modules/w_obelisk.js)
   The numbers live in index.html WEAPONS.obelisk (so the server anti-cheat reads them like every core gun): one shot, then a
   1.2 s bolt cycle (P.boltT), head or body shot kills, limbs leave ~18 HP, adsFov 8 (strongest zoom). This add-on brings:
   - the model (Blender, render/weapons/obelisk/obelisk.py -> assets/models/weapons/obelisk/obelisk.js): registered as a
     "unique gun" (KIT g_obelisk / g_obelisk_sight + GMETA) so the game's own buildGunVM / rifleTP make the first-person
     viewmodel (hands, reticle, flash) and the third-person gun (bots, online players, drops);
   - the BOLT: a separate part animated through the cycle (lift, pull back, push, lock) in first person (from P.boltT) and in
     third person (bots: when they fire; online players: on their shot event, so everyone sees the same cycle);
   - its own scope overlay (Cryzen / CS style: full black surround, thick posts, thin centre lines with mil ticks, small bright
     centre dot; the scope drops while the bolt cycles and comes back if you still hold aim: index.html adsT);
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

  /* ---------- scope overlay (only while the Obelisk is out) ---------- */
  const css = document.createElement('style');
  css.textContent = '#scope.ob{background:radial-gradient(circle at center,transparent 0 40.6vmin,rgba(0,0,0,.72) 41.2vmin,#05080a 42.4vmin,#000 43.2vmin)}' +
    '#scope.ob .tl,#scope.ob .tr{width:calc(50% - 14vmin);height:6px;margin-top:-3px}#scope.ob .tb,#scope.ob .tt{height:calc(50% - 14vmin);width:6px;margin-left:-3px}' +
    '#scope .tt{display:none}#scope.ob .tt{display:block;top:0;left:50%}' +
    '#scope .obx,#scope .oby{display:none}#scope.ob .obx{display:block;left:calc(50% - 14vmin);width:28vmin;top:50%;height:9px;margin-top:-4.5px;background:repeating-linear-gradient(90deg,#000 0 1px,transparent 1px 2.8vmin);background-position:center;-webkit-mask:linear-gradient(90deg,#000 0 47%,transparent 47% 53%,#000 53%);mask:linear-gradient(90deg,#000 0 47%,transparent 47% 53%,#000 53%)}' +
    '#scope.ob .oby{display:block;top:calc(50% - 14vmin);height:28vmin;left:50%;width:9px;margin-left:-4.5px;background:repeating-linear-gradient(0deg,#000 0 1px,transparent 1px 2.8vmin);background-position:center;-webkit-mask:linear-gradient(0deg,#000 0 47%,transparent 47% 53%,#000 53%);mask:linear-gradient(0deg,#000 0 47%,transparent 47% 53%,#000 53%)}' +
    '#scope.ob .dot{width:3px;height:3px;margin:-1.5px 0 0 -1.5px;background:#d8fbff;box-shadow:0 0 5px #6fdcff}';
  document.head.appendChild(css);
  { const sc = document.getElementById('scope'); if (sc) for (const c of ['tt', 'obx', 'oby']) { const i = document.createElement('i'); i.className = c; sc.appendChild(i); } }
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
