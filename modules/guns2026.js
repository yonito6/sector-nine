/* Sector Nine — 2026 gun look (window.S9Guns26). First pass: K-7 Carbine, M-2 Pistol, R-90 Longbow (GUNS below).
   What it does (first-person viewmodel only; third-person / bots untouched):
   1. Materials: every painted/metal part of the gun gets a per-gun twin of its material with a 2026 layer on top:
      tri-planar detail mask (micro-scratches, composite weave, ceramic armour plates with seams, grunge) at a fixed texel density,
      per-part future material (ceramic plate / composite / anodised alloy / polymer) with its own tint, roughness, metalness,
      edge wear (baked hard-edge attribute + noise) that chips the coating down to bare alloy, cavity AO, derivative bump.
      The twin keeps the source's maps/emissive Color (heat glow still works) and is registered with S9GunSkins.alias(),
      so finishes still find the part's role and paint over it; Factory brings the twin back. Weak tier (Performance) keeps
      the original simple materials (twins are swapped out, never compiled mid-match).
   2. Decals: one merged decal mesh per gun (invented brands, serials, stencils; 1 draw call), raycast onto flat faces.
      Holo readouts: pistol ammo counter, Longbow zoom/range panel (additive canvas planes, redrawn only on change).
   3. Optics: crisp canvas reticles with a dark halo (reads on bright and dark backgrounds), iridescent AR-coated glass with
      a view-dependent glint; pistol gets a projected holo frame; Longbow scope view = one post pass (only while scoped):
      eye-box parallax shadow driven by look/move sway, lens edge chromatic + barrel distortion, analytic AA mil reticle that
      flips light/dark with the background, illuminated chevron; DOM readout (zoom, range at 10 Hz). The CSS #scope is hidden.
   4. ADS: critically damped spring for the gun's hip->ADS travel (soft start, no overshoot, exact alignment when settled),
      ADS inertia (roll + dip from the spring velocity), cheap defocus of the near gun body while aiming (mip bias + softer
      normals by view distance, in the twin shader; High/Ultra only).
   API: S9Guns26 = { version, ready, on, guns, enable(), disable(), report(), _cfg }.
   Hooks: wraps buildGunVM (upgrade rebuilt viewmodels), updateViewmodel (ADS curve, inertia, readouts, scope), applyQuality (tier switch).
   Needs: gunskins (alias + roles), loads after gunpolish. Data: none (all textures generated at load, ~60 ms). */
(() => {
'use strict';
if (window.S9Guns26) return;
const API = window.S9Guns26 = { version: 1, ready: false, on: false, guns: ['carbine', 'pistol', 'sniper'], error: null };
const gv = name => { try { return (0, eval)(`typeof ${name} !== 'undefined' ? ${name} : undefined`); } catch (e) { return undefined; } };
let T = null;

/* ------------------------------------------------------------------ per-gun identity */
// linear colours; kind: 0 ceramic plate, 1 composite weave, 2 anodised alloy, 3 polymer
const Z = (kind, tint, rough, metal, o = {}) => Object.assign({ kind, tint, rough, metal, recol: .88, wear: .8, scr: .7, bump: .55, keep: 0 }, o);
const CFG = {
  carbine: { brand: 'HALCYON ARMS', bare: [.5, .51, .53], zones: {
    rbody: Z(0, [.5, .48, .43], .38, .04, { recol: 1, wear: 1 }),          // bone ceramic armour shell (owner: no orange paint patches)
    rtrim: Z(2, [.045, .055, .075], .3, .92, { recol: .75 }),              // blue-black anodised alloy
    strim: Z(3, [.035, .037, .04], .62, .15, { wear: 0, scr: .15 }), body: Z(2, [.05, .055, .065], .32, .9), trim: Z(1, [.03, .032, .036], .46, .1),
    metal: Z(2, [.4, .41, .43], .24, 1, { wear: .3 }), grip: Z(3, [.03, .03, .032], .78, 0, { wear: .3 }) },
    decals: [
      { r: 'halcyon', side: 'top', x: 0, z: -.42, w: .12, dark: true }, { r: 'k7', side: 'top', x: .005, z: .3, w: .1, dark: true },
      { r: 'cellK', side: -1, y: -.11, z: -.4, w: .1, dark: true },
      { r: 'k7', side: 1, y: -.11, z: -.4, w: .09, dark: true } ] },
  pistol: { brand: 'KESTREL DYNAMICS', bare: [.55, .56, .58], zones: {
    body: Z(1, [.035, .037, .043], .42, .08, { wear: .9 }),                // graphite composite frame + slide
    acc: Z(2, [.42, .17, .07], .27, .95, { recol: .92 }),                   // copper-anodised slide top
    trim: Z(0, [.026, .026, .029], .55, .05), metal: Z(2, [.55, .56, .58], .2, 1, { wear: .2 }),
    grip: Z(3, [.028, .03, .034], .82, 0, { wear: .25, bump: .9 }), strim: Z(3, [.035, .037, .04], .62, .15, { wear: 0 }) },
    decals: [
      { r: 'kestrel', side: 'top', x: 0, z: -.005, w: .08 }, { r: 'm2', side: -1, y: .024, z: -.05, w: .07 },
      { r: 'serialP', side: -1, y: -.016, z: -.08, w: .045 } ],
  },
  sniper: { brand: 'ORBITAL FOUNDRY', bare: [.5, .51, .53], zones: {
    acc: Z(0, [.6, .4, .035], .38, .04, { wear: 1 }),                       // signal-yellow ceramic plates
    body: Z(0, [.055, .06, .066], .4, .1), trim: Z(1, [.025, .027, .03], .44, .1),
    metal: Z(2, [.3, .31, .33], .26, 1, { wear: .3 }), grip: Z(3, [.03, .03, .033], .8, 0, { wear: .25 }),
    strim: Z(3, [.035, .037, .04], .62, .15, { recol: 1, wear: 0, scr: .15 }) },   // plain matte scope tube
    decals: [
      { r: 'serialS', side: 'top', x: 0, z: .28, w: .06, dark: true },
      { r: 'orbital', side: -1, y: -.01, z: 0, w: .14 } ],
  },
};
API._cfg = CFG;

/* ------------------------------------------------------------------ generated textures */
function hash(n) { n = (n << 13) ^ n; return 1 - ((n * (n * n * 15731 + 789221) + 1376312589) & 0x7fffffff) / 1073741824; }
function maskTexture(S = 1024) {
  // value noise, tileable
  const vn = (G, seed) => { const L = new Float32Array(G * G); for (let i = 0; i < G * G; i++) L[i] = hash(i * 7 + seed * 131) * .5 + .5; return (x, y) => { const fx = x * G, fy = y * G, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy, a = ix % G, b = iy % G, a1 = (a + 1) % G, b1 = (b + 1) % G, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty); return (L[b * G + a] * (1 - sx) + L[b * G + a1] * sx) * (1 - sy) + (L[b1 * G + a] * (1 - sx) + L[b1 * G + a1] * sx) * sy; }; };
  const n1 = vn(8, 1), n2 = vn(16, 2), n3 = vn(32, 3), n4 = vn(64, 4), n5 = vn(128, 5);
  // scratches + plates drawn on 2D canvases
  const cv = () => { const c = document.createElement('canvas'); c.width = c.height = S; return c; };
  const sc = cv(), g = sc.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, S, S); g.lineCap = 'round';
  let seed = 9; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 1700; i++) {
    const x = rnd() * S, y = rnd() * S, dir = rnd() < .65 ? (rnd() - .5) * .5 : rnd() * Math.PI, len = 8 + Math.pow(rnd(), 2.2) * 150, cx = Math.cos(dir) * len, cy = Math.sin(dir) * len;
    g.strokeStyle = `rgba(255,255,255,${.18 + rnd() * .7})`; g.lineWidth = .5 + rnd() * 1.1;
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) { if ((ox && Math.min(x, x + cx) > 160 && Math.max(x, x + cx) < S - 160) || (oy && Math.min(y, y + cy) > 160 && Math.max(y, y + cy) < S - 160)) continue;
      g.beginPath(); g.moveTo(x + ox, y + oy); g.quadraticCurveTo(x + ox + cx * .5 + (rnd() - .5) * 8, y + oy + cy * .5 + (rnd() - .5) * 8, x + ox + cx, y + oy + cy); g.stroke(); }
  }
  const pc = cv(), q = pc.getContext('2d'); q.fillStyle = '#fff'; q.fillRect(0, 0, S, S);
  q.filter = 'blur(2.2px)'; q.strokeStyle = '#000'; q.lineWidth = 5;
  const cols = [0, 330, 700], rows = [0, 260, 540, 800];
  for (const r of rows) { q.beginPath(); q.moveTo(-10, r); q.lineTo(S + 10, r); q.stroke(); }
  rows.forEach((r, i) => { const r2 = rows[i + 1] ?? S; for (const c0 of cols) { const c = (c0 + i * 170) % S; q.beginPath(); q.moveTo(c, r); q.lineTo(c, r2); q.stroke(); } });
  q.fillStyle = '#000'; rows.forEach((r, i) => { for (const c0 of cols) { const c = (c0 + i * 170) % S; for (const [dx, dy] of [[14, 14], [-14, 14]]) { q.beginPath(); q.arc((c + dx + S) % S, r + dy, 3.2, 0, 6.283); q.fill(); } } });
  q.filter = 'none';
  const sd = g.getImageData(0, 0, S, S).data, pd = q.getImageData(0, 0, S, S).data, out = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4, u = x / S, v = y / S;
    const gr = n1(u, v) * .4 + n2(u, v) * .27 + n3(u, v) * .17 + n4(u, v) * .1 + n5(u, v) * .06;
    const cx = x >> 4, cy = y >> 4, fx = (x & 15) / 16, fy = (y & 15) / 16;     // 2x2 twill, 16 px strands
    const wv = ((cx + (cy >> 1)) & 1) ? .5 + .5 * Math.sin(Math.PI * fy) : .5 + .5 * Math.sin(Math.PI * fx);
    out[i] = Math.min(255, sd[i] * (.55 + gr * .8)); out[i + 1] = wv * 255; out[i + 2] = pd[i]; out[i + 3] = gr * 255;
  }
  const t = new T.DataTexture(out, S, S, T.RGBAFormat); t.wrapS = t.wrapT = T.RepeatWrapping; t.magFilter = T.LinearFilter; t.minFilter = T.LinearMipmapLinearFilter;
  t.generateMipmaps = true; t.anisotropy = 8; t.needsUpdate = true; return t;
}
// decal atlas: each entry draws into its own cell (512 x 128 px); white/grey ink on transparent, tinted per quad by vertex colour
const DECAL = {
  halcyon: g => { glyphRing(g, 60, 64, 40); txt(g, 'HALCYON ARMS', 118, 62, 46, 900, 3); txt(g, 'K-7 // PULSE CARBINE  ·  4.6 kJ', 120, 102, 20, 500, 2); },
  k7: g => { txt(g, 'K-7', 10, 92, 92, 900, -2); txt(g, 'CL.III', 220, 56, 26, 600, 4); txt(g, 'NEO-KYOTO', 220, 96, 26, 600, 4); },
  serialK: g => { txt(g, 'SN 2091-K7-0447-ΔX', 8, 52, 34, 600, 2); barcode(g, 8, 72, 380, 40); },
  cellK: g => { hazard(g, 0, 18, 120, 92); txt(g, 'CELL 4.2kV', 140, 62, 40, 800, 2); txt(g, '▲ DO NOT VENT', 140, 104, 26, 600, 3); },
  chev: g => { for (let k = 0; k < 4; k++) { g.beginPath(); g.moveTo(40 + k * 110, 20); g.lineTo(100 + k * 110, 64); g.lineTo(40 + k * 110, 108); g.lineTo(70 + k * 110, 108); g.lineTo(130 + k * 110, 64); g.lineTo(70 + k * 110, 20); g.closePath(); g.fill(); } },
  kestrel: g => { g.beginPath(); g.moveTo(14, 96); g.lineTo(60, 24); g.lineTo(78, 60); g.lineTo(104, 30); g.lineTo(90, 96); g.closePath(); g.fill(); txt(g, 'KESTREL', 118, 70, 52, 900, 4); txt(g, 'DYNAMICS · M-2', 120, 106, 24, 600, 5); },
  m2: g => { txt(g, 'M-2', 8, 90, 88, 900, -2); txt(g, '6.8 PLASMA', 190, 56, 30, 700, 3); txt(g, 'SAFE ◦ FIRE ●', 190, 98, 28, 600, 2); },
  serialP: g => { txt(g, 'KD-2093-0118', 8, 54, 40, 700, 2); barcode(g, 8, 74, 300, 36); },
  orbital: g => { g.lineWidth = 7; g.beginPath(); g.ellipse(64, 64, 50, 20, -.4, 0, 6.283); g.stroke(); g.beginPath(); g.arc(64, 64, 16, 0, 6.283); g.fill(); txt(g, 'ORBITAL FOUNDRY', 130, 66, 40, 900, 3); txt(g, 'LUNAR SHIPYARD 4 · R-90', 132, 104, 22, 600, 3); },
  r90: g => { txt(g, 'R-90 LONGBOW', 8, 64, 52, 900, 2); txt(g, 'RAIL-ASSIST  ·  12.7 MAG-SLUG', 10, 104, 24, 600, 2); },
  serialS: g => { txt(g, 'OF-R90-77Δ-0031', 8, 52, 36, 700, 2); barcode(g, 8, 72, 360, 40); },
  vent: g => { hazard(g, 0, 10, 150, 108); txt(g, 'HOT', 170, 84, 70, 900, 6); },
};
const DKEYS = Object.keys(DECAL), DCOLS = 2, DROWS = Math.ceil(DKEYS.length / DCOLS), DW = 512, DH = 128;
function txt(g, s, x, y, px, wt, sp) { g.font = `${wt} ${px}px "Rajdhani","Orbitron","Segoe UI",Arial,sans-serif`; try { g.letterSpacing = sp + 'px'; } catch (e) {} g.fillText(s, x, y); }
function glyphRing(g, x, y, r) { g.lineWidth = 9; g.beginPath(); g.arc(x, y, r, .5, 2.9); g.stroke(); g.beginPath(); g.arc(x, y, r, 3.6, 6.0); g.stroke(); g.beginPath(); g.arc(x, y, r * .38, 0, 6.283); g.fill(); }
function barcode(g, x, y, w, h) { let s = 7; for (let px = x; px < x + w;) { s = (s * 48271) % 2147483647; const bw = 2 + (s % 5); if (s % 3) g.fillRect(px, y, bw, h); px += bw + 2 + (s >> 3) % 3; } }
function hazard(g, x, y, w, h) { g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip(); for (let k = -h; k < w; k += 28) { g.beginPath(); g.moveTo(x + k, y + h); g.lineTo(x + k + 14, y + h); g.lineTo(x + k + 14 + h, y); g.lineTo(x + k + h, y); g.closePath(); g.fill(); } g.restore(); g.lineWidth = 4; g.strokeRect(x + 2, y + 2, w - 4, h - 4); }
function decalAtlas() {
  const c = document.createElement('canvas'); c.width = DW * DCOLS; c.height = DH * DROWS; const g = c.getContext('2d');
  g.fillStyle = g.strokeStyle = '#fff'; g.textBaseline = 'alphabetic';
  DKEYS.forEach((k, i) => { g.save(); g.translate((i % DCOLS) * DW, Math.floor(i / DCOLS) * DH); g.beginPath(); g.rect(0, 0, DW, DH); g.clip(); DECAL[k](g); g.restore(); });
  const t = new T.CanvasTexture(c); t.anisotropy = 8; t.generateMipmaps = true; t.minFilter = T.LinearMipmapLinearFilter; return t;
}
// reticles (white on transparent) + their blurred halo
function reticleTex(kind, halo) {
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d'), m = S / 2;
  if (halo) g.filter = 'blur(5px)';
  g.strokeStyle = g.fillStyle = '#fff'; g.lineCap = 'round';
  const L = halo ? 3 : 1;
  // owner 2026-11-06: ONLY a crisp glowing dot (no ring, no frame)
  const dotR = kind === 'holo' ? 13 : 22;
  g.beginPath(); g.arc(m, m, dotR + (halo ? 7 : 0), 0, 6.283); g.fill();
  const t = new T.CanvasTexture(c); t.generateMipmaps = true; t.minFilter = T.LinearMipmapLinearFilter; return t;
}
function holoFrameTex() {
  const c = document.createElement('canvas'); c.width = 512; c.height = 320; const g = c.getContext('2d');
  g.strokeStyle = g.fillStyle = '#fff'; g.lineWidth = 5; const b = 56;
  for (const [x, y, sx, sy] of [[12, 12, 1, 1], [500, 12, -1, 1], [12, 308, 1, -1], [500, 308, -1, -1]]) { g.beginPath(); g.moveTo(x, y + sy * b); g.lineTo(x, y); g.lineTo(x + sx * b, y); g.stroke(); }
  g.globalAlpha = .35; g.lineWidth = 2; g.strokeRect(30, 30, 452, 260); g.globalAlpha = .8;
  g.font = '600 22px "Rajdhani",Arial,sans-serif'; g.fillText('KD-HOLO  ▸  SYNC', 40, 290 - 12);
  const t = new T.CanvasTexture(c); t.generateMipmaps = true; t.minFilter = T.LinearMipmapLinearFilter; return t;
}
function glintTex() {
  const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64); r.addColorStop(0, 'rgba(255,255,255,.9)'); r.addColorStop(.25, 'rgba(160,120,255,.35)'); r.addColorStop(.6, 'rgba(60,200,180,.12)'); r.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  g.globalCompositeOperation = 'lighter'; const l = g.createLinearGradient(0, 0, 128, 128); l.addColorStop(.35, 'rgba(0,0,0,0)'); l.addColorStop(.5, 'rgba(255,255,255,.5)'); l.addColorStop(.65, 'rgba(0,0,0,0)');
  g.fillStyle = l; g.beginPath(); g.ellipse(64, 64, 60, 12, -.8, 0, 6.283); g.fill();
  return new T.CanvasTexture(c);
}

/* ------------------------------------------------------------------ the twin material (2026 layer) */
const U = { dof: { value: 0 } };
let MASK = null;
const VERT_P = `
attribute float g26e; attribute vec3 g26c; attribute vec3 g26f; varying vec3 g26C; varying vec3 g26F; uniform mat4 g26ToGun; varying vec3 g26P; varying vec3 g26N; varying float g26E; varying vec3 g26G; varying vec3 g26GN;`;
const FRAG_P = `
uniform sampler2D g26M; uniform float g26Tile, g26Obj, g26Kind, g26Recol, g26Keep, g26Wear, g26Scr, g26Bump, g26Rough, g26Metal, g26Dof;
uniform vec3 g26Tint, g26Bare;
varying vec3 g26P; varying vec3 g26N; varying float g26E; varying vec3 g26G; varying vec3 g26GN; varying vec3 g26C; varying vec3 g26F;
float g26b = 0.;
vec4 g26tri() {   // one tap on the dominant axis (kit parts are mostly axis-aligned; a 2-3 tap blend cost +0.3-0.6 ms)
  vec3 p = g26P * (g26Obj / g26Tile), n = abs(g26N);
  vec2 uv = n.x > n.y && n.x > n.z ? p.zy : n.y > n.z ? p.xz + .37 : p.xy + .71;
  return texture2D(g26M, uv, g26b); }
vec3 g26perturb(vec3 sp, vec3 sn, vec2 dh, float fd) { vec3 sx = dFdx(sp), sy = dFdy(sp), r1 = cross(sy, sn), r2 = cross(sn, sx); float det = dot(sx, r1) * fd;
  vec3 gr = sign(det) * (dh.x * r1 + dh.y * r2); return normalize(abs(det) * sn - gr); }`;
let CHUNKS = null;
function chunks() {
  if (CHUNKS) return CHUNKS;
  const SC = T.ShaderChunk, bias = s => s.replace(/texture2D\(\s*(normalMap|roughnessMap|metalnessMap|map)\s*,\s*vUv\s*\)/g, 'texture2D( $1, vUv, g26b )');
  const nm = bias(SC.normal_fragment_maps).replace('mapN.xy *= normalScale;', 'mapN.xy *= normalScale * .55 * (1. - g26Dof * .45);   // softer source normals: no crunchy look');
  CHUNKS = { map: bias(SC.map_fragment), rough: bias(SC.roughnessmap_fragment), metal: bias(SC.metalnessmap_fragment), nm };
  return CHUNKS;
}
let PFLAGS = '';
function patch(sh, u) {
  Object.assign(sh.uniforms, u);
  if (PFLAGS) sh.fragmentShader = PFLAGS.split(',').map(f => '#define ' + f + String.fromCharCode(10)).join('') + sh.fragmentShader;
  sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>' + VERT_P)
    .replace('#include <begin_vertex>', '#include <begin_vertex>\n g26P = position; g26N = normal; g26E = g26e; g26C = g26c; g26F = g26f; g26G = (g26ToGun * vec4(position, 1.)).xyz; g26GN = normalize(mat3(g26ToGun) * normal);');
  const C = chunks();
  sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>' + FRAG_P)
    .replace('#include <map_fragment>', `
  float g26d = length(vViewPosition); g26b = .6 + g26Dof * 2.4 * (1. - smoothstep(.16, .6, g26d));   // +0.6 mip: detail stays a soft texture
  #ifdef G26_NOTRI
  vec4 g26m = vec4(0., .5, 1., .5);
  #else
  vec4 g26m = g26tri();
  #endif
  float g26scr = g26m.r, g26wv = g26m.g, g26pl = g26m.b, g26gr = g26m.a;
  float kC = step(abs(g26Kind), .5), kW = step(abs(g26Kind - 1.), .5), kA = step(abs(g26Kind - 2.), .5), kP = step(abs(g26Kind - 3.), .5);
  float g26seam = kC * (1. - g26pl);
  float g26ed = 1.;   // distance (gun units) to the nearest hard edge of this face (barycentric, flat kit geometry)
  { vec3 fwc = max(fwidth(g26C), vec3(1e-6)); float pw = length(fwidth(g26G)) * .7071; vec3 dd = g26C / fwc * pw + (1. - g26F) * 9.; g26ed = min(dd.x, min(dd.y, dd.z)); }
  float g26edge = max(smoothstep(.8, .98, g26E), 1. - smoothstep(.0012, .0055, g26ed));   // wider soft band: no sparkly 1-px lines
  float g26wear = smoothstep(.35, .95, g26edge * (.75 + .5 * g26gr)) * g26Wear * .6 * (1. - kA * .6);
  ${C.map}
  {
    vec3 o = diffuseColor.rgb; float L = dot(o, vec3(.299, .587, .114)), sat = max(o.r, max(o.g, o.b)) - min(o.r, min(o.g, o.b));
    vec3 rc = g26Tint * (.82 + .36 * clamp(L * 2., 0., 1.2));
    rc *= mix(1., .95 + .08 * g26gr, kC + kP); rc *= mix(1., .92 + .1 * g26wv, kW); rc *= mix(1., .95 + .08 * g26gr, kA);
    float rk = g26Recol * (1. - g26Keep * smoothstep(.12, .3, sat));
    diffuseColor.rgb = mix(o, rc, rk);
    diffuseColor.rgb *= 1. - g26seam * .3;
    diffuseColor.rgb = mix(diffuseColor.rgb, g26Bare * (.8 + .3 * g26gr), g26wear);
    diffuseColor.rgb += smoothstep(.35, .9, g26scr) * g26Scr * .015 * (1. - g26wear);
  }`)
    .replace('#include <roughnessmap_fragment>', C.rough)
    .replace('#include <metalnessmap_fragment>', C.metal + `
  {
    float tr = g26Rough + .04 + (g26gr - .5) * .05 + kW * (g26wv - .5) * .08;
    roughnessFactor = mix(roughnessFactor, tr, g26Recol);
    roughnessFactor = mix(roughnessFactor, roughnessFactor * .88, smoothstep(.35, .9, g26scr) * g26Scr);
    roughnessFactor = mix(roughnessFactor, .26, g26wear);
    roughnessFactor = clamp(roughnessFactor + g26Dof * .08, .04, 1.);
    metalnessFactor = mix(metalnessFactor, g26Metal, g26Recol);
    metalnessFactor = mix(metalnessFactor, 1., g26wear);
  }`)
    .replace('#include <normal_fragment_maps>', C.nm + `
  {
    float h = kC * g26pl * .35 + kP * g26gr * .08 - g26wear * .03;   // weave is clear-coated: albedo + roughness only   // scratches stay out of the bump (sub-pixel lines sparkle)
    vec2 dh = clamp(vec2(dFdx(h), dFdy(h)), -.03, .03) * g26Bump * (1. - g26Dof * .7);
    #ifndef G26_NOBUMP
    normal = g26perturb(-vViewPosition, normal, dh, faceDirection);
    #endif
  }`)
    .replace('#include <aomap_fragment>', `#include <aomap_fragment>
  { float cav = (1. - g26seam * .65) * (.86 + .14 * g26gr); reflectedLight.indirectDiffuse *= cav; reflectedLight.indirectSpecular *= mix(1., cav, .75); }`);
}
const TWINS = new Map();   // key -> twin
function twinOf(src, gun, role, objScale, toGun) {
  const z = CFG[gun].zones[role]; if (!z) return null;
  const key = src.uuid + '|' + gun + '|' + role + '|' + toGun.elements.map(v => v.toFixed(3)).join(',');
  let m = TWINS.get(key); if (m) return m;
  m = src.clone(); m.name = (src.name || '') + '|g26'; if (src.emissive) m.emissive = src.emissive;   // shared Color: the game's heat glow still drives it
  const u = { g26M: { value: MASK }, g26Tile: { value: .9 }, g26Obj: { value: objScale }, g26Kind: { value: z.kind }, g26Recol: { value: z.recol }, g26Keep: { value: z.keep },
    g26Wear: { value: z.wear }, g26Scr: { value: z.scr }, g26Bump: { value: z.bump }, g26Rough: { value: z.rough }, g26Metal: { value: z.metal }, g26Dof: U.dof,
    g26Tint: { value: new T.Vector3(...z.tint) }, g26Bare: { value: new T.Vector3(...CFG[gun].bare) }, g26ToGun: { value: toGun.clone() } };
  m.userData.g26 = u; m.onBeforeCompile = sh => patch(sh, u); m.customProgramCacheKey = () => 'g26v1' + PFLAGS;
  try { window.S9GunSkins && S9GunSkins.alias && S9GunSkins.alias(m, src); } catch (e) {}
  TWINS.set(key, m); return m;
}
// edge wear inputs. Indexed (smooth) meshes: g26e = 1 on vertices where split normals meet (bevels). Flat (non-indexed) kit meshes:
// per-corner barycentrics g26c + per-face flags g26f (which of the 3 edges is hard: dihedral > 32 deg or open) -> constant-width band in the shader
function edgeAttr(geo) {
  if (geo.attributes.g26e) return;
  const p = geo.attributes.position, n = geo.attributes.normal; if (!p || !n) return;
  const N = p.count, q = 1e4, cos = Math.cos(32 * Math.PI / 180), e = new Float32Array(N), C = new Float32Array(N * 3), F = new Float32Array(N * 3);
  const key = i => Math.round(p.getX(i) * q) + ',' + Math.round(p.getY(i) * q) + ',' + Math.round(p.getZ(i) * q);
  if (geo.index) {
    const map = new Map();
    for (let i = 0; i < N; i++) { const k = key(i); let l = map.get(k); if (!l) map.set(k, l = []); l.push(i); }
    for (const l of map.values()) { if (l.length < 2) continue; let edge = false;
      for (let a = 0; a < l.length && !edge; a++) for (let b = a + 1; b < l.length; b++) { const i = l[a], j = l[b]; if (n.getX(i) * n.getX(j) + n.getY(i) * n.getY(j) + n.getZ(i) * n.getZ(j) < cos) { edge = true; break; } }
      if (edge) for (const i of l) e[i] = 1; }
  } else {
    const tris = N / 3 | 0, cen = new Float32Array(tris * 3), cosH = Math.cos(40 * Math.PI / 180), fn = new Float32Array(tris * 3), ks = new Array(N), edges = new Map(), a = new T.Vector3(), b = new T.Vector3(), c = new T.Vector3();
    for (let i = 0; i < N; i++) ks[i] = key(i);
    for (let t = 0; t < tris; t++) {
      a.fromBufferAttribute(p, t * 3); b.fromBufferAttribute(p, t * 3 + 1); c.fromBufferAttribute(p, t * 3 + 2); cen[t * 3] = (a.x + b.x + c.x) / 3; cen[t * 3 + 1] = (a.y + b.y + c.y) / 3; cen[t * 3 + 2] = (a.z + b.z + c.z) / 3; b.sub(a); c.sub(a); b.cross(c); const L = b.length() || 1; fn[t * 3] = b.x / L; fn[t * 3 + 1] = b.y / L; fn[t * 3 + 2] = b.z / L;
      for (let k = 0; k < 3; k++) { const k1 = ks[t * 3 + (k + 1) % 3], k2 = ks[t * 3 + (k + 2) % 3], ek = k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1; let l = edges.get(ek); if (!l) edges.set(ek, l = []); l.push(t); }
    }
    for (let t = 0; t < tris; t++) for (let k = 0; k < 3; k++) {
      const k1 = ks[t * 3 + (k + 1) % 3], k2 = ks[t * 3 + (k + 2) % 3], l = edges.get(k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1);
      let hard = false;   // convex edges only (where a real coating chips); open edges and creases stay clean
      for (const u of l) if (u !== t && fn[t * 3] * fn[u * 3] + fn[t * 3 + 1] * fn[u * 3 + 1] + fn[t * 3 + 2] * fn[u * 3 + 2] < cosH && (cen[u * 3] - cen[t * 3]) * fn[t * 3] + (cen[u * 3 + 1] - cen[t * 3 + 1]) * fn[t * 3 + 1] + (cen[u * 3 + 2] - cen[t * 3 + 2]) * fn[t * 3 + 2] < 0) hard = true;
      if (hard) for (let v = 0; v < 3; v++) F[(t * 3 + v) * 3 + k] = 1;   // edge opposite corner k
      C[(t * 3 + k) * 3 + k] = 1;
    }
  }
  geo.setAttribute('g26e', new T.BufferAttribute(e, 1)); geo.setAttribute('g26c', new T.BufferAttribute(C, 3)); geo.setAttribute('g26f', new T.BufferAttribute(F, 3));
}

/* ------------------------------------------------------------------ viewmodel upgrade */
const VMS = new Map();   // gun -> { vm, swaps:[[mesh, twin]], decal, holo, glints:[], frame }
let ATLAS = null, RET = null;
const solid = (o, T_) => o.isMesh && o.material && !Array.isArray(o.material) && o.material.isMeshStandardMaterial && !o.material.transparent && o.material.depthTest !== false && o.material !== gv('GLOVE_M') && o.material !== gv('SLEEVE_M') && !o.userData.g26;
function upgrade(vm, gun) {
  if (!vm || !vm.group || vm.group.userData.g26) return;
  const g = vm.group, rec = { vm, swaps: [], glints: [], holo: null, frame: null }; g.userData.g26 = true; VMS.set(gun, rec);
  g.updateMatrixWorld(true);
  const gs = new T.Vector3(); g.getWorldScale(gs);
  const roleOf = window.S9GunSkins && S9GunSkins._roleOf;
  // 1. decal placement (projected in the twin shader), then the twins
  // owner 2026-11-06: no decals/stickers on any gun (placeDecals kept for later, not called)
  const ginv = g.matrixWorld.clone().invert();
  g.traverse(o => {
    if (!solid(o)) return;
    const src = o.userData.gsOrig || o.material;
    let role = roleOf ? roleOf(o, gun) : null;
    if (!role && /\|gp-sight$/.test(src.name || '')) role = 'strim';
    if (!role) return;
    const ws = new T.Vector3(); o.getWorldScale(ws);
    const tw = twinOf(src, gun, role, ws.x / gs.x, new T.Matrix4().multiplyMatrices(ginv, o.matrixWorld)); if (!tw) return;
    edgeAttr(o.geometry);
    rec.swaps.push([o, src, tw]);
  });
  // 3. optics + holo
  try { optics(vm, g, gun, rec); } catch (e) { console.warn('guns2026: optics', gun, e); }
  try { if (CFG[gun].holo) rec.holo = holoPanel(g, gun, CFG[gun].holo); } catch (e) { console.warn('guns2026: holo', gun, e); }
}
// decals: one merged mesh of flat quads per gun (1 draw call, cost only where a decal is), placed by raycast on faces mapped flat
// (docs/agents: probe) - side decals face +-x (text runs toward the stock on the left side), top decals face +y (letters' up = +x)
function placeDecals(g, gun) {
  const rec = VMS.get(gun), log = rec.decalLog = [];
  const targets = []; g.traverse(o => { if (solid(o) || (o.isMesh && o.userData.gsOrig)) targets.push(o); });
  const inv = g.matrixWorld.clone().invert(), rc = new T.Raycaster(), pos = [], uv = [], col = [], idx = [];
  const hitAt = (side, a, z) => {
    const top = side === 'top', o = (top ? new T.Vector3(a, .6, z) : new T.Vector3(side * .6, a, z)).applyMatrix4(g.matrixWorld), d = (top ? new T.Vector3(0, -1, 0) : new T.Vector3(-side, 0, 0)).transformDirection(g.matrixWorld);
    rc.set(o, d); rc.far = 2; const h = rc.intersectObjects(targets, false)[0]; if (!h) return null;
    return { p: h.point.clone().applyMatrix4(inv), n: h.face.normal.clone().transformDirection(h.object.matrixWorld).transformDirection(inv).normalize() };
  };
  for (const d of CFG[gun].decals || []) {
    const ai = DKEYS.indexOf(d.r); if (ai < 0) continue;
    const top = d.side === 'top', c = hitAt(d.side, top ? d.x : d.y, d.z); if (!c || (top ? c.n.y : c.n.x * d.side) < .85) { log.push(d.r + ':miss'); continue; }
    const n = top ? new T.Vector3(0, 1, 0) : new T.Vector3(d.side, 0, 0), right = top ? new T.Vector3(0, 0, 1) : new T.Vector3(0, 0, -d.side), up = top ? new T.Vector3(1, 0, 0) : new T.Vector3(0, 1, 0);
    const w = d.w, h = w * DH / DW, ctr = top ? new T.Vector3(d.x, c.p.y, d.z) : new T.Vector3(c.p.x, d.y, d.z);
    // every corner must land on (nearly) the same plane, else the decal would float over a step
    let ok = true, lift = 0; for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1]]) { const q = ctr.clone().addScaledVector(right, sx * w / 2 * .96).addScaledVector(up, sy * h / 2 * .96), k = hitAt(d.side, top ? q.x : q.y, q.z);
      const dd = k ? (top ? k.p.y - ctr.y : (k.p.x - ctr.x) * d.side) : 1; if (!k || Math.abs(dd) > .004) { ok = false; break; } lift = Math.max(lift, dd); }
    ctr.addScaledVector(n, lift);   // sit on the highest point under the decal: never sinks into the surface
    if (!ok) { log.push(d.r + ':step'); continue; }
    const b = pos.length / 3, u0 = (ai % DCOLS) / DCOLS, v0 = 1 - (Math.floor(ai / DCOLS) + 1) / DROWS, du = 1 / DCOLS, dv = 1 / DROWS, ink = d.dark ? [.03, .033, .036] : [.8, .82, .84];
    for (const [sx, sy, uu, vv] of [[-1, -1, 0, 0], [1, -1, 1, 0], [1, 1, 1, 1], [-1, 1, 0, 1]]) {
      const q = ctr.clone().addScaledVector(right, sx * w / 2).addScaledVector(up, sy * h / 2).addScaledVector(n, .0006);
      pos.push(q.x, q.y, q.z); uv.push(u0 + uu * du, v0 + vv * dv); col.push(...ink);
    }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3); log.push(d.r);
  }
  if (!idx.length) return null;
  const geo = new T.BufferGeometry(); geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); geo.setAttribute('uv', new T.Float32BufferAttribute(uv, 2)); geo.setAttribute('color', new T.Float32BufferAttribute(col, 3)); geo.setIndex(idx); geo.computeVertexNormals();
  const m = new T.MeshStandardMaterial({ map: ATLAS, vertexColors: true, transparent: true, depthWrite: false, roughness: .5, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  m.name = 'g26-decal'; const me = new T.Mesh(geo, m); me.userData.noProbe = me.userData.g26 = true; me.renderOrder = 1; g.add(me); return me;
}
function additive(map, color, opacity = 1) { return new T.MeshBasicMaterial({ map, color, transparent: true, opacity, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide }); }
function optics(vm, g, gun, rec) {
  const ret = vm.reticle;
  if (ret && (gun === 'carbine' || gun === 'pistol')) {
    const holo = gun === 'carbine', size = holo ? .0353 : .022;
    const col = holo ? new T.Color(12, .9, .4) : new T.Color(9, 5.5, 1);
    for (const c of ret.children) c.visible = false;     // the old dot/ring stay as (hidden) children: the reticle keeps its position
    const halo = new T.Mesh(new T.PlaneGeometry(size, size), new T.MeshBasicMaterial({ map: RET[holo ? 'holoH' : 'pistH'], color: 0x000000, transparent: true, opacity: .42, depthTest: false, depthWrite: false }));
    halo.renderOrder = 5; ret.add(halo);
    const r = new T.Mesh(new T.PlaneGeometry(size, size), new T.MeshBasicMaterial({ map: RET[holo ? 'holo' : 'pist'], color: col, transparent: true, depthTest: false, depthWrite: false }));
    r.renderOrder = 6; ret.add(r);
    for (const m of [halo, r]) m.userData.noProbe = m.userData.g26 = true;
    if (false) {   // (owner: no frame) projected holo frame around the pistol's dot (same plane as the reticle: no parallax)
      const f = new T.Mesh(new T.PlaneGeometry(.085, .053), additive(RET.frame, new T.Color(.35, 1.8, 2.2), .6)); f.material.depthTest = false; f.renderOrder = 5; f.userData.noProbe = f.userData.g26 = true; ret.add(f); rec.frame = f;
    }
  }
  // glass: iridescent AR coating + a glint card that fades while aiming
  g.traverse(o => {
    if (!o.isMesh || !o.material || o.userData.g26) return; const m = o.material;
    if (!(m.isMeshPhysicalMaterial && m.transparent)) return;
    const gm = new T.MeshPhysicalMaterial({ color: 0xa8ccff, transparent: true, opacity: .14, roughness: .02, metalness: 0, envMapIntensity: 1.6, depthWrite: false, iridescence: 1, iridescenceIOR: 1.35, iridescenceThicknessRange: [180, 520], specularIntensity: 1 });
    gm.name = 'g26-glass'; o.material = gm; o.userData.g26 = true;
    o.geometry.computeBoundingBox(); const bb = o.geometry.boundingBox, c = bb.getCenter(new T.Vector3()), sz = bb.getSize(new T.Vector3()), d = Math.max(sz.x, sz.y) * 1.1;
    (rec.glass = rec.glass || []).push(gm);   // (owner: no glint card / lens ring)
  });
}
function holoPanel(g, gun, h) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 128; const t = new T.CanvasTexture(c); t.generateMipmaps = true; t.minFilter = T.LinearMipmapLinearFilter;
  const m = new T.Mesh(new T.PlaneGeometry(h.w, h.w / 2), additive(t, new T.Color(.45, 1.6, 2), .9));
  m.position.set(...h.pos); m.rotation.set(...h.rot); m.userData.noProbe = m.userData.g26 = true; m.renderOrder = 3; g.add(m);
  return { m, c, g: c.getContext('2d'), t, kind: h.kind, last: '' };
}
function drawHolo(hp, a, b) {
  const s = a + '|' + b; if (s === hp.last) return; hp.last = s; const g = hp.g, W = 256, H = 128;
  g.clearRect(0, 0, W, H); g.fillStyle = g.strokeStyle = '#fff'; g.globalAlpha = .18; g.fillRect(0, 0, W, H); g.globalAlpha = 1; g.lineWidth = 3; g.strokeRect(4, 4, W - 8, H - 8);
  if (hp.kind === 'ammo') { g.font = '700 72px "Rajdhani",Arial,sans-serif'; g.fillText(String(a).padStart(2, '0'), 18, 86); g.font = '600 22px "Rajdhani",Arial,sans-serif'; g.fillText('CELL', 150, 40); const f = Math.max(0, Math.min(1, b)); g.strokeRect(150, 54, 88, 22); g.fillRect(153, 57, 82 * f, 16); g.fillText('KD·M2', 150, 108); }
  else { g.font = '700 50px "Rajdhani",Arial,sans-serif'; g.fillText(a, 16, 62); g.font = '600 26px "Rajdhani",Arial,sans-serif'; g.fillText(b, 18, 104); g.fillText('OF·R90', 160, 40); }
  hp.t.needsUpdate = true;
}

/* ------------------------------------------------------------------ material on/off by tier (never compiled mid-match) */
const tierOk = () => { const G = window.S9GFX; const t = (G && G.tier) || (gv('CFG') || {}).q || 'high'; return t !== 'performance'; };
const inMatch = () => { const s = gv('state'); return s === 'play' || s === 'dead' || s === 'paused'; };
function setMats(on) {
  for (const rec of VMS.values()) for (const [o, src, tw] of rec.swaps) {
    if (on) { if (o.material === src) o.material = tw; if (o.userData.gsOrig === src) o.userData.gsOrig = tw; }
    else { if (o.material === tw) o.material = src; if (o.userData.gsOrig === tw) o.userData.gsOrig = src; }
  }
  API.on = on;
}
function compileVMs() {
  const r = gv('renderer'), gs = gv('gunScene'), gc = gv('gunCam'), WM = gv('WM'); if (!r || !gs || !gc || !WM) return;
  const vis = Object.keys(WM).map(k => [WM[k].group, WM[k].group.visible]); for (const [g] of vis) g.visible = true;
  try { r.compile(gs, gc); } catch (e) { console.warn('guns2026: compile', e); } for (const [g, v] of vis) g.visible = v;
  try { window.S9GunSkins && S9GunSkins._warm && S9GunSkins._warm(); } catch (e) {}
}
function sync(force) {
  const want = tierOk();
  if (want === API.on && !force) return;
  if (want && inMatch()) return;          // turning on needs new programs: wait for the menu / next match
  setMats(want); if (want) compileVMs();
}

/* ------------------------------------------------------------------ Longbow scope view (post pass, only while scoped) */
const ScopeShader = {
  uniforms: { tDiffuse: { value: null }, uK: { value: 0 }, uOpen: { value: 1 }, uAsp: { value: 1.78 }, uOff: { value: null }, uRes: { value: null }, uCA: { value: 1 }, uR: { value: .4 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uK, uOpen, uAsp, uCA, uR; uniform vec2 uOff, uRes; varying vec2 vUv;
    float ln(float d, float w, float px) { return 1. - smoothstep(w - px, w + px, d); }
    void main() {
      vec2 p = (vUv - .5) * vec2(uAsp, 1.);
      float R = uR * mix(.55, 1., uOpen), r = length(p) / R, px = 1. / uRes.y;
      // lens: slight barrel distortion + chromatic fringe toward the rim (grows when the eye is off-axis)
      float ca = smoothstep(.5, 1., r) * (.0035 + length(uOff) * .05) * uCA;
      vec2 d = (vUv - .5) * (1. - .045 * r * r * step(r, 1.));
      vec3 col = vec3(texture2D(tDiffuse, .5 + d * (1. + ca)).r, texture2D(tDiffuse, .5 + d).g, texture2D(tDiffuse, .5 + d * (1. - ca)).b);
      float L = dot(col, vec3(.299, .587, .114));
      col *= vec3(.97, 1., 1.02);
      // eye-box shadow: rim + crescent opposite the eye offset
      float r2 = length(p - uOff * 2.4) / R;
      float sh = max(smoothstep(.955, 1.0, r), smoothstep(.86, 1.06, r2) * .92);
      // rim sheen (coated glass)
      vec2 nq = normalize(p + 1e-5);
      col += vec3(.5, .45, .8) * smoothstep(.88, .985, r) * (1. - smoothstep(.985, 1., r)) * max(0., dot(nq, vec2(-.62, .78))) * .25;
      // reticle (screen-centred: the bullet goes there), analytic + AA; ink flips light/dark with the background
      vec2 q = p / R; float a = 0.;
      float thin = 1.1 * px / R, thick = 3.4 * px / R, gap = .035;
      a = max(a, ln(abs(q.y), thin, px / R) * step(gap, abs(q.x)) * step(abs(q.x), .62));
      a = max(a, ln(abs(q.x), thin, px / R) * step(gap, abs(q.y)) * step(abs(q.y), .62));
      a = max(a, ln(abs(q.y), thick, px / R) * step(.6, abs(q.x)));
      a = max(a, ln(abs(q.x), thick, px / R) * step(.6, q.y));
      a = max(a, ln(abs(q.x), thick, px / R) * step(q.y, -.6));
      for (int i = 1; i <= 7; i++) { float s = float(i) * .075, tl = (i == 5 ? .028 : .014);
        a = max(a, ln(abs(abs(q.x) - s), thin, px / R) * step(abs(q.y), tl));
        a = max(a, ln(abs(abs(q.y) - s), thin, px / R) * step(abs(q.x), tl) * step(q.y, 0.) );
        a = max(a, ln(abs(q.y - s), thin, px / R) * step(abs(q.x), tl * .6)); }
      for (int i = 1; i <= 4; i++) { float s = -float(i) * .075; a = max(a, ln(abs(q.y - s), thin, px / R) * step(abs(q.x), .02 + float(i) * .012)); }   // drop ladder
      vec3 ink = mix(vec3(.95, .66, .3), vec3(.01), smoothstep(.16, .42, L));
      col = mix(col, ink, a * .95);
      // illuminated chevron at the aim point
      vec2 c = q; float ch = ln(abs(abs(c.x) * .9 + c.y * .9 + .0), thin * 1.3, px / R) * step(-.03, c.y) * step(c.y, 0.) * step(abs(c.x), .03);
      ch = max(ch, 1. - smoothstep(1.4 * px / R, 2.6 * px / R, length(c)));
      col = mix(col, vec3(1., .16, .1), ch); col += vec3(1., .2, .1) * exp(-length(c) * R / (5. * px)) * .25;
      // outside the tube: black; inner edge highlight ring
      col *= 1. - sh; col += vec3(.18, .2, .24) * ln(abs(r - 1.004), .003, px / R) * (1. - sh * .5);
      col = mix(texture2D(tDiffuse, vUv).rgb, col, uK) * mix(1., 0., (1. - uOpen) * step(1., r) * uK);
      gl_FragColor = vec4(col, 1.);
    }`
};
let SCOPE = null;
function scopeInit() {
  const C = gv('composer'), grade = gv('grade'); if (!C || !T.ShaderPass) return;
  const pass = new T.ShaderPass(ScopeShader); pass.uniforms.uOff.value = new T.Vector2(); pass.uniforms.uRes.value = new T.Vector2(1, 1); pass.enabled = false;
  const i = grade ? C.passes.indexOf(grade) : -1; C.insertPass(pass, i >= 0 ? i + 1 : C.passes.length);
  const st = document.createElement('style'); st.textContent = `body.g26scope #scope{display:none!important}
    #g26ro{position:absolute;left:50%;top:50%;transform:translate(calc(27vmin), calc(25vmin));pointer-events:none;opacity:0;font:600 14px/1.25 "Rajdhani","Share Tech Mono",monospace;letter-spacing:.14em;color:#ffb35a;text-shadow:0 0 6px rgba(255,140,40,.55),0 1px 0 #000;white-space:nowrap;z-index:3}
    #g26ro b{font-size:22px;font-weight:700;letter-spacing:.06em;color:#ffd08a} #g26ro i{font-style:normal;opacity:.7}
    #g26ro2{position:absolute;left:50%;top:50%;transform:translate(calc(-36vmin), calc(-30vmin));pointer-events:none;opacity:0;font:600 11px "Rajdhani",monospace;letter-spacing:.22em;color:#9fe8ff;text-shadow:0 0 6px rgba(60,200,255,.5);z-index:3}`;
  document.head.appendChild(st);
  const hud = document.getElementById('hud') || document.body;
  const ro = document.createElement('div'); ro.id = 'g26ro'; ro.innerHTML = '<b id="g26z">8.0×</b><br><span id="g26r">RNG --- M</span><br><i>WND 0.0 · ELV 0.0</i>'; hud.appendChild(ro);
  const ro2 = document.createElement('div'); ro2.id = 'g26ro2'; ro2.textContent = 'OF-R90 ▸ BALLISTIC LINK'; hud.appendChild(ro2);
  document.body.classList.add('g26scope');
  SCOPE = { pass, ro, ro2, z: ro.querySelector('#g26z'), r: ro.querySelector('#g26r'), off: new T.Vector2(), vel: new T.Vector2(), lastYaw: 0, lastPitch: 0, rangeT: 0, range: -1, rc: new T.Raycaster(), lastTxt: '' };
}
function rangeNow() {
  const cam = gv('camera'), world = gv('world'), robots = gv('robots') || []; if (!cam || !world) return -1;
  const o = cam.getWorldPosition(new T.Vector3()), d = cam.getWorldDirection(new T.Vector3());
  let best = 1e9; SCOPE.rc.set(o, d); SCOPE.rc.far = 400; const h = SCOPE.rc.intersectObjects(world.meshes || [], false)[0]; if (h) best = h.distance;
  for (const r of robots) { if (!r || r.dead || !r.root) continue; const v = r.root.position.clone(); v.y += 1.2; v.sub(o); const t = v.dot(d); if (t <= 0 || t > best) continue; if (v.clone().addScaledVector(d, -t).length() < .55) best = t; }
  return best < 1e8 ? best : -1;
}
function scopeFrame(dt, P, W) {
  if (!SCOPE) return;
  const scoped = W && W.scope ? Math.min(1, Math.max(0, (P.ads - .8) / .2)) : 0, pass = SCOPE.pass, U2 = pass.uniforms;
  pass.enabled = scoped > 0 && (P.ads > .85);
  const vis = pass.enabled ? 1 : 0; if (SCOPE.vis !== vis) { SCOPE.vis = vis; SCOPE.ro.style.opacity = SCOPE.ro2.style.opacity = vis ? '1' : '0'; }
  if (!pass.enabled) { SCOPE.lastYaw = P.yaw; SCOPE.lastPitch = P.pitch; SCOPE.off.set(0, 0); SCOPE.vel.set(0, 0); return; }
  const r = gv('renderer'); if (r) { const s = r.getSize(new T.Vector2()); U2.uRes.value.set(s.x * r.getPixelRatio(), s.y * r.getPixelRatio()); U2.uAsp.value = s.x / Math.max(1, s.y); }
  U2.uK.value = 1; U2.uOpen.value = Math.min(1, Math.max(0, (P.ads - .85) / .13)); U2.uCA.value = tierOk() ? 1 : 0;
  // eye-box: the scope lags the look (mouse) and the body (strafe), springs back to centre
  const dy = P.yaw - SCOPE.lastYaw, dp = P.pitch - SCOPE.lastPitch; SCOPE.lastYaw = P.yaw; SCOPE.lastPitch = P.pitch;
  const h = dt > 0 ? Math.min(dt, .05) : .016, k = 140, c = 2 * Math.sqrt(k) * .8;
  const tx = Math.max(-.06, Math.min(.06, dy * 1.6 + (P.vel ? (P.vel.x * Math.cos(P.yaw) - P.vel.z * Math.sin(P.yaw)) * -.004 : 0))), ty = Math.max(-.06, Math.min(.06, -dp * 1.6));
  SCOPE.vel.x += (k * (tx - SCOPE.off.x) - c * SCOPE.vel.x) * h; SCOPE.vel.y += (k * (ty - SCOPE.off.y) - c * SCOPE.vel.y) * h;
  SCOPE.off.addScaledVector(SCOPE.vel, h); U2.uOff.value.copy(SCOPE.off);
  // readout: zoom always, range at 10 Hz
  const cam = gv('camera'); const zoom = cam ? Math.tan(39 * Math.PI / 180) / Math.tan(cam.fov * Math.PI / 360) : 1;
  SCOPE.rangeT -= dt; if (SCOPE.rangeT <= 0) { SCOPE.rangeT = .1; SCOPE.range = rangeNow(); }
  const zt = zoom.toFixed(1) + '×', rt = 'RNG ' + (SCOPE.range > 0 ? String(Math.round(SCOPE.range)).padStart(3, '0') : '---') + ' M', key = zt + rt;
  if (key !== SCOPE.lastTxt) { SCOPE.lastTxt = key; SCOPE.z.textContent = zt; SCOPE.r.textContent = rt; }
}

/* ------------------------------------------------------------------ ADS curve, inertia, defocus, readouts */
const A = { s: 0, v: 0, last: 0, tgt: 0, w: null };
function vmFrame(dt) {
  const P = gv('P'), WEAPONS = gv('WEAPONS'); if (!P || !WEAPONS) return;
  const W = WEAPONS[P.weapon], rec = VMS.get(P.weapon), gun = gv('gun');
  scopeFrame(dt, P, W);
  if (!rec || !gun || !W) { A.s = P.ads; A.v = 0; A.w = P.weapon; U.dof.value = 0; return; }
  if (A.w !== P.weapon) { A.w = P.weapon; A.s = A.u = P.ads; A.v = 0; A.last = P.ads; }
  const a = P.ads, h = Math.min(Math.max(dt, 0), .05);
  if (a > A.last + 1e-4 || a > .995) A.tgt = 1; else if (a < A.last - 1e-4 || a < .005) A.tgt = 0; A.last = a;
  // travel u runs linearly in time toward the target; the gun follows smootherstep(u): zero velocity AND acceleration at both
  // ends (soft lift-off, soft landing, no overshoot), exactly 1 at full ADS. Duration matches the game's own ADS (95% point).
  const dur = 3.4 / (W.adsSpeed || 14), ss = u => u * u * u * (u * (u * 6 - 15) + 10);
  if (A.u === undefined) A.u = A.s;
  const u0 = A.u; A.u = Math.min(1, Math.max(0, A.u + (A.tgt ? 1 : -1) * h / dur));
  if (a < .02 && A.tgt === 0) A.u = Math.min(A.u, a);              // the game snapped ADS off (switch / sprint / death)
  const s0 = A.s; A.s = ss(A.u); A.v = h > 0 ? (A.s - s0) / h : 0;
  const HIP = gv('HIP_POS'), ADS = gv('ADS_POS');
  if (HIP && ADS) {
    const d = A.s - a; gun.position.x += (ADS.x - HIP.x) * d; gun.position.y += (ADS.y - HIP.y) * d; gun.position.z += (ADS.z - HIP.z) * d;
    // inertia: the gun rolls in and dips a touch while it travels, settles exactly at full ADS
    const iv = Math.max(-8, Math.min(8, A.v));
    gun.rotation.z += iv * .0055; gun.rotation.x -= iv * .0028; gun.position.y -= Math.abs(iv) * .0009;
  }
  U.dof.value = API.on ? Math.max(0, (A.s - .55) / .45) * .9 : 0;
  // optics + readouts
  for (const gl of rec.glints) gl.material.opacity = .55 * (1 - Math.min(1, A.s * 1.4)) + .04;
  if (rec.glass) for (const gm of rec.glass) gm.opacity = .14 - .11 * A.s;   // clear view through the window while aiming
  if (rec.frame) { const f = Math.max(0, (A.s - .5) / .5); rec.frame.material.opacity = .5 * f * (.92 + .08 * Math.sin((gv('G') || {}).time * 18 || 0)); rec.frame.scale.setScalar(.92 + .08 * f); }
  if (rec.holo) {
    if (rec.holo.kind === 'ammo') drawHolo(rec.holo, P.ammo, P.ammo / (W.mag || 1));
    else { const cam = gv('camera'); const z = cam ? Math.tan(39 * Math.PI / 180) / Math.tan(cam.fov * Math.PI / 360) : 1; drawHolo(rec.holo, z.toFixed(1) + '×', (SCOPE && SCOPE.range > 0 ? Math.round(SCOPE.range) + ' M' : 'RNG --') + '  ' + P.ammo + '/' + W.mag); }
  }
}

/* ------------------------------------------------------------------ boot + hooks */
function hook(name, make) {
  const o = gv(name); if (typeof o !== 'function') return false;
  window.__g26fn = make(o); try { (0, eval)(`${name} = window.__g26fn`); } catch (e) { console.warn('guns2026: hook ' + name, e); return false; } finally { delete window.__g26fn; }
  return true;
}
function report() {
  const out = { on: API.on, ready: API.ready, tier: (window.S9GFX || {}).tier, twins: TWINS.size, guns: {} };
  for (const [g, r] of VMS) out.guns[g] = { swaps: r.swaps.length, live: r.swaps.filter(([o, s, t]) => o.material === t).length, decals: r.decalLog, glints: r.glints.length, holo: !!r.holo, frame: !!r.frame };
  return out;
}
let booted = false;
function boot() {
  if (booted) return; const s = window.__s9; T = window.THREE;
  if (!s || !T || !gv('WM') || !window.S9GunSkins || !S9GunSkins._roleOf) return setTimeout(boot, 300);
  booted = true;
  try {
    const t0 = performance.now();
    MASK = maskTexture(1024); ATLAS = decalAtlas();
    RET = { holo: reticleTex('holo'), holoH: reticleTex('holo', true), pist: reticleTex('pist'), pistH: reticleTex('pist', true), frame: holoFrameTex(), glint: glintTex() };
    const WM = gv('WM'); for (const id of API.guns) if (WM[id]) upgrade(WM[id], id); stripAll();
    hook('buildGunVM', o => function (id) { const vm = o.apply(this, arguments); try { stripGun(id, vm); if (API.guns.includes(id)) { upgrade(vm, id); if (API.on) { const rec = VMS.get(id); if (rec) for (const [m, src, tw] of rec.swaps) if (m.material === src) m.material = tw; } } } catch (e) { console.warn('guns2026: build', e); } return vm; });
    hook('updateViewmodel', o => function (dt) { const r = o.apply(this, arguments); try { vmFrame(dt); } catch (e) { if (!API._err) { API._err = 1; console.warn('guns2026: frame', e); } } return r; });
    hook('applyQuality', o => function () { const r = o.apply(this, arguments); try { if (!inMatch()) ensure(); sync(); } catch (e) {} return r; });
    hook('warmShaders', o => function () { try { ensure(); sync(); } catch (e) {} return o.apply(this, arguments); });
    // owner 2026-11-06: sniper scope view reverted to the game's own (scopeInit not called)
    sync(true);
    API.genMs = Math.round(performance.now() - t0);
    API.ready = true;
  } catch (e) { API.error = String(e && e.message || e); console.warn('guns2026: boot', e); }
}
// owner 2026-11-06: on EVERY gun strip decal-like and ring-like glow: reticle rings (dot only), the glowing rings/LEDs on optics,
// glow tori round muzzles/scope bells, flat screen panels. Kept: long energy strips in the body, moving charge rotors (void/helix),
// creature guns (poopgun/flytrap/boomerang are drawn that way on purpose), muzzle flashes.
let HIDDEN = null;
const KEEP_ALL = new Set(['poopgun', 'flytrap', 'boomerang', 'knife']);
function stripGun(id, W) {
  if (!W || !W.group || KEEP_ALL.has(id) || W.group.userData.g26strip) return 0;
  const g = W.group; g.userData.g26strip = true; g.updateMatrixWorld(true);
  const inv = g.matrixWorld.clone().invert(), hide = [];
  g.traverse(o => {
    if (!o.isMesh || o.userData.g26) return;
    let q = o, inFlash = false, inRet = false; while (q) { if (q === W.flash) inFlash = true; if (q === W.reticle) inRet = true; q = q.parent; } if (inFlash) return;
    const m = o.material, gt = o.geometry.type; if (!m || !m.isMeshBasicMaterial) return;
    if (inRet) { if (gt === 'RingGeometry') hide.push(o); return; }                                   // dot only
    if (gt === 'TorusGeometry' && id !== 'ricochet') { hide.push(o); return; }                        // glow rings round muzzles
    if (gt === 'PlaneGeometry' && m.map) { hide.push(o); return; }                                    // screens / panels
    const bb = new T.Box3().setFromObject(o).applyMatrix4(inv), sz = bb.getSize(new T.Vector3());
    if (/^gp-/.test(o.name || '') ) return;                                                            // gunpolish mechanical carriers
    if (bb.min.y > .05 && sz.z < .09) hide.push(o);                                                   // ring/LED on the optic (sniper scope bell)
  });
  for (const o of hide) { o.userData.g26hidden = o.material; o.material = HIDDEN || (HIDDEN = new T.MeshBasicMaterial({ visible: false })); }   // a non-drawing material: the game may toggle .visible, it never draws
  (API.stripped = API.stripped || {})[id] = hide.length;
  return hide.length;
}
function stripAll() { const WM = gv('WM'); if (!WM) return; for (const id of Object.keys(WM)) { const W = WM[id]; if (W && W.group && !W.group.userData.g26strip) stripGun(id, W); } }
function ensure() {   // viewmodels rebuilt by other modules (gunpolish) after we booted
  const WM = gv('WM'); if (!WM || !booted) return;
  stripAll();
  let n = 0; for (const id of API.guns) if (WM[id] && !WM[id].group.userData.g26) { upgrade(WM[id], id); n++; }
  if (n && API.on) { for (const id of API.guns) { const r = VMS.get(id); if (r) for (const [o, src, tw] of r.swaps) { if (o.material === src) o.material = tw; if (o.userData.gsOrig === src) o.userData.gsOrig = tw; } } }
  return n;
}
API.enable = () => { setMats(true); compileVMs(); return report(); };
API.disable = () => { setMats(false); return report(); };
API.report = report;
API._twins = () => [...TWINS.values()];
API._vms = VMS; API._A = A;
API._flags = f => { PFLAGS = f || ''; for (const m of TWINS.values()) m.needsUpdate = true; compileVMs(); };
addEventListener('s9modules', () => { boot(); setTimeout(() => { try { ensure(); sync(true); } catch (e) {} }, 0); });
if (window.__s9 && gv('WM')) setTimeout(boot, 0);
})();
