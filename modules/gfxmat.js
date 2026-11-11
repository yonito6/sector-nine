/* Sector Nine - graphics phase 2: surfaces, characters, edges, shadows, decals (modules/gfxmat.js)
   Loads AFTER graphics.js and gfxplus.js (see gfxmat.INTEGRATE.md). Owns no DOM, no CSS, no storage, no network (except the
   SMAA helper scripts from the same CDN/version the game already uses for three.js).
   Per quality tier (Performance = nothing at all):
   - Medium: detail normal/roughness/grime on the map's materials (one projection), softer + sun-aligned contact shadows,
             persistent bullet-hole / scorch decal pool with fade (small).
   - High:   full triplanar detail (panel lines, scratches, wear, concrete grime, rust streaks), rim/fresnel light on players,
             SMAA + contrast-adaptive sharpening (instead of FXAA), 4096 sun shadow with a wider PCF kernel, larger decal pool.
   - Ultra:  same as High, plus PCF-soft shadows on a 6144 map, stronger detail range, lighter sharpening (4x MSAA already smooths edges).
   Rules kept: no new lights, every shader/texture prepared at load (a tier change only changes uniforms/visibility), nothing is
   compiled during a match. Public API: window.S9GFXM (status(), setEnabled(on), rebuild()). */
(function () {
  'use strict';
  if (window.S9GFXM) return;
  const need = typeof composer !== 'undefined' && typeof renderer !== 'undefined' && typeof scene !== 'undefined' && typeof grade !== 'undefined' && typeof CFG !== 'undefined' && typeof QUALITY !== 'undefined' && typeof applyQuality === 'function' && typeof loadMap === 'function';
  if (!need || !renderer.capabilities.isWebGL2) { console.warn('[gfxmat] game globals / WebGL2 not found, module idle'); return; }
  const T = THREE, M = { ready: false, err: null, enabled: true, level: 0, buildMs: 0, texMs: 0, flagged: 0, kinds: [0, 0, 0], placed: { hole: 0, scorch: 0 }, rims: 0, smaaOk: false, notes: [] };
  const LEVELS = { performance: 0, balanced: 1, high: 2, ultra: 3 };
  const tierNow = () => (window.S9GFX && S9GFX.tier) || CFG.q;
  const wantLevel = () => (M.enabled ? (LEVELS[CFG.q] ?? 1) : 0);
  const inMatch = () => typeof state !== 'undefined' && (state === 'play' || state === 'paused' || state === 'dead');
  const has = n => { try { return typeof (0, eval)(n) !== 'undefined'; } catch (e) { return false; } };
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  /* =====================================================================================================
     1. PROCEDURAL DETAIL TEXTURES (generated once, in the menu). RGBA8, tileable:
        R,G = surface-slope offset (-grad of a height field, decoded as (c*2-1)*1.5), B = roughness modulation (0.5 neutral,
        lower = glossier: scratches, worn edges), A = grime / rust mask.
     ===================================================================================================== */
  /* the generator is a self-contained function so it can run in a Worker (no frame hitch); falls back to the main thread */
  function genKit() {
  const rng = seed => { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296; };
  function noiseKit(seed) {
    const lat = new Map();
    const get = (px, py) => { const k = px * 65536 + py; let a = lat.get(k); if (!a) { const r = rng(seed + px * 977 + py * 131); a = new Float32Array(px * py); for (let i = 0; i < a.length; i++) a[i] = r(); lat.set(k, a); } return a; };
    const vn = (px, py, u, v) => {
      const a = get(px, py), x = u * px, y = v * py, x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const xa = ((x0 % px) + px) % px, xb = (xa + 1) % px, ya = ((y0 % py) + py) % py, yb = (ya + 1) % py;
      const t = a[ya * px + xa] + (a[ya * px + xb] - a[ya * px + xa]) * sx, b = a[yb * px + xa] + (a[yb * px + xb] - a[yb * px + xa]) * sx;
      return t + (b - t) * sy;
    };
    const fbm = (px, py, u, v, oct) => { let s = 0, a = 1, t = 0; for (let o = 0; o < oct; o++) { s += a * vn(px << o, py << o, u, v); t += a; a *= .5; } return s / t; };
    return { vn, fbm };
  }
  // low-frequency noise is evaluated on a small grid once and bilinearly sampled (about 4x faster than evaluating it per pixel)
    const grid = (f, G) => { const a = new Float32Array(G * G); for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) a[y * G + x] = f(x / G, y / G);
      return (u, v) => { const x = u * G, y = v * G, x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, xa = x0 % G, xb = (xa + 1) % G, ya = y0 % G, yb = (ya + 1) % G;
        const t = a[ya * G + xa] + (a[ya * G + xb] - a[ya * G + xa]) * fx, b = a[yb * G + xa] + (a[yb * G + xb] - a[yb * G + xa]) * fx; return t + (b - t) * fy; }; };
  const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const clamp01 = x => x < 0 ? 0 : x > 1 ? 1 : x;
  // pack (height H in pixel units, B, A) into an RGBA8 DataTexture
  function pack(S, H, B, A, strength) {
    const d = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = y * S + x, xm = y * S + ((x + S - 1) % S), xp = y * S + ((x + 1) % S), ym = ((y + S - 1) % S) * S + x, yp = ((y + 1) % S) * S + x;
      const nx = -(H[xp] - H[xm]) * .5 * strength, ny = -(H[yp] - H[ym]) * .5 * strength, o = i * 4;
      d[o] = clamp01(((nx / 1.5) + 1) * .5) * 255; d[o + 1] = clamp01(((ny / 1.5) + 1) * .5) * 255; d[o + 2] = clamp01(B[i]) * 255; d[o + 3] = clamp01(A[i]) * 255;
    }
    return { S, d };
  }
  const canvasOf = S => { if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(S, S); const c = document.createElement('canvas'); c.width = c.height = S; return c; };
  // random scratches / cracks drawn on a canvas (wrapped so the tile stays seamless), returned as a 0..1 float field
  function strokes(S, seed, n, spec) {
    const c = canvasOf(S), g = c.getContext('2d', { willReadFrequently: true }), r = rng(seed); g.lineCap = 'round';
    for (let i = 0; i < n; i++) {
      const x = r() * S, y = r() * S, len = spec.min + Math.pow(r(), 2) * spec.len, q = r();
      const ang = q < spec.h ? (r() - .5) * .25 : q < spec.h + spec.v ? Math.PI / 2 + (r() - .5) * .25 : r() * Math.PI;
      g.strokeStyle = `rgba(255,255,255,${spec.a0 + r() * spec.a1})`; g.lineWidth = spec.w0 + r() * spec.w1;
      for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) { g.beginPath(); g.moveTo(x + ox, y + oy); g.lineTo(x + ox + Math.cos(ang) * len, y + oy + Math.sin(ang) * len); g.stroke(); }
    }
    const px = g.getImageData(0, 0, S, S).data, f = new Float32Array(S * S);
    for (let i = 0; i < f.length; i++) f[i] = px[i * 4] / 255;
    return f;
  }
  function genMetal() {
    const S = 1024, N = S * S, H = new Float32Array(N), B = new Float32Array(N), A = new Float32Array(N), nk = noiseKit(11), r = rng(7), CELL = 256, C = 4;
    const vs = [], hs = [], tone = [], rough = [];
    for (let i = 0; i < C; i++) { vs.push([]); hs.push([]); tone.push([]); rough.push([]); for (let j = 0; j < C; j++) { vs[i].push(r() > .18); hs[i].push(r() > .18); tone[i].push(r() * .08); rough[i].push((r() - .5) * .12); } }
    const gA = grid((u, v) => nk.fbm(3, 3, u, v, 3), 128), gB = grid((u, v) => nk.fbm(5, 5, u, v, 2), 128);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = y * S + x, ci = (x / CELL) | 0, cj = (y / CELL) | 0, u = x / S, v = y / S;
      A[i] = tone[ci][cj] + .06 + (gA(u, v) - .5) * .26;
      B[i] = .5 + rough[ci][cj] + (gB(u, v) - .5) * .16;
      H[i] = (nk.vn(256, 256, u, v) - .5) * .18;   // faint grain
    }
    // panel seams: groove + dirt in the groove + worn bright edge beside it + rivet rows
    const seam = (alongX, pos, from, to) => {
      for (let t = from; t < to; t++) for (let d = -7; d <= 7; d++) {
        const a = (pos + d + S) % S, b = (t + S) % S, i = alongX ? b * S + a : a * S + b, k = Math.abs(d);
        H[i] -= 1.7 * Math.exp(-((k / 1.45) ** 2)); A[i] += .26 * Math.exp(-((k / 3.4) ** 2)); B[i] -= .13 * Math.exp(-(((k - 4.5) / 1.8) ** 2)); B[i] += .08 * Math.exp(-((k / 1.5) ** 2));
      }
      for (let t = from + 24; t < to - 8; t += 48) for (const side of [-15, 15]) {
        for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const rr = Math.hypot(dx, dy); if (rr > 4) continue; const a = (pos + side + (alongX ? dx : dy) + S) % S, b = (t + (alongX ? dy : dx) + S) % S, i = alongX ? b * S + a : a * S + b;
          H[i] += 1.15 * Math.exp(-((rr / 2.1) ** 2)); A[i] += .1 * Math.exp(-((rr / 3.2) ** 2)); }
      }
    };
    for (let i = 0; i < C; i++) for (let j = 0; j < C; j++) { if (vs[i][j]) seam(true, i * CELL, j * CELL, (j + 1) * CELL); if (hs[i][j]) seam(false, j * CELL, i * CELL, (i + 1) * CELL); }
    const sc = strokes(S, 33, 300, { min: 8, len: 60, h: .42, v: .26, a0: .14, a1: .5, w0: .7, w1: .8 });
    for (let i = 0; i < N; i++) { const s = sc[i]; H[i] -= s * .35; B[i] -= s * .34; A[i] -= s * .04; }
    return pack(S, H, B, A, 1);
  }
  function genConcrete() {
    const S = 512, N = S * S, H = new Float32Array(N), B = new Float32Array(N), A = new Float32Array(N), nk = noiseKit(23);
    const cr = strokes(S, 55, 5, { min: 70, len: 200, h: .3, v: .3, a0: .5, a1: .4, w0: 1, w1: .8 });
    const gS = grid((u, v) => nk.fbm(3, 3, u, v, 4), 128), gR = grid((u, v) => nk.fbm(5, 5, u, v, 3), 128);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = y * S + x, u = x / S, v = y / S;
      const pit = sstep(.76, .9, nk.vn(112, 112, u, v)), grain = (nk.vn(220, 220, u, v) - .5) * .5 + (nk.vn(56, 56, u, v) - .5) * .7;
      const dj = Math.min(Math.min(x, S - x), Math.min(y, S - y));
      const stain = sstep(.46, .82, gS(u, v)), streak = sstep(.5, .86, nk.fbm(44, 3, u, v, 2)) * (.65 + .35 * Math.cos(v * 6.2832));
      H[i] = grain * .55 - pit * .6 - 1.5 * Math.exp(-((dj / 1.6) ** 2)) - cr[i] * .9;
      A[i] = stain * .42 + streak * .3 + .18 * Math.exp(-((dj / 5) ** 2)) + cr[i] * .35 + pit * .12 + .03;
      B[i] = .5 + (gR(u, v) - .5) * .22 + pit * .06;
    }
    return pack(S, H, B, A, .9);
  }
  function genRust() {
    const S = 512, N = S * S, H = new Float32Array(N), B = new Float32Array(N), A = new Float32Array(N), nk = noiseKit(41);
    const gBl = grid((u, v) => nk.fbm(6, 6, u, v, 4), 128);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = y * S + x, u = x / S, v = y / S;
      const streak = nk.fbm(40, 4, u, v, 3), blob = gBl(u, v);
      const m = sstep(.5, .8, streak) * sstep(.28, .7, blob) * (.7 + .3 * Math.cos(v * 6.2832 + 1));
      H[i] = m * (nk.fbm(90, 90, u, v, 2) - .35) * 2.2 + (nk.vn(200, 200, u, v) - .5) * .25;
      A[i] = m; B[i] = .5 + m * .28 - (1 - m) * .04;
    }
    return pack(S, H, B, A, .8);
  }


    return { metal: genMetal, concrete: genConcrete, rust: genRust };
  }
  function toTex(o) {
    const t = new T.DataTexture(o.d, o.S, o.S, T.RGBAFormat, T.UnsignedByteType);
    t.wrapS = t.wrapT = T.RepeatWrapping; t.magFilter = T.LinearFilter; t.minFilter = T.LinearMipmapLinearFilter; t.generateMipmaps = true; t.anisotropy = Math.min(4, maxAniso); t.encoding = T.LinearEncoding; t.needsUpdate = true; return t;
  }
  function makeTextures() {
    const names = ['metal', 'concrete', 'rust'];
    const direct = () => { const K = genKit(); return names.map(n => toTex(K[n]())); };
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof Blob === 'undefined') return new Promise(res => setTimeout(() => res(direct()), 0));
    return new Promise(res => {
      let w = null, done = false;
      const fin = v => { if (done) return; done = true; try { w && w.terminate(); } catch (e) {} res(v); };
      try {
        const url = URL.createObjectURL(new Blob(['const K=(' + genKit.toString() + ')();onmessage=function(e){var o=K[e.data]();postMessage({n:e.data,S:o.S,d:o.d},[o.d.buffer]);};'], { type: 'text/javascript' }));
        w = new Worker(url); const got = {};
        w.onmessage = e => { got[e.data.n] = toTex(e.data); if (names.every(n => got[n])) { URL.revokeObjectURL(url); fin(names.map(n => got[n])); } };
        w.onerror = () => { M.notes.push('worker failed, generating on the main thread'); fin(direct()); };
        for (const n of names) w.postMessage(n);
      } catch (e) { fin(direct()); }
    });
  }

  const canvasOf = S => { const c = document.createElement('canvas'); c.width = c.height = S; return c; };
  const rng = seed => { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296; };

  /* =====================================================================================================
     2. MAP MATERIAL DETAIL (shader patch on the map's own materials, world-space triplanar)
     ===================================================================================================== */
  const UG = { gmK: { value: 0 }, gmTri: { value: 1 } };    // global, shared by every patched material (tier -> uniforms only)
  const KP = [0, 1, 2].map(() => ({ gmTex: { value: null }, gmP: { value: new T.Vector4(1, .5, .5, 0) }, gmTint: { value: new T.Vector3(1, 1, 1) }, gmQ: { value: new T.Vector2(1 / 6, 55) } }));
  // kind, weight by texture name (kind 0 = metal panels, 1 = concrete / stone / brick, 2 = rust). Natural surfaces get nothing.
  const NAMEK = { metal_plate: [0, 1], container_grey: [0, 1], hull: [0, 1.1], rustplate: [2, 1], rusty_corrugated_iron: [2, 1], green_metal_rust: [2, .9], metal_grate_rusty: [2, .55],
    precast_concrete_wall: [1, 1], worn_asphalt: [1, .8], dark_brick_wall: [1, .7], red_brick: [1, .7], volcanic_rock_tiles: [1, .6], japanese_stone_wall: [1, .45], sandstone_blocks_08: [1, .4], large_sandstone_blocks: [1, .4] };
  const SKIPN = new Set(['sand_02', 'snow_floor', 'forest_ground_06', 'wood_floor_deck', 'rock_wall_08', 'alienrock']);
  // per-map personality: s = overall strength, d = grime, r = rust bias (scales kind-2 / adds weight), p = panel seam strength for metal
  const MAPK = {
    neon: { s: 1, d: .85, p: 1.1 }, grid: { s: 1, d: .7, p: 1.15 }, orbital: { s: 1.05, d: .75, p: 1.2 }, biolab: { s: 1, d: .8, p: 1 }, caverns: { s: .9, d: 1, p: .9 },
    foundry: { s: 1.1, d: 1.2, p: .9 }, yard: { s: 1.05, d: 1.15, p: .9 }, docks: { s: 1.1, d: 1.2, p: .9 }, dunes: { s: .8, d: .8, p: .8 }, glacier: { s: .8, d: .6, p: .9 }, shrine: { s: .7, d: .8, p: .7 },
  };
  let TEX = null, nameOf = new Map();
  function rebuildNames() {
    nameOf = new Map();
    try { if (typeof ASSET !== 'undefined' && ASSET.world) for (const n of Object.keys(ASSET.world)) { const s = ASSET.world[n]; if (s) { if (s.d) nameOf.set(s.d, n); if (s.n) nameOf.set(s.n, n); } }
      if (window.S9GFX && S9GFX.hdLoaded) for (const n of Object.keys(S9GFX.hdLoaded)) { const s = S9GFX.hdLoaded[n]; if (s && s.d) { nameOf.set(s.d, n); nameOf.set(s.n, n); } } } catch (e) {}
  }
  function classify(m) {
    if (!m || !m.isMeshStandardMaterial || m.isMeshPhysicalMaterial || m.transparent || m.opacity < .99 || m.emissiveMap) return null;
    if (m.emissive && (m.emissive.r + m.emissive.g + m.emissive.b) > .06) return null;
    if (m.userData && m.userData.gmSkip) return null;
    const nm = (m.map && nameOf.get(m.map)) || (m.normalMap && nameOf.get(m.normalMap)) || null;
    if (nm) { if (SKIPN.has(nm)) return null; if (NAMEK[nm]) return NAMEK[nm]; }
    const unk = m.map && !nm ? .8 : 1;   // map-kit materials carry textures we have no name for: judge them by their look
    const c = m.color || { r: 1, g: 1, b: 1 }, lum = .2126 * c.r + .7152 * c.g + .0722 * c.b;
    if (m.metalness >= .5) return [0, .9 * unk];
    if (m.roughness >= .9 && lum < .04) return null;
    return [1, .55 * unk];
  }
  const GL_PARS = `
varying vec3 vGmW; varying vec3 vGmN;
uniform sampler2D gmTex; uniform vec4 gmP; uniform vec3 gmTint; uniform vec2 gmQ; uniform float gmK, gmTri, gmW;`;
  const VS_CODE = `
{ vec4 gmp = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  gmp = instanceMatrix * gmp;
#endif
  vGmW = (modelMatrix * gmp).xyz; vGmN = normalize(mat3(modelMatrix) * objectNormal); }`;
  const MAP_CODE = `
float gmAmt = 0.0, gmA = 0.0, gmBv = 0.5; vec3 gmDN = vec3(0.0);
{
  float gmd = length(vViewPosition);
  gmAmt = gmK * gmW * (1.0 - smoothstep(gmQ.y * 0.4, gmQ.y, gmd));
  vec3 gmn = normalize(vGmN); vec3 gmw = pow(abs(gmn), vec3(7.0)); gmw /= (gmw.x + gmw.y + gmw.z);
  vec3 gmpw = vGmW * gmQ.x; vec2 gmuX = gmpw.zy, gmuY = gmpw.xz, gmuZ = gmpw.xy;
  vec2 gmXx = dFdx(gmuX), gmXy = dFdy(gmuX), gmYx = dFdx(gmuY), gmYy = dFdy(gmuY), gmZx = dFdx(gmuZ), gmZy = dFdy(gmuZ);
  if (gmAmt > 0.004) {
    vec4 gsx = vec4(0.5, 0.5, 0.5, 0.0), gsy = gsx, gsz = gsx;
    if (gmTri > 0.5) {
      if (gmw.x > 0.02) gsx = textureGrad(gmTex, gmuX, gmXx, gmXy);
      if (gmw.y > 0.02) gsy = textureGrad(gmTex, gmuY, gmYx, gmYy);
      if (gmw.z > 0.02) gsz = textureGrad(gmTex, gmuZ, gmZx, gmZy);
    } else if (gmw.y >= gmw.x && gmw.y >= gmw.z) { gsy = textureGrad(gmTex, gmuY, gmYx, gmYy); gmw = vec3(0.0, 1.0, 0.0); }
    else if (gmw.x >= gmw.z) { gsx = textureGrad(gmTex, gmuX, gmXx, gmXy); gmw = vec3(1.0, 0.0, 0.0); }
    else { gsz = textureGrad(gmTex, gmuZ, gmZx, gmZy); gmw = vec3(0.0, 0.0, 1.0); }
    vec2 gox = (gsx.rg * 2.0 - 1.0) * 1.5, goy = (gsy.rg * 2.0 - 1.0) * 1.5, goz = (gsz.rg * 2.0 - 1.0) * 1.5;
    gmDN = gmw.x * vec3(0.0, gox.y, gox.x) + gmw.y * vec3(goy.x, 0.0, goy.y) + gmw.z * vec3(goz.x, goz.y, 0.0);
    gmBv = gsx.b * gmw.x + gsy.b * gmw.y + gsz.b * gmw.z;
    gmA = gsx.a * gmw.x + gsy.a * gmw.y + gsz.a * gmw.z;
    float gmUp = smoothstep(0.6, 0.95, gmn.y);     // floors stay cleaner (people walk there; keeps the floor readable under players)
    diffuseColor.rgb *= mix(vec3(1.0), mix(vec3(1.0 - gmP.y * (1.0 - 0.6 * gmUp)), gmTint, gmP.w), clamp(gmA * gmAmt, 0.0, 1.0));
    diffuseColor.rgb *= 1.0 + max(0.0, 0.5 - gmBv) * gmP.z * 1.1 * gmAmt;     // worn / scratched spots show brighter bare surface
  }
}`;
  const ROUGH_CODE = `
if (gmAmt > 0.004) roughnessFactor = clamp(roughnessFactor * (1.0 + (gmBv - 0.5) * 2.0 * gmP.z * gmAmt), 0.05, 1.0);`;
  const NORM_CODE = `
if (gmAmt > 0.004) { vec3 gmwn = inverseTransformDirection(normal, viewMatrix); gmwn = normalize(gmwn + gmDN * gmP.x * gmAmt); normal = normalize((viewMatrix * vec4(gmwn, 0.0)).xyz); }`;
  function patchShader(sh, mat) {
    const k = (mat.userData.gm | 0) - 1;
    Object.assign(sh.uniforms, UG, KP[k], { gmW: { value: mat.userData.gmw || 1 } });
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vGmW; varying vec3 vGmN;').replace('#include <begin_vertex>', '#include <begin_vertex>' + VS_CODE);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>' + GL_PARS).replace('#include <map_fragment>', '#include <map_fragment>' + MAP_CODE)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>' + ROUGH_CODE).replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>' + NORM_CODE);
  }
  const baseHook = () => T.MeshStandardMaterial.prototype.onBeforeCompile, baseKey = () => T.MeshStandardMaterial.prototype.customProgramCacheKey;
  function flagMat(m) {
    if (m.userData.gm) return false;
    const k = classify(m); if (!k) return false;
    m.userData.gm = k[0] + 1; m.userData.gmw = k[1];
    m.onBeforeCompile = function (sh, r) { baseHook().call(this, sh, r); patchShader(sh, this); };
    m.customProgramCacheKey = function () { return String(baseKey().call(this)) + '|gm1'; };
    m.needsUpdate = true; M.flagged++; M.kinds[k[0]]++;
    return true;
  }
  function flagMap() {
    if (typeof MAPROOT === 'undefined') return;
    rebuildNames(); const seen = new Set();
    MAPROOT.traverse(o => { if (!(o.isMesh || o.isInstancedMesh) || !o.material) return; for (const m of [].concat(o.material)) { if (seen.has(m)) continue; seen.add(m); if (!m.userData.gm) flagMat(m); } });
  }
  function applyDetail() {
    const L = M.level, mk = Object.assign({ s: 1, d: 1, p: 1 }, MAPK[M.map] || {});
    UG.gmK.value = [0, .6, 1, 1.12][L]; UG.gmTri.value = L >= 2 ? 1 : 0;
    const fade = [0, 32, 42, 60][L];
    const set = (k, n, d, ro, tint, tile) => { KP[k].gmP.value.set(n * mk.s * (k === 0 ? mk.p : 1), d * mk.d, ro * mk.s, tint); KP[k].gmQ.value.set(1 / tile, fade); };
    set(0, 1.15, .62, .6, 0, 6); set(1, .6, .66, .3, 0, 3.4); set(2, .7, .6, .5, 1, 3.4);
    KP[2].gmTint.value.set(1.18, .6, .3);
  }

  /* =====================================================================================================
     3. CHARACTER SHADING: rim/fresnel overlay on player bodies + softer, sun-aligned contact shadow
     ===================================================================================================== */
  let rimProto = null;
  function rimMaterial() {
    if (rimProto) return rimProto;
    rimProto = new T.ShaderMaterial({
      uniforms: T.UniformsUtils.merge([T.UniformsLib.fog, { uCol: { value: new T.Color(.4, .6, .9) }, uK: { value: .26 }, uPow: { value: 2.5 }, uOp: { value: 1 } }]),
      vertexShader: `#include <common>
#include <skinning_pars_vertex>
#include <fog_pars_vertex>
varying vec3 vN; varying vec3 vV; varying float vUp;
void main(){
  #include <skinbase_vertex>
  #include <beginnormal_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  #include <fog_vertex>
  vN = normalize(transformedNormal); vV = -mvPosition.xyz; vUp = (vec4(vN, 0.0) * viewMatrix).y;
}`,
      fragmentShader: `#include <common>
#include <fog_pars_fragment>
uniform vec3 uCol; uniform float uK, uPow, uOp; varying vec3 vN; varying vec3 vV; varying float vUp;
void main(){
  vec3 n = normalize(vN); float ndv = clamp(dot(n, normalize(vV)), 0.0, 1.0);
  float f = pow(1.0 - ndv, uPow) * (0.55 + 0.45 * clamp(vUp * 0.7 + 0.5, 0.0, 1.0)) * uK * uOp;
  vec3 c = uCol * f;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fd = fogDensity * vFogDepth; c *= exp(-fd * fd);
    #else
      c *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
    #endif
  #endif
  gl_FragColor = vec4(c, 1.0);
}`,
      transparent: true, blending: T.AdditiveBlending, depthWrite: false, fog: true,
    });
    rimProto.name = 'gmRim';
    return rimProto;
  }
  const RIMS = new Set(), _rv = new T.Vector3(), _rf = new T.Vector3();
  // rim base colour: cool sky blue by default; a map look can set its own (yard: port glow) via S9GFXM.setRimBase([r,g,b] | null)
  const RIM0 = new T.Color(.55, .72, 1), RIMB = RIM0.clone();
  const rimCol = (r, out) => out.copy(RIMB).lerp(r.color || new T.Color(1, 1, 1), .5).multiplyScalar(1.15);
  // The overlay lives at the scene root (NOT inside the bot's model): other modules (skins, killcam, spectate) walk the model looking for
  // "the" skinned mesh, and must never find ours. It copies the body's world matrix right before it is drawn, so it never lags a frame.
  function attachRim(r) {
    try {
      if (!r || !r.model || r.gmRim) return;
      let body = null; r.model.traverse(o => { if (o.isSkinnedMesh && !/visor/i.test(o.name) && !body) body = o; });
      if (!body) return;
      const mat = rimMaterial().clone(); mat.name = 'gmRim';
      rimCol(r, mat.uniforms.uCol.value);
      const ov = new T.SkinnedMesh(body.geometry, mat); ov.bind(body.skeleton, body.bindMatrix); ov.frustumCulled = false; ov.renderOrder = 3; ov.castShadow = ov.receiveShadow = false; ov.name = 'gmRimMesh'; ov.visible = false;
      ov.matrixAutoUpdate = false; ov.matrixWorldNeedsUpdate = false;
      ov.onBeforeRender = () => { ov.matrixWorld.copy(body.matrixWorld); ov.bindMatrixInverse.copy(ov.matrixWorld).invert(); };
      scene.add(ov);
      r.gmRim = { ov, body, mat }; RIMS.add(r); M.rims = RIMS.size;
    } catch (e) { M.err = 'rim ' + e.message; }
  }
  function dropRim(r) { const R = r.gmRim; if (!R) return; try { scene.remove(R.ov); R.mat.dispose(); } catch (e) {} r.gmRim = null; RIMS.delete(r); }
  function updateRims() {
    const on = M.level >= 2;
    for (const r of Array.from(RIMS)) {
      const R = r.gmRim; if (!R) { RIMS.delete(r); continue; }
      if (!r.root.parent || (typeof robots !== 'undefined' && !robots.includes(r))) { dropRim(r); continue; }
      if (R.ov.geometry !== R.body.geometry) R.ov.geometry = R.body.geometry;
      const op = R.body.material && R.body.material.transparent ? R.body.material.opacity : 1;
      let seen = true;
      if (on && typeof camera !== 'undefined') { const p = r.root.position, cp = camera.position; _rv.set(p.x - cp.x, p.y + 1 - cp.y, p.z - cp.z); const d2 = _rv.lengthSq(); camera.getWorldDirection(_rf); seen = d2 < 2025 && (_rv.dot(_rf) > -1.2); }
      R.ov.visible = on && seen && R.body.visible && op > .05 && r.root.visible;
      R.mat.uniforms.uOp.value = op; R.mat.uniforms.uK.value = (M.level >= 3 ? .24 : .26) * M.rimK;
    }
    M.rims = RIMS.size;
  }
  /* contact shadows: ONE instanced draw call for all players (soft 2-lobe falloff, stretched away from the sun, fades while airborne).
     The game's own hard blob under each bot is hidden while this is on. */
  const CS = { im: null, n: 24, a: null };
  function initContact() {
    if (CS.im) return;
    const g = new T.PlaneGeometry(1, 1); g.rotateX(-Math.PI / 2); CS.a = new T.InstancedBufferAttribute(new Float32Array(CS.n), 1); g.setAttribute('aA', CS.a);
    const mat = new T.ShaderMaterial({
      uniforms: T.UniformsUtils.merge([T.UniformsLib.fog, {}]),
      vertexShader: `#include <common>
#include <fog_pars_vertex>
attribute float aA; varying vec2 vUv; varying float vA;
void main(){ vUv = uv; vA = aA; vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mvPosition;
#include <fog_vertex>
}`,
      fragmentShader: `#include <common>
#include <fog_pars_fragment>
varying vec2 vUv; varying float vA;
void main(){
  vec2 p = vUv * 2.0 - 1.0; float r2 = dot(p, p);
  float a = 0.85 * pow(1.0 - smoothstep(0.04, 1.0, r2), 1.4) * vA;   // wide soft disc with a darker core: reads clearly under feet
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fd = fogDensity * vFogDepth; a *= exp(-fd * fd);
    #else
      a *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
    #endif
  #endif
  if (a < 0.003) discard;
  gl_FragColor = vec4(0.0, 0.0, 0.0, a);
}`,
      transparent: true, depthWrite: false, fog: true, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    const im = new T.InstancedMesh(g, mat, CS.n); im.frustumCulled = false; im.renderOrder = 1; im.name = 'gm_contact'; im.visible = false;
    const z = new T.Matrix4().makeScale(0, 0, 0); for (let i = 0; i < CS.n; i++) im.setMatrixAt(i, z);
    CS.im = im; scene.add(im);
  }
  const _cm = new T.Object3D();
  function updateContact() {
    if (!CS.im || typeof robots === 'undefined') return;
    const on = M.level >= 1 && !M.noContact; CS.im.visible = on;   // noContact: test switch
    let az = 0, sunH = .7;
    if (typeof sun !== 'undefined' && sun) { const dx = -sun.position.x, dz = -sun.position.z; az = Math.atan2(dx, dz); sunH = Math.max(.25, sun.position.clone().normalize().y); }
    const stretch = Math.min(1.4, 1 + .6 * (1 - sunH) + .05);
    let i = 0;
    for (const r of robots) {
      const b = r.gmBlob || (r.gmBlob = r.root && typeof HB !== 'undefined' && HB ? r.root.children.find(c => c.geometry === HB.blob) : null);
      if (b) b.visible = !(M.level >= 1);   // the game's hard disc stays hidden even when the test switch hides ours
      if (i >= CS.n) continue;
      let show = on && r.root.visible;
      if (show) {
        const p = r.root.position, g = typeof groundAt === 'function' ? groundAt(p.x, p.z, p.y + .6, .4) : p.y, air = Math.max(0, p.y - g);
        _cm.position.set(p.x, g + .025, p.z); _cm.rotation.set(0, az, 0); _cm.scale.set(1.9, 1, 1.9 * stretch); _cm.updateMatrix(); CS.im.setMatrixAt(i, _cm.matrix);
        CS.a.array[i] = Math.max(0, 1 - air * .6) * (r.dead && r.deadT > 4 ? .6 : 1);
      } else { _cm.scale.set(0, 0, 0); _cm.updateMatrix(); CS.im.setMatrixAt(i, _cm.matrix); CS.a.array[i] = 0; }
      i++;
    }
    for (; i < CS.n; i++) { _cm.scale.set(0, 0, 0); _cm.updateMatrix(); CS.im.setMatrixAt(i, _cm.matrix); CS.a.array[i] = 0; }
    CS.im.instanceMatrix.needsUpdate = true; CS.a.needsUpdate = true;
  }

  /* =====================================================================================================
     4. DECALS: persistent bullet-hole / scorch pools with fade (the game's own hole/scorch meshes are hidden while we draw)
     ===================================================================================================== */
  const D = { ready: false, kinds: {}, now: 0, amb: new T.Color(.12, .12, .12) };
  const LIFE = 150, FADE = 14;
  function decalAtlas(kind) {
    const T0 = 256, tiles = kind === 'hole' ? 4 : 2, c = canvasOf(T0 * 2), r = rng(kind === 'hole' ? 91 : 17), cg = c.getContext('2d');
    c.height = kind === 'hole' ? T0 * 2 : T0; const R = (a, b) => a + r() * (b - a);
    for (let t = 0; t < tiles; t++) {
      const tc = canvasOf(T0), g = tc.getContext('2d'); g.save(); g.translate(T0 / 2, T0 / 2);
      if (kind === 'hole') {
        let gr = g.createRadialGradient(0, 0, 0, 0, 0, 112); gr.addColorStop(0, 'rgba(0,0,0,.55)'); gr.addColorStop(.35, 'rgba(0,0,0,.3)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.beginPath(); g.arc(0, 0, 112, 0, 6.2832); g.fill();   // soot halo
        for (let i = 0; i < 9; i++) { const a = R(0, 6.28), L = R(34, 100); g.strokeStyle = `rgba(0,0,0,${R(.3, .6)})`; g.lineWidth = R(1.2, 2.4); g.beginPath(); g.moveTo(Math.cos(a) * 20, Math.sin(a) * 20); let px = Math.cos(a) * 20, py = Math.sin(a) * 20; for (let s = 0; s < 3; s++) { px += Math.cos(a + R(-.5, .5)) * L / 3; py += Math.sin(a + R(-.5, .5)) * L / 3; g.lineTo(px, py); } g.stroke(); }
        for (let i = 0; i < 26; i++) { const a = R(0, 6.28), d = R(26, 100); g.fillStyle = `rgba(215,215,215,${R(.2, .5)})`; g.beginPath(); g.arc(Math.cos(a) * d, Math.sin(a) * d, R(1, 3.2), 0, 6.28); g.fill(); }   // chips
        g.beginPath(); for (let i = 0; i <= 14; i++) { const a = i / 14 * 6.2832, rr = 34 + R(-5, 8); i ? g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : g.moveTo(Math.cos(a) * rr, Math.sin(a) * rr); } g.closePath(); g.fillStyle = 'rgba(215,215,215,.42)'; g.fill();   // chipped lighter rim (kept subtle: dark neon look)
        g.beginPath(); for (let i = 0; i <= 12; i++) { const a = i / 12 * 6.2832, rr = 25 + R(-3, 4); i ? g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : g.moveTo(Math.cos(a) * rr, Math.sin(a) * rr); } g.closePath(); g.fillStyle = 'rgba(0,0,0,1)'; g.fill();   // pit
        gr = g.createRadialGradient(0, 0, 0, 0, 0, 22); gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.beginPath(); g.arc(0, 0, 22, 0, 6.28); g.fill();
      } else {
        for (let i = 0; i < 34; i++) { const a = R(0, 6.28), d = R(0, 70), rr = R(26, 66), x = Math.cos(a) * d, y = Math.sin(a) * d, gr = g.createRadialGradient(x, y, 0, x, y, rr); gr.addColorStop(0, `rgba(0,0,0,${R(.18, .4)})`); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.beginPath(); g.arc(x, y, rr, 0, 6.28); g.fill(); }
        for (let i = 0; i < 22; i++) { const a = R(0, 6.28), L = R(60, 118); g.strokeStyle = `rgba(0,0,0,${R(.18, .45)})`; g.lineWidth = R(2, 7); g.lineCap = 'round'; g.beginPath(); g.moveTo(Math.cos(a) * 14, Math.sin(a) * 14); g.lineTo(Math.cos(a) * L, Math.sin(a) * L); g.stroke(); }
        g.globalCompositeOperation = 'destination-in'; const m = g.createRadialGradient(0, 0, 40, 0, 0, 124); m.addColorStop(0, 'rgba(0,0,0,1)'); m.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = m; g.fillRect(-T0, -T0, T0 * 2, T0 * 2);
      }
      g.restore(); cg.drawImage(tc, (t % 2) * T0, Math.floor(t / 2) * T0);
    }
    const tex = new T.CanvasTexture(c); tex.anisotropy = Math.min(8, maxAniso); tex.encoding = T.LinearEncoding; tex.generateMipmaps = true; tex.minFilter = T.LinearMipmapLinearFilter; return tex;
  }
  function decalMaterial(atlas, kind) {
    return new T.ShaderMaterial({
      uniforms: T.UniformsUtils.merge([T.UniformsLib.fog, { tAtlas: { value: atlas }, uNow: { value: 0 }, uLife: { value: LIFE }, uFade: { value: FADE }, uAmb: { value: D.amb }, uRim: { value: kind === 'hole' ? 1 : 0 } }]),
      vertexShader: `#include <common>
#include <fog_pars_vertex>
attribute float aBorn; attribute float aTile; varying vec2 vUv; varying float vAge; uniform float uNow; uniform float uLife, uFade; varying float vFd;
void main(){
  vUv = uv; vAge = uNow - aBorn; vFd = 1.0 - smoothstep(uLife - uFade, uLife, vAge) ;
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`,
      fragmentShader: `#include <common>
#include <fog_pars_fragment>
uniform sampler2D tAtlas; uniform vec3 uAmb; uniform float uRim; varying vec2 vUv; varying float vAge; varying float vFd;
void main(){
  vec4 t = texture2D(tAtlas, vUv);
  float a = t.a * vFd * smoothstep(0.0, 0.03, vAge);
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fd = fogDensity * vFogDepth; a *= exp(-fd * fd);
    #else
      a *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
    #endif
  #endif
  if (a < 0.003) discard;
  // multiplicative mark: result = surface * (1 - a + a * tone). tone 0 = soot / pit, ~1.3 = chipped lighter edge, so it works on any surface brightness
  gl_FragColor = vec4(t.rgb * 1.6 * a, a);
}`,
      transparent: true, blending: T.CustomBlending, blendEquation: T.AddEquation, blendSrc: T.DstColorFactor, blendDst: T.OneMinusSrcAlphaFactor, depthWrite: false, fog: true, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5,
    });
  }
  function makeKind(kind, size, n) {
    const atlas = decalAtlas(kind), tiles = kind === 'hole' ? 4 : 2;
    const g = new T.PlaneGeometry(1, 1), uv = g.attributes.uv, uvA = new Float32Array(n * 0);
    // one geometry per instance would be wasteful: atlas tile is chosen with an instanced attribute that remaps uv in the vertex shader
    g.setAttribute('aBorn', new T.InstancedBufferAttribute(new Float32Array(n).fill(-1e5), 1));
    g.setAttribute('aTile', new T.InstancedBufferAttribute(new Float32Array(n), 1));
    const mat = decalMaterial(atlas, kind);
    mat.vertexShader = mat.vertexShader.replace('vUv = uv;', `float tt = aTile; vUv = vec2((mod(tt, 2.0) + uv.x) * 0.5, (floor(tt * 0.5) + uv.y) * ${kind === 'hole' ? '0.5' : '1.0'});`);
    const im = new T.InstancedMesh(g, mat, n); im.frustumCulled = false; im.renderOrder = 1; im.name = 'gm_' + kind; im.visible = false;
    const z = new T.Matrix4().makeScale(0, 0, 0); for (let i = 0; i < n; i++) im.setMatrixAt(i, z);
    const K = { kind, im, n, pool: n, idx: 0, size, tiles, born: g.attributes.aBorn, tile: g.attributes.aTile, mat };
    D.kinds[kind] = K; scene.add(im); return K;
  }
  const _o = new T.Object3D(), _sz = new T.Vector2();
  function placeDecal(p, n, s, kind) {
    const K = D.kinds[kind]; if (!K || !K.im.visible) return;
    const i = K.idx % K.pool; K.idx = (K.idx + 1) % K.pool;
    const sz = K.size * Math.min(2.2, Math.max(.7, s)) * (.9 + Math.random() * .25);
    _o.position.set(p.x + n.x * .007, p.y + n.y * .007, p.z + n.z * .007); _o.lookAt(p.x + n.x, p.y + n.y, p.z + n.z); _o.rotateZ(Math.random() * 6.2832); _o.scale.setScalar(sz); _o.updateMatrix();
    K.im.setMatrixAt(i, _o.matrix); K.im.instanceMatrix.needsUpdate = true;
    K.born.array[i] = D.now; K.tile.array[i] = (Math.random() * K.tiles) | 0; K.born.needsUpdate = K.tile.needsUpdate = true;
    // the slot a few places ahead starts fading now, so the ring never pops marks out of existence
    const j = (i + 6) % K.pool; if (K.born.array[j] > -1e4 && D.now - K.born.array[j] < LIFE - 1.2) K.born.array[j] = D.now - (LIFE - 1.2);
    M.placed[kind]++;
  }
  function applyDecalLevel() {
    const L = M.level, game = typeof DK !== 'undefined' ? DK : {};
    const pools = [0, 96, 224, 320], spools = [0, 24, 56, 72];
    if (D.kinds.hole) { D.kinds.hole.pool = Math.min(D.kinds.hole.n, pools[L] || 1); D.kinds.hole.im.visible = L > 0; D.kinds.hole.idx %= D.kinds.hole.pool; }
    if (D.kinds.scorch) { D.kinds.scorch.pool = Math.min(D.kinds.scorch.n, spools[L] || 1); D.kinds.scorch.im.visible = L > 0; D.kinds.scorch.idx %= D.kinds.scorch.pool; }
    if (game.hole) game.hole.im.visible = L === 0;
    if (game.scorch) game.scorch.im.visible = L === 0;
  }
  function clearMine() { for (const k of Object.values(D.kinds)) { k.born.array.fill(-1e5); k.born.needsUpdate = true; k.idx = 0; } M.placed.hole = M.placed.scorch = 0; }
  function updateDecalAmb() {
    let l = .12, col = null;
    try { scene.traverse(o => { if (o.isHemisphereLight && !col) col = o.color.clone().multiplyScalar(Math.min(1.5, o.intensity)); }); } catch (e) {}
    if (col) { l = (col.r + col.g + col.b) / 3; D.amb.copy(col).lerp(new T.Color(l, l, l), .5).multiplyScalar(.5); D.amb.r = Math.min(.3, Math.max(.05, D.amb.r)); D.amb.g = Math.min(.3, Math.max(.05, D.amb.g)); D.amb.b = Math.min(.3, Math.max(.05, D.amb.b)); }
  }

  /* =====================================================================================================
     5. EDGES: SMAA (3 passes, after the grade) + contrast-adaptive sharpening
     ===================================================================================================== */
  let smaa = null, cas = null, smaaPromise = null;
  const CDN = 'https://cdn.jsdelivr.net/npm/three@0.147.0/examples/js/';
  const loadScript = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('load ' + src)); document.head.appendChild(s); });
  function ensurePasses() {
    if (cas) return Promise.resolve();
    const CAS = {
      uniforms: { tDiffuse: { value: null }, uRes: { value: new T.Vector2(1, 1) }, uAmt: { value: .5 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform sampler2D tDiffuse; uniform vec2 uRes; uniform float uAmt; varying vec2 vUv;
void main(){
  vec2 px = 1.0 / uRes;
  vec3 e = texture2D(tDiffuse, vUv).rgb, b = texture2D(tDiffuse, vUv + vec2(0.0, -px.y)).rgb, d = texture2D(tDiffuse, vUv + vec2(-px.x, 0.0)).rgb, f = texture2D(tDiffuse, vUv + vec2(px.x, 0.0)).rgb, h = texture2D(tDiffuse, vUv + vec2(0.0, px.y)).rgb;
  vec3 mn = min(min(min(d, e), min(f, b)), h), mx = max(max(max(d, e), max(f, b)), h);
  vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, vec3(0.001)), 0.0, 1.0));
  float peak = -1.0 / mix(8.0, 5.0, uAmt);
  vec3 w = amp * peak;
  vec3 col = clamp((w * (b + d + f + h) + e) / (1.0 + 4.0 * w), 0.0, 1.0);
  gl_FragColor = vec4(col, 1.0);
}`,
    };
    cas = new T.ShaderPass(CAS); cas.enabled = false; cas.needsSwap = true; composer.addPass(cas);
    if (!smaaPromise) smaaPromise = (T.SMAAPass ? Promise.resolve() : loadScript(CDN + 'shaders/SMAAShader.js').then(() => loadScript(CDN + 'postprocessing/SMAAPass.js'))).then(() => {
      smaa = new T.SMAAPass(Math.max(4, renderer.domElement.width), Math.max(4, renderer.domElement.height)); smaa.enabled = false; smaa.needsSwap = true;
      smaa.materialWeights.defines.SMAA_MAX_SEARCH_STEPS = '4'; smaa.materialEdges.defines.SMAA_THRESHOLD = '0.13';   // cost: about 1/3 less than the stock 8 steps / 0.1
      const i = composer.passes.indexOf(cas); composer.insertPass(smaa, i < 0 ? composer.passes.length : i);
      M.smaaOk = true;
    }).catch(e => { M.notes.push('smaa: ' + e.message); });
    return smaaPromise;
  }
  function applyEdges() {
    const L = M.level, msaa = composer.renderTarget1 ? composer.renderTarget1.samples : 0, GU = grade.uniforms;
    const wantSmaa = L >= 2 && msaa === 0 && M.smaaOk && !M.edgeLite, wantCas = L >= 3 && !!cas;   // High relies on graphics.js's own sharpen (a whole extra full-screen pass costs about 0.15 ms)
    if (smaa) smaa.enabled = wantSmaa;
    if (cas) { cas.enabled = wantCas; cas.uniforms.uAmt.value = L >= 3 ? .45 : .7; cas.uniforms.uRes.value.set(Math.max(1, renderer.domElement.width), Math.max(1, renderer.domElement.height)); }
    const Tt = window.S9GFX && S9GFX.TIERS && S9GFX.TIERS[S9GFX.tier];      // graphics.js values (restored when we are off / lower tier)
    if (GU.uAA && Tt) { GU.uAA.value = wantSmaa ? 0 : Tt.aa; GU.uSharp.value = Tt.sharp; }   // graphics.js's own local-contrast sharpen stays (CAS only adds, so textured glow keeps its contrast)
  }

  /* =====================================================================================================
     6. SHADOWS (static sun shadow map rendered at map load): bigger map, soft PCF, bias tuned per tier
     ===================================================================================================== */
  let shadowOrig = null;
  function sizeShadows() {
    if (!shadowOrig) shadowOrig = { high: QUALITY.high && QUALITY.high.shadow, ultra: QUALITY.ultra && QUALITY.ultra.shadow };
    const L = M.level;
    if (QUALITY.high && shadowOrig.high) QUALITY.high.shadow = M.enabled && L >= 2 ? 4096 : shadowOrig.high;
    if (QUALITY.ultra && shadowOrig.ultra) QUALITY.ultra.shadow = M.enabled && L >= 3 ? 6144 : shadowOrig.ultra;
  }
  function applyShadows() {
    if (typeof sun === 'undefined' || !sun || !sun.shadow) return;
    const L = M.level; sizeShadows();
    const soft = L >= 3, type = soft ? T.PCFSoftShadowMap : T.PCFShadowMap;   // PCF soft costs about +1.1 ms at 1080p (36 shadow reads per pixel): Ultra only; High uses plain PCF on the bigger map with a wider kernel
    if (!inMatch() && renderer.shadowMap.type !== type) {
      renderer.shadowMap.type = type;
      const bump = root => root && root.traverse(o => { if (o.material) [].concat(o.material).forEach(m => { m.needsUpdate = true; }); });
      bump(scene); if (typeof gunScene !== 'undefined') bump(gunScene);
      M.needWarm = true;
    }
    if (L >= 2) { sun.shadow.bias = L >= 3 ? -.00016 : -.00022; sun.shadow.normalBias = L >= 3 ? .014 : .02; sun.shadow.radius = L >= 3 ? 1 : 1.6; }
    else { sun.shadow.bias = -.0004; sun.shadow.normalBias = .03; sun.shadow.radius = 1; }
  }

  /* =====================================================================================================
     7. APPLY + HOOKS
     ===================================================================================================== */
  function applyAll() {
    M.level = wantLevel();
    try { applyDetail(); applyDecalLevel(); applyEdges(); updateContact(); updateRims(); } catch (e) { M.err = 'apply ' + e.message; console.warn('[gfxmat]', e); }
  }
  async function bring() {
    // heavy, once: textures, passes, pools; then flags the current map. Only in the menu (never while a match runs)
    if (M.busy) return; M.busy = true;
    const t0 = performance.now();
    try {
      M.level = wantLevel();
      if (M.level > 0) {
        if (!TEX) { TEX = await makeTextures(); TEX.forEach((t, i) => { KP[i].gmTex.value = t; }); M.texMs = Math.round(performance.now() - t0); }
        if (!D.ready) { makeKind('hole', .36, 320); makeKind('scorch', 1.5, 72); initContact(); D.ready = true; }
        if (M.level >= 2) await ensurePasses();
        updateDecalAmb();
        for (const t of TEX || []) { try { renderer.initTexture(t); } catch (e) {} }
        M.map = typeof CUR_MAP !== 'undefined' ? CUR_MAP : M.map;
        flagMap();
      }
      applyShadows(); applyAll();
      if (typeof applyQuality === 'function' && !inMatch()) applyQuality();
      if (M.started && M.level > 0 && !inMatch()) warmMine();
    } catch (e) { M.err = 'bring ' + (e && e.message); console.warn('[gfxmat]', e); }
    M.busy = false; M.buildMs = Math.round(performance.now() - t0);
  }
  function warmMine() {
    try {
      if (!M.level) return;
      for (const r of (typeof robots !== 'undefined' ? robots : [])) if (!r.gmRim) attachRim(r);
      const was = []; for (const k of Object.values(D.kinds)) { was.push(k.im.visible); k.im.visible = true; } const cw = CS.im ? CS.im.visible : false; if (CS.im) CS.im.visible = true;
      updateRims(); const prev = []; for (const r of RIMS) { prev.push(r.gmRim.ov.visible); r.gmRim.ov.visible = true; }
      composer.render(0);
      let i = 0; for (const r of RIMS) r.gmRim.ov.visible = prev[i++];
      i = 0; for (const k of Object.values(D.kinds)) k.im.visible = was[i++]; if (CS.im) CS.im.visible = cw;
      M.needWarm = false;
    } catch (e) { M.err = 'warm ' + e.message; }
  }
  const _applyQuality = applyQuality;
  applyQuality = function () {
    try { M.level = wantLevel(); sizeShadows(); if (M.level !== M.applied) M.edgeLite = false; } catch (e) {}
    const r = _applyQuality.apply(this, arguments);
    try {
      if (!M.started) return r;
      const L1 = wantLevel(), up = L1 > M.applied;
      if (L1 > 0 && (!TEX || up) && !inMatch() && !M.busy) bring();
      else { M.level = L1; applyShadows(); applyAll(); M.applied = L1; }
    } catch (e) { M.err = 'aq ' + e.message; }
    return r;
  };
  const _loadMap = loadMap;
  loadMap = async function (id) {
    const r = await _loadMap.apply(this, arguments);
    try {
      M.map = typeof CUR_MAP !== 'undefined' ? CUR_MAP : id; M.level = wantLevel(); M.edgeLite = false; M.slow = 0;
      if (M.level > 0 && TEX) { flagMap(); updateDecalAmb(); clearMine(); }
      applyShadows(); applyAll(); M.needWarm = true;
    } catch (e) { M.err = 'loadMap ' + e.message; }
    return r;
  };
  // the post chain's LAST enabled pass draws to the screen, every other pass into a buffer: three.js builds a separate program for each
  // (output encoding sRGB vs linear). Which pass is last depends on the tier (Ultra adds CAS after the grade, High may add SMAA) and on
  // the scope pass (guns2026): a mid-match tier switch or the first scope-in built the grade/CAS/SMAA/scope shader for its new role (2
  // compiles = a hitch; gfxlook gate 'no shader built after the match started'). Every full-screen pass from the grade on is compiled
  // here for BOTH roles; three.js keeps both programs per material, so later role changes never compile.
  function warmPost() {
    try {
      if (typeof composer === 'undefined' || !composer || !composer.passes) return;
      const gi = typeof grade !== 'undefined' ? composer.passes.indexOf(grade) : -1, mats = new Set();
      for (const p of composer.passes.slice(Math.max(0, gi))) { if (!p) continue; for (const v of Object.values(p)) if (v && v.isMaterial) mats.add(v); if (p.fsQuad && p.fsQuad.material) mats.add(p.fsQuad.material); }
      if (!mats.size) return;
      const sc = new T.Scene(), cam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1), geo = new T.PlaneGeometry(2, 2), prev = renderer.getRenderTarget();
      for (const m of mats) { const q = new T.Mesh(geo, m); q.frustumCulled = false; sc.add(q); }
      for (const tgt of [null, composer.renderTarget1 || composer.readBuffer || null]) { try { renderer.setRenderTarget(tgt); renderer.compile(sc, cam); } catch (e) {} }
      renderer.setRenderTarget(prev); geo.dispose(); M.postWarm = mats.size;
    } catch (e) { M.err = 'warmPost ' + e.message; }
  }
  if (typeof warmShaders === 'function') { const _ws = warmShaders; warmShaders = function () { const r = _ws.apply(this, arguments); warmMine(); warmPost(); return r; }; }
  if (typeof buildBot === 'function') { const _bb = buildBot; buildBot = function () { const r = _bb.apply(this, arguments); if (M.level > 0) attachRim(r); return r; }; }
  if (typeof newRoster === 'function') { const _nr = newRoster; newRoster = function () { for (const r of Array.from(RIMS)) dropRim(r); const x = _nr.apply(this, arguments); try { if (M.level > 0) for (const r of robots) attachRim(r); } catch (e) {} return x; }; }
  if (typeof decal === 'function') { const _d = decal; decal = function (p, n, s, kind) { const r = _d.apply(this, arguments); try { if (M.level > 0) placeDecal(p, n, s || 1, kind || 'hole'); } catch (e) {} return r; }; }
  if (typeof clearDecals === 'function') { const _cd = clearDecals; clearDecals = function () { const r = _cd.apply(this, arguments); try { clearMine(); } catch (e) {} return r; }; }
    if (typeof frame === 'function') {
    const _frame = frame;
    frame = function (now) {
      try {
        if (typeof state !== 'undefined' && state !== 'paused' && M.lastNow) D.now += Math.min(.1, (now - M.lastNow) / 1000);   // marks age with play time (not while paused)
        M.lastNow = now;
        for (const k of Object.values(D.kinds)) k.mat.uniforms.uNow.value = D.now;
        if (M.level > 0 || CS.im) { updateRims(); updateContact(); }
        if (smaa && smaa.enabled && state === 'play' && window.S9GFX) { if ((M.fc = (M.fc || 0) + 1) % 90 === 0) { const g = S9GFX.gpuMs || 0; M.slow = g > 11.5 ? (M.slow || 0) + 1 : 0; if (M.slow >= 3) { M.edgeLite = true; M.slow = 0; applyEdges(); M.notes.push('SMAA switched off: the graphics card is the bottleneck (' + g + ' ms), FXAA stays'); } } }
        if (cas && cas.enabled) { renderer.getDrawingBufferSize(_sz); if (cas.uniforms.uRes.value.x !== _sz.x || cas.uniforms.uRes.value.y !== _sz.y) cas.uniforms.uRes.value.copy(_sz); }
      } catch (e) {}
      return _frame(now);
    };
  }

  /* ---------- public ---------- */
  M.setEnabled = on => { M.enabled = !!on; M.level = wantLevel(); applyShadows(); if (M.enabled && !TEX && !inMatch()) bring(); else { applyAll(); if (M.needWarm && !inMatch()) warmMine(); } };
  M.rebuild = () => { flagMap(); applyAll(); };
  M.status = () => {
    const sh = typeof sun !== 'undefined' && sun && sun.shadow ? { size: sun.shadow.mapSize.x, bias: sun.shadow.bias, normalBias: sun.shadow.normalBias, radius: sun.shadow.radius } : {};
    return { ready: M.ready, busy: !!M.busy, level: M.level, enabled: M.enabled, tier: tierNow(), map: (typeof CUR_MAP !== 'undefined' ? CUR_MAP : M.map), flagged: M.flagged, kinds: M.kinds.slice(), rims: M.rims, texMs: M.texMs, buildMs: M.buildMs, err: M.err, notes: M.notes.slice(),
      gmK: UG.gmK.value, tri: UG.gmTri.value, smaa: !!(smaa && smaa.enabled), cas: !!(cas && cas.enabled), smaaOk: M.smaaOk, softShadow: renderer.shadowMap.type === T.PCFSoftShadowMap, shadow: sh,
      decals: { ready: D.ready, holePool: D.kinds.hole ? D.kinds.hole.pool : 0, scorchPool: D.kinds.scorch ? D.kinds.scorch.pool : 0, placed: Object.assign({}, M.placed), now: D.now, gameHoleVisible: typeof DK !== 'undefined' && DK.hole ? DK.hole.im.visible : null },
      contact: !!(CS.im && CS.im.visible) };
  };
  M.CS = CS; M.D = D; M.UG = UG; M.KP = KP; M.get = () => ({ smaa, cas, TEX, RIMS });
  M.rimK = 1;   // edge-light strength x per map (graphics.js LOOK.rim: dark maps get a brighter edge instead of a flat body colour)
  M.setRimK = k => { M.rimK = k > 0 ? +k : 1; };
  M.setRimBase = c => { if (c) RIMB.setRGB(c[0], c[1], c[2]); else RIMB.copy(RIM0); for (const r of RIMS) if (r.gmRim) rimCol(r, r.gmRim.mat.uniforms.uCol.value); };
  window.S9GFXM = M;
  // graphics.js counts materials it upgraded; ours are upgraded too (its hook runs first inside ours), so count them for its status
  if (window.S9GFX && S9GFX.status) { const _st = S9GFX.status; S9GFX.status = function () { const s = _st.apply(this, arguments); try { s.patched = Math.max(s.patched, M.flagged); } catch (e) {} return s; }; }

  /* ---------- start: when the menu is up and graphics.js is ready ---------- */
  const iv = setInterval(() => {
    if (typeof state === 'undefined' || state !== 'menu') return;
    if (window.S9GFX && !S9GFX.ready) return;
    clearInterval(iv); M.started = true;
    (async () => {
      await bring(); M.applied = M.level;
      if (M.level > 0) { try { warmShaders(); } catch (e) {} }
      M.ready = true; window.dispatchEvent(new Event('s9gfxm'));
    })();
  }, 60);
})();
