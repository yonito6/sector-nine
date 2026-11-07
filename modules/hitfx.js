/* Sector Nine add-on: HIT REACTIONS + IMPACT EFFECTS (modules/hitfx.js)  -> window.S9HitFX
   What it adds (the way CS2 / Valorant / Apex / CoD sell a hit):
   - Impact burst on every body hit, by what the body is made of: dark stylized blood mist + spray (humans), teal glowing goo
     (Xeno), spores (Mushroom Man), sparks + oil (Robot Butler), bone chips + ghost wisps (Skeleton), neon shards (Glitch).
     Bigger burst on a headshot, a finishing burst on a kill. Settings > Gameplay > "Low violence" = armour sparks only, no marks.
   - Small splats on the wall behind the target and the floor under it (own pooled, multiplicative decal mesh; fades out).
   - Hit-react animation: additive bone offsets on the skinned rig per hit location (head snaps back, torso twists toward the
     side that was hit, legs buckle, arm jerks), a stronger stagger for sniper / shotgun / Flytrap / explosive hits, and a
     direction-aware death (the body turns to fall AWAY from the shot, with a backwards knock for heavy guns).
   - A positional impact sound at the victim.
   - Everything also plays in the KILLCAM replay (on you and on everyone else) and for online players: reactions are driven
     only by hits each client already receives (no new network fields, nothing the server has to trust).
   Cost rules: every particle comes from the game's existing pooled particle systems (FX / SMOKE: no new draw call, no new
   shader); the splat mesh is one pre-compiled instanced mesh that is hidden (0 draw calls) while no splat is alive.
   Performance tier: only the same small burst the game always drew (recoloured), no mist, no splats.
   Bone offsets are put back right after each frame is drawn, so hit boxes (and therefore hit detection) never move.
   Loads after index.html (any order; best before killcam.js). Numbers + colours: data/hitfx.json (fallback built in). */
(() => {
'use strict';
if (window.S9HitFX) return;
if (typeof THREE === 'undefined' || typeof damageBot !== 'function' || typeof animateBot !== 'function') { console.warn('[hitfx] game globals not found, idle'); return; }
const T = THREE;
const HX = window.S9HitFX = { ver: 1, ready: false, errors: 0, data: 'builtin', stats: { hits: 0, heads: 0, kills: 0, netHits: 0, replayFx: 0, splats: 0, particles: 0, suppressed: 0, reacts: 0 }, perf: { n: 0, ms: 0, max: 0 } };
const warn = e => { HX.errors++; if (HX.errors < 6) console.warn('[hitfx]', e); };

/* =============================================================================== data */
// built-in fallback = a trimmed copy of data/hitfx.json (the file wins once loaded)
const L3 = (pool, n, col, size, life, speed, spread, up, grav, drag, grow, alpha, back) => ({ pool, n, col, size, life, speed, spread, up, grav, drag, grow, alpha, back });
let D = {
  tiers: { performance: 'low', balanced: 'mid', high: 'high', ultra: 'high' }, lowViolence: 'sparks',
  skins: { default: 'flesh', butler: 'metal', mushroom: 'spore', skeleton: 'bone', glitch: 'glitch', xeno: 'goo' },
  materials: {
    flesh: { sound: 'flesh', decal: { tint: [.22, .05, .05], strength: .85 },   // dark maroon, particulate, gone in ~0.3 s (mirror of data/hitfx.json)
      hit: [L3('smoke', [0, 2, 3], [.16, .028, .03], [.07, .11], [.12, .18], [.3, .8], .5, .1, .3, 6, .25, .45, true), L3('smoke', [0, 3, 4], [.12, .03, .032], [.1, .17], [.18, .28], [.5, 1.3], .75, .2, .4, 5, .45, .42, true),
        L3('smoke', [7, 8, 11], [.09, .016, .018], [.018, .034], [.2, .3], [2.2, 4.6], .4, .5, 9.5, .8, 0, 1), L3('smoke', [0, 3, 5], [.09, .016, .018], [.016, .03], [.16, .26], [1.6, 3.4], .55, .4, 9.5, .9, 0, 1, true)],
      head: [L3('smoke', [0, 3, 4], [.16, .028, .03], [.09, .14], [.12, .18], [.3, .8], .5, .1, .3, 6, .25, .45, true), L3('smoke', [0, 4, 5], [.12, .03, .032], [.13, .22], [.18, .28], [.5, 1.3], .75, .2, .4, 5, .45, .42, true),
        L3('smoke', [7, 10, 14], [.09, .016, .018], [.018, .034], [.2, .3], [2.2, 4.6], .4, .5, 9.5, .8, 0, 1), L3('smoke', [0, 4, 6], [.09, .016, .018], [.016, .03], [.16, .26], [1.6, 3.4], .55, .4, 9.5, .9, 0, 1, true)],
      kill: [L3('smoke', [0, 3, 5], [.16, .028, .03], [.11, .17], [.12, .18], [.3, .8], .5, .1, .3, 6, .25, .45, true), L3('smoke', [0, 5, 6], [.12, .03, .032], [.15, .26], [.18, .28], [.5, 1.3], .75, .2, .4, 5, .45, .42, true),
        L3('smoke', [7, 12, 17], [.09, .016, .018], [.018, .034], [.2, .3], [2.2, 4.6], .4, .5, 9.5, .8, 0, 1), L3('smoke', [0, 5, 8], [.09, .016, .018], [.016, .03], [.16, .26], [1.6, 3.4], .55, .4, 9.5, .9, 0, 1, true)] },
    sparks: { sound: 'metal', decal: null,
      hit: [L3('fx', [7, 8, 10], [7, 4.2, 1.6], [.025, .05], [.15, .35], [2.5, 5.5], .75, .6, 12, 1, 0, 1)],
      head: [L3('fx', [12, 14, 18], [7.5, 4.6, 1.8], [.03, .055], [.2, .4], [3, 7], .85, .8, 12, 1, 0, 1)],
      kill: [L3('fx', [20, 24, 30], [7, 3.6, 1.2], [.03, .07], [.3, .8], [2, 7], 1, .7, 10, 1.5, 0, 1)] }
  },
  weapons: { default: { knock: 1 }, knife: { knock: 2, heavy: true }, sniper: { knock: 2.2, heavy: true }, breacher: { knock: 1.8, heavy: true }, judge: { knock: 1.7, heavy: true }, poopgun: { knock: 1.6, heavy: true }, flytrap: { knock: 2.4, heavy: true }, nade: { knock: 2.2, heavy: true }, nova: { knock: 2.2, heavy: true }, seeker: { knock: 2.2, heavy: true } },
  noBlood: { weapons: ['ftpoison', 'lava', 'acid', 'laser'], minDamage: 5 },
  react: { rise: .045, head: { neck: .22, head: .38, spine: .06, tau: .16, dur: .55 }, body: { pitch: .2, twist: .34, tau: .15, dur: .5 }, low: { pitch: -.16, knee: .55, hip: .25, drop: .07, tau: .17, dur: .55 },
    arm: { arm: .7, twist: .18, tau: .13, dur: .45 }, heavy: { stagger: .11, tau: .22, dur: .7 }, maxStrength: 2.6 },
  death: { turn: .2, jitter: .35, knockPitch: .32, knockRise: .09, knockTau: .35, slide: 1.35, kinds: ['spin', 'head', 'riddled'] },
  decals: { pool: { low: 0, mid: 28, high: 56 }, life: 24, fade: 5, wallRange: 2.4, wallChance: .75, floorChance: .55, size: { hit: [.22, .38], head: [.32, .52], kill: [.42, .7] } },
  sound: { volVictim: .55, volMine: .3, ref: 3, roll: 1.3 }
};
HX.D = () => D;
function applyData(j) {
  if (!j || typeof j !== 'object' || !j.materials) return;
  const out = Object.assign({}, D, j);
  for (const k of ['react', 'death', 'decals', 'sound', 'noBlood']) out[k] = Object.assign({}, D[k], j[k] || {});
  out.materials = Object.assign({}, D.materials, j.materials); out.skins = Object.assign({}, D.skins, j.skins || {}); out.weapons = Object.assign({}, D.weapons, j.weapons || {});
  D = out; HX.data = 'json'; if (DEC) sizeDecals();
}
try { fetch('data/hitfx.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : null).then(applyData).catch(() => {}); } catch (e) {}

/* =============================================================================== settings */
const LS = 'sector9-hitfx';
let lowV = false, lowVAt = 0;
function lowViolence() {   // Settings > Gameplay > Low violence (settings.js); without it: localStorage 'sector9-hitfx' {lowViolence}
  const now = performance.now(); if (now - lowVAt < 750) return lowV; lowVAt = now;
  try { const S = window.S9Settings; if (S && typeof S.set === 'function' && !S.set.__hx) { const so = S.set; const w = function () { lowVAt = 0; try { return so.apply(this, arguments); } finally { lowVAt = 0; } }; w.__hx = 1; S.set = w; }   // a change through the settings API is seen at once, not after the 0.75 s cache
    if (S && typeof S.get === 'function') { const g = S.get().gameplay; if (g && typeof g.lowViolence === 'boolean') return (lowV = g.lowViolence); } } catch (e) {}
  try { const o = JSON.parse(localStorage.getItem(LS) || 'null'); lowV = !!(o && o.lowViolence); } catch (e) { lowV = false; }
  return lowV;
}
HX.setLowViolence = on => { try { const S = window.S9Settings; if (S && typeof S.set === 'function' && S.get().gameplay && 'lowViolence' in S.get().gameplay) S.set('gameplay.lowViolence', !!on); else localStorage.setItem(LS, JSON.stringify({ lowViolence: !!on })); } catch (e) {} lowVAt = 0; return lowViolence(); };
const TI = { low: 0, mid: 1, high: 2 };
const tierName = () => D.tiers[(typeof CFG !== 'undefined' && CFG.q) || 'balanced'] || 'mid';
const tier = () => TI[tierName()] ?? 1;
HX.tier = tierName;

/* =============================================================================== what a body is made of */
function skinOfEnt(e) {
  try {
    if (!e) return 'std';
    if (e === PLAYER_ENT || e.isPlayer) { const SK = window.S9Skins; return (SK && SK.look && SK.look.skin) || 'std'; }
    if (e.kcGhost && e.kcEnt) { if (e.s9look && e.s9look.skin) return e.s9look.skin; return skinOfEnt(e.kcEnt); }
    return (e.s9look && e.s9look.skin) || 'std';
  } catch (er) { return 'std'; }
}
function matOf(e) { if (lowViolence()) return D.lowViolence || 'sparks'; const k = D.skins[skinOfEnt(e)] || D.skins.default || 'flesh'; return D.materials[k] ? k : 'flesh'; }
HX.matOf = matOf;
const wcfg = w => (D.weapons && (D.weapons[w] || D.weapons.default)) || { knock: 1 };

/* =============================================================================== particles (the game's own pools) */
const _p = new T.Vector3(), _d = new T.Vector3(), _r = new T.Vector3(), _q = new T.Vector3(), UP = new T.Vector3(0, 1, 0);
const rnd = (a, b) => a + Math.random() * (b - a);
function randUnit(out) { const z = rnd(-1, 1), a = rnd(0, 6.2832), s = Math.sqrt(1 - z * z); return out.set(Math.cos(a) * s, z, Math.sin(a) * s); }
// kind: hit | head | kill. dir = direction the shot travelled (spray leaves out the far side, mist hangs at the entry)
function emit(matKey, kind, point, dir, scale = 1) {
  if (typeof FX === 'undefined' || !FX || typeof SMOKE === 'undefined' || !SMOKE) return 0;
  const M = D.materials[matKey] || D.materials.flesh, layers = M[kind] || M.hit; if (!layers) return 0;
  const ti = tier(); let n0 = 0;
  for (const L of layers) {
    const pool = L.pool === 'fx' ? FX : SMOKE, n = Math.round((L.n[ti] || 0) * scale); if (!n) continue;
    const spawn = quiet > 0 ? (L.pool === 'fx' ? realFX : realSM) : pool.spawn;
    for (let i = 0; i < n; i++) {
      _d.copy(dir); if (L.back) _d.negate(); randUnit(_r); _d.multiplyScalar(1 - L.spread).addScaledVector(_r, L.spread); if (_d.lengthSq() < 1e-6) _d.copy(_r); _d.normalize();
      const sp = rnd(L.speed[0], L.speed[1]); _d.multiplyScalar(sp); _d.y += L.up * sp * Math.random();
      _p.set(point.x + rnd(-.035, .035), point.y + rnd(-.035, .035), point.z + rnd(-.035, .035));
      const k = rnd(.82, 1.15);
      spawn.call(pool, _p, _d.x, _d.y, _d.z, L.col[0] * k, L.col[1] * k, L.col[2] * k, rnd(L.size[0], L.size[1]), rnd(L.life[0], L.life[1]), L.grav, L.drag, L.grow, L.alpha);
    }
    n0 += n;
  }
  HX.stats.particles += n0; return n0;
}
HX.emit = emit;

/* =============================================================================== splat decals (own pool, multiplicative, hidden when empty) */
let DEC = null;
function splatAtlas() {   // 4 tiles of 128 px: irregular blots with droplets and a streak; white-ish mask, tinted per instance
  const c = canvasOf(256), g = c.getContext('2d');
  let seed = 7; const R = (a, b) => { seed = (seed * 16807) % 2147483647; return a + (seed / 2147483647) * (b - a); };
  for (let t = 0; t < 4; t++) {
    g.save(); g.translate((t % 2) * 128 + 64, Math.floor(t / 2) * 128 + 64);
    const blob = (x, y, r, a) => { const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, `rgba(255,255,255,${a})`); gr.addColorStop(.62, `rgba(255,255,255,${a * .92})`); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill(); };
    for (let i = 0; i < 7; i++) blob(R(-14, 14), R(-14, 14), R(12, 24), R(.55, .85));
    const n = 8 + (t * 3); for (let i = 0; i < n; i++) { const a = R(0, 6.28), d = R(26, 54); blob(Math.cos(a) * d, Math.sin(a) * d, R(2, 6), R(.6, .9)); }
    if (t !== 1) { const a = R(0, 6.28); for (let k = 0; k < 14; k++) blob(Math.cos(a) * (20 + k * 2.6), Math.sin(a) * (20 + k * 2.6), Math.max(1.2, 6 - k * .35), .8); }
    g.restore();
  }
  const tx = new T.CanvasTexture(c); tx.encoding = T.LinearEncoding; tx.generateMipmaps = true; tx.minFilter = T.LinearMipmapLinearFilter; tx.anisotropy = 4; return tx;
}
function initDecals() {
  if (DEC || typeof scene === 'undefined' || !scene) return;
  const N = 64, g = new T.PlaneGeometry(1, 1);
  const born = new T.InstancedBufferAttribute(new Float32Array(N).fill(-1e5), 1), tint = new T.InstancedBufferAttribute(new Float32Array(N * 4), 4), tile = new T.InstancedBufferAttribute(new Float32Array(N), 1);
  g.setAttribute('aBorn', born); g.setAttribute('aTint', tint); g.setAttribute('aTile', tile);
  const mat = new T.ShaderMaterial({
    uniforms: T.UniformsUtils.merge([T.UniformsLib.fog, { tA: { value: splatAtlas() }, uNow: { value: 0 }, uLife: { value: 24 }, uFade: { value: 5 } }]),
    vertexShader: `#include <common>
#include <fog_pars_vertex>
attribute float aBorn; attribute vec4 aTint; attribute float aTile; uniform float uNow, uLife, uFade; varying vec2 vUv; varying float vA; varying vec3 vTint;
void main(){
  vUv = vec2((mod(aTile, 2.0) + uv.x) * .5, (floor(aTile * .5) + uv.y) * .5);
  float age = uNow - aBorn; vA = aTint.a * (1.0 - smoothstep(uLife - uFade, uLife, age)) * smoothstep(0.0, .06, age); vTint = aTint.rgb;
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`,
    fragmentShader: `#include <common>
#include <fog_pars_fragment>
uniform sampler2D tA; varying vec2 vUv; varying float vA; varying vec3 vTint;
void main(){
  float a = texture2D(tA, vUv).r * vA;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fd = fogDensity * vFogDepth; a *= exp(-fd * fd);
    #else
      a *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
    #endif
  #endif
  if (a < .004) discard;
  // multiplicative: surface * (1 - a + a * tint * 2): darkens + tints any surface, never glows
  gl_FragColor = vec4(vTint * 2.0 * a, a);
}`,
    transparent: true, depthWrite: false, fog: true, blending: T.CustomBlending, blendEquation: T.AddEquation, blendSrc: T.DstColorFactor, blendDst: T.OneMinusSrcAlphaFactor,
    polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6
  });
  const im = new T.InstancedMesh(g, mat, N); im.name = 'hitfx_splats'; im.frustumCulled = false; im.renderOrder = 1; im.visible = false;
  const z = new T.Matrix4().makeScale(0, 0, 0); for (let i = 0; i < N; i++) im.setMatrixAt(i, z);
  scene.add(im);
  DEC = { im, mat, N, pool: 0, idx: 0, born, tint, tile, lastBorn: -1e5, z };
  sizeDecals(); warmDecals();
}
function sizeDecals() { if (!DEC) return; const P0 = D.decals.pool || {}; DEC.pool = Math.min(DEC.N, P0[tierName()] || 0); DEC.mat.uniforms.uLife.value = D.decals.life || 24; DEC.mat.uniforms.uFade.value = D.decals.fade || 5; }
const _o = new T.Object3D(), _n = new T.Vector3();
function placeSplat(p, n, size, tint, strength) {
  if (!DEC) return; sizeDecals(); if (!DEC.pool) return;
  const i = DEC.idx % DEC.pool; DEC.idx = (DEC.idx + 1) % DEC.pool;
  _o.position.set(p.x + n.x * .008, p.y + n.y * .008, p.z + n.z * .008); _o.lookAt(p.x + n.x, p.y + n.y, p.z + n.z); _o.rotateZ(rnd(0, 6.2832)); _o.scale.setScalar(size); _o.updateMatrix();
  DEC.im.setMatrixAt(i, _o.matrix); DEC.im.instanceMatrix.needsUpdate = true;
  const now = G.time; DEC.born.array[i] = now; DEC.tile.array[i] = (Math.random() * 4) | 0; DEC.tint.array.set([tint[0], tint[1], tint[2], strength], i * 4);
  DEC.born.needsUpdate = DEC.tile.needsUpdate = DEC.tint.needsUpdate = true; DEC.lastBorn = now; DEC.im.visible = true; HX.stats.splats++;
}
function tickDecals() {
  if (!DEC) return; const now = G.time; DEC.mat.uniforms.uNow.value = now;
  if (DEC.im.visible && (now - DEC.lastBorn > (D.decals.life || 24) + .5 || now < DEC.lastBorn - 1)) DEC.im.visible = false;   // nothing alive: 0 draw calls
}
function clearSplats() { if (!DEC) return; DEC.born.array.fill(-1e5); DEC.born.needsUpdate = true; for (let i = 0; i < DEC.N; i++) DEC.im.setMatrixAt(i, DEC.z); DEC.im.instanceMatrix.needsUpdate = true; DEC.idx = 0; DEC.lastBorn = -1e5; DEC.im.visible = false; }
function warmDecals() {   // compile the splat program once into the game's real render target (never mid-match)
  try { if (!DEC || typeof renderer === 'undefined') return; const tmp = new T.Scene(); tmp.fog = scene.fog; const was = DEC.im.visible; scene.remove(DEC.im); tmp.add(DEC.im); DEC.im.visible = true;
    const prev = renderer.getRenderTarget(); if (typeof rt !== 'undefined' && rt) renderer.setRenderTarget(rt); renderer.compile(tmp, camera); renderer.setRenderTarget(prev);
    tmp.remove(DEC.im); scene.add(DEC.im); DEC.im.visible = was; HX.warmed = (HX.warmed || 0) + 1; } catch (e) { warn(e); }
}
// first collider box face along a ray (the game's own movement boxes: a few microseconds, no triangles, no tree building)
const _ray = new T.Ray(), _hp = new T.Vector3(), _hit = { p: new T.Vector3(), n: new T.Vector3(), d: 0 };
function wallHit(o, d, far) {
  const C = typeof world !== 'undefined' && world.colliders; if (!C || !C.length) return null;
  _ray.set(o, d); let best = far, bb = null;
  for (const b of C) { if (b.containsPoint(o)) continue; if (!_ray.intersectBox(b, _hp)) continue; const dd = _hp.distanceTo(o); if (dd < best) { best = dd; bb = b; _hit.p.copy(_hp); } }
  if (!bb) return null; const p = _hit.p, e = 1e-3; _hit.n.set(0, 0, 0);
  if (Math.abs(p.x - bb.min.x) < e) _hit.n.x = -1; else if (Math.abs(p.x - bb.max.x) < e) _hit.n.x = 1; else if (Math.abs(p.z - bb.min.z) < e) _hit.n.z = -1; else if (Math.abs(p.z - bb.max.z) < e) _hit.n.z = 1; else if (Math.abs(p.y - bb.max.y) < e) _hit.n.y = 1; else _hit.n.y = -1;
  _hit.d = best; return _hit;
}
// where a splat goes: the wall behind the target (along the shot), and the floor under the hit
function splats(kind, matKey, point, dir, footY) {
  if (DEC) sizeDecals(); const M = D.materials[matKey]; if (!M || !M.decal || !DEC || !DEC.pool || typeof world === 'undefined' || !world.meshes) return;
  const sz = D.decals.size[kind] || D.decals.size.hit, tint = M.decal.tint, st = M.decal.strength;
  if (Math.random() < (kind === 'hit' ? D.decals.wallChance : 1)) {
    _d.set(dir.x, dir.y * .5, dir.z).normalize(); const h = wallHit(point, _d, D.decals.wallRange);
    if (h) placeSplat(h.p, h.n, rnd(sz[0], sz[1]) * (1 - h.d / (D.decals.wallRange * 2.2)), tint, st);
  }
  if (Math.random() < (kind === 'hit' ? D.decals.floorChance : 1)) {
    const fx = point.x + dir.x * rnd(.15, .7), fz = point.z + dir.z * rnd(.15, .7), gy = groundAt(fx, fz, (footY ?? point.y - 1) + .5, .05);
    if (Number.isFinite(gy) && Math.abs(gy - (footY ?? gy)) < 1.2) placeSplat(_q.set(fx, gy, fz), UP, rnd(sz[0], sz[1]) * (kind === 'hit' ? .8 : 1.1), tint, st);
  }
}

/* =============================================================================== impact sounds at the victim (pre-rendered once) */
const SND = {};
// built once, one sound per idle slot (never on the hit path: a first hit must not pay ~10-40 ms of synthesis)
function buildSounds() {
  if (SND.ready || SND.building || typeof AU === 'undefined' || !AU.ctx) return; SND.building = true;
  const jobs = [];
  const c = AU.ctx, sr = c.sampleRate;
  const make = (dur, fn) => { const n = Math.floor(sr * dur), b = c.createBuffer(1, n, sr), d = b.getChannelData(0); fn(d, sr, n); let m = 0; for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(d[i])); if (m > 0) for (let i = 0; i < n; i++) d[i] *= .9 / m; return b; };
  // flesh: dull low thump + a short wet slap of filtered noise
  jobs.push(() => SND.flesh = make(.22, (d, sr, n) => { let ph = 0, lp = 0; for (let i = 0; i < n; i++) { const t = i / sr, f = 70 + 120 * Math.exp(-t / .02); ph += 6.2832 * f / sr; const e = Math.exp(-t / .05) * Math.min(1, t / .001); const nz = Math.random() * 2 - 1; lp += .28 * (nz - lp); d[i] = Math.tanh(Math.sin(ph) * 2.2) * e * .9 + lp * Math.exp(-t / .028) * 1.4; } }));
  jobs.push(() => SND.head = make(.3, (d, sr, n) => { let ph = 0, lp = 0, bp = 0; for (let i = 0; i < n; i++) { const t = i / sr, f = 90 + 220 * Math.exp(-t / .015); ph += 6.2832 * f / sr; const nz = Math.random() * 2 - 1; lp += .4 * (nz - lp); bp += .7 * (nz - bp); d[i] = Math.tanh(Math.sin(ph) * 2.6) * Math.exp(-t / .07) + (nz - bp) * Math.exp(-t / .006) * .8 + lp * Math.exp(-t / .04) * 1.2; } }));
  jobs.push(() => SND.goo = make(.28, (d, sr, n) => { let lp = 0, ph = 0; for (let i = 0; i < n; i++) { const t = i / sr, nz = Math.random() * 2 - 1, k = .05 + .2 * Math.exp(-t / .05); lp += k * (nz - lp); ph += 6.2832 * (180 + 90 * Math.sin(t * 60)) / sr; d[i] = lp * 2.2 * Math.exp(-t / .07) + Math.sin(ph) * .3 * Math.exp(-t / .05); } }));
  jobs.push(() => SND.metal = make(.3, (d, sr, n) => { const fs = [1130, 1870, 2650, 3410]; for (let i = 0; i < n; i++) { const t = i / sr; let v = 0; for (let k = 0; k < fs.length; k++) v += Math.sin(6.2832 * fs[k] * t + k) * Math.exp(-t / (.06 + k * .015)) / (k + 1); d[i] = v + (Math.random() * 2 - 1) * Math.exp(-t / .004) * .7; } }));
  jobs.push(() => SND.bone = make(.18, (d, sr, n) => { let bp = 0; for (let i = 0; i < n; i++) { const t = i / sr, nz = Math.random() * 2 - 1; bp += .55 * (nz - bp); d[i] = (nz - bp) * Math.exp(-t / .012) + Math.sin(6.2832 * 620 * t) * Math.exp(-t / .03) * .5 + (Math.random() < .002 ? .8 : 0) * Math.exp(-t / .08); } }));
  const idle = window.requestIdleCallback || (f => setTimeout(f, 30));
  const next = () => { const f = jobs.shift(); if (!f) { SND.ready = true; SND.building = false; return; } try { f(); } catch (e) { warn(e); } idle(next); }; idle(next);
}
function impactSound(key, pos, mine) {
  try {
    if (typeof AU === 'undefined' || !AU.ctx) return; if (!SND.ready) { buildSounds(); return; } const buf = SND[key] || SND.flesh; if (!buf) return;
    const kc = window.S9KC, inKc = !!(kc && kc.inReplay && kc.audio && kc.audio.dry);
    if (!inKc && typeof voice === 'function' && !voice('impact', pos)) return;
    const S = D.sound, vol = (mine ? S.volMine : S.volVictim) * (inKc ? .9 : 1);
    const c = AU.ctx, src = c.createBufferSource(); src.buffer = buf; src.playbackRate.value = rnd(.92, 1.08);
    if (inKc) { const g = c.createGain(); g.gain.value = vol; const p = c.createPanner(); p.distanceModel = 'inverse'; p.refDistance = S.ref; p.rolloffFactor = S.roll; if (p.positionX) { p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z; } src.connect(g); g.connect(p); p.connect(kc.audio.dry); }
    else { const g = bus({ pos, vol, ref: S.ref, roll: S.roll }); src.connect(g); }
    src.start();
  } catch (e) { warn(e); }
}

/* =============================================================================== reactions: events + additive bone offsets */
// one log of every hit/kill (live), kept ~9 s: entities read their own recent ones; the killcam replays them on its actors
const LOG = []; HX.log = LOG;
const HIST = 9;
// "the same frame" = the renderer's frame counter (game time stands still while paused, so it can't tell frames apart)
const frameNo = () => { try { return renderer.info.render.frame; } catch (e) { return G.time; } };
function evList(e) { const h = e.__hfx || (e.__hfx = { ev: [], saved: null, bones: null }); return h; }
function trimLog() { const t0 = G.time - HIST; while (LOG.length && (LOG[0].t < t0 || LOG[0].t > G.time + 1)) LOG.shift(); if (LOG.length > 400) LOG.splice(0, LOG.length - 400); }
function feetOf(e) { return e === PLAYER_ENT || e.isPlayer ? P.pos : e.root.position; }
function yawOf(e) { return e === PLAYER_ENT || e.isPlayer ? P.yaw + Math.PI : (e.root ? e.root.rotation.y : 0); }
// zone: head | body | low (legs) | arm
function zoneOf(e, zone, point) {
  if (zone === 'head') return 'head';
  if (zone === 'limb' && point) { const f = feetOf(e); return point.y - f.y < .95 ? 'low' : 'arm'; }
  return 'body';
}
function record(e, o) {
  const t = G.time, h = evList(e), w = wcfg(o.weapon), R0 = D.react;
  let str = clamp((w.knock || 1) * (.55 + Math.min(o.dmg || 30, 120) / 70), .3, R0.maxStrength || 2.6); if (o.zone === 'head') str *= 1.15;
  // pellets / several hits in the same frame: one stronger reaction, not N stacked ones
  const last = h.ev[h.ev.length - 1];
  const fr = frameNo();
  if (last && last.f === fr && !o.kill) { last.str = Math.min(R0.maxStrength || 2.6, last.str + str * .3); last.n++; return last; }
  const f = feetOf(e), dx = o.dir.x, dz = o.dir.z, L = Math.hypot(dx, dz) || 1;
  const ev = { t, f: fr, ent: e, zone: o.zone, dx: dx / L, dz: dz / L, str, heavy: !!w.heavy, n: 1, mat: o.mat, crit: !!o.crit, kill: !!o.kill, weapon: o.weapon || '',
    lx: o.point ? o.point.x - f.x : 0, ly: o.point ? o.point.y - f.y : 1.2, lz: o.point ? o.point.z - f.z : 0, tq: 0, y1: 0, net: !!o.net };
  // torque about the vertical axis: a hit on the right side twists the right shoulder back
  if (o.point) { const cx = o.point.x - f.x, cz = o.point.z - f.z; ev.tq = clamp((cz * ev.dx - cx * ev.dz) / .22, -1, 1); } else ev.tq = rnd(-.6, .6);
  if (o.kill) ev.y1 = Math.atan2(-ev.dx, -ev.dz) + rnd(-1, 1) * (D.death.jitter || .35);   // face the shot: the backwards fall goes away from it
  h.ev.push(ev); if (h.ev.length > 6) h.ev.shift();
  LOG.push(ev); trimLog(); HX.stats.reacts++;
  return ev;
}
const imp = (age, rise, tau) => age < 0 ? 0 : age < rise ? Math.sin(age / rise * Math.PI / 2) : Math.exp(-(age - rise) / tau);
function bonesOf(r) {
  const h = evList(r); if (h.bones && h.bones.model === r.model) return h.bones;
  const b = n => r.model.getObjectByName('mixamorig' + n) || null;
  h.bones = { model: r.model, hips: r.B.hips, spine: r.B.spine, spine1: r.B.spine1, spine2: r.B.spine2, neck: r.B.neck, head: r.B.head, lArm: b('LeftArm'), rArm: b('RightArm'), lUp: b('LeftUpLeg'), rUp: b('RightUpLeg'), lLeg: b('LeftLeg'), rLeg: b('RightLeg') };
  h.bones.list = ['hips', 'spine', 'spine1', 'spine2', 'neck', 'head', 'lArm', 'rArm', 'lUp', 'rUp', 'lLeg', 'rLeg'].map(k => h.bones[k]).filter(Boolean);
  return h.bones;
}
function restore(r) {
  const h = r.__hfx; if (!h || !h.saved) return;
  const S = h.saved; for (let i = 0; i < S.b.length; i++) S.b[i].quaternion.copy(S.q[i]); if (S.m) r.model.position.copy(S.m); if (S.gun && r.gun) r.gun.position.copy(S.gun);
  h.saved = null;
}
const APPLIED = new Set(); HX._applied = APPLIED;
const _ax = new T.Vector3(), _ax2 = new T.Vector3(), _ha = new T.Vector3(), _hb = new T.Vector3(), _st = new T.Vector3();
// pose the reactions of entity r at time Tn (game time live; replay time for killcam actors)
function react(r, Tn, evs) {
  const R0 = D.react, B = bonesOf(r); let any = false;
  for (const ev of evs) { const age = Tn - ev.t; if (age >= 0 && age < Math.max(R0[ev.zone] ? R0[ev.zone].dur : .5, ev.heavy ? R0.heavy.dur : 0)) { any = true; break; } }
  if (!any) return false;
  const saved = { b: B.list.slice(), q: B.list.map(b => b.quaternion.clone()), m: r.model.position.clone(), gun: r.gun ? r.gun.position.clone() : null };
  r.__hfx.saved = saved; APPLIED.add(r);
  if (r.B.rhand) { r.B.rhand.updateWorldMatrix(true, false); r.B.rhand.getWorldPosition(_ha); }
  const probe = () => { const hb = r.meshes ? r.meshes.find(m => m.userData.zone === 'head') : null, cb = r.meshes ? r.meshes.find(m => m.userData.zone === 'body') : null, fa = n => r.model.getObjectByName('mixamorig' + n);
    return { h: (hb || B.head).getWorldPosition(new T.Vector3()), s: (cb || B.spine2).getWorldPosition(new T.Vector3()), k: (B.rLeg || B.hips).getWorldPosition(new T.Vector3()), a: [fa('LeftForeArm'), fa('RightForeArm')].map(b => b ? b.getWorldPosition(new T.Vector3()) : new T.Vector3()) }; };
  const dbg = HX.debug ? Object.assign(probe(), { t: Tn, hg0: r.gun ? r.gun.position.distanceTo(_ha) : 0 }) : null;
  const yaw = r.root.rotation.y, rightX = Math.cos(yaw), rightZ = -Math.sin(yaw);
  let drop = 0; _st.set(0, 0, 0);
  for (const ev of evs) {
    const age = Tn - ev.t; if (age < 0) continue; const Z = R0[ev.zone] || R0.body; if (age > Math.max(Z.dur, ev.heavy ? R0.heavy.dur : 0)) continue;
    const k = imp(age, R0.rise, Z.tau) * ev.str, k2 = ev.heavy ? imp(age, R0.rise * 1.6, R0.heavy.tau) * ev.str : 0;
    _ax.set(0, 1, 0).cross(_ax2.set(ev.dx, 0, ev.dz)).normalize();   // rotating about this tips a bone's top along the shot
    if (ev.zone === 'head') { rotateBoneWorld(B.neck, _ax, Z.neck * k); rotateBoneWorld(B.head, _ax, Z.head * k); rotateBoneWorld(B.spine2, _ax, Z.spine * k); rotateBoneWorld(B.head, UP, ev.tq * .12 * k); }
    else if (ev.zone === 'low') {
      const side = (ev.lx * rightX + ev.lz * rightZ) >= 0 ? 1 : -1;   // which leg
      const up = side > 0 ? B.rUp : B.lUp, leg = side > 0 ? B.rLeg : B.lLeg; _ax2.set(rightX, 0, rightZ);
      rotateBoneWorld(leg, _ax2, -Z.knee * k); rotateBoneWorld(up, _ax2, Z.hip * k); rotateBoneWorld(B.spine1, _ax, Z.pitch * k); drop += Z.drop * Math.min(1.4, k);
    } else if (ev.zone === 'arm') {
      const side = (ev.lx * rightX + ev.lz * rightZ) >= 0 ? 1 : -1, arm = side > 0 ? B.rArm : B.lArm;
      rotateBoneWorld(arm, _ax, Z.arm * k); rotateBoneWorld(B.spine2, UP, ev.tq * Z.twist * k);
    } else { rotateBoneWorld(B.spine1, _ax, Z.pitch * .55 * k); rotateBoneWorld(B.spine2, _ax, Z.pitch * .45 * k); rotateBoneWorld(B.spine1, UP, ev.tq * Z.twist * .5 * k); rotateBoneWorld(B.spine2, UP, ev.tq * Z.twist * .5 * k); rotateBoneWorld(B.neck, _ax, -Z.pitch * .3 * k); }
    if (k2) { _st.x += ev.dx * R0.heavy.stagger * k2; _st.z += ev.dz * R0.heavy.stagger * k2; rotateBoneWorld(B.hips, _ax, .1 * k2); }
  }
  if (drop || _st.lengthSq()) {   // stagger / buckle: the model shifts inside its root (root = network / AI position, untouched)
    _st.applyAxisAngle(UP, -yaw); r.model.position.x += _st.x; r.model.position.z += _st.z; r.model.position.y -= Math.min(.12, drop);
  }
  // the gun stays in the hand
  if (r.B.rhand && r.gun) { r.B.rhand.updateWorldMatrix(true, false); r.B.rhand.getWorldPosition(_hb); r.gun.position.add(_q.subVectors(_hb, _ha)); }
  if (dbg) {   // tests: how far the head / chest / knee really moved, and that the gun is still in the hand
    r.model.updateMatrixWorld(true); const ev = evs[evs.length - 1], dir = new T.Vector3(ev.dx, 0, ev.dz);
    const q1 = probe(), dh = q1.h.sub(dbg.h), ds = q1.s.sub(dbg.s), dk = q1.k.sub(dbg.k), da = Math.max(q1.a[0].distanceTo(dbg.a[0]), q1.a[1].distanceTo(dbg.a[1]));
    r.__hfx.dbg = { t: Tn, head: dh.length(), headAlong: dh.dot(dir), chest: ds.length(), knee: dk.length(), drop: -dk.y, arm: da, model: r.model.position.length(), handGun0: dbg.hg0, handGun: r.gun && r.B.rhand ? r.B.rhand.getWorldPosition(new T.Vector3()).distanceTo(r.gun.position) : 0 };
    (HX.dbgLog || (HX.dbgLog = [])).push(Object.assign({ name: r.name, ghost: !!r.kcGhost, zone: ev.zone, heavy: ev.heavy }, r.__hfx.dbg)); if (HX.dbgLog.length > 400) HX.dbgLog.shift();
  }
  return true;
}
HX._react = react;
function restoreAll() { for (const r of APPLIED) restore(r); APPLIED.clear(); }

/* =============================================================================== hit entry points */
const NOBLOOD = () => new Set((D.noBlood && D.noBlood.weapons) || []);
let noB = null, noBData = null;
const bloodless = w => { if (noBData !== D) { noB = NOBLOOD(); noBData = D; } return noB.has(w); };
// one landed hit: reaction + burst + splats + sound. o: { zone(game zone), point, dir, dmg, crit, weapon, attacker, kill, net, mine }
function onHit(e, o) {
  const t0 = performance.now();
  try {
    const mat = matOf(e), zone = zoneOf(e, o.zone, o.point), dmg = +o.dmg || 0;
    const dot = bloodless(o.weapon) || dmg < (D.noBlood.minDamage || 5);
    if (dot && !o.kill) { if (dmg >= 2) record(e, { zone, point: o.point, dir: o.dir, dmg: dmg * .5, weapon: o.weapon, mat, crit: false }); return; }
    const h = evList(e), lastEv = h.ev[h.ev.length - 1], same = !!lastEv && lastEv.f === frameNo();
    record(e, { zone, point: o.point, dir: o.dir, dmg, weapon: o.weapon, mat, crit: o.crit, net: o.net });
    const kind = zone === 'head' || o.crit ? 'head' : 'hit';
    if (o.point && !(e === PLAYER_ENT && state !== 'dead' && !replayOn())) {   // your own body in first person: nothing in front of your eyes
      const P0 = HX.prof, ta = P0 ? performance.now() : 0;
      emit(mat, kind, o.point, o.dir, same ? .35 : 1); const tb = P0 ? performance.now() : 0;
      if (!same || Math.random() < .3) splats(kind, mat, o.point, o.dir, feetOf(e).y); const tc = P0 ? performance.now() : 0;
      if (P0) { P0.emit = (P0.emit || 0) + tb - ta; P0.splat = (P0.splat || 0) + tc - tb; P0.splatMax = Math.max(P0.splatMax || 0, tc - tb); P0.n = (P0.n || 0) + 1; }
      if (!same) impactSound(kind === 'head' && mat === 'flesh' ? 'head' : (D.materials[mat] || {}).sound || 'flesh', o.point, !!o.mine);
    }
    HX.stats.hits++; if (kind === 'head') HX.stats.heads++;
  } catch (er) { warn(er); }
  finally { const ms = performance.now() - t0; HX.perf.n++; HX.perf.ms += ms; HX.perf.max = Math.max(HX.perf.max, ms); }
}
function onKill(e, dir, crit, weapon, point) {
  try {
    const mat = matOf(e), f = feetOf(e), p = point || new T.Vector3(f.x, f.y + (crit ? 1.6 : 1.2), f.z);
    const ev = record(e, { zone: crit ? 'head' : 'body', point: p, dir, dmg: 100, weapon, mat, crit, kill: true });
    if (!(e === PLAYER_ENT && !replayOn())) { emit(mat, 'kill', p, dir, 1); splats('kill', mat, p, dir, f.y); }
    HX.stats.kills++; return ev;
  } catch (er) { warn(er); return null; }
}
HX.onHit = onHit; HX.onKill = onKill;
const replayOn = () => { const kc = window.S9KC; return !!(kc && kc.inReplay); };

/* =============================================================================== hooks into the game */
// every hook calls the original; HX.enabled = false turns the whole module into a pass-through (tests: A/B timing in one page)
HX.enabled = true;
const wrap = (name, make) => { try { const orig = (0, eval)(name); if (typeof orig !== 'function') return false; const fn = make(orig);
  const w = function () { return HX.enabled === false ? orig.apply(this, arguments) : fn.apply(this, arguments); };
  (0, eval)(`(f) => { ${name} = f; }`)(w); return true; } catch (e) { warn(e); return false; } };
// the game's own small orange spark burst on body hits / deaths is replaced by the material burst (mid/high tiers, not low violence)
function suppressing(e) { return tier() > 0 && matOf(e) !== (D.lowViolence || 'sparks'); }
// (nested: damageBot -> botDie both suppress; our own bursts always use the real spawn functions)
let quiet = 0, realFX = null, realSM = null;
function quietFx(fn) {
  if (quiet++ === 0) { realFX = FX.spawn; realSM = SMOKE.spawn; FX.spawn = SMOKE.spawn = function () { HX.stats.suppressed++; }; }
  try { return fn(); } finally { if (--quiet === 0) { FX.spawn = realFX; SMOKE.spawn = realSM; realFX = realSM = null; } }
}

wrap('damageBot', orig => function (r, dmg, crit, point, dir, zone, attacker, weapon) {
  if (!r || r.dead || !point || !dir) return orig.apply(this, arguments);
  const byMe = attacker === PLAYER_ENT, lands = !(r.shield > 0) && (!r.remote || byMe), hp0 = r.hp, seq0 = typeof NET !== 'undefined' && NET.seq ? NET.seq.hit : 0;
  const q = lands && suppressing(r) && typeof FX !== 'undefined' && FX;
  const res = q ? quietFx(() => orig.apply(this, arguments)) : orig.apply(this, arguments);
  // landed = their health went down (bots) / the hit was really sent (online players; team modes drop friendly fire before that)
  if (lands && (r.remote ? NET.seq.hit !== seq0 : (r.hp < hp0 || r.dead))) {
    // the kill itself is handled by botDie (finishing burst); this is the impact
    onHit(r, { zone, point: point.clone(), dir: _d.copy(dir).normalize().clone(), dmg, crit, weapon, attacker, mine: byMe });
  }
  return res;
});
wrap('hurtPlayer', orig => function (dmg, from, attacker, crit, weapon) {
  const live = state === 'play' && !P.dead && !window.__god && !(P.shield > 0), hp0 = P.hp;
  const res = orig.apply(this, arguments);
  try { if (live && P.hp < hp0) { const dir = from ? _d.set(P.pos.x - from.x, 0, P.pos.z - from.z) : _d.set(rnd(-1, 1), 0, rnd(-1, 1)); if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1); dir.normalize();
    const zone = crit ? 'head' : (Math.random() < .2 ? 'limb' : 'body'), pt = new T.Vector3(P.pos.x - dir.x * .12, P.pos.y + (zone === 'head' ? 1.62 : zone === 'limb' ? .6 : 1.2), P.pos.z - dir.z * .12);
    onHit(PLAYER_ENT, { zone, point: pt, dir: dir.clone(), dmg: hp0 - P.hp, crit, weapon, attacker }); } } catch (e) { warn(e); }
  return res;
});
wrap('playerDie', orig => function (killer, weapon, crit) {
  try { const kp = killer && killer !== PLAYER_ENT && killer.root ? killer.root.position : null, dir = kp ? new T.Vector3(P.pos.x - kp.x, 0, P.pos.z - kp.z) : new T.Vector3(0, 0, 1); if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1); dir.normalize();
    const ev = onKill(PLAYER_ENT, dir, !!crit, weapon); if (ev) { let k = (typeof DEATH_OF !== 'undefined' && DEATH_OF[weapon]) || 'spin'; if (crit && (k === 'spin' || k === 'riddled')) k = 'head'; ev.dk = k; } } catch (e) { warn(e); }
  return orig.apply(this, arguments);
});
// a death: finishing burst instead of the generic spark ring, then a death that falls away from the shot
wrap('botDie', orig => function (r, dir, crit, byMe) {
  if (!r) return orig.apply(this, arguments);
  restore(r); APPLIED.delete(r);
  const d = dir && dir.lengthSq() > 1e-6 ? new T.Vector3(dir.x, 0, dir.z).normalize() : new T.Vector3(0, 0, 1);
  const res = suppressing(r) && typeof FX !== 'undefined' && FX ? quietFx(() => orig.apply(this, arguments)) : orig.apply(this, arguments);
  try { const p = r.root.position, ev = onKill(r, d, !!crit, r.__hfxW || '', new T.Vector3(p.x, p.y + (crit ? 1.6 : 1.15), p.z)); if (ev) ev.dk = r.deathKind; deathTurn(r, ev); } catch (e) { warn(e); }
  return res;
});
wrap('startDeathFx', orig => function (r, dir, crit, weapon) { const res = orig.apply(this, arguments); try { r.__hfxW = weapon || ''; } catch (e) {} return res; });
function deathTurn(r, ev) {
  const k = r.deathKind; if (!ev || !(D.death.kinds || []).includes(k)) { r.__hfxD = null; return; }
  const w = wcfg(ev.weapon);
  r.deathSpin = 0; r.__hfxD = { y0: r.root.rotation.y, y1: ev.y1, knock: (w.heavy ? 1 : .45) * Math.min(1.6, w.knock || 1) };
  if (r.deathVel && w.heavy) r.deathVel.multiplyScalar(D.death.slide || 1.35);
}
const lerpAng = (a, b, t) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
const ez = x => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
function poseDeath(root, D0, t) {   // turn toward the fall direction quickly, plus a backwards knock that settles
  const Dd = D.death; root.rotation.y = lerpAng(D0.y0, D0.y1, ez(t / Dd.turn));
  root.rotation.x = -Dd.knockPitch * D0.knock * imp(t, Dd.knockRise, Dd.knockTau);
}
wrap('updateDeathFx', orig => function (r, dt) {
  const res = orig.apply(this, arguments);
  try { if (r.__hfxD && (D.death.kinds || []).includes(r.deathKind)) poseDeath(r.root, r.__hfxD, r.deadT); } catch (e) { warn(e); }
  return res;
});
wrap('resetDeathFx', orig => function (r) { if (r) r.__hfxD = null; return orig.apply(this, arguments); });
// online: hits of one remote player on ANOTHER remote player (spectators, 3+ player rooms). Hits on you arrive via hurtPlayer.
wrap('netReceive', orig => function (E, pr) {
  try {
    const r = E && E.r, myId = typeof NET !== 'undefined' && NET.room && NET.room.myId;
    if (r && pr && Array.isArray(pr.hl) && Array.isArray(pr.x)) {
      const last = E.__hfxHit | 0; let top = last;
      for (const h of pr.hl) {
        const s = h && (h.s | 0); if (!s || s <= last) continue; top = Math.max(top, s);
        if (!h.t || h.t === myId || last === 0 && E.__hfxSeen !== true) continue;   // first state from a player: old hits, skip
        const v = typeof remoteById === 'function' ? remoteById(h.t) : null; if (!v || v.dead || v.shield > 0) continue;
        const w = typeof h.wn === 'string' && WEAPONS[h.wn] ? h.wn : NET_W[h.w | 0] || 'carbine';
        const a = r.root.position, vp = v.root.position, dir = new T.Vector3(vp.x - a.x, 0, vp.z - a.z); if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1); dir.normalize();
        const head = !!h.h, pt = new T.Vector3(vp.x - dir.x * .15, vp.y + (head ? 1.6 : 1.15 + rnd(-.15, .1)), vp.z - dir.z * .15);
        onHit(v, { zone: head ? 'head' : 'body', point: pt, dir, dmg: clamp(+h.a || 0, 0, 250), crit: head, weapon: w, attacker: r, net: true });
        HX.stats.netHits++;
      }
      E.__hfxHit = top; E.__hfxSeen = true;
    }
  } catch (e) { warn(e); }
  return orig.apply(this, arguments);
});
// reactions on the rig, after the animation of that frame
wrap('animateBot', orig => function (r, dt) {
  if (r && r.__hfx && r.__hfx.saved) { restore(r); APPLIED.delete(r); }
  const res = orig.apply(this, arguments);
  try {
    if (r && r.model && r.B && !r.dead) {
      const kc = window.S9KC;
      if (r.kcGhost) { if (kc && kc.clip && r.kcEnt) { const evs = ghostEvents(r.kcEnt); if (evs.length) react(r, kc.rt, evs); } }
      else if (r.__hfx && r.__hfx.ev.length && !(kc && kc.live && !kc.inReplay)) react(r, G.time, r.__hfx.ev);
    }
  } catch (e) { warn(e); }
  return res;
});
function ghostEvents(ent) { const out = []; for (const ev of LOG) if (ev.ent === ent) out.push(ev); return out; }

/* =============================================================================== killcam: replay the impacts on its actors */
let kcClip = null, kcPrev = 0;
const _g = new T.Vector3(), _gd = new T.Vector3();
function replayFx() {
  const kc = window.S9KC; if (!kc || !kc.clip || !(kc.inReplay || (kc.fin && state === 'matchend'))) { kcClip = null; return; }
  const c = kc.clip, rt = kc.rt; if (kcClip !== c) { kcClip = c; kcPrev = c.t0 - 1e-3; }
  if (!(rt > kcPrev)) return;
  const cast = new Set(c.cast || []), GH = kc.ghosts;
  for (const ev of LOG) {
    if (ev.t <= kcPrev || ev.t > rt || !cast.has(ev.ent)) continue;
    const g = GH && GH.get(ev.ent); if (!g || !g.root.visible) continue;
    const gp = g.root.position; _g.set(gp.x + ev.lx, gp.y + ev.ly, gp.z + ev.lz); _gd.set(ev.dx, 0, ev.dz);
    const mat = lowViolence() ? (D.lowViolence || 'sparks') : ev.mat;
    emit(mat, ev.kill ? 'kill' : (ev.zone === 'head' || ev.crit ? 'head' : 'hit'), _g, _gd, 1);
    if (!ev.kill) impactSound(ev.zone === 'head' && mat === 'flesh' ? 'head' : (D.materials[mat] || {}).sound || 'flesh', _g.clone(), false);
    HX.stats.replayFx++;
  }
  // dead actors: the same direction-aware fall as live
  for (const ent of cast) {
    const g = GH && GH.get(ent); if (!g) continue;
    if (!g.kcDying) { if (g.__hfxKD) { g.root.rotation.x = 0; g.__hfxKD = null; } continue; }
    let ev = null; for (let i = LOG.length - 1; i >= 0; i--) { const q = LOG[i]; if (q.ent === ent && q.kill && q.t <= rt + .05) { ev = q; break; } }
    if (!ev || !(D.death.kinds || []).includes(ev.dk || 'spin')) continue;
    if (!g.__hfxKD || g.__hfxKD.ev !== ev) { const w = wcfg(ev.weapon); g.__hfxKD = { ev, y0: g.root.rotation.y, y1: ev.y1, knock: (w.heavy ? 1 : .45) * Math.min(1.6, w.knock || 1) }; }
    poseDeath(g.root, g.__hfxKD, Math.max(0, rt - ev.t)); g.root.updateMatrixWorld(true);
  }
  kcPrev = rt;
}

/* =============================================================================== per frame: around the render */
function hookRender() {
  if (typeof composer !== 'object' || !composer || typeof composer.render !== 'function' || composer.__hfx) return false;
  const _render = composer.render; composer.__hfx = true;
  composer.render = function () {
    const t0 = performance.now();
    try { tickDecals(); if (HX.enabled !== false) replayFx(); } catch (e) { warn(e); }
    HX.frameMs = performance.now() - t0;
    try { return _render.apply(this, arguments); } finally { try { restoreAll(); } catch (e) { warn(e); } }
  };
  return true;
}
wrap('warmShaders', orig => function () { let was = false; if (DEC) { was = DEC.im.visible; DEC.im.visible = true; } try { return orig.apply(this, arguments); } finally { if (DEC) DEC.im.visible = was; } });
wrap('clearDecals', orig => function () { const r = orig.apply(this, arguments); try { clearSplats(); } catch (e) {} return r; });
wrap('respawnBot', orig => function (r) { if (r && r.__hfx) { restore(r); APPLIED.delete(r); r.__hfx.ev.length = 0; } return orig.apply(this, arguments); });

/* =============================================================================== boot */
function boot() {
  if (!window.__s9 || typeof FX === 'undefined' || !FX || typeof scene === 'undefined') { setTimeout(boot, 200); return; }
  try { hookRender(); initDecals(); } catch (e) { warn(e); }
  const snd = () => { if (typeof AU !== 'undefined' && AU.ctx) { try { buildSounds(); } catch (e) { warn(e); } } else setTimeout(snd, 1000); }; snd();
  HX.ready = true;
}
boot();

/* =============================================================================== test / debug API */
HX.status = () => ({ ready: HX.ready, data: HX.data, tier: tierName(), lowViolence: lowViolence(), splatsVisible: !!(DEC && DEC.im.visible), splatPool: DEC ? DEC.pool : 0, log: LOG.length, applied: APPLIED.size, stats: Object.assign({}, HX.stats), perf: { n: HX.perf.n, avgMs: HX.perf.n ? HX.perf.ms / HX.perf.n : 0, maxMs: HX.perf.max }, warmed: HX.warmed || 0 });
HX.splatMesh = () => DEC && DEC.im;
HX.clear = () => { clearSplats(); LOG.length = 0; };
})();
