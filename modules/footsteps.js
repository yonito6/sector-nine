/* Sector Nine: footsteps that match the floor.
   - A surface map is built once per map (from the visible floor triangles: kit pieces + every other map mesh),
     so finding what is under someone's feet at runtime is one array lookup (no rays, no allocations).
   - Each surface has its own sound (heel + toe roll, separate jump landings), 4 step + 3 landing variations,
     rendered once from the recipes in data/surfaces.json into small audio buffers.
   - Replaces sfx.step (you) and sfx.foeStep (bots + online players, 3D HRTF, same distance rules) and adds
     steps to the killcam replay. Persistent voice chains + the old per-half-second budget: no cut-outs.
   Works as a plain add-on (wraps window.__s9.sfx); the same file runs in Node to render the WAV files. */
(function () {
  'use strict';

  /* ===================== sound synthesis (shared by the browser and render/sfx/render_steps.js) ===================== */
  function rng(seed) { let a = seed >>> 0; return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  // RBJ biquad (lp / hp / bp with 0 dB peak), run in place over a range of a buffer
  function biquad(type, f, q, sr) {
    const w = 2 * Math.PI * Math.min(f, sr * .45) / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * Math.max(q, .05));
    let b0, b1, b2; const a0 = 1 + al, a1 = -2 * cs, a2 = 1 - al;
    if (type === 'lp') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; } else if (type === 'hp') { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; } else { b0 = al; b1 = 0; b2 = -al; }
    return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  }
  // one strike (heel, toe or a landing foot) of a surface recipe added into out[] starting at sample s0
  function strike(out, sr, rec, s0, gain, R, opt) {
    const N = out.length, J = (v, k) => v * (1 + (R() * 2 - 1) * k);
    for (const L of rec.layers) {
      const st = s0 + Math.round(((L.at || 0) + (R() * 2 - 1) * .002) * sr); if (st >= N) continue;
      const tauK = opt.tauK, g = J(L.g || 1, .12) * gain;
      if (L.t === 'thump') {
        if (opt.noThump) continue;
        const f0 = J(L.f0, .06) * opt.fK, f1 = L.f1 * opt.fK, tau = L.tau * tauK, gg = g * opt.thumpK, len = Math.min(N - st, Math.ceil(tau * 7 * sr)); let ph = 0;
        for (let i = 0; i < len; i++) { const t = i / sr, f = f1 + (f0 - f1) * Math.exp(-t / (tau * .6)); ph += 2 * Math.PI * f / sr; out[st + i] += Math.sin(ph) * gg * Math.exp(-t / tau) * Math.min(1, t / .0015); }
      } else if (L.t === 'noise') {
        const tau = L.tau * tauK, atk = L.atk || .001, len = Math.min(N - st, Math.ceil((tau * 7 + atk) * sr)), c = biquad(L.type, J(L.f, .07), L.q || .7, sr); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
        for (let i = 0; i < len; i++) { const t = i / sr, x = R() * 2 - 1, y = c[0] * x + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2; x2 = x1; x1 = x; y2 = y1; y1 = y;
          out[st + i] += y * g * (t < atk ? t / atk : Math.exp(-(t - atk) / tau)); }
      } else if (L.t === 'ring') {
        for (const p of L.p) { const f = J(p[0], .05) * opt.fK, a = J(p[1], .15) * gain, tau = p[2] * tauK, len = Math.min(N - st, Math.ceil(tau * 7 * sr)), ph0 = R() * 6.283;
          for (let i = 0; i < len; i++) { const t = i / sr; out[st + i] += Math.sin(ph0 + 2 * Math.PI * f * t) * a * Math.exp(-t / tau) * Math.min(1, t / .0008); } }
      } else if (L.t === 'grains') {
        const n = Math.max(1, Math.round(J(L.n, .25) * (opt.land ? 1.4 : 1))), w = L.w * tauK;
        for (let k = 0; k < n; k++) { const gs = st + Math.floor(Math.pow(R(), 1.6) * w * sr); if (gs >= N) continue;
          const c = biquad(L.type, L.f * (1 + (R() * 2 - 1) * (L.fs || .3)), L.q || 1, sr), tau = L.tau * (.6 + R() * .8), len = Math.min(N - gs, Math.ceil(tau * 7 * sr)), ga = g * (.4 + R() * .8); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
          for (let i = 0; i < len; i++) { const x = R() * 2 - 1, y = c[0] * x + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; out[gs + i] += y * ga * Math.exp(-i / sr / tau); } }
      } else if (L.t === 'chirps') {
        const n = Math.max(1, Math.round(L.n * (opt.land ? 1.5 : 1)));
        for (let k = 0; k < n; k++) { if (R() > (L.p ?? 1)) continue; const cs = st + Math.floor(R() * L.w * tauK * sr); if (cs >= N) continue;
          const f0 = L.f0 * (.8 + R() * .4), f1 = L.f1 * (.8 + R() * .4), d = L.d * (.7 + R() * .6), len = Math.min(N - cs, Math.ceil(d * sr)), ga = g * (.5 + R() * .7); let ph = 0;
          for (let i = 0; i < len; i++) { const u = i / len, f = f0 + (f1 - f0) * u; ph += 2 * Math.PI * f / sr; out[cs + i] += Math.sin(ph) * ga * Math.sin(Math.PI * u); } }
      }
    }
  }
  // a full footstep sound: kind 'step' (heel + toe) or 'land' (two feet, heavier, longer)
  function renderSound(rec, kind, variant, sr, cfg, name) {
    cfg = cfg || {}; const R = rng(hash((name || '') + ':' + kind + ':' + variant)), land = kind === 'land';
    const len = Math.min(cfg.maxLen || .34, rec.len * (land ? 1.2 : 1) + (land ? .03 : 0)), N = Math.ceil(len * sr), out = new Float32Array(N);
    if (land) {
      strike(out, sr, rec, 0, 1, R, { tauK: 1.35, fK: .86, thumpK: 1.5, land: true });
      strike(out, sr, rec, Math.round((.018 + R() * .012) * sr), .7, R, { tauK: 1.2, fK: .92, thumpK: 1.2, land: true });
    } else {
      strike(out, sr, rec, 0, 1, R, { tauK: 1, fK: 1, thumpK: 1 });
      strike(out, sr, rec, Math.round((rec.roll + (R() * 2 - 1) * .008) * sr), rec.toe, R, { tauK: .85, fK: 1.08, thumpK: .35 });
    }
    // loudness: same RMS for every surface over the first 120 ms (so the recipe 'gain' is the only difference), peak-limited, faded out
    let e = 0; const m = Math.min(N, Math.round(.12 * sr)); for (let i = 0; i < m; i++) e += out[i] * out[i];
    let k = (cfg.targetRms || .16) / Math.max(1e-6, Math.sqrt(e / m)), pk = 0; for (let i = 0; i < N; i++) pk = Math.max(pk, Math.abs(out[i] * k)); if (pk > .97) k *= .97 / pk;
    const fade = Math.round(.03 * sr); for (let i = 0; i < N; i++) out[i] *= k * (i > N - fade ? (N - i) / fade : 1);
    return out;
  }
  const SYNTH = { rng, hash, renderSound };
  if (typeof window === 'undefined') { if (typeof module !== 'undefined') module.exports = SYNTH; return; }

  /* ===================== browser: data, surface map, playback ===================== */
  const FS = window.FOOTSTEPS = window.FOOTSTEPS || {};
  if (FS.installed) return; FS.installed = true; FS.synth = SYNTH;
  FS.errors = 0; FS.log = []; FS.logOn = false; FS.counts = {}; FS.stats = { built: {}, plays: 0, skipped: 0, fallback: 0 };
  let D = null, NAMES = [], SID = {}, IGN = 255;
  const S9 = () => window.__s9;
  const src = (document.currentScript && document.currentScript.src) || '';
  const base = src ? src.replace(/modules\/footsteps\.js.*$/, '') : '';
  FS.ready = fetch(base + 'data/surfaces.json', { cache: 'no-cache' }).then(r => r.json()).then(j => { setData(j); return true; }).catch(e => { FS.errors++; FS.loadError = String(e); return false; });
  function setData(j) {
    D = j; NAMES = j.surfaces.slice(); SID = {}; NAMES.forEach((n, i) => { SID[n] = i; }); SID.ignore = IGN; FS.data = j; FS.names = NAMES;
    FS.mapId = null; buffersFor = {}; // rebuild with the new data
  }
  FS.setData = setData;
  const sidOf = name => (name in SID ? SID[name] : SID.concrete);

  /* ---------- classification: which surface a material/piece is ---------- */
  function mapCfg() { return (D.maps && D.maps[FS.mapId]) || {}; }
  function kitSurface(piece, mat) {
    const mc = mapCfg(), pm = (mc.pieces && mc.pieces[piece]) ?? (D.pieces && D.pieces[piece]);
    if (typeof pm === 'string') return pm === 'ignore' || /^m_glow/.test(mat) ? 'ignore' : pm;
    if (pm && pm[mat]) return pm[mat];
    return (mc.kitMaterials && mc.kitMaterials[mat]) || D.kitMaterials[mat] || 'metal';
  }
  function texName(m) { const t = m && m.map, im = t && t.image, s = im && (im.currentSrc || im.src); return s ? s.split('/').pop().replace(/_diff\.jpg.*$/, '') : ''; }
  function meshSurface(o) {
    const m = Array.isArray(o.material) ? o.material[0] : o.material, mc = mapCfg();
    if (!m || m.isShaderMaterial || m.isMeshBasicMaterial || m.isPointsMaterial || m.isSpriteMaterial || m.visible === false) return 'ignore';
    const tn = texName(m); if (tn && D.textures[tn]) return D.textures[tn];
    if (!tn && m.color) { const hx = m.color.getHexString(), cm = mc.colors && mc.colors[hx]; if (cm) return cm; if (D.colors && D.colors[hx]) return D.colors[hx]; }
    const us = o.userData.surface; if (us && us !== 'concrete' && SID[us] !== undefined) return us;
    if (m.isMeshPhysicalMaterial) return m.transparent ? (mc.physicalTransparent || 'glass') : (mc.physicalOpaque || 'glass');
    if (m.transparent && m.opacity < .6) return 'ignore';   // decals, holograms
    if ((m.metalness || 0) >= .35) return 'metal';
    return us === 'concrete' && mc.ground ? 'concrete' : (us || 'concrete');
  }

  /* ---------- the surface map: a grid of floor layers (height + surface) ---------- */
  // build: rasterise every upward-facing visible triangle at 2x2 samples per cell; overlapping surfaces within
  // mergeHeight of each other share a layer and the one covering more of the cell wins (thin trims on a deck don't count)
  let G = null;
  FS.grid = () => G;
  function* builder(mapId) {
    const s9 = S9(), L = D.lookup, cs = L.cell, half = s9.HALF + 2, N = Math.ceil(half * 2 / cs), K = L.layers, NN = N * N, ss = cs / 2, M = Math.round(L.mergeHeight * 100), slope = L.maxSlope;
    const H = new Int16Array(NN * K), A = new Uint8Array(NN * K), B = new Uint8Array(NN * K), CA = new Uint8Array(NN * K), CB = new Uint8Array(NN * K), HA = new Int16Array(NN * K), HB = new Int16Array(NN * K), C = new Uint8Array(NN);
    let tris = 0, samples = 0; FS.sources = {};
    function add(cell, yc, s) {
      const b = cell * K, n = C[cell];
      for (let k = 0; k < n; k++) { const q = b + k; if (Math.abs(H[q] - yc) <= M) { if (yc > H[q]) H[q] = yc;
          if (A[q] === s) { if (CA[q] < 255) CA[q]++; if (yc > HA[q]) HA[q] = yc; } else if (CB[q] === 0 || B[q] === s) { B[q] = s; if (CB[q] < 255) CB[q]++; if (CB[q] === 1 || yc > HB[q]) HB[q] = yc; } return; } }
      // full (tall stacks: terraces, roofs): keep the lowest layers, they are where people walk
      // full (thick rocks, terraces, roofs): drop the most buried layer, the one with the least head room above it
      // (an inner face of a rock under its snow cap), never the top surface
      if (n >= K) { let worst = -1, wg = 1e9; for (let k = 0; k <= n; k++) { const hk = k < n ? H[b + k] : yc; let gap = 1e9;
          for (let m2 = 0; m2 <= n; m2++) { const hm = m2 < n ? H[b + m2] : yc; if (hm > hk && hm - hk < gap) gap = hm - hk; } if (gap < wg) { wg = gap; worst = k; } }
        if (worst === n || worst < 0) return; const q = b + worst; H[q] = yc; A[q] = s; CA[q] = 1; HA[q] = yc; CB[q] = 0; return; }
      const q = b + n; H[q] = yc; A[q] = s; CA[q] = 1; HA[q] = yc; CB[q] = 0; C[cell] = n + 1;
    }
    function tri(ax, ay, az, bx, by, bz, cx, cy, cz, s) {
      const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (nl < 1e-9 || ny / nl < slope) return; tris++;
      // scanline: per sample row, the x span the triangle covers; height from the triangle's plane
      const gx = -nx / ny, gz = -nz / ny, e = 1e-7;
      const z0 = Math.max(0, Math.ceil((Math.min(az, bz, cz) + half) / ss - .5)), z1 = Math.min(2 * N - 1, Math.floor((Math.max(az, bz, cz) + half) / ss - .5));
      for (let j = z0; j <= z1; j++) { const pz = -half + (j + .5) * ss; let lo = 1e9, hi = -1e9;
        if ((az <= pz + e && bz >= pz - e) || (bz <= pz + e && az >= pz - e)) { if (Math.abs(bz - az) < e) { lo = Math.min(lo, ax, bx); hi = Math.max(hi, ax, bx); } else { const x = ax + (pz - az) * (bx - ax) / (bz - az); if (x < lo) lo = x; if (x > hi) hi = x; } }
        if ((bz <= pz + e && cz >= pz - e) || (cz <= pz + e && bz >= pz - e)) { if (Math.abs(cz - bz) < e) { lo = Math.min(lo, bx, cx); hi = Math.max(hi, bx, cx); } else { const x = bx + (pz - bz) * (cx - bx) / (cz - bz); if (x < lo) lo = x; if (x > hi) hi = x; } }
        if ((cz <= pz + e && az >= pz - e) || (az <= pz + e && cz >= pz - e)) { if (Math.abs(az - cz) < e) { lo = Math.min(lo, cx, ax); hi = Math.max(hi, cx, ax); } else { const x = cx + (pz - cz) * (ax - cx) / (az - cz); if (x < lo) lo = x; if (x > hi) hi = x; } }
        if (hi < lo) continue;
        const i0 = Math.max(0, Math.ceil((lo + half) / ss - .5 - 1e-6)), i1 = Math.min(2 * N - 1, Math.floor((hi + half) / ss - .5 + 1e-6)), row = (j >> 1) * N, yz = ay + gz * (pz - az);
        for (let i = i0; i <= i1; i++) { const px = -half + (i + .5) * ss; samples++; add(row + (i >> 1), Math.round((yz + gx * (px - ax)) * 100), s); } }
    }
    let t0 = performance.now(); const slice = () => performance.now() - t0 > FS.sliceMs;
    // 1) kit pieces, from the placement log (piece + material known exactly)
    const log = s9.MKLOG && s9.MKLOG[mapId], MKIT = s9.MKIT || {};
    if (log) for (const pc of log.pieces) {
      if (pc.piece === 'solid_block') { if (!pc.visible) continue; const sid = sidOf(kitSurface('solid_block', pc.material || 'm_concrete')); if (sid === IGN) continue;
        const [w, h, dd] = pc.size, y = pc.y + h; tri(pc.x - w / 2, y, pc.z - dd / 2, pc.x - w / 2, y, pc.z + dd / 2, pc.x + w / 2, y, pc.z + dd / 2, sid); tri(pc.x - w / 2, y, pc.z - dd / 2, pc.x + w / 2, y, pc.z + dd / 2, pc.x + w / 2, y, pc.z - dd / 2, sid); continue; }
      const parts = MKIT[pc.piece]; if (!parts) continue;
      const a = (pc.quarterTurns || 0) * Math.PI / 2, ca = Math.cos(a), sa = Math.sin(a), X = pc.x, Y = pc.y || 0, Z = pc.z;
      for (const { m, geo } of parts) {
        const sid = sidOf(kitSurface(pc.piece, m)); if (sid === IGN) continue;
        if (FS.debugSources) { const k = NAMES[sid] + ' <- kit ' + pc.piece + ':' + m; FS.sources[k] = (FS.sources[k] || 0) + 1; }
        const P = geo.attributes.position, I = geo.index, n = I ? I.count : P.count, arr = P.array, st = P.isInterleavedBufferAttribute ? P.data.stride : 3, off = P.offset || 0;
        for (let t = 0; t < n; t += 3) {
          const o0 = (I ? I.getX(t) : t) * st + off, o1 = (I ? I.getX(t + 1) : t + 1) * st + off, o2 = (I ? I.getX(t + 2) : t + 2) * st + off;
          tri(arr[o0] * ca + arr[o0 + 2] * sa + X, arr[o0 + 1] + Y, -arr[o0] * sa + arr[o0 + 2] * ca + Z,
              arr[o1] * ca + arr[o1 + 2] * sa + X, arr[o1 + 1] + Y, -arr[o1] * sa + arr[o1 + 2] * ca + Z,
              arr[o2] * ca + arr[o2 + 2] * sa + X, arr[o2 + 1] + Y, -arr[o2] * sa + arr[o2 + 2] * ca + Z, sid);
        }
        if (slice()) { yield; t0 = performance.now(); }
      }
    }
    const PH = FS.phases = { t: performance.now() }; PH.kit = 0;
    // 2) every other visible map mesh (floors, boxes, terrain, ice), by its material
    const meshes = [], _bb = new s9.THREE.Box3(); s9.MAPROOT.updateMatrixWorld(true);
    s9.MAPROOT.traverseVisible(o => { if (!o.isMesh || o.isSkinnedMesh || o.isInstancedMesh) return; if (o.userData.dyn && o.material && o.material.userData && o.material.userData.keep && log) return; meshes.push(o); });
    for (const o of meshes) {
      const sid = sidOf(meshSurface(o)); if (sid === IGN) continue;
      // the huge backdrop plane round the arena (900 m, just under the floor) is never walked on
      { const gb = o.geometry.boundingBox || (o.geometry.computeBoundingBox(), o.geometry.boundingBox); if (gb) { _bb.copy(gb).applyMatrix4(o.matrixWorld); if (_bb.max.x - _bb.min.x > half * 6 && _bb.max.y < .01) continue; } }
      if (FS.debugSources) { const m = o.material, k = NAMES[sid] + ' <- ' + (o.name || o.geometry.type) + ' ' + m.type + ' ' + (texName(m) || '#' + (m.color ? m.color.getHexString() : '')) + ' us=' + (o.userData.surface || ''); FS.sources[k] = (FS.sources[k] || 0) + 1; }
      const g = o.geometry, P = g.attributes.position; if (!P) continue; const I = g.index, n = I ? I.count : P.count, e = o.matrixWorld.elements;
      const W = (k, out) => { const x = P.getX(k), y = P.getY(k), z = P.getZ(k); out[0] = e[0] * x + e[4] * y + e[8] * z + e[12]; out[1] = e[1] * x + e[5] * y + e[9] * z + e[13]; out[2] = e[2] * x + e[6] * y + e[10] * z + e[14]; };
      const pa = [0, 0, 0], pb = [0, 0, 0], pcv = [0, 0, 0];
      for (let t = 0; t + 2 < n; t += 3) {
        W(I ? I.getX(t) : t, pa); W(I ? I.getX(t + 1) : t + 1, pb); W(I ? I.getX(t + 2) : t + 2, pcv);
        tri(pa[0], pa[1], pa[2], pb[0], pb[1], pb[2], pcv[0], pcv[1], pcv[2], sid);
        if ((t & 4095) === 0 && slice()) { yield; t0 = performance.now(); }
      }
    }
    PH.meshes = performance.now() - PH.t; PH.t = performance.now();
    // 3) water / ice zones and acid / lava / sea hazards: the floor inside them (near ground level) is that surface
    const FX = s9.MAPFX, zt = Math.round(L.zoneMaxHeight * 100), rects = [];
    if (FX) { for (const z of FX.zones || []) if (D.zones[z.type]) rects.push([z, D.zones[z.type]]); for (const h of FX.hazards || []) if (D.hazards[h.kind]) rects.push([h, D.hazards[h.kind]]); }
    for (const [r, name] of rects) { const sid = sidOf(name);
      for (let j = Math.max(0, Math.floor((r.z0 + half) / cs)); j <= Math.min(N - 1, Math.floor((r.z1 + half) / cs)); j++) for (let i = Math.max(0, Math.floor((r.x0 + half) / cs)); i <= Math.min(N - 1, Math.floor((r.x1 + half) / cs)); i++) {
        const x = -half + (i + .5) * cs, z = -half + (j + .5) * cs; if (x < r.x0 || x > r.x1 || z < r.z0 || z > r.z1) continue;
        const cell = j * N + i, b = cell * K; let hit = false;
        for (let k = 0; k < C[cell]; k++) if (H[b + k] < zt) { A[b + k] = sid; CA[b + k] = 255; CB[b + k] = 0; hit = true; }
        if (!hit && C[cell] < K) { const q = b + C[cell]; H[q] = 3; A[q] = sid; CA[q] = 255; CB[q] = 0; C[cell]++; } } }
    PH.zones = performance.now() - PH.t; PH.t = performance.now();
    // finalise: one surface per layer
    const FSu = new Uint8Array(NN * K);
    // two surfaces in one layer: the one on top wins (a plate lying on a deck) unless it covers only a sliver of the
    // cell compared with the other (a thin trim strip across wooden planks); same height = the larger area wins
    for (let c = 0, q = 0; c < NN; c++) for (let k = 0, n = C[c]; k < n; k++) { q = c * K + k; if (!CB[q]) { FSu[q] = A[q]; continue; }
      const dh = HB[q] - HA[q], topB = dh >= 1, topA = dh <= -1;
      FSu[q] = topB ? (CB[q] >= CA[q] * .35 ? B[q] : A[q]) : topA ? (CA[q] >= CB[q] * .35 ? A[q] : B[q]) : (CB[q] > CA[q] ? B[q] : A[q]); }
    const mc = mapCfg();
    PH.final = performance.now() - PH.t; PH.samples = samples;
    G = { map: mapId, N, K, cs, half, H, S: FSu, C, ground: sidOf(mc.ground || 'concrete'), tris, samples, aboveFeet: Math.round(L.aboveFeet * 100), belowFeet: Math.round(L.belowFeet * 100) };
  }
  FS.sliceMs = 3;
  let job = null, jobMap = null, jobMark = null;
  function startBuild(sync) { FS.stats.builds = (FS.stats.builds || 0) + 1;
    const s9 = S9(); FS.mapId = s9.CUR_MAP; G = null; jobMap = s9.CUR_MAP; jobMark = mapMark(); const t = performance.now();
    job = { it: builder(jobMap), t, cpu: 0 };
    if (sync) { const keep = FS.sliceMs; FS.sliceMs = 1e9; try { while (!job.it.next().done); } finally { FS.sliceMs = keep; } finishBuild(performance.now() - t); }
  }
  function finishBuild(cpu) { FS.stats.built[jobMap] = { ms: +(cpu).toFixed(1), wallMs: +(performance.now() - job.t).toFixed(0), tris: G ? G.tris : 0, cells: G ? G.N * G.N : 0 }; job = null; }
  function stepBuild() { if (!job) return; const t = performance.now(); let done = false; try { done = job.it.next().done; } catch (e) { FS.errors++; FS.lastError = String(e && e.stack || e); job = null; return; } job.cpu += performance.now() - t; if (done) finishBuild(job.cpu); }
  // a map counts as "changed" when its id or its first scene object changes (maps are torn down and rebuilt)
  // (not the child count: drops, pickups and effects come and go during a match without the map changing)
  function mapMark() { const s9 = S9(), r = s9.MAPROOT; return s9.CUR_MAP + '|' + (r && r.children.length ? r.children[0].uuid : ''); }
  FS.onMapLoaded = () => { if (D && window.__s9) startBuild(true); };   // (release guard) loadMap() can run before the game publishes window.__s9: the frame watcher builds it later   // optional: call from loadMap() while the loading screen is up
  FS.rebuild = () => startBuild(true);

  // what is under the feet at (x, yFeet, z): the highest floor layer at or a little under the feet; zero allocations
  function lookCell(cell, yc) { const b = cell * G.K, n = G.C[cell]; let best = -1, bh = -1e9;
    for (let k = 0; k < n; k++) { const h = G.H[b + k]; if (h <= yc + G.aboveFeet && h >= yc - G.belowFeet && h > bh) { bh = h; best = b + k; } } return best; }
  function surfaceAt(x, y, z) {
    if (!G) { FS.stats.fallback++; return SID[(D && mapCfgFor((S9() || {}).CUR_MAP).ground) || 'concrete'] ?? 0; }
    const i = Math.floor((x + G.half) / G.cs), j = Math.floor((z + G.half) / G.cs), N = G.N, yc = Math.round(y * 100);
    if (i < 0 || j < 0 || i >= N || j >= N) return G.ground;
    let q = lookCell(j * N + i, yc); if (q >= 0) return G.S[q];
    // standing on an edge: the nearest neighbouring cell that has floor at this height
    for (let r = 1; r <= 2; r++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) { if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue; const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue; q = lookCell(jj * N + ii, yc); if (q >= 0) return G.S[q]; }
    return G.ground;
  }
  function mapCfgFor(id) { return (D && D.maps && D.maps[id]) || {}; }
  // the water / ice / hazard surface at a point (null if none): what the zones step of the build applied
  FS.zoneSurface = (x, y, z) => { const FX = (S9() || {}).MAPFX; if (!FX || !D || y >= D.lookup.zoneMaxHeight) return null; let r = null;
    for (const q of FX.zones || []) if (D.zones[q.type] && x >= q.x0 && x <= q.x1 && z >= q.z0 && z <= q.z1) r = D.zones[q.type];
    for (const q of FX.hazards || []) if (D.hazards[q.kind] && x >= q.x0 && x <= q.x1 && z >= q.z0 && z <= q.z1) r = D.hazards[q.kind]; return r; };
  FS.surfaceAt = surfaceAt; FS.classify = { meshSurface: o => { FS.mapId = FS.mapId || (S9() || {}).CUR_MAP; return meshSurface(o); }, kitSurface: (piece, mat) => kitSurface(piece, mat), texName };
  FS.surfaceName = (x, y, z) => NAMES[surfaceAt(x, y, z)];
  FS.layersAt = (x, z) => { if (!G) return []; const i = Math.floor((x + G.half) / G.cs), j = Math.floor((z + G.half) / G.cs), c = j * G.N + i, out = []; for (let k = 0; k < G.C[c]; k++) out.push([G.H[c * G.K + k] / 100, NAMES[G.S[c * G.K + k]]]); return out; };

  /* ---------- sound buffers: rendered from the recipes on first audio use, a few per frame ---------- */
  let buffersFor = {}, warmQ = null;
  function bufferSet(ctx, name) {
    let b = buffersFor[name]; if (b) return b;
    const rec = D.sounds[name] || D.sounds.concrete, R = D.render, sr = R.sampleRate || 32000;
    b = buffersFor[name] = { step: [], land: [], last: -1, lastL: -1, gain: rec.gain || 1 };
    for (let v = 0; v < (R.stepVariants || 4); v++) b.step.push(toBuf(ctx, renderSound(rec, 'step', v, sr, R, name), sr));
    for (let v = 0; v < (R.landVariants || 3); v++) b.land.push(toBuf(ctx, renderSound(rec, 'land', v, sr, R, name), sr));
    return b;
  }
  function toBuf(ctx, data, sr) { const b = ctx.createBuffer(1, data.length, sr); b.copyToChannel ? b.copyToChannel(data, 0) : b.getChannelData(0).set(data); return b; }
  function warm(ctx) { if (!warmQ) warmQ = NAMES.slice(); const t = performance.now(); while (warmQ.length && performance.now() - t < 4) { const n = warmQ.shift(); try { bufferSet(ctx, n); } catch (e) { FS.errors++; FS.lastError = String(e); } } }

  /* ---------- voice chains: created once, reused (only a buffer source per step is new) ---------- */
  let CH = null, baseDry = null;
  function chains(AU) {
    if (CH && CH.ctx === AU.ctx) return CH;
    // your steps go to the game's step bus; enemy steps to whatever bus the game routes enemy steps to (the settings
    // add-on swaps AU.dry for its "enemy footsteps boost" bus during sfx.foeStep). Chains are made from the frame loop,
    // never inside a wrapped call, so 'base' is the real step bus.
    const c = AU.ctx, mx = D.mix, fp = mx.foePanner, base = baseDry || AU.dry, meOut = c.createGain(), foeOut = c.createGain(); meOut.connect(base); foeOut.connect(base);
    CH = { ctx: c, me: [], foe: [], next: 0, nextF: 0, base, meOut, foeOut, foeDest: base };
    const mk = (pos) => { const g = c.createGain(), lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 12000; lp.Q.value = .5; g.connect(lp); let out = lp, pan = null;
      if (pos) { pan = c.createPanner(); pan.panningModel = fp.model || 'HRTF'; pan.distanceModel = fp.distance || 'inverse'; pan.refDistance = fp.ref; pan.rolloffFactor = fp.rolloff; pan.maxDistance = fp.max; lp.connect(pan); out = pan; }
      out.connect(pos ? foeOut : meOut); const vs = c.createGain(); vs.gain.value = pos ? fp.verb : mx.playerVerb; out.connect(vs); if (AU.verb) vs.connect(AU.verb);
      return { g, lp, pan, busy: 0 }; };
    for (let i = 0; i < 4; i++) CH.me.push(mk(false));
    for (let i = 0; i < 10; i++) CH.foe.push(mk(true));
    return CH;
  }
  const budget = { t: 0, n: 0 };
  function pickChain(list, now, start) { for (let k = 0; k < list.length; k++) { const ch = list[(start + k) % list.length]; if (ch.busy <= now) return ch; } return null; }
  const R01 = (a, b) => a + Math.random() * (b - a);
  // who: 'me' | 'foe'; mode: walk | sprint | land | crouch; pos (foe only); sid: surface id
  function play(who, mode, sid, pos, tag, at) {
    const s9 = S9() || {}, AU = s9.AU; if (!AU || !AU.ctx || !D || !AU.dry) return false;
    const c = AU.ctx, now = c.currentTime, mx = D.mix;
    // another add-on rendering a game sound offline (killcam v2 pre-renders sfx.step): play our buffer straight into
    // its offline graph, without touching the live voice chains
    if ((CH && c !== CH.ctx) || (typeof OfflineAudioContext !== 'undefined' && c instanceof OfflineAudioContext)) {
      const set = bufferSet(c, NAMES[sid] || 'concrete'), m = mx[who === 'foe' ? 'foe' : 'player'], b = (mode === 'land' ? set.land : set.step)[0];
      const g = c.createGain(); g.gain.value = (mode === 'land' ? m.land : mode === 'sprint' ? m.sprint : m.walk) * (mode === 'crouch' ? m.crouch : 1) * set.gain;
      const sn = c.createBufferSource(); sn.buffer = b; sn.playbackRate.value = mx.rate[mode] || 1; sn.connect(g); g.connect(AU.dry); sn.start(0); return true; }
    if (who === 'foe') {
      if (s9.camera.position.distanceTo(pos) > mx.foePanner.maxDistance) { FS.stats.skipped++; return false; }
      // the game's own voice budget when it is reachable (shared counters), else the same rule here
      if (typeof voice === 'function' && typeof VOICES !== 'undefined' && VOICES.foestep) { if (!voice('foestep', pos)) { FS.stats.skipped++; return false; } }
      else { if (now - budget.t >= .5) { budget.t = now; budget.n = 0; } if (budget.n >= mx.foePanner.budgetPerHalfSecond) { FS.stats.skipped++; return false; } budget.n++; }
    }
    const name = NAMES[sid] || 'concrete', set = bufferSet(c, name), land = mode === 'land', list = land ? set.land : set.step;
    let v = Math.floor(Math.random() * list.length); if (list.length > 1 && v === (land ? set.lastL : set.last)) v = (v + 1) % list.length; if (land) set.lastL = v; else set.last = v;
    const C = chains(AU);
    if (who === 'foe' && AU.dry !== C.base && AU.dry !== C.foeDest) { try { C.foeOut.disconnect(); C.foeOut.connect(AU.dry); C.foeDest = AU.dry; } catch (e) {} }
    const L = who === 'foe' ? C.foe : C.me, ch = pickChain(L, now, who === 'foe' ? C.nextF : C.next); if (!ch) { FS.stats.skipped++; return false; }
    if (who === 'foe') { C.nextF = (L.indexOf(ch) + 1) % L.length; } else C.next = (L.indexOf(ch) + 1) % L.length;
    const m = mx[who === 'foe' ? 'foe' : 'player'], crouch = mode === 'crouch', base = land ? m.land : mode === 'sprint' ? m.sprint : m.walk;
    const vol = base * (crouch ? m.crouch : 1) * set.gain * (mx.calibration || 1) * R01(mx.random.vol[0], mx.random.vol[1]), rate = (mx.rate[mode] || 1) * R01(mx.random.rate[0], mx.random.rate[1]);
    const buf = list[v], s = c.createBufferSource(); s.buffer = buf; s.playbackRate.value = rate; s.connect(ch.g);
    ch.g.gain.setValueAtTime(vol, now); ch.lp.frequency.setValueAtTime(mx.lp[mode] || 12000, now);
    if (ch.pan) { if (ch.pan.positionX) { ch.pan.positionX.setValueAtTime(pos.x, now); ch.pan.positionY.setValueAtTime(pos.y, now); ch.pan.positionZ.setValueAtTime(pos.z, now); } else ch.pan.setPosition(pos.x, pos.y, pos.z); }
    s.start(now); ch.busy = now + buf.duration / rate + .03; AU.count = (AU.count || 0) + 1; FS.stats.plays++;
    FS.counts[name] = (FS.counts[name] || 0) + 1;
    if (FS.logOn) { const q = pos || at; FS.log.push({ who, mode, surface: name, x: q ? q.x : null, y: q ? q.y : null, z: q ? q.z : null, vol, rate, tag: tag || '', t: now, gt: ((S9() || {}).G || {}).time }); if (FS.log.length > 2000) FS.log.splice(0, 500); }
    return true;
  }
  FS.play = play; FS.route = () => CH ? { foeOnOwnBus: CH.foeDest !== CH.base } : null;
  // for other add-ons with their own audio bus (killcam v2 replay): the right footstep buffer for a spot, no playback
  FS.bufferAt = (x, y, z, mode) => { const AU = (S9() || {}).AU; if (!AU || !AU.ctx || !D) return null; const set = bufferSet(AU.ctx, NAMES[surfaceAt(x, y, z)] || 'concrete'), L = mode === 'land' ? set.land : set.step; return L[Math.floor(Math.random() * L.length)]; }; FS.warmed = () => !!warmQ && !warmQ.length;

  /* ---------- hooks into the game ---------- */
  let wrapped = false; const _mp = { x: 0, y: 0, z: 0 };
  function wrap() {
    const s9 = S9(); if (!s9 || !s9.sfx || wrapped) return; wrapped = true;
    const sfx = s9.sfx, oldStep = sfx.step, oldFoe = sfx.foeStep; FS.old = { step: oldStep, foeStep: oldFoe };
    sfx.step = function (sprint, land, crouch) {
      try { if (!D || FS.disabled) return oldStep.apply(this, arguments); const p = s9.P.pos;
        _mp.x = p.x; _mp.y = p.y; _mp.z = p.z; play('me', land ? 'land' : crouch ? 'crouch' : sprint ? 'sprint' : 'walk', surfaceAt(p.x, p.y, p.z), null, 'me', _mp); }
      catch (e) { FS.errors++; FS.lastError = String(e && e.stack || e); }
    };
    sfx.foeStep = function (pos, sprint, land, crouch) {
      try { if (!D || FS.disabled) return oldFoe.apply(this, arguments);
        play('foe', land ? 'land' : crouch ? 'crouch' : sprint ? 'sprint' : 'walk', surfaceAt(pos.x, pos.y, pos.z), pos, 'foe'); }
      catch (e) { FS.errors++; FS.lastError = String(e && e.stack || e); }
    };
  }

  /* ---------- killcam: the replay has no live movement, so steps come from the recorded positions ---------- */
  const KC = { lastRt: null, acc: [], prev: [], air: [], deathT: null };
  const _kp = { x: 0, y: 0, z: 0 }, _kv = { x: 0, y: 0, z: 0, distanceTo(o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z); } };
  function recAt(F, t, j, out) { let i = 0; while (i < F.length - 2 && F[i + 1].t < t) i++; const a = F[i], b = F[Math.min(i + 1, F.length - 1)], A = j < 0 ? a.me : a.b[j], B = (j < 0 ? b.me : b.b[j]) || A; if (!A) return false;
    const k = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0; out.x = A[0] + (B[0] - A[0]) * k; out.y = A[1] + (B[1] - A[1]) * k; out.z = A[2] + (B[2] - A[2]) * k; return true; }
  function killcamTick() {
    const s9 = S9(), REC = s9.REC; if (!REC || window.S9KC) return;   // killcam v2 (modules/killcam.js) plays its own replay steps
    if (!(s9.state === 'dead' && REC.on && REC.frozenFrames && REC.lastRt > -1e8)) { KC.lastRt = null; return; }
    const F = REC.frozenFrames, rt = REC.lastRt;
    if (KC.deathT !== REC.deathT || KC.lastRt === null || rt < KC.lastRt) { KC.deathT = REC.deathT; KC.lastRt = rt; KC.acc.length = KC.prev.length = KC.air.length = 0; return; }
    const dt = rt - KC.lastRt; KC.lastRt = rt; if (dt <= 0 || dt > .25 || rt >= REC.deathT - .02) return;
    const n = F[0].b.length;
    for (let j = -1; j < n; j++) {
      const k = j + 1; if (!recAt(F, rt, j, _kp)) { KC.prev[k] = null; continue; }
      const pv = KC.prev[k] || (KC.prev[k] = { x: _kp.x, y: _kp.y, z: _kp.z });
      const hs = Math.hypot(_kp.x - pv.x, _kp.z - pv.z) / dt, vy = (_kp.y - pv.y) / dt, air = Math.abs(vy) > 1.5;
      if (KC.air[k] && !air && vy <= 0) { _kv.x = _kp.x; _kv.y = _kp.y; _kv.z = _kp.z; play('foe', 'land', surfaceAt(_kp.x, _kp.y, _kp.z), _kv, 'killcam'); }
      KC.air[k] = air; pv.x = _kp.x; pv.y = _kp.y; pv.z = _kp.z;
      if (air || hs < 1.2) continue;
      const sprint = hs > 5, stride = sprint ? 2.4 : 1.85; KC.acc[k] = (KC.acc[k] || 0) + hs * dt;
      if (KC.acc[k] > stride) { KC.acc[k] = 0; _kv.x = _kp.x; _kv.y = _kp.y; _kv.z = _kp.z;
        const fr = F[F.length - 1], row = j < 0 ? fr.me : fr.b[j], crouch = row && (j < 0 ? row[5] : row[6]) > .5;
        play('foe', crouch ? 'crouch' : sprint ? 'sprint' : 'walk', surfaceAt(_kp.x, _kp.y, _kp.z), _kv, 'killcam'); }
    }
  }

  /* ---------- per frame: wrap once, (re)build the surface map when the map changes, warm buffers, killcam ---------- */
  FS.perf = { n: 0, total: 0, max: 0 };
  function tick() {
    requestAnimationFrame(tick); if (FS.disabled) return; const t0 = performance.now();
    try {
      const s9 = S9(); if (!s9 || !D) return; wrap();
      if (s9.CUR_MAP && s9.MAPROOT && s9.MAPROOT.children.length) {
        const ld = document.getElementById('mapload'), loading = ld && !ld.hidden;
        if (!loading && mapMark() !== jobMark && !(G && G.map === s9.CUR_MAP && mapMark() === FS.builtMark)) { startBuild(false); }
        if (job) { stepBuild(); if (!job) FS.builtMark = jobMark; }
      }
      if (s9.AU && s9.AU.ctx && s9.AU.dry) { if (!baseDry || (CH && CH.ctx !== s9.AU.ctx)) baseDry = s9.AU.dry; chains(s9.AU); }
      if (s9.AU && s9.AU.ctx && (!warmQ || warmQ.length)) warm(s9.AU.ctx);
      killcamTick();
    } catch (e) { FS.errors++; FS.lastError = String(e && e.stack || e); }
    const dt = performance.now() - t0; FS.perf.n++; FS.perf.total += dt; if (dt > FS.perf.max) FS.perf.max = dt;
  }
  const _sb = startBuild; startBuild = function (sync) { _sb(sync); if (sync) FS.builtMark = jobMark; };
  requestAnimationFrame(tick);
})();
