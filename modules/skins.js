/* Sector Nine — soldier skins + Customize screen (window.S9Skins)
   - 14 soldier skins, all on the SAME skeleton, animation set and hitboxes as the standard soldier.
     Every skin = one merged skinned mesh (base body with parts removed/reshaped + attachments skinned to the
     existing bones) + the visor: the same 2 draw calls as the standard soldier.
   - Cosmetic geometry is never a raycast target: hits keep using the game's invisible hitbox meshes (r.meshes).
   - Customization: primary / secondary / visor colour, shoulder emblem, helmet on/off where it fits.
   - Saved in localStorage 'sector9-look' and PUT /api/me/look when signed in; online look travels in state field `lk`.
   Gun skins are owned by S9GunSkins (modules/gunskins.js); applyGunSkin delegates to it.
   Bind space used for all modelling below: centimetres, +Z up, +Y = forward (toes), character's LEFT = -X (T-pose). */
(() => {
'use strict';
if (window.S9Skins && window.S9Skins.version) return;
const T = window.THREE;
const LS_KEY = 'sector9-look';

/* ======================================================================================= data */
const RANKS = ['Recruit', 'Private', 'Corporal', 'Sergeant', 'Lieutenant', 'Captain', 'Major', 'Colonel', 'General', 'Sector Legend'];
const STEPS = ['I', 'II', 'III', 'IV', 'V'];
const rankOfLevel = L => Math.min(9, Math.floor((Math.max(1, L) - 1) / 5));
const levelName = L => `${RANKS[rankOfLevel(L)]} ${STEPS[(Math.max(1, L) - 1) % 5]}`;
// pal = [primary, secondary, dark, accent, glow(visor), light, extra, metal]; slots 0,1,4 are the player's colour pickers
const SKINS = [
  { id: 'std', name: 'Standard Trooper', rarity: 'common', level: 1, tag: 'Sector issue armour. Clean, sharp, reliable.',
    pal: ['#d9b48a', '#4b5536', '#17191c', '#b3261e', '#36e0ff', '#e8e2d6', '#6e7781', '#8d99a3'], helmet: false },
  { id: 'nomad', name: 'Desert Nomad', rarity: 'common', level: 4, tag: 'Sun-bleached wraps, goggles and a dune-runner poncho.',
    pal: ['#c8a46e', '#7d4a2b', '#2b221b', '#2f8f83', '#ffb347', '#efe1c4', '#9b6a3e', '#a29a8c'], helmet: true },
  { id: 'arctic', name: 'Arctic Ops', rarity: 'common', level: 7, tag: 'Pixel snow camo, fur hood and ice-cleat boots.',
    pal: ['#e9eef2', '#7d8b99', '#1d2329', '#ff6a1a', '#7ff3ff', '#ffffff', '#b6c4cf', '#9fb0bd'], helmet: true },
  { id: 'banana', name: 'Banana Suit', rarity: 'rare', level: 9, tag: 'Fully ripe. Zero stealth. Maximum potassium.',
    pal: ['#ffd43b', '#34343c', '#3a2a12', '#2f6fd6', '#fff36b', '#ffffff', '#efbf96', '#8a8f96'], helmet: false },
  { id: 'jugg', name: 'Heavy Juggernaut', rarity: 'rare', level: 12, tag: 'Slab armour, hazard stripes, a visor slit and attitude.',
    pal: ['#6f7f98', '#e8b320', '#2a3140', '#d23b1e', '#ff3b2f', '#c9ced6', '#4d5869', '#a7b0bb'], helmet: false },
  { id: 'ninja', name: 'Cyber Ninja', rarity: 'rare', level: 15, tag: 'Matte black, neon seams, a blade on the back and a scarf that never stops.',
    pal: ['#1b1d24', '#e0245e', '#0b0c0f', '#7a7f8c', '#ff2e88', '#d7dae3', '#2c2f3a', '#9aa1ad'], helmet: false },
  { id: 'pirate', name: 'Space Pirate', rarity: 'rare', level: 18, tag: 'Tricorn, long coat, gold trim and a robot parrot who talks back.',
    pal: ['#5a1b1b', '#2a2320', '#120d0b', '#d9a33a', '#ffcc33', '#efe3c8', '#2e6f8e', '#b0884a'], helmet: true },
  { id: 'dino', name: 'Party Dino', rarity: 'epic', level: 21, tag: 'Inflatable rex costume with a party hat. Rawr means hello.',
    pal: ['#63c23c', '#ffd84a', '#1e3a1c', '#ff4fa3', '#ffe14d', '#fff2b0', '#2f8f3a', '#9aa3ab'], helmet: false },
  { id: 'mecha', name: 'Mecha Pilot', rarity: 'epic', level: 24, tag: 'G-suit, bubble helmet, life-support pack and hoses.',
    pal: ['#f2f2ee', '#e2462f', '#1b1f26', '#2b6fd6', '#59ffb0', '#ffffff', '#ffb000', '#9aa6b3'], helmet: true },
  { id: 'butler', name: 'Robot Butler', rarity: 'epic', level: 27, tag: 'Tailcoat, bow tie, monocle and a moustache moulded in chrome.',
    pal: ['#4b505d', '#f3efe6', '#22242b', '#b3122e', '#7fd7ff', '#ffffff', '#f0c45a', '#c7ccd4'], helmet: false },
  { id: 'mushroom', name: 'Mushroom Man', rarity: 'epic', level: 31, tag: 'A spotted cap, gills, glowing spores and a mossy body.',
    pal: ['#d8322c', '#efe6d2', '#2d2318', '#6b8f3a', '#b6ff6a', '#fff8ea', '#8a6a48', '#9a9a8a'], helmet: false },
  { id: 'skeleton', name: 'Skeleton Phantom', rarity: 'legendary', level: 35, tag: 'Bone armour over a void suit. Its eyes burn ghost-green.',
    pal: ['#ece6d4', '#121318', '#07080a', '#5b5f6b', '#3dff9a', '#ffffff', '#2a2d36', '#8a8f99'], helmet: false },
  { id: 'glitch', name: 'Neon Glitch', rarity: 'legendary', level: 40, tag: 'A corrupted render: crystal head, pixel shards, live neon seams.',
    pal: ['#14121f', '#2de2ff', '#06060a', '#ff3df2', '#ff3df2', '#e9e6ff', '#3b2b6b', '#7c7f99'], helmet: false },
  { id: 'xeno', name: 'Xeno Alien', rarity: 'legendary', level: 46, tag: 'Teal chitin, an elongated skull and veins that pulse with light.',
    pal: ['#2aa79b', '#4a2a7a', '#0d0b14', '#c8ff3a', '#ffd23d', '#d9fff5', '#1d6b74', '#7d8a9a'], helmet: false },
];
const EMBLEMS = [
  { id: 'none', name: 'None', level: 1 }, { id: 'nine', name: 'Sector 9', level: 1 }, { id: 'star', name: 'Star', level: 1 },
  { id: 'bolt', name: 'Lightning', level: 3 }, { id: 'cross', name: 'Crosshair', level: 5 }, { id: 'skull', name: 'Skull', level: 8 },
  { id: 'wings', name: 'Wings', level: 11 }, { id: 'flame', name: 'Flame', level: 14 }, { id: 'gear', name: 'Gear', level: 17 },
  { id: 'eye', name: 'Eye', level: 20 }, { id: 'crown', name: 'Crown', level: 23 }, { id: 'heart', name: 'Heart', level: 26 },
  { id: 'paw', name: 'Dino Paw', level: 29 }, { id: 'alien', name: 'Alien', level: 33 }, { id: 'banana', name: 'Banana', level: 37 },
  { id: 'wolf', name: 'Wolf', level: 42 },
];
const RARITY = { common: { name: 'Common', col: '#b9c2cc' }, rare: { name: 'Rare', col: '#38b6ff' }, epic: { name: 'Epic', col: '#c06bff' }, legendary: { name: 'Legendary', col: '#ffb02e' } };
const SWATCHES = ['#d9b48a', '#c8a46e', '#e9eef2', '#ffd43b', '#5f6670', '#1b1d24', '#5a1b1b', '#4fbf4a', '#f2f2ee', '#1a1b22', '#d8322c', '#ece6d4', '#14121f', '#8fd16a',
  '#4b5536', '#7d4a2b', '#7d8b99', '#3f7d20', '#e8b320', '#e0245e', '#2a2320', '#f2e14c', '#e2462f', '#f3efe6', '#2de2ff', '#2a3b2c', '#ff6a1a', '#2b6fd6',
  '#36e0ff', '#ffb347', '#7ff3ff', '#fff36b', '#ff3b2f', '#ff2e88', '#ffcc33', '#ffe14d', '#59ffb0', '#7fd7ff', '#b6ff6a', '#3dff9a', '#ff3df2', '#a6ff3b', '#ffffff', '#9b6bff'];
const SKIN = Object.fromEntries(SKINS.map(s => [s.id, s]));
const SKIN_IDX = Object.fromEntries(SKINS.map((s, i) => [s.id, i]));
const EMB_IDX = Object.fromEntries(EMBLEMS.map((e, i) => [e.id, i]));

/* ======================================================================================= small utils */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const D2R = Math.PI / 180;
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const hashStr = str => { let h = 2166136261; for (const ch of String(str)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; };
const hex6 = v => { const s = String(v || '').replace('#', '').toLowerCase(); return /^[0-9a-f]{6}$/.test(s) ? s : null; };
const escH = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gv = name => { try { return (0, eval)(`typeof ${name} !== 'undefined' ? ${name} : undefined`); } catch (e) { return undefined; } };   // the game's top-level consts/lets
const S9 = () => window.__s9 || {};

/* value noise / fbm (tileable on a period) */
function makeNoise(seed) {
  const R = rng(seed), P = new Uint8Array(512), V = new Float32Array(256);
  for (let i = 0; i < 256; i++) { P[i] = i; V[i] = R(); }
  for (let i = 255; i > 0; i--) { const j = (R() * (i + 1)) | 0; [P[i], P[j]] = [P[j], P[i]]; }
  for (let i = 0; i < 256; i++) P[i + 256] = P[i];
  const h = (x, y, p) => V[P[(((x % p) + p) % p) + P[(((y % p) + p) % p)]]];
  const n2 = (x, y, p) => { const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    return lerp(lerp(h(xi, yi, p), h(xi + 1, yi, p), u), lerp(h(xi, yi + 1, p), h(xi + 1, yi + 1, p), u), v); };
  const fbm = (x, y, p, oct = 4) => { let a = 0, amp = .5, f = 1, sum = 0; for (let o = 0; o < oct; o++) { a += n2(x * f, y * f, p * f) * amp; sum += amp; amp *= .5; f *= 2; } return a / sum; };
  return { n2, fbm };
}
function canvasOf(w, h = w) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

/* ======================================================================================= base soldier (bind pose) */
let B = null;   // base info, built once from the pristine soldier asset
function soldierSource() {
  const A = gv('ASSET'); if (A && A.soldier && A.soldier.scene) return A.soldier.scene;
  const r = (gv('robots') || S9().robots || [])[0]; return r ? r.model : null;
}
function baseInit() {
  if (B) return B;
  const src = soldierSource(); if (!src) return null;
  let body = null, visor = null; src.traverse(o => { if (o.isSkinnedMesh) { if (/visor/i.test(o.name)) visor = o; else body = o; } });
  if (!body) return null;
  // the pristine geometry: a robot clone may already carry a skin, so use its original if we stored one
  const geo = (body.userData.s9orig && body.userData.s9orig.geo) || body.geometry;
  const pa = geo.attributes.position, na = geo.attributes.normal, ua = geo.attributes.uv, sia = geo.attributes.skinIndex, swa = geo.attributes.skinWeight;
  const n = pa.count, pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), uv = new Float32Array(n * 2), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  const GX = ['getX', 'getY', 'getZ', 'getW'];
  for (let i = 0; i < n; i++) {
    pos[i * 3] = pa.getX(i); pos[i * 3 + 1] = pa.getY(i); pos[i * 3 + 2] = pa.getZ(i);
    nrm[i * 3] = na.getX(i); nrm[i * 3 + 1] = na.getY(i); nrm[i * 3 + 2] = na.getZ(i);
    if (ua) { uv[i * 2] = ua.getX(i); uv[i * 2 + 1] = ua.getY(i); }
    for (let k = 0; k < 4; k++) { si[i * 4 + k] = sia[GX[k]](i); sw[i * 4 + k] = swa[GX[k]](i); }
  }
  const index = geo.index ? Uint32Array.from(geo.index.array) : Uint32Array.from({ length: n }, (_, i) => i);
  const bones = body.skeleton.bones, names = bones.map(b => b.name.replace(/^mixamorig:?/, ''));
  const bonePos = body.skeleton.boneInverses.map(m => new T.Vector3().setFromMatrixPosition(m.clone().invert()));
  const dom = new Int16Array(n); for (let i = 0; i < n; i++) { let b = 0, w = -1; for (let k = 0; k < 4; k++) if (sw[i * 4 + k] > w) { w = sw[i * 4 + k]; b = si[i * 4 + k]; } dom[i] = b; }
  // weld coincident vertices (UV seams) so offsets/normals never crack
  const wmap = new Map(), weld = new Int32Array(n); let wc = 0;
  for (let i = 0; i < n; i++) { const k = `${Math.round(pos[i * 3] * 20)}|${Math.round(pos[i * 3 + 1] * 20)}|${Math.round(pos[i * 3 + 2] * 20)}`; let id = wmap.get(k); if (id === undefined) { id = wc++; wmap.set(k, id); } weld[i] = id; }
  const mat = body.material, vm = visor ? visor.material : null;
  B = { body, visor, geo, n, pos, nrm, uv, si, sw, index, names, bone: Object.fromEntries(names.map((nm, i) => [nm, i])), bonePos, dom, weld, wc,
    map: mat.map, normalMap: mat.normalMap, visorMap: vm && vm.map, visorGeo: visor && visor.geometry, visorMat: vm, tris0: index.length / 3 };
  B.grid = gridOf(pos, n, 6);
  return B;
}
// uniform grid over points for nearest-neighbour queries (cm)
function gridOf(pos, n, cell) {
  const g = new Map(); const key = (x, y, z) => `${x}|${y}|${z}`;
  for (let i = 0; i < n; i++) { const k = key(Math.floor(pos[i * 3] / cell), Math.floor(pos[i * 3 + 1] / cell), Math.floor(pos[i * 3 + 2] / cell)); let a = g.get(k); if (!a) g.set(k, a = []); a.push(i); }
  return { g, cell, pos,
    near(x, y, z, k = 3, filter) { const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell); let best = [];
      for (let r = 1; r <= 12; r++) { best = [];
        for (let i = cx - r; i <= cx + r; i++) for (let j = cy - r; j <= cy + r; j++) for (let l = cz - r; l <= cz + r; l++) { const a = g.get(key(i, j, l)); if (!a) continue;
          for (const v of a) { if (filter && !filter(v)) continue; const dx = pos[v * 3] - x, dy = pos[v * 3 + 1] - y, dz = pos[v * 3 + 2] - z; best.push([dx * dx + dy * dy + dz * dz, v]); } }
        if (best.length >= k) break; }
      best.sort((a, b) => a[0] - b[0]); return best.slice(0, k); } };
}

/* ======================================================================================= modelling kit (bind space) */
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);
const UPZ = g => g.rotateX(Math.PI / 2);     // three's Y-up primitives -> our Z-up
function xf(geo, o = {}) {   // place a primitive: s (scale), r (deg, XYZ), p (position)
  const m = new T.Matrix4(), q = new T.Quaternion().setFromEuler(new T.Euler(...(o.r || [0, 0, 0]).map(a => a * D2R), o.order || 'XYZ'));
  const s = o.s === undefined ? [1, 1, 1] : typeof o.s === 'number' ? [o.s, o.s, o.s] : o.s;
  m.compose(V(...(o.p || [0, 0, 0])), q, V(...s)); geo.applyMatrix4(m); return geo;
}
function smoothGeo(g) {   // weld + smooth normals (rounded shapes built from separate faces)
  const BU = T.BufferGeometryUtils; g.deleteAttribute('normal'); if (g.attributes.uv) g.deleteAttribute('uv'); if (g.attributes.uv2) g.deleteAttribute('uv2');
  const m = BU && BU.mergeVertices ? BU.mergeVertices(g, 1e-3) : g; m.computeVertexNormals(); return m;
}
const P = {   // primitives (sizes in cm)
  sph: (r, ws = 16, hs = 12) => new T.SphereGeometry(r, ws, hs),
  ell: (rx, ry, rz, ws = 16, hs = 12) => new T.SphereGeometry(1, ws, hs).scale(rx, ry, rz),
  cyl: (rt, rb, h, seg = 16, open = false) => UPZ(new T.CylinderGeometry(rt, rb, h, seg, 1, open)),
  cone: (r, h, seg = 12) => UPZ(new T.ConeGeometry(r, h, seg)),
  tor: (R, r, rs = 8, ts = 24, arc = Math.PI * 2) => new T.TorusGeometry(R, r, rs, ts, arc),
  cap: (r, len, cs = 4, rs = 10) => UPZ(new T.CapsuleGeometry(r, len, cs, rs)),
  ico: (r, d = 0) => new T.IcosahedronGeometry(r, d),
  oct: (r) => new T.OctahedronGeometry(r, 0),
  box: (w, d, h) => new T.BoxGeometry(w, d, h),
  rbox(w, d, h, r, seg = 3) {   // rounded box (x=w, y=d, z=h)
    const g = new T.BoxGeometry(w, d, h, seg, seg, seg), p = g.attributes.position, ix = w / 2 - r, iy = d / 2 - r, iz = h / 2 - r, v = V(), q = V();
    for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i); q.set(clamp(v.x, -ix, ix), clamp(v.y, -iy, iy), clamp(v.z, -iz, iz)); const d0 = v.clone().sub(q); if (d0.lengthSq() > 1e-9) v.copy(q).addScaledVector(d0.normalize(), r); p.setXYZ(i, v.x, v.y, v.z); }
    return smoothGeo(g);
  },
  lathe(pts, seg = 20, a0 = 0, arc = Math.PI * 2) { return UPZ(new T.LatheGeometry(pts.map(([r, z]) => new T.Vector2(Math.max(0, r), z)), seg, a0, arc)); },   // pts [radius, height]
  tube(pts, r, ts = 20, rs = 8, taper) {   // pts: bind-space points; taper(t) -> radius multiplier
    const cv = new T.CatmullRomCurve3(pts.map(p => V(...p))), g = new T.TubeGeometry(cv, ts, r, rs, false);
    if (taper) { const p = g.attributes.position, v = V(); for (let i = 0; i <= ts; i++) { const c = cv.getPointAt(i / ts), k = taper(i / ts); for (let j = 0; j <= rs; j++) { const id = i * (rs + 1) + j; v.fromBufferAttribute(p, id).sub(c).multiplyScalar(k).add(c); p.setXYZ(id, v.x, v.y, v.z); } } g.computeVertexNormals(); }
    return g;
  },
  ext(shape, depth, bevel = .4, segs = 2) {   // 2D outline [[x,y]...] extruded along +Z, centred on z
    const s = new T.Shape(shape.map(([x, y]) => new T.Vector2(x, y)));
    const g = new T.ExtrudeGeometry(s, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: segs, curveSegments: 8 });
    g.translate(0, 0, -depth / 2); return g;
  },
};
const sc = (g, sx, sy = sx, sz = sx) => { g.computeBoundingBox(); const c = g.boundingBox.getCenter(V()); g.translate(-c.x, -c.y, -c.z); g.scale(sx, sy, sz); g.translate(c.x, c.y, c.z); return g; };
// deform helpers for organic parts
function displace(g, f) { const p = g.attributes.position, v = V(); for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i); f(v); p.setXYZ(i, v.x, v.y, v.z); } g.computeVertexNormals(); return g; }

class Kit {
  constructor(base, opts) {
    this.B = base; this.parts = []; this.removeFn = null; this.slotFn = null; this.deformFn = null; this.visor = true; this.opts = opts || {};
    this.pat = null; this.mesh = null;
  }
  bp(name) { return this.B.bonePos[this.B.bone[name]].clone(); }
  // ray against the bind-pose body (base triangles still present): returns {p, n} or null
  hit(o, d, withParts) {
    if (!this._rm) { const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(this.B.pos, 3)); g.setIndex(new T.BufferAttribute(this.B.index, 1)); this._rm = new T.Mesh(g, new T.MeshBasicMaterial({ side: T.DoubleSide })); this._rm.updateMatrixWorld(true); }
    const rc = new T.Raycaster(V(...o), V(...d).normalize()); const objs = this.noBase ? [] : [this._rm];
    if (withParts || this.noBase) for (const pt of this.parts) { if (!pt._m) { const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(pt.pos, 3)); g.setIndex(new T.BufferAttribute(pt.idx, 1)); pt._m = new T.Mesh(g, this._rm.material); pt._m.updateMatrixWorld(true); } objs.push(pt._m); }
    const h = rc.intersectObjects(objs, false)[0]; if (!h) return null;
    const n = h.face.normal.clone(); if (n.dot(rc.ray.direction) > 0) n.negate(); return { p: h.point, n, d: h.distance };
  }
  surf(o, d, off = 0, withParts, fb) { const h = this.hit(o, d, withParts); if (!h) return fb ? V(...fb) : V(...o).addScaledVector(V(...d).normalize(), 30); return h.p.addScaledVector(h.n, off); }
  // cloth sheet hanging in front of (side=+1) or behind (side=-1) the body: rows of [z, [x...], offset]; misses are filled from neighbours
  sheet(rows, side, flip) {
    const pts = rows.map(([z, xs, off]) => xs.map(x => { const h = this.hit([x, side * 45, z], [0, -side, 0]); return h ? [x, h.p.y + side * off, z] : null; }));
    for (let i = 0; i < pts.length; i++) for (let j = 0; j < pts[i].length; j++) if (!pts[i][j]) {
      let best = null; for (let d = 1; d < pts[i].length && !best; d++) best = (pts[i][j - d] || pts[i][j + d]); if (!best && i) best = pts[i - 1][j];
      const [z, xs, off] = rows[i]; pts[i][j] = [xs[j], best ? best[1] : side * (12 + off), z]; }
    // never let a lower row tuck back inside the one above (cloth hangs straight down)
    for (let i = 1; i < pts.length; i++) for (let j = 0; j < pts[i].length; j++) { const a = pts[i - 1][j], b = pts[i][j]; if (side > 0 ? b[1] < a[1] - .2 : b[1] > a[1] + .2) b[1] = side > 0 ? Math.max(b[1], a[1] - .2) : Math.min(b[1], a[1] + .2); }
    return gridGeo(pts, side < 0 ? !flip : !!flip);
  }
  remove(fn) { const prev = this.removeFn; this.removeFn = prev ? (v, p, b) => prev(v, p, b) || fn(v, p, b) : fn; return this; }
  removeHead() { this.visor = false; return this.remove((v, p, b) => b === 'Head' || b === 'HeadTop_End'); }
  // squash the armour's tall neck collar + shoulder fins (for heads that are not helmets)
  lowCollar(k = .4, from = 153) { return this.deform((p, n, b) => { if ((TORSO.has(b) || /Shoulder/.test(b)) && p.z > from && Math.abs(p.x) < 17) { p.z = from + (p.z - from) * k; } }); }
  slots(fn) { const prev = this.slotFn; this.slotFn = prev ? (v, p, b, c) => { const r = fn(v, p, b, c); return r === undefined ? prev(v, p, b, c) : r; } : fn; return this; }
  deform(fn) { const prev = this.deformFn; this.deformFn = prev ? (p, n, b) => { prev(p, n, b); fn(p, n, b); } : fn; return this; }
  pattern(def) { this.pat = def; return this; }
  // add geometry; o: { slot, rough, metal, pat(bool), bone (rigid) | weights:'near' (transfer), glow, emb }
  add(geo, o = {}) {
    let g = geo.index ? geo : geo; if (!g.attributes.normal) g.computeVertexNormals();
    const p = g.attributes.position, nn = g.attributes.normal, cnt = p.count;
    const part = { pos: new Float32Array(cnt * 3), nrm: new Float32Array(cnt * 3), uv: new Float32Array(cnt * 2), idx: null, si: new Uint16Array(cnt * 4), sw: new Float32Array(cnt * 4), mat: new Float32Array(cnt * 4), o };
    for (let i = 0; i < cnt; i++) { part.pos[i * 3] = p.getX(i); part.pos[i * 3 + 1] = p.getY(i); part.pos[i * 3 + 2] = p.getZ(i); part.nrm[i * 3] = nn.getX(i); part.nrm[i * 3 + 1] = nn.getY(i); part.nrm[i * 3 + 2] = nn.getZ(i); }
    if (o.uv && g.attributes.uv) for (let i = 0; i < cnt; i++) { part.uv[i * 2] = g.attributes.uv.getX(i); part.uv[i * 2 + 1] = g.attributes.uv.getY(i); }
    part.idx = g.index ? Uint32Array.from(g.index.array) : Uint32Array.from({ length: cnt }, (_, i) => i);
    const flags = (o.pat ? 2 : 0) + (o.emb ? 4 : 0);
    for (let i = 0; i < cnt; i++) { part.mat[i * 4] = o.slot ?? 0; part.mat[i * 4 + 1] = o.rough ?? .55; part.mat[i * 4 + 2] = o.metal ?? .1; part.mat[i * 4 + 3] = flags; }
    this.parts.push(part); return part;
  }
  // add both sides: fn(s) builds the right side (s=+1) or the left side (s=-1)
  mirror(fn) { fn(1); fn(-1); return this; }
}

/* ======================================================================================= build a skin's merged geometry */
const GEO_CACHE = new Map();
function weightsFor(part, B) {
  const o = part.o, n = part.pos.length / 3;
  if (o.pre) return;
  if (o.bone) { const bi = B.bone[o.bone]; for (let i = 0; i < n; i++) { part.si[i * 4] = bi; part.sw[i * 4] = 1; } return; }
  const nearW = (p, bones) => { const allow = bones ? new Set(bones.map(b => B.bone[b])) : null, nb = B.grid.near(p.x, p.y, p.z, 4, allow ? v => allow.has(B.dom[v]) : null), acc = new Map();
    for (const [d2, v] of nb) { const w0 = 1 / (Math.sqrt(d2) + .5); for (let k = 0; k < 4; k++) { const w = B.sw[v * 4 + k] * w0; if (w > 0) acc.set(B.names[B.si[v * 4 + k]], (acc.get(B.names[B.si[v * 4 + k]]) || 0) + w); } }
    const tot = [...acc.values()].reduce((a, b) => a + b, 0) || 1; return [...acc.entries()].map(([b, w]) => [b, w / tot]); };
  if (o.wfn) { const p = V(); for (let i = 0; i < n; i++) { p.fromArray(part.pos, i * 3); const ws = o.wfn(p, nearW).sort((a, b) => b[1] - a[1]).slice(0, 4), s = ws.reduce((a, e) => a + e[1], 0) || 1; ws.forEach(([b, w], k) => { part.si[i * 4 + k] = B.bone[b]; part.sw[i * 4 + k] = w / s; }); } return; }
  // transfer: inverse-distance blend of the nearest body vertices' weights (optionally limited to some bones)
  const allow = o.bones ? new Set(o.bones.map(b => B.bone[b])) : null, filt = allow ? v => allow.has(B.dom[v]) : null;
  for (let i = 0; i < n; i++) {
    const nb = B.grid.near(part.pos[i * 3], part.pos[i * 3 + 1], part.pos[i * 3 + 2], 4, filt), acc = new Map(); let tot = 0;
    for (const [d2, v] of nb) { const w0 = 1 / (Math.sqrt(d2) + .5); for (let k = 0; k < 4; k++) { const w = B.sw[v * 4 + k] * w0; if (w <= 0) continue; const b = B.si[v * 4 + k]; acc.set(b, (acc.get(b) || 0) + w); tot += w; } }
    const top = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4), s = top.reduce((a, e) => a + e[1], 0) || 1;
    for (let k = 0; k < 4; k++) { part.si[i * 4 + k] = top[k] ? top[k][0] : 0; part.sw[i * 4 + k] = top[k] ? top[k][1] / s : 0; }
  }
}
function buildSkinGeo(skinId, variant) {
  const key = skinId + '|' + (variant ? 1 : 0); if (GEO_CACHE.has(key)) return GEO_CACHE.get(key);
  if (typeof EXTGEO !== 'undefined' && (EXTGEO[key] || EXTGEO[skinId + '|0'])) { const g = EXTGEO[key] || EXTGEO[skinId + '|0']; GEO_CACHE.set(key, g); return g; }
  const base = baseInit(); if (!base) return null;
  const def = SKIN[skinId] || SKIN.std, K = new Kit(base, { helmet: !!variant });
  (BUILD[def.id] || BUILD.std)(K, base, !!variant);
  const n = base.n;
  // base body: optional reshaping (costumes) with welded normals
  let pos = base.pos, nrm = base.nrm;
  if (K.deformFn) {
    pos = base.pos.slice(); const p = V(), nv = V();
    const moved = new Float32Array(base.wc * 3), cnt = new Uint16Array(base.wc), done = new Uint8Array(base.wc);
    // deform each welded point once (seams stay closed)
    for (let i = 0; i < n; i++) { const w = base.weld[i]; if (done[w]) continue; done[w] = 1; p.set(base.pos[i * 3], base.pos[i * 3 + 1], base.pos[i * 3 + 2]); nv.set(base.nrm[i * 3], base.nrm[i * 3 + 1], base.nrm[i * 3 + 2]); K.deformFn(p, nv, base.names[base.dom[i]], i); moved[w * 3] = p.x; moved[w * 3 + 1] = p.y; moved[w * 3 + 2] = p.z; }
    for (let i = 0; i < n; i++) { const w = base.weld[i]; pos[i * 3] = moved[w * 3]; pos[i * 3 + 1] = moved[w * 3 + 1]; pos[i * 3 + 2] = moved[w * 3 + 2]; }
    nrm = weldedNormals(pos, base.index, base.weld, base.wc, n);
  }
  // which base triangles stay
  const keep = []; const idx = base.index;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    if (K.removeFn) { let all = true; for (const v of [a, b, c]) if (!K.removeFn(v, V(base.pos[v * 3], base.pos[v * 3 + 1], base.pos[v * 3 + 2]), base.names[base.dom[v]])) { all = false; break; } if (all) continue; }
    keep.push(a, b, c);
  }
  // base material channels: slotFn(v, pos, bone) -> undefined (texture classes), or [slot, rough, metal, flags]
  const bmat = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    let r = K.slotFn ? K.slotFn(i, V(base.pos[i * 3], base.pos[i * 3 + 1], base.pos[i * 3 + 2]), base.names[base.dom[i]]) : undefined;
    if (r === undefined || r === null) r = [-1, -1, -1, K.pat && K.pat.body === false ? 0 : 2];
    bmat[i * 4] = r[0]; bmat[i * 4 + 1] = r[1]; bmat[i * 4 + 2] = r[2]; bmat[i * 4 + 3] = 1 + (r[3] || 0);
  }
  // attachments: weights
  for (const part of K.parts) weightsFor(part, base);
  let total = n; for (const p of K.parts) total += p.pos.length / 3;
  const P3 = new Float32Array(total * 3), N3 = new Float32Array(total * 3), U2 = new Float32Array(total * 2), SI = new Uint16Array(total * 4), SW = new Float32Array(total * 4), M4 = new Float32Array(total * 4);
  P3.set(pos); N3.set(nrm); U2.set(base.uv); SI.set(base.si); SW.set(base.sw); M4.set(bmat);
  const I = keep.slice(); let off = n;
  const ranges = [];
  for (const p of K.parts) { const c = p.pos.length / 3; ranges.push([off, c]); P3.set(p.pos, off * 3); N3.set(p.nrm, off * 3); U2.set(p.uv, off * 2); SI.set(p.si, off * 4); SW.set(p.sw, off * 4); M4.set(p.mat, off * 4); for (let i = 0; i < p.idx.length; i++) I.push(p.idx[i] + off); off += c; }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.BufferAttribute(P3, 3)); g.setAttribute('normal', new T.BufferAttribute(N3, 3)); g.setAttribute('uv', new T.BufferAttribute(U2, 2));
  g.setAttribute('skinIndex', new T.Uint16BufferAttribute(SI, 4)); g.setAttribute('skinWeight', new T.BufferAttribute(SW, 4)); g.setAttribute('aMat', new T.BufferAttribute(M4, 4));
  g.setIndex(new T.BufferAttribute(Uint32Array.from(I), 1)); g.computeBoundingSphere(); g.computeBoundingBox();
  g.userData.s9 = { skin: def.id, variant: !!variant, tris: I.length / 3, baseTris: keep.length / 3, partTris: (I.length - keep.length) / 3, visor: K.visor, pat: K.pat || null, nParts: K.parts.length, parts: ranges };
  GEO_CACHE.set(key, g); return g;
}
function weldedNormals(pos, index, weld, wc, n) {
  const acc = new Float32Array(wc * 3), a = V(), b = V(), c = V(), e1 = V(), e2 = V();
  for (let t = 0; t < index.length; t += 3) {
    const i0 = index[t], i1 = index[t + 1], i2 = index[t + 2];
    a.fromArray(pos, i0 * 3); b.fromArray(pos, i1 * 3); c.fromArray(pos, i2 * 3); e1.subVectors(b, a); e2.subVectors(c, a); e1.cross(e2);
    for (const v of [i0, i1, i2]) { const w = weld[v]; acc[w * 3] += e1.x; acc[w * 3 + 1] += e1.y; acc[w * 3 + 2] += e1.z; }
  }
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const w = weld[i]; e1.set(acc[w * 3], acc[w * 3 + 1], acc[w * 3 + 2]).normalize(); out[i * 3] = e1.x; out[i * 3 + 1] = e1.y; out[i * 3 + 2] = e1.z; }
  return out;
}

/* ======================================================================================= the skins (modelling in bind space, cm) */
// slots: 0 primary · 1 secondary · 2 dark · 3 accent · 4 glow (visor colour) · 5 light · 6 extra · 7 metal
const S = { P: 0, S: 1, D: 2, A: 3, G: 4, L: 5, X: 6, M: 7 };
const HEAD_C = [0, -2, 167];   // centre of the standard helmet
const TORSO = new Set(['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck']);
const HANDS_RE = /Hand/;
const FEET = /Foot|Toe/;
// helpers used by the builders
function gridGeo(rows, flip) {   // rows[i][j] = [x,y,z]
  const g = new T.BufferGeometry(), pos = [], idx = [], R = rows.length, C = rows[0].length;
  for (const row of rows) for (const p of row) pos.push(...p);
  for (let i = 0; i < R - 1; i++) for (let j = 0; j < C - 1; j++) { const a = i * C + j, b = a + C; if (flip) idx.push(a, a + 1, b, b, a + 1, b + 1); else idx.push(a, b, a + 1, b, b + 1, a + 1); }
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals(); return g;
}
// give a single-sided sheet some thickness: second face pushed along the normal + side walls on open borders
function thicken(g, t, outward) {
  g = g.index ? g : (T.BufferGeometryUtils ? T.BufferGeometryUtils.mergeVertices(g) : g); if (!g.attributes.normal) g.computeVertexNormals();
  const p = g.attributes.position, n = g.attributes.normal, cnt = p.count, ix = g.index.array, pos = new Float32Array(cnt * 6);
  for (let i = 0; i < cnt; i++) { const k = outward ? 1 : 0; for (let c = 0; c < 3; c++) { const pv = p.array[i * 3 + c], nv = n.array[i * 3 + c]; pos[i * 3 + c] = pv + nv * t * k; pos[(cnt + i) * 3 + c] = pv - nv * t * (1 - k); } }
  const idx = []; for (let q = 0; q < ix.length; q += 3) { idx.push(ix[q], ix[q + 1], ix[q + 2]); idx.push(cnt + ix[q], cnt + ix[q + 2], cnt + ix[q + 1]); }
  const edges = new Map(); for (let q = 0; q < ix.length; q += 3) for (let e = 0; e < 3; e++) { const a = ix[q + e], b = ix[q + (e + 1) % 3], k = a < b ? a + '|' + b : b + '|' + a; const v = edges.get(k); if (v) v.n++; else edges.set(k, { a, b, n: 1 }); }
  for (const { a, b, n: c } of edges.values()) if (c === 1) idx.push(a, cnt + a, b, b, cnt + a, cnt + b);
  const out = new T.BufferGeometry(); out.setAttribute('position', new T.BufferAttribute(pos, 3)); out.setIndex(idx); out.computeVertexNormals(); return out;
}
// band of a sphere facing +Y (front): w = width (deg), h = height (deg), e = elevation of its centre (deg)
function visorBand(c, R, w, h, e = 0, ws = 24, hs = 4) {
  const g = new T.SphereGeometry(R, ws, hs, Math.PI * 1.5 - w * D2R / 2, w * D2R, Math.PI / 2 - e * D2R - h * D2R / 2, h * D2R); UPZ(g); g.translate(...c); return g;
}
const ellBand = (c, r, w, h, e, ws = 24, hs = 3) => visorBand([0, 0, 0], 1, w, h, e, ws, hs).applyMatrix4(new T.Matrix4().makeScale(...r)).translate(...c);
const rot = (n, from = V(0, 0, 1)) => { const e = new T.Euler().setFromQuaternion(new T.Quaternion().setFromUnitVectors(from, n.clone().normalize())); return [e.x / D2R, e.y / D2R, e.z / D2R]; };
// round shoulder patch carrying the emblem, projected onto whatever is there (body and parts) so it never floats
function emblemPatch(K, o = {}) {
  const c = o.c || [-30, -6, 200], dir = o.dir || [0, 0, -1], R = o.r || 4.6, rings = 4, segs = 18, bones = o.bones || ['LeftArm', 'LeftShoulder'];
  const d = V(...dir).normalize(), up = Math.abs(d.z) > .9 ? V(1, 0, 0) : V(0, 0, 1), ax = new T.Vector3().crossVectors(up, d).normalize(), ay = new T.Vector3().crossVectors(d, ax).normalize();
  if (o.flipU) ax.negate(); if (o.flipV) ay.negate();
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= rings; i++) for (let j = 0; j <= segs; j++) {
    const rr = R * i / rings, a = j / segs * Math.PI * 2, lx = Math.cos(a) * rr, ly = Math.sin(a) * rr;
    const o3 = V(...c).addScaledVector(ax, lx).addScaledVector(ay, ly).addScaledVector(d, -30);
    const h = K.hit(o3.toArray(), d.toArray(), true); const p = h ? h.p.addScaledVector(h.n, o.off || .32) : o3.addScaledVector(d, 30);
    pos.push(p.x, p.y, p.z); uv.push(.5 + lx / R * .5, .5 - ly / R * .5);
  }
  for (let i = 0; i < rings; i++) for (let j = 0; j < segs; j++) { const a = i * (segs + 1) + j, b = a + segs + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); }
  const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
  const nn = g.attributes.normal; let flip = 0; for (let i = 0; i < nn.count; i++) flip += nn.getX(i) * -d.x + nn.getY(i) * -d.y + nn.getZ(i) * -d.z;
  if (flip < 0) { const ix = g.index.array; for (let t = 0; t < ix.length; t += 3) { const tmp = ix[t + 1]; ix[t + 1] = ix[t + 2]; ix[t + 2] = tmp; } g.computeVertexNormals(); }
  K.add(g, { slot: o.slot ?? S.D, rough: .45, metal: .2, emb: true, uv: true, bones });
}
// balaclava head + neck for helmet-off looks; eyes: thin glowing visor strip
function bareHead(K, o = {}) {
  const [x, y, z] = HEAD_C;
  K.add(xf(P.ell(9.4, 10.4, 11.6, 18, 14), { p: [x, y + .5, z - .5] }), { slot: o.slot ?? S.D, rough: .75, metal: 0, bone: 'Head' });
  K.add(xf(P.cyl(5.8, 6.6, 12, 12), { p: [x, y - 2.2, 153.5] }), { slot: o.slot ?? S.D, rough: .75, metal: 0, bone: 'Head' });
  if (o.eyes) K.add(ellBand([x, y + .5, z - .5], [9.7, 10.7, 11.9], 110, 11, 7, 20, 2), { slot: S.G, rough: .1, metal: 0, bone: 'Head' });
}
// goggles: two lens cups + strap ring; tilt (deg) pushes them up onto the forehead
function goggles(K, o = {}) {
  const z = o.z ?? 170, yF = o.y ?? 10.3, w = o.w ?? 4.1, tilt = o.tilt || 0;
  for (const s of [-1, 1]) {
    K.add(xf(P.cyl(w, w * 1.08, 3.2, 14), { r: [90 + tilt, 0, 0], p: [s * 4.6, yF, z] }), { slot: S.D, rough: .35, metal: .6, bone: 'Head' });
    K.add(xf(P.cyl(w * .8, w * .8, .8, 14), { r: [90 + tilt, 0, 0], p: [s * 4.6, yF + 1.65, z + tilt * .03] }), { slot: o.lens ?? S.G, rough: .05, metal: .2, bone: 'Head' });
  }
  K.add(xf(P.tor(o.ringR ?? 10.9, .8, 5, 32), { s: [1, o.ringY ?? 1.08, 1], p: [0, -1.6, z] }), { slot: S.D, rough: .8, metal: 0, bone: 'Head' });
}
// dorsal fin: triangle with its base along the spine (Z), tip pointing back (-Y), thin in X
const dorsal = (w, h, t, p) => { const g = P.ext([[-w, 0], [0, h], [w, 0]], t, Math.min(.5, t * .3), 1); g.applyMatrix4(new T.Matrix4().makeBasis(V(0, 0, 1), V(0, -1, 0), V(1, 0, 0))); return g.translate(...p); };
const fur = (g, amt, seed) => { const N = makeNoise(seed); g.computeVertexNormals(); const nn = g.attributes.normal, p = g.attributes.position; for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i), z = p.getZ(i), n = N.n2(x * 2.2 + 40, y * 2.2 + z * 1.7 + 40, 256), n2 = N.n2(x * 7 + 9, y * 7 + z * 6, 256), k = ((n - .5) * 1.2 + (n2 - .5) * .9) * amt * 10; p.setXYZ(i, x + nn.getX(i) * k, y + nn.getY(i) * k, z + nn.getZ(i) * k); } g.computeVertexNormals(); return g; };
const BUILD = {
  /* ------------------------------------------------------------------ Desert Nomad */
  nomad(K, B, helmet) {
    const [hx, hy] = HEAD_C;
    if (!helmet) {
      K.removeHead(); bareHead(K, { slot: S.X });
      const R = rng(5);   // turban: wrapped bands, each a little different, built up over the crown
      for (let i = 0; i < 5; i++) K.add(xf(P.tor(9.4 - i * .7, 2.3, 6, 22), { s: [1, 1.12, .78], r: [(R() - .5) * 16 - 8, (R() - .5) * 12, R() * 360], p: [hx, hy - .6, 171.5 + i * 2.1] }), { slot: S.P, rough: .95, metal: 0, bone: 'Head', pat: true });
      K.add(xf(P.ell(8, 9, 4.4, 14, 8), { p: [hx, hy - .6, 181.5] }), { slot: S.P, rough: .95, metal: 0, bone: 'Head', pat: true });
      K.add(thicken(ellBand([hx, hy + .4, 164], [10, 11, 11.6], 190, 46, -32, 22, 3), .6, true), { slot: S.S, rough: .95, metal: 0, bone: 'Head', pat: true });
      K.add(sc(P.tube([[0, -11, 176], [0, -15, 168], [1, -17, 158], [3, -18, 148]], 2.2, 12, 6, t => 1 - t * .4), 1.6, .55, 1), { slot: S.P, rough: .95, metal: 0, bones: ['Head', 'Neck', 'Spine2'], pat: true });
      goggles(K, { z: 170.5, y: 9.4, lens: S.G });
    } else {
      const hood = new T.SphereGeometry(1, 22, 14, Math.PI * .1, Math.PI * 1.8, 0, Math.PI * .66); xf(hood, { s: [11.6, 15.6, 13], r: [90, 0, 90], p: [hx, hy - .8, 168.5] });
      K.add(hood, { slot: S.P, rough: .95, metal: 0, bone: 'Head', pat: true });
      K.add(sc(P.tube([[0, -14, 172], [0, -19, 162], [0, -21, 150], [0, -22, 140]], 3, 12, 8, t => 1 - t * .3), 1.6, .55, 1), { slot: S.P, rough: .95, metal: 0, bones: ['Head', 'Neck', 'Spine2'], pat: true });
      goggles(K, { z: 176.5, y: 9.2, tilt: -18, ringR: 11.6, lens: S.G });
    }
    // tabard: front + back cloth panels from the shoulders to mid-thigh, rope belt, pouches, bedroll on the back
    for (const side of [1, -1]) {
      const rows = []; for (let i = 0; i <= 7; i++) { const z = 154 - i * 9.5, w = 10.5 + i * .55; rows.push([z, [-w, -w / 2, 0, w / 2, w], 1.3 + i * .25]); }
      K.add(thicken(K.sheet(rows, side), .6), { slot: S.S, rough: .95, metal: 0, bones: ['Spine2', 'Spine1', 'Spine', 'Hips'], pat: true });
    }
    K.add(xf(P.tor(21, 1.1, 5, 36), { s: [1.08, .86, 1], p: [0, -1, 100.5] }), { slot: S.X, rough: .9, metal: 0, bones: ['Hips', 'Spine'] });
    for (const [x, y] of [[-1, .55], [1, .55], [-1, -.3]]) { const h = K.hit([x * 40, y * 40, 97], [-x, -y, 0]); if (h) K.add(xf(P.rbox(7, 4, 8, 1.2, 2), { r: rot(h.n, V(0, 1, 0)), p: h.p.addScaledVector(h.n, 1.6).toArray() }), { slot: S.X, rough: .85, metal: 0, bones: ['Hips'] }); }
    const by = K.surf([0, -40, 158], [0, 1, 0]).y - 4.4;
    K.add(xf(P.cyl(4.6, 4.6, 34, 12), { r: [0, 90, 0], p: [0, by, 158] }), { slot: S.P, rough: .9, metal: 0, bone: 'Spine2', pat: true });
    for (const x of [-11, 11]) K.add(xf(P.tor(4.8, .55, 5, 16), { r: [0, 90, 0], p: [x, by, 158] }), { slot: S.D, rough: .7, metal: .1, bone: 'Spine2' });
    emblemPatch(K);
  },

  /* ------------------------------------------------------------------ Arctic Ops */
  arctic(K, B, helmet) {
    const [hx, hy] = HEAD_C;
    if (helmet) {
      const hood = new T.SphereGeometry(1, 22, 14, Math.PI * .12, Math.PI * 1.76, 0, Math.PI * .72); xf(hood, { s: [12.4, 15.4, 14], r: [90, 0, 90], p: [hx, hy - 1.5, 167.5] });
      K.add(hood, { slot: S.P, rough: .85, metal: 0, bone: 'Head', pat: true });
      K.add(xf(fur(new T.TorusGeometry(10.6, 2.6, 10, 36), .22, 3), { s: [1, 1.22, 1], r: [90, 0, 0], p: [hx, hy + 6.8, 167] }), { slot: S.L, rough: 1, metal: 0, bone: 'Head' });
    } else {
      K.removeHead(); bareHead(K, { slot: S.D });
      K.add(xf(P.ell(10.4, 11.6, 8, 18, 10), { p: [hx, hy, 176] }), { slot: S.S, rough: .7, metal: 0, bone: 'Head', pat: true });
      K.add(xf(fur(new T.TorusGeometry(10.3, 2.6, 9, 32), .25, 7), { s: [1, 1.12, .8], p: [hx, hy, 174] }), { slot: S.L, rough: 1, metal: 0, bone: 'Head' });
      for (const s of [-1, 1]) K.add(xf(fur(P.ell(3.2, 6.2, 8, 10, 8), .2, 9 + s), { p: [s * 10.4, hy - 1.5, 165] }), { slot: S.L, rough: 1, metal: 0, bone: 'Head' });
      goggles(K, { z: 168.5, y: 9.6, w: 4.4, lens: S.A });
      K.add(xf(P.ell(7.6, 4.4, 5.2, 14, 8), { p: [hx, 7.4, 159.6] }), { slot: S.X, rough: .6, metal: .2, bone: 'Head' });
      for (let i = -2; i <= 2; i++) K.add(xf(P.box(.8, 1, 3.4), { p: [i * 2, 11.6, 159.6] }), { slot: S.D, rough: .6, metal: .2, bone: 'Head' });
    }
    for (let i = -1; i <= 1; i++) { const s = K.surf([i * 7.5, 40, 128], [0, -1, 0], 2.2); K.add(xf(P.rbox(6.4, 4.4, 11, 1.1, 2), { p: [s.x, s.y, s.z] }), { slot: S.S, rough: .8, metal: 0, bones: ['Spine1', 'Spine2'] }); K.add(xf(P.box(5, .8, 2.4), { p: [s.x, s.y + 2.3, s.z + 3.6] }), { slot: S.A, rough: .6, metal: 0, bones: ['Spine1', 'Spine2'] }); }
    for (const sx of [-1, 1]) K.add(sc(P.tube([[sx * 9, 9, 150], [sx * 10, 14, 138], [sx * 9.5, 15.8, 124]], .9, 8, 5), 1, .6, 1), { slot: S.D, rough: .8, metal: 0, bones: ['Spine2', 'Spine1'] });
    const by = K.surf([0, -40, 136], [0, 1, 0]).y - 4.6;
    K.add(xf(P.rbox(24, 9, 22, 2.6, 2), { p: [0, by, 136] }), { slot: S.S, rough: .8, metal: 0, bone: 'Spine2', pat: true });
    K.add(xf(P.cyl(.9, .9, 34, 6), { r: [0, -25, 0], p: [3, by - 5.4, 138] }), { slot: S.D, rough: .5, metal: .4, bone: 'Spine2' });
    K.add(xf(P.ext([[-6, -1], [6, -1.4], [9, 1], [0, 2], [-9, 1]], 1.2, .2, 1), { r: [90, 0, -25], p: [-4.2, by - 5.4, 153.4] }), { slot: S.M, rough: .3, metal: .9, bone: 'Spine2' });
    for (const s of ['Left', 'Right']) { const p = K.bp(s + 'Foot'); K.add(xf(fur(new T.TorusGeometry(7.6, 2, 8, 26), .25, 11), { s: [1, 1.15, 1], p: [p.x, p.y + 1, 19.5] }), { slot: S.L, rough: 1, metal: 0, bone: s + 'Leg' }); }
    emblemPatch(K);
  },

  /* ------------------------------------------------------------------ Cyber Ninja */
  ninja(K) {
    const [hx, hy] = HEAD_C, HC = [hx, hy + .3, 166], HR = [9.2, 10.4, 12];
    K.removeHead();
    K.add(xf(P.ell(...HR, 20, 14), { p: HC }), { slot: S.P, rough: .45, metal: .2, bone: 'Head' });
    K.add(xf(P.cyl(5.6, 6.4, 12, 12), { p: [hx, hy - 2.2, 153.5] }), { slot: S.P, rough: .6, metal: .1, bone: 'Head' });
    const shell = (w, h, e, k = 1.03) => visorBand([0, 0, 0], 1, w, h, e, 24, 3).applyMatrix4(new T.Matrix4().makeScale(HR[0] * k, HR[1] * k, HR[2] * k)).translate(...HC);
    K.add(shell(120, 9, 12), { slot: S.G, rough: .1, metal: 0, bone: 'Head' });   // eye slit
    K.add(thicken(shell(130, 30, -22, 1.04), .9, true), { slot: S.M, rough: .3, metal: .9, bone: 'Head' });   // jaw plate
    for (let i = -2; i <= 2; i++) { const a = (90 + i * 13) * D2R, e = -22 * D2R; K.add(xf(P.box(.5, .8, 6.4), { r: [0, 0, 90 - (90 + i * 13)], p: [HC[0] + Math.cos(a) * HR[0] * 1.09 * Math.cos(e), HC[1] + Math.sin(a) * HR[1] * 1.09 * Math.cos(e), HC[2] + Math.sin(e) * HR[2]] }), { slot: S.D, rough: .5, metal: .5, bone: 'Head' }); }
    // headband hugging the head (radius follows the ellipsoid at that height) + two long tails
    const bz = 4.6, kz = Math.sqrt(1 - Math.pow(bz / HR[2], 2));
    K.add(xf(P.tor(HR[0] * kz + .3, .9, 5, 30), { s: [1, (HR[1] * kz + .3) / (HR[0] * kz + .3), 1], p: [HC[0], HC[1], HC[2] + bz] }), { slot: S.S, rough: .6, metal: 0, bone: 'Head' });
    const by = HC[1] - HR[1] * kz - .6;
    K.add(xf(P.rbox(3.4, 2.2, 3, .8, 1), { p: [0, by, HC[2] + bz] }), { slot: S.S, rough: .6, metal: 0, bone: 'Head' });
    for (const [x, d] of [[-1.2, 1], [1.2, -.6]]) K.add(sc(P.tube([[x, by - .5, HC[2] + bz], [x * 2 + d, by - 6, HC[2] + bz - 2], [x * 3 + d * 2, by - 12, HC[2] + bz - 6], [x * 4 + d * 3, by - 17, HC[2] + bz - 12]], 1.2, 12, 4, t => 1 - t * .4), 1.5, 1, .5), { slot: S.S, rough: .6, metal: 0, bone: 'Head' });
    // scarf ring + trailing scarf down the back
    K.add(xf(P.tor(10.2, 3, 8, 26), { s: [1, 1.15, 1], p: [0, -4.5, 152.5] }), { slot: S.S, rough: .9, metal: 0, bones: ['Neck', 'Spine2'] });
    const sb = K.surf([-6, -40, 140], [0, 1, 0]).y;
    K.add(sc(P.tube([[-4, -15, 151], [-7, sb - 3, 146], [-10, sb - 4, 136], [-12, sb - 3.5, 124]], 3.2, 14, 6, t => 1 - t * .35), 1, .45, 1), { slot: S.S, rough: .9, metal: 0, bone: 'Spine2' });
    // katana on the back: sheath diagonal, guard + wrapped grip over the right shoulder
    const bk = K.surf([0, -40, 136], [0, 1, 0]).y - 3.4, a = V(15, bk, 158), b2 = V(-14, bk - 1, 104), dir = b2.clone().sub(a).normalize(), mid = a.clone().add(b2).multiplyScalar(.5), L = a.distanceTo(b2), er = rot(dir);
    K.add(xf(sc(P.cap(1.7, L - 3.4, 3, 8), 1.35, .7, 1), { r: er, p: mid.toArray() }), { slot: S.D, rough: .3, metal: .3, bone: 'Spine2' });
    K.add(xf(P.cyl(3.6, 3.6, .9, 14), { r: er, p: a.clone().addScaledVector(dir, -1.2).toArray() }), { slot: S.M, rough: .3, metal: .9, bone: 'Spine2' });
    K.add(xf(P.cyl(1.25, 1.25, 13, 8), { r: er, p: a.clone().addScaledVector(dir, -8.5).toArray() }), { slot: S.S, rough: .7, metal: 0, bone: 'Spine2' });
    K.add(xf(P.sph(1.5, 8, 6), { p: a.clone().addScaledVector(dir, -15.2).toArray() }), { slot: S.M, rough: .3, metal: .9, bone: 'Spine2' });
    K.mirror(s => { const side = s < 0 ? 'Left' : 'Right', fa = K.bp(side + 'ForeArm');
      const g = new T.CylinderGeometry(7.4, 6.6, 15, 14, 1, true, Math.PI * .1, Math.PI * 1.2); g.rotateZ(Math.PI / 2 * s); xf(g, { p: [fa.x + s * 11, fa.y - .5, fa.z + .4] });
      K.add(thicken(g, .9), { slot: S.M, rough: .3, metal: .85, bone: side + 'ForeArm' });
      K.add(xf(P.tor(7.5, .45, 5, 20), { r: [0, 90, 0], p: [fa.x + s * 5, fa.y - .5, fa.z + .4] }), { slot: S.G, rough: .1, metal: 0, bone: side + 'ForeArm' });
    });
    K.add(xf(P.tor(20.5, 2, 6, 34), { s: [1.08, .86, 1], r: [0, -6, 0], p: [0, -1, 103] }), { slot: S.S, rough: .8, metal: 0, bones: ['Hips', 'Spine'] });
    K.add(P.tube([[12, 12, 102], [14, 15, 96], [15, 15.5, 88]], 1.5, 6, 5, t => 1 - t * .4), { slot: S.S, rough: .8, metal: 0, bones: ['Hips'] });
    emblemPatch(K);
  },

  /* ------------------------------------------------------------------ Space Pirate */
  pirate(K, B, helmet) {
    const [hx, hy] = HEAD_C;
    if (helmet) {
      K.add(xf(P.ell(10.6, 11.6, 6.5, 18, 8), { p: [hx, hy - .5, 181] }), { slot: S.D, rough: .7, metal: 0, bone: 'Head', pat: true });
      const brim = new T.RingGeometry(9.5, 19, 30, 2), bp = brim.attributes.position, v = V();
      for (let i = 0; i < bp.count; i++) { v.fromBufferAttribute(bp, i); const r = v.length(), th = Math.atan2(v.y, v.x) + Math.PI / 2, k = Math.pow(Math.max(0, Math.cos(th * 3)), .7) * Math.max(0, (r - 10) / 9); bp.setXYZ(i, v.x, v.y * 1.06, k * 9 + (r - 9.5) * .12); }
      brim.computeVertexNormals(); xf(brim, { p: [hx, hy - .5, 177.5] });
      K.add(thicken(brim, .9, true), { slot: S.D, rough: .75, metal: 0, bone: 'Head', pat: true });
      const e = []; for (let i = 0; i <= 60; i++) { const a = i / 60 * Math.PI * 2, th = a + Math.PI / 2, k = Math.pow(Math.max(0, Math.cos(th * 3)), .7); e.push(V(hx + Math.cos(a) * 19, hy - .5 + Math.sin(a) * 19 * 1.06, 177.5 + k * 9 + 1.15)); }
      K.add(new T.TubeGeometry(new T.CatmullRomCurve3(e, true), 60, .55, 4, true), { slot: S.A, rough: .25, metal: .95, bone: 'Head' });
      emblemPatch(K, { c: [hx, 40, 182.5], dir: [0, -1, 0], r: 3.2, slot: S.D, bones: ['Head'], off: .25 });
    } else {
      K.removeHead(); bareHead(K, { slot: S.D });
      K.add(xf(new T.SphereGeometry(1, 18, 8, 0, Math.PI * 2, 0, Math.PI * .5), { s: [10.1, 11.2, 9], r: [90, 0, 0], p: [hx, hy + .3, 168.8] }), { slot: S.P, rough: .85, metal: 0, bone: 'Head', pat: true });
      K.add(xf(P.sph(2.4, 8, 6), { p: [0, -11.5, 169.5] }), { slot: S.P, rough: .85, metal: 0, bone: 'Head' });
      for (const s of [-1, 1]) K.add(P.tube([[0, -12, 169.5], [s * 2.4, -15.5, 165], [s * 3.6, -17.5, 159]], 1.2, 6, 5, t => 1 - t * .4), { slot: S.P, rough: .85, metal: 0, bone: 'Head' });
      K.add(xf(P.tor(10, .35, 4, 30), { s: [1, 1.1, 1], r: [0, -14, 0], p: [hx, hy + .5, 168] }), { slot: S.D, rough: .6, metal: 0, bone: 'Head' });
      K.add(xf(P.ell(3.1, 1.2, 2.6, 10, 6), { p: [-4.4, 9.2, 167.4] }), { slot: S.S, rough: .4, metal: .1, bone: 'Head' });
      K.add(xf(P.tor(2.6, .6, 5, 16), { r: [90, 0, 0], p: [4.4, 9.6, 167.4] }), { slot: S.A, rough: .25, metal: .95, bone: 'Head' });
      K.add(xf(P.cyl(2.1, 2.1, .6, 14), { r: [90, 0, 0], p: [4.4, 9.8, 167.4] }), { slot: S.G, rough: .1, metal: 0, bone: 'Head' });
      for (const x of [-2.8, 0, 2.8]) K.add(P.tube([[x, 7.6, 160], [x * 1.1, 8.8, 155], [x * 1.2, 9, 150.5]], 1.25, 6, 5, t => 1 - t * .5), { slot: S.S, rough: .8, metal: 0, bone: 'Head' });
      for (const x of [-2.8, 0, 2.8]) K.add(xf(P.tor(1.1, .35, 4, 10), { p: [x * 1.15, 8.9, 153] }), { slot: S.A, rough: .25, metal: .95, bone: 'Head' });
    }
    // long coat: 4 coat-tail panels (each follows its own leg), lapels, cuffs, belt + buckle, bandolier
    for (const [s, f] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
      const side = s < 0 ? 'Left' : 'Right', rows = [];
      for (let i = 0; i <= 5; i++) { const z = 99 - i * 9.6, xs = []; for (let j = 0; j <= 3; j++) xs.push(s * (3 + j * (5.2 + i * .15))); rows.push([z, xs, 1.4 + i * .42]); }
      K.add(thicken(K.sheet(rows, f, s > 0), .7), { slot: S.P, rough: .7, metal: 0, bones: ['Hips', side + 'UpLeg'], pat: true });
    }
    const cs = K.surf([0, 40, 146], [0, -1, 0]);
    for (const s of [-1, 1]) K.add(xf(P.ext([[0, 0], [4.5, -2], [6.5, -14], [2, -24], [.5, -24]], .8, .25, 1), { r: [90, 0, s * -8], s: [s, 1, 1], p: [s * 4.5, cs.y + .9, 154] }), { slot: S.A, rough: .3, metal: .9, bones: ['Spine2', 'Spine1'] });
    K.add(xf(P.tor(20.2, 1.6, 5, 34), { s: [1.08, .88, 1], p: [0, -1, 101] }), { slot: S.D, rough: .5, metal: 0, bones: ['Hips', 'Spine'] });
    const bs = K.surf([0, 40, 101], [0, -1, 0]); K.add(xf(P.rbox(7, 1.4, 5.2, .8, 1), { p: [0, bs.y + .5, 101] }), { slot: S.A, rough: .25, metal: .95, bones: ['Hips'] });
    const bd = []; for (let i = 0; i <= 10; i++) { const t = i / 10, x = lerp(16, -15, t), z = lerp(156, 104, t), s2 = K.surf([x, 40, z], [0, -1, 0], 1); bd.push(s2.toArray()); }
    K.add(P.tube(bd, 1.5, 20, 5), { slot: S.D, rough: .6, metal: 0, bones: ['Spine2', 'Spine1', 'Spine', 'Hips'] });
    for (let i = 1; i < 10; i += 2) K.add(xf(P.cyl(.8, .8, 3.4, 6), { r: [0, 0, 32], p: [bd[i][0], bd[i][1] + 1.1, bd[i][2]] }), { slot: S.A, rough: .25, metal: .95, bones: ['Spine1', 'Spine'] });
    K.mirror(s => { const side = s < 0 ? 'Left' : 'Right', fa = K.bp(side + 'ForeArm'); K.add(xf(P.cyl(8, 7, 7, 14), { r: [0, 0, 90], p: [fa.x + s * 18.5, fa.y - .5, fa.z] }), { slot: S.P, rough: .7, metal: 0, bone: side + 'ForeArm', pat: true }); K.add(xf(P.tor(8, .5, 4, 20), { r: [0, 90, 0], p: [fa.x + s * 22, fa.y - .5, fa.z] }), { slot: S.A, rough: .3, metal: .95, bone: side + 'ForeArm' }); });
    // robot parrot perched on the left shoulder
    const sh = K.surf([-15, -5, 200], [0, 0, -1], 0), px = sh.x, py = sh.y, pz = sh.z;
    for (const dx of [-1.4, 1.4]) K.add(xf(P.cyl(.45, .45, 3, 5), { p: [px + dx, py, pz + 1.3] }), { slot: S.M, rough: .3, metal: .9, bone: 'LeftShoulder' });
    K.add(xf(P.ell(3.6, 4.6, 5.6, 12, 8), { r: [-18, 0, 0], p: [px, py, pz + 6.6] }), { slot: S.X, rough: .35, metal: .6, bone: 'LeftShoulder' });
    K.add(xf(P.sph(3, 12, 8), { p: [px, py + 1.6, pz + 12.6] }), { slot: S.X, rough: .35, metal: .6, bone: 'LeftShoulder' });
    K.add(xf(P.cone(1.3, 3.6, 8), { r: [-120, 0, 0], p: [px, py + 4.6, pz + 11.6] }), { slot: S.A, rough: .3, metal: .9, bone: 'LeftShoulder' });
    for (const dx of [-1.5, 1.5]) K.add(xf(P.sph(.75, 6, 5), { p: [px + dx * 1.2, py + 3.4, pz + 13.4] }), { slot: S.G, rough: .1, metal: 0, bone: 'LeftShoulder' });
    for (const dx of [-1, 1]) K.add(xf(P.ell(1, 3.6, 4.8, 8, 6), { r: [-25, dx * 8, 0], p: [px + dx * 3.6, py - .5, pz + 6] }), { slot: S.A, rough: .4, metal: .7, bone: 'LeftShoulder' });
    K.add(xf(P.ell(1.6, 1, 6, 6, 6), { r: [35, 0, 0], p: [px, py - 4.8, pz + 1] }), { slot: S.A, rough: .4, metal: .7, bone: 'LeftShoulder' });
    if (!helmet) emblemPatch(K, { c: [-30, -6, 200], r: 4 });
  },

};

Object.assign(BUILD, {
  /* ------------------------------------------------------------------ Mushroom Man */
  mushroom(K) {
    const [hx, hy] = HEAD_C;
    K.removeHead(); K.lowCollar(.45, 152);
    K.add(xf(P.lathe([[6, 150], [8.2, 156], [9, 163], [8.6, 170], [7.6, 175], [0, 176]], 20), { p: [hx, hy, 0] }), { slot: S.L, rough: .75, metal: 0, bone: 'Head' });
    for (const s of [-1, 1]) K.add(xf(P.ell(1.6, 1, 2.3, 8, 6), { p: [s * 3.3, hy + 8.4, 166.5] }), { slot: S.G, rough: .2, metal: 0, bone: 'Head' });
    K.add(P.tube([[-2.6, hy + 8.4, 162.4], [0, hy + 9.1, 161.2], [2.6, hy + 8.4, 162.4]], .4, 8, 4), { slot: S.D, rough: .5, metal: 0, bone: 'Head' });
    for (const s of [-1, 1]) K.add(xf(P.ell(1.4, .4, .9, 6, 4), { p: [s * 5, hy + 7.9, 163.8] }), { slot: S.A, rough: .8, metal: 0, bone: 'Head' });
    const capC = [hx, hy - 1, 172.5], cap = P.lathe([[0, 12], [6, 11.4], [11, 9.2], [15, 5.6], [17.6, 1.6], [18.2, -.4], [17, -1.4], [10, -.8], [6, -.6]], 30);
    xf(cap, { r: [-7, 0, 0], p: capC }); K.add(cap, { slot: S.P, rough: .45, metal: 0, bone: 'Head' });
    const gills = P.lathe([[6.2, -.8], [16.6, -1.2]], 48); displace(gills, v => { const a = Math.atan2(v.y, v.x); v.z += -.9 * Math.abs(Math.sin(a * 24)); });
    xf(gills, { r: [-7, 0, 0], p: [capC[0], capC[1], capC[2] - .4] }); K.add(gills, { slot: S.L, rough: .8, metal: 0, bone: 'Head' });
    const R = rng(17);
    for (let i = 0; i < 11; i++) { const a = R() * Math.PI * 2, rr = i < 1 ? 0 : 4 + R() * 11; const lp = V(Math.cos(a) * rr, Math.sin(a) * rr, 30).applyEuler(new T.Euler(-7 * D2R, 0, 0)).add(V(...capC)); const h = K.hit(lp.toArray(), [0, 0, -1], true);
      if (!h || h.p.z < capC[2] - 2) continue; const sz = 1.3 + R() * 1.9;
      K.add(xf(P.ell(sz, sz, sz * .35, 10, 5), { r: rot(h.n), p: h.p.toArray() }), { slot: S.L, rough: .6, metal: 0, bone: 'Head' }); }
    const baby = (pt, n, s, bone) => { const e = rot(n);
      const g1 = xf(P.cyl(.9 * s, 1.2 * s, 4 * s, 8), { p: [0, 0, 2 * s - .5] }), g2 = xf(P.lathe([[0, 2.2], [2.2, 1.4], [3, .2], [1.2, 0]], 12).scale(s, s, s), { p: [0, 0, 3.6 * s] });
      for (const [g, sl] of [[g1, S.L], [g2, S.P]]) K.add(xf(g, { r: e, p: pt.toArray() }), { slot: sl, rough: .5, metal: 0, bone }); };
    for (const [o, d, s, bone] of [[[-14, -6, 200], [0, 0, -1], 1.2, 'LeftShoulder'], [[-18, -9, 200], [0, 0, -1], .8, 'LeftShoulder'], [[15, -7, 200], [0, 0, -1], .95, 'RightShoulder'], [[-6, -40, 132], [0, 1, 0], 1.1, 'Spine2'], [[5, -40, 124], [0, 1, 0], .8, 'Spine1']]) { const h = K.hit(o, d); if (h) baby(h.p.addScaledVector(h.n, -.4), h.n, s, bone); }
    const N = makeNoise(4);
    for (const [o, d, s, bone] of [[[-11, -6, 200], [0, 0, -1], 1, 'LeftShoulder'], [[12, -10, 200], [0, 0, -1], .9, 'RightShoulder'], [[0, -40, 112], [0, 1, 0], 1, 'Spine'], [[-12, 40, 128], [0, -1, 0], .8, 'Spine1']]) { const h = K.hit(o, d); if (h) K.add(xf(displace(P.ell(4.6 * s, 4.6 * s, 2 * s, 12, 6), v => v.multiplyScalar(1 + (N.n2(v.x * 1.4 + 9, v.y * 1.4 + v.z, 64) - .5) * .5)), { r: rot(h.n), p: h.p.toArray() }), { slot: S.A, rough: 1, metal: 0, bone, pat: true }); }
    emblemPatch(K, { c: [-30, -6, 200], r: 4, slot: S.X });
  },

  /* ------------------------------------------------------------------ Skeleton Phantom */
  skeleton(K) {
    const [hx, hy] = HEAD_C;
    K.removeHead(); K.lowCollar(.5, 152);
    K.add(xf(P.ell(9.4, 10.8, 10.2, 20, 14), { p: [hx, hy - .8, 170.5] }), { slot: S.L, rough: .55, metal: 0, bone: 'Head' });
    K.add(xf(P.ell(7.6, 7.8, 5.5, 16, 8), { p: [hx, hy + 3.6, 162.5] }), { slot: S.L, rough: .55, metal: 0, bone: 'Head' });
    for (const s of [-1, 1]) {
      K.add(xf(P.ell(3, 2, 3.2, 10, 8), { p: [s * 3.8, hy + 9.6, 167.2] }), { slot: S.D, rough: .9, metal: 0, bone: 'Head' });
      K.add(xf(P.sph(1.1, 8, 6), { p: [s * 3.8, hy + 10.6, 167.2] }), { slot: S.G, rough: .1, metal: 0, bone: 'Head' });
      K.add(xf(P.ell(2.2, 3.4, 1.6, 8, 6), { p: [s * 6.6, hy + 7.6, 164] }), { slot: S.L, rough: .55, metal: 0, bone: 'Head' });
    }
    K.add(xf(P.ext([[-1.2, 0], [1.2, 0], [0, 2.6]], .8, .2, 1), { r: [90, 0, 0], p: [0, hy + 11.2, 162.6] }), { slot: S.D, rough: .9, metal: 0, bone: 'Head' });
    K.add(xf(P.rbox(11, 7.4, 3.6, 1.6, 2), { p: [hx, hy + 4.6, 157.2] }), { slot: S.L, rough: .55, metal: 0, bone: 'Head' });
    for (let i = -3; i <= 3; i++) K.add(xf(P.box(1.25, 1.2, 2.2), { p: [i * 1.45, hy + 8.4, 159.6] }), { slot: S.L, rough: .45, metal: 0, bone: 'Head' });
    K.add(xf(P.cyl(4.4, 5, 8, 10), { p: [hx, hy - 3, 152.5] }), { slot: S.D, rough: .8, metal: 0, bone: 'Head' });
    for (let i = 0; i < 5; i++) for (const s of [-1, 1]) {
      const z = 150 - i * 6.2, pts = []; for (let k = 0; k <= 5; k++) { const x = s * lerp(1.6, 17 - i * .8, k / 5), zz = z - Math.pow(k / 5, 1.6) * 4; pts.push(K.surf([x, 40, zz], [0, -1, 0], .9).toArray()); }
      K.add(P.tube(pts, 1.05 - i * .06, 10, 5), { slot: S.L, rough: .5, metal: 0, bones: ['Spine2', 'Spine1'] });
    }
    K.add(sc(P.tube([[0, 0, 153], [0, 0, 138], [0, 0, 124]].map(([x, , z]) => K.surf([x, 40, z], [0, -1, 0], 1.2).toArray()), 1.6, 8, 6), 1.4, 1, 1), { slot: S.L, rough: .5, metal: 0, bones: ['Spine2', 'Spine1'] });
    for (let z = 156; z >= 100; z -= 6.2) { const sp = K.surf([0, -40, z], [0, 1, 0], -.3); K.add(xf(P.rbox(5.4, 3.6, 3.8, 1.2, 1), { p: [sp.x, sp.y - 1.2, z] }), { slot: S.L, rough: .5, metal: 0, bones: z > 140 ? ['Spine2', 'Neck'] : z > 120 ? ['Spine1', 'Spine2'] : ['Spine', 'Hips'] }); }
    const pv = K.surf([0, 40, 100], [0, -1, 0]); K.add(xf(P.ext([[-13, 4], [13, 4], [9, -6], [3, -9], [-3, -9], [-9, -6]], 1.2, .5, 1), { r: [90, 0, 0], p: [0, pv.y + .8, 100] }), { slot: S.L, rough: .5, metal: 0, bones: ['Hips'] });
    K.mirror(s => {
      const side = s < 0 ? 'Left' : 'Right';
      for (const [a, b, bone] of [[side + 'Arm', side + 'ForeArm', side + 'Arm'], [side + 'ForeArm', side + 'Hand', side + 'ForeArm']]) { const pa = K.bp(a), pb = K.bp(b), m = pa.clone().lerp(pb, .5), L = pa.distanceTo(pb) * .78, top = K.surf([m.x, m.y, 200], [0, 0, -1], .2);
        K.add(xf(P.cap(1.3, L - 2.6, 2, 6), { r: [0, 90, 0], p: [m.x, m.y, top.z + .6] }), { slot: S.L, rough: .5, metal: 0, bone });
        for (const e of [-1, 1]) K.add(xf(P.ell(1.9, 1.6, 1.4, 8, 6), { p: [m.x + e * L / 2, m.y, top.z + .6] }), { slot: S.L, rough: .5, metal: 0, bone }); }
      for (const [a, b, bone] of [[side + 'UpLeg', side + 'Leg', side + 'UpLeg'], [side + 'Leg', side + 'Foot', side + 'Leg']]) { const pa = K.bp(a), pb = K.bp(b), m = pa.clone().lerp(pb, .5), L = pa.distanceTo(pb) * .7, fr = K.surf([m.x, 40, m.z], [0, -1, 0], .2);
        K.add(xf(P.cap(1.6, L - 3.2, 2, 6), { p: [m.x, fr.y + .7, m.z] }), { slot: S.L, rough: .5, metal: 0, bone });
        for (const e of [-1, 1]) K.add(xf(P.ell(2.2, 1.6, 1.8, 8, 6), { p: [m.x, fr.y + .7, m.z + e * L / 2] }), { slot: S.L, rough: .5, metal: 0, bone }); }
    });
    emblemPatch(K, { c: [-30, -6, 200], r: 4, slot: S.X });
  },

  /* ------------------------------------------------------------------ Neon Glitch */
  glitch(K) {
    const [hx, hy] = HEAD_C;
    K.removeHead();
    const bands = [[132, 138, 1.6], [108, 112, -1.4], [62, 66, 1.2], [148, 151, -1.1]];
    K.deform((p, n, b) => { for (const [z0, z1, dx] of bands) if (p.z > z0 && p.z < z1 && !/Arm|Hand|Shoulder/.test(b)) { p.x += dx; p.y += dx * .4; } });
    const head = new T.IcosahedronGeometry(1, 1).toNonIndexed(); xf(head, { s: [10.6, 11.6, 13.4], r: [8, 0, 18], p: [hx, hy, 167.5] }); head.computeVertexNormals();
    K.add(head, { slot: S.X, rough: .15, metal: .7, bone: 'Head' });
    const wire = new T.IcosahedronGeometry(1, 1); const ed = new T.EdgesGeometry(wire), ep = ed.attributes.position;
    for (let i = 0; i < ep.count; i += 2) { const a = V().fromBufferAttribute(ep, i), b = V().fromBufferAttribute(ep, i + 1); const m = new T.Matrix4().compose(V(hx, hy, 167.5), new T.Quaternion().setFromEuler(new T.Euler(8 * D2R, 0, 18 * D2R)), V(10.7, 11.7, 13.5)); a.applyMatrix4(m); b.applyMatrix4(m);
      if ((i / 2) % 3 === 0) K.add(xf(P.cyl(.28, .28, a.distanceTo(b), 4), { r: rot(b.clone().sub(a)), p: a.clone().lerp(b, .5).toArray() }), { slot: S.G, rough: .1, metal: 0, bone: 'Head' }); }
    K.add(xf(P.box(17, 2.8, 2.4), { p: [hx, hy + 10, 169.5] }), { slot: S.G, rough: .1, metal: 0, bone: 'Head' });
    K.add(xf(P.cyl(5, 6, 10, 6), { p: [hx, hy - 2.2, 153.5] }).toNonIndexed(), { slot: S.X, rough: .3, metal: .5, bone: 'Head' });
    const R = rng(23), spots = [[[0, 0, 200], [0, 0, -1], 'Head', 1.1], [[-16, -6, 200], [0, 0, -1], 'LeftShoulder', 2.3], [[17, -6, 200], [0, 0, -1], 'RightShoulder', 2.1], [[-22, -4, 200], [0, 0, -1], 'LeftArm', 1.8], [[23, -4, 200], [0, 0, -1], 'RightArm', 1.7], [[-50, -6, 200], [0, 0, -1], 'LeftForeArm', .7], [[40, -8, 116], [-1, 0, 0], 'Hips', .8],
      [[-40, 0, 72], [1, 0, 0], 'LeftUpLeg', .8], [[0, -40, 130], [0, 1, 0], 'Spine1', 1], [[12, 40, 146], [0, -1, 0], 'Spine2', .7], [[40, 2, 34], [-1, 0, 0], 'RightLeg', .6]];
    for (const [o, d, bone, s] of spots) { const h = K.hit(o, d, bone === 'Head'); if (!h) continue; const n = h.n, t1 = V(n.y, -n.x, 0); if (t1.lengthSq() < .01) t1.set(1, 0, 0); t1.normalize(); const t2 = new T.Vector3().crossVectors(n, t1);
      for (let i = 0; i < 6; i++) { const sz = (1.4 + R() * 2.6) * s, off = h.p.clone().addScaledVector(t1, (R() - .5) * 7 * s).addScaledVector(t2, (R() - .5) * 7 * s);
        const hh = K.hit(off.clone().addScaledVector(n, 20).toArray(), n.clone().negate().toArray(), bone === 'Head'); if (!hh) continue; const at = hh.p.addScaledVector(n, sz * (.1 + R() * .25));
        K.add(xf(P.box(sz, sz, sz), { r: [R() * 30, R() * 30, R() * 90], p: at.toArray() }), { slot: R() < .45 ? S.G : R() < .7 ? S.A : S.X, rough: .2, metal: .4, bone }); } }
    emblemPatch(K, { c: [-30, -6, 200], r: 4.2, slot: S.D });
  },

});

/* ======================================================================================= outfit bodies: each skin's own torso / arms / legs / boots
   Lofts whose cross-sections are measured from the standard soldier (so the visible volume stays the same and the hitboxes keep
   matching), reshaped per skin. Weights come from the soldier's own skin (nearest body vertices), so every outfit bends exactly
   like the standard soldier. The soldier's armour triangles are removed; only its gloved hands stay (recoloured). */
let PROF = null;
function profiles() {
  if (PROF) return PROF; const B = baseInit(), pos = B.pos, n = B.n, nm = i => B.names[B.dom[i]];
  const pct = (a, q) => { if (!a.length) return 0; a.sort((x, y) => x - y); return a[clamp(Math.floor(a.length * q), 0, a.length - 1)]; };
  const torso = [], arm = [], leg = [];
  for (let z = 84; z <= 162; z += 2) { const xs = [], ys = []; for (let i = 0; i < n; i++) { const b = nm(i); if (!TORSO.has(b) || Math.abs(pos[i * 3 + 2] - z) > 2.2) continue; xs.push(pos[i * 3]); ys.push(pos[i * 3 + 1]); }
    if (xs.length > 6) torso.push({ z, x0: pct(xs, .04), x1: pct(xs, .96), y0: pct(ys.slice(), .05), y1: pct(ys, .95) }); }
  for (let x = 12; x <= 70; x += 2) { const ys = [], zs = []; for (let i = 0; i < n; i++) { const b = nm(i); if (!/RightArm|RightForeArm|RightShoulder|RightHand$/.test(b) || Math.abs(pos[i * 3] - x) > 2.2) continue; ys.push(pos[i * 3 + 1]); zs.push(pos[i * 3 + 2]); }
    if (ys.length > 6) arm.push({ x, y0: pct(ys.slice(), .06), y1: pct(ys, .94), z0: pct(zs.slice(), .06), z1: pct(zs, .94) }); }
  for (let z = 106; z >= 8; z -= 2) { const xs = [], ys = []; for (let i = 0; i < n; i++) { const b = nm(i); if (!/RightUpLeg|RightLeg|RightFoot/.test(b) || Math.abs(pos[i * 3 + 2] - z) > 2.2 || pos[i * 3] < -1) continue; xs.push(pos[i * 3]); ys.push(pos[i * 3 + 1]); }
    if (xs.length > 6) leg.push({ z, x0: pct(xs.slice(), .06), x1: pct(xs, .94), y0: pct(ys.slice(), .06), y1: pct(ys, .94) }); }
  const sm = (L, keys) => L.map((e, i) => { const o = Object.assign({}, e); for (const k of keys) { const a = L[Math.max(0, i - 1)][k], c = L[Math.min(L.length - 1, i + 1)][k]; o[k] = (a + e[k] * 2 + c) / 4; } return o; });
  const foot = (() => { const xs = [], ys = [], zs = []; for (let i = 0; i < n; i++) if (/RightFoot|RightToe/.test(nm(i))) { xs.push(pos[i * 3]); ys.push(pos[i * 3 + 1]); zs.push(pos[i * 3 + 2]); } return { x0: pct(xs.slice(), .03), x1: pct(xs, .97), y0: pct(ys.slice(), .02), y1: pct(ys, .98), z1: pct(zs, .98) }; })();
  const s2 = (L, k) => sm(sm(sm(L, k), k), k);
  PROF = { torso: s2(torso, ['x0', 'x1', 'y0', 'y1']), arm: s2(arm, ['y0', 'y1', 'z0', 'z1']), leg: s2(leg, ['x0', 'x1', 'y0', 'y1']), foot };
  return PROF;
}
function lerpProf(L, key, v, field) {
  const asc = L[0][key] < L[L.length - 1][key], first = asc ? L[0] : L[L.length - 1], last = asc ? L[L.length - 1] : L[0];
  if (v <= first[key]) return first[field]; if (v >= last[key]) return last[field];
  for (let i = 1; i < L.length; i++) { const a = L[i - 1], b = L[i]; if ((v - a[key]) * (v - b[key]) <= 0) { const t = (v - a[key]) / ((b[key] - a[key]) || 1); return lerp(a[field], b[field], t); } }
  return first[field];
}
const se = (c, s, n) => [Math.sign(c) * Math.pow(Math.abs(c), 2 / n), Math.sign(s) * Math.pow(Math.abs(s), 2 / n)];   // superellipse point
// loft through rings (each an array of [x,y,z]); skip(i, j) drops a quad (openings); ends closed with fans unless told not to
function loftGeo(rings, capA = true, capB = true, skip) {
  const R = rings.length, C = rings[0].length, pos = [], idx = [];
  for (const r of rings) for (const p of r) pos.push(...p);
  for (let i = 0; i < R - 1; i++) for (let j = 0; j < C; j++) { if (skip && skip(i, j)) continue; const a = i * C + j, b = i * C + (j + 1) % C, c = (i + 1) * C + j, d = (i + 1) * C + (j + 1) % C; idx.push(a, c, b, b, c, d); }
  const cap = (ri, flip) => { const r = rings[ri], cc = [0, 0, 0]; for (const p of r) for (let k = 0; k < 3; k++) cc[k] += p[k] / C; const ci = pos.length / 3; pos.push(...cc); for (let j = 0; j < C; j++) { const a = ri * C + j, b = ri * C + (j + 1) % C; if (flip) idx.push(ci, a, b); else idx.push(ci, b, a); } };
  if (capA) cap(0, true); if (capB) cap(R - 1, false);
  const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals(); return g;
}
function outward(g, centreFn) { const p = g.attributes.position, nn = g.attributes.normal; let s = 0; const v = V(), c = V(); for (let i = 0; i < p.count; i += 5) { v.fromBufferAttribute(p, i); centreFn(v, c); s += V(nn.getX(i), nn.getY(i), nn.getZ(i)).dot(v.sub(c)); } if (s < 0) { const ix = g.index.array; for (let t = 0; t < ix.length; t += 3) { const tmp = ix[t + 1]; ix[t + 1] = ix[t + 2]; ix[t + 2] = tmp; } g.computeVertexNormals(); } return g; }
/* outfit(K, spec): spec = {
     torso: { w(z), d(z), n (number | fn z), off(th, z) cm, dy(z), ab(z) -> [a, b, cx, cy] (own profile), z0, z1, step, seg, skip(th, z) },
     arm: { r(x), n, off(th, x), x0, x1 }, leg: { r(z), n, off(th, z), z0, z1 }, boot: { len, h, toe, n, sole, off } | false,
     mat: { torso, arm, leg, boot } each { slot, rough, metal, pat }, glove: slot }
   th: torso/leg 0 = +X (character's right), PI/2 = front (+Y); arm 0 = front (+Y), PI/2 = up (+Z). */
function outfit(K, spec) {
  const PR = profiles(), sp = spec;
  K.remove((v, p, b) => !/Hand/.test(b)); K.visor = false; K.noBase = true;
  K.slots((v, p, b) => /Hand/.test(b) ? [sp.glove ?? S.D, .6, .05, 1 + 8] : undefined);
  const T0 = sp.torso || {}, A = sp.arm || {}, L = sp.leg || {};
  const tSec = z => { if (T0.ab) return T0.ab(z); const x0 = lerpProf(PR.torso, 'z', z, 'x0'), x1 = lerpProf(PR.torso, 'z', z, 'x1'), y0 = lerpProf(PR.torso, 'z', z, 'y0'), y1 = lerpProf(PR.torso, 'z', z, 'y1');
    return [(x1 - x0) / 2 * (T0.w ? T0.w(z) : 1), (y1 - y0) / 2 * (T0.d ? T0.d(z) : 1), (x0 + x1) / 2, (y0 + y1) / 2 + (T0.dy ? T0.dy(z) : 0)]; };
  const tN = z => typeof T0.n === 'function' ? T0.n(z) : (T0.n ?? 2.4);
  const torsoPt = (th, z, extra = 0) => { const [a, b, cx, cy] = tSec(z), [ex, ey] = se(Math.cos(th), Math.sin(th), tN(z)), o = (T0.off ? T0.off(th, z) : 0) + extra, k = 1 + o / Math.max(4, Math.hypot(a * ex, b * ey)); return [cx + a * ex * k, cy + b * ey * k, z]; };
  const aSec = x => { const y0 = lerpProf(PR.arm, 'x', x, 'y0'), y1 = lerpProf(PR.arm, 'x', x, 'y1'), z0 = lerpProf(PR.arm, 'x', x, 'z0'), z1 = lerpProf(PR.arm, 'x', x, 'z1'), k = A.r ? A.r(x) : 1; return [(y1 - y0) / 2 * k, (z1 - z0) / 2 * k, (y0 + y1) / 2, (z0 + z1) / 2]; };
  const armPt = (s, th, x, extra = 0) => { const [a, b, cy, cz] = aSec(x), [ey, ez] = se(Math.cos(th), Math.sin(th), A.n ?? 2.3), o = (A.off ? A.off(th, x) : 0) + extra, k = 1 + o / Math.max(3, Math.hypot(a * ey, b * ez)); return [s * x, cy + a * ey * k, cz + b * ez * k]; };
  const lSec = z => { const x0 = lerpProf(PR.leg, 'z', z, 'x0'), x1 = lerpProf(PR.leg, 'z', z, 'x1'), y0 = lerpProf(PR.leg, 'z', z, 'y0'), y1 = lerpProf(PR.leg, 'z', z, 'y1'), k = L.r ? L.r(z) : 1; return [(x1 - x0) / 2 * k, (y1 - y0) / 2 * k, (x0 + x1) / 2, (y0 + y1) / 2]; };
  const legPt = (s, th, z, extra = 0) => { const [a, b, cx, cy] = lSec(z), [ex, ey] = se(Math.cos(th), Math.sin(th), L.n ?? 2.3), o = (L.off ? L.off(th, z) : 0) + extra, k = 1 + o / Math.max(3, Math.hypot(a * ex, b * ey)); return [s * (cx + a * ex * k), cy + b * ey * k, z]; };
  K.body = { torsoPt, armPt, legPt, tSec, aSec, lSec };
  // torso
  const tz0 = T0.z0 ?? 88, tz1 = T0.z1 ?? 158, seg = T0.seg ?? 28, st = T0.step ?? 2.5, zs = []; for (let z = tz0; z <= tz1 + .01; z += st) zs.push(Math.min(z, tz1));
  const rings = zs.map(z => Array.from({ length: seg }, (_, j) => torsoPt(j / seg * Math.PI * 2, z)));
  const skip = T0.skip ? (i, j) => T0.skip((j + .5) / seg * Math.PI * 2, (zs[i] + zs[i + 1]) / 2) : null;
  K.add(outward(loftGeo(rings, T0.capA !== false, T0.capB !== false, skip), (v, c) => { const s = tSec(v.z); c.set(s[2], s[3], v.z); }), Object.assign({ slot: S.P, rough: .55, metal: .1, pat: true }, (sp.mat || {}).torso, { bones: T0.bones || ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'LeftShoulder', 'RightShoulder'] }));
  K.mirror(s => {
    const side = s < 0 ? 'Left' : 'Right';
    const ax0 = A.x0 ?? 13, ax1 = A.x1 ?? 66, aseg = A.seg ?? 18, ar = []; for (let x = ax0; x <= ax1 + .01; x += (A.step ?? 2.5)) ar.push(Array.from({ length: aseg }, (_, j) => armPt(s, j / aseg * Math.PI * 2, x)));
    K.add(outward(loftGeo(ar), (v, c) => { const q = aSec(Math.abs(v.x)); c.set(v.x, q[2], q[3]); }), Object.assign({ slot: S.P, rough: .55, metal: .1, pat: true }, (sp.mat || {}).arm, { bones: ['Spine2', side + 'Shoulder', side + 'Arm', side + 'ForeArm', side + 'Hand'] }));
    const lz0 = L.z0 ?? 104, lz1 = L.z1 ?? 13, lseg = L.seg ?? 20, lr = []; for (let z = lz0; z >= lz1 - .01; z -= (L.step ?? 3)) lr.push(Array.from({ length: lseg }, (_, j) => legPt(s, j / lseg * Math.PI * 2, z)));
    K.add(outward(loftGeo(lr), (v, c) => { const q = lSec(v.z); c.set(s * q[2], q[3], v.z); }), Object.assign({ slot: S.S, rough: .6, metal: .05, pat: true }, (sp.mat || {}).leg, { bones: ['Hips', side + 'UpLeg', side + 'Leg', side + 'Foot'] }));
    if (sp.boot !== false) {
      const Bt = Object.assign({ len: 1, h: 1, n: 3, toe: 1, sole: 1.6, w: 1 }, sp.boot || {}), f = PR.foot, fx = (f.x0 + f.x1) / 2, hw = (f.x1 - f.x0) / 2 * Bt.w, br = [], yA = f.y0 - .8, yB = lerp(f.y0, f.y1, Bt.len) + .8;
      for (let i = 0; i <= 14; i++) { const t = i / 14, y = lerp(yA, yB, t), top = lerp(Bt.h * 19, 5.6 * Bt.toe, smooth(.25, .95, t)), w = hw * (t > .8 ? lerp(1, .7, Math.pow((t - .8) / .2, 1.5)) : t < .1 ? lerp(.86, 1, t / .1) : 1), zb = Bt.sole * .6;
        br.push(Array.from({ length: 16 }, (_, j) => { const th = j / 16 * Math.PI * 2, [ex, ez] = se(Math.cos(th), Math.sin(th), Bt.n), o = Bt.off ? Bt.off(th, t) : 0; return [s * fx + ex * (w + o), y, zb + (top - zb) / 2 + ez * ((top - zb) / 2 + o)]; })); }
      const fb = [side + 'Foot', side + 'ToeBase', side + 'Leg'];
      K.add(outward(loftGeo(br), (v, c) => c.set(s * fx, v.y, 8)), Object.assign({ slot: S.D, rough: .5, metal: .2, pat: false }, (sp.mat || {}).boot, { bones: fb }));
      K.add(xf(P.cyl(hw * 1.02, hw * 1.04, Bt.sole, 18), { s: [1, (yB - yA) / 2 / hw + .02, 1], p: [s * fx, (yA + yB) / 2, Bt.sole / 2] }), { slot: (sp.mat || {}).sole ?? S.D, rough: .85, metal: 0, bones: fb });
      K.body.boot = { fx, hw, yA, yB, top: Bt.h * 19 };
    }
  });
  return K.body;
}
// a patch of an outfit surface, offset outward and given thickness: region 'torso' (th, z) | 'arm' (th, x, side) | 'leg' (th, z, side)
function patch(K, region, o) {
  const nu = o.nu ?? 10, nv = o.nv ?? 8, rows = [];
  for (let i = 0; i <= nv; i++) { const v = lerp(o.v0, o.v1, i / nv), row = []; for (let j = 0; j <= nu; j++) { const u = lerp(o.u0, o.u1, j / nu), off = (o.off ?? .5) + (o.offFn ? o.offFn(u, v) : 0);
    row.push(region === 'torso' ? K.body.torsoPt(u, v, off) : region === 'arm' ? K.body.armPt(o.side, u, v, off) : K.body.legPt(o.side, u, v, off)); } rows.push(row); }
  let g = gridGeo(rows, !!o.flip); const nn = g.attributes.normal; let sgn = 0; const p = g.attributes.position;
  for (let i = 0; i < p.count; i += 3) { const c = region === 'torso' ? K.body.tSec(p.getZ(i)) : null; const out = region === 'torso' ? V(p.getX(i) - c[2], p.getY(i) - c[3], 0) : region === 'arm' ? V(0, p.getY(i) - K.body.aSec(Math.abs(p.getX(i)))[2], p.getZ(i) - K.body.aSec(Math.abs(p.getX(i)))[3]) : V(p.getX(i) - o.side * K.body.lSec(p.getZ(i))[2], p.getY(i) - K.body.lSec(p.getZ(i))[3], 0); sgn += out.dot(V(nn.getX(i), nn.getY(i), nn.getZ(i))); }
  if (sgn < 0) g = gridGeo(rows, !o.flip);
  return K.add(thicken(g, o.t ?? .6), Object.assign({ slot: S.S, rough: .5, metal: .1 }, o.mat));
}
// team colour zone on every skin: emissive band round the left upper arm + a chest light, in the player's / team's colour
function band(c, axis, ry, rz, w, t, seg = 28) {   // flat ring band around an axis ('x' or 'z') through c, radii ry/rz (inner), width w, thickness t
  const rings = [[-w / 2, 0], [-w / 2, t], [w / 2, t], [w / 2, 0]].map(([d, o]) => Array.from({ length: seg }, (_, j) => { const a = j / seg * Math.PI * 2, u = Math.cos(a) * (ry + o), v = Math.sin(a) * (rz + o); return axis === 'x' ? [c[0] + d, c[1] + u, c[2] + v] : [c[0] + u, c[1] + v, c[2] + d]; }));
  rings.push(rings[0]); return loftGeo(rings, false, false);
}
function teamZone(K, o = {}) {
  const x = o.x ?? 25;
  if (K.body && o.useBody !== false) { const [a, b, cy, cz] = K.body.aSec(x); for (const s of o.both === false ? [-1] : [-1, 1]) K.add(band([s * x, cy, cz], 'x', a + (o.armOff ?? .25), b + (o.armOff ?? .25), o.bw ?? 9, .9), { slot: 8, rough: .2, metal: 0, bones: [s < 0 ? 'LeftArm' : 'RightArm'] }); }
  else { const A = profiles().arm, ry = (lerpProf(A, 'x', x, 'y1') - lerpProf(A, 'x', x, 'y0')) / 2, rz = (lerpProf(A, 'x', x, 'z1') - lerpProf(A, 'x', x, 'z0')) / 2, cy = (lerpProf(A, 'x', x, 'y1') + lerpProf(A, 'x', x, 'y0')) / 2, cz = (lerpProf(A, 'x', x, 'z1') + lerpProf(A, 'x', x, 'z0')) / 2;
    for (const s of o.both === false ? [-1] : [-1, 1]) K.add(band([s * x, cy, cz], 'x', ry + (o.armOff ?? .5), rz + (o.armOff ?? .5), o.bw ?? 9, .9), { slot: 8, rough: .2, metal: 0, bones: [s < 0 ? 'LeftArm' : 'RightArm'] }); }
  if (o.chest !== false) { const h = K.hit([o.cx ?? 0, 45, o.cz ?? 143], [0, -1, 0], true); if (h) K.add(xf(P.rbox(o.cw ?? 15, 1.2, o.ch ?? 4.2, .9, 1), { r: rot(h.n, V(0, 1, 0)), p: h.p.addScaledVector(h.n, .25).toArray() }), { slot: 8, rough: .2, metal: 0, bones: ['Spine2', 'Spine1'] }); }
  if (o.back !== false) { const h = K.hit([0, -45, o.bz ?? 150], [0, 1, 0], true); if (h) K.add(xf(P.rbox(o.bwid ?? 9, 1.2, 1.8, .6, 1), { r: rot(h.n, V(0, -1, 0)), p: h.p.addScaledVector(h.n, .25).toArray() }), { slot: 8, rough: .2, metal: 0, bones: ['Spine2'] }); }
}

/* ======================================================================================= this module's 7 skins (own outfits) */
const bell = (x, c, w) => Math.exp(-Math.pow((x - c) / w, 2));
Object.assign(BUILD, {
  /* ------------------------------------------------------------------ Standard Trooper: the soldier itself + team zone */
  std(K) { K.pattern({ body: false }); emblemPatch(K); teamZone(K, { useBody: false, cx: 8.5, cz: 141 }); },

  /* ------------------------------------------------------------------ Heavy Juggernaut: slab plate armour */
  jugg(K) {
    const [hx, hy] = HEAD_C;
    const plate = z => { const f = ((z - 92) / 8.5) % 1; return f < .14 ? -.7 : 0; };
    outfit(K, {
      torso: { n: z => z > 118 ? 3.6 : 2.8, w: z => z > 120 ? 1.06 : .97, d: z => z > 122 ? 1.08 : 1, off: (th, z) => (z < 122 ? plate(z) : 0) + (z > 124 && z < 150 && Math.sin(th) > .2 ? 1.2 * Math.sin(th) : 0) },
      arm: { n: 3, r: x => x < 40 ? 1.04 : 1.12, off: (th, x) => (x > 42 && x < 62 ? .6 : 0) + (Math.abs(((x - 14) / 7) % 1) < .12 ? -.4 : 0) },
      leg: { n: 3, r: z => z > 60 ? 1.04 : 1.1, off: (th, z) => Math.abs(((z - 14) / 9) % 1) < .1 ? -.4 : 0 },
      boot: { len: 1.08, h: 1.3, n: 4, sole: 2.6, toe: 1.25 },
      mat: { torso: { slot: S.P, rough: .42, metal: .75 }, arm: { slot: S.P, rough: .42, metal: .75 }, leg: { slot: S.X, rough: .5, metal: .55 }, boot: { slot: S.D, rough: .45, metal: .6 }, sole: S.D }, glove: S.D,
    });
    // bevelled helmet: superellipse shell, recessed visor slit, cheek plates, chin guard, crest, side vents
    const hR = [], HC = [hx, hy + .6, 166.5];
    for (let i = 0; i <= 10; i++) { const t = i / 10, z = lerp(150, 184.5, t), k = Math.sqrt(Math.max(0, 1 - Math.pow((t - .42) / .64, 2))), ring = [];
      for (let j = 0; j < 20; j++) { const th = j / 20 * Math.PI * 2, [ex, ey] = se(Math.cos(th), Math.sin(th), 3.2); ring.push([HC[0] + ex * 11 * k, HC[1] + ey * 12.8 * k + (ey > 0 ? 1.2 * k : 0), z]); } hR.push(ring); }
    K.add(outward(loftGeo(hR), (v, c) => c.set(HC[0], HC[1], v.z)), { slot: S.P, rough: .4, metal: .75, bone: 'Head', pat: true });
    K.add(xf(P.rbox(18.5, 2.4, 4.6, 1.1, 1), { p: [hx, HC[1] + 13.2, 170.5] }), { slot: S.D, rough: .3, metal: .6, bone: 'Head' });
    K.add(xf(P.rbox(16.5, 1.2, 1.6, .5, 1), { p: [hx, HC[1] + 14.1, 170.6] }), { slot: S.G, rough: .1, metal: 0, bone: 'Head' });
    for (const s of [-1, 1]) { K.add(xf(P.rbox(3.4, 11, 11, 1.3, 1), { r: [0, 0, s * 14], p: [s * 10.6, HC[1] + 5, 163.5] }), { slot: S.S, rough: .45, metal: .55, bone: 'Head' });
      for (let k = 0; k < 3; k++) K.add(xf(P.box(.6, 4.6, 1), { r: [0, 0, s * 14], p: [s * 12.3, HC[1] + 3 + k * 2.2, 162] }), { slot: S.D, rough: .5, metal: .4, bone: 'Head' }); }
    K.add(xf(P.rbox(13, 4, 5.5, 1.6, 1), { p: [hx, HC[1] + 11.6, 157.6] }), { slot: S.S, rough: .45, metal: .55, bone: 'Head' });
    for (let i = -2; i <= 2; i++) K.add(xf(P.box(1.1, 1, 3.6), { p: [i * 2.4, HC[1] + 13.7, 157.8] }), { slot: S.M, rough: .4, metal: .9, bone: 'Head' });
    K.add(xf(P.rbox(3.6, 22, 4.4, 1.5, 1), { r: [-8, 0, 0], p: [hx, HC[1] - 1.4, 184.2] }), { slot: S.S, rough: .45, metal: .5, bone: 'Head' });
    K.add(xf(P.cyl(6.4, 7.2, 10, 14), { p: [hx, hy - 2.2, 152.5] }), { slot: S.D, rough: .6, metal: .3, bone: 'Head' });
    // gorget, layered pauldrons, chest reactor (team light), back power cell, gauntlet rims, knee guards, shin plates
    K.add(xf(P.lathe([[12.5, -3], [15.2, 0], [14.8, 4.5], [11.6, 7.5]], 24), { s: [1, .95, 1], p: [0, -4, 150.5] }), { slot: S.P, rough: .42, metal: .75, bones: ['Spine2', 'Neck'], pat: true });
    K.mirror(s => {
      const side = s < 0 ? 'Left' : 'Right', arm = K.bp(side + 'Arm');
      for (let i = 0; i < 3; i++) { const g = new T.SphereGeometry(1, 12, 5, 0, Math.PI * 2, 0, Math.PI * .5); xf(g, { s: [13.2 - i * 1.6, 12.6 - i * 1.4, 6.5 - i * .5], p: [arm.x + s * (1.5 + i * 4.2), arm.y, 155.5 - i * 1.7] }); K.add(thicken(g, .9, true), { slot: i === 0 ? S.S : S.P, rough: .4, metal: .8, bone: side + 'Arm', pat: true }); }
      const [ga, gb, gy, gz] = K.body.aSec(58); K.add(band([s * 58, gy, gz], 'x', ga * 1.12 + .6, gb * 1.12 + .6, 1.6, .9), { slot: S.S, rough: .4, metal: .6, bone: side + 'ForeArm' });
      const kh = K.hit([s * 9.8, 45, 59], [0, -1, 0], true); if (kh) K.add(xf(new T.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI * .5), { s: [6.6, 7.6, 3.4], r: rot(kh.n), p: kh.p.addScaledVector(kh.n, -.8).toArray() }), { slot: S.S, rough: .4, metal: .7 });
      patch(K, 'leg', { side: s, u0: Math.PI * .3, u1: Math.PI * .7, v0: 46, v1: 22, off: .3, t: 1, mat: { slot: S.P, rough: .42, metal: .75, pat: true } });
    });
    const cs = K.surf([0, 45, 140], [0, -1, 0], 0, true);
    K.add(xf(P.rbox(24, 4.4, 18, 2, 2), { p: [0, cs.y + 1.4, 140] }), { slot: S.P, rough: .4, metal: .8, bones: ['Spine2', 'Spine1'], pat: true });
    K.add(xf(P.cyl(4.2, 4.2, 1.6, 18), { r: [90, 0, 0], p: [0, cs.y + 4.2, 141] }), { slot: 8, rough: .2, metal: 0, bones: ['Spine2'] });
    for (let i = 0; i < 5; i++) K.add(xf(P.box(2.2, .6, 14.6), { r: [0, 35, 0], p: [-10 + i * 5, cs.y + 3.75, 140] }), { slot: S.S, rough: .5, metal: .3, bones: ['Spine2', 'Spine1'] });
    const bk = K.surf([0, -45, 138], [0, 1, 0], 0, true);
    K.add(xf(P.rbox(22, 7, 20, 2, 2), { p: [0, bk.y - 3, 138] }), { slot: S.D, rough: .5, metal: .7, bone: 'Spine2' });
    for (const x of [-6, 0, 6]) K.add(xf(P.cyl(1.6, 1.6, 15, 8), { p: [x, bk.y - 6.6, 138] }), { slot: S.G, rough: .2, metal: 0, bone: 'Spine2' });
    teamZone(K, { x: 37, cz: 128, cw: 12, ch: 3 });
    emblemPatch(K, { c: [-27, -6, 200], r: 4 });
  },

  /* ------------------------------------------------------------------ Xeno Alien: teal chitin exoskeleton, yellow eyes */
  xeno(K) {
    const [hx, hy] = HEAD_C;
    outfit(K, {
      torso: { n: 2.1, w: z => (1 - .2 * bell(z, 108, 9)) * (z > 124 && z < 150 ? 1.04 : 1), d: z => (1 - .14 * bell(z, 108, 9)) * .95,
        off: (th, z) => { const ribs = z > 96 && z < 122 ? .9 * Math.max(0, Math.cos((z - 96) / 5.2 * Math.PI)) : 0, keel = z > 120 ? 1.6 * Math.exp(-Math.pow((th - Math.PI / 2) / .22, 2)) : 0, chit = z > 124 ? .7 * Math.max(0, Math.cos(th * 6)) : 0; return ribs + keel + chit; } },
      arm: { n: 2, r: x => x < 40 ? .84 : .8, off: (th, x) => (x > 42 ? .8 * Math.max(0, Math.cos(th * 3)) : 0) + (Math.abs(((x - 13) / 6) % 1) < .15 ? -.35 : 0) },
      leg: { n: 2, r: z => z > 60 ? .88 : .82, off: (th, z) => (z < 55 ? .7 * Math.max(0, Math.cos(th * 3 + .5)) : 0) + (Math.abs(((z - 13) / 7) % 1) < .14 ? -.35 : 0) },
      boot: { len: 1.12, h: .7, n: 2.2, toe: .6, sole: 1 },
      mat: { torso: { slot: S.P, rough: .3, metal: .15 }, arm: { slot: S.S, rough: .28, metal: .2 }, leg: { slot: S.S, rough: .28, metal: .2 }, boot: { slot: S.X, rough: .3, metal: .2 }, sole: S.D }, glove: S.X,
    });
    // chitin shoulder carapaces + knee spikes + toe claws
    K.mirror(s => { const side = s < 0 ? 'Left' : 'Right';
      patch(K, 'arm', { side: s, u0: Math.PI * .15, u1: Math.PI * .95, v0: 14, v1: 30, off: .3, t: 1.2, offFn: (u, v) => 1.6 * Math.sin((v - 14) / 16 * Math.PI), mat: { slot: S.P, rough: .3, metal: .15, pat: true } });
      const kp = K.body.legPt(s, Math.PI / 2, 58, 0); K.add(xf(P.cone(2.2, 7, 8), { r: [-70, 0, 0], p: [kp[0], kp[1] + 2.4, kp[2] + 1.5] }), { slot: S.P, rough: .3, metal: .15 });
      const ep = K.body.armPt(s, Math.PI * 1.5, 44, 0); K.add(xf(P.cone(1.6, 6, 6), { r: [0, s * 90, 0], p: [ep[0], ep[1] - 1.2, ep[2] - .2] }), { slot: S.P, rough: .3, metal: .15 });
      const bt = K.body.boot; for (const dx of [-2.6, 0, 2.6]) K.add(xf(P.cone(1.1, 3.4, 6), { r: [-82, 0, 0], p: [s * bt.fx + dx, bt.yB - .6, 2.6] }), { slot: S.L, rough: .3, metal: 0 });
    });
    // elongated skull sweeping back, ridge, slanted yellow eyes, mandibles, mouth slit, neck
    const skull = new T.SphereGeometry(1, 26, 18); displace(skull, v => { if (v.y < 0) { v.y *= 2.5; v.z += -v.y * .5; } else v.y *= 1.05; if (v.z < -.2) { v.x *= .72; v.y *= .9; } v.x *= 1 - Math.max(0, -v.y - .6) * .22; });
    xf(skull, { s: [9, 10.4, 10.2], p: [hx, hy + 2.4, 166.5] }); K.add(skull, { slot: S.P, rough: .3, metal: .15, bone: 'Head', pat: true });
    const ridge = []; for (let i = 0; i <= 10; i++) { const t = i / 10, y = lerp(9, -38, t), z = 172 + t * 22; const h = K.hit([0, y, z + 30], [0, 0, -1], true); if (h) ridge.push(h.p.addScaledVector(h.n, -.5).toArray()); }
    if (ridge.length > 3) K.add(sc(P.tube(ridge, 1.7, 22, 5, t => 1.2 - t * .75), .7, 1, 1.25), { slot: S.S, rough: .3, metal: .2, bone: 'Head' });
    for (const s of [-1, 1]) {
      K.add(xf(P.ell(4.6, 2, 2.1, 16, 10), { r: [0, -s * 10, s * -30], p: [s * 4.7, hy + 11.3, 166.8] }), { slot: S.G, rough: .05, metal: 0, bone: 'Head' });
      K.add(xf(P.ell(1.1, 1, 2, 8, 6), { r: [0, -s * 10, s * -30], p: [s * 4.9, hy + 12.9, 166.9] }), { slot: S.D, rough: .05, metal: .2, bone: 'Head' });
      K.add(xf(P.ell(5.4, 1.4, 2.6, 12, 8), { r: [0, -s * 10, s * -30], p: [s * 5, hy + 10.5, 167.3] }), { slot: S.S, rough: .3, metal: .2, bone: 'Head' });
      K.add(P.tube([[s * 3.2, hy + 10.4, 160], [s * 4.4, hy + 12.8, 157.4], [s * 2.6, hy + 14.2, 155.6]], .7, 8, 5, t => 1 - t * .7), { slot: S.L, rough: .3, metal: 0, bone: 'Head' });
    }
    K.add(xf(P.ell(3.4, .7, .5, 10, 4), { p: [0, hy + 11.8, 159.4] }), { slot: S.D, rough: .4, metal: 0, bone: 'Head' });
    K.add(xf(P.cyl(4.6, 6.4, 13, 12), { p: [hx, hy - 1.5, 153.5] }), { slot: S.P, rough: .3, metal: .15, bone: 'Head', pat: true });
    // back pipes with glowing tips, dorsal fins
    const bk = K.surf([0, -45, 146], [0, 1, 0], 0, true).y;
    for (const s of [-1, 1]) { K.add(P.tube([[s * 8, bk + 1.5, 146], [s * 10, bk - 6, 152], [s * 12.4, bk - 11.5, 160], [s * 13.6, bk - 13.4, 167]], 2.2, 10, 6, t => 1 - t * .55), { slot: S.S, rough: .3, metal: .2, bone: 'Spine2' }); K.add(xf(P.sph(1.1, 8, 6), { p: [s * 13.6, bk - 13.4, 167.4] }), { slot: S.G, rough: .1, metal: 0, bone: 'Spine2' }); }
    for (let z = 140; z >= 104; z -= 7.5) { const sp = K.surf([0, -45, z], [0, 1, 0], -.6, true); K.add(dorsal(3, 4.4, 1.6, sp.toArray()), { slot: S.S, rough: .3, metal: .2 }); }
    teamZone(K, { cz: 137, cw: 10 });
    emblemPatch(K, { c: [-30, -6, 200], r: 3.8, slot: S.D });
  },

  /* ------------------------------------------------------------------ Mecha Pilot: padded flight suit */
  mecha(K, B, helmet) {
    const [hx, hy] = HEAD_C, HC = [hx, hy - .2, 168];
    outfit(K, {
      torso: { n: 2.5, seg: 22, step: 3, w: z => .98, d: z => .98, off: (th, z) => (Math.abs(Math.cos(th)) < .06 ? -.35 : 0) + (z < 124 && z > 98 ? .35 * Math.max(0, Math.cos((z - 98) / 4.4 * Math.PI)) : 0) },
      arm: { n: 2.2, seg: 14, step: 3, r: x => .95, off: (th, x) => x < 36 ? .55 * Math.max(0, Math.cos((x - 13) / 3.8 * Math.PI)) : (x > 54 ? .5 : 0) },
      leg: { n: 2.2, seg: 16, r: z => .96, off: (th, z) => z > 66 && z < 96 ? .5 * Math.max(0, Math.cos((z - 66) / 4.2 * Math.PI)) : 0 },
      boot: { len: 1.06, h: 1.45, n: 3.4, sole: 2.4, toe: 1.2 },
      mat: { torso: { slot: S.P, rough: .5, metal: .05 }, arm: { slot: S.P, rough: .5, metal: .05 }, leg: { slot: S.P, rough: .5, metal: .05 }, boot: { slot: S.S, rough: .4, metal: .2 }, sole: S.D }, glove: S.D,
    });
    if (helmet) {
      K.add(xf(P.sph(13.2, 22, 16), { s: [1, 1.04, 1], p: HC }), { slot: S.L, rough: .3, metal: .1, bone: 'Head' });
      K.add(thicken(ellBand(HC, [13.25, 13.75, 13.25], 150, 52, 4, 26, 6), .55, true), { slot: S.D, rough: .04, metal: .45, bone: 'Head' });
      K.add(ellBand(HC, [13.9, 14.4, 13.9], 92, 2.2, 20, 20, 1), { slot: S.G, rough: .1, metal: 0, bone: 'Head' });
      K.add(ellBand(HC, [13.9, 14.4, 13.9], 60, 1.6, -9, 16, 1), { slot: S.G, rough: .1, metal: 0, bone: 'Head' });
      for (const s of [-1, 1]) { K.add(xf(P.cyl(4, 4, 3.4, 14), { r: [0, 0, 90], p: [s * 12.6, hy - .4, 166] }), { slot: S.S, rough: .4, metal: .3, bone: 'Head' }); K.add(xf(P.cyl(2.6, 2.6, 3.8, 12), { r: [0, 0, 90], p: [s * 12.8, hy - .4, 166] }), { slot: S.D, rough: .5, metal: .5, bone: 'Head' }); }
      K.add(xf(P.rbox(3, 22, 3.4, 1.2, 1), { r: [-6, 0, 0], p: [hx, hy - 1.6, 181.2] }), { slot: S.S, rough: .4, metal: .2, bone: 'Head' });
      K.add(xf(P.cyl(.35, .55, 12, 5), { r: [0, -12, 0], p: [14.2, hy - 3, 176] }), { slot: S.M, rough: .3, metal: .9, bone: 'Head' });
      K.add(xf(P.sph(.9, 8, 6), { p: [15.4, hy - 3, 182] }), { slot: S.A, rough: .2, metal: 0, bone: 'Head' });
      K.add(xf(P.cyl(6.4, 7.6, 10, 14), { p: [hx, hy - 2.2, 152] }), { slot: S.D, rough: .5, metal: .3, bone: 'Head' });
    } else {
      bareHead(K, { slot: S.D });
      K.add(thicken(ellBand([hx, hy + .5, 166.5], [9.6, 10.6, 11.8], 100, 46, -2, 18, 4), .4, true), { slot: S.D, rough: .06, metal: .4, bone: 'Head' });
      for (const s of [-1, 1]) K.add(xf(P.ell(1.7, .8, 2.3, 10, 6), { p: [s * 3.4, hy + 11.6, 168.5] }), { slot: S.G, rough: .1, metal: 0, bone: 'Head' });
      K.add(P.tube([[-3.2, hy + 11, 162.4], [0, hy + 11.5, 160.9], [3.2, hy + 11, 162.4]], .45, 8, 4), { slot: S.G, rough: .1, metal: 0, bone: 'Head' });
      K.add(xf(new T.SphereGeometry(1, 18, 10, 0, Math.PI * 2, 0, Math.PI * .5), { s: [10.1, 11.1, 9.2], r: [90, 0, 0], p: [hx, hy + .2, 169] }), { slot: S.S, rough: .6, metal: 0, bone: 'Head' });
      for (const s of [-1, 1]) K.add(xf(P.cyl(4.4, 4.4, 3, 16), { r: [0, 0, 90], p: [s * 10.2, hy, 165] }), { slot: S.P, rough: .4, metal: .2, bone: 'Head' });
      goggles(K, { z: 175.5, y: 8.6, tilt: -22, ringR: 10.6, lens: S.A });
      K.add(P.tube([[10.8, hy + 2, 163], [9.6, 4, 159], [5, 10.4, 158.2], [2, 11.2, 158.6]], .45, 8, 4), { slot: S.D, rough: .5, metal: .4, bone: 'Head' });
      K.add(xf(P.cap(.9, 1.4, 2, 6), { r: [0, 90, 0], p: [1.4, 11.4, 158.6] }), { slot: S.G, rough: .2, metal: 0, bone: 'Head' });
    }
    // harness straps over the suit, chest buckle (team light), life-support pack + tanks + status bar, hoses, thigh pockets, knee pads
    for (const s of [-1, 1]) { const pts = []; for (let i = 0; i <= 7; i++) { const z = 158 - i * 8.5, x = s * lerp(9.5, 6, i / 7); pts.push(K.surf([x, 45, z], [0, -1, 0], .7, true).toArray()); } K.add(sc(P.tube(pts, 1.1, 14, 4), 1, .6, 1), { slot: S.D, rough: .6, metal: .1 }); }
    const cs = K.surf([0, 45, 134], [0, -1, 0], 0, true);
    K.add(xf(P.cyl(4, 4, 1.6, 18), { r: [90, 0, 0], p: [0, cs.y + 1.6, 134] }), { slot: S.M, rough: .25, metal: .95 });
    K.add(xf(P.cyl(2.3, 2.3, 1.8, 14), { r: [90, 0, 0], p: [0, cs.y + 2.3, 134] }), { slot: 8, rough: .2, metal: 0 });
    const bk = K.surf([0, -45, 140], [0, 1, 0], 0, true).y;
    K.add(xf(P.rbox(26, 9, 25, 3, 2), { p: [0, bk - 4.2, 139] }), { slot: S.P, rough: .4, metal: .2, bone: 'Spine2', pat: true });
    for (const x of [-8, 8]) K.add(xf(P.cap(3.6, 15, 3, 10), { p: [x, bk - 10.4, 139] }), { slot: S.S, rough: .3, metal: .5, bone: 'Spine2' });
    K.add(xf(P.rbox(9, 1.2, 2.4, .6, 1), { p: [0, bk - 8.9, 146] }), { slot: S.G, rough: .1, metal: 0, bone: 'Spine2' });
    if (helmet) for (const s of [-1, 1]) K.add(P.tube([[s * 8, bk - 6, 151.6], [s * 10.5, bk - 4, 158], [s * 12.4, -10, 162.5], [s * 13.2, -4.5, 163.5]], 1.5, 18, 6, t => 1 + .13 * Math.cos(t * 70)), { slot: S.D, rough: .6, metal: .2, bones: ['Spine2', 'Neck', 'Head'] });
    K.mirror(s => {
      patch(K, 'leg', { side: s, u0: -Math.PI * .28, u1: Math.PI * .22, v0: 86, v1: 70, off: .25, t: 2.2, mat: { slot: S.S, rough: .6, metal: 0 } });
      patch(K, 'leg', { side: s, u0: Math.PI * .28, u1: Math.PI * .72, v0: 63, v1: 52, off: .3, t: 1.4, mat: { slot: S.D, rough: .5, metal: .2 } });
    });
    for (const u of [0, Math.PI]) patch(K, 'torso', { u0: u - .16, u1: u + .16, v0: 95, v1: 128, nu: 3, nv: 8, off: .2, t: .35, mat: { slot: S.S, rough: .45, metal: .05 } });
    patch(K, 'torso', { u0: Math.PI * .485, u1: Math.PI * .515, v0: 104, v1: 152, nu: 1, nv: 10, off: .25, t: .3, mat: { slot: S.D, rough: .4, metal: .4 } });
    K.mirror(s => { patch(K, 'arm', { side: s, u0: Math.PI * .2, u1: Math.PI * .8, v0: 13, v1: 20.5, nu: 8, nv: 3, off: .2, t: .5, mat: { slot: S.S, rough: .45, metal: .05 } });
      const [a, b, cy, cz] = K.body.aSec(56); K.add(band([s * 56, cy, cz], 'x', a + .2, b + .2, 2, .5), { slot: S.S, rough: .45, metal: .05, bone: (s < 0 ? 'Left' : 'Right') + 'ForeArm' }); });
    { const [a, b, cx, cy] = K.body.tSec(101); K.add(band([cx, cy, 101], 'z', a + .3, b + .3, 3.4, .8), { slot: S.D, rough: .5, metal: .2, bones: ['Hips', 'Spine'] }); const bs = K.surf([0, 45, 101], [0, -1, 0], 0, true); K.add(xf(P.rbox(6, 1.2, 4.4, .6, 1), { p: [0, bs.y + .5, 101] }), { slot: S.M, rough: .3, metal: .9 }); }
    { const [a, b, cx, cy] = K.body.tSec(155); K.add(band([cx, cy, 154.5], 'z', a * .82, b * .82, 3, 1.2), { slot: S.S, rough: .45, metal: .1, bones: ['Spine2', 'Neck'] }); }
    teamZone(K, { cz: 147, cw: 10, ch: 2.6 });
    emblemPatch(K, { r: 4.4, slot: S.A });
  },

  /* ------------------------------------------------------------------ Banana Suit: full costume */
  banana(K) {
    const R = [[76, 18.2], [82, 17.8], [88, 17.8], [100, 18.8], [116, 19.5], [132, 19.3], [146, 18], [158, 16], [168, 14.6], [176, 13.2], [182, 11.4]];
    const Rz = z => { if (z <= R[0][0]) return R[0][1]; for (let i = 1; i < R.length; i++) if (z <= R[i][0]) return lerp(R[i - 1][1], R[i][1], (z - R[i - 1][0]) / (R[i][0] - R[i - 1][0])); return R[R.length - 1][1]; };
    const axisY = z => -4 + Math.pow(Math.max(0, z - 95) / 90, 2) * 7, EY = .7;
    const hole = (th, z) => z > 159 && z < 178 && Math.abs(th - Math.PI / 2) < .62 * Math.sqrt(Math.max(0, 1 - Math.pow((z - 168.5) / 9.5, 2)));
    const hem = th => 82 + 2.6 * Math.cos(th * 4 + .4);
    outfit(K, {
      torso: { ab: z => [Rz(z), Rz(z) * EY, 0, axisY(z)], n: 2, z0: 80, z1: 182, step: 2, seg: 30, off: (th, z) => Rz(z) * .055 * Math.cos(th * 5 + .6) + (z < 84 ? Math.max(0, hem(th) - z) * -2.2 : 0), skip: hole, capA: false },
      arm: { n: 2, r: x => 1.02 }, leg: { n: 2.2, r: z => .96 },
      boot: { len: 1.15, h: .85, n: 2.1, toe: 1.5, sole: 1.6, w: 1.08 },
      mat: { torso: { slot: S.P, rough: .5, metal: 0 }, arm: { slot: S.P, rough: .5, metal: 0 }, leg: { slot: S.S, rough: .8, metal: 0, pat: false }, boot: { slot: S.A, rough: .55, metal: .05 }, sole: S.D }, glove: S.D,
    });
    // inside of the costume: a dark hood lining with the pilot's face (visor eyes) set back in the opening, a rim round the hole
    K.add(xf(P.ell(9.2, 9.4, 10.6, 18, 12), { p: [0, axisY(168) + 6.5, 168.5] }), { slot: S.D, rough: .7, metal: 0, bone: 'Head' });
    { const fy = axisY(168) + 6.5 + 9.2; K.add(xf(P.ell(7.6, 2.6, 8.6, 16, 10), { p: [0, fy - 1.8, 168.5] }), { slot: S.X, rough: .6, metal: 0, bone: 'Head' });
      for (const s of [-1, 1]) { K.add(xf(P.sph(2.2, 12, 8), { p: [s * 2.8, fy + .2, 171.2] }), { slot: S.L, rough: .15, metal: 0, bone: 'Head' }); K.add(xf(P.sph(1.05, 8, 6), { p: [s * 2.8 + s * .35, fy + 1.9, 170.6] }), { slot: S.D, rough: .1, metal: 0, bone: 'Head' }); }
      K.add(P.tube([[-3.8, fy + .3, 165.6], [-1.8, fy + 1, 163.7], [0, fy + 1.15, 163.2], [1.8, fy + 1, 163.7], [3.8, fy + .3, 165.6]], .75, 12, 5), { slot: S.D, rough: .5, metal: 0, bone: 'Head' }); }
    const rim = []; for (let i = 0; i <= 40; i++) { const a = i / 40 * Math.PI * 2, z = 168.5 + Math.sin(a) * 9.6, th = Math.PI / 2 + Math.cos(a) * .62 * Math.sqrt(Math.max(0, 1 - Math.pow((z - 168.5) / 9.6, 2))); rim.push(V(...K.body.torsoPt(th, z, .1))); }
    K.add(new T.TubeGeometry(new T.CatmullRomCurve3(rim, true), 40, .8, 5, true), { slot: S.L, rough: .5, metal: 0, bone: 'Head' });
    // tapering tip with ridges, brown stem
    const tip = P.lathe([[12.2, 0], [11.4, 3], [9.6, 6.4], [7, 9.4], [4.6, 11.6], [2.9, 12.8], [2.3, 13.2]], 20);
    displace(tip, v => { const th = Math.atan2(v.y, v.x), k = 1 + .055 * Math.cos(th * 5 + .6); v.x *= k; v.y *= k * EY; v.y += Math.pow(v.z / 16, 2) * 3.6; });
    xf(tip, { p: [0, axisY(182), 181] }); K.add(tip, { slot: S.P, rough: .5, metal: 0, bone: 'Head', pat: true });
    const sy = axisY(182) + 2.6; K.add(xf(P.cyl(2.2, 2.5, 2.2, 10), { p: [0, sy, 194.3] }), { slot: S.D, rough: .8, metal: 0, bone: 'Head' });
    K.add(P.tube([[0, sy, 194.8], [0, sy + .8, 197.2], [0, sy + 2.3, 198.8], [0, sy + 4.2, 199.4]], 1.7, 10, 8, t => 1 - t * .2), { slot: S.D, rough: .85, metal: 0, bone: 'Head' });
    // brown "ripe" speckles are the pattern; chest sticker = emblem (oval), team colour on the sleeves
    const st = K.surf([0, 45, 130], [0, -1, 0], 0, true);
    emblemPatch(K, { c: [0, st.y + 10, 130], dir: [0, -1, 0], r: 6.4, slot: S.A, bones: ['Spine1', 'Spine2', 'Spine'], off: .45 });
    teamZone(K, { x: 30, cz: 150, cw: 9, ch: 2.4 });
  },

  /* ------------------------------------------------------------------ Party Dino: inflatable rex suit */
  dino(K) {
    const [hx, hy] = HEAD_C;
    outfit(K, {
      torso: { n: 2, w: z => 1.05 + .04 * bell(z, 112, 14), d: z => 1.05, off: (th, z) => 2.4 * Math.max(0, Math.sin(th)) * bell(z, 114, 16) },
      arm: { n: 2, r: x => 1.06 + .04 * bell(x, 30, 8) }, leg: { n: 2, r: z => z > 60 ? 1.1 : 1.04 },
      boot: { len: 1.16, h: .75, n: 2, toe: 1.3, sole: 1.2, w: 1.12 },
      mat: { torso: { slot: S.P, rough: .48, metal: 0 }, arm: { slot: S.P, rough: .48, metal: 0 }, leg: { slot: S.P, rough: .48, metal: 0 }, boot: { slot: S.P, rough: .48, metal: 0, pat: true }, sole: S.D }, glove: S.P,
    });
    // ribbed yellow belly panel
    patch(K, 'torso', { u0: Math.PI * .27, u1: Math.PI * .73, v0: 92, v1: 148, nu: 12, nv: 18, off: .35, t: .8, offFn: (u, v) => .7 * Math.max(0, Math.cos((v - 92) / 7 * Math.PI)), mat: { slot: S.S, rough: .55, metal: 0 } });
    // hood head: cranium, snout with felt teeth, open mouth with the pilot's glow inside, googly eyes, nostrils, party hat
    K.add(xf(P.ell(10.8, 11.5, 11.5, 20, 14), { p: [hx, hy - 1, 169] }), { slot: S.P, rough: .5, metal: 0, bone: 'Head', pat: true });
    K.add(xf(P.ell(8.6, 9.6, 5.4, 18, 10), { p: [hx, hy + 9.2, 172] }), { slot: S.P, rough: .5, metal: 0, bone: 'Head', pat: true });
    K.add(xf(P.ell(8.2, 9.2, 3.4, 16, 8), { p: [hx, hy + 8.4, 161.5] }), { slot: S.P, rough: .5, metal: 0, bone: 'Head', pat: true });
    K.add(xf(P.ell(7.4, 8.4, 4.4, 16, 8), { p: [hx, hy + 8.2, 166.6] }), { slot: S.D, rough: .9, metal: 0, bone: 'Head' });
    K.add(xf(P.rbox(9, 1, 1.6, .5, 1), { p: [hx, hy + 14.6, 166.8] }), { slot: S.G, rough: .1, metal: 0, bone: 'Head' });
    for (let i = 0; i < 7; i++) { const a = (i / 6 - .5) * 2.1, x = Math.sin(a) * 7.6, y = hy + 8.4 + Math.cos(a) * 8.4; K.add(xf(P.cone(.95, 2.4, 5), { r: [180, 0, 0], p: [x, y, 168.4] }), { slot: S.L, rough: .6, metal: 0, bone: 'Head' }); K.add(xf(P.cone(.85, 2, 5), { p: [x * .97, y - .2, 164.8] }), { slot: S.L, rough: .6, metal: 0, bone: 'Head' }); }
    for (const s of [-1, 1]) { K.add(xf(P.sph(3.8, 14, 10), { p: [s * 5.4, hy + 6, 178.6] }), { slot: S.L, rough: .15, metal: 0, bone: 'Head' }); K.add(xf(P.sph(1.9, 10, 8), { p: [s * 6.3, hy + 8.9, 179.6] }), { slot: S.D, rough: .1, metal: 0, bone: 'Head' }); K.add(xf(P.ell(.9, .6, .6, 6, 4), { p: [s * 2.4, hy + 17.6, 174] }), { slot: S.D, rough: .6, metal: 0, bone: 'Head' }); }
    for (let i = 0; i < 4; i++) { const z0 = 179.8 + i * 3.2, r0 = 5.6 - i * 1.3; K.add(xf(P.cyl(Math.max(.4, r0 - 1.3), r0, 3.2, 14), { r: [-12, 8, 0], p: [hx + 1.2 + i * .1, hy - 1.6 - i * .7, z0 + 1.6] }), { slot: i % 2 ? S.A : S.S, rough: .5, metal: 0, bone: 'Head' }); }
    K.add(xf(P.sph(1.8, 10, 6), { p: [hx + 1.6, hy - 4.4, 193.4] }), { slot: S.L, rough: .9, metal: 0, bone: 'Head' });
    K.add(xf(P.cyl(6, 7.4, 10, 14), { p: [hx, hy - 2.5, 153] }), { slot: S.P, rough: .5, metal: 0, bone: 'Head', pat: true });
    // spikes along the back, curled tail, three toe claws per foot
    for (const [z, h] of [[156, 4.6], [146, 5.6], [136, 6.2], [124, 5.6], [112, 4.8], [101, 4]]) { const sp = K.surf([0, -45, z], [0, 1, 0], -.8, true); K.add(dorsal(3.6, h, 1.8, sp.toArray()), { slot: S.S, rough: .5, metal: 0 }); }
    for (const [z, h] of [[178, 3.6], [171, 4.2], [164, 3.8]]) { const sp = K.surf([0, -45, z], [0, 1, 0], -.8, true, [0, hy - 11, z]); K.add(dorsal(2.8, h, 1.5, sp.toArray()), { slot: S.S, rough: .5, metal: 0, bone: 'Head' }); }
    const tb = K.surf([0, -45, 98], [0, 1, 0], -1.5, true);
    K.add(P.tube([[0, tb.y + 1.5, 99], [0, tb.y - 8, 90], [0, tb.y - 15, 78], [0, tb.y - 19, 66], [0, tb.y - 19.5, 57]], 7, 16, 10, t => 1 - t * .88), { slot: S.P, rough: .5, metal: 0, bones: ['Hips', 'Spine'], pat: true });
    K.mirror(s => { const bt = K.body.boot; for (const dx of [-3.2, 0, 3.2]) K.add(xf(P.cone(1.3, 3.6, 6), { r: [-80, 0, 0], p: [s * bt.fx + dx, bt.yB - .2, 3.4] }), { slot: S.L, rough: .4, metal: 0 }); });
    teamZone(K, { x: 30, cz: 147, cw: 10 });
    emblemPatch(K, { c: [-30, -6, 200], r: 4.2, slot: S.A });
  },

  /* ------------------------------------------------------------------ Robot Butler: tailcoat, shirt front, chrome head */
  butler(K) {
    const [hx, hy] = HEAD_C;
    outfit(K, {
      torso: { n: 2.3, w: z => .95 * (z < 104 ? 1.02 : 1), d: z => .93, off: (th, z) => Math.abs(Math.cos(th)) < .05 && z > 104 ? -.3 : 0 },
      arm: { n: 2.1, r: x => x > 60 ? 1.08 : .92 }, leg: { n: 2.2, r: z => .9 },
      boot: { len: 1.04, h: .58, n: 2.4, toe: .85, sole: 1.1 },
      mat: { torso: { slot: S.P, rough: .5, metal: .05 }, arm: { slot: S.P, rough: .5, metal: .05 }, leg: { slot: S.P, rough: .5, metal: .05 }, boot: { slot: S.D, rough: .12, metal: .35 }, sole: S.D }, glove: S.L,
    });
    // shirt front + waistcoat, satin trouser stripes, white cuffs + spats
    patch(K, 'torso', { u0: Math.PI * .37, u1: Math.PI * .63, v0: 120, v1: 156, nu: 8, nv: 10, off: .3, t: .5, mat: { slot: S.S, rough: .55, metal: 0 } });
    patch(K, 'torso', { u0: Math.PI * .3, u1: Math.PI * .7, v0: 104, v1: 121, nu: 10, nv: 6, off: .45, t: .6, mat: { slot: S.A, rough: .4, metal: .1 } });
    K.mirror(s => {
      patch(K, 'leg', { side: s, u0: -.18, u1: .18, v0: 98, v1: 22, nu: 2, nv: 14, off: .2, t: .3, mat: { slot: S.D, rough: .15, metal: .3 } });
      const [a, b, cy, cz] = K.body.aSec(62); K.add(band([s * 62, cy, cz], 'x', a + .2, b + .2, 3.4, .5), { slot: S.S, rough: .5, metal: 0, bone: (s < 0 ? 'Left' : 'Right') + 'ForeArm' });
      const [la, lb, lx, ly] = K.body.lSec(20); K.add(band([s * lx, ly, 19], 'z', la + .25, lb + .25, 5, .6), { slot: S.L, rough: .6, metal: 0 });
    });
    for (const z of [148, 140, 132, 124]) { const sp = K.surf([0, 45, z], [0, -1, 0], .3, true); K.add(xf(P.sph(.85, 6, 5), { p: sp.toArray() }), { slot: S.X, rough: .3, metal: 1 }); }
    // chrome can head + dome, dark face glass, round eyes, gold monocle + chain, gold moustache, bowler hat
    K.add(xf(P.cyl(9.4, 9.8, 15, 22), { p: [hx, hy, 165] }), { slot: S.M, rough: .18, metal: 1, bone: 'Head' });
    K.add(xf(new T.SphereGeometry(9.4, 22, 8, 0, Math.PI * 2, 0, Math.PI * .5), { r: [90, 0, 0], p: [hx, hy, 172.5] }), { slot: S.M, rough: .18, metal: 1, bone: 'Head' });
    K.add(xf(P.cyl(9.9, 9.9, 2, 22), { p: [hx, hy, 157.4] }), { slot: S.D, rough: .4, metal: .6, bone: 'Head' });
    K.add(xf(P.cyl(5.8, 6.8, 10, 14), { p: [hx, hy - 1.5, 152] }), { slot: S.D, rough: .4, metal: .6, bone: 'Head' });
    K.add(xf(P.rbox(13, 2, 9.5, 2, 2), { p: [hx, hy + 9.3, 166] }), { slot: S.D, rough: .08, metal: .5, bone: 'Head' });
    for (const s of [-1, 1]) K.add(xf(P.cyl(2.1, 2.1, 1.2, 16), { r: [90, 0, 0], p: [s * 3.4, hy + 10.6, 168] }), { slot: S.G, rough: .1, metal: 0, bone: 'Head' });
    K.add(xf(P.tor(3, .45, 5, 18), { r: [90, 0, 0], p: [3.4, hy + 11.5, 168] }), { slot: S.X, rough: .2, metal: 1, bone: 'Head' });
    K.add(P.tube([[6.2, hy + 11.2, 167], [8.6, hy + 9.6, 162], [9.6, hy + 7, 157.6]], .2, 8, 3), { slot: S.X, rough: .2, metal: 1, bone: 'Head' });
    for (const s of [-1, 1]) K.add(P.tube([[0, hy + 10.5, 163.4], [s * 2.6, hy + 11, 162.6], [s * 5, hy + 10.9, 163.4], [s * 6.1, hy + 10.5, 165.3], [s * 5.2, hy + 10.4, 166.3]], 1, 12, 5, t => 1 - t * .65), { slot: S.X, rough: .25, metal: 1, bone: 'Head' });
    K.add(xf(P.ell(1.7, 1.2, 1.1, 8, 6), { p: [0, hy + 10.7, 163.5] }), { slot: S.X, rough: .25, metal: 1, bone: 'Head' });
    K.add(xf(P.ell(13.6, 14.4, 1.4, 24, 4), { r: [-6, 8, 0], p: [hx, hy - .6, 177.6] }), { slot: S.D, rough: .5, metal: .1, bone: 'Head' });
    K.add(xf(new T.SphereGeometry(1, 20, 8, 0, Math.PI * 2, 0, Math.PI * .5), { r: [84, 8, 0], s: [9.6, 10.4, 8.2], p: [hx, hy - .4, 178.2] }), { slot: S.D, rough: .5, metal: .1, bone: 'Head' });
    K.add(xf(P.cyl(9.7, 9.9, 1.6, 22), { r: [-6, 8, 0], p: [hx, hy - .5, 179.5] }), { slot: S.A, rough: .6, metal: 0, bone: 'Head' });
    // collar wings, bow tie, pocket square, tailcoat tails (one per leg)
    const nk = K.surf([0, 45, 152], [0, -1, 0], 0, true);
    for (const s of [-1, 1]) K.add(xf(P.ext([[0, 0], [5.5, 1.5], [3.5, -4.2]], .7, .2, 1), { r: [80, 0, 0], s: [s, 1, 1], p: [s * 1.2, nk.y + .2, 155] }), { slot: S.S, rough: .5, metal: 0, bones: ['Neck', 'Spine2'] });
    for (const s of [-1, 1]) K.add(xf(P.ext([[0, 0], [5, 2.6], [5, -2.6]], 1.6, .5, 1), { r: [90, 0, 0], s: [s, 1, 1], p: [0, nk.y + 1.8, 152.6] }), { slot: 8, rough: .45, metal: 0, bones: ['Neck', 'Spine2'] });
    K.add(xf(P.rbox(2.4, 1.8, 2.4, .8, 1), { p: [0, nk.y + 2.4, 152.6] }), { slot: 8, rough: .45, metal: 0, bones: ['Neck', 'Spine2'] });
    const ps = K.surf([-10, 45, 146], [0, -1, 0], .4, true); K.add(xf(P.ext([[-2.4, 0], [2.4, 0], [1.6, 3], [0, 4.2], [-1.4, 2.6]], .5, .15, 1), { r: [90, 0, 0], p: [ps.x, ps.y + .2, ps.z - 1] }), { slot: S.A, rough: .5, metal: 0, bones: ['Spine2'] });
    for (const s of [-1, 1]) { const side = s < 0 ? 'Left' : 'Right', rows = [];
      for (let i = 0; i <= 6; i++) { const z = 101 - i * 8.6, w = Math.max(1.5, 11 - i * 1.25), xs = []; for (let j = 0; j <= 3; j++) xs.push(s * (1.2 + j * w / 3)); rows.push([z, xs, 1.2 + i * .5]); }
      K.add(thicken(K.sheet(rows, -1, s > 0), .7), { slot: S.P, rough: .5, metal: .05, bones: ['Hips', side + 'UpLeg'], pat: true }); }
    teamZone(K, { chest: false });
    emblemPatch(K, { r: 4, slot: S.A });
  },
});

/* ======================================================================================= shader (patched MeshStandardMaterial) */
// aMat = (slot | -1 = use the soldier texture's material classes, roughness | -1, metalness | -1, flags)
// flags: 1 base body · 2 pattern · 4 emblem · 8 ignore the soldier normal map (costume surfaces) · 16 flat colour (no texture detail)
const VERT_HEAD = 'attribute vec4 aMat;\nvarying vec4 vMat; varying vec3 vBP; varying vec3 vBN; varying vec3 vS9X; varying vec3 vS9Y; varying vec3 vS9Z;\n';
const FRAG_HEAD = `
uniform vec3 uPal[9]; uniform float uBase[5]; uniform vec3 uTeam; uniform vec2 uCRM[5];
uniform sampler2D uPat; uniform float uPatS; uniform vec3 uPatCol; uniform float uPatAmt; uniform float uPatDark; uniform float uPatGlow; uniform float uBump;
uniform sampler2D uEmb; uniform vec4 uEmbRect; uniform vec3 uEmbCol; uniform float uEmbOn;
uniform vec3 uGlow; uniform float uTime;
varying vec4 vMat; varying vec3 vBP; varying vec3 vBN; varying vec3 vS9X; varying vec3 vS9Y; varying vec3 vS9Z;
vec4 s9Tri(vec3 p, vec3 n) { vec3 w = pow(abs(n), vec3(4.0)); w /= (w.x + w.y + w.z + 1e-4);
  return texture2D(uPat, p.yz) * w.x + texture2D(uPat, p.xz + vec2(.37, .11)) * w.y + texture2D(uPat, p.xy + vec2(.71, .53)) * w.z; }
// height gradient of the pattern (bind space, per cm) from the dominant triplanar plane
vec3 s9Grad(vec3 p, vec3 n) { vec3 an = abs(n); vec2 uv; vec3 Ta, Ba;
  if (an.x > an.y && an.x > an.z) { uv = p.yz; Ta = vec3(0., 1., 0.); Ba = vec3(0., 0., 1.); } else if (an.y > an.z) { uv = p.xz + vec2(.37, .11); Ta = vec3(1., 0., 0.); Ba = vec3(0., 0., 1.); } else { uv = p.xy + vec2(.71, .53); Ta = vec3(1., 0., 0.); Ba = vec3(0., 1., 0.); }
  float e = 1. / 512., h0 = texture2D(uPat, uv).a, hu = texture2D(uPat, uv + vec2(e, 0.)).a, hv = texture2D(uPat, uv + vec2(0., e)).a;
  return ((hu - h0) * Ta + (hv - h0) * Ba) / e; }
float s9Flag(float f, float bit) { return mod(floor(f / bit + .001), 2.0); }
`;
const FRAG_MAP = `
  float s9F = vMat.w, s9IsBase = s9Flag(s9F, 1.), s9UsePat = s9Flag(s9F, 2.), s9IsEmb = s9Flag(s9F, 4.), s9NoNM = s9Flag(s9F, 8.), s9Flat = s9Flag(s9F, 16.);
  vec3 s9Col = vec3(1.); float s9R = vMat.y, s9M = vMat.z, s9Glow = 0., s9H = 0., s9Team = 0.;
  vec3 s9c = texture2D(map, vUv).rgb; float s9L = dot(s9c, vec3(.2126, .7152, .0722));
  float s9det = s9Flat > .5 ? 1. : clamp(.5 + sqrt(s9L) * .85, .55, 1.22);
  if (s9IsBase > .5 && vMat.x < -.5) {
    float mx = max(s9c.r, max(s9c.g, s9c.b)) + .004;
    float wR = smoothstep(.55, .8, (s9c.r - s9c.g) / mx);
    float wM = smoothstep(-.01, .09, (s9c.b - s9c.g) / mx) * (1. - wR);
    float wO = smoothstep(-.03, .07, (s9c.g - s9c.r) / mx) * (1. - wM) * (1. - wR);
    float wD = 1. - smoothstep(.012, .05, s9L);
    float wP = (1. - wR) * (1. - wM) * (1. - wO);
    wP *= 1. - wD; wO *= 1. - wD; wM *= 1. - wD; wR *= 1. - wD;
    float dP = clamp(s9L / .48, .45, 1.2), dO = clamp(s9L / .09, .5, 1.35), dD = clamp(s9L / .022, .6, 1.6), dM = clamp(s9L / .2, .5, 1.3), dR = clamp(s9L / .12, .6, 1.3);
    int b0 = int(uBase[0] + .5), b1 = int(uBase[1] + .5), b2 = int(uBase[2] + .5), b3 = int(uBase[3] + .5), b4 = int(uBase[4] + .5);
    s9Col = wP * uPal[b0] * dP + wO * uPal[b1] * dO + wD * uPal[b2] * dD + wM * uPal[b3] * dM + wR * uPal[b4] * dR;
    s9R = wP * uCRM[0].x + wO * uCRM[1].x + wD * uCRM[2].x + wM * uCRM[3].x + wR * uCRM[4].x;
    s9M = wP * uCRM[0].y + wO * uCRM[1].y + wD * uCRM[2].y + wM * uCRM[3].y + wR * uCRM[4].y;
    s9Glow = (b0 == 4 ? wP : 0.) + (b1 == 4 ? wO : 0.) + (b2 == 4 ? wD : 0.) + (b3 == 4 ? wM : 0.) + (b4 == 4 ? wR : 0.);
  } else {
    int sl = int(vMat.x + .5); s9Col = uPal[sl] * (s9IsBase > .5 ? s9det : 1.);
    if (sl == 4) s9Glow = 1.; if (sl == 8) s9Team = 1.;
    if (s9R < 0.) s9R = .6; if (s9M < 0.) s9M = .1;
  }
  if (s9UsePat > .5) {
    vec4 pt = s9Tri(vBP * uPatS, normalize(vBN));
    s9Col = mix(s9Col, uPatCol, pt.r * uPatAmt); s9Col *= 1. - pt.g * uPatDark;
    s9Glow += pt.b * uPatGlow * (.6 + .4 * sin(uTime * 2.6 + vBP.z * .09 + vBP.x * .05)); s9H = 1.;
    s9R = clamp(s9R + (pt.g - .5) * .12, .04, 1.);
  }
  if (s9IsEmb > .5 && uEmbOn > .5) { vec2 eu = clamp(vUv, .02, .98); float ea = texture2D(uEmb, uEmbRect.xy + eu * uEmbRect.zw).a; s9Col = mix(s9Col, uEmbCol, ea); s9Glow += ea * .12; }
  s9Col *= 1. - clamp(s9Glow + s9Team, 0., 1.) * .75;
  diffuseColor.rgb *= s9Col;
`;
function patchBody(sh, u) {
  Object.assign(sh.uniforms, u);
  sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + VERT_HEAD)
    .replace('#include <begin_vertex>', '#include <begin_vertex>\n vMat = aMat; vBP = position; vBN = normal;')
    .replace('#include <skinnormal_vertex>', '#include <skinnormal_vertex>\n#ifdef USE_SKINNING\n vS9X = normalize(normalMatrix * (skinMatrix * vec4(1., 0., 0., 0.)).xyz); vS9Y = normalize(normalMatrix * (skinMatrix * vec4(0., 1., 0., 0.)).xyz); vS9Z = normalize(normalMatrix * (skinMatrix * vec4(0., 0., 1., 0.)).xyz);\n#else\n vS9X = normalize(normalMatrix * vec3(1., 0., 0.)); vS9Y = normalize(normalMatrix * vec3(0., 1., 0.)); vS9Z = normalize(normalMatrix * vec3(0., 0., 1.));\n#endif');
  sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + FRAG_HEAD)
    .replace('#include <map_fragment>', FRAG_MAP)
    .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = s9R;')
    .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n metalnessFactor = s9M;')
    .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n vec3 s9N0 = normal;')
    .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n if (s9NoNM > .5 || s9IsBase < .5) normal = s9N0;\n if (uBump > 0. && s9UsePat > .5) { vec3 gb = s9Grad(vBP * uPatS, normalize(vBN)) * uPatS * uBump; vec3 gv = gb.x * vS9X + gb.y * vS9Y + gb.z * vS9Z; normal = normalize(normal - (gv - dot(gv, normal) * normal)); }')
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += uGlow * s9Glow + uTeam * s9Team;');
}
let FLAT_TEX = null, EMB_TEX = null;
function flatTex() { if (!FLAT_TEX) { FLAT_TEX = new T.DataTexture(new Uint8Array([0, 0, 0, 128]), 1, 1, T.RGBAFormat); FLAT_TEX.needsUpdate = true; } return FLAT_TEX; }
function makeBodyMat() {
  const b = baseInit();
  const u = { uPal: { value: Array.from({ length: 9 }, () => new T.Color()) }, uTeam: { value: new T.Color() }, uBase: { value: [0, 1, 2, 7, 3] }, uCRM: { value: Array.from({ length: 5 }, () => new T.Vector2(.6, .1)) },
    uPat: { value: flatTex() }, uPatS: { value: 1 / 34 }, uPatCol: { value: new T.Color() }, uPatAmt: { value: 0 }, uPatDark: { value: 0 }, uPatGlow: { value: 0 }, uBump: { value: 0 },
    uEmb: { value: emblemAtlas() }, uEmbRect: { value: new T.Vector4(0, 0, .25, .25) }, uEmbCol: { value: new T.Color(1, 1, 1) }, uEmbOn: { value: 0 },
    uGlow: { value: new T.Color() }, uTime: { value: 0 } };
  const m = new T.MeshStandardMaterial({ map: b.map, normalMap: b.normalMap, roughness: 1, metalness: 1, envMapIntensity: .85 });
  m.name = 's9skin'; m.userData.s9u = u;
  m.onBeforeCompile = sh => patchBody(sh, u);
  m.customProgramCacheKey = () => 's9skin-v1';
  return m;
}

/* ======================================================================================= procedural pattern textures (RGBA: R tint, G grime, B glow, A height) */
const PAT_CACHE = new Map();
function patTex(kind, seed = 1) {
  const key = kind + '|' + seed; if (PAT_CACHE.has(key)) return PAT_CACHE.get(key);
  const S = 512, d = new Uint8Array(S * S * 4), N = makeNoise(seed), R = rng(seed * 7 + 3), per = 8;
  const put = (x, y, r, g, b, a) => { const i = (y * S + x) * 4; d[i] = clamp(r, 0, 1) * 255; d[i + 1] = clamp(g, 0, 1) * 255; d[i + 2] = clamp(b, 0, 1) * 255; d[i + 3] = clamp(a, 0, 1) * 255; };
  const pts = []; const cells = 7; for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) pts.push([(i + R()) / cells, (j + R()) / cells, R()]);
  const vor = (u, v) => { let d1 = 9, d2 = 9, id = 0; for (const [px, py, pr] of pts) for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) { const dx = u - px - ox, dy = v - py - oy, dd = Math.sqrt(dx * dx + dy * dy); if (dd < d1) { d2 = d1; d1 = dd; id = pr; } else if (dd < d2) d2 = dd; } return [d1, d2 - d1, id]; };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S, f = N.fbm(u * per, v * per, per, 5), f2 = N.fbm(u * per * 2 + 3, v * per * 2 + 9, per * 2, 3);
    let r = 0, g = 0, b = 0, a = .5;
    if (kind === 'panel') {   // fine hex micro-panels + wear
      const hx = u * 9, hy = v * 9 * 1.1547, row = Math.floor(hy), cx = hx + (row % 2) * .5, fx = cx - Math.floor(cx) - .5, fy = hy - row - .5, e = Math.max(Math.abs(fx) * 1.1, Math.abs(fy) + Math.abs(fx) * .5);
      const line = smooth(.43, .48, e); g = line * .5 + smooth(.62, .8, f) * .25; a = .55 - line * .4 + (f - .5) * .1;
    } else if (kind === 'scratch') {   // battle-worn plate: scratches, dents, rivet rows
      g = smooth(.55, .78, f) * .35; a = .5 + (f - .5) * .5;
      const sc = Math.abs(Math.sin((u * 3 + v * 7 + N.n2(u * 4, v * 4, 4) * .6) * Math.PI * 9)); if (sc > .985 && f2 > .5) { g += .35; a -= .2; }
      const rv = (Math.abs(((u * 8) % 1) - .5) < .07 && Math.abs(((v * 4) % 1) - .5) < .07) ? 1 : 0; a += rv * .35; g += rv * .1;
    } else if (kind === 'camoD') {   // desert camo blobs + cloth weave
      const c1 = smooth(.48, .52, f), c2 = smooth(.58, .62, f2); r = c1; g = c2 * .45; a = .5 + ((x % 4 < 2) !== (y % 4 < 2) ? .08 : -.08) + (f - .5) * .2;
    } else if (kind === 'pixel') {   // digital snow camo
      const px = Math.floor(u * 32), py = Math.floor(v * 32), q = N.fbm(px / 32 * per, py / 32 * per, per, 3), q2 = N.fbm(px / 32 * per + 5, py / 32 * per + 2, per, 3);
      r = q > .55 ? 1 : 0; g = q2 > .6 ? .55 : 0; a = .5 + r * .1 - g * .1;
    } else if (kind === 'speckle') {   // banana speckles + long fibres
      const sp = N.n2(u * 64, v * 64, 64); g = smooth(.78, .9, sp) * .85 + smooth(.7, .75, f) * .12; r = smooth(.6, .9, N.fbm(u * 2, v * 2, 2, 2)) * .5;
      a = .5 + Math.sin(u * Math.PI * 2 * 24) * .06 - g * .15;
    } else if (kind === 'scales') {   // dino / dragon scales
      const sx = u * 14, sy = v * 14, row = Math.floor(sy), ox = (row % 2) * .5, cx = sx + ox - Math.floor(sx + ox) - .5, cy = sy - row - .5, dd = Math.sqrt(cx * cx + cy * cy * 1.3);
      a = .75 - dd * .9; g = smooth(.38, .5, dd) * .45; r = smooth(.55, .7, f) * .9;
    } else if (kind === 'veins') {   // xeno: bio-luminescent cell walls
      const [d1, edge, id] = vor(u, v); const wall = 1 - smooth(.0, .03, edge); b = wall * smooth(.35, .6, f) + smooth(.0, .035, .035 - d1) * (id > .6 ? 1 : 0); r = wall * .8; g = d1 * .45; a = .4 + d1 * 1.2 - wall * .35;
    } else if (kind === 'weave') {   // ninja: carbon weave + thin neon circuit traces
      const wv = ((Math.floor(u * 48) + Math.floor(v * 48 / 2)) % 4 < 2) ? 1 : 0; a = .5 + wv * .12; g = wv * .18;
      const tx = Math.abs(((u * 3 + Math.floor(v * 2) * .37) % 1) - .5) < .008, ty = Math.abs(((v * 2) % 1) - .5) < .012 && ((u * 3) % 1) < .45;
      b = (tx && ((v * 3) % 1) < .7) || ty ? 1 : 0; r = b * .6;
    } else if (kind === 'leather') {   // pirate: leather grain, stitched seams, grime
      a = .5 + (N.n2(u * 90, v * 90, 90) - .5) * .25 + (f - .5) * .2; g = smooth(.55, .8, f) * .5;
      const st = Math.abs(((v * 5) % 1) - .5) < .01 && ((u * 40) % 1) < .55; r = st ? .9 : 0; a += st ? .12 : 0;
    } else if (kind === 'stripes') {   // mecha: panel lines + hazard band
      const pl = Math.min(Math.abs(((u * 4) % 1) - .5), Math.abs(((v * 4) % 1) - .5)), ln = 1 - smooth(.0, .015, .5 - pl); g = ln * .55; a = .55 - ln * .3;
      r = (Math.floor((u + v) * 14) % 2 === 0 && v > .82 && v < .97) ? 1 : 0;
    } else if (kind === 'mist') {   // skeleton: ghost mist + hairline cracks
      const [, edge] = vor(u, v); const crack = 1 - smooth(0, .012, edge); g = crack * .5; b = smooth(.55, .85, f) * .55 + crack * .25; a = .5 - crack * .3;
    } else if (kind === 'grid') {   // glitch: neon grid + dead-pixel blocks
      const gx = Math.abs(((u * 5) % 1) - .5) > .475, gy = Math.abs(((v * 5) % 1) - .5) > .475; const blk = N.n2(Math.floor(u * 16) * 3.1, Math.floor(v * 16) * 1.7, 64) > .84;
      b = (gx || gy ? 1 : 0) * .9 + (blk ? .6 : 0); r = blk ? 1 : 0; a = .5 + (gx || gy ? -.2 : 0) + (blk ? .2 : 0);
    } else if (kind === 'pinstripe') {   // butler: tailoring pinstripes + fine twill
      const ps = Math.abs(((u * 10) % 1) - .5) < .025; r = ps ? .7 : 0; a = .5 + (((x + y) % 3) === 0 ? .05 : 0); g = (f - .5) * .1;
    } else if (kind === 'moss') {   // mushroom: moss patches, lichen, tiny glowing spores
      const m = smooth(.52, .62, f); r = m; g = smooth(.6, .8, f2) * .4; const sp = N.n2(u * 96, v * 96, 96) > .93 && m > .5; b = sp ? 1 : 0; a = .45 + m * .25 + (N.n2(u * 64, v * 64, 64) - .5) * m * .3;
    } else if (kind === 'fur') {   // arctic fur / fleece
      a = .5 + (N.n2(u * 128, v * 40, 128) - .5) * .7; g = (1 - a) * .4;
    }
    put(x, y, r, g, b, a);
  }
  const t = new T.DataTexture(d, S, S, T.RGBAFormat); t.wrapS = t.wrapT = T.RepeatWrapping; t.magFilter = T.LinearFilter; t.minFilter = T.LinearMipmapLinearFilter; t.generateMipmaps = true; t.anisotropy = 4; t.needsUpdate = true;
  PAT_CACHE.set(key, t); return t;
}

/* ======================================================================================= emblem atlas (4x4 cells, white on transparent) */
function emblemDraw(g, id, s) {   // draw emblem `id` centred in an s x s cell
  g.save(); g.translate(s / 2, s / 2); const k = s / 256; g.scale(k, k); g.fillStyle = '#fff'; g.strokeStyle = '#fff'; g.lineJoin = 'round'; g.lineCap = 'round';
  const poly = (pts) => { g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); g.fill(); };
  const cut = f => { g.save(); g.globalCompositeOperation = 'destination-out'; f(); g.restore(); };
  const circ = (x, y, r) => { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); };
  switch (id) {
    case 'nine': g.lineWidth = 26; g.beginPath(); g.arc(0, -28, 46, 0, Math.PI * 2); g.stroke(); g.beginPath(); g.moveTo(46, -28); g.quadraticCurveTo(48, 70, -40, 92); g.stroke(); g.lineWidth = 10; g.strokeRect(-104, -104, 208, 208); break;
    case 'star': { const p = []; for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? 46 : 112; p.push([Math.cos(a) * r, Math.sin(a) * r + 6]); } poly(p); break; }
    case 'bolt': poly([[22, -118], [-62, 14], [-6, 14], [-30, 118], [62, -22], [6, -22], [40, -118]]); break;
    case 'cross': g.lineWidth = 18; g.beginPath(); g.arc(0, 0, 72, 0, Math.PI * 2); g.stroke(); for (const [a, b] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) { g.beginPath(); g.moveTo(a * 40, b * 40); g.lineTo(a * 112, b * 112); g.stroke(); } circ(0, 0, 14); break;
    case 'skull': g.beginPath(); g.ellipse(0, -18, 84, 80, 0, 0, Math.PI * 2); g.fill(); g.fillRect(-48, 40, 96, 52); cut(() => { circ(-32, -16, 24); circ(32, -16, 24); poly([[0, 14], [-12, 36], [12, 36]]); for (const x of [-30, -10, 10, 30]) g.fillRect(x - 4, 66, 8, 28); }); break;
    case 'wings': for (const s2 of [-1, 1]) { g.save(); g.scale(s2, 1); poly([[10, -10], [118, -70], [96, -38], [122, -34], [92, -6], [112, 0], [74, 26], [10, 30]]); g.restore(); } circ(0, 6, 26); break;
    case 'flame': g.beginPath(); g.moveTo(0, 118); g.bezierCurveTo(-96, 100, -92, 10, -30, -40); g.bezierCurveTo(-40, -2, -8, 8, -2, -12); g.bezierCurveTo(-24, -70, 10, -100, 30, -122); g.bezierCurveTo(20, -60, 96, -30, 80, 40); g.bezierCurveTo(74, 96, 30, 116, 0, 118); g.fill();
      cut(() => { g.beginPath(); g.moveTo(0, 96); g.bezierCurveTo(-40, 86, -36, 40, -6, 18); g.bezierCurveTo(0, 50, 30, 40, 20, 10); g.bezierCurveTo(48, 40, 40, 90, 0, 96); g.fill(); }); break;
    case 'gear': { g.beginPath(); for (let i = 0; i < 24; i++) { const a = i * Math.PI / 12, r = i % 2 ? 84 : 112; g.lineTo(Math.cos(a - .12) * r, Math.sin(a - .12) * r); g.lineTo(Math.cos(a + .12) * r, Math.sin(a + .12) * r); } g.closePath(); g.fill(); cut(() => circ(0, 0, 40)); break; }
    case 'eye': g.beginPath(); g.moveTo(-120, 0); g.quadraticCurveTo(0, -100, 120, 0); g.quadraticCurveTo(0, 100, -120, 0); g.fill(); cut(() => circ(0, 0, 46)); circ(0, 0, 22); break;
    case 'crown': poly([[-104, 70], [-112, -60], [-56, -4], [0, -96], [56, -4], [112, -60], [104, 70]]); g.fillRect(-104, 82, 208, 22); break;
    case 'heart': g.beginPath(); g.moveTo(0, 104); g.bezierCurveTo(-130, 20, -96, -104, 0, -46); g.bezierCurveTo(96, -104, 130, 20, 0, 104); g.fill(); break;
    case 'paw': g.beginPath(); g.ellipse(0, 40, 62, 52, 0, 0, Math.PI * 2); g.fill(); for (const [x, y, r] of [[-70, -30, 26], [-26, -74, 28], [26, -74, 28], [70, -30, 26]]) { g.beginPath(); g.ellipse(x, y, r * .8, r, x / 200, 0, Math.PI * 2); g.fill(); } break;
    case 'alien': g.beginPath(); g.moveTo(0, 116); g.bezierCurveTo(-60, 90, -104, 10, -96, -40); g.bezierCurveTo(-88, -100, 88, -100, 96, -40); g.bezierCurveTo(104, 10, 60, 90, 0, 116); g.fill(); cut(() => { for (const s2 of [-1, 1]) { g.beginPath(); g.ellipse(s2 * 40, -6, 34, 18, s2 * .5, 0, Math.PI * 2); g.fill(); } }); break;
    case 'banana': g.beginPath(); g.moveTo(-100, -70); g.quadraticCurveTo(-60, 110, 108, 40); g.quadraticCurveTo(-20, 60, -70, -86); g.closePath(); g.fill(); g.fillRect(-112, -96, 30, 22); break;
    case 'wolf': poly([[-92, -112], [-50, -40], [50, -40], [92, -112], [96, -10], [56, 60], [0, 112], [-56, 60], [-96, -10]]); cut(() => { poly([[-56, -6], [-16, 6], [-50, 22]]); poly([[56, -6], [16, 6], [50, 22]]); poly([[-14, 64], [14, 64], [0, 84]]); }); break;
  }
  g.restore();
}
function emblemAtlas() {
  if (EMB_TEX) return EMB_TEX;
  const c = canvasOf(1024), g = c.getContext('2d'); g.clearRect(0, 0, 1024, 1024);
  EMBLEMS.forEach((e, i) => { g.save(); g.translate((i % 4) * 256, Math.floor(i / 4) * 256); emblemDraw(g, e.id, 256); g.restore(); });
  EMB_TEX = new T.CanvasTexture(c); EMB_TEX.flipY = false; EMB_TEX.anisotropy = 4; EMB_TEX.needsUpdate = true; EMB_TEX.userData.canvas = c; return EMB_TEX;
}
const embRect = id => { const i = Math.max(0, EMB_IDX[id] ?? 1); return [(i % 4) * .25, Math.floor(i / 4) * .25, .25, .25]; };

/* ======================================================================================= looks: colours + apply */
// look = { skin, p, s, v (hex6, no #), emb (emblem id), h (1 = helmet variant) }
function defaultLook(skinId) { const d = SKIN[skinId] || SKIN.std; return { skin: d.id, p: d.pal[0].slice(1), s: d.pal[1].slice(1), v: d.pal[4].slice(1), emb: 'nine', h: d.helmet ? 1 : 0 }; }
function normLook(l) {
  if (typeof l === 'string') l = { skin: l };
  l = l || {}; const d = SKIN[l.skin] ? l.skin : 'std', base = defaultLook(d);
  const o = { skin: d, p: hex6(l.p) || base.p, s: hex6(l.s) || base.s, v: hex6(l.v) || base.v, emb: EMB_IDX[l.emb] !== undefined ? l.emb : base.emb, h: SKIN[d].helmet ? (l.h === 0 || l.h === false ? 0 : 1) : 0 };
  if (hex6(l.team)) o.team = hex6(l.team); return o;
}
const col = h => new T.Color('#' + h);
// per-skin material setup: which slot each soldier-texture class maps to + roughness/metal per class + pattern
const MATDEF = {
  std:      { base: [0, 1, 2, 7, 3], crm: [[.55, .15], [.85, 0], [.6, .1], [.35, .9], [.5, .1]], pat: ['panel', .0, .35, 0, 1.2], patCol: 5 },
  nomad:    { base: [0, 1, 2, 7, 3], crm: [[.85, 0], [.9, 0], [.75, .05], [.45, .8], [.7, 0]], pat: ['camoD', .65, .25, 0, 1.4], patCol: 6 },
  arctic:   { base: [0, 1, 2, 7, 3], crm: [[.7, .05], [.85, 0], [.7, .05], [.35, .9], [.5, .1]], pat: ['pixel', .8, .35, 0, .8], patCol: 6, patS: 1 / 40 },
  banana:   { base: [0, 0, 0, 0, 0], crm: [[.55, 0], [.55, 0], [.55, 0], [.55, 0], [.55, 0]], pat: ['speckle', .35, .55, 0, 1], patCol: 6, patS: 1 / 60 },
  jugg:     { base: [0, 2, 2, 7, 1], crm: [[.42, .75], [.7, .2], [.6, .3], [.3, .95], [.45, .3]], pat: ['scratch', 0, .45, 0, 2.2], patCol: 5 },
  ninja:    { base: [0, 0, 2, 2, 1], crm: [[.35, .2], [.6, 0], [.5, .1], [.3, .8], [.4, .2]], pat: ['weave', 0, .25, .42, .6], patCol: 4 },
  pirate:   { base: [0, 1, 2, 3, 3], crm: [[.65, .02], [.8, 0], [.75, .05], [.3, .95], [.35, .9]], pat: ['leather', .0, .5, 0, 1.6], patCol: 3 },
  dino:     { base: [0, 0, 0, 0, 3], crm: [[.48, 0], [.48, 0], [.48, 0], [.48, 0], [.48, 0]], pat: ['scales', .55, .35, 0, 1.6], patCol: 6, patS: 1 / 22 },
  mecha:    { base: [0, 1, 2, 7, 1], crm: [[.4, .1], [.55, .05], [.6, .1], [.3, .9], [.45, .1]], pat: ['stripes', 0, .4, 0, 1.2], patCol: 6 },
  butler:   { base: [0, 0, 2, 7, 3], crm: [[.5, .05], [.5, .05], [.6, .1], [.2, 1], [.4, .1]], pat: ['pinstripe', .85, 0, 0, .3], patCol: 6 },
  mushroom: { base: [1, 6, 2, 6, 3], crm: [[.8, 0], [.8, 0], [.8, 0], [.6, .2], [.6, 0]], pat: ['moss', .8, .3, .6, 1.6], patCol: 3 },
  skeleton: { base: [1, 1, 1, 2, 1], crm: [[.6, .05], [.6, .05], [.6, .05], [.4, .5], [.6, .05]], pat: ['mist', 0, .25, .16, .6], patCol: 4 },
  glitch:   { base: [0, 0, 2, 2, 4], crm: [[.25, .4], [.4, .2], [.4, .2], [.2, .9], [.3, .2]], pat: ['grid', .5, 0, .5, .8], patCol: 3 },
  xeno:     { base: [0, 1, 2, 1, 3], crm: [[.38, 0], [.45, .05], [.45, .05], [.4, .1], [.38, 0]], pat: ['veins', .3, .2, 1.1, 1.6], patCol: 6, patS: 1 / 40, glowK: 1.8 },
};
// first-person glove + sleeve colour slot per skin
const HANDS = { std: [2, 1], nomad: [6, 0], arctic: [5, 0], banana: [0, 0], jugg: [2, 0], ninja: [2, 0], pirate: [2, 0], dino: [0, 0], mecha: [5, 0], butler: [5, 0], mushroom: [5, 1], skeleton: [5, 1], glitch: [2, 0], xeno: [0, 1] };
function setupMat(m, look, glowK = 1) {
  const d = SKIN[look.skin], md = MATDEF[look.skin] || MATDEF.std, u = m.userData.s9u;
  d.pal.forEach((h, i) => u.uPal.value[i].set(h));
  u.uPal.value[0].set('#' + look.p); u.uPal.value[1].set('#' + look.s); u.uPal.value[4].set('#' + look.v);
  u.uPal.value[8].set('#' + (look.team || TEAM_DEFAULT));
  for (const c of u.uPal.value) c.convertSRGBToLinear();
  u.uBase.value = md.base.slice(); md.crm.forEach(([r, me], i) => u.uCRM.value[i].set(r, me));
  const [pk, amt, dark, glow, bump] = md.pat; u.uPat.value = patTex(pk, hashStr(look.skin) % 997 + 1); u.uPatAmt.value = amt; u.uPatDark.value = dark; u.uPatGlow.value = glow; u.uBump.value = bump * .35;
  u.uPatCol.value.copy(u.uPal.value[md.patCol]); u.uPatS.value = md.patS || 1 / 34;
  const er = embRect(look.emb); u.uEmbRect.value.set(...er); u.uEmbOn.value = look.emb && look.emb !== 'none' ? 1 : 0;
  u.uEmbCol.value.copy(u.uPal.value[5]); if (look.skin === 'arctic' || look.skin === 'mecha' || look.skin === 'butler') u.uEmbCol.value.copy(u.uPal.value[2]);
  u.uGlow.value.set('#' + look.v).convertSRGBToLinear().multiplyScalar(2.4 * glowK);
}
const TEAM_DEFAULT = 'ff7a2f';
const lum = c => c.r * .2126 + c.g * .7152 + c.b * .0722;
// apply a skin to a robot (r from buildBot) or to any object holding the soldier's skinned meshes
function apply(target, skinId, colours) {
  if (!target) return false;
  const base = baseInit(); if (!base) return false;
  const look = normLook(Object.assign({}, typeof colours === 'object' && colours ? colours : {}, { skin: skinId && SKIN[skinId] ? skinId : (colours && colours.skin) || 'std' }));
  const r = target.isBot || target.remote || (target.model && target.meshes) ? target : null, model = r ? r.model : target;
  let body = null, visor = null; model.traverse(o => { if (o.isSkinnedMesh) { if (/visor/i.test(o.name)) visor = o; else body = o; } });
  if (!body) return false;
  if (!body.userData.s9orig) body.userData.s9orig = { geo: body.geometry, mat: body.material };
  if (visor && !visor.userData.s9orig) visor.userData.s9orig = { mat: visor.material, vis: visor.visible };
  const geo = buildSkinGeo(look.skin, look.h); if (!geo) return false;
  const st = body.userData.s9 || (body.userData.s9 = { mat: makeBodyMat(), vmat: visor ? visor.userData.s9orig.mat.clone() : null });
  const m = st.mat, prevBody = r ? r.body : body.material;
  // carry over the live state the game may be animating (fade, hit flash, freeze tint)
  if (prevBody && prevBody !== m) { m.opacity = prevBody.opacity; m.transparent = prevBody.transparent; m.depthWrite = prevBody.depthWrite; if (prevBody.emissive) m.emissive.copy(prevBody.emissive); }
  setupMat(m, look); st.look = look; st.r = r;
  body.geometry = geo; body.material = m; body.frustumCulled = false; body.castShadow = false;
  if (visor) { visor.visible = !!geo.userData.s9.visor && visor.userData.s9orig.vis !== false; if (st.vmat) { visor.material = st.vmat; const vm = st.vmat; vm.emissiveIntensity = 1; vm.roughness = .08; vm.metalness = .45; vm.envMapIntensity = 1.6;
    if (!vm.userData.s9fres) { vm.userData.s9fres = 1; vm.onBeforeCompile = sh => { sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>'+String.fromCharCode(10)+' float s9fr = 1. - abs(dot(normalize(vNormal), normalize(vViewPosition))); totalEmissiveRadiance *= .22 + 1.9 * pow(s9fr, 2.2);'); }; vm.customProgramCacheKey = () => 's9visor-v1'; vm.needsUpdate = true; } } }
  if (r) { r.body = m; if (r.bodyCol) r.bodyCol = m.color.clone(); r.s9look = look; r.s9key = lookCode(look); }
  body.onBeforeRender = syncFn(body);
  return true;
}
// keeps glow/visor in step with what the game does to r.visor (team colour on spawn, dim on death, flash on vaporise)
function syncFn(body) {
  return function () {
    const st = body.userData.s9; if (!st) return; const r = st.r, u = st.mat.userData.s9u; u.uTime.value = performance.now() / 1000;
    let k = 1; const pv = r && r.visor;
    if (pv && r.color) k = clamp(lum(pv.emissive) / Math.max(.04, lum(r.color)), 0, 5);
    u.uGlow.value.set('#' + st.look.v).convertSRGBToLinear().multiplyScalar(1.9 * k * ((MATDEF[st.look.skin] || {}).glowK || 1));
    const tc = r && r.color ? r.color : new T.Color('#' + (st.look.team || TEAM_DEFAULT)).convertSRGBToLinear(); u.uTeam.value.copy(tc).multiplyScalar(2.2 * k); u.uPal.value[8].copy(tc);
    const vm = st.vmat; if (vm) { vm.emissive.set('#' + st.look.v).convertSRGBToLinear().multiplyScalar(1.15 * k); if (pv) { if (vm.transparent !== pv.transparent) { vm.transparent = pv.transparent; vm.needsUpdate = true; } vm.opacity = pv.opacity; vm.depthWrite = pv.depthWrite; } }
  };
}
function restore(target) {
  const model = target && (target.model || target); if (!model) return;
  model.traverse(o => { const s = o.userData && o.userData.s9orig; if (!s) return; if (s.geo) o.geometry = s.geo; if (s.mat) o.material = s.mat; if (s.vis !== undefined) o.visible = s.vis; o.onBeforeRender = () => {}; });
  if (target.model) { let b = null; target.model.traverse(o => { if (o.isSkinnedMesh && !/visor/i.test(o.name)) b = o; }); if (b) target.body = b.material; target.s9key = null; }
}

/* ======================================================================================= look codes (online `lk` + account) */
function lookCode(l) { l = normLook(l); return `${SKIN_IDX[l.skin].toString(36)}${l.h ? 1 : 0}.${l.p}.${l.s}.${l.v}.${(EMB_IDX[l.emb] || 0).toString(36)}`; }
function parseCode(code) {
  const m = /^([0-9a-z])([01])\.([0-9a-f]{6})\.([0-9a-f]{6})\.([0-9a-f]{6})\.([0-9a-z]{1,2})$/.exec(String(code || '').toLowerCase()); if (!m) return null;
  const si = parseInt(m[1], 36), ei = parseInt(m[6], 36); if (!SKINS[si]) return null;
  return normLook({ skin: SKINS[si].id, h: +m[2], p: m[3], s: m[4], v: m[5], emb: (EMBLEMS[ei] || EMBLEMS[1]).id });
}
// account look = { skin: "<id>-<h>-<secondary>-<visor>", color: "#primary", emblem: "<id>", gunSkins:{} } (server allows [A-Za-z0-9_-]{1,32})
function toAccount(l) { l = normLook(l); return { skin: l.skin, color: '#' + l.p, emblem: `${l.emb}-${l.h}-${l.s}-${l.v}` }; }
function fromAccount(a) {
  if (!a || typeof a !== 'object' || !a.skin) return null;
  const m = /^([a-z][a-z0-9]*)(?:-([01])-([0-9a-f]{6})-([0-9a-f]{6}))?$/.exec(String(a.skin)); if (!m || !SKIN[m[1]]) return null;
  const e = /^([a-z]+)(?:-([01])-([0-9a-f]{6})-([0-9a-f]{6}))?$/.exec(String(a.emblem || '')) || [];
  const p = typeof a.color === 'string' ? hex6(a.color) : Number.isInteger(a.color) ? a.color.toString(16).padStart(6, '0') : null;
  return normLook({ skin: m[1], h: m[2] !== undefined ? +m[2] : e[2] !== undefined ? +e[2] : undefined, s: m[3] || e[3], v: m[4] || e[4], p, emb: e[1] || a.emblem });
}

/* ======================================================================================= player state: saved look, unlocks */
const state = { look: null, per: {}, botMode: 'random', level: null };
function loadState() {
  try { const s = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); if (s && typeof s === 'object') { state.per = s.per && typeof s.per === 'object' ? s.per : {}; state.botMode = s.botMode === 'standard' ? 'standard' : 'random'; state.look = normLook(s.look || 'std'); } } catch (e) {}
  if (!state.look) state.look = normLook('std');
}
function saveState(sync = true) {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ v: 1, look: state.look, per: state.per, botMode: state.botMode })); } catch (e) {}
  if (sync) syncAccount();
}
function account() { return window.S9Account || null; }
function profile() { const A = account(); if (!A) return null; try { const p = typeof A.profile === 'function' ? A.profile() : typeof A.getProfile === 'function' ? A.getProfile() : A.profile; return p && typeof p === 'object' && typeof p.then !== 'function' ? p : null; } catch (e) { return null; } }
function playerLevel() {
  if (state.level) return state.level;
  const p = profile(); if (p && p.level) return Math.max(1, p.level | 0);
  try { const l = +localStorage.getItem('sector9-level'); if (l > 0) return l | 0; } catch (e) {}
  return 1;
}
const unlocked = (item, L = playerLevel()) => !item.level || L >= item.level;
let syncT = 0;
function syncAccount() {
  const A = account(); if (!A) return;
  clearTimeout(syncT); syncT = setTimeout(() => {
    try {
      const body = toAccount(state.look); if (!owns(state.look.skin) || !signedIn()) return;
      if (typeof A.api === 'function') serverEquip(state.look.skin).then(() => { const r = A.api('/api/me/look', { method: 'PUT', body }); if (r && r.catch) r.catch(() => {}); });
      else if (typeof A.putLook === 'function') A.putLook(body);
    } catch (e) {}
  }, 400);
}
function pullAccount() { const p = profile(); const l = p && fromAccount(p.look); if (l && owns(l.skin)) { state.look = l; state.per[l.skin] = { p: l.p, s: l.s, v: l.v, h: l.h }; saveState(false); refreshAll(); } }

/* ======================================================================================= ownership: skins are shop items (Nine Shards)
   A soldier skin can be worn when it is OWNED: the default item (Standard Trooper) always; others when GET /api/me/inventory lists
   "sol_<skinId>" (or S9Shop.data.items[].owned). The level only sets the minimum level to BUY (data/economy.json).
   Guests (not signed in): only the default skin. The server enforces the same rules on PUT /api/me/equip and /api/me/look. */
const ECON = { items: {}, loaded: false, cur: { name: 'Nine Shards', icon: 'assets/ui/shop/shard.svg' } };
const INV = { owned: new Set(), defaults: new Set(['sol_std']), loaded: false, at: 0, who: null };
function loadEconomy() {
  if (!window.fetch) return Promise.resolve();
  return fetch('data/economy.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(j => {
    if (!j || !Array.isArray(j.items)) return; const rar = {}; for (const r of j.rarities || []) rar[r.id] = r; const mult = (j.typePriceMultiplier && j.typePriceMultiplier.soldier) || 1;
    for (const it of j.items) if (it.type === 'soldier' && /^[a-z][a-z0-9_]{1,30}$/.test(it.skinId || '')) {
      const r = rar[it.rarity] || {}; ECON.items[it.skinId] = { id: String(it.id), price: Number.isFinite(it.price) ? it.price : Math.round((r.price || 0) * mult / 10) * 10, minLevel: Math.max(it.minLevel || 1, r.minLevel || 1), rarity: it.rarity, def: !!it.default, comingSoon: !!it.comingSoon };
      if (it.default) INV.defaults.add(String(it.id)); }
    if (j.currency) ECON.cur = { name: String(j.currency.name || 'Nine Shards'), icon: String(j.currency.iconSvg || j.currency.icon || ECON.cur.icon) };
    ECON.loaded = true; if (isOpen()) render();
  }).catch(() => {});
}
const wornLook = () => owns(state.look.skin) ? state.look : normLook(Object.assign({}, state.look, { skin: 'std', h: 0 }));
const itemOf = skinId => ECON.items[skinId] || { id: 'sol_' + skinId, price: null, minLevel: (SKIN[skinId] || {}).level || 1, def: skinId === 'std' };
const signedIn = () => { const A = account(); try { return !!(A && (typeof A.token === 'function' ? A.token() : A.token)); } catch (e) { return false; } };
function owns(skinId) {
  const it = itemOf(skinId); if (skinId === 'std' || it.def || INV.defaults.has(it.id)) return true;
  if (!signedIn()) return false;
  if (INV.owned.has(it.id)) return true;
  try { const D = window.S9Shop && window.S9Shop.data; const x = D && Array.isArray(D.items) && D.items.find(i => i.id === it.id); if (x && x.owned) return true; } catch (e) {}
  return false;
}
let invBusy = null;
function refreshInventory(force) {
  const A = account(); if (!A || typeof A.api !== 'function' || !signedIn()) { INV.owned = new Set(); INV.loaded = true; return Promise.resolve(INV); }
  if (invBusy) return invBusy; if (!force && Date.now() - INV.at < 15000) return Promise.resolve(INV);
  invBusy = Promise.resolve().then(() => A.api('/api/me/inventory')).then(r => {
    INV.owned = new Set((r && Array.isArray(r.items) ? r.items : []).map(i => String(i && i.id)).filter(Boolean)); if (r && Array.isArray(r.defaults)) for (const d of r.defaults) INV.defaults.add(String(d));
    INV.loaded = true; INV.at = Date.now(); const p = profile(); INV.who = p && p.id; try { localStorage.setItem('sector9-inv', JSON.stringify({ who: INV.who, owned: [...INV.owned], at: INV.at })); } catch (e) {}
    if (!owns(state.look.skin)) { state.look = normLook(Object.assign({}, state.look, { skin: 'std' })); saveState(false); applyHands(); }
    if (isOpen()) render(); return INV;
  }).catch(() => { try { const c = JSON.parse(localStorage.getItem('sector9-inv') || 'null'); const p = profile(); if (c && Array.isArray(c.owned) && (!p || c.who === p.id)) INV.owned = new Set(c.owned.map(String)); } catch (e) {} INV.loaded = true; return INV; }).finally(() => { invBusy = null; });
  return invBusy;
}
// equip on the server: the economy's equip writes the look's skin itself (it checks ownership); colours/emblem follow via /api/me/look
function serverEquip(skinId) {
  const A = account(); if (!A || typeof A.api !== 'function' || !signedIn()) return Promise.resolve(false);
  return Promise.resolve().then(() => A.api('/api/me/equip', { method: 'PUT', body: { slot: 'soldier', itemId: itemOf(skinId).id } })).then(() => true).catch(() => false);
}
function openShop(skinId) {
  const S = window.S9Shop, id = itemOf(skinId).id; if (!S || typeof S.open !== 'function') return false;
  try { S.open(id); } catch (e) { try { S.open('catalogue'); } catch (e2) { return false; } } return true;
}

/* ======================================================================================= who wears what */
function botLook(r) {
  if (state.botMode === 'standard') return normLook({ skin: 'std', v: '#' + new T.Color(...[r.color.r, r.color.g, r.color.b]).getHexString() });
  const h = hashStr(r.name || 'bot'), d = SKINS[h % SKINS.length], R = rng(h);
  const l = defaultLook(d.id); l.v = r.color.clone().getHexString(); l.emb = EMBLEMS[1 + (h >>> 4) % (EMBLEMS.length - 1)].id; l.h = d.helmet ? (R() < .5 ? 1 : 0) : 0;
  return normLook(l);
}
function remoteLook(r) {
  const NET = gv('NET'); const E = NET && NET.peers ? [...NET.peers.values()].find(e => e.r === r) : null;
  const l = E && E.pres && parseCode(E.pres.lk);
  return l || normLook({ skin: 'std', v: r.color.getHexString() });
}
function ensureRobot(r) {
  if (!r || !r.model) return;
  const l = r.remote ? remoteLook(r) : botLook(r), code = lookCode(l);
  if (r.s9key !== code) apply(r, l.skin, l);
}
function refreshAll() {
  for (const r of gv('robots') || []) { r.s9key = null; ensureRobot(r); }
  applyHands();
}
// first-person gloves + sleeves follow your own skin (shared viewmodel materials, originals kept)
let HAND0 = null;
function applyHands() {
  const gm = gv('GLOVE_M'), sm = gv('SLEEVE_M'); if (!gm || !sm) return;
  if (!HAND0) HAND0 = { g: [gm.color.clone(), gm.roughness, gm.metalness], s: [sm.color.clone(), sm.roughness, sm.metalness] };
  const l = wornLook(), d = SKIN[l.skin], [gs, ss] = HANDS[l.skin] || [2, 1];
  const pick = i => i === 0 ? '#' + l.p : i === 1 ? '#' + l.s : d.pal[i];
  if (l.skin === 'std') { gm.color.copy(HAND0.g[0]); sm.color.copy(HAND0.s[0]); return; }
  gm.color.set(pick(gs)).convertSRGBToLinear().multiplyScalar(.75); sm.color.set(pick(ss)).convertSRGBToLinear().multiplyScalar(.7);
}

/* ======================================================================================= hooks into the game (globals; no index.html edits needed) */
let hooked = false;
function installHooks() {
  if (hooked) return true;
  const bb = gv('buildBot'); if (typeof bb !== 'function') return false;
  hooked = true;
  // every new fighter (bots + remote players) gets its look as soon as it is built (global function bindings are reassigned through indirect eval)
  try { (0, eval)('buildBot = (function (orig) { return function (profile) { const r = orig.apply(this, arguments); try { window.S9Skins && window.S9Skins._onBot(r); } catch (e) { console.warn("skins", e); } return r; }; })(buildBot)'); } catch (e) { console.warn('skins: buildBot hook', e); }
  try { (0, eval)('netReceive = (function (orig) { return function (E, pr) { const out = orig.apply(this, arguments); try { if (E && E.r && pr) window.S9Skins && window.S9Skins._onRemote(E.r, pr.lk); } catch (e) {} return out; }; })(netReceive)'); } catch (e) {}
  try { (0, eval)('netSend = (function (orig) { return function (dt) { const out = orig.apply(this, arguments); try { window.S9Skins && window.S9Skins._onSend(); } catch (e) {} return out; }; })(netSend)'); } catch (e) {}
  // removing a fighter frees its GPU data: give the shared skin geometry back first so the cache survives
  try { (0, eval)('freeBotGpu = (function (orig) { return function (root) { try { root.traverse(o => { const s = o.userData && o.userData.s9orig; if (s && s.geo) o.geometry = s.geo; }); } catch (e) {} return orig.apply(this, arguments); }; })(freeBotGpu)'); } catch (e) {}
  return true;
}
let lastSent = '', lastRoom = null;
function onSend() {
  const NET = gv('NET'); if (!NET || !NET.on || !NET.room || typeof NET.room.presence !== 'function') return;
  const code = lookCode(wornLook()); if (code === lastSent && NET.room === lastRoom) return;
  lastSent = code; lastRoom = NET.room; try { const p = NET.room.presence({ lk: code }); if (p && p.catch) p.catch(() => {}); } catch (e) {}
}
function onRemote(r, lk) { if (!r) return; const l = parseCode(lk) || null; const code = l ? lookCode(l) : null; if (l && r.s9key !== code) apply(r, l.skin, l); else if (!l && !r.s9key) ensureRobot(r); }
/* shader warm-up: every program a skinned fighter can need (body + visor, opaque + fading) is compiled at load into the same
   render target the game draws to, and two hidden reference soldiers stay in the scene (far below, frustum-culled: never
   drawn) so later scene / graphics-tier compiles include them too. Materials share programs, so spawning or re-skinning
   fighters mid-match never builds a shader. Patterns + skin meshes are prepared while the menu is idle. */
let WARM = null, warmScene = null;
function warmSkins() {
  const A = gv('ASSET'), sc = gv('scene'), R = gv('renderer'), cam = gv('camera'); if (!A || !A.soldier || !sc || !R || !cam || !baseInit()) return false;
  if (!WARM) WARM = [0, 1].map(tr => {
    const m = T.SkeletonUtils.clone(A.soldier.scene); m.name = 's9skins-warm'; m.position.set(0, -600, 0); m.rotation.y = Math.PI; apply(m, 'std', { skin: 'std' });
    m.traverse(o => { if (!o.isMesh) return; o.frustumCulled = true; o.castShadow = o.receiveShadow = false; const st = o.userData.s9; if (st) for (const x of [st.mat, st.vmat]) if (x) { x.transparent = !!tr; x.depthWrite = !tr; x.opacity = tr ? .5 : 1; x.needsUpdate = true; } if (/visor/i.test(o.name)) o.visible = true; });
    m.updateMatrixWorld(true); return m; }).concat([0, 1].map(tr => {   // + the unskinned soldier (death cams / clones still use its materials)
    const m = T.SkeletonUtils.clone(A.soldier.scene); m.name = 's9skins-warm-plain'; m.position.set(0, -600, 0);
    m.traverse(o => { if (!o.isMesh) return; o.frustumCulled = true; o.castShadow = o.receiveShadow = false; o.material = o.material.clone(); o.material.transparent = !!tr; o.material.depthWrite = !tr; o.material.opacity = tr ? .5 : 1; });
    m.updateMatrixWorld(true); return m; }));
  if (warmScene !== sc) { for (const m of WARM) sc.add(m); warmScene = sc;
    const prev = R.getRenderTarget(), rt = gv('rt'); try { if (rt) R.setRenderTarget(rt); R.compile(sc, cam); } catch (e) { console.warn('skins warm', e); } R.setRenderTarget(prev); }
  return true;
}
let prepQ = null;
function prepIdle() {   // build every skin's mesh + pattern while the menu is idle (one per tick)
  if (!prepQ) { prepQ = []; for (const s of SKINS) { prepQ.push([s.id, 0]); if (s.helmet) prepQ.push([s.id, 1]); } }
  if (!prepQ.length || gv('state') !== 'menu') return;
  const [id, h] = prepQ.shift(); try { buildSkinGeo(id, h); const md = MATDEF[id]; if (md) { const t = patTex(md.pat[0], hashStr(id) % 997 + 1); const R = gv('renderer'); if (R && R.initTexture) R.initTexture(t); } } catch (e) {}
}
let watchT = 0;
function watch() {
  try { warmSkins(); prepIdle(); } catch (e) {}
  installHooks();
  const robots = gv('robots'); if (robots && baseInit()) for (const r of robots) if (!r.s9key || (r.remote && r.s9key)) ensureRobot(r);
  if (gv('GLOVE_M') && !HAND0) applyHands();
}

/* ======================================================================================= preview stage (one shared WebGL renderer for every preview) */
let PV = null, SIL_MAT = null;
function stage() {
  if (PV) return PV;
  const base = baseInit(); const A = gv('ASSET'); if (!base || !A || !A.soldier) return null;
  const renderer = new T.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  renderer.outputEncoding = T.sRGBEncoding; renderer.toneMapping = T.ACESFilmicToneMapping; renderer.toneMappingExposure = .95; renderer.setPixelRatio(1);
  const scene = new T.Scene();
  // studio environment: soft grey room + two coloured rim panels (matches the game's sci-fi env)
  const env = new T.Scene(); env.add(new T.Mesh(new T.SphereGeometry(20, 24, 12), new T.MeshBasicMaterial({ color: new T.Color(.16, .17, .2), side: T.BackSide })));
  for (const [p, c] of [[[0, 9, 10], [3, 3, 3.2]], [[-12, 5, -6], [.5, 1.8, 2.6]], [[12, 6, -6], [2.6, 1, .5]], [[0, -8, 0], [.2, .2, .22]]]) { const m = new T.Mesh(new T.PlaneGeometry(9, 5), new T.MeshBasicMaterial({ color: new T.Color(...c), side: T.DoubleSide })); m.position.set(...p); m.lookAt(0, 0, 0); env.add(m); }
  const pm = new T.PMREMGenerator(renderer); scene.environment = pm.fromScene(env, .02).texture; pm.dispose();
  const key = new T.DirectionalLight(0xfff1e0, 1.35); key.position.set(2.5, 4, 3); scene.add(key);
  const rim = new T.DirectionalLight(0x7fd8ff, 1.0); rim.position.set(-3, 2.5, -3); scene.add(rim);
  scene.add(new T.HemisphereLight(0xbfd4ff, 0x1a1410, .55));
  const floor = new T.Mesh(new T.CircleGeometry(1.1, 48), new T.MeshBasicMaterial({ map: blobTex(), transparent: true, depthWrite: false })); floor.rotation.x = -Math.PI / 2; floor.position.y = .002; scene.add(floor);
  const cam = new T.PerspectiveCamera(30, 1, .05, 50);
  const root = new T.Group(); scene.add(root);
  const model = T.SkeletonUtils.clone(A.soldier.scene); model.rotation.y = Math.PI; root.add(model);
  model.traverse(o => { if (o.isMesh) { o.frustumCulled = false; o.castShadow = false; } });
  const mixer = new T.AnimationMixer(model); let action = null;
  PV = { renderer, scene, cam, root, model, mixer, floor, look: null, clip: null,
    pose(name, t) { const C = gv('CLIPS'); if (!C || !C[name]) return; if (PV.clip !== name) { mixer.stopAllAction(); action = mixer.clipAction(C[name].full); action.play(); PV.clip = name; } action.time = t % action.getClip().duration; mixer.update(0); },
    setLook(l) { const n = normLook(l); const k = lookCode(n) + (n.team || ''); if (PV.look !== k) { apply(model, n.skin, n); PV.look = k; } },
    frame(w, h, yaw, dist = 4.6, ty = .95, fov = 30) { renderer.setSize(w, h, false); cam.aspect = w / h; cam.fov = fov; cam.updateProjectionMatrix(); root.rotation.y = yaw; cam.position.set(0, ty + .25, dist); cam.lookAt(0, ty, 0); },
    render() { model.traverse(o => { if (o.onBeforeRender && o.isSkinnedMesh) o.onBeforeRender(); }); renderer.render(scene, cam); return renderer.domElement; } };
  PV.pose('Idle_Loop', .3);
  return PV;
}
function blobTex() { const c = canvasOf(128), g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 4, 64, 64, 64); gr.addColorStop(0, 'rgba(0,0,0,.55)'); gr.addColorStop(.6, 'rgba(0,0,0,.25)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, 128, 128); const t = new T.CanvasTexture(c); return t; }
// draw a look into a canvas (or into an element: a canvas is created inside it). Returns a promise.
function preview(el, look, opts = {}) {
  return new Promise((res, rej) => {
    const go = () => {
      const pv = stage(); if (!pv) return setTimeout(go, 300);
      let cv = el; if (!el) return rej(new Error('no element'));
      if (!(el instanceof HTMLCanvasElement)) { cv = el.querySelector('canvas.s9sk-pv'); if (!cv) { el.innerHTML = ''; cv = document.createElement('canvas'); cv.className = 's9sk-pv'; cv.style.cssText = 'width:100%;height:100%;display:block'; el.appendChild(cv); } }
      const r = cv.getBoundingClientRect(), w = opts.w || Math.max(64, Math.round((r.width || cv.width || 256) * Math.min(2, devicePixelRatio || 1))), h = opts.h || Math.max(64, Math.round((r.height || cv.height || 256) * Math.min(2, devicePixelRatio || 1)));
      const l = look && typeof look === 'object' && !look.skin && look.look ? look.look : look;
      const n = typeof l === 'object' && l && ('color' in l || 'emblem' in l || 'gunSkins' in l || /-/.test(String(l.skin || ''))) ? (fromAccount(l) || normLook('std')) : normLook(l || state.look);
      pv.setLook(n); pv.pose(opts.clip || 'Idle_Loop', opts.t ?? .3); pv.frame(w, h, opts.yaw ?? -.45, opts.dist ?? 4.6, opts.ty ?? .95);
      const lightK = opts.dark ? .18 : 1; pv.scene.traverse(o => { if (o.isLight) { if (o.userData.i0 === undefined) o.userData.i0 = o.intensity; o.intensity = o.userData.i0 * lightK; } }); pv.renderer.toneMappingExposure = opts.dark ? .75 : .95;
      if (opts.silhouette) pv.scene.overrideMaterial = SIL_MAT || (SIL_MAT = new T.MeshBasicMaterial({ color: 0x000000 }));
      const fl = pv.floor.visible; if (opts.silhouette) pv.floor.visible = false;
      const src = pv.render(); pv.scene.overrideMaterial = null; pv.floor.visible = fl; cv.width = w; cv.height = h; const g = cv.getContext('2d'); g.clearRect(0, 0, w, h); g.drawImage(src, 0, 0, w, h); res(cv);
    };
    go();
  });
}

/* ======================================================================================= measuring: silhouette fairness, per-bone volumes, animation integrity */
// renders the skin (red) and the game's hitboxes (green) from a view; returns pixel areas
let MZ = null;
function measureStage() {
  const pv = stage(); if (!pv) return null; if (MZ) return MZ;
  const rt = new T.WebGLRenderTarget(256, 256), cam = new T.OrthographicCamera(-1.15, 1.15, 2.2, -.1, -10, 10);
  const vis = new T.MeshBasicMaterial({ color: 0xff0000, blending: T.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true });
  const hb = new T.MeshBasicMaterial({ color: 0x00ff00, blending: T.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true });
  // the game's own hitbox shapes, attached exactly as buildBot does
  const HB = gv('HB'); const geo = HB ? HB : { head: new T.SphereGeometry(.15, 10, 8), chest: new T.BoxGeometry(.46, .46, .32), pelvis: new T.BoxGeometry(.38, .26, .28), thigh: new T.CapsuleGeometry(.095, .3, 2, 8), shin: new T.CapsuleGeometry(.08, .32, 2, 8), arm: new T.CapsuleGeometry(.07, .2, 2, 8) };
  const model = pv.model, bone = n => model.getObjectByName('mixamorig' + n), boxes = [], _v = V();
  model.updateMatrixWorld(true);
  const hit = (b, g, oy) => { if (!b) return; const s = b.getWorldScale(_v).x || 1; const m = new T.Mesh(g, hb); m.scale.setScalar(1 / s); m.position.set(0, oy / s, 0); m.visible = false; b.add(m); boxes.push(m); };
  hit(bone('Head'), geo.head, .1); hit(bone('Spine1'), geo.chest, .1); hit(bone('Hips'), geo.pelvis, 0);
  for (const s of ['Left', 'Right']) { hit(bone(s + 'UpLeg'), geo.thigh, .22); hit(bone(s + 'Leg'), geo.shin, .22); hit(bone(s + 'Arm'), geo.arm, .14); hit(bone(s + 'ForeArm'), geo.arm, .13); }
  MZ = { rt, cam, vis, hb, boxes, buf: new Uint8Array(256 * 256 * 4) };
  return MZ;
}
function silhouette(look, view, clip = 'Idle_Loop', t = .3) {
  const pv = stage(), mz = measureStage(); if (!pv || !mz) return null;
  pv.setLook(look); pv.pose(clip, t); pv.root.rotation.y = view; pv.root.updateMatrixWorld(true);
  const r = pv.renderer, sc = pv.scene, keep = [];
  const meshes = []; pv.model.traverse(o => { if (o.isSkinnedMesh && o.visible) meshes.push([o, o.material]); });
  sc.traverse(o => { if (o.isMesh || o.isLight) keep.push([o, o.visible]); }); for (const [o] of keep) if (o.isMesh) o.visible = false;
  for (const [o] of meshes) { o.visible = true; o.material = mz.vis; }
  for (const b of mz.boxes) b.visible = true;
  const prevT = r.getRenderTarget(), cc = r.getClearColor(new T.Color()), ca = r.getClearAlpha(); r.setRenderTarget(mz.rt); r.setClearColor(0, 1); r.clear(); r.render(sc, mz.cam); r.readRenderTargetPixels(mz.rt, 0, 0, 256, 256, mz.buf); r.setRenderTarget(prevT); r.setClearColor(cc, ca);
  for (const [o, m] of meshes) o.material = m; for (const b of mz.boxes) b.visible = false; for (const [o, v] of keep) o.visible = v;
  let vis = 0, hit = 0, both = 0; const d = mz.buf; for (let i = 0; i < d.length; i += 4) { const a = d[i] > 40, h = d[i + 1] > 40; if (a) vis++; if (h) hit++; if (a && h) both++; }
  if (silhouette.keep) silhouette.last = d.slice();
  return { vis, hit, both };
}
const VIEWS = [['front', 0], ['side', Math.PI / 2], ['threeQ', -Math.PI / 4], ['back', Math.PI]];
const POSES = [['idle', 'Idle_Loop', .3], ['run', 'Sprint_Loop', .2], ['crouch', 'Crouch_Idle_Loop', .5]];
// silhouette numbers for one look vs the standard soldier, plus per-bone bind-space volumes
function measure(look, opts = {}) {
  const n = normLook(look), std = normLook({ skin: 'std', v: n.v }), rows = [];
  for (const [pn, clip, t] of opts.poses || POSES) for (const [vn, yaw] of opts.views || VIEWS) {
    const a = silhouette(n, yaw, clip, t), b = silhouette(std, yaw, clip, t); if (!a || !b) continue;
    rows.push({ pose: pn, view: vn, area: a.vis / b.vis, overhang: (a.vis - a.both) / b.vis, stdOverhang: (b.vis - b.both) / b.vis, coverage: a.both / a.hit, stdCoverage: b.both / b.hit });
  }
  const worst = k => rows.reduce((m, r) => Math.max(m, Math.abs(r[k] - (k === 'area' ? 1 : 0))), 0);
  return { look: lookCode(n), rows, maxAreaDev: worst('area'), maxExtraOverhang: rows.reduce((m, r) => Math.max(m, r.overhang - r.stdOverhang), -1), minCoverageDelta: rows.reduce((m, r) => Math.min(m, r.coverage - r.stdCoverage), 1), volumes: volumes(n) };
}
const VOL_BONES = ['Head', 'Neck', 'Spine2', 'Spine1', 'Spine', 'Hips', 'LeftArm', 'LeftForeArm', 'RightArm', 'RightForeArm', 'LeftUpLeg', 'LeftLeg', 'RightUpLeg', 'RightLeg'];
function volumes(look) {   // per-bone axis-aligned boxes of the visible geometry in bind space (cm), by dominant bone weight
  const n = normLook(look), g = buildSkinGeo(n.skin, n.h), base = baseInit(); if (!g) return null;
  const p = g.attributes.position.array, si = g.attributes.skinIndex.array, sw = g.attributes.skinWeight.array, ix = g.index.array, used = new Uint8Array(p.length / 3); for (const i of ix) used[i] = 1;
  const box = {};
  for (let i = 0; i < used.length; i++) { if (!used[i]) continue; let b = 0, w = -1; for (let k = 0; k < 4; k++) if (sw[i * 4 + k] > w) { w = sw[i * 4 + k]; b = si[i * 4 + k]; } let nm = base.names[b]; if (/Hand/.test(nm)) nm = nm.startsWith('Left') ? 'LeftForeArm' : 'RightForeArm'; if (/Shoulder/.test(nm)) nm = 'Spine2'; if (/Foot|Toe/.test(nm)) nm = nm.startsWith('Left') ? 'LeftLeg' : 'RightLeg'; if (nm === 'HeadTop_End') nm = 'Head';
    const e = box[nm] || (box[nm] = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9]); for (let k = 0; k < 3; k++) { e[k] = Math.min(e[k], p[i * 3 + k]); e[k + 3] = Math.max(e[k + 3], p[i * 3 + k]); } }
  const out = {}; for (const k of VOL_BONES) if (box[k]) out[k] = box[k].map(v => Math.round(v * 10) / 10); return out;
}
// animation integrity: CPU-skin the merged mesh in several poses (bind units = cm).
//  stretch: attachment triangle edges vs the bind pose (base body edges reported alongside for reference)
//  detach: every attachment must keep touching something: of its contact points (<= 2.5 cm from other geometry in the bind pose)
//          at least one must stay within +1.5 cm in every pose; detachCm = the worst part's smallest gap growth
function animCheck(look, clips = [['Walk_Loop', .4], ['Sprint_Loop', .25], ['Crouch_Fwd_Loop', .5], ['Death01', 1.2], ['Pistol_Reload', .8]]) {
  const pv = stage(); const n = normLook(look); pv.setLook(n);
  let body = null; pv.model.traverse(o => { if (o.isSkinnedMesh && !/visor/i.test(o.name)) body = o; });
  const g = body.geometry, info = g.userData.s9, base = baseInit(), N0 = base.n, total = g.attributes.position.count, ix = g.index.array, pos = g.attributes.position.array, out = [];
  const used = new Uint8Array(total); for (const i of ix) used[i] = 1;
  const owner = new Int32Array(total).fill(-1); info.parts.forEach(([o, c], k) => { for (let i = o; i < o + c; i++) owner[i] = k; });
  const tris = [], baseTris = []; for (let t = 0; t < ix.length; t += 3) (ix[t] >= N0 ? tris : baseTris).push(t);
  const step = Math.max(1, Math.floor(tris.length / 1500)), bstep = Math.max(1, Math.floor(baseTris.length / 1500));
  // contact = closest point on another piece's triangle (body or other part) within 2.5 cm in the bind pose (exact, barycentric)
  const tri = []; for (let t = 0; t < ix.length; t += 3) tri.push(t);
  const P0 = i => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]], CELL = 8, tg = new Map();
  for (const t of tri) { const a = P0(ix[t]), b = P0(ix[t + 1]), c = P0(ix[t + 2]), key = `${Math.floor((a[0] + b[0] + c[0]) / 3 / CELL)}|${Math.floor((a[1] + b[1] + c[1]) / 3 / CELL)}|${Math.floor((a[2] + b[2] + c[2]) / 3 / CELL)}`; let l = tg.get(key); if (!l) tg.set(key, l = []); l.push(t); }
  const closest = (p, a, b, c) => {   // Ericson: closest point on triangle -> [dist, u, v, w]
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]], dot = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
    const d1 = dot(ab, ap), d2 = dot(ac, ap); let u, v, w;
    if (d1 <= 0 && d2 <= 0) { u = 1; v = 0; w = 0; } else { const bp = [p[0] - b[0], p[1] - b[1], p[2] - b[2]], d3 = dot(ab, bp), d4 = dot(ac, bp);
      if (d3 >= 0 && d4 <= d3) { u = 0; v = 1; w = 0; } else { const vc = d1 * d4 - d3 * d2;
        if (vc <= 0 && d1 >= 0 && d3 <= 0) { const t = d1 / (d1 - d3); u = 1 - t; v = t; w = 0; } else { const cp = [p[0] - c[0], p[1] - c[1], p[2] - c[2]], d5 = dot(ab, cp), d6 = dot(ac, cp);
          if (d6 >= 0 && d5 <= d6) { u = 0; v = 0; w = 1; } else { const vb = d5 * d2 - d1 * d6;
            if (vb <= 0 && d2 >= 0 && d6 <= 0) { const t = d2 / (d2 - d6); u = 1 - t; v = 0; w = t; } else { const va = d3 * d6 - d5 * d4;
              if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const t = (d4 - d3) / ((d4 - d3) + (d5 - d6)); u = 0; v = 1 - t; w = t; } else { const den = 1 / (va + vb + vc); v = vb * den; w = vc * den; u = 1 - v - w; } } } } } }
    const q = [a[0] * u + b[0] * v + c[0] * w, a[1] * u + b[1] * v + c[1] * w, a[2] * u + b[2] * v + c[2] * w]; return [Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]), u, v, w]; };
  // samples per part: its vertices + triangle centroids (long primitives touch along faces, not at vertices)
  const partTris = info.parts.map(() => []); for (let t = 0; t < ix.length; t += 3) { const o = owner[ix[t]]; if (o >= 0) partTris[o].push(t); }
  const contacts = info.parts.map(() => []);
  info.parts.forEach(([o, c], k) => {
    const samples = []; for (let i = o; i < o + c; i++) if (used[i]) samples.push([[i, 1]]);
    for (const t of partTris[k]) samples.push([[ix[t], 1 / 3], [ix[t + 1], 1 / 3], [ix[t + 2], 1 / 3]]);
    const stepS = Math.max(1, Math.floor(samples.length / 160));
    for (let si = 0; si < samples.length; si += stepS) { const sm = samples[si], p = [0, 0, 0]; for (const [i, w] of sm) { p[0] += pos[i * 3] * w; p[1] += pos[i * 3 + 1] * w; p[2] += pos[i * 3 + 2] * w; }
      const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL), cz = Math.floor(p[2] / CELL); let best = null;
      for (let x = cx - 2; x <= cx + 2; x++) for (let y = cy - 2; y <= cy + 2; y++) for (let z = cz - 2; z <= cz + 2; z++) { const L = tg.get(`${x}|${y}|${z}`); if (!L) continue;
        for (const t of L) { if (owner[ix[t]] === k) continue; const r = closest(p, P0(ix[t]), P0(ix[t + 1]), P0(ix[t + 2])); if (r[0] <= 2.5 && (!best || r[0] < best[1])) best = [t, r[0], r[1], r[2], r[3]]; } }
      if (best) contacts[k].push([sm, ...best]); } });
  const free = contacts.map((c, k) => c.length ? -1 : k).filter(k => k >= 0);
  for (const [clip, t] of clips) {
    pv.pose(clip, t); pv.root.rotation.y = 0; pv.root.updateMatrixWorld(true); body.skeleton.update();
    const cache = new Map(), sk = i => { let v = cache.get(i); if (!v) { v = body.boneTransform(i, V().fromArray(pos, i * 3)); cache.set(i, v); } return v; };
    const stretch = (list, st) => { let mx = 0; const rs = []; for (let k = 0; k < list.length; k += st) { const t0 = list[k]; for (let e = 0; e < 3; e++) { const a = ix[t0 + e], b = ix[t0 + (e + 1) % 3]; const L0 = Math.hypot(pos[a * 3] - pos[b * 3], pos[a * 3 + 1] - pos[b * 3 + 1], pos[a * 3 + 2] - pos[b * 3 + 2]); if (L0 < .4) continue; const L1 = sk(a).distanceTo(sk(b)); rs.push(L1 / L0); mx = Math.max(mx, L1 / L0); } } rs.sort((x, y) => x - y); return { max: mx, p99: rs[Math.floor(rs.length * .99)] || 1 }; };
    const sp = stretch(tris, step), sb = stretch(baseTris, bstep);
    let detach = 0, worst = -1;
    contacts.forEach((c, k) => { if (!c.length) return; let m = 1e9; for (const [sm, t, d0, u, v, w] of c) { const p = V(); for (const [i, wt] of sm) p.addScaledVector(sk(i), wt); const a = sk(ix[t]), b = sk(ix[t + 1]), cc = sk(ix[t + 2]); const q = V(a.x * u + b.x * v + cc.x * w, a.y * u + b.y * v + cc.y * w, a.z * u + b.z * v + cc.z * w); m = Math.min(m, p.distanceTo(q) - d0); if (m <= 0) break; } if (m > detach) { detach = m; worst = k; } });
    out.push({ clip, t, partStretchP99: +sp.p99.toFixed(3), partStretchMax: +sp.max.toFixed(3), baseStretchP99: +sb.p99.toFixed(3), baseStretchMax: +sb.max.toFixed(3), detachCm: +Math.max(0, detach).toFixed(2), worstPart: worst });
  }
  return { look: lookCode(n), tris: info.tris, parts: info.parts.length, partsWithoutContact: free, rows: out };
}

/* ======================================================================================= Customize screen */
const CSS = `
#s9sk{position:fixed;inset:0;z-index:60;background:radial-gradient(120% 90% at 50% 35%,#1a1e26,#08090c) #0b0d10;color:var(--ink,#ece6d8);font-family:var(--mono,Consolas,monospace);display:grid;grid-template-columns:minmax(250px,330px) 1fr minmax(270px,340px);grid-template-rows:auto 1fr;gap:0 18px;padding:16px 18px;box-sizing:border-box;overflow:hidden}
#s9sk[hidden]{display:none}
#s9sk *{box-sizing:border-box}
#s9sk .hd{grid-column:1/-1;display:flex;align-items:center;gap:16px;border-bottom:1px solid var(--line,rgba(236,230,216,.18));padding-bottom:10px;min-width:0}
#s9sk .hd h2{font-family:var(--display,Impact,sans-serif);font-weight:900;font-size:clamp(30px,4vw,46px);line-height:.9;margin:0;letter-spacing:.02em}
#s9sk .kick{font-size:11px;letter-spacing:.28em;text-transform:uppercase;color:var(--sodium,#ff9a3c)}
#s9sk .tabs{display:flex;gap:6px;margin-left:auto}
#s9sk button{font:inherit;color:inherit;cursor:pointer}
#s9sk .tab{border:1px solid var(--line,rgba(236,230,216,.18));background:transparent;padding:9px 14px;font-size:12px;letter-spacing:.16em;text-transform:uppercase}
#s9sk .tab[aria-selected=true]{background:var(--sodium,#ff9a3c);color:#14100b;border-color:transparent}
#s9sk .x{border:0;background:transparent;font-size:26px;line-height:1;padding:4px 8px;color:var(--dim,#8b9097)}
#s9sk .x:hover{color:var(--ink,#ece6d8)}
#s9sk .col{min-height:0;overflow:auto;padding:12px 2px 18px;scrollbar-width:thin}
#s9sk .lab{font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--dim,#8b9097);margin:14px 0 8px}
#s9sk .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
#s9sk .card{position:relative;text-align:left;border:1px solid var(--line,rgba(236,230,216,.18));background:rgba(236,230,216,.03);padding:0 0 8px;min-width:0;overflow:hidden;transition:border-color .15s,transform .15s}
#s9sk .card:hover{border-color:rgba(236,230,216,.45)}
#s9sk .card:focus-visible,#s9sk .tab:focus-visible,#s9sk .sw:focus-visible,#s9sk .em:focus-visible,#s9sk .tog:focus-visible{outline:2px solid var(--cyan,#7fe7ff);outline-offset:2px}
#s9sk .card[aria-pressed=true]{border-color:var(--sodium,#ff9a3c);box-shadow:inset 0 0 0 1px var(--sodium,#ff9a3c)}
#s9sk .card .th{display:block;width:100%;aspect-ratio:3/4;object-fit:cover;background:linear-gradient(180deg,rgba(255,255,255,.04),rgba(0,0,0,.25))}
#s9sk .card b{display:block;font-family:var(--display,Impact,sans-serif);font-size:18px;letter-spacing:.02em;padding:6px 8px 0;line-height:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#s9sk .card i{display:block;font-style:normal;font-size:10px;letter-spacing:.14em;text-transform:uppercase;padding:3px 8px 0}
#s9sk .card .rb{position:absolute;left:0;top:0;right:0;height:3px}
#s9sk .card.lock .th{filter:grayscale(1) brightness(.45)}
#s9sk .card .lk{position:absolute;inset:auto 6px 46px 6px;display:flex;flex-direction:column;align-items:center;gap:2px;font-size:10px;letter-spacing:.1em;text-transform:uppercase;text-align:center;color:var(--ink,#ece6d8);pointer-events:none}
#s9sk .card .lk svg{width:22px;height:22px;opacity:.9}
#s9sk .card .lk .pr{display:inline-flex;align-items:center;gap:4px;color:var(--cyan,#7fe7ff);font-size:12px;letter-spacing:.04em}#s9sk .card .lk .pr svg,#s9sk .pill svg{width:12px;height:12px}
#s9sk .stagewrap{position:relative;min-height:0;display:grid;grid-template-rows:1fr auto}
#s9sk .stage{position:relative;min-height:0;touch-action:none;cursor:grab}
#s9sk .stage:active{cursor:grabbing}
#s9sk .stage canvas{position:absolute;inset:0;width:100%!important;height:100%!important;display:block}
#s9sk .meta{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 14px;padding:6px 4px 10px}
#s9sk .meta h3{font-family:var(--display,Impact,sans-serif);font-size:clamp(26px,3.2vw,38px);margin:0;line-height:.9}
#s9sk .meta p{margin:0;color:var(--dim,#8b9097);font-size:12px;flex-basis:100%}
#s9sk .pill{font-size:10px;letter-spacing:.16em;text-transform:uppercase;padding:3px 7px;border:1px solid currentColor}
#s9sk .hint{position:absolute;left:8px;bottom:8px;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim,#8b9097);pointer-events:none}
#s9sk .zoom{position:absolute;right:8px;bottom:8px;display:flex;gap:6px}
#s9sk .zoom button{width:34px;height:34px;border:1px solid var(--line,rgba(236,230,216,.18));background:rgba(11,13,16,.6);font-size:18px}
#s9sk .row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
#s9sk .sw{width:26px;height:26px;border:1px solid rgba(255,255,255,.25);padding:0}
#s9sk .sw[aria-pressed=true]{outline:2px solid var(--ink,#ece6d8);outline-offset:2px}
#s9sk .pick{position:relative;width:26px;height:26px;border:1px dashed rgba(255,255,255,.45);display:grid;place-items:center;font-size:14px;overflow:hidden}
#s9sk .pick input{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%}
#s9sk .ems{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:6px}
#s9sk .em{position:relative;aspect-ratio:1;border:1px solid var(--line,rgba(236,230,216,.18));background:rgba(236,230,216,.04);padding:4px}
#s9sk .em canvas{width:100%;height:100%;display:block}
#s9sk .em[aria-pressed=true]{border-color:var(--sodium,#ff9a3c);background:rgba(255,154,60,.12)}
#s9sk .em.lock canvas{opacity:.25}
#s9sk .em.lock::after{content:attr(data-lv);position:absolute;inset:auto 0 2px 0;text-align:center;font-size:9px;color:var(--dim,#8b9097)}
#s9sk .tog{display:flex;align-items:center;gap:10px;border:1px solid var(--line,rgba(236,230,216,.18));background:transparent;padding:9px 12px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;width:100%;justify-content:space-between}
#s9sk .tog s{display:inline-block;width:34px;height:18px;border-radius:9px;background:rgba(255,255,255,.18);position:relative;text-decoration:none}
#s9sk .tog s::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--ink,#ece6d8);transition:transform .15s}
#s9sk .tog[aria-pressed=true] s{background:var(--sodium,#ff9a3c)}#s9sk .tog[aria-pressed=true] s::after{transform:translateX(16px)}
#s9sk .go{font-family:var(--display,Impact,sans-serif);font-weight:900;font-size:22px;letter-spacing:.08em;text-transform:uppercase;color:#14100b;background:var(--sodium,#ff9a3c);border:0;padding:12px 22px 10px;width:100%;margin-top:16px;clip-path:polygon(0 0,100% 0,100% 70%,calc(100% - 12px) 100%,0 100%)}
#s9sk .ghost{border:1px solid var(--line,rgba(236,230,216,.18));background:transparent;padding:9px 12px;font-size:11px;letter-spacing:.14em;text-transform:uppercase}
#s9sk .note{font-size:11px;color:var(--dim,#8b9097);min-height:16px;margin-top:8px}
#s9sk .wlist{display:flex;gap:6px;overflow:auto;padding-bottom:6px}
#s9sk .wlist button{flex:0 0 auto;border:1px solid var(--line,rgba(236,230,216,.18));background:transparent;padding:7px 10px;font-size:11px;letter-spacing:.1em;text-transform:uppercase}
#s9sk .wlist button[aria-pressed=true]{border-color:var(--sodium,#ff9a3c);color:var(--sodium,#ff9a3c)}
#s9sk .soon{border:1px dashed var(--line,rgba(236,230,216,.18));padding:18px;color:var(--dim,#8b9097);font-size:12px;line-height:1.6}
@media (max-width:980px){
  #s9sk{display:flex;flex-direction:column;padding:12px 16px 24px;overflow-y:auto;overflow-x:hidden}
  #s9sk .stagewrap{flex:none;height:max(300px,46vh);order:2}
  #s9sk .col{flex:none;overflow:visible}
  #s9sk .col.opts{order:3;padding-top:4px}
  #s9sk .col.skins{order:4}
  #s9sk .grid{grid-template-columns:repeat(3,minmax(0,1fr))}
  #s9sk .hd h2{font-size:30px}
}
@media (max-width:520px){
  #s9sk .grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  #s9sk .hd{flex-wrap:wrap}
  #s9sk .tabs{margin-left:0;order:3;width:100%}
  #s9sk .tab{flex:1}
  #s9sk .ems{grid-template-columns:repeat(8,minmax(0,1fr))}
}
@media (prefers-reduced-motion:reduce){#s9sk .card,#s9sk .tog s::after{transition:none}}
`;
const LOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="10" rx="1"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
let UI = null;
function ensureUI() {
  if (UI) return UI;
  const st = document.createElement('style'); st.id = 's9skCss'; st.textContent = CSS; document.head.appendChild(st);
  const root = document.createElement('div'); root.id = 's9sk'; root.hidden = true; root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Customize');
  root.innerHTML = `<div class="hd"><div><div class="kick">Customize</div><h2>Your look</h2></div>
      <div class="tabs" role="tablist"><button class="tab" role="tab" data-tab="soldier" aria-selected="true">Soldier</button><button class="tab" role="tab" data-tab="weapons" aria-selected="false">Weapons</button></div>
      <button class="x" data-close aria-label="Close">×</button></div>
    <div class="col skins" data-pane="list"></div>
    <div class="stagewrap"><div class="stage" aria-label="3D preview: drag to turn, scroll or pinch to zoom"><div class="hint">Drag to turn · scroll to zoom</div><div class="zoom"><button data-zoom="-1" aria-label="Zoom out">−</button><button data-zoom="1" aria-label="Zoom in">+</button></div></div><div class="meta"></div></div>
    <div class="col opts" data-pane="opts"></div>`;
  document.body.appendChild(root);
  UI = { root, tab: 'soldier', sel: null, yaw: -.45, zoom: 0, auto: true, drag: null, pts: new Map(), raf: 0, last: 0, weapon: null };
  root.addEventListener('click', onClick); root.addEventListener('input', onInput);
  document.addEventListener('keydown', e => { if (!root.hidden && e.key === 'Escape') { e.stopPropagation(); closeUI(); } }, true);
  const stg = root.querySelector('.stage');
  stg.addEventListener('pointerdown', e => { if (e.target.closest('button')) return; stg.setPointerCapture(e.pointerId); UI.pts.set(e.pointerId, [e.clientX, e.clientY]); UI.auto = false; });
  stg.addEventListener('pointermove', e => { const p = UI.pts.get(e.pointerId); if (!p) return; const dx = e.clientX - p[0], dy = e.clientY - p[1];
    if (UI.pts.size === 1) UI.yaw += dx * .012; else if (UI.pts.size === 2) { const [a, b] = [...UI.pts.values()], d0 = Math.hypot(a[0] - b[0], a[1] - b[1]); UI.pts.set(e.pointerId, [e.clientX, e.clientY]); const [c, d] = [...UI.pts.values()]; UI.zoom = clamp(UI.zoom + (Math.hypot(c[0] - d[0], c[1] - d[1]) - d0) * .004, 0, 1); return; }
    UI.pts.set(e.pointerId, [e.clientX, e.clientY]); void dy; });
  const up = e => { UI.pts.delete(e.pointerId); }; stg.addEventListener('pointerup', up); stg.addEventListener('pointercancel', up);
  stg.addEventListener('wheel', e => { e.preventDefault(); UI.zoom = clamp(UI.zoom - Math.sign(e.deltaY) * .12, 0, 1); }, { passive: false });
  return UI;
}
function openUI(tab) {
  ensureUI(); const pv = stage(); if (!pv) { setTimeout(() => openUI(tab), 300); return; }
  loadState(); refreshInventory(); UI.sel = state.look.skin; UI.tab = tab === 'weapons' ? 'weapons' : 'soldier'; UI.root.hidden = false; UI.auto = true;
  const stg = UI.root.querySelector('.stage'); if (pv.renderer.domElement.parentNode !== stg) stg.prepend(pv.renderer.domElement);
  render(); cancelAnimationFrame(UI.raf); UI.last = performance.now(); UI.raf = requestAnimationFrame(loop);
  const t = UI.root.querySelector('.tab[aria-selected=true]'); if (t) t.focus({ preventScroll: true });
}
function closeUI() { if (!UI || UI.root.hidden) return; UI.root.hidden = true; cancelAnimationFrame(UI.raf); const pv = PV; if (pv && pv.renderer.domElement.parentNode) pv.renderer.domElement.remove(); }
const isOpen = () => !!(UI && !UI.root.hidden);
function shownLook() { const s = UI.sel || state.look.skin; if (s === state.look.skin) return state.look; const per = state.per[s] || {}; return normLook(Object.assign({ skin: s, emb: state.look.emb }, per)); }
function loop(t) {
  if (!isOpen()) return; UI.raf = requestAnimationFrame(loop);
  const dt = Math.min(.05, (t - UI.last) / 1000); UI.last = t; const pv = PV; if (!pv) return;
  if (UI.tab === 'weapons') return;
  if (UI.auto) UI.yaw += dt * .35;
  const stg = UI.root.querySelector('.stage'), r = stg.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1), w = Math.max(2, Math.round(r.width * dpr)), h = Math.max(2, Math.round(r.height * dpr));
  pv.setLook(shownLook()); if (pv.clip !== 'Idle_Loop') pv.pose('Idle_Loop', 0); pv.mixer.update(dt);
  const z = UI.zoom, aspect = w / h, fit = aspect < .8 ? 1.25 / aspect : 1;
  pv.renderer.setPixelRatio(1); pv.frame(w, h, UI.yaw, lerp(4.4 * fit, 1.6, z), lerp(.95, 1.55, z), 30);
  pv.render();
}
const SHARD_SVG = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M8 1l5 5-5 9-5-9z" fill="#7fe7ff" stroke="#e9fbff" stroke-width=".8"/></svg>';
const fmtPrice = p => p == null ? '' : `${SHARD_SVG} ${Number(p).toLocaleString('en-US')}`;
function skinCard(s, L) {
  const lock = !owns(s.id), it = itemOf(s.id), r = RARITY[s.rarity], lvl = it.minLevel || s.level;
  return `<button class="card${lock ? ' lock' : ''}" data-skin="${s.id}" aria-pressed="${UI.sel === s.id}" aria-label="${escH(s.name)}${lock ? ', locked until level ' + s.level : ''}">
    <span class="rb" style="background:${r.col}"></span><img class="th" alt="" loading="lazy" src="${escH(THUMB[s.id] || `assets/ui/skins/${s.id}.png`)}" onerror="this.style.visibility='hidden'">
    ${lock ? `<span class="lk">${LOCK_SVG}${it.price != null ? `<span class="pr">${fmtPrice(it.price)}</span>` : ''}<span>${L >= lvl ? 'In the shop' : 'Lv ' + lvl + ' to buy'}</span></span>` : ''}
    <b>${escH(s.name)}</b><i style="color:${r.col}">${r.name}${lock ? '' : ' · owned'}</i></button>`;
}
function render() {
  const L = playerLevel(), root = UI.root;
  root.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === UI.tab)));
  const list = root.querySelector('[data-pane=list]'), opts = root.querySelector('[data-pane=opts]'), meta = root.querySelector('.meta'), stg = root.querySelector('.stage');
  if (UI.tab === 'weapons') { renderWeapons(list, opts, meta, stg); return; }
  stg.querySelector('.hint').hidden = false; stg.querySelector('.zoom').hidden = false; const gs = stg.querySelector('.gsv'); if (gs) gs.remove(); if (PV && PV.renderer.domElement.parentNode !== stg) stg.prepend(PV.renderer.domElement);
  list.innerHTML = `<div class="lab">Soldier skins · ${SKINS.filter(s => owns(s.id)).length}/${SKINS.length} owned</div><div class="grid">${SKINS.map(s => skinCard(s, L)).join('')}</div>`;
  const s = SKIN[UI.sel] || SKIN.std, lock = !owns(s.id), it = itemOf(s.id), lvl = it.minLevel || s.level, look = shownLook(), r = RARITY[s.rarity], worn = wornLook().skin === s.id;
  meta.innerHTML = `<h3>${escH(s.name)}</h3><span class="pill" style="color:${r.col}">${r.name}</span><span class="pill" style="color:var(--dim,#8b9097)">${lock ? (it.price != null ? fmtPrice(it.price) + ' · ' : '') + 'Lv ' + lvl + ' to buy (' + escH(levelName(lvl)) + ')' : 'Owned'}</span><p>${escH(s.tag)}</p>`;
  const sw = (slot, cur) => SWATCHES.map(c => `<button class="sw" data-slot="${slot}" data-col="${c.slice(1)}" style="background:${c}" aria-label="${slot} ${c}" aria-pressed="${cur === c.slice(1)}"></button>`).slice(0, 14).join('') + `<span class="pick" title="Any colour">+<input type="color" data-slot="${slot}" value="#${cur}" aria-label="Pick any ${slot} colour"></span>`;
  const palFor = slot => { const base = [s.pal[slot === 'p' ? 0 : slot === 's' ? 1 : 4]]; const pool = slot === 'v' ? SWATCHES.slice(28) : SWATCHES.slice(0, 28); return [...new Set(base.concat(pool))]; };
  const swRow = slot => { const cur = look[slot]; return palFor(slot).slice(0, 13).map(c => `<button class="sw" data-slot="${slot}" data-col="${c.slice(1)}" style="background:${c}" aria-label="${slot === 'p' ? 'Primary' : slot === 's' ? 'Secondary' : 'Visor'} colour ${c}" aria-pressed="${cur === c.slice(1)}"></button>`).join('') + `<span class="pick" title="Any colour">+<input type="color" data-slot="${slot}" value="#${cur}" aria-label="Pick any ${slot === 'p' ? 'primary' : slot === 's' ? 'secondary' : 'visor'} colour"></span>`; };
  void sw;
  opts.innerHTML = `<div class="lab">Primary colour</div><div class="row">${swRow('p')}</div>
    <div class="lab">Secondary colour</div><div class="row">${swRow('s')}</div>
    <div class="lab">Visor / glow colour</div><div class="row">${swRow('v')}</div>
    <div class="lab">Shoulder emblem</div><div class="ems">${EMBLEMS.map(e => `<button class="em${unlocked(e, L) ? '' : ' lock'}" data-emb="${e.id}" data-lv="Lv ${e.level}" aria-pressed="${look.emb === e.id}" aria-label="${escH(e.name)}${unlocked(e, L) ? '' : ', unlocks at level ' + e.level}" title="${escH(e.name)}${unlocked(e, L) ? '' : ' · ' + escH(levelName(e.level))}"><canvas width="64" height="64" data-embc="${e.id}"></canvas></button>`).join('')}</div>
    ${s.helmet ? `<div class="lab">Head</div><button class="tog" data-helm aria-pressed="${!!look.h}">Helmet on <s></s></button>` : ''}
    <div class="lab">Bots in your matches</div><button class="tog" data-bots aria-pressed="${state.botMode === 'random'}">Wear random skins <s></s></button>
    <div class="row" style="margin-top:12px"><button class="ghost" data-reset>Reset colours</button></div>
    ${lock ? `<button class="go" data-shop>${window.S9Shop ? 'Get in Shop' : 'Shop coming soon'}${it.price != null ? ' · ' + Number(it.price).toLocaleString('en-US') : ''}</button><div class="note">${signedIn() ? (playerLevel() >= lvl ? 'Buy it with Nine Shards to wear it.' : `Reach level ${lvl} (${escH(levelName(lvl))}) to buy it.`) : 'Sign in to buy skins and keep them on every device.'}</div>`
      : `<button class="go" data-equip>${worn ? 'Equipped' : 'Equip'}</button>`}
    <div class="note" aria-live="polite"></div>`;
  opts.querySelectorAll('canvas[data-embc]').forEach(c => { const g = c.getContext('2d'); g.clearRect(0, 0, 64, 64); if (c.dataset.embc !== 'none') emblemDraw(g, c.dataset.embc, 64); else { g.strokeStyle = 'rgba(236,230,216,.5)'; g.lineWidth = 3; g.beginPath(); g.moveTo(16, 48); g.lineTo(48, 16); g.stroke(); } });
}
function note(t) { const n = UI.root.querySelector('.note'); if (n) n.textContent = t; }
// edits apply to the skin on show; they are saved (and synced) at once when that skin is the equipped one
function edit(patch) {
  const s = UI.sel, L = playerLevel(); const cur = shownLook(), n = normLook(Object.assign({}, cur, patch, { skin: s }));
  state.per[s] = { p: n.p, s: n.s, v: n.v, h: n.h };
  if (patch.emb !== undefined) { const e = EMBLEMS[EMB_IDX[patch.emb]]; if (e && !unlocked(e, L)) { note(`${e.name} unlocks at ${levelName(e.level)} (level ${e.level}).`); return; } state.look.emb = n.emb; }
  if (state.look.skin === s) setLook(n); else saveState(false);
  render();
}
function onClick(e) {
  const t = e.target.closest('button'); if (!t || !UI.root.contains(t)) return;
  if (t.dataset.close !== undefined) return closeUI();
  if (t.dataset.tab) { UI.tab = t.dataset.tab; return render(); }
  if (t.dataset.zoom) { UI.zoom = clamp(UI.zoom + (+t.dataset.zoom) * .25, 0, 1); return; }
  if (UI.tab === 'weapons') return onWeaponClick(t);
  if (t.dataset.skin) { UI.sel = t.dataset.skin; UI.auto = true; render(); const s = SKIN[UI.sel]; if (!owns(s.id)) note(`Preview only: get ${s.name} in the shop to wear it.`); return; }
  if (t.dataset.shop !== undefined) { if (!openShop(UI.sel)) note('The shop is not open yet.'); return; }
  if (t.dataset.slot && t.dataset.col) return edit({ [t.dataset.slot]: t.dataset.col });
  if (t.dataset.emb) return edit({ emb: t.dataset.emb });
  if (t.dataset.helm !== undefined) return edit({ h: shownLook().h ? 0 : 1 });
  if (t.dataset.bots !== undefined) { state.botMode = state.botMode === 'random' ? 'standard' : 'random'; saveState(false); refreshAll(); return render(); }
  if (t.dataset.reset !== undefined) { const d = defaultLook(UI.sel); return edit({ p: d.p, s: d.s, v: d.v }); }
  if (t.dataset.equip !== undefined) { const s = SKIN[UI.sel]; if (!owns(s.id)) return note('You do not own this skin yet.'); setLook(Object.assign({}, shownLook(), { emb: state.look.emb })); render(); note(signedIn() ? 'Equipped and saved to your account.' : 'Equipped.'); }
}
function onInput(e) { const t = e.target; if (t.matches('input[type=color][data-slot]')) edit({ [t.dataset.slot]: t.value.slice(1) }); }
// Weapons tab: gun finishes come from S9GunSkins (owned by the gun-skins module)
function renderWeapons(list, opts, meta, stg) {
  const GS = window.S9GunSkins, ids = (S9().GUN_IDS || gv('GUN_IDS') || []).slice(), W = S9().WEAPONS || gv('WEAPONS') || {};
  stg.querySelector('.hint').hidden = true; stg.querySelector('.zoom').hidden = true; if (PV && PV.renderer.domElement.parentNode === stg) PV.renderer.domElement.remove();
  if (!UI.weapon || !ids.includes(UI.weapon)) UI.weapon = ids[0] || 'carbine';
  list.innerHTML = `<div class="lab">Weapons</div><div class="wlist" style="flex-wrap:wrap">${ids.map(id => `<button data-weapon="${id}" aria-pressed="${UI.weapon === id}">${escH((W[id] && W[id].name) || id)}</button>`).join('')}</div>`;
  let gsv = stg.querySelector('.gsv'); if (!gsv) { gsv = document.createElement('div'); gsv.className = 'gsv'; gsv.style.cssText = 'position:absolute;inset:0'; stg.appendChild(gsv); }
  meta.innerHTML = `<h3>${escH((W[UI.weapon] && W[UI.weapon].name) || UI.weapon)}</h3><p>${escH((W[UI.weapon] && W[UI.weapon].cls) || '')}</p>`;
  if (!GS) { gsv.innerHTML = ''; opts.innerHTML = `<div class="lab">Finishes</div><div class="soon">Weapon finishes are on the way. Your soldier look is ready to customise on the Soldier tab.</div>`; return; }
  let fins = []; try { fins = (typeof GS.list === 'function' ? GS.list(UI.weapon) : []) || []; } catch (e) { fins = []; }
  const cur = (() => { try { return typeof GS.current === 'function' ? GS.current(UI.weapon) : GS.look && GS.look[UI.weapon]; } catch (e) { return null; } })();
  opts.innerHTML = `<div class="lab">Finishes</div><div class="grid">${fins.map(f => { const id = f.id || f, lock = f.unlocked === false; const r = RARITY[f.rarity] || RARITY.common;
    return `<button class="card${lock ? ' lock' : ''}" data-finish="${escH(id)}" aria-pressed="${cur === id}"><span class="rb" style="background:${r.col}"></span><b>${escH(f.name || id)}</b><i style="color:${r.col}">${lock ? 'Lv ' + (f.level || f.unlockLevel || '?') : r.name}</i></button>`; }).join('') || '<div class="soon">No finishes for this weapon yet.</div>'}</div><div class="note" aria-live="polite"></div>`;
  try { if (typeof GS.preview === 'function') { const r = GS.preview(gsv, UI.weapon, cur || (fins[0] && (fins[0].id || fins[0]))); if (r && r.catch) r.catch(() => {}); } } catch (e) { console.warn('S9GunSkins.preview', e); }
}
function onWeaponClick(t) {
  const GS = window.S9GunSkins;
  if (t.dataset.weapon) { UI.weapon = t.dataset.weapon; return render(); }
  if (t.dataset.finish && GS) { const f = t.dataset.finish; try { for (const k of ['select', 'equip', 'setFinish']) if (typeof GS[k] === 'function') { GS[k](UI.weapon, f); break; } const gsv = UI.root.querySelector('.gsv'); if (gsv && typeof GS.preview === 'function') GS.preview(gsv, UI.weapon, f); } catch (e) { console.warn('S9GunSkins', e); } render(); }
}
// a "Customize" button next to Arsenal in the menu + pause screens (no index.html edits needed)
function injectButtons() {
  for (const id of ['btnArsenal', 'btnArsenal2']) { const a = document.getElementById(id); if (!a || document.getElementById(id + 'Skins')) continue;
    const b = document.createElement('button'); b.className = a.className || 'ghost'; b.id = id + 'Skins'; b.type = 'button'; b.textContent = 'Customize'; b.addEventListener('click', () => openUI('soldier')); a.insertAdjacentElement('afterend', b); }
}

/* ======================================================================================= portable export: one skin as a skinned glTF (embedded) on the soldier skeleton */
function bakedColours(geo, look) {
  const base = baseInit(), n = geo.attributes.position.count, uv = geo.attributes.uv.array, am = geo.attributes.aMat.array, out = new Uint8Array(n * 4);
  const img = base.map && base.map.image; let px = null, W = 0, H = 0;
  if (img) { W = img.width; H = img.height; const c = canvasOf(W, H), g = c.getContext('2d'); g.drawImage(img, 0, 0); px = g.getImageData(0, 0, W, H).data; }
  const d = SKIN[look.skin], pal = d.pal.map(h => new T.Color(h)); pal[0].set('#' + look.p); pal[1].set('#' + look.s); pal[4].set('#' + look.v); for (const c of pal) c.convertSRGBToLinear();
  const md = MATDEF[look.skin] || MATDEF.std, lin = v => Math.pow(v / 255, 2.2), col = new T.Color();
  for (let i = 0; i < n; i++) {
    const slot = am[i * 4], flags = am[i * 4 + 3], isBase = flags % 2 >= 1; let r = 0, g = 0, b = 0;
    if (px && isBase) { const x = clamp(Math.floor(uv[i * 2] * W), 0, W - 1), y = clamp(Math.floor(uv[i * 2 + 1] * H), 0, H - 1), k = (y * W + x) * 4; r = lin(px[k]); g = lin(px[k + 1]); b = lin(px[k + 2]); }
    const L = r * .2126 + g * .7152 + b * .0722;
    if (isBase && slot < -.5) {
      const mx = Math.max(r, g, b) + .004, wR = smooth(.55, .8, (r - g) / mx), wM = smooth(-.01, .09, (b - g) / mx) * (1 - wR), wO = smooth(-.03, .07, (g - r) / mx) * (1 - wM) * (1 - wR), wD = 1 - smooth(.012, .05, L);
      let wP = (1 - wR) * (1 - wM) * (1 - wO); wP *= 1 - wD; const w = [wP, wO * (1 - wD), wD, wM * (1 - wD), wR * (1 - wD)], det = [clamp(L / .48, .45, 1.2), clamp(L / .09, .5, 1.35), clamp(L / .022, .6, 1.6), clamp(L / .2, .5, 1.3), clamp(L / .12, .6, 1.3)];
      col.setRGB(0, 0, 0); for (let k = 0; k < 5; k++) col.add(pal[md.base[k]].clone().multiplyScalar(w[k] * det[k]));
    } else { col.copy(pal[Math.round(slot)] || pal[0]); if (isBase && !(flags & 16)) col.multiplyScalar(clamp(.5 + Math.sqrt(L) * .85, .55, 1.22)); }
    out[i * 4] = clamp(col.r, 0, 1) * 255; out[i * 4 + 1] = clamp(col.g, 0, 1) * 255; out[i * 4 + 2] = clamp(col.b, 0, 1) * 255; out[i * 4 + 3] = 255;
  }
  return out;
}
function exportGLTF(skinId, h) {
  const base = baseInit(), look = normLook({ skin: skinId, h: h === undefined ? (SKIN[skinId] && SKIN[skinId].helmet ? 1 : 0) : h }), geo = buildSkinGeo(look.skin, look.h);
  const ix = geo.index.array, used = new Int32Array(geo.attributes.position.count).fill(-1), order = [];
  for (const i of ix) if (used[i] < 0) { used[i] = order.length; order.push(i); }
  const N = order.length, P3 = geo.attributes.position.array, N3 = geo.attributes.normal.array, SI = geo.attributes.skinIndex.array, SW = geo.attributes.skinWeight.array, AM = geo.attributes.aMat.array, CB = bakedColours(geo, look);
  const pos = new Float32Array(N * 3), nrm = new Float32Array(N * 3), col = new Uint8Array(N * 4), jnt = new Uint8Array(N * 4), wgt = new Uint8Array(N * 4), slot = new Uint8Array(N), idx = new Uint16Array(ix.length);
  const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  order.forEach((v, i) => { for (let k = 0; k < 3; k++) { pos[i * 3 + k] = P3[v * 3 + k]; nrm[i * 3 + k] = N3[v * 3 + k]; mn[k] = Math.min(mn[k], P3[v * 3 + k]); mx[k] = Math.max(mx[k], P3[v * 3 + k]); }
    for (let k = 0; k < 4; k++) { col[i * 4 + k] = CB[v * 4 + k]; jnt[i * 4 + k] = SI[v * 4 + k]; }
    const w = [0, 1, 2, 3].map(k => Math.round(SW[v * 4 + k] * 255)); const s = w.reduce((a, c) => a + c, 0); if (s !== 255) { const m = w.indexOf(Math.max(...w)); w[m] += 255 - s; } for (let k = 0; k < 4; k++) wgt[i * 4 + k] = w[k];
    slot[i] = AM[v * 4] < 0 ? 255 : AM[v * 4]; });
  for (let i = 0; i < ix.length; i++) idx[i] = used[ix[i]];
  // nodes: Character root -> bones (rest pose), mesh node
  const bones = base.body.skeleton.bones, bi = new Map(bones.map((b, i) => [b, i])), nodes = [], top = bones[0].parent;
  nodes.push({ name: top ? top.name || 'Character' : 'Character', matrix: top ? top.matrix.toArray() : undefined, children: [] });
  bones.forEach(b => nodes.push({ name: b.name, translation: b.position.toArray(), rotation: b.quaternion.toArray(), scale: b.scale.toArray() }));
  bones.forEach((b, i) => { const kids = b.children.filter(c => bi.has(c)).map(c => bi.get(c) + 1); if (kids.length) nodes[i + 1].children = kids; });
  nodes[0].children.push(1);
  const meshNode = nodes.length; nodes.push({ name: 's9_' + look.skin, mesh: 0, skin: 0 }); nodes[0].children.push(meshNode);
  // binary layout
  const parts = [], views = [], acc = []; let off = 0;
  const addView = (arr, target) => { const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), pad = (4 - (bytes.length % 4)) % 4; parts.push(bytes, new Uint8Array(pad)); views.push({ buffer: 0, byteOffset: off, byteLength: bytes.length, target }); off += bytes.length + pad; return views.length - 1; };
  const addAcc = (arr, type, ct, count, extra = {}, target = 34962) => { acc.push(Object.assign({ bufferView: addView(arr, target), componentType: ct, count, type }, extra)); return acc.length - 1; };
  const ibm = new Float32Array(bones.length * 16); base.body.skeleton.boneInverses.forEach((m, i) => ibm.set(m.elements, i * 16));
  const A = { POSITION: addAcc(pos, 'VEC3', 5126, N, { min: mn, max: mx }), NORMAL: addAcc(nrm, 'VEC3', 5126, N), COLOR_0: addAcc(col, 'VEC4', 5121, N, { normalized: true }), JOINTS_0: addAcc(jnt, 'VEC4', 5121, N), WEIGHTS_0: addAcc(wgt, 'VEC4', 5121, N, { normalized: true }), _SLOT: addAcc(slot, 'SCALAR', 5121, N) };
  const I = addAcc(idx, 'SCALAR', 5123, idx.length, {}, 34963), IB = acc.push({ bufferView: addView(ibm), componentType: 5126, count: bones.length, type: 'MAT4' }) - 1;
  const total = new Uint8Array(off); let o = 0; for (const pt of parts) { total.set(pt, o); o += pt.length; }
  let bin = ''; for (let i = 0; i < total.length; i += 8192) bin += String.fromCharCode.apply(null, total.subarray(i, i + 8192));
  const d = SKIN[look.skin];
  const gltf = { asset: { version: '2.0', generator: 'Sector Nine skins.js export' }, scene: 0, scenes: [{ nodes: [0] }], nodes,
    meshes: [{ name: 's9_' + look.skin, primitives: [{ attributes: A, indices: I, material: 0 }] }],
    skins: [{ name: 'soldier', joints: bones.map((_, i) => i + 1), inverseBindMatrices: IB, skeleton: 1 }],
    materials: [{ name: 's9skin', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: .2, roughnessFactor: .6 } }],
    accessors: acc, bufferViews: views, buffers: [{ byteLength: off, uri: 'data:application/octet-stream;base64,' + btoa(bin) }],
    extras: { skin: look.skin, name: d.name, helmet: !!look.h, units: 'centimetres in bind space (+Z up, +Y forward); the Character node scales to metres', slots: ['primary', 'secondary', 'dark', 'accent', 'glow', 'light', 'extra', 'metal'], palette: d.pal, look: lookCode(look),
      note: '_SLOT per vertex = colour slot (255 = soldier texture class: plate->primary, cloth->secondary, dark->dark, metal->metal, stripe->accent). COLOR_0 = baked default colours. Hitboxes are NOT part of the skin: use the standard soldier hit shapes.' } };
  return JSON.stringify(gltf);
}

/* ======================================================================================= external skins (data/skins2.json + glTF models on the soldier skeleton)
   Contract (also in skins.INTEGRATE.md):
   data/skins2.json = { "skins": [ { "id": "ninja", "name": "...", "rarity": "common|rare|epic|legendary", "level": 15, "desc": "...",
       "pal": ["#primary","#secondary","#dark","#accent","#glow","#light","#extra","#metal"], "model": "assets/models/skins2/ninja.gltf.json",
       "modelHelmet": "...optional helmet-on variant...", "keepBase": "hands" | "none" | "all", "keepVisor": false,
       "pattern": ["weave", tintAmount, grime, glow, reliefCm] (optional), "hands": [gloveSlot, sleeveSlot] (optional) } ] }
   Each model: glTF 2.0 (embedded buffers) with SkinnedMesh(es) bound to the soldier skeleton (joint names mixamorig*: same as
   assets/models/soldier.gltf.json). Material name = colour slot: primary | secondary | dark | accent | glow | light | extra | metal | team
   (+ "_pat" suffix to apply the skin's pattern, e.g. "primary_pat"; "emblem" = shoulder emblem patch, needs UVs 0..1).
   Meshes parented directly to a bone (not skinned) are bound rigidly to that bone. An entry with an id this module already has
   replaces it (same order, so online look codes stay stable); new ids are appended. */
const SLOT_NAMES = { primary: 0, secondary: 1, dark: 2, accent: 3, glow: 4, visor: 4, light: 5, extra: 6, metal: 7, team: 8, emblem: 2 };
const EXT = {};
const normBone = n => String(n || '').replace(/^mixamorig[:_]?/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
const LOADS = [];
function loadSkins2() {
  if (!window.fetch) return Promise.resolve();
  return fetch('data/skins2.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(j => { const ps = []; if (j && Array.isArray(j.skins)) for (const e of j.skins) { try { const p = registerExternal(e); if (p) ps.push(p); } catch (err) { console.warn('skins2', e && e.id, err); } } return Promise.all(ps); }).catch(() => {});
}
const EXTGEO = {}, THUMB = {};
function registerExternal(e) {
  if (!e || !/^[a-z][a-z0-9]{1,15}$/.test(e.id || '') || !e.model || !/^[\w./-]+$/.test(e.model)) return;
  const sl = e.slots && typeof e.slots === 'object' ? [e.slots.primary, e.slots.secondary, e.slots.dark, e.slots.accent, e.slots.visor || e.slots.glow, e.slots.light, e.slots.extra, e.slots.metal] : e.pal;
  const pal = Array.isArray(sl) && sl.length >= 8 && sl.slice(0, 8).every(h => hex6(h)) ? sl.slice(0, 8).map(h => '#' + hex6(h)) : (SKIN[e.id] ? SKIN[e.id].pal : SKIN.std.pal);
  const def = { id: e.id, name: String(e.name || e.id).slice(0, 40), rarity: RARITY[e.rarity] ? e.rarity : 'rare', level: clamp((e.level ?? e.unlockLevel) | 0 || 1, 1, 50), tag: String(e.desc || e.tag || '').slice(0, 160), pal, helmet: !!e.modelHelmet, ext: true };
  const i = SKINS.findIndex(s => s.id === e.id); if (i >= 0) SKINS[i] = def; else SKINS.push(def);
  for (const k in SKIN) delete SKIN[k]; SKINS.forEach((s, k) => { SKIN[s.id] = s; SKIN_IDX[s.id] = k; });
  const M = e.material && typeof e.material === 'object' ? e.material : null;
  MATDEF[e.id] = Object.assign({}, MATDEF[e.id] || MATDEF.std, M && Array.isArray(M.pat) ? { pat: M.pat.slice(0, 5), patCol: M.patCol ?? 5, patS: M.patS } : {}, M && Array.isArray(M.base) ? { base: M.base.slice(0, 5) } : {}, M && Array.isArray(M.crm) ? { crm: M.crm.slice(0, 5) } : {},
    Array.isArray(e.pattern) ? { pat: [String(e.pattern[0]), +e.pattern[1] || 0, +e.pattern[2] || 0, +e.pattern[3] || 0, +e.pattern[4] || 0] } : {});
  if (Array.isArray(e.hands)) HANDS[e.id] = e.hands.slice(0, 2).map(v => clamp(v | 0, 0, 7));
  if (typeof e.thumbnail === 'string' && /^[\w./-]+$/.test(e.thumbnail)) THUMB[e.id] = e.thumbnail;
  const x = EXT[e.id] = { e, data: {}, ready: false };
  const getText = url => fetch(url, { cache: 'no-store' }).then(r => r.ok ? r.text() : Promise.reject(new Error(url + ' ' + r.status)));
  const load = (url, h) => getText(url).then(txt => {
    const j = JSON.parse(txt), pr = j.meshes && j.meshes[0] && j.meshes[0].primitives[0];
    if (pr && pr.attributes && pr.attributes._MAT !== undefined) { EXTGEO[e.id + '|' + h] = completeGeo(j, e.id, h); return; }   // complete merged mesh in this module's format
    return new Promise((res, rej) => new T.GLTFLoader().parse(txt, url.replace(/[^/]*$/, ''), g => { x.data[h] = extParts(g); res(); }, rej));
  });
  const fallback = BUILD[e.id] || BUILD.std;
  BUILD[e.id] = (K, B, helmet) => {
    const d = x.ready && (x.data[helmet ? 1 : 0] || x.data[0]);
    if (!d) return fallback(K, B, helmet);
    const keep = e.keepBase || 'hands';
    if (keep === 'hands') K.remove((v, p, b) => !/Hand/.test(b)); else if (keep === 'none') K.remove(() => true);
    if (keep !== 'all') { K.noBase = true; K.slots((v, p, b) => /Hand/.test(b) ? [(HANDS[e.id] || [2])[0], .6, .05, 1 + 8] : undefined); }
    K.visor = !!e.keepVisor && keep === 'all';
    for (const p of d) K.parts.push(Object.assign({}, p, { pos: p.pos.slice(), nrm: p.nrm.slice(), idx: p.idx.slice(), si: p.si.slice(), sw: p.sw.slice(), mat: p.mat.slice(), uv: p.uv.slice(), o: { pre: true } }));
  };
  return Promise.all([load(e.model, 0), e.modelHelmet ? load(e.modelHelmet, 1) : null]).then(() => {
    x.ready = true; for (const k of [...GEO_CACHE.keys()]) if (k.startsWith(e.id + '|')) GEO_CACHE.delete(k);
    refreshAll(); if (isOpen()) render();
  }).catch(err => console.warn('skins2 model', e.id, err)).finally(() => { if (isOpen()) render(); });
}
// a glTF that already holds the complete merged mesh (this module's attributes: _MAT = aMat, joints in the soldier's order, standard IBMs)
function completeGeo(j, id, h) {
  const bufs = j.buffers.map(b => { const s = atob(String(b.uri).split(',')[1]), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u.buffer; });
  const acc = i => { const a = j.accessors[i], bv = j.bufferViews[a.bufferView], off = (bv.byteOffset || 0) + (a.byteOffset || 0), n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[a.type], C = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array }[a.componentType];
    const arr = new C(bufs[bv.buffer], off, a.count * n); return a.normalized && C === Uint8Array ? Float32Array.from(arr, v => v / 255) : a.normalized && C === Uint16Array ? Float32Array.from(arr, v => v / 65535) : arr; };
  const pr = j.meshes[0].primitives[0], A = pr.attributes, g = new T.BufferGeometry(), n = j.accessors[A.POSITION].count;
  g.setAttribute('position', new T.BufferAttribute(Float32Array.from(acc(A.POSITION)), 3));
  g.setAttribute('normal', new T.BufferAttribute(Float32Array.from(acc(A.NORMAL)), 3));
  g.setAttribute('uv', new T.BufferAttribute(A.TEXCOORD_0 !== undefined ? Float32Array.from(acc(A.TEXCOORD_0)) : new Float32Array(n * 2), 2));
  g.setAttribute('skinIndex', new T.Uint16BufferAttribute(Uint16Array.from(acc(A.JOINTS_0)), 4));
  g.setAttribute('skinWeight', new T.BufferAttribute(Float32Array.from(acc(A.WEIGHTS_0)), 4));
  g.setAttribute('aMat', new T.BufferAttribute(Float32Array.from(acc(A._MAT)), 4));
  const ix = acc(pr.indices); g.setIndex(new T.BufferAttribute(Uint32Array.from(ix), 1)); g.computeBoundingSphere(); g.computeBoundingBox();
  const ex = j.extras || {}, parts = (Array.isArray(ex.parts) ? ex.parts : []).map(p => Array.isArray(p) ? (typeof p[0] === 'string' ? [p[1] | 0, p[2] | 0] : [p[0] | 0, p[1] | 0]) : null).filter(Boolean);
  g.userData.s9 = { skin: id, variant: !!h, tris: ix.length / 3, baseTris: 0, partTris: ix.length / 3, visor: false, pat: null, nParts: parts.length, parts, external: true };
  return g;
}
// glTF scene -> parts in this module's bind space with the soldier's bone indices
function extParts(gltf) {
  const base = baseInit(), ourIdx = {}; base.names.forEach((n, i) => { ourIdx[normBone(n)] = i; });
  const ourBind = base.body.skeleton.boneInverses.map(m => m.clone().invert()), out = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse(o => {
    if (!o.isMesh) return;
    const g = o.geometry, pa = g.attributes.position, na = g.attributes.normal || (g.computeVertexNormals(), g.attributes.normal), n = pa.count, ua = g.attributes.uv;
    const groups = g.groups && g.groups.length ? g.groups : [{ start: 0, count: g.index ? g.index.count : n, materialIndex: 0 }], mats = [].concat(o.material);
    const part = { pos: new Float32Array(n * 3), nrm: new Float32Array(n * 3), uv: new Float32Array(n * 2), si: new Uint16Array(n * 4), sw: new Float32Array(n * 4), mat: new Float32Array(n * 4), idx: null };
    const M = new T.Matrix4(), N3 = new T.Matrix3(), v = V(), nv = V(), GX = ['getX', 'getY', 'getZ', 'getW'];
    let rigidBone = -1; if (!o.isSkinnedMesh) { let p = o.parent; while (p && !(p.isBone || /mixamorig/i.test(p.name))) p = p.parent; rigidBone = p ? ourIdx[normBone(p.name)] ?? -1 : -1; if (rigidBone < 0) return; }
    for (let i = 0; i < n; i++) {
      let ws = [];
      if (o.isSkinnedMesh) { for (let k = 0; k < 4; k++) { const w = g.attributes.skinWeight[GX[k]](i); if (w > 0) { const bn = o.skeleton.bones[g.attributes.skinIndex[GX[k]](i)], oi = bn ? ourIdx[normBone(bn.name)] : undefined; if (oi !== undefined) ws.push([oi, w, bn]); } } }
      else ws = [[rigidBone, 1, null]];
      if (!ws.length) ws = [[base.bone.Hips, 1, null]];
      ws.sort((a, b) => b[1] - a[1]); const s = ws.reduce((a, e) => a + e[1], 0) || 1;
      ws.forEach(([b, w], k) => { if (k < 4) { part.si[i * 4 + k] = b; part.sw[i * 4 + k] = w / s; } });
      // position: their bind -> local space of the dominant bone -> our bind space
      v.fromBufferAttribute(pa, i); nv.fromBufferAttribute(na, i);
      if (o.isSkinnedMesh) { const bn = ws[0][2], j = o.skeleton.bones.indexOf(bn); M.copy(ourBind[ws[0][0]]).multiply(o.skeleton.boneInverses[j]).multiply(o.bindMatrix); }
      else { const bone = (() => { let p = o.parent; while (p && !(p.isBone || /mixamorig/i.test(p.name))) p = p.parent; return p; })(); M.copy(ourBind[rigidBone]).multiply(bone.matrixWorld.clone().invert()).multiply(o.matrixWorld); }
      v.applyMatrix4(M); N3.getNormalMatrix(M); nv.applyMatrix3(N3).normalize();
      part.pos.set([v.x, v.y, v.z], i * 3); part.nrm.set([nv.x, nv.y, nv.z], i * 3); if (ua) { part.uv[i * 2] = ua.getX(i); part.uv[i * 2 + 1] = ua.getY(i); }
    }
    const ix = g.index ? Array.from(g.index.array) : Array.from({ length: n }, (_, i) => i); part.idx = Uint32Array.from(ix);
    for (const gr of groups) { const m = mats[gr.materialIndex || 0] || mats[0], nm = String((m && m.name) || 'primary').toLowerCase(), key = nm.replace(/_pat$/, ''), slot = SLOT_NAMES[key] ?? 0, flags = (/_pat$/.test(nm) ? 2 : 0) + (key === 'emblem' ? 4 : 0);
      for (let t = gr.start; t < gr.start + gr.count && t < ix.length; t++) { const vi = ix[t]; part.mat[vi * 4] = slot; part.mat[vi * 4 + 1] = m && m.roughness !== undefined ? m.roughness : .55; part.mat[vi * 4 + 2] = m && m.metalness !== undefined ? m.metalness : .1; part.mat[vi * 4 + 3] = flags; } }
    out.push(part);
  });
  return out;
}

/* ======================================================================================= public API */
function list() {
  const L = playerLevel();
  return SKINS.map(s => ({ id: s.id, name: s.name, rarity: s.rarity, rarityName: RARITY[s.rarity].name, level: itemOf(s.id).minLevel || s.level, unlockAt: levelName(itemOf(s.id).minLevel || s.level), unlocked: owns(s.id), owned: owns(s.id), canBuy: L >= (itemOf(s.id).minLevel || s.level), price: itemOf(s.id).price, itemId: itemOf(s.id).id, desc: s.tag,
    colors: { primary: s.pal[0], secondary: s.pal[1], visor: s.pal[4] }, helmetVariant: !!s.helmet }));
}
function applyGunSkin(weaponId, finishId, target) {
  const GS = window.S9GunSkins; if (GS && typeof GS.applyGunSkin === 'function') return GS.applyGunSkin(weaponId, finishId, target);
  if (GS && typeof GS.apply === 'function') return GS.apply(weaponId, finishId, target);
  return false;
}
function setLook(l, opts = {}) {
  const n = normLook(Object.assign({}, state.look, l));
  if (!owns(n.skin) && !opts.force) return false;
  if (EMBLEMS[EMB_IDX[n.emb]] && !unlocked(EMBLEMS[EMB_IDX[n.emb]]) && !opts.force) n.emb = state.look.emb;
  state.look = n; state.per[n.skin] = { p: n.p, s: n.s, v: n.v, h: n.h, emb: n.emb }; saveState(opts.sync !== false); applyHands(); lastSent = '';
  return true;
}
let READY = null;
function init() {
  loadState(); READY = Promise.all([loadSkins2(), loadEconomy()]).catch(() => {});
  const hookAcc = () => { const A = account(); if (!A || hookAcc.done) return; hookAcc.done = true; if (typeof A.onChange === 'function') A.onChange(() => { INV.at = 0; refreshInventory(true).then(() => pullAccount()); }); refreshInventory(true).then(() => pullAccount()); };
  hookAcc(); setTimeout(hookAcc, 2000); setTimeout(hookAcc, 8000);
  const tick = () => { try { watch(); } catch (e) { console.warn('skins', e); } };
  tick(); watchT = setInterval(tick, 400);
  const ib = () => { try { injectButtons(); } catch (e) {} }; ib(); setTimeout(ib, 1500);
  // pull the account look when the account module signs in
}
window.S9Skins = {
  version: 1,
  list, apply: (t, id, c) => apply(t, id, c), restore, applyGunSkin,
  preview: (el, look, opts) => preview(el, look, opts),
  open: tab => openUI(tab), close: () => closeUI(), get isOpen() { return isOpen(); },
  get look() { return Object.assign({}, state.look); }, setLook,
  lookCode: l => lookCode(l || state.look), parseLook: parseCode, readRemoteLook: pr => parseCode(pr && typeof pr === 'object' ? pr.lk : pr),
  toAccount, fromAccount, emblems: () => EMBLEMS.map(e => Object.assign({ unlocked: unlocked(e), unlockAt: levelName(e.level) }, e)),
  get botMode() { return state.botMode; }, set botMode(v) { state.botMode = v === 'standard' ? 'standard' : 'random'; saveState(false); refreshAll(); },
  setLevel(n) { state.level = n ? Math.max(1, n | 0) : null; },
  data: () => ({ version: 1, ranks: RANKS, rarity: RARITY, skins: SKINS.map(s => ({ id: s.id, name: s.name, rarity: s.rarity, unlockLevel: s.level, unlockRank: levelName(s.level), desc: s.tag,
    slots: { primary: s.pal[0], secondary: s.pal[1], dark: s.pal[2], accent: s.pal[3], visor: s.pal[4], light: s.pal[5], extra: s.pal[6], metal: s.pal[7] }, helmetVariant: !!s.helmet, customizable: ['primary', 'secondary', 'visor', 'emblem'].concat(s.helmet ? ['helmet'] : []) })),
    emblems: EMBLEMS.map(e => ({ id: e.id, name: e.name, unlockLevel: e.level, unlockRank: levelName(e.level) })), swatches: SWATCHES }),
  // internals used by the hooks + tests
  _onBot: r => { if (r && !r.remote) ensureRobot(r); }, _onRemote: onRemote, _onSend: onSend, _pull: () => pullAccount(), _stageCanvas: () => PV && PV.renderer.domElement, _geo: buildSkinGeo, _base: () => baseInit(), _refresh: refreshAll,
  get ready() { return READY; }, owns, refreshInventory: f => refreshInventory(f), _inv: INV, _econ: ECON,
  _measure: (...a) => measure(...a), _sil: (l, v, c, t) => { silhouette.keep = true; const r = silhouette(normLook(l), v, c, t); silhouette.keep = false; return Object.assign(r, { buf: Array.from(silhouette.last) }); }, _state: state, _anim: (l, c) => animCheck(l, c), _vol: volumes, _dbg: { BUILD, GEO_CACHE, SKIN, MATDEF, stage },
  exportGLTF,
};
init();
})();
