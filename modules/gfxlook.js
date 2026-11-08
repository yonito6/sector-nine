/* Sector Nine - baked "2026 look" per map (modules/gfxlook.js). Loads AFTER graphics, gfxplus, gfxmat (see gfxlook.INTEGRATE.md).
   Everything it shows is a PORTABLE ASSET made offline (Blender / scripts in render/look/), so the Unity version reuses the same files:
   - Baked global illumination + ambient occlusion LIGHTMAP (Blender Cycles bake on a second UV set): sky light, bounce light of the sun
     and of the neon strips, soft occlusion in corners. It replaces the flat ambient (hemisphere + sky diffuse) on the map's static
     surfaces; the sun stays dynamic with its real-time shadows. Reflections are dimmed where the lightmap says the spot is enclosed.
   - PBR texture sets (albedo / normal / ARM = ambient-occlusion, roughness, metalness) at 2K for the main surfaces.
   - Wear + dirt DECALS from one atlas (placements are data), drawn as ONE multiply-blended mesh.
   - Cinematic grade: ACES (Hill fit: RRT + ODT, desaturates highlights instead of hue-shifting them) + a 32^3 colour LUT (.cube + PNG strip).
   Data: data/look/<map>.json (which assets, strengths, decal placements). Assets: assets/look/<map>/ (lightmap, lightmap UVs, decal atlas, LUT).
   Tiers: Performance = nothing changes (lightmap/LUT strength 0, decals hidden, 1K textures). Balanced/High/Ultra = all of it.
   Rules kept: no new lights, +1 draw call (decals, not on Performance), every shader is built at map load (a tier change only changes
   uniforms / visibility / texture objects), nothing per frame.
   API: window.S9LOOK = { ready, on, map, status(), receivers(), exportGeo(), setOn(on) }. Off switch (tests/A-B): localStorage
   'sector9-look' = 'off' or window.__s9LookOff = true before load. */
(function () {
  'use strict';
  if (window.S9LOOK) return;
  const need = typeof renderer !== 'undefined' && typeof scene !== 'undefined' && typeof MAPROOT !== 'undefined' && typeof loadMap === 'function' &&
    typeof applyQuality === 'function' && typeof grade !== 'undefined' && typeof composer !== 'undefined' && typeof CFG !== 'undefined';
  if (!need || !renderer.capabilities.isWebGL2) { console.warn('[gfxlook] game globals / WebGL2 not found, module idle'); return; }
  const T = THREE;
  let off = false; try { off = localStorage.getItem('sector9-look') === 'off'; } catch (e) {}
  if (window.__s9LookOff) off = true;
  const L = { ready: false, on: !off, map: null, err: null, data: {}, applied: null, recv: 0, matched: 0, missed: 0, mats: 0, decals: 0, loadMs: 0, notes: [] };
  const tierNow = () => (window.S9GFX && S9GFX.tier) || CFG.q;
  const full = () => L.on && tierNow() !== 'performance';
  const inMatch = () => typeof state !== 'undefined' && (state === 'play' || state === 'paused' || state === 'dead');

  /* ---------- which map meshes take a lightmap (the SAME rule at bake time and at run time) ---------- */
  const visChain = o => { for (let q = o; q; q = q.parent) if (!q.visible) return false; return true; };
  function isRecv(o) {
    if (!o.isMesh || o.isSkinnedMesh || o.isInstancedMesh || o.isPoints || o.isLine || o.isSprite) return false;
    if (Array.isArray(o.material) || !visChain(o)) return false;
    const m = o.material, g = o.geometry;
    if (!m || !m.isMeshStandardMaterial || m.isMeshPhysicalMaterial || m.transparent || m.opacity < .99 || m.isShaderMaterial) return false;
    if (!g || !g.attributes.position || !g.attributes.normal || g.morphAttributes.position) return false;
    if ((g.index ? g.index.count : g.attributes.position.count) < 3) return false;
    if (o.userData.noProbe || o.userData.s9nolm) return false;
    // the endless ground outside the walls is not part of the arena (it would eat the whole atlas)
    if (!g.boundingBox) g.computeBoundingBox();
    const bb = g.boundingBox.clone().applyMatrix4(o.matrixWorld), lim = (typeof HALF !== 'undefined' ? HALF : 40) * 2 + 20;
    return bb.max.x - bb.min.x <= lim && bb.max.z - bb.min.z <= lim;
  }
  const corners = g => g.index ? g.index.count : g.attributes.position.count;
  function keyOf(o) {
    const g = o.geometry; if (!g.boundingBox) g.computeBoundingBox();
    const c = g.boundingBox.clone().applyMatrix4(o.matrixWorld).getCenter(new T.Vector3());
    return o.material.type + '|' + corners(g) + '|' + c.x.toFixed(1) + ',' + c.y.toFixed(1) + ',' + c.z.toFixed(1);
  }
  function receivers() {
    MAPROOT.updateMatrixWorld(true);
    const out = [], seen = {};
    MAPROOT.traverse(o => { if (!isRecv(o)) return; let k = keyOf(o); seen[k] = (seen[k] || 0) + 1; if (seen[k] > 1) k += '#' + seen[k]; out.push({ o, key: k }); });
    return out;
  }

  /* ---------- bake export (render/look/export_lm.js calls this in a headless game) ---------- */
  function avgTex(t) {
    try { const im = t && t.image; if (!im) return [1, 1, 1];
      const cv = document.createElement('canvas'); cv.width = cv.height = 16; const c = cv.getContext('2d', { willReadFrequently: true }); c.drawImage(im, 0, 0, 16, 16);
      const d = c.getImageData(0, 0, 16, 16).data, s = [0, 0, 0]; for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) { const v = d[i + k] / 255; s[k] += v <= .04045 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }
      return s.map(v => v / 256);
    } catch (e) { return [.5, .5, .5]; }
  }
  function exportGeo() {
    const R = receivers(), mats = [], mi = new Map(), meshes = [], f = [];
    const v = new T.Vector3(), nm = new T.Matrix3();
    const idx = [];
    const pushMesh = o => {   // per vertex (position + normal, world space) in the geometry's own order, plus its index list
      const g = o.geometry, P = g.attributes.position, N = g.attributes.normal, I = g.index, vstart = f.length / 6, istart = idx.length;
      nm.getNormalMatrix(o.matrixWorld);
      for (let j = 0; j < P.count; j++) { v.fromBufferAttribute(P, j).applyMatrix4(o.matrixWorld); f.push(v.x, v.y, v.z); v.fromBufferAttribute(N, j).applyMatrix3(nm).normalize(); f.push(v.x, v.y, v.z); }
      if (I) for (let i = 0; i < I.count; i++) idx.push(I.getX(i));
      return { vstart, verts: P.count, istart, icount: I ? I.count : 0 };
    };
    for (const { o, key } of R) {
      const m = o.material; let id = mi.get(m);
      if (id === undefined) { const a = m.map ? avgTex(m.map) : [1, 1, 1]; id = mats.length; mi.set(m, id);
        mats.push({ name: m.name || m.type, albedo: [m.color.r * a[0], m.color.g * a[1], m.color.b * a[2]], metal: m.metalness, rough: m.roughness, env: m.envMapIntensity, emissive: m.emissive ? [m.emissive.r * m.emissiveIntensity, m.emissive.g * m.emissiveIntensity, m.emissive.b * m.emissiveIntensity] : [0, 0, 0] }); }
      meshes.push(Object.assign({ key, mat: id }, pushMesh(o)));
    }
    const f2 = [];   // occluders + emitters: positions only
    const emit = [], occl = [], recvSet = new Set(R.map(r => r.o));
    const v2 = new T.Vector3(), IM = new T.Matrix4(), M = new T.Matrix4();
    MAPROOT.traverse(o => {
      if (!o.isMesh || o.isSkinnedMesh || recvSet.has(o) || !visChain(o) || Array.isArray(o.material)) return;
      const m = o.material, g = o.geometry; if (!g || !g.attributes.position) return;
      const glow = m.isMeshBasicMaterial && !m.transparent && m.blending === T.NormalBlending && Math.max(m.color.r, m.color.g, m.color.b) > 1.05;
      const solid = !m.transparent && m.visible !== false && (m.isMeshStandardMaterial || m.isMeshLambertMaterial || m.isMeshPhongMaterial) && m.opacity > .6;
      if (!glow && !solid) return;
      const P = g.attributes.position, I = g.index, n = corners(g), cnt = o.isInstancedMesh ? o.count : 1, start = f2.length / 3;
      for (let k = 0; k < cnt; k++) { M.copy(o.matrixWorld); if (o.isInstancedMesh) { o.getMatrixAt(k, IM); M.multiply(IM); }
        for (let i = 0; i < n; i++) { v2.fromBufferAttribute(P, I ? I.getX(i) : i).applyMatrix4(M); f2.push(v2.x, v2.y, v2.z); } }
      (glow ? emit : occl).push({ start, corners: n * cnt, color: glow ? [m.color.r, m.color.g, m.color.b] : null, name: o.name || m.type });
    });
    let hemi = null; scene.traverse(o => { if (o.isHemisphereLight && !hemi && visChain(o)) hemi = { sky: [o.color.r, o.color.g, o.color.b], ground: [o.groundColor.r, o.groundColor.g, o.groundColor.b], i: o.intensity }; });
    const sd = sun.position.clone().sub(sun.target.position).normalize();
    // the sky as the player sees it (background cube) -> equirect float image for the Blender world
    let sky = null;
    try {
      const bg = scene.background; if (bg && bg.isTexture) {
        const W = 128, H = 64, rt = new T.WebGLRenderTarget(W, H, { type: T.FloatType }), sc = new T.Scene(), cam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        const mat = new T.ShaderMaterial({ uniforms: { c: { value: bg } }, vertexShader: 'varying vec2 vU; void main(){ vU = uv; gl_Position = vec4(position.xy, 0., 1.); }',
          fragmentShader: 'uniform samplerCube c; varying vec2 vU; void main(){ float ph = (vU.x - .5) * 6.2831853, th = (vU.y - .5) * 3.14159265; vec3 d = vec3(sin(ph) * cos(th), sin(th), -cos(ph) * cos(th)); gl_FragColor = vec4(textureCube(c, d).rgb, 1.); }' });
        sc.add(new T.Mesh(new T.PlaneGeometry(2, 2), mat)); const prev = renderer.getRenderTarget(); renderer.setRenderTarget(rt); renderer.render(sc, cam); renderer.setRenderTarget(prev);
        const px = new Float32Array(W * H * 4); renderer.readRenderTargetPixels(rt, 0, 0, W, H, px); rt.dispose(); mat.dispose();
        sky = { w: W, h: H, px: Array.from(px, x => Math.round(x * 1e4) / 1e4), note: 'u: azimuth from -z (three) clockwise, v: elevation -90..90, rows bottom-up' };
      }
    } catch (e) { sky = null; }
    return { map: typeof CUR_MAP !== 'undefined' ? CUR_MAP : null, half: typeof HALF !== 'undefined' ? HALF : 32, mats, meshes, emit, occl,
      sun: { dir: [sd.x, sd.y, sd.z], color: [sun.color.r, sun.color.g, sun.color.b], i: sun.intensity }, hemi, sky,
      exposure: grade.uniforms.uExposure.value, data: Array.from(new Float32Array(f), x => Math.round(x * 1e4) / 1e4), index: idx, occData: Array.from(new Float32Array(f2), x => Math.round(x * 1e4) / 1e4) };
  }

  /* ---------- shared uniforms (one object in every patched shader: a tier change never recompiles) ---------- */
  const blank = new T.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1); blank.needsUpdate = true;
  const U = { s9LkTex: { value: blank }, s9LkK: { value: 0 }, s9LkM: { value: 2 }, s9LkEnv: { value: .35 }, s9LkSpec: { value: .6 }, s9LkOpen: { value: .5 }, s9LkGain: { value: 1 } };
  const VS_PARS = '\nattribute vec2 s9lm; attribute vec3 s9vl; varying vec2 vS9L; varying vec3 vS9V;';
  const FS_PARS = '\nuniform sampler2D s9LkTex; uniform float s9LkK, s9LkM, s9LkEnv, s9LkSpec, s9LkOpen, s9LkGain; varying vec2 vS9L; varying vec3 vS9V; float s9lkOn = 0.0, s9lkOcc = 1.0;';
  // before the map's light maps: swap the flat ambient (ambient + hemisphere, already in `irradiance`) for the baked light
  const LM_CODE = `
s9lkOn = (s9LkK > 0.001 && (vS9L.x >= 0.0 || vS9L.x < -1.5)) ? 1.0 : 0.0;   // u >= 0: lightmap texture, u = -2: light per vertex, u = -1: none
if (s9lkOn > 0.5) {
  vec3 s9lk = vS9L.x < -1.5 ? vS9V : texture2D(s9LkTex, vS9L).rgb; s9lk = s9lk * s9lk * s9LkM * s9LkGain;      // stored as sqrt(light / M)
  irradiance = mix(irradiance, s9lk * PI, s9LkK);
  s9lkOcc = clamp(dot(s9lk, vec3(.2126, .7152, .0722)) / s9LkOpen, 0.0, 1.0);
}`;
  const LM_AFTER = `
if (s9lkOn > 0.5) { iblIrradiance *= mix(1.0, s9LkEnv, s9LkK); radiance *= mix(1.0, mix(1.0, s9lkOcc, s9LkSpec), s9LkK); }`;
  function patchShader(sh) {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>' + VS_PARS).replace('#include <begin_vertex>', '#include <begin_vertex>\nvS9L = s9lm; vS9V = s9vl;');
    let fs = sh.fragmentShader.replace('#include <common>', '#include <common>' + FS_PARS)
      .replace('#include <lights_fragment_maps>', LM_CODE + '\n#include <lights_fragment_maps>')
      .replace('#include <lights_fragment_end>', LM_AFTER + '\n#include <lights_fragment_end>');   // after graphics.js's map probe
    // graphics.js baked AO volume: the lightmap already holds this spot's occlusion
    fs = fs.replace('if (s9AOStr > 0.001) {', 'if (s9AOStr > 0.001 && s9lkOn < 0.5) {');
    sh.fragmentShader = fs;
    patchMacro(sh);
  }
  const baseHook = () => T.MeshStandardMaterial.prototype.onBeforeCompile, baseKey = () => T.MeshStandardMaterial.prototype.customProgramCacheKey;
  function flagMat(m) {
    if (m.userData.lk) return false;
    const prevHook = Object.prototype.hasOwnProperty.call(m, 'onBeforeCompile') ? m.onBeforeCompile : null;
    const prevKey = Object.prototype.hasOwnProperty.call(m, 'customProgramCacheKey') ? m.customProgramCacheKey : null;
    m.onBeforeCompile = function (sh, r) { (prevHook || baseHook()).call(this, sh, r); patchShader(sh); };
    m.customProgramCacheKey = function () { return String((prevKey || baseKey()).call(this)) + '|lk1'; };
    m.userData.lk = 1; m.needsUpdate = true; L.mats++;
    return true;
  }

  /* ---------- per-map data ---------- */
  const DATA = {}, ASSETS = {};
  async function getData(id) {
    if (DATA[id] !== undefined) return DATA[id];
    try { const r = await fetch('data/look/' + id + '.json', { cache: 'no-cache' }); DATA[id] = r.ok ? await r.json() : null; } catch (e) { DATA[id] = null; }
    return DATA[id];
  }
  const texLoad = (url, srgb, flip = true) => new Promise(res => new T.TextureLoader().load(url, t => { t.encoding = srgb ? T.sRGBEncoding : T.LinearEncoding; t.flipY = flip; res(t); }, undefined, () => res(null)));
  async function getAssets(id, D) {
    if (ASSETS[id]) return ASSETS[id];
    const base = 'assets/look/' + id + '/', A = { lm: null, uv: null, lut: null, decal: null, pbr: {} };
    const jobs = [];
    if (D.lightmap) {
      jobs.push(texLoad(base + D.lightmap.image, false).then(t => { if (t) { t.wrapS = t.wrapT = T.ClampToEdgeWrapping; t.minFilter = T.LinearMipmapLinearFilter; t.magFilter = T.LinearFilter; } A.lm = t; }));
      if (D.lightmap.vl) jobs.push(fetch(base + D.lightmap.vl).then(r => r.ok ? r.arrayBuffer() : null).then(b => { A.vl = b ? new Uint8Array(b) : null; }).catch(() => {}));
      jobs.push(fetch(base + D.lightmap.uv).then(r => r.ok ? r.arrayBuffer() : null).then(b => { A.uv = b ? new Uint16Array(b) : null; }).catch(() => {}));
    }
    if (D.lut) jobs.push(texLoad(base + D.lut.image, false, false).then(t => { if (t) { t.minFilter = t.magFilter = T.LinearFilter; t.generateMipmaps = false; t.wrapS = t.wrapT = T.ClampToEdgeWrapping; } A.lut = t; }));
    if (D.backdrop) jobs.push(texLoad(base + D.backdrop.image, false).then(t => { if (t) { t.wrapS = T.RepeatWrapping; t.wrapT = T.ClampToEdgeWrapping; t.anisotropy = 4; } A.bd = t; }));
    if (D.props && D.props.signs) jobs.push(texLoad(base + D.props.signs.image, true).then(t => { if (t) t.anisotropy = 8; A.signs = t; }));
    if (D.ground && D.ground.puddleMask) jobs.push(texLoad(base + D.ground.puddleMask, false).then(t => { A.puddle = t; }));
    if (D.ground && D.ground.paintImage) jobs.push(texLoad(base + D.ground.paintImage, true).then(t => { if (t) t.anisotropy = 8; A.paint = t; }));
    if (D.inside && D.inside.skinImage) jobs.push(texLoad(base + D.inside.skinImage, true).then(t => { if (t) t.anisotropy = 8; A.skins = t; }));
    if (D.outside && D.outside.ground) { const p2 = 'assets/tex/hd/' + D.outside.ground.set; jobs.push(Promise.all([texLoad(p2 + '_diff.jpg', true), texLoad(p2 + '_nor_gl.jpg', false), texLoad(p2 + '_arm.jpg', false)]).then(([d, n, a]) => { if (d && n && a) { for (const t of [d, n, a]) { t.wrapS = t.wrapT = T.RepeatWrapping; t.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy()); } A.outer = { d, n, a }; } })); }
    if (D.decals) jobs.push(texLoad(base + D.decals.image, true).then(t => { if (t) { t.wrapS = t.wrapT = T.ClampToEdgeWrapping; t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy()); } A.decal = t; }));
    for (const [slot, set] of Object.entries(D.pbr || {})) {
      const p = 'assets/tex/hd/' + set;
      jobs.push(Promise.all([texLoad(p + '_diff.jpg', true), texLoad(p + '_nor_gl.jpg', false), texLoad(p + '_arm.jpg', false)]).then(([d, n, a]) => { if (d && n && a) { for (const t of [d, n, a]) { t.wrapS = t.wrapT = T.RepeatWrapping; t.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy()); } A.pbr[slot] = { d, n, a }; } }));
    }
    await Promise.all(jobs);
    return (ASSETS[id] = A);
  }

  /* ---------- lightmap: UVs onto the meshes, patch their materials ---------- */
  function applyLightmap(D, A) {
    const lm = D.lightmap; if (!lm || !A.lm || !A.uv) { L.notes.push('no lightmap assets'); return; }
    const R = receivers(), byKey = new Map(lm.meshes.map(x => [x.key, x])), mats = new Set();
    L.recv = R.length; L.matched = 0; L.missed = 0;
    for (const { o, key } of R) {
      const e = byKey.get(key);
      const g = o.geometry, nv = g.attributes.position.count;
      if (!e || e.verts !== nv || e.icount !== (g.index ? g.index.count : 0)) { L.missed++; o.userData.s9lmMiss = key; continue; }
      if (e.vl !== undefined) { if (!A.vl) { L.missed++; continue; } g.setAttribute('s9vl', new T.BufferAttribute(A.vl.subarray(e.vl * 3, (e.vl + nv) * 3), 3, true)); g.setAttribute('s9lm', new T.BufferAttribute(new Float32Array(nv * 2).fill(-2), 2)); }
      else { g.setAttribute('s9lm', new T.BufferAttribute(A.uv.subarray(e.offset * 2, (e.offset + nv) * 2), 2, true)); g.setAttribute('s9vl', new T.BufferAttribute(new Uint8Array(nv * 3), 3, true)); }
      mats.add(o.material); L.matched++;
    }
    // any other mesh drawing with a patched material reads "no lightmap here" (u < 0) and keeps the old ambient
    MAPROOT.traverse(o => { if (o.isMesh && !Array.isArray(o.material) && mats.has(o.material) && !o.geometry.attributes.s9lm) {
      const n = o.geometry.attributes.position.count, a = new Float32Array(n * 2).fill(-1); o.geometry.setAttribute('s9lm', new T.BufferAttribute(a, 2)); o.geometry.setAttribute('s9vl', new T.BufferAttribute(new Uint8Array(n * 3), 3, true)); } });
    for (const m of mats) flagMat(m);
    U.s9LkM.value = lm.scale || 2; U.s9LkEnv.value = lm.env ?? .35; U.s9LkSpec.value = lm.spec ?? .6; U.s9LkOpen.value = lm.open || .5; U.s9LkGain.value = lm.gain || 1;
  }

  /* ---------- PBR sets: same shader, other texture objects (so no recompile) ---------- */
  const ORIG = new WeakMap();
  function pbrTargets(D) {
    // slot -> materials, by the texture set they were built from (ASSET.world names) on this map's meshes
    const want = D.pbr || {}, out = {}, nameOf = new Map();
    try { for (const n of Object.keys(ASSET.world || {})) { const s = ASSET.world[n]; if (s && s.d) nameOf.set(s.d, n); } if (window.S9GFX && S9GFX.hdLoaded) for (const n of Object.keys(S9GFX.hdLoaded)) { const s = S9GFX.hdLoaded[n]; if (s && s.d) nameOf.set(s.d, n); } } catch (e) {}
    MAPROOT.traverse(o => { if (!o.isMesh || Array.isArray(o.material)) return; const m = o.material; if (!m || !m.map) return;
      const n = ORIG.has(m) ? ORIG.get(m).name : nameOf.get(m.map); if (n && want[n]) (out[n] = out[n] || new Set()).add(m); });
    return out;
  }
  function applyPBR(D, A, hd) {
    const tg = pbrTargets(D);
    for (const [slot, set] of Object.entries(tg)) {
      const P = A.pbr[slot], tile = (D.pbrTile && D.pbrTile[slot]) || 1;
      for (const m of set) {
        if (!ORIG.has(m)) ORIG.set(m, { name: slot, map: m.map, normalMap: m.normalMap, roughnessMap: m.roughnessMap, metalnessMap: m.metalnessMap, aoMap: m.aoMap });
        const o = ORIG.get(m), use = hd && P;
        const put = (k, t) => { if (!m[k] && !o[k]) return; if (!t) return; if (t !== o[k] && o[k]) { t.repeat.copy(o[k].repeat).multiplyScalar(1 / tile); t.offset.copy(o[k].offset); } m[k] = t; };
        put('map', use ? P.d : o.map); put('normalMap', use ? P.n : o.normalMap);
        put('roughnessMap', use ? P.a : o.roughnessMap); put('metalnessMap', use ? P.a : o.metalnessMap); put('aoMap', use ? P.a : o.aoMap);
      }
    }
    L.pbr = Object.values(tg).reduce((a, x) => a + x.size, 0); L.pbrHd = !!hd && L.pbr > 0;
    for (const P of Object.values(A.pbr)) for (const t of [P.d, P.n, P.a]) { try { renderer.initTexture(t); } catch (e) {} }
  }

  /* ---------- decals: one mesh, multiply blend, atlas cells, placements from data ---------- */
  let decalMesh = null, EXTRA = [];
  /* ---------- extension registry (docs/agents/maps/yard_STYLE.md section 10): specialists build in their OWN modules ----------
     window.S9LOOK_EXT = [{ name, maps, replaces:[keys], patch(D, map), async build(ctx) -> Object3D[], tier(on, tierName) }]
     replace keys: decals, backdrop:glow|far|city|near|clouds|ships, props, lib:in, lib:out, city, inside, air, outer, puddles, paint, pools, macro */
  let SKIP = new Set(), EXTS = [];   // active for the current map
  const skip = k => SKIP.has(k);
  const extsFor = id => (Array.isArray(window.S9LOOK_EXT) ? window.S9LOOK_EXT : []).filter(e => e && e.name && (!e.maps || e.maps.includes(id) || e.maps.includes('*')));
  const PATCHED = new WeakMap();   // data object -> names of the extensions that already patched it (DATA is cached: patch once)
  const LIGHTS = {};
  async function getLights(id) {
    if (LIGHTS[id] !== undefined) return LIGHTS[id];
    try { const r = await fetch('data/look/' + id + '/lights.json', { cache: 'no-cache' }); LIGHTS[id] = r.ok ? await r.json() : null; } catch (e) { LIGHTS[id] = null; }
    return LIGHTS[id];
  }
  const loadGLB = url => new Promise(res => { try { if (!T.GLTFLoader) return res(null); new T.GLTFLoader().load(url, g => res(g), undefined, () => res(null)); } catch (e) { res(null); } });
  function extTier(on) { for (const e of EXTS) if (e.tier && e.__built) { try { e.tier(on, tierNow()); } catch (er) { L.notes.push('ext ' + e.name + ' tier: ' + er.message); } } }
  // dev loader: specialists' modules load without manifest edits (404-tolerant; the integrator may move them into manifest.json later)
  const DEV_MODS = ['lookprops', 'looksurf', 'lookworld', 'lookair'];
  const devHost = (() => { try { return /^(localhost|127\.0\.0\.1)$/.test(location.hostname) || localStorage.getItem('sector9-lookdev') === '1'; } catch (e) { return false; } })();
  const devLoad = Promise.all((devHost ? DEV_MODS : []).map(n => new Promise(res => {
    try { if (document.querySelector('script[data-s9look="' + n + '"]') || (window.S9LOOK_EXT || []).some(e => e && e.module === n)) return res();
      const sc = document.createElement('script'); sc.src = 'modules/' + n + '.js?t=' + Date.now(); sc.async = false; sc.dataset.s9look = n;
      sc.onload = () => res(); sc.onerror = () => res(); document.head.appendChild(sc); setTimeout(res, 8000);
    } catch (e) { res(); } })));
  const DECAL_VS = `
attribute vec4 dA; varying vec2 vU; varying float vF; varying float vK;
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uFade;
void main(){ vU = uv; vK = dA.x; vec4 mv = modelViewMatrix * vec4(position, 1.0); vF = 1.0 - smoothstep(uFade * 0.55, uFade, -mv.z); gl_Position = projectionMatrix * mv;
#include <logdepthbuf_vertex>
}`;
  const DECAL_FS = `
uniform sampler2D uAtlas; uniform float uK; varying vec2 vU; varying float vF; varying float vK;
#include <common>
#include <logdepthbuf_pars_fragment>
void main(){
#include <logdepthbuf_fragment>
  vec4 t = texture2D(uAtlas, vU); float a = clamp(t.a * vK * vF * uK, 0.0, 1.0);
  gl_FragColor = vec4(mix(vec3(1.0), t.rgb, a), 1.0); }`;
  function buildDecals(D, A) {
    if (decalMesh) { MAPROOT.remove(decalMesh); decalMesh.geometry.dispose(); decalMesh = null; }
    const dd = D.decals; if (!dd || !A.decal || !dd.list || !dd.list.length) return;
    const cols = dd.grid[0], rows = dd.grid[1], P = [], UV = [], DA = [], IDX = [];
    const n = new T.Vector3(), t = new T.Vector3(), b = new T.Vector3(), c = new T.Vector3(), up = new T.Vector3();
    for (const d of dd.list) {
      // d = [cell, x, y, z, nx, ny, nz, w, h, rot, strength]
      const [cell, x, y, z, nx, ny, nz, w, h, rot, k] = d;
      n.set(nx, ny, nz).normalize(); up.set(0, 1, 0); if (Math.abs(n.y) > .9) up.set(0, 0, 1);
      t.crossVectors(up, n).normalize(); b.crossVectors(n, t).normalize();
      const cr = Math.cos(rot || 0), sr = Math.sin(rot || 0), tx = t.clone().multiplyScalar(cr).addScaledVector(b, sr), bx = b.clone().multiplyScalar(cr).addScaledVector(t, -sr);
      c.set(x, y, z).addScaledVector(n, .012);
      const u0 = (cell % cols) / cols, v0 = 1 - (Math.floor(cell / cols) + 1) / rows, du = 1 / cols, dv = 1 / rows, base = P.length / 3;
      for (const [sx, sy, uu, vv] of [[-1, -1, 0, 0], [1, -1, 1, 0], [1, 1, 1, 1], [-1, 1, 0, 1]]) {
        P.push(c.x + tx.x * sx * w / 2 + bx.x * sy * h / 2, c.y + tx.y * sx * w / 2 + bx.y * sy * h / 2, c.z + tx.z * sx * w / 2 + bx.z * sy * h / 2);
        UV.push(u0 + (uu * .96 + .02) * du, v0 + (vv * .96 + .02) * dv); DA.push(k ?? 1, 0, 0, 0);
      }
      IDX.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(P, 3)); g.setAttribute('uv', new T.Float32BufferAttribute(UV, 2)); g.setAttribute('dA', new T.Float32BufferAttribute(DA, 4)); g.setIndex(IDX);
    g.computeBoundingSphere();
    const mat = new T.ShaderMaterial({ uniforms: { uAtlas: { value: A.decal }, uK: { value: dd.strength || 1 }, uFade: { value: dd.fade || 60 } }, vertexShader: DECAL_VS, fragmentShader: DECAL_FS,
      transparent: true, depthWrite: false, blending: T.MultiplyBlending, premultipliedAlpha: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    decalMesh = new T.Mesh(g, mat); decalMesh.name = 's9look-decals'; decalMesh.renderOrder = 2; decalMesh.userData.noProbe = true; decalMesh.userData.dyn = true; decalMesh.frustumCulled = false; decalMesh.matrixAutoUpdate = false;
    MAPROOT.add(decalMesh); L.decals = dd.list.length;
  }


  /* ---------- the world outside: layered impostor backdrop (mountains, city, industry, clouds) + ships, ONE draw call ----------
     Cylinder-segment layers far beyond the walls, drawn far -> near in one mesh (index order = blend order). Each layer is tinted
     toward the sky colour behind it by its depth (atmospheric perspective: the sky cube itself is sampled in the view direction),
     windows flicker, beacons blink, clouds drift, ships cross the sky - all in the shader from one time uniform (no per-frame CPU work). */
  const BD_VS = `
attribute vec4 aK; attribute vec4 aS; uniform float uT; varying vec2 vU; varying vec4 vK; varying vec3 vD; varying float vB;
void main(){ vU = uv; vK = aK; vec3 p = position;
  if (aK.x > 2.5) {
    float a = aS.w + uT * aS.z; vec3 c = vec3(cos(a) * aS.x, aS.y + sin(uT * .21 + aS.w) * 4.0, sin(a) * aS.x);
    vec3 r = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]), u = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    p = c + (r * (uv.x - .5) * 3.0 + u * (uv.y - .5) * 1.2) * (1.0 + aS.x * .004); vB = fract(uT * .7 + aS.w);
  } else vB = 0.0;
  vec4 w = modelMatrix * vec4(p, 1.0); vD = w.xyz - cameraPosition; gl_Position = projectionMatrix * viewMatrix * w; gl_Position.z = gl_Position.w * .9999; }`;
  const BD_FS = `
uniform sampler2D uAt; uniform samplerCube uSky; uniform float uT, uHasSky, uGain; uniform vec3 uFog, uWin, uBeacon, uGlow;
varying vec2 vU; varying vec4 vK; varying vec3 vD; varying float vB;
void main(){
  vec3 d = normalize(vD); vec3 sky = uHasSky > .5 ? textureCube(uSky, vec3(-d.x, d.y, d.z)).rgb : uFog;
  if (vK.x > 3.5) { float g = pow(1.0 - vU.y, 2.2); gl_FragColor = vec4(uGlow * g, g * .7); return; }   // horizon glow of the port
  if (vK.x > 2.5) { vec2 q = vU - .5; float body = step(abs(q.x), .42) * smoothstep(.45, .2, abs(q.y)); float bl = step(.86, vB);
    vec3 c = mix(vec3(.02), sky, .55) * body + uBeacon * bl * exp(-dot(q - vec2(.38, 0.), q - vec2(.38, 0.)) * 400.) * 6.0 + uWin * exp(-dot(q * vec2(3., 8.), q * vec2(3., 8.)) * 6.) * .6;
    float a = max(body * .9, bl * .9); if (a < .01) discard; gl_FragColor = vec4(c, a); return; }
  vec2 uv = vec2(vU.x + (vK.x > 1.5 ? uT * vK.w : 0.0), (vK.y + vU.y) * .25);
  vec4 t = texture2D(uAt, uv);
  float haze = vK.z;
  if (vK.x > 1.5) { float a = t.r * .55; if (a < .01) discard; gl_FragColor = vec4(sky * (1.05 + .25 * t.r), a); return; }
  float m = t.r; if (m < .02) discard;
  vec3 sil = mix(sky * .18 + vec3(.004), sky, haze);
  float fl = .75 + .25 * sin(uT * (1.0 + t.a * 3.0) + t.a * 40.0);
  vec3 wcol = t.a > .9 ? vec3(2.2, .5, 1.8) : t.a > .78 ? vec3(.5, 1.5, 2.1) : t.a > .5 ? uWin : uWin * vec3(1.1, .85, .6);
  vec3 c = sil + wcol * t.g * m * fl * (1.0 - haze * .75) * uGain + uBeacon * t.b * step(.5, fract(uT * .55 + vU.x * 7.0)) * 4.0 * (1.0 - haze * .5);
  gl_FragColor = vec4(c, m); }`;
  function buildBackdrop(D, A) {
    const B = D.backdrop; if (!B || !A.bd) return null;
    const P = [], UV = [], K = [], S = [], I = [];
    const quad = (vs, uvs, k, sv) => { const n = P.length / 3; for (let i = 0; i < 4; i++) { P.push(...vs[i]); UV.push(...uvs[i]); K.push(...k); S.push(...(sv || [0, 0, 0, 0])); } I.push(n, n + 1, n + 2, n, n + 2, n + 3); };
    const layers = B.layers.filter(l => !skip('backdrop:' + l.kind)), ships = skip('backdrop:ships') ? 0 : (B.ships || 0);
    if (!layers.length && !ships) return null;
    for (const L0 of layers.slice().sort((a, b) => b.r - a.r)) {   // far -> near = blend order
      const seg = L0.seg || 96, k = [L0.kind === 'glow' ? 4 : L0.kind === 'clouds' ? 2 : 1, L0.row, L0.haze, L0.speed || 0], rot = L0.rot || 0;
      for (let i = 0; i < seg; i++) {
        const a0 = rot + i / seg * Math.PI * 2, a1 = rot + (i + 1) / seg * Math.PI * 2, u0 = i / seg * L0.tile, u1 = (i + 1) / seg * L0.tile;
        const x0 = Math.cos(a0) * L0.r, z0 = Math.sin(a0) * L0.r, x1 = Math.cos(a1) * L0.r, z1 = Math.sin(a1) * L0.r, y0 = L0.y, y1 = L0.y + L0.h;
        quad([[x0, y0, z0], [x1, y0, z1], [x1, y1, z1], [x0, y1, z0]], [[u0, 0], [u1, 0], [u1, 1], [u0, 1]], k);
      }
    }
    for (let i = 0; i < ships; i++) { const r = 140 + (i * 47) % 260, alt = 38 + (i * 23) % 60, sp = (i % 2 ? 1 : -1) * (.012 + (i % 3) * .006);
      quad([[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]], [[0, 0], [1, 0], [1, 1], [0, 1]], [3, 0, 0, 0], [r, alt, sp, i * 1.7]); }
    const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(P, 3)); g.setAttribute('uv', new T.Float32BufferAttribute(UV, 2));
    g.setAttribute('aK', new T.Float32BufferAttribute(K, 4)); g.setAttribute('aS', new T.Float32BufferAttribute(S, 4)); g.setIndex(I);
    const bg = scene.background, hasSky = !!(bg && bg.isTexture && bg.isCubeTexture);
    const fogC = scene.fog ? scene.fog.color : new T.Color(.2, .2, .25);
    const mat = new T.ShaderMaterial({ uniforms: { uAt: { value: A.bd }, uSky: { value: hasSky ? bg : null }, uHasSky: { value: hasSky ? 1 : 0 }, uT: { value: 0 }, uGain: { value: B.gain || 1 },
      uFog: { value: new T.Color().copy(fogC) }, uWin: { value: new T.Color(...(B.win || [1.6, 1.1, .6])) }, uBeacon: { value: new T.Color(...(B.beacon || [3, .2, .1])) }, uGlow: { value: new T.Color(...(B.glow || [1.2, .45, .3])) } },
      vertexShader: BD_VS, fragmentShader: BD_FS, transparent: true, depthWrite: false, side: T.DoubleSide });
    const m = new T.Mesh(g, mat); m.name = 's9look-backdrop'; m.frustumCulled = false; m.renderOrder = -5; m.userData.noProbe = true; m.userData.dyn = true; m.userData.s9nolm = true;
    m.onBeforeRender = () => { mat.uniforms.uT.value = (performance.now() / 1000) % 3600; };
    return m;
  }

  /* ---------- wall detail: pipe runs + sagging cables, signage panels (data: props.pipes / props.signs), 2 draw calls ---------- */
  function buildProps(D, A) {
    const Pp = D.props; if (!Pp) return [];
    const out = [], geos = [], up = new T.Vector3(0, 1, 0);
    for (const r of Pp.pipes || []) {   // [x0,y0,z0, x1,y1,z1, radius, sag]
      const a = new T.Vector3(r[0], r[1], r[2]), b = new T.Vector3(r[3], r[4], r[5]), rad = r[6], sag = r[7] || 0, L = a.distanceTo(b);
      const pts = []; const n = sag ? 16 : 1; for (let i = 0; i <= n; i++) { const t = i / n; pts.push(a.clone().lerp(b, t).addScaledVector(up, -sag * 4 * t * (1 - t))); }
      geos.push(new T.TubeGeometry(new T.CatmullRomCurve3(pts), sag ? 24 : 1, rad, rad > .06 ? 10 : 5, false));
      if (!sag && rad > .06) for (let t = 1; t < L; t += 2.4) { const c = a.clone().lerp(b, t / L), br = new T.BoxGeometry(rad * 2.8, rad * 2.8, .1); br.lookAt(b.clone().sub(a)); br.translate(c.x, c.y, c.z); geos.push(br); }
    }
    if (geos.length) {
      const list = geos.map(g => { const q = g.index ? g.toNonIndexed() : g; for (const k of Object.keys(q.attributes)) if (!['position', 'normal', 'uv'].includes(k)) q.deleteAttribute(k); return q; });
      const g = T.BufferGeometryUtils.mergeBufferGeometries(list);
      const m = new T.Mesh(g, new T.MeshStandardMaterial({ color: new T.Color(...(Pp.pipeColor || [.32, .33, .35])), roughness: .45, metalness: .8, envMapIntensity: .8 }));
      m.name = 's9look-pipes'; m.castShadow = false; m.receiveShadow = true; m.userData.noProbe = true; m.userData.dyn = true; m.userData.s9nolm = true; out.push(m);
    }
    const SG = Pp.signs; if (SG && A.signs && SG.list && SG.list.length) {   // [cell, x, y, z, nx, nz, w, h]
      const P = [], UV = [], I = [], cols = SG.grid[0], rows = SG.grid[1];
      for (const s0 of SG.list) { const [cell, x, y, z, nx, nz, w, h] = s0, n = new T.Vector3(nx, 0, nz).normalize(), t = new T.Vector3(0, 1, 0).cross(n).normalize(), c = new T.Vector3(x, y, z).addScaledVector(n, .03);
        const u0 = (cell % cols) / cols, v0 = 1 - (Math.floor(cell / cols) + 1) / rows, b0 = P.length / 3;
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { P.push(c.x + t.x * sx * w / 2, c.y + sy * h / 2, c.z + t.z * sx * w / 2); UV.push(u0 + (sx + 1) / 2 / cols, v0 + (sy + 1) / 2 / rows); }
        I.push(b0, b0 + 1, b0 + 2, b0, b0 + 2, b0 + 3); }
      const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(P, 3)); g.setAttribute('uv', new T.Float32BufferAttribute(UV, 2)); g.setIndex(I);
      const m = new T.Mesh(g, new T.MeshBasicMaterial({ map: A.signs, color: new T.Color(...(SG.glow || [2.2, 2.2, 2.2])), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 }));
      m.name = 's9look-signs'; m.userData.noProbe = true; m.userData.dyn = true; m.renderOrder = 3; out.push(m);
    }
    return out;
  }


  /* ---------- prop library (data/look/props_lib.json recipes) placed by data: merged into 2 meshes (lit + glowing) ----------
     placement = [type, x, y, z, rotY, scale, brand colour index, accent colour index, wear 0..1]; every copy gets its own colour jitter + wear */
  let LIB = null;
  async function getLib() { if (LIB !== null) return LIB; try { const r = await fetch('data/look/props_lib.json', { cache: 'no-cache' }); LIB = r.ok ? (await r.json()).types : {}; } catch (e) { LIB = {}; } return LIB; }
  function buildLib(D) {
    const P = D.place; if (!P || !LIB) return [];
    const lit = [], glow = [], M4 = new T.Matrix4(), Q = new T.Matrix4(), S4 = new T.Matrix4(), BR = D.palette.brand, AC = D.palette.accent;
    let st = 77; const rnd = () => { st = (st * 1664525 + 1013904223) >>> 0; return st / 4294967296; };
    for (const [type, x, y, z, ry, sc, bi, ai, wear] of P) {
      const parts = LIB[type]; if (!parts) continue;
      M4.makeRotationY(ry || 0).setPosition(x, y || 0, z); S4.makeScale(sc || 1, sc || 1, sc || 1); M4.multiply(S4);
      for (const [sh, sx, sy, sz, px, py, pz, pr, col, em] of parts) {
        const g = sh === 'c' ? new T.CylinderGeometry(sx, sx, sy, sz || 10) : new T.BoxGeometry(sx, sy, sz);
        Q.makeRotationY(pr || 0).setPosition(px, py, pz); g.applyMatrix4(Q); g.applyMatrix4(M4);
        const c = col === 'B' ? BR[bi % BR.length] : col === 'A' ? AC[ai % AC.length] : col, j = em ? 1 : (1 - (wear || 0) * .35 * rnd()) * (.9 + .2 * rnd());
        const n = g.attributes.position.count, cols = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { cols[i * 3] = c[0] * j * (em || 1); cols[i * 3 + 1] = c[1] * j * (em || 1); cols[i * 3 + 2] = c[2] * j * (em || 1); }
        const q = g.toNonIndexed(); q.setAttribute('color', new T.BufferAttribute(cols.length === q.attributes.position.count * 3 ? cols : (() => { const a = new Float32Array(q.attributes.position.count * 3); for (let i = 0; i < a.length; i += 3) { a[i] = cols[0]; a[i + 1] = cols[1]; a[i + 2] = cols[2]; } return a; })(), 3));
        q.deleteAttribute('uv'); (em ? glow : lit).push(q);
      }
    }
    const out = [];
    if (lit.length) { const m = new T.Mesh(T.BufferGeometryUtils.mergeBufferGeometries(lit), new T.MeshStandardMaterial({ vertexColors: true, roughness: .6, metalness: .35, envMapIntensity: .7 }));
      m.name = 's9look-props'; m.castShadow = false; m.receiveShadow = true; m.userData.noProbe = true; m.userData.dyn = true; m.userData.s9nolm = true; out.push(m); }
    if (glow.length) { const m = new T.Mesh(T.BufferGeometryUtils.mergeBufferGeometries(glow), new T.MeshBasicMaterial({ vertexColors: true }));
      m.name = 's9look-glow'; m.userData.noProbe = true; m.userData.dyn = true; m.userData.s9nolm = true; out.push(m); }
    return out;
  }

  /* ---------- 3D city blocks + landmark (real parallax), windows from world position in the shader: 1 draw call ---------- */
  const CITY_VS = `varying vec3 vW; varying vec3 vN; varying vec4 vC; attribute vec4 aC;
void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normal; vC = aC; gl_Position = projectionMatrix * viewMatrix * w; }`;
  const CITY_FS = `uniform samplerCube uSky; uniform float uHasSky, uT; uniform vec3 uFog; varying vec3 vW; varying vec3 vN; varying vec4 vC;
float h1(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main(){
  vec3 d = normalize(vW - cameraPosition); vec3 sky = uHasSky > .5 ? textureCube(uSky, vec3(-d.x, d.y, d.z)).rgb : uFog;
  float dist = length(vW.xz - cameraPosition.xz), haze = clamp((dist - 120.0) / 380.0, 0.0, 1.0) * .78 + .12 + vC.w * .05 - clamp(vW.y / 600.0, 0.0, .1);
  if (vC.w > 1.5) { vec3 e = vC.rgb * (vC.w > 2.5 ? 5.0 * step(.5, fract(uT * .6 + vW.x * .01)) : 2.2); gl_FragColor = vec4(mix(e, sky, clamp((dist - 200.0) / 500.0, 0.0, .6)), 1.0); return; }   // roof holo ads / pad rings / beacons
  vec3 base = vC.rgb * (.55 + .45 * max(vN.y, 0.0)) * (.8 + .4 * h1(vec2(floor(vW.y / 9.3), vC.r * 50.0))) * (.9 + .2 * h1(floor(vW.xz / 4.0)));
  vec3 c = base;
  if (abs(vN.y) < .5) {   // facades: window grid, varied light per window (warm, cool, neon, dark), floors flicker rarely
    float along = abs(vN.x) > .5 ? vW.z : vW.x; vec2 cell = vec2(floor(along / 2.2), floor(vW.y / 3.1)); vec2 f = fract(vec2(along / 2.2, vW.y / 3.1));
    float win = step(.18, f.x) * step(f.x, .82) * step(.25, f.y) * step(f.y, .78);
    float r = h1(cell + vC.rg * 91.0), lit = step(.62, r) * step(.45, h1(vec2(cell.y, vC.b * 77.0))) * (.45 + .55 * h1(cell * 1.7));
    vec3 wc = r > .93 ? vec3(2.4, .5, 1.9) : r > .86 ? vec3(.5, 1.6, 2.2) : r > .7 ? vec3(1.3, 1.25, 1.1) : vec3(1.9, 1.15, .55);
    float fl = .8 + .2 * step(.97, h1(cell + floor(uT * .25)));
    c += wc * win * lit * fl * .7;
  }
  if (vC.w > .9 && vW.y > 160.0) c += vec3(3.0, .4, 2.6) * step(.5, fract(uT * .5)) * 2.0;   // landmark crown
  gl_FragColor = vec4(mix(c, sky, haze), 1.0); }`;
  function buildCity(D) {
    const C = D.city; if (!C || !C.blocks) return null;
    const geos = [], bg = scene.background, hasSky = !!(bg && bg.isTexture && bg.isCubeTexture);
    for (const [x, z, w, dd, h, r, g, b, lm, y0] of C.blocks) {
      const q = new T.BoxGeometry(w, h, dd).toNonIndexed(); q.translate(x, (y0 === undefined ? -2 : y0) + h / 2, z); q.deleteAttribute('uv');
      const n = q.attributes.position.count, a = new Float32Array(n * 4); for (let i = 0; i < n; i++) a.set([r, g, b, lm || 0], i * 4); q.setAttribute('aC', new T.BufferAttribute(a, 4)); geos.push(q);
    }
    const mat = new T.ShaderMaterial({ uniforms: { uSky: { value: hasSky ? bg : null }, uHasSky: { value: hasSky ? 1 : 0 }, uT: { value: 0 }, uFog: { value: new T.Color().copy(scene.fog ? scene.fog.color : new T.Color(.2, .2, .25)) } }, vertexShader: CITY_VS, fragmentShader: CITY_FS });
    const m = new T.Mesh(T.BufferGeometryUtils.mergeBufferGeometries(geos), mat); m.name = 's9look-city'; m.frustumCulled = false; m.userData.noProbe = true; m.userData.dyn = true; m.userData.s9nolm = true;
    m.onBeforeRender = () => { mat.uniforms.uT.value = (performance.now() / 1000) % 3600; };
    return m;
  }

  /* ---------- ground: puddles (mirror the neon through graphics.js's map probe), light pools (additive), paint markings: 3 draw calls ---------- */
  // pools: mode 0 = soft disk (outside lamps, no bake there), mode 1 = wet sheen hugging a wall base (the bake holds the real lamp pool;
  // the ellipse is centred ON the wall base, so the wall hides its inner half). Both get fbm noise in the alpha (no clean disks).
  const POOL_FS = `uniform float uK; varying vec2 vU; varying vec3 vCol; varying vec3 vW; varying float vM;
float ph(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float pn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f); return mix(mix(ph(i), ph(i + vec2(1, 0)), f.x), mix(ph(i + vec2(0, 1)), ph(i + 1.), f.x), f.y); }
void main(){ vec2 q = vU * 2.0 - 1.0; float r = dot(q, q); float n = pn(vW.xz * .9) * .5 + pn(vW.xz * 2.3 + 7.) * .3 + pn(vW.xz * 5.1 - 3.) * .2;
  float a = vM > .5 ? (1.0 - smoothstep(.15, 1.0, r)) * (1.0 + .5 * (n - .5)) : (1.0 - smoothstep(.45, 1.0, r)) * .72 * (exp(-r * 3.4) + .22 / (1.0 + r * 14.0)) * (.55 + .9 * n);   // inverse-square-ish falloff + noise cookie: no plateau, no hard rim
  gl_FragColor = vec4(vCol * max(a, 0.0) * uK, 1.0); }`;
  const POOL_VS = `attribute vec3 aCol; attribute float aM; varying vec2 vU; varying vec3 vCol; varying vec3 vW; varying float vM; void main(){ vU = uv; vCol = aCol; vM = aM; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
  function quads(list, uvOf, extra) {   // list of [x,y,z, w, h, rot] flat on the ground
    const P = [], UV = [], X = [], I = [];
    for (let k = 0; k < list.length; k++) { const [x, y, z, w, h, rot] = list[k], c = Math.cos(rot || 0), s = Math.sin(rot || 0), b = P.length / 3, uv = uvOf(k);
      for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const lx = sx * w / 2, lz = sz * h / 2; P.push(x + lx * c - lz * s, y, z + lx * s + lz * c); UV.push(uv[0] + (sx + 1) / 2 * uv[2], uv[1] + (sz + 1) / 2 * uv[3]); if (extra) X.push(...extra(k)); }
      I.push(b, b + 2, b + 1, b, b + 3, b + 2); }
    const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(P, 3)); g.setAttribute('uv', new T.Float32BufferAttribute(UV, 2)); g.setIndex(I); g.computeVertexNormals();
    return { g, X };
  }
  function buildGround(D, A) {
    const G0 = D.ground; if (!G0) return [];
    const out = [];
    if (G0.puddles && A.puddle && !skip('puddles')) {
      const { g } = quads(G0.puddles, k => [(k % 2) * .5, (Math.floor(k / 2) % 2) * .5, .5, .5]);
      const m = new T.Mesh(g, new T.MeshStandardMaterial({ color: new T.Color(.16, .17, .19), roughness: .03, metalness: .65, envMapIntensity: 2.6, alphaMap: A.puddle, alphaTest: .5, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
      m.name = 's9look-puddles'; m.receiveShadow = true; m.userData.noProbe = true; m.userData.dyn = true; m.userData.s9nolm = true; out.push(m);
    }
    if (G0.pools && G0.pools.length && !skip('pools')) {
      const { g, X } = quads(G0.pools, () => [0, 0, 1, 1], k => { const c = G0.pools[k][6]; return [...c, ...c, ...c, ...c].slice(0, 3); });
      const cols = [], md = []; for (let k = 0; k < G0.pools.length; k++) for (let v = 0; v < 4; v++) { cols.push(...G0.pools[k][6]); md.push(G0.pools[k][7] || 0); }
      g.setAttribute('aCol', new T.Float32BufferAttribute(cols, 3)); g.setAttribute('aM', new T.Float32BufferAttribute(md, 1));
      const m = new T.Mesh(g, new T.ShaderMaterial({ uniforms: { uK: { value: G0.poolK || 1 } }, vertexShader: POOL_VS, fragmentShader: POOL_FS, transparent: true, depthWrite: false, blending: T.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
      m.name = 's9look-pools'; m.renderOrder = 4; m.userData.noProbe = true; m.userData.dyn = true; out.push(m);
    }
    if (G0.paint && A.paint && !skip('paint')) {
      const cols = G0.paintGrid[0], rows = G0.paintGrid[1];
      const { g } = quads(G0.paint, k => { const cell = G0.paint[k][6]; return [(cell % cols) / cols, 1 - (Math.floor(cell / cols) + 1) / rows, 1 / cols, 1 / rows]; });
      const m = new T.Mesh(g, new T.MeshStandardMaterial({ map: A.paint, transparent: true, depthWrite: false, roughness: .7, metalness: 0, envMapIntensity: .3, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      m.name = 's9look-paint'; m.renderOrder = 1; m.receiveShadow = true; m.userData.noProbe = true; m.userData.dyn = true; m.userData.s9nolm = true; out.push(m);
    }
    return out;
  }


  /* ---------- inside the arena: wall skins (lit atlas panels), emissive seams/frames, cargo brand tints: 2 draw calls ----------
     skins  = [cell, x, y, z, nx, nz, width, height] vertical panels 3 cm off a wall face (no collision change)
     strips = [x0, y0, z0, x1, y1, z1, nx, nz, width, colour index] glowing lines on a wall face
     tint   = [piece, x, y, z, quarterTurns, brand] map-kit cargo recoloured to its owner's brand (vertex colours, restored when off) */
  function buildInside(D, A) {
    const I0 = D.inside; if (!I0) return [];
    const out = [];
    if (I0.skins && A.skins) {
      const P = [], UV = [], N = [], IX = [], cols = I0.skinGrid[0], rows = I0.skinGrid[1];
      for (const [cell, x, y, z, nx, nz, w, h] of I0.skins) {
        const t = new T.Vector3(nz, 0, -nx), b0 = P.length / 3, u0 = (cell % cols) / cols, v0 = 1 - (Math.floor(cell / cols) + 1) / rows;
        const ru = cell < 8 ? Math.max(1, Math.round(w / 3)) : 1, rv = cell < 8 ? Math.max(1, Math.round(h / 3)) : 1;   // big walls repeat the panel art at ~3 m
        for (let i = 0; i < ru; i++) for (let j = 0; j < rv; j++) {
          const cw = w / ru, ch = h / rv, cx = -w / 2 + cw * (i + .5), cy = -h / 2 + ch * (j + .5), b = P.length / 3;
          for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { P.push(x + t.x * (cx + sx * cw / 2), y + cy + sy * ch / 2, z + t.z * (cx + sx * cw / 2)); N.push(nx, 0, nz); UV.push(u0 + (sx + 1) / 2 / cols * .98 + .01 / cols, v0 + (sy + 1) / 2 / rows * .98 + .01 / rows); }
          IX.push(b, b + 1, b + 2, b, b + 2, b + 3);
        }
      }
      const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(P, 3)); g.setAttribute('normal', new T.Float32BufferAttribute(N, 3)); g.setAttribute('uv', new T.Float32BufferAttribute(UV, 2)); g.setIndex(IX);
      const m = new T.Mesh(g, new T.MeshStandardMaterial({ map: A.skins, alphaTest: .5, roughness: .5, metalness: .35, envMapIntensity: .8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: T.FrontSide }));
      m.name = 's9look-skins'; m.receiveShadow = true; m.userData.noProbe = true; m.userData.dyn = true; m.userData.s9nolm = true; out.push(m);
    }
    if (I0.strips && I0.strips.length) {
      const P = [], C = [], IX = [];
      for (const [x0, y0, z0, x1, y1, z1, nx, nz, w, ci] of I0.strips) {
        const a = new T.Vector3(x0, y0, z0), b = new T.Vector3(x1, y1, z1), d = b.clone().sub(a).normalize(), n = new T.Vector3(nx, 0, nz), s = d.clone().cross(n).normalize().multiplyScalar(w / 2), o = n.clone().multiplyScalar(.035), c = I0.seamColors[ci % I0.seamColors.length], k = P.length / 3;
        for (const p of [a.clone().sub(s), a.clone().add(s), b.clone().add(s), b.clone().sub(s)]) { p.add(o); P.push(p.x, p.y, p.z); C.push(...c); }
        IX.push(k, k + 1, k + 2, k, k + 2, k + 3);
      }
      const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(P, 3)); g.setAttribute('color', new T.Float32BufferAttribute(C, 3)); g.setIndex(IX);
      const m = new T.Mesh(g, new T.MeshBasicMaterial({ vertexColors: true, side: T.DoubleSide })); m.name = 's9look-seams'; m.userData.noProbe = true; m.userData.dyn = true; out.push(m);
    }
    return out;
  }
  // cargo brand tints on the map kit's merged meshes (vertex colours inside each piece's footprint); originals kept for "off"
  const TINTED = [];
  function tintKit(D, on) {
    const I0 = D.inside; if (!I0 || !I0.tint || typeof MKMETA === 'undefined') return;
    if (!TINTED.length) {
      const BR = D.palette.brand, boxes = I0.tint.map(([piece, x, y, z, qt, bi]) => { const M = MKMETA[piece]; if (!M) return null; const a = qt * Math.PI / 2, ca = Math.round(Math.cos(a)), sa = Math.round(Math.sin(a));
        let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9, y1 = 0; for (const b of M.b) { for (const px of [b[0], b[3]]) for (const pz of [b[2], b[5]]) { const X = px * ca + pz * sa + x, Z = -px * sa + pz * ca + z; x0 = Math.min(x0, X); x1 = Math.max(x1, X); z0 = Math.min(z0, Z); z1 = Math.max(z1, Z); } y1 = Math.max(y1, b[4]); }
        return { x0: x0 - .05, x1: x1 + .05, z0: z0 - .05, z1: z1 + .05, y0: y - .05, y1: y + y1 + .05, c: BR[bi % BR.length] }; }).filter(Boolean);
      MAPROOT.traverse(o => { if (!o.isMesh || !o.material || !o.material.vertexColors || !o.geometry.attributes.color || o.name.startsWith('s9look')) return;
        const m = o.material, nm = (m.color.r + m.color.g + m.color.b) / 3; if (m.metalness > .7 || nm < .12) return;   // hull panels only (not trim / glow)
        const P = o.geometry.attributes.position, Cc = o.geometry.attributes.color, orig = Cc.array.slice(), tinted = Cc.array.slice(); let n = 0;
        for (let i = 0; i < P.count; i++) { const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
          for (const b of boxes) if (x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1 && y > b.y0 && y < b.y1) { for (let k = 0; k < 3; k++) tinted[i * 3 + k] = orig[i * 3 + k] * Math.min(3, b.c[k] / Math.max(.02, [m.color.r, m.color.g, m.color.b][k]) * 1.6); n++; break; } }
        if (n) TINTED.push({ a: Cc, orig, tinted, n }); });
    }
    for (const t of TINTED) { t.a.array.set(on ? t.tinted : t.orig); t.a.needsUpdate = true; }
    L.tinted = TINTED.reduce((a, t) => a + t.n, 0);
  }


  /* ---------- light shafts + ground fog layers (research #6): 2 draw calls, additive, no depth writes ----------
     cones = [x, y(top), z, length, radius at the bottom, r, g, b] hanging down from lamps; soft at the edges by the view angle
     fog   = [x, y, z, w, d, r, g, b, alpha] flat layers drifting slowly (noise in the shader), faded with camera distance */
  const SH_VS = `attribute vec3 aCol; varying vec3 vCol; varying float vV; varying vec3 vN; varying vec3 vW; varying vec2 vU;
void main(){ vCol = aCol; vU = uv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`;
  const SH_FS = `uniform float uT, uK; varying vec3 vCol; varying vec3 vN; varying vec3 vW; varying vec2 vU;
void main(){ vec3 v = normalize(cameraPosition - vW); float edge = pow(abs(dot(v, vN)), 1.6); float down = pow(vU.y, 1.4);
  float fl = .9 + .1 * sin(uT * 2.0 + vW.x * 3.0); gl_FragColor = vec4(vCol * edge * down * fl * uK, 1.0); }`;
  const FOG_FS = `uniform float uT, uK; varying vec3 vCol; varying vec3 vW; varying vec2 vU;
float h(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5); }
float n2(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f); return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + 1.), f.x), f.y); }
void main(){ vec2 p = vW.xz * .09 + vec2(uT * .02, uT * .013); float n = n2(p) * .6 + n2(p * 2.3 - uT * .03) * .4;
  vec2 q = vU * 2. - 1.; float m = (1. - smoothstep(.55, 1., max(abs(q.x), abs(q.y)))); float d = length(cameraPosition - vW); float near = smoothstep(1.5, 7., d);
  gl_FragColor = vec4(vCol * smoothstep(.35, .85, n) * m * near * uK, 1.0); }`;
  function buildAir(D) {
    const A0 = D.air; if (!A0) return [];
    const out = [], tick = m => { m.onBeforeRender = () => { m.material.uniforms.uT.value = (performance.now() / 1000) % 3600; }; };
    if (A0.cones && A0.cones.length) {
      const geos = [];
      for (const [x, y, z, len, rad, r, g, b] of A0.cones) { const q = new T.CylinderGeometry(rad * .12, rad, len, 18, 1, true); q.translate(x, y - len / 2, z);
        const uv = q.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
        const n = q.attributes.position.count, c = new Float32Array(n * 3); for (let i = 0; i < n; i++) c.set([r, g, b], i * 3); q.setAttribute('aCol', new T.BufferAttribute(c, 3)); geos.push(q); }
      const m = new T.Mesh(T.BufferGeometryUtils.mergeBufferGeometries(geos), new T.ShaderMaterial({ uniforms: { uT: { value: 0 }, uK: { value: A0.coneK || .35 } }, vertexShader: SH_VS, fragmentShader: SH_FS, transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide }));
      m.name = 's9look-shafts'; m.renderOrder = 6; m.userData.noProbe = true; m.userData.dyn = true; tick(m); out.push(m);
    }
    if (A0.fog && A0.fog.length) {
      const P = [], UV = [], C = [], N = [], I = [];
      for (const [x, y, z, w, d, r, g, b, a] of A0.fog) { const k = P.length / 3; for (const [sx, sz, u, v] of [[-1, -1, 0, 0], [1, -1, 1, 0], [1, 1, 1, 1], [-1, 1, 0, 1]]) { P.push(x + sx * w / 2, y, z + sz * d / 2); UV.push(u, v); C.push(r * a, g * a, b * a); N.push(0, 1, 0); } I.push(k, k + 2, k + 1, k, k + 3, k + 2); }
      const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(P, 3)); g.setAttribute('uv', new T.Float32BufferAttribute(UV, 2)); g.setAttribute('aCol', new T.Float32BufferAttribute(C, 3)); g.setAttribute('normal', new T.Float32BufferAttribute(N, 3)); g.setIndex(I);
      const m = new T.Mesh(g, new T.ShaderMaterial({ uniforms: { uT: { value: 0 }, uK: { value: A0.fogK || 1 } }, vertexShader: SH_VS, fragmentShader: FOG_FS, transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide }));
      m.name = 's9look-groundfog'; m.renderOrder = 5; m.userData.noProbe = true; m.userData.dyn = true; tick(m); out.push(m);
    }
    return out;
  }


  /* ---------- realism: macro variation + wet patches on the ground (breaks texture tiling), outside ground plane ---------- */
  const MACRO_PARS = `
float s9h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float s9n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f); return mix(mix(s9h(i), s9h(i + vec2(1, 0)), f.x), mix(s9h(i + vec2(0, 1)), s9h(i + 1.), f.x), f.y); }
float s9fbm(vec2 p){ return s9n(p) * .55 + s9n(p * 2.7 + 13.) * .3 + s9n(p * 7.1 - 5.) * .15; }
uniform float s9MacK, s9WetK;`;
  // after map_fragment: large-scale brightness/tint variation; after roughnessmap: puddle-free wet patches on the ground
  const MACRO_MAP = `
float s9wet = 0.0;
if (s9MacK > 0.001) { float s9m = s9fbm(vS9W.xz * .045); diffuseColor.rgb *= mix(1.0, .72 + .52 * s9m, s9MacK) * mix(vec3(1.0), vec3(1.02, 1.0, .96), s9n(vS9W.xz * .013) * s9MacK);
  if (vS9W.y < .08) { s9wet = smoothstep(.55, .72, s9fbm(vS9W.xz * .07 + 3.1)) * s9WetK; diffuseColor.rgb *= 1.0 - .38 * s9wet; } }`;
  const MACRO_ROUGH = `
roughnessFactor = mix(roughnessFactor, .07, s9wet);`;
  const UM = { s9MacK: { value: 0 }, s9WetK: { value: 0 } };
  function patchMacro(sh) {
    if (!/varying vec3 vS9W/.test(sh.fragmentShader)) return;   // graphics.js gives lit materials their world position
    Object.assign(sh.uniforms, UM);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>' + MACRO_PARS).replace('#include <map_fragment>', '#include <map_fragment>' + MACRO_MAP).replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>' + MACRO_ROUGH);
  }
  let coreOuter = null;
  function buildOuter(D, A) {
    const O = D.outside && D.outside.ground; if (!O || !A.outer) return null;
    const W = O.r1 * 2, g = new T.PlaneGeometry(W, W); g.rotateX(-Math.PI / 2); g.translate(0, -.012, 0);
    const rep = W / O.tile; for (const t of [A.outer.d, A.outer.n, A.outer.a]) t.repeat.set(rep, rep);
    const m = new T.MeshStandardMaterial({ map: A.outer.d, normalMap: A.outer.n, roughnessMap: A.outer.a, metalnessMap: A.outer.a, aoMap: A.outer.a, metalness: 1, roughness: 1, color: new T.Color(.62, .62, .66), envMapIntensity: .6 });
    const hook = baseHook(); m.onBeforeCompile = function (sh, r) { hook.call(this, sh, r); patchMacro(sh); }; m.customProgramCacheKey = function () { return String(baseKey().call(this)) + '|mc1'; };
    g.setAttribute('uv2', g.attributes.uv);
    const mesh = new T.Mesh(g, m); mesh.name = 's9look-outer'; mesh.receiveShadow = true; mesh.userData.noProbe = true; mesh.userData.dyn = true; mesh.userData.s9nolm = true;
    coreOuter = null; MAPROOT.traverse(o => { if (o.isMesh && o !== mesh && o.geometry && o.geometry.parameters && o.geometry.parameters.width >= 800) coreOuter = o; });
    return mesh;
  }
  /* ---------- grade: Hill ACES + LUT, folded into graphics.js's final pass (no extra pass) ---------- */
  const GU = grade.uniforms;
  Object.assign(GU, { uLut: { value: blank }, uLutK: { value: 0 }, uAcesK: { value: 0 } });
  function patchGrade() {
    let fs = grade.material.fragmentShader; if (fs.includes('s9lut')) return true;
    const ACES = `
uniform sampler2D uLut; uniform float uLutK, uAcesK;
vec3 s9rrt(vec3 v){ vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
vec3 s9acesHill(vec3 c){ c = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777) * c; c = s9rrt(c);
  return clamp(mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602) * c, 0., 1.); }
vec3 s9lut(vec3 c){ c = clamp(c, 0., 1.); float N = 32.; float bz = c.b * (N - 1.); float b0 = min(floor(bz), N - 2.); float f = bz - b0;
  vec2 uv = vec2((b0 * N + c.r * (N - 1.) + .5) / (N * N), (c.g * (N - 1.) + .5) / N);
  return mix(texture2D(uLut, uv).rgb, texture2D(uLut, uv + vec2(1. / N, 0.)).rgb, f); }`;
    const a = 'return aces(c*uExposure);', b = 'gl_FragColor = vec4(col,1.);';
    if (!fs.includes(a) || !fs.includes(b)) { L.notes.push('grade shader not recognised: LUT/ACES off'); return false; }
    fs = fs.replace('vec3 tm(vec2 uv)', ACES + '\nvec3 tm(vec2 uv)').replace(a, 'return uAcesK > .5 ? s9acesHill(c*uExposure*(1./.6)) : aces(c*uExposure);')
      .replace(b, 'if (uLutK > .001) col = mix(col, s9lut(col), uLutK);\n  ' + b);
    grade.material.fragmentShader = fs; grade.material.needsUpdate = true;
    return true;
  }
  let gradeOk = false;

  /* ---------- per map + per tier (uniform writes / visibility / texture objects only) ---------- */
  let LOOK0 = null;
  /* ---------- light balance (yard_STYLE.md section 3): moon = the dynamic sun, hemisphere = the baked sky fill, corner floodlight towers ----------
     Uniform/colour writes on the game's existing lights and materials only (no new lights), originals restored when the look is off. */
  const SUN0 = new WeakMap(), HEMI0 = new WeakMap();
  let FLOOD = null;
  function findFlood() {   // the 4 corner floodlight towers built by index.html (lens colour 3,7,8, cone uCol .35,.85,1, glow sprite, 22 m pool)
    FLOOD = { lens: new Set(), cone: new Set(), glow: [], pool: new Set() };
    const near = (c, r, g, b) => Math.abs(c.r - r) < .02 && Math.abs(c.g - g) < .02 && Math.abs(c.b - b) < .02;
    scene.traverse(o => {
      const m = o.material; if (!m || Array.isArray(m)) return;
      if (o.isMesh && m.isMeshBasicMaterial && !m.map && near(m.color, 3, 7, 8)) FLOOD.lens.add(m);
      else if (o.isMesh && m.isShaderMaterial && m.uniforms && m.uniforms.uCol && o.geometry && o.geometry.parameters && o.geometry.parameters.radiusBottom === 6 && o.geometry.parameters.height === 12) FLOOD.cone.add(m);
      else if (o.isSprite && near(m.color, 1.2, 2.6, 3)) FLOOD.glow.push(o);
      else if (o.isMesh && m.isMeshBasicMaterial && m.map && m.blending === T.AdditiveBlending && o.geometry && o.geometry.parameters && o.geometry.parameters.width === 22) FLOOD.pool.add(m);
    });
    for (const m of FLOOD.lens) if (!m.userData.s9c0) m.userData.s9c0 = m.color.clone();
    for (const m of FLOOD.cone) if (!m.userData.s9c0) m.userData.s9c0 = m.uniforms.uCol.value.clone();
    for (const o of FLOOD.glow) if (!o.userData.s9c0) { o.userData.s9c0 = o.material.color.clone(); o.userData.s9s0 = o.scale.x; }
    for (const m of FLOOD.pool) if (!m.userData.s9c0) m.userData.s9c0 = m.color.clone();
  }
  function applyLight(D, on) {
    const LD = on && D && D.light;
    try { if (typeof sun !== 'undefined' && sun && sun.isDirectionalLight) {
      if (!SUN0.has(sun)) SUN0.set(sun, { p: sun.position.clone(), c: sun.color.clone(), i: sun.intensity });
      const o = SUN0.get(sun), M = LD && LD.moon;
      if (M) { const len = o.p.length() || 70; sun.position.set(...M.dir).normalize().multiplyScalar(len).add(sun.target.position); sun.color.setRGB(...M.color); sun.intensity = M.i; }
      else { sun.position.copy(o.p); sun.color.copy(o.c); sun.intensity = o.i; }
      sun.updateMatrixWorld();
    } } catch (e) {}
    try { scene.traverse(h => { if (!h.isHemisphereLight) return; if (!HEMI0.has(h)) HEMI0.set(h, { s: h.color.clone(), g: h.groundColor.clone(), i: h.intensity });
      const o = HEMI0.get(h), F = LD && LD.hemi;
      if (F) { h.color.setRGB(...F.sky); h.groundColor.setRGB(...F.ground); h.intensity = F.i; } else { h.color.copy(o.s); h.groundColor.copy(o.g); h.intensity = o.i; } }); } catch (e) {}
    try { if (window.S9GFXM && S9GFXM.setRimBase) S9GFXM.setRimBase(LD && LD.rim ? LD.rim : null); } catch (e) {}   // player rim = the map's rim light (yard: port glow)
    if (FLOOD) { const F = LD && LD.flood;
      for (const m of FLOOD.lens) m.color.copy(F ? new T.Color(...F.lens) : m.userData.s9c0);
      for (const m of FLOOD.cone) m.uniforms.uCol.value.copy(F ? new T.Color(...F.cone) : m.userData.s9c0);
      for (const g of FLOOD.glow) { g.material.color.copy(F ? new T.Color(...F.glow) : g.userData.s9c0); g.scale.setScalar(F ? g.userData.s9s0 * (F.glowScale || 1) : g.userData.s9s0); }
      for (const m of FLOOD.pool) { m.color.copy(F ? new T.Color(...F.pool) : m.userData.s9c0); }
    }
  }
  function applyGrain() {   // luma grain on High+ only (graphics.js sets the tier's own value in applyQuality first)
    try { const D = DATA[L.map], t = tierNow(); if (L.applied && D && D.grain !== undefined && (t === 'high' || t === 'ultra')) GU.uGrain.value = D.grain; } catch (e) {}
  }
  function applyTier() {
    const D = DATA[L.map], A = ASSETS[L.map], on = full() && !!D && !!A;
    U.s9LkK.value = on && A.lm && D.lightmap ? 1 : 0; U.s9LkTex.value = on && A.lm ? A.lm : blank;
    GU.uLutK.value = on && gradeOk && A.lut && D.lut ? (D.lut.strength ?? 1) : 0; GU.uLut.value = on && A.lut ? A.lut : blank;
    GU.uAcesK.value = on && gradeOk && D.aces === 'hill' ? 1 : 0;
    if (D && L.exp0 === undefined) L.exp0 = GU.uExposure.value;
    if (D && L.exp0 !== undefined) GU.uExposure.value = on && D.exposure ? D.exposure : L.exp0;
    for (const o of EXTRA) o.visible = on;
    if (coreOuter) coreOuter.visible = !on;   // the game's flat 900 m plane gives way to the textured port ground
    UM.s9MacK.value = on && D && D.outside && !skip('macro') ? D.outside.ground.macro : 0; UM.s9WetK.value = on && D && D.outside && !skip('macro') ? D.outside.ground.wet : 0;
    applyLight(D, on);
    if (D && D.inside && !skip('inside')) { try { tintKit(D, on); } catch (e) { L.err = 'tint ' + e.message; } }
    if (D && A) { try { applyPBR(D, A, on); } catch (e) { L.err = 'pbr ' + e.message; } }   // both sets were uploaded at load: a swap is free
    // per-map grade numbers (graphics.js LOOK table) while the baked look is on; graphics.js re-reads them on applyQuality
    try { if (window.S9GFX && S9GFX.LOOK && L.map) { if (!LOOK0) LOOK0 = {}; if (!(L.map in LOOK0)) LOOK0[L.map] = Object.assign({}, S9GFX.LOOK[L.map] || {});
      S9GFX.LOOK[L.map] = Object.assign({}, LOOK0[L.map], on && D && D.grade ? D.grade : {}); } } catch (e) {}
    L.applied = on;
    extTier(on);
  }
  function compileNow() {
    // build every changed program now (loading screen / menu), into the post buffer the game really draws into
    const hidden = []; for (const r of EXTRA) r.traverse(o => { if (!o.visible) { o.visible = true; hidden.push(o); } });
    const prev = renderer.getRenderTarget();
    try { renderer.setRenderTarget(composer.renderTarget1); renderer.compile(scene, camera); } catch (e) { L.err = 'compile ' + e.message; }
    renderer.setRenderTarget(prev); for (const o of hidden) o.visible = false;
    try { composer.render(0); } catch (e) {}
  }
  async function setupMap(id) {
    const t0 = performance.now();
    L.map = id; decalMesh = null; L.exp0 = undefined;
    const D = await getData(id); if (!D || !L.on) { EXTS = []; SKIP = new Set(); applyTier(); return; }
    // extensions: which built-in builders they replace, then their data patches (once per loaded data object)
    EXTS = extsFor(id); SKIP = new Set(); for (const e of EXTS) { e.__built = false; e.__n = 0; e.__err = null; for (const k of e.replaces || []) SKIP.add(k); }
    { const done = PATCHED.get(D) || new Set(); PATCHED.set(D, done);
      for (const e of EXTS) if (e.patch && !done.has(e.name)) { try { e.patch(D, id); } catch (er) { e.__err = 'patch ' + er.message; L.notes.push('ext ' + e.name + ' patch: ' + er.message); } done.add(e.name); } }
    const [A, LT] = await Promise.all([getAssets(id, D), getLights(id)]);
    if (typeof CUR_MAP !== 'undefined' && CUR_MAP !== id) return;   // another map loaded meanwhile
    try { applyLightmap(D, A); } catch (e) { L.err = 'lightmap ' + e.message; console.warn('[gfxlook]', e); }
    for (const o of EXTRA) if (o.parent) o.parent.remove(o);
    EXTRA = []; coreOuter = null;
    const add = (o, list) => { if (!o) return; MAPROOT.add(o); EXTRA.push(o); if (list) list.push(o); };
    await builtins(D, A, add);
    // extensions build last (their own emissive multipliers: ctx.D.emissive); one failing extension never breaks the map: the built-in
    // builders it replaced (and no working extension also replaces) are rebuilt as the fallback
    if (EXTS.length) {
      const ctx = { map: id, D, A, T, scene, MAPROOT, renderer, camera, tierName: tierNow(), U, GU, UM, baseHook, baseKey, patchMacro, lights: LT, loadTex: (url, srgb) => texLoad(url, srgb), loadGLB };
      for (const e of EXTS) {
        if (!e.build) { e.__built = true; continue; }
        try { const objs = (await e.build(ctx)) || []; for (const o of objs) if (o && o.isObject3D) { o.userData.s9ext = e.name; add(o); e.__n++; } e.__built = true; }
        catch (er) { e.__err = 'build ' + er.message; L.notes.push('ext ' + e.name + ' build: ' + er.message); console.warn('[gfxlook] ext', e.name, er); }
      }
      if (typeof CUR_MAP !== 'undefined' && CUR_MAP !== id) return;
      const ok = new Set(); for (const e of EXTS) if (e.__built) for (const k of e.replaces || []) ok.add(k);
      const back = [...SKIP].filter(k => !ok.has(k));
      if (back.length) { L.notes.push('fallback built-ins: ' + back.join(',')); SKIP = ok; await builtins(D, A, add, new Set(back)); }
    }
    L.extra = EXTRA.map(o => o.name);
    try { findFlood(); } catch (e) { L.notes.push('flood ' + e.message); }
    applyTier(); try { applyQuality(); } catch (e) {}
    compileNow();
    L.loadMs = Math.round(performance.now() - t0);
  }
  // the built-in builders not replaced by an extension; only = Set of replace keys to (re)build as a fallback (null = all not skipped)
  async function builtins(D, A, add, only) {
    const want = k => only ? only.has(k) : !skip(k), wantAny = ks => ks.some(want);
    const S0 = SKIP; if (only) SKIP = new Set([...S0].filter(k => !only.has(k)).concat(['decals', 'props', 'lib:in', 'lib:out', 'city', 'inside', 'air', 'outer', 'puddles', 'paint', 'pools', 'macro', 'backdrop:glow', 'backdrop:far', 'backdrop:city', 'backdrop:near', 'backdrop:clouds', 'backdrop:ships'].filter(k => !only.has(k))));
    try { if (want('decals')) { buildDecals(D, A); if (decalMesh) EXTRA.push(decalMesh); } } catch (e) { L.err = 'decals ' + e.message; }
    try { if (wantAny(['backdrop:glow', 'backdrop:far', 'backdrop:city', 'backdrop:near', 'backdrop:clouds', 'backdrop:ships'])) add(buildBackdrop(D, A)); } catch (e) { L.err = 'backdrop ' + e.message; }
    try { if (want('props')) for (const m of buildProps(D, A)) add(m); } catch (e) { L.err = 'props ' + e.message; }
    try { const inn = want('lib:in'), out = want('lib:out');
      if ((inn || out) && D.place) { await getLib(); const inside = q => Math.abs(q[1]) <= 36.5 && Math.abs(q[3]) <= 36.5;
        for (const m of buildLib({ place: D.place.filter(q => inside(q) ? inn : out), palette: D.palette })) add(m); } } catch (e) { L.err = 'lib ' + e.message; }
    try { if (want('city')) add(buildCity(D)); } catch (e) { L.err = 'city ' + e.message; }
    try { if (want('inside')) for (const m of buildInside(D, A)) add(m); } catch (e) { L.err = 'inside ' + e.message; }
    try { if (want('air')) for (const m of buildAir(D)) add(m); } catch (e) { L.err = 'air ' + e.message; }
    try { if (want('outer')) add(buildOuter(D, A)); } catch (e) { L.err = 'outer ' + e.message; }
    try { if (window.S9GFXM && S9GFXM.rebuild) S9GFXM.rebuild(); } catch (e) {}   // gfxmat's triplanar wear/panel detail on the new props too
    // brighter emissives (research #4): every built-in glowing look mesh pushed above the bloom threshold (extensions own theirs)
    for (const o of EXTRA) if (!o.userData.s9ext && o.material && o.material.isMeshBasicMaterial && o.material.vertexColors && D.emissiveK) o.material.color.setScalar(D.emissiveK);
    if (!only) TINTED.length = 0;
    try { if (wantAny(['puddles', 'paint', 'pools'])) for (const m of buildGround(D, A)) add(m); } catch (e) { L.err = 'ground ' + e.message; }
    if (only) SKIP = S0;
  }

  /* ---------- hooks ---------- */
  const _lm = loadMap;
  loadMap = async function (id) {
    const before = typeof CUR_MAP !== 'undefined' ? CUR_MAP : null, hadKids = MAPROOT.children.length;
    const r = await _lm.apply(this, arguments);
    try { if (L.started) { const now = typeof CUR_MAP !== 'undefined' ? CUR_MAP : id; if (now !== before || !hadKids || L.map !== now) await setupMap(now); } } catch (e) { L.err = 'loadMap ' + e.message; }
    return r;
  };
  const _aq = applyQuality;
  applyQuality = function () { const r = _aq.apply(this, arguments); try { const D0 = DATA[L.map]; if (L.started && D0 && D0.bloomT && full() && typeof bloom !== 'undefined' && bloom) bloom.threshold = D0.bloomT; } catch (e) {} try { if (L.started && L.applied !== (full() && !!DATA[L.map])) applyTier(); else if (L.started) { const on = L.applied; for (const o of EXTRA) o.visible = on; extTier(on); } } catch (e) {} applyGrain(); return r; };
  if (typeof warmShaders === 'function') { const _ws = warmShaders; warmShaders = function () { const hidden = []; for (const r of EXTRA) r.traverse(o => { if (!o.visible) { o.visible = true; hidden.push(o); } }); try { return _ws.apply(this, arguments); } finally { for (const o of hidden) o.visible = false; } }; }

  /* ---------- public ---------- */
  L.receivers = () => receivers().map(r => r.key);
  L.exportGeo = exportGeo;
  // mockups only (owner decisions): extra placements drawn like the library props, no collision; S9LOOK.mock(list) / S9LOOK.mock(null) clears
  let MOCK = [];
  L.mock = list => { for (const m of MOCK) { MAPROOT.remove(m); m.geometry.dispose(); } MOCK = []; const D = DATA[L.map]; if (!list || !D || !LIB) return 0;
    for (const m of buildLib({ place: list, palette: D.palette })) { m.name += '-mock'; MAPROOT.add(m); MOCK.push(m); } compileNow(); return MOCK.length; };
  L.setOn = on => { L.on = !!on; if (on && L.map && !ASSETS[L.map] && !inMatch()) setupMap(L.map); else applyTier(); try { applyQuality(); } catch (e) {} };
  L.status = () => ({ ready: L.ready, on: L.on, applied: L.applied, tier: tierNow(), map: L.map, data: !!DATA[L.map], recv: L.recv, matched: L.matched, missed: L.missed, mats: L.mats, decals: L.decals, pbr: L.pbr || 0, pbrHd: !!L.pbrHd, extra: (L.extra || []).slice(),
    ext: EXTS.map(e => ({ name: e.name, built: !!e.__built, meshes: e.__n || 0, err: e.__err || null })), skip: [...SKIP],
    flood: FLOOD ? FLOOD.lens.size + FLOOD.cone.size + FLOOD.glow.length + FLOOD.pool.size : 0, tinted: L.tinted || 0, lmK: U.s9LkK.value, lutK: GU.uLutK.value, aces: GU.uAcesK.value, gradeOk, loadMs: L.loadMs, err: L.err, notes: L.notes.slice(-5) });
  L.U = U; L.GU = GU; L.UM = UM;
  L.ext = () => EXTS.map(e => e.name);
  L.D = () => DATA[L.map] || null;   // tuning / QA: the live data object (applyTier re-reads light, grade, exposure from it)
  L.retune = () => { applyTier(); try { applyQuality(); } catch (e) {} };
  window.S9LOOK = L;
  window.S9LOOK_EXT = window.S9LOOK_EXT || [];

  /* ---------- start: in the menu, after graphics.js and gfxmat are ready ---------- */
  const iv = setInterval(() => {
    if (typeof state === 'undefined' || state !== 'menu' || typeof CUR_MAP === 'undefined' || !CUR_MAP) return;
    if (window.S9GFX && !S9GFX.ready) return; if (window.S9GFXM && !S9GFXM.ready) return;
    clearInterval(iv); L.started = true;
    gradeOk = patchGrade();
    (async () => { try { await devLoad; } catch (e) {} try { await setupMap(CUR_MAP); } catch (e) { L.err = 'start ' + e.message; } L.ready = true; window.dispatchEvent(new Event('s9look')); })();
  }, 60);
})();
