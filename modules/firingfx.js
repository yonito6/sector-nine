/* Sector Nine add-on: FIRING VFX (modules/firingfx.js)  -> window.S9FiringFX
   What it adds (GRAPHICS_RESEARCH #3, GUNS_HANDOFF item 3), all pooled, all compiled at load:
   - Per-gun muzzle flash SHAPES by weapon class (energy = long hot bolt + bloom, ballistic = star burst + cone, alien = lobed tendrils),
     tinted by the weapon's own colour. Replaces the three plain planes of the first-person flash group (they stay, hidden).
   - A short light flash on nearby surfaces: pooled additive splat on the wall/floor in front of the muzzle (no new real-time light).
   - Smoke wisps after bursts, vent glow at the muzzle + heat shimmer on sustained fire (the game's SMOKE pool + one glow quad per gun).
   - Pooled shell / energy-cell / pod ejection from the ejection port (instanced, gravity, floor bounce, despawn) + a sound hook
     (S9FiringFX.onBounce, default = the game's own sfx.impact, throttled). Replaces ejectCasing() while enabled.
   - Impact sparks/dust per surface type (data/firingfx.json "surfaces", mesh.userData.surface) on every bullet hole, plus ground dust
     when you fire at the floor close to you.
   - Recoil-linked slide / bolt / pump travel when the viewmodel exposes a part with that name.
   Cost: FX/SMOKE pools of the game (no new draw call), <= 3 instanced ejection meshes + <= 4 splat quads (hidden when idle).
   Weak tier (Performance): flash shapes + a small ejection pool only. Nothing is built after load: no shader compile mid-match.
   Hooks (each calls the original): updateViewmodel, ejectCasing, decal, warmShaders. S9FiringFX.enabled=false = pass-through.
   Data: data/firingfx.json (fallback built in). API: status(), perf, onBounce(kind,pos). */
(() => {
'use strict';
if (window.S9FiringFX) return;
if (typeof THREE === 'undefined' || typeof updateViewmodel !== 'function' || typeof ejectCasing !== 'function' || typeof decal !== 'function' || typeof FX === 'undefined' || typeof SMOKE === 'undefined') { console.warn('[firingfx] game globals not found, idle'); return; }
const T = THREE;
const FF = window.S9FiringFX = { ver: 1, ready: false, enabled: true, errors: 0, data: 'builtin', sound: true, stats: { shots: 0, ejected: 0, bounces: 0, splats: 0, impacts: 0, wisps: 0, dust: 0, rays: 0 }, perf: { n: 0, ms: 0, max: 0, win: [] } };
const warn = e => { FF.errors++; if (FF.errors < 6) console.warn('[firingfx]', e); };
const R = (a, b) => a + Math.random() * (b - a);

/* ------------------------------------------------------------------ data */
let D = {
  classes: { carbine: 'energy', wasp: 'energy', helix: 'energy', breacher: 'ballistic', sniper: 'ballistic', pistol: 'ballistic', nova: 'alien' },
  flash: { energy: { size: .34, len: .5 }, ballistic: { size: .38, len: .42 }, alien: { size: .36, len: .4 } },
  weaponScale: { sniper: 1.5, breacher: 1.4, pistol: .8, wasp: .85, helix: 1.3, nova: 1.2 },
  pools: { 0: { eject: 6, splat: 0 }, 1: { eject: 16, splat: 3 }, 2: { eject: 24, splat: 4 } },
  wisp: { heatPerShot: 1, heatDecay: 1.6, startAt: 3, rate: [0, 7, 12], life: [.9, 1.5], size: [.05, .1] },
  vent: { startAt: 7, full: 14 },
  eject: { life: 2.2, bounces: 3, restitution: .36, gravity: 16, soundGapMs: 90 },
  slide: { travel: .014, decay: 22 },
  surfaces: { concrete: { dust: [.62, .6, .56], puff: 3, sparks: 1 }, metal: { dust: [.5, .52, .56], puff: 1, sparks: 7 }, wood: { dust: [.55, .4, .24], puff: 3, sparks: 0, chips: 4 } }
};
try { fetch('data/firingfx.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : null).then(j => { if (j && j.surfaces) { D = Object.assign(D, j); FF.data = 'json'; } }).catch(() => {}); } catch (e) {}
FF.D = () => D;

const TI = { performance: 0, balanced: 1, high: 2, ultra: 2 };
const tier = () => { const q = (typeof CFG !== 'undefined' && CFG.q) || 'balanced'; return TI[q] ?? 1; };
const clsOf = id => D.classes[id] || 'energy';
const wcol = (w, k) => { const c = (w && (w.tracer || w.glow)) || [6, 3.2, 1.2]; const m = Math.max(c[0], c[1], c[2], .001); return [c[0] / m, c[1] / m, c[2] / m]; };

/* ------------------------------------------------------------------ textures (canvas, shared) */
function canvasTex(draw, w = 128, h = 128) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.globalCompositeOperation = 'lighter'; draw(g, w, h);
  const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; return t;
}
const rad = (g, x, y, r, stops) => { const gr = g.createRadialGradient(x, y, 0, x, y, r); for (const [o, col] of stops) gr.addColorStop(o, col); g.fillStyle = gr; g.fillRect(0, 0, g.canvas.width, g.canvas.height); };
const TEX = {
  glow: canvasTex((g, w, h) => rad(g, w / 2, h / 2, w / 2, [[0, 'rgba(255,255,255,1)'], [.25, 'rgba(255,255,255,.55)'], [.6, 'rgba(255,255,255,.12)'], [1, 'rgba(255,255,255,0)']])),
  // ballistic: star burst + cone
  star: canvasTex((g, w, h) => { rad(g, w / 2, h / 2, w * .28, [[0, 'rgba(255,255,255,1)'], [.5, 'rgba(255,255,255,.5)'], [1, 'rgba(255,255,255,0)']]);
    for (let i = 0; i < 7; i++) { const a = i / 7 * 6.283 + .2, L = (i % 2 ? .34 : .5) * w; g.save(); g.translate(w / 2, h / 2); g.rotate(a); const gr = g.createLinearGradient(0, 0, L, 0); gr.addColorStop(0, 'rgba(255,255,255,.95)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.beginPath(); g.moveTo(0, -w * .035); g.lineTo(L, 0); g.lineTo(0, w * .035); g.fill(); g.restore(); } }),
  cone: canvasTex((g, w, h) => { const gr = g.createLinearGradient(0, 0, w, 0); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(.35, 'rgba(255,255,255,.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.beginPath(); g.moveTo(0, h * .46); g.lineTo(w, h * .08); g.lineTo(w, h * .92); g.lineTo(0, h * .54); g.closePath(); g.fill(); }, 128, 64),
  // energy: hot core bloom + thin bolt
  bloom: canvasTex((g, w, h) => { rad(g, w / 2, h / 2, w / 2, [[0, 'rgba(255,255,255,1)'], [.18, 'rgba(255,255,255,.8)'], [.45, 'rgba(255,255,255,.22)'], [1, 'rgba(255,255,255,0)']]); g.fillStyle = 'rgba(255,255,255,.55)'; g.fillRect(w * .06, h * .47, w * .88, h * .06); }),
  bolt: canvasTex((g, w, h) => { const gr = g.createLinearGradient(0, 0, w, 0); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(.5, 'rgba(255,255,255,.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.beginPath(); g.moveTo(0, h * .3); g.quadraticCurveTo(w * .5, h * .46, w, h * .5); g.quadraticCurveTo(w * .5, h * .54, 0, h * .7); g.closePath(); g.fill(); rad(g, 0, h / 2, h * .8, [[0, 'rgba(255,255,255,.7)'], [1, 'rgba(255,255,255,0)']]); }, 128, 64),
  // alien: lobed organic blob + tendril
  lobes: canvasTex((g, w, h) => { rad(g, w / 2, h / 2, w * .22, [[0, 'rgba(255,255,255,1)'], [1, 'rgba(255,255,255,0)']]);
    for (let i = 0; i < 5; i++) { const a = i / 5 * 6.283 + .5, L = w * (.3 + (i % 3) * .06), cx = w / 2 + Math.cos(a) * L * .55, cy = h / 2 + Math.sin(a) * L * .55; const gr = g.createRadialGradient(cx, cy, 0, cx, cy, w * .15); gr.addColorStop(0, 'rgba(255,255,255,.85)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, w, h); } }),
  tendril: canvasTex((g, w, h) => { const gr = g.createLinearGradient(0, 0, w, 0); gr.addColorStop(0, 'rgba(255,255,255,.95)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.strokeStyle = gr; g.lineCap = 'round';
    for (let i = 0; i < 3; i++) { g.lineWidth = h * (.16 - i * .04); g.beginPath(); g.moveTo(0, h / 2); g.bezierCurveTo(w * .3, h * (.2 + i * .3), w * .6, h * (.9 - i * .3), w, h * (.35 + i * .15)); g.stroke(); } }, 128, 64)
};
const FACE = { energy: 'bloom', ballistic: 'star', alien: 'lobes' }, SIDE = { energy: 'bolt', ballistic: 'cone', alien: 'tendril' };
const addMat = (tex, col) => new T.MeshBasicMaterial({ map: tex, color: new T.Color(col[0], col[1], col[2]), transparent: true, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide, fog: false });
const mark = o => { o.userData.noProbe = true; o.frustumCulled = false; return o; };

/* ------------------------------------------------------------------ per-gun flash shapes + vent glow */
const GUNS = {};   // id -> { cls, flashG, vent, slide, port }
const PARTRE = /(^|[|_-])(slide|chbolt|pump|pumpbar|bolt)\d*$/i;
const _m = new T.Vector3();
function attachGun(id) {
  const m = WM[id]; if (!m || !m.flash || m.__ffx) return; m.__ffx = 1;
  const w = WEAPONS[id] || {}, cls = clsOf(id), F = D.flash[cls] || D.flash.energy, sc = (D.weaponScale[id] || 1), col = wcol(w);
  const g = new T.Group(); g.name = 'ffx-flash'; mark(g);
  const face = new T.Mesh(new T.PlaneGeometry(F.size * sc, F.size * sc), addMat(TEX[FACE[cls]], col)); face.position.z = -.012; mark(face); g.add(face);
  const sg = new T.PlaneGeometry(F.len * sc, F.size * .55 * sc); sg.translate(F.len * sc / 2, 0, 0);
  for (let k = 0; k < 2; k++) { const a = new T.Group(); a.rotation.z = k * Math.PI / 2 + (cls === 'alien' ? .4 : 0); const s = new T.Mesh(sg, addMat(TEX[SIDE[cls]], col)); s.rotation.y = Math.PI / 2; s.position.z = -.02; mark(s); a.add(s); g.add(a); }
  for (const c of m.flash.children) c.visible = false;   // the game's plain planes stay, hidden
  m.flash.add(g);
  // vent glow: one soft quad at the muzzle, opacity follows sustained fire
  const vm = new T.Mesh(new T.PlaneGeometry(.2 * sc, .2 * sc), addMat(TEX.glow, cls === 'ballistic' ? [1, .45, .15] : col)); vm.position.copy(m.flash.position); vm.position.z += .06; vm.visible = false; mark(vm); vm.renderOrder = 19; m.group.add(vm);
  // slide / bolt / pump + ejection port, if the model exposes them
  let slide = null, port = null; m.group.updateWorldMatrix(true, true);
  m.group.traverse(o => { if (!slide && o !== m.group && PARTRE.test(o.name || '') && o.isObject3D && !/^gp-ring/.test(o.name)) slide = o; if (!port && /ejport|ejection/i.test(o.name || '')) port = o; });
  let rest = null, k = 1; if (slide) { rest = slide.position.clone(); _m.setFromMatrixScale(slide.parent.matrixWorld); k = 1 / Math.max(.001, Math.min(_m.x, _m.y, _m.z)) * (slide.parent === m.group ? 1 : 1); }
  GUNS[id] = { cls, flashG: g, vent: vm, slide, rest, slideK: k, port };
}
function scanGuns() { for (const id in WM) if (!GUNS[id]) { try { attachGun(id); } catch (e) { warn(e); } } }

/* ------------------------------------------------------------------ light flash on nearby surfaces (pooled additive splats) */
const SPL = []; let splIdx = 0;
function makeSplats() {
  const n = D.pools[2].splat; const g = new T.PlaneGeometry(1, 1);
  for (let i = 0; i < n; i++) { const m = new T.Mesh(g, addMat(TEX.glow, [1, 1, 1])); m.visible = false; m.renderOrder = 6; m.userData.noProbe = true; m.frustumCulled = false; scene.add(m); SPL.push({ m, life: 0, max: .08 }); }
}
const rc = new T.Raycaster(), _d = new T.Vector3(), _n = new T.Vector3(), _p = new T.Vector3();
let rayAt = 0;
function nearSurface(w, id, col, power) {
  const t = tier(); if (t < 1) return;
  const now = performance.now(); if (now - rayAt < 45) return; rayAt = now;   // dense fire: every 3rd-4th shot
  camera.getWorldDirection(_d); rc.set(camera.position, _d); rc.far = 7; FF.stats.rays++;
  const h = rc.intersectObjects(world.meshes, false)[0]; if (!h || !h.face) return;
  _n.copy(h.face.normal).transformDirection(h.object.matrixWorld);
  const s = SPL[splIdx % Math.min(SPL.length, D.pools[t].splat)]; splIdx++; if (!s) return;
  const k = Math.max(.25, 1 - h.distance / 7) * power;
  s.m.position.copy(h.point).addScaledVector(_n, .03); s.m.lookAt(h.point.x + _n.x, h.point.y + _n.y, h.point.z + _n.z);
  s.m.scale.setScalar((1 + 1.6 * k) * (id === 'pistol' ? .7 : 1)); s.m.material.color.setRGB(col[0] * k * .9, col[1] * k * .9, col[2] * k * .9); s.m.material.opacity = 1; s.life = s.max = .07; s.m.visible = true; FF.stats.splats++;
  // firing close to the floor: ground dust
  if (_n.y > .6 && h.distance < 3.4) { const ds = surfOf(h.object); dust(h.point, _n, ds, .6 + (3.4 - h.distance) * .2 + power * .2, true); }
}

/* ------------------------------------------------------------------ surface effects */
const surfCache = new WeakMap(); let rayBudget = 0;
function surfOf(o) { return (o && o.userData && o.userData.surface) || 'concrete'; }
function dust(p, n, surf, k, ground) {
  const t = tier(); if (t < 1) return;
  const S = D.surfaces[surf] || D.surfaces.concrete, c = S.dust, np = Math.max(1, Math.round(S.puff * k * (t === 2 ? 1 : .6)));
  for (let i = 0; i < np; i++) SMOKE.spawn(p, n.x * R(.4, 1.4) + R(-.5, .5), n.y * R(.4, 1.4) + R(0, .6), n.z * R(.4, 1.4) + R(-.5, .5), c[0], c[1], c[2], R(.1, .2) * (ground ? 1.3 : 1) * Math.min(1.6, k + .3), R(.45, ground ? 1.1 : .8), -.15, 2.6, 1, ground ? .38 : .45);
  FF.stats.dust += np;
  const sp = Math.round((S.sparks || 0) * Math.min(1.5, k) * (t === 2 ? 1 : .5));
  for (let i = 0; i < sp; i++) FX.spawn(p, n.x * 4 + R(-3, 3), n.y * 4 + R(0, 4), n.z * 4 + R(-3, 3), 4.5 * (c[0] + .4), 3.2 * (c[1] + .3), 2 * (c[2] + .3), R(.015, .035), R(.15, .35), 14, 1);
  for (let i = 0; i < (S.chips || 0) * Math.min(1.5, k); i++) FX.spawn(p, n.x * 3 + R(-2.5, 2.5), n.y * 3 + R(0, 3), n.z * 3 + R(-2.5, 2.5), 1.4, .9, .45, R(.018, .035), R(.25, .5), 14, .8);
}
function impact(p, n) {
  const t = tier(); if (t < 1) return;
  let surf = 'concrete';
  if (rayBudget > 0) { rayBudget--; rc.set(_p.copy(p).addScaledVector(n, .06), _d.copy(n).negate()); rc.far = .3; const h = rc.intersectObjects(world.meshes, false)[0]; if (h) { surf = surfOf(h.object); FF.__lastSurf = surf; } else surf = FF.__lastSurf || 'concrete'; }
  else surf = FF.__lastSurf || 'concrete';
  FF.stats.impacts++; dust(p, n, surf, .8, false);
}

/* ------------------------------------------------------------------ pooled ejection (instanced) */
const EJ = {};   // kind -> { im, N, idx, it: [] }
let ejSound = 0;
function makeEject() {
  const mats = {
    shell: new T.MeshStandardMaterial({ color: 0xc9a24a, metalness: 1, roughness: .28 }),
    cell: new T.MeshBasicMaterial({ color: 0xffffff }),
    pod: new T.MeshBasicMaterial({ color: 0xffffff })
  };
  const geos = { shell: new T.CylinderGeometry(.0065, .0065, .034, 8), cell: new T.BoxGeometry(.02, .013, .034), pod: new T.IcosahedronGeometry(.011, 0) };
  const N = D.pools[2].eject;
  for (const k of ['shell', 'cell', 'pod']) {
    const im = new T.InstancedMesh(geos[k], mats[k], N); im.instanceMatrix.setUsage(T.DynamicDrawUsage); im.setColorAt(0, new T.Color(1, 1, 1)); im.visible = false; mark(im); im.userData.noProbe = true; scene.add(im);
    const z = new T.Matrix4().makeScale(0, 0, 0); for (let i = 0; i < N; i++) im.setMatrixAt(i, z);
    EJ[k] = { im, N, idx: 0, alive: 0, it: Array.from({ length: N }, () => ({ life: 0, p: new T.Vector3(), v: new T.Vector3(), e: new T.Euler(), av: new T.Vector3(), b: 0 })) };
  }
}
const _o = new T.Object3D(), _q = new T.Quaternion(), _c = new T.Color();
function eject() {
  const t = tier(), id = P.weapon, g = GUNS[id], cls = g ? g.cls : clsOf(id), kind = cls === 'ballistic' ? 'shell' : cls === 'alien' ? 'pod' : 'cell', E = EJ[kind]; if (!E) return;
  const cap = Math.min(E.N, D.pools[t].eject), ii = E.idx % cap, it = E.it[ii]; E.idx++;
  const ads = P.ads || 0;
  if (g && g.port) { g.port.getWorldPosition(_p); _p.applyMatrix4(camera.matrixWorld); } else _p.set(.13 - ads * .06, -.1 + ads * .035, -.42).applyMatrix4(camera.matrixWorld);
  it.p.copy(_p); it.v.set(R(1.6, 2.6), R(1.2, 2.2), R(.2, .9)).applyQuaternion(camera.quaternion).addScaledVector(P.vel, .7); it.av.set(R(-22, 22), R(-22, 22), R(-22, 22)); it.e.set(R(0, 6), R(0, 6), R(0, 6)); it.life = D.eject.life; it.b = 0;
  const w = WEAPONS[id] || {}; const c = wcol(w); _c.setRGB(kind === 'cell' ? c[0] * 2.4 : 1.8 * c[0] + .2, kind === 'cell' ? c[1] * 2.4 : 2.1 * c[1] + .2, kind === 'cell' ? c[2] * 2.4 : 1.6 * c[2] + .2); if (kind === 'pod') _c.setRGB(.5, 2.6, .9);
  if (kind !== 'shell') E.im.setColorAt(ii, _c);
  if (E.im.instanceColor) E.im.instanceColor.needsUpdate = true;
  E.im.visible = true; FF.stats.ejected++;
}
function updEject(dt) {
  const gv = D.eject.gravity, rest = D.eject.restitution, gapOK = performance.now() - ejSound > D.eject.soundGapMs;
  for (const k in EJ) {
    const E = EJ[k]; if (!E.im.visible) continue; let any = false;
    for (let i = 0; i < E.N; i++) {
      const it = E.it[i]; if (it.life <= 0) continue;
      it.life -= dt; if (it.life <= 0) { E.im.setMatrixAt(i, ZERO); continue; }
      any = true; it.v.y -= gv * dt; it.p.addScaledVector(it.v, dt); it.e.x += it.av.x * dt; it.e.y += it.av.y * dt; it.e.z += it.av.z * dt;
      const gy = groundAt(it.p.x, it.p.z, it.p.y, .02) + .012;
      if (it.p.y < gy) { it.p.y = gy; if (it.v.y < -.5 && it.b < D.eject.bounces) { it.b++; FF.stats.bounces++; if (it.b === 1 && FF.sound && gapOK && P.weapon) { ejSound = performance.now(); try { FF.onBounce(k, it.p); } catch (e) {} } } it.v.y *= -rest; it.v.x *= .55; it.v.z *= .55; it.av.multiplyScalar(.55); if (Math.abs(it.v.y) < .3) it.v.y = 0; }
      _o.position.copy(it.p); _o.rotation.copy(it.e); const s = it.life < .3 ? it.life / .3 : 1; _o.scale.setScalar(s); _o.updateMatrix(); E.im.setMatrixAt(i, _o.matrix);
    }
    E.im.instanceMatrix.needsUpdate = true; if (!any) E.im.visible = false;
  }
}
const ZERO = new T.Matrix4().makeScale(0, 0, 0);
FF.onBounce = (kind, pos) => { if (kind === 'shell' && typeof sfx !== 'undefined' && sfx.impact) sfx.impact(pos, true); };

/* ------------------------------------------------------------------ per-frame */
let lastFired = -1, heat = 0, wispT = 0, afterT = 0, ventV = 0, shimT = 0;
const _mz = new T.Vector3();
function onShot(id) {
  FF.stats.shots++; const w = WEAPONS[id] || {}, g = GUNS[id], t = tier(), sc = D.weaponScale[id] || 1, col = wcol(w);
  if (g && g.slide) g.slideV = 1;
  nearSurface(w, id, col, Math.min(1.4, sc));
  heat += D.wisp.heatPerShot * (sc > 1.2 ? 2 : 1); afterT = 1.6;
}
function update(dt) {
  const t = tier(), W0 = WEAPONS[P.weapon];
  const fired = G.fired | 0;
  if (lastFired < 0 || fired < lastFired) lastFired = fired;
  if (fired !== lastFired) { const n = fired - lastFired; lastFired = fired; if (P.weapon !== 'knife' && W0) onShot(P.weapon); }
  rayBudget = 2;
  heat = Math.max(0, heat - D.wisp.heatDecay * dt);
  const g = GUNS[P.weapon];
  // slide / bolt
  for (const id in GUNS) { const q = GUNS[id]; if (q.slide && q.slideV > 0) { q.slideV = Math.max(0, q.slideV - dt * D.slide.decay * .2); q.slide.position.z = q.rest.z + D.slide.travel * q.slideK * q.slideV; if (q.slideV === 0) q.slide.position.copy(q.rest); } }
  if (t >= 1 && g) {
    camera.getWorldDirection(_d);
    // smoke wisps after bursts
    afterT -= dt;
    if (afterT > 0 && heat >= D.wisp.startAt - 1) { wispT -= dt; const rate = D.wisp.rate[t] || 0; while (wispT <= 0 && rate > 0) { wispT += 1 / rate; _mz.set(.13 * (1 - P.ads), -.12 * (1 - P.ads), -.75).applyMatrix4(camera.matrixWorld);
      const c = g.cls === 'ballistic' ? [.46, .45, .44] : g.cls === 'alien' ? [.3, .5, .34] : [.4, .5, .58];
      SMOKE.spawn(_mz, R(-.15, .15) + _d.x * .5, R(.35, .8), R(-.15, .15) + _d.z * .5, c[0], c[1], c[2], R(D.wisp.size[0], D.wisp.size[1]), R(D.wisp.life[0], D.wisp.life[1]), -.18, 1.6, .5, .28); FF.stats.wisps++; } }
    // vent glow + heat shimmer on sustained fire
    const target = clampN((heat - D.vent.startAt) / (D.vent.full - D.vent.startAt), 0, 1); ventV += (target - ventV) * Math.min(1, dt * (target > ventV ? 8 : 1.6));
    if (g.vent) { g.vent.visible = ventV > .02 && P.weapon !== 'knife'; if (g.vent.visible) { const f = ventV * (.85 + .15 * Math.sin(performance.now() * .03)); g.vent.material.opacity = f * .8; g.vent.scale.setScalar(.8 + ventV * .6); } }
    if (t === 2 && ventV > .3) { shimT -= dt; if (shimT <= 0) { shimT = .09; _mz.set(.13 * (1 - P.ads), -.08 * (1 - P.ads), -.55).applyMatrix4(camera.matrixWorld); SMOKE.spawn(_mz, R(-.05, .05), R(.5, .9), R(-.05, .05), .6, .62, .66, R(.12, .2), R(.5, .8), -.1, 1.2, 1, .05 + ventV * .05); } }
  }
  for (const s of SPL) { if (s.life <= 0) continue; s.life -= dt; if (s.life <= 0) { s.m.visible = false; continue; } s.m.material.opacity = s.life / s.max; }
  updEject(dt);
}
const clampN = (x, a, b) => x < a ? a : x > b ? b : x;

/* ------------------------------------------------------------------ hooks */
const wrap = (name, make) => { try { const orig = (0, eval)(name); if (typeof orig !== 'function') return false; const fn = make(orig);
  const w = function () { return FF.enabled === false ? orig.apply(this, arguments) : fn.apply(this, arguments); }; w.__ffx = 1;
  (0, eval)(`(f) => { ${name} = f; }`)(w); return true; } catch (e) { warn(e); return false; } };
wrap('updateViewmodel', orig => function (dt) {
  const r = orig.apply(this, arguments); const t0 = performance.now();
  try { if (G.time !== FF.__gt || true) update(dt); } catch (e) { warn(e); }
  const ms = performance.now() - t0, p = FF.perf; p.n++; p.ms += ms; if (ms > p.max) p.max = ms; p.win.push(ms); if (p.win.length > 600) p.win.shift();
  return r;
});
wrap('ejectCasing', orig => function () { try { eject(); } catch (e) { warn(e); return orig.apply(this, arguments); } });
wrap('decal', orig => function (p, n, s, kind) { const r = orig.apply(this, arguments); try { if (kind === 'hole' && p && n) impact(p, n); } catch (e) { warn(e); } return r; });

/* ------------------------------------------------------------------ precompile (load + warmShaders) */
function withVisible(fn) {
  const saved = []; const set = (o, v) => { saved.push([o, o.visible]); o.visible = v; };
  for (const id in GUNS) { const q = GUNS[id]; set(q.flashG.parent, true); set(q.flashG, true); q.flashG.traverse(o => { if (o !== q.flashG) set(o, true); }); set(q.vent, true); }
  for (const k in WM) set(WM[k].group, true);
  for (const k in EJ) set(EJ[k].im, true); for (const s of SPL) set(s.m, true);
  try { return fn(); } finally { for (const [o, v] of saved) o.visible = v; }
}
function precompile() {
  try { const prev = renderer.getRenderTarget(); renderer.setRenderTarget(rt); withVisible(() => { renderer.compile(scene, camera); renderer.compile(gunScene, gunCam); }); renderer.setRenderTarget(prev); FF.programsAtReady = renderer.info.programs.length; } catch (e) { warn(e); try { renderer.setRenderTarget(null); } catch (e2) {} }
}
wrap('warmShaders', orig => function () { scanGuns(); let r; withVisible(() => { r = orig.apply(this, arguments); }); return r; });

/* ------------------------------------------------------------------ status / test hooks */
FF.status = () => ({ ready: FF.ready, data: FF.data, tier: tier(), guns: Object.keys(GUNS).map(k => k + ':' + GUNS[k].cls + (GUNS[k].slide ? '+slide' : '')), pool: { eject: Object.fromEntries(Object.entries(EJ).map(([k, e]) => [k, e.N])), splat: SPL.length }, stats: Object.assign({}, FF.stats), perf: { n: FF.perf.n, avgMs: FF.perf.n ? FF.perf.ms / FF.perf.n : 0, maxMs: FF.perf.max }, programs: renderer.info.programs.length, programsAtReady: FF.programsAtReady, errors: FF.errors });
FF.state = () => ({ heat, ventV, afterT, ejecting: Object.fromEntries(Object.entries(EJ).map(([k, e]) => [k, e.it.filter(i => i.life > 0).length])), splats: SPL.filter(s => s.life > 0).length });
FF.p95 = () => { const a = FF.perf.win.slice().sort((x, y) => x - y); return a.length ? a[Math.floor(a.length * .95)] : 0; };
try { makeSplats(); makeEject(); scanGuns(); precompile(); FF.ready = true; } catch (e) { warn(e); }
})();
