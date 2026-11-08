/* gfxkit (S9KIT): modelled futuristic arena kit (render/kit/build_kit.py) drawn in place of the map kit's simple cover / cargo / wall pieces.
   - Shapes are shared by every map; data/look/<map>/kit.json makes them look like that map (palette, wear, grime, dust, decals, pattern).
   - Collision, bullets, sight lines, nav and server boxes are untouched: every kit piece fills exactly the collision boxes of the piece it
     replaces (render/kit/kit_report.json maxDev <= 5 mm). Only the picture changes: the old piece's vertices in the merged map mesh are
     collapsed (same vertex count/order, so gfxlook's per-vertex light stays valid) and restored when the look or this module is off.
   - Drawn as InstancedMesh per piece type and LOD (LOD1 = no small hardware; swapped by distance 4x a second, no per-frame work).
   - Lit like the baked map: each placement takes the old piece's baked per-vertex light (gfxlook s9vl), front and back side averages.
   Runs as a gfxlook extension (window.S9LOOK_EXT, docs: modules/gfxlook.INTEGRATE.md section 6). Load BEFORE gfxlook (like yardcover).
   Off switch: localStorage['sector9-kit'] = 'off' or S9KIT.setOn(false).   API: S9KIT.status(), S9KIT.setOn(on), S9KIT.stats()          */
(() => {
  'use strict';
  const K = window.S9KIT = window.S9KIT || {};
  Object.assign(K, { ready: true, map: null, built: false, on: true, err: null, notes: [] });
  try { if (localStorage.getItem('sector9-kit') === 'off') K.on = false; } catch (e) {}
  const MAPS = ['yard'];   // maps with data/look/<map>/kit.json
  const PIECES = ['wall_4', 'wall_4_window', 'wall_4_door', 'wall_half', 'wall_low', 'hexbags', 'barrier_energy', 'crate_1', 'crate_stack', 'container_6', 'container_6_open'];
  const DATA = {}; let KIT = null, TEX = null, S = null, LOOKON = false;
  const getData = async id => { if (DATA[id] !== undefined) return DATA[id]; try { const r = await fetch('data/look/' + id + '/kit.json', { cache: 'no-cache' }); DATA[id] = r.ok ? await r.json() : null; } catch (e) { DATA[id] = null; } return DATA[id]; };
  const hash = (x, y, z) => { let h = Math.imul(Math.round(x * 10) | 0, 73856093) ^ Math.imul(Math.round(z * 10) | 0, 19349663) ^ Math.imul(Math.round(y * 10) | 0, 83492791); h ^= h >>> 13; h = Math.imul(h, 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

  /* ---------- kit geometry (one glb for every map) ---------- */
  async function loadKit(ctx, D) {
    if (KIT) return KIT;
    const T = ctx.T, g = await ctx.loadGLB(D.glb); if (!g) throw new Error('kit glb missing');
    const out = {};
    g.scene.traverse(o => {
      if (!o.isMesh) return; const m = /^(.+)__(lod0|glass)$/.exec(o.name); if (!m) return;
      const geo = o.geometry; o.updateMatrixWorld(true); geo.applyMatrix4(o.matrixWorld);
      const c = geo.attributes.color, uv2 = geo.attributes.uv2;
      if (c) { const n = c.count, a = new Float32Array(n * 3); for (let i = 0; i < n; i++) { a[i * 3] = c.getX(i); a[i * 3 + 1] = c.getY(i); a[i * 3 + 2] = c.getZ(i); } geo.setAttribute('kz', new T.BufferAttribute(a, 3)); geo.deleteAttribute('color'); }
      if (uv2) { geo.setAttribute('kd', uv2); geo.deleteAttribute('uv2'); }
      const e = out[m[1]] = out[m[1]] || {}; e[m[2]] = geo;
      if (m[2] === 'lod0' && geo.index && geo.attributes.kz) {   // LOD1: drop the detail-only triangles (COLOR_0.b = 1)
        const I = geo.index.array, kz = geo.attributes.kz.array, keep = [];
        for (let i = 0; i < I.length; i += 3) if (kz[I[i] * 3 + 2] < .5) keep.push(I[i], I[i + 1], I[i + 2]);
        const l1 = new T.BufferGeometry(); for (const k in geo.attributes) l1.setAttribute(k, geo.attributes[k]);
        l1.setIndex(new T.BufferAttribute(I.length > 65535 * 3 || geo.attributes.position.count > 65535 ? new Uint32Array(keep) : new Uint16Array(keep), 1)); e.lod1 = l1;
      }
    });
    for (const p of PIECES) if (!out[p] || !out[p].lod0) throw new Error('kit piece missing: ' + p);
    return (KIT = out);
  }
  function loadTex(T, url, opt) {
    return new Promise(res => new T.TextureLoader().load(url, t => { t.flipY = false; if (opt.repeat) t.wrapS = t.wrapT = T.RepeatWrapping; t.anisotropy = 4; t.needsUpdate = true; res(t); }, undefined, () => res(null)));
  }
  async function loadTexs(ctx, D) {
    if (TEX) return TEX; const T = ctx.T;
    const [n, m, mi, dc] = await Promise.all([loadTex(T, D.normal, {}), loadTex(T, D.mask, {}), loadTex(T, D.micro, { repeat: 1 }), loadTex(T, D.decals, {})]);
    if (!n || !m || !mi || !dc) throw new Error('kit textures missing');
    return (TEX = { n, m, mi, dc });
  }

  /* ---------- material: zones from vertex colour, palette per map, wear from the baked edge mask ---------- */
  const VS_P = `
attribute vec3 kz; attribute vec2 kd; attribute vec4 kv; attribute vec3 kl0; attribute vec3 kl1;
uniform vec3 kPaint[10]; uniform vec3 kAcc[10]; uniform vec3 kGlow[4];
varying vec3 vKz; varying vec4 vKv; varying vec2 vKd; varying vec3 vKp; varying vec3 vKn; varying vec3 vKl; varying vec3 vKpaint; varying vec3 vKacc; varying vec3 vKglow; varying float vKs;`;
  const VS_M = `
vKz = kz; vKv = kv; vKs = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453); vKd = kd; vKp = position; vKn = normal;
vKl = mix(kl1, kl0, clamp(normal.z * .5 + .5, 0., 1.));
{ int pi = int(kv.x + .5); vKpaint = kPaint[pi]; vKacc = kAcc[pi]; vKglow = kGlow[int(kv.y + .5)]; }`;
  const FS_P = `
uniform sampler2D kMask, kMicro, kDecal; uniform vec4 kWear; uniform vec4 kPat; uniform vec3 kAlloy, kPoly, kComp, kInk, kHazA, kHazB, kDust, kPrimer;
uniform float kGlowK, s9LkK, s9LkM, s9LkGain;
varying vec3 vKz; varying vec4 vKv; varying vec2 vKd; varying vec3 vKp; varying vec3 vKn; varying vec3 vKl; varying vec3 vKpaint; varying vec3 vKacc; varying vec3 vKglow; varying float vKs;
float kRough = .5, kMetal = 0., kAO = 1.; vec3 kEmit = vec3(0.);`;
  const FS_COLOR = `
{
  vec4 km = texture2D(kMask, vUv);
  vec4 mic = texture2D(kMicro, vKd * .31 + vKs * 7.3);
  vec4 mic2 = texture2D(kMicro, vKd * 1.9 + vKs * 3.1);
  vec4 stk = texture2D(kMicro, vec2(vKd.x * .45, vKd.y * .11) + vKs * 5.7);
  float cell = vKv.z; vec2 dcu = (vec2(mod(cell, 4.), floor(cell / 4.)) + clamp(vKd, .02, .98)) * .25;
  float ink = texture2D(kDecal, dcu).a;
  int zone = int(vKz.x * 8.);
  vec3 base = vKpaint; float paint = 1.;
  if (zone == 0) { if (vKv.w > 0. && vKp.y < vKv.w) base = vKacc; }   // two-tone split height per family (kit.json assign.<piece>.twoTone)
  else if (zone == 1) base = vKacc;
  else if (zone == 2) { base = kAlloy * (.85 + .3 * mic2.b); kRough = .3 + .2 * mic2.b; kMetal = 1.; paint = 0.; }
  else if (zone == 3) { base = kPoly; kRough = .62 + .15 * mic2.b; paint = .35; }
  else if (zone == 4) { base = vec3(.03); kEmit = vKglow * kGlowK * mix(.3, 1., step(.5, vKz.y)); kRough = .2; paint = 0.; }
  else if (zone == 5) { base = mix(kPoly * 1.4, kInk, ink * (1. - .6 * kWear.x * mic.a)); kRough = .45; paint = .3; }
  else if (zone == 6) { float s = fract((vKd.x + vKd.y) * kPat.y); base = mix(kHazA, kHazB, step(.5, s)); }
  else { base = kComp * (.88 + .24 * mic.r); kRough = .6; }
  if (zone <= 1 || zone == 6) kRough = .48 + .12 * mic2.b;
  base *= 1. - kPat.z + 2. * kPat.z * vKz.y;                        // per-part tone variation
  // wear: chips on edges (baked bevel mask) broken by noise -> primer / bare alloy
  float chip = smoothstep(1. - kWear.x, 1.15 - kWear.x, km.g * .8 + mic2.a * .5) * paint;
  base = mix(base, mix(kPrimer, kAlloy * .7, step(.6, mic.a)), chip); kMetal = mix(kMetal, step(.6, mic.a), chip); kRough = mix(kRough, .42, chip);
  // grime: cavities (baked local AO), rain streaks down vertical faces, noise
  float cav = 1. - km.b, up = vKn.y;
  float grime = clamp(kWear.y * (cav * 1.2 + mic.r * .35 + stk.g * .7 * (1. - abs(up))), 0., 1.);
  base *= 1. - .55 * grime; kRough = mix(kRough, .85, grime * .6);
  float dust = smoothstep(.55, .95, up) * kWear.z * (.45 + .55 * mic.r);
  base = mix(base, kDust, dust * .7); kRough = mix(kRough, .9, dust);
  kAO = km.r * (.7 + .3 * km.b);
  diffuseColor.rgb = base;
}`;
  function makeMat(ctx, D) {
    const T = ctx.T, P = D.palette, C = a => new T.Color(a[0], a[1], a[2]), U = ctx.U || {};
    const m = new T.MeshStandardMaterial({ color: 0xffffff, roughness: .5, metalness: 0, normalMap: TEX.n, envMapIntensity: .8 });
    m.normalScale.set(1, -1); m.name = 's9kit'; m.userData.keep = true;
    const pad = (a, n) => { const o = a.map(C); while (o.length < n) o.push(C([.1, .1, .1])); return o.slice(0, n); };
    const u = m.userData.ku = {
      kMask: { value: TEX.m }, kMicro: { value: TEX.mi }, kDecal: { value: TEX.dc },
      kPaint: { value: pad(P.paint, 10) }, kAcc: { value: pad(P.accent, 10) }, kGlow: { value: pad(P.glow, 4) },
      kWear: { value: new T.Vector4(D.wear, D.grime, D.dust, 0) }, kPat: { value: new T.Vector4(0, D.pattern.hazardScale || 5, D.pattern.panelTone || .05, 0) },
      kAlloy: { value: C(P.alloy) }, kPoly: { value: C(P.polymer) }, kComp: { value: C(P.composite) }, kInk: { value: C(P.stencil) },
      kHazA: { value: C(P.hazardA) }, kHazB: { value: C(P.hazardB) }, kDust: { value: C(P.dust) }, kPrimer: { value: C(P.primer) },
      kGlowK: { value: (D.glowK || 1) * ((ctx.D && ctx.D.emissive && ctx.D.emissive.neon) || 1) },
      s9LkK: U.s9LkK || { value: 0 }, s9LkM: U.s9LkM || { value: 1 }, s9LkGain: U.s9LkGain || { value: 1 }   // shared with gfxlook: tier/tuning follow
    };
    const hook = ctx.baseHook ? ctx.baseHook() : null, key = ctx.baseKey ? ctx.baseKey() : null;
    m.onBeforeCompile = function (sh, r) {
      if (hook) hook.call(this, sh, r);
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>' + VS_P).replace('#include <begin_vertex>', '#include <begin_vertex>' + VS_M);
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>' + FS_P)
        .replace('#include <color_fragment>', '#include <color_fragment>' + FS_COLOR)
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = kRough;')
        .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = kMetal;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance = kEmit;')
        .replace('#include <lights_fragment_maps>', '#include <lights_fragment_maps>\nif (s9LkK > .001) irradiance = mix(irradiance, vKl * s9LkM * s9LkGain * PI, s9LkK);')
        .replace('#include <aomap_fragment>', 'reflectedLight.indirectDiffuse *= kAO; reflectedLight.indirectSpecular *= mix(1., kAO, .8); reflectedLight.directDiffuse *= mix(1., kAO, .35);');
    };
    m.customProgramCacheKey = function () { return String(key ? key.call(this) : '') + '|kit1'; };
    const gm = new T.MeshPhysicalMaterial({ color: C(P.glow[0]), emissive: C(P.glow[0]).multiplyScalar(.06), transparent: true, opacity: .2, roughness: .05, metalness: 0, depthWrite: false, side: T.DoubleSide });
    gm.name = 's9kit-glass'; gm.userData.keep = true;
    return { m, gm };
  }

  /* ---------- the old pieces: vertex ranges in the map's merged meshes ---------- */
  function oldRanges(T, key, scene) {
    const log = (typeof MKLOG !== 'undefined' && MKLOG[key]) || null; if (!log || typeof MKIT === 'undefined') throw new Error('no MKLOG/MKIT for ' + key);
    const off = {}, ent = [];
    for (const p of log.pieces) {
      if (p.piece === 'solid_block') { if (p.visible) { const mt = p.material || 'm_concrete'; off[mt] = (off[mt] || 0) + 36; } continue; }
      const parts = MKIT[p.piece]; if (!parts) continue;
      const e = { p, r: [] };
      for (const { m, geo } of parts) { const n = geo.attributes.position.count, a = off[m] || 0; e.r.push({ m, a, n, geo }); off[m] = a + n; }
      if (PIECES.includes(p.piece)) ent.push(e);
    }
    const meshes = {};
    scene.traverse(o => { if (!o.isMesh || o.isInstancedMesh || !o.geometry || !o.geometry.attributes.position) return;
      const n = o.geometry.attributes.position.count; for (const m in off) if (off[m] === n && !meshes[m]) meshes[m] = o; });
    // verify: the first vertex of every replaced piece sits where put() placed it
    const v = new T.Vector3(), M = new T.Matrix4();
    for (const e of ent) { const { p } = e; M.makeRotationY((p.quarterTurns || 0) * Math.PI / 2).setPosition(p.x, p.y || 0, p.z);
      for (const r of e.r) { const o = meshes[r.m]; if (!o) throw new Error('merged mesh missing ' + r.m); const P = o.geometry.attributes.position;
        v.fromBufferAttribute(r.geo.attributes.position, 0).applyMatrix4(M); if (Math.abs(P.getX(r.a) - v.x) + Math.abs(P.getY(r.a) - v.y) + Math.abs(P.getZ(r.a) - v.z) > 1e-3) throw new Error('vertex order mismatch at ' + p.piece + ' ' + p.x + ',' + p.z); } }
    return { ent, meshes };
  }
  function sampleLight(T, e, meshes) {   // the old piece's baked per-vertex light, split by its local +z / -z side
    const a = (e.p.quarterTurns || 0) * Math.PI / 2, dz = [Math.sin(a), Math.cos(a)], s = [[0, 0, 0, 0], [0, 0, 0, 0]];
    for (const r of e.r) { const o = meshes[r.m], g = o.geometry, L = g.attributes.s9vl, N = g.attributes.normal; if (!L) continue;
      const la = L.array, nn = L.normalized ? 255 : 1;
      for (let i = r.a; i < r.a + r.n; i += 3) { const side = N.getX(i) * dz[0] + N.getZ(i) * dz[1] >= 0 ? 0 : 1, q = s[side];
        for (let k = 0; k < 3; k++) { const x = la[i * 3 + k] / nn; q[k] += x * x; } q[3]++; } }
    const avg = q => q[3] ? [q[0] / q[3], q[1] / q[3], q[2] / q[3]] : null, f = avg(s[0]), b = avg(s[1]), all = f && b ? f.map((x, i) => (x + b[i]) / 2) : (f || b || [0, 0, 0]);
    return [f || all, b || all];
  }
  function collapse(on) {
    if (!S) return; if (S.collapsed === on) return;
    for (const e of S.old.ent) for (const r of e.r) { const o = S.old.meshes[r.m], P = o.geometry.attributes.position, A = P.array;
      if (on) { if (!r.save) r.save = A.slice(r.a * 3, (r.a + r.n) * 3); for (let i = 1; i < r.n; i++) { const j = (r.a + i) * 3; A[j] = A[r.a * 3]; A[j + 1] = A[r.a * 3 + 1]; A[j + 2] = A[r.a * 3 + 2]; } }
      else if (r.save) A.set(r.save, r.a * 3);
      P.needsUpdate = true; }
    S.collapsed = on;
  }

  /* ---------- build per map ---------- */
  function glowSlot(rule, p) { if (typeof rule === 'number') return rule; if (Math.abs(p.x) < 7.5 && Math.abs(p.z) < 7.5) return 3; return p.z < 0 ? 0 : 1; }
  async function build(ctx) {
    const T = ctx.T, id = ctx.map; K.err = null; K.map = id; K.built = false;
    if (S) teardown();
    const D = await getData(id); if (!D) return [];
    if (!K.on) { K.notes.push('off'); return []; }
    await loadKit(ctx, D); await loadTexs(ctx, D);
    const old = oldRanges(T, id, ctx.scene), mats = makeMat(ctx, D);
    const by = {};
    for (const e of old.ent) { const p = e.p, A = D.assign[p.piece] || { pick: [[0, 0]], glow: 'zone' }, h = hash(p.x, p.y || 0, p.z), pk = A.pick[Math.floor(h * A.pick.length) % A.pick.length];
      const M = new T.Matrix4().makeRotationY((p.quarterTurns || 0) * Math.PI / 2).setPosition(p.x, p.y || 0, p.z), [l0, l1] = sampleLight(T, e, old.meshes);
      (by[p.piece] = by[p.piece] || []).push({ M, pos: new T.Vector3(p.x, (p.y || 0) + 1.2, p.z), kv: [pk[0], glowSlot(A.glow, p), pk[1], A.twoTone || 0], l0, l1 }); }
    const root = new T.Group(); root.name = 's9kit'; root.userData.s9ext = true; root.userData.noProbe = true;
    const types = [];
    for (const name in by) {
      const list = by[name], n = list.length, G = KIT[name], mk = [];
      for (const [lod, geo0, mat] of [[0, G.lod0, mats.m], [1, G.lod1, mats.m], [2, G.glass, mats.gm]]) {
        if (!geo0) continue;
        const geo = new T.BufferGeometry(); for (const k in geo0.attributes) geo.setAttribute(k, geo0.attributes[k]); geo.setIndex(geo0.index);
        geo.setAttribute('kv', new T.InstancedBufferAttribute(new Float32Array(n * 4), 4)); geo.setAttribute('kl0', new T.InstancedBufferAttribute(new Float32Array(n * 3), 3)); geo.setAttribute('kl1', new T.InstancedBufferAttribute(new Float32Array(n * 3), 3));
        if (lod === 2) { geo.deleteAttribute('kv'); geo.deleteAttribute('kl0'); geo.deleteAttribute('kl1'); }
        const im = new T.InstancedMesh(geo, mat, n); im.name = 's9kit-' + name + (lod === 2 ? '-glass' : '-lod' + lod); im.frustumCulled = false;
        im.castShadow = lod < 2; im.receiveShadow = lod < 2; im.userData.noProbe = true; im.userData.dyn = true; im.userData.s9ext = true; im.userData.s9nolm = true;
        if (lod === 2) { list.forEach((q, i) => im.setMatrixAt(i, q.M)); im.renderOrder = 3; }
        im.count = lod === 1 ? 0 : n; root.add(im); mk[lod] = im;
      }
      types.push({ name, list, mk, tris0: G.lod0.index.count / 3, tris1: G.lod1.index.count / 3, sig: '' });
    }
    S = { id, root, old, types, mats, collapsed: false, cam: ctx.camera, lodD: D.lodDist || 30, iv: null };
    lodTick(true);
    S.iv = setInterval(() => { try { lodTick(false); } catch (e) { K.err = 'lod ' + e.message; } }, 250);
    collapse(true); K.built = true; LOOKON = true;
    wrapExport();
    return [root];
  }
  function lodTick(force) {
    if (!S) return;
    if (S.collapsed) for (const m in S.old.meshes) if (!S.old.meshes[m].parent) { K.notes.push('map rebuilt'); teardown(); return; }
    const cam = S.cam || (window.__s9 && window.__s9.camera); if (!cam) return; const cp = cam.getWorldPosition ? cam.getWorldPosition(new cam.position.constructor()) : cam.position;
    for (const t of S.types) {
      let sig = ''; const near = [], far = [];
      t.list.forEach((q, i) => { const d = q.pos.distanceTo(cp) < S.lodD; (d ? near : far).push(i); sig += d ? '1' : '0'; });
      if (!force && sig === t.sig) continue; t.sig = sig;
      for (const [lod, idx] of [[0, near], [1, far]]) { const im = t.mk[lod]; if (!im) continue;
        const g = im.geometry, kv = g.attributes.kv.array, l0 = g.attributes.kl0.array, l1 = g.attributes.kl1.array;
        idx.forEach((i, j) => { const q = t.list[i]; im.setMatrixAt(j, q.M); kv.set(q.kv, j * 4); l0.set(q.l0, j * 3); l1.set(q.l1, j * 3); });
        im.count = idx.length; im.instanceMatrix.needsUpdate = true; g.attributes.kv.needsUpdate = g.attributes.kl0.needsUpdate = g.attributes.kl1.needsUpdate = true; }
    }
  }
  function teardown() {
    if (!S) return; clearInterval(S.iv); collapse(false);
    if (S.root.parent) S.root.parent.remove(S.root);
    S.root.traverse(o => { if (o.isInstancedMesh) { o.geometry.dispose(); o.dispose && o.dispose(); } });
    S.mats.m.dispose(); S.mats.gm.dispose(); S = null; K.built = false;
  }
  function tier(on) { LOOKON = !!on; if (!S) return; collapse(LOOKON && K.on); S.root.visible = LOOKON && K.on; }
  let wrappedExport = false;
  function wrapExport() {   // the lightmap export (render/look/export_lm.js) must see the real old pieces, not the collapsed ones
    if (wrappedExport || !window.S9LOOK || typeof S9LOOK.exportGeo !== 'function') return; wrappedExport = true;
    const ex = S9LOOK.exportGeo; S9LOOK.exportGeo = function () { const was = S && S.collapsed; if (was) collapse(false); try { return ex.apply(this, arguments); } finally { if (was) collapse(true); } };
  }
  // gfxlook: skins/strips that were painted onto the old pieces would float on the new ones (the kit carries its own panels + light seams)
  function patch(D, map) {
    if (!K.on || !D || !D.inside || typeof MKLOG === 'undefined' || !MKLOG[map] || typeof MKMETA === 'undefined') return;
    const bx = [];
    for (const p of MKLOG[map].pieces) { if (!PIECES.includes(p.piece) || !MKMETA[p.piece]) continue; const a = (p.quarterTurns || 0) * Math.PI / 2, ca = Math.round(Math.cos(a)), sa = Math.round(Math.sin(a));
      for (const b of MKMETA[p.piece].b) { const X = [], Z = []; for (const px of [b[0], b[3]]) for (const pz of [b[2], b[5]]) { X.push(px * ca + pz * sa + p.x); Z.push(-px * sa + pz * ca + p.z); }
        bx.push([Math.min(...X) - .3, b[1] + (p.y || 0) - .05, Math.min(...Z) - .3, Math.max(...X) + .3, b[4] + (p.y || 0) + .05, Math.max(...Z) + .3]); } }
    const on = (x, y, z) => bx.some(b => x > b[0] && x < b[3] && z > b[2] && z < b[5] && y > b[1] && y < b[4]);
    const I = D.inside, n0 = (I.skins || []).length + (I.strips || []).length + (I.tint || []).length;
    if (I.skins) I.skins = I.skins.filter(s => !on(s[1], s[2], s[3]));
    if (I.strips) I.strips = I.strips.filter(s => !on((s[0] + s[3]) / 2, (s[1] + s[4]) / 2, (s[2] + s[5]) / 2));
    if (I.tint) I.tint = I.tint.filter(t => !PIECES.includes(t[0]));
    K.patched = n0 - ((I.skins || []).length + (I.strips || []).length + (I.tint || []).length);
  }
  K.setOn = on => { K.on = !!on; try { localStorage.setItem('sector9-kit', on ? 'on' : 'off'); } catch (e) {} if (S) { collapse(LOOKON && K.on); S.root.visible = LOOKON && K.on; } };
  K.stats = () => { if (!S) return null; let calls = 0, tris = 0, inst = 0; for (const t of S.types) for (let l = 0; l < 3; l++) { const im = t.mk[l]; if (!im || !im.count) continue; calls++; inst += l < 2 ? im.count : 0; tris += im.count * im.geometry.index.count / 3; }
    return { types: S.types.length, instances: inst, calls, tris: Math.round(tris), collapsedPieces: S.old.ent.length }; };
  K.status = () => ({ ready: K.ready, on: K.on, map: K.map, built: K.built, lookOn: LOOKON, collapsed: !!(S && S.collapsed), patched: K.patched || 0, err: K.err, notes: K.notes.slice(-5), stats: K.stats() });
  const EXT = { name: 'gfxkit', module: 'gfxkit', maps: MAPS, replaces: [], patch, tier,
    async build(ctx) { try { if (!(await getData(ctx.map))) return []; return await build(ctx); } catch (e) { K.err = e.message; try { teardown(); } catch (e2) {} return []; } } };
  window.S9LOOK_EXT = window.S9LOOK_EXT || [];
  if (!window.S9LOOK_EXT.some(e => e && e.name === 'gfxkit')) window.S9LOOK_EXT.push(EXT);
})();
