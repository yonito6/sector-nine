/* Sector Nine — gun finishes (window.S9GunSkins)
   Catalogue: data/gunskins.json (one entry per finish; weapon = gun id or "all" for cross-weapon collections).
   How a finish is drawn:
   - Every skinnable part of a gun keeps its geometry; only its material is swapped for a shared "finish" material
     (one per finish x part role x source-material class). Zero extra draw calls for the body.
   - Patterns are tri-planar (projected in the gun's own model space), so they never depend on UVs and look the same
     on the first-person viewmodel and the third-person model. Textures: assets/tex/gunskins/<id>_a/_m/_e.jpg
     (albedo, R roughness G metalness B height, emissive), <= 1024 px, mipmapped, loaded lazily.
   - Legendary / Mythic / collection finishes add ONE extra mesh per gun (fins, holo emitters, a duck charm) from
     assets/models/gunskins/<weapon>.gltf.json, attached to the gun body (baked by render/gunskins/bake_accents.js).
   - Sights, lenses, reticles, glow strips, muzzle flashes, hands and gloves are never touched.
   - Animated finishes run on ONE shared time uniform (game time, so they freeze when the game pauses); no per-frame allocations.
   API: list(weaponId?), get(weaponId), equipped(), apply(weaponId, skinId, target3D), applyToViewmodel(weaponId, skinId),
        preview(canvas, weaponId, skinId, opts) -> Promise, ready (Promise), applyGunSkin (alias used by S9Skins). */
(() => {
'use strict';
if (window.S9GunSkins && window.S9GunSkins.version) return;
const T = window.THREE;
const LS_KEY = 'sector9-gunskins';
const gv = name => { try { return (0, eval)(`typeof ${name} !== 'undefined' ? ${name} : undefined`); } catch (e) { return undefined; } };
const BASE = (() => { try { const s = document.currentScript && document.currentScript.src; return s && /modules\/gunskins\.js/.test(s) ? s.replace(/modules\/gunskins\.js.*$/, '') : ''; } catch (e) { return ''; } })();
const RARITY = { common: { name: 'Common', col: '#b8c0cc', i: 0 }, rare: { name: 'Rare', col: '#3d9bff', i: 1 }, epic: { name: 'Epic', col: '#b45cff', i: 2 }, legendary: { name: 'Legendary', col: '#ffb02e', i: 3 }, mythic: { name: 'Mythic', col: '#ff3d6e', i: 4 } };
const FACTORY = { id: 'factory', weapon: 'all', name: 'Factory', rarity: 'common', collection: null, unlockLevel: 1, default: true, desc: 'The finish it left the factory with.' };
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/* ======================================================================================= catalogue */
let CAT = [], BYID = new Map();
const ready = fetch(BASE + 'data/gunskins.json', { cache: 'no-cache' }).then(r => r.json()).then(d => {
  CAT = (d.skins || []).filter(s => s && ID_RE.test(s.id)); BYID = new Map(CAT.map(s => [s.id, s])); loadState(); onReady(); return true;
}).catch(e => { console.warn('gunskins: catalogue', e); return false; });
const WEAPON_IDS = () => { const g = gv('GUN_IDS'); return g ? g.slice() : []; };
function list(weaponId) {
  const out = [FACTORY];
  for (const s of CAT) if (!weaponId || s.weapon === 'all' || s.weapon === weaponId) out.push(s);
  return out.sort((a, b) => (a.default ? -1 : b.default ? 1 : 0) || RARITY[a.rarity].i - RARITY[b.rarity].i || (a.weapon === 'all') - (b.weapon === 'all'));
}
const fits = (s, w) => s && (s.id === 'factory' || s.weapon === 'all' || s.weapon === w);
const skinOf = id => id === 'factory' || !id ? FACTORY : BYID.get(id) || null;

/* ======================================================================================= player state */
const state = { eq: {} };
function loadState() {
  try { const s = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); if (s && s.eq && typeof s.eq === 'object') for (const [w, id] of Object.entries(s.eq)) if (ID_RE.test(w) && ID_RE.test(String(id)) && (id === 'factory' || BYID.has(id))) state.eq[w] = id; } catch (e) {}
}
function saveState() { try { localStorage.setItem(LS_KEY, JSON.stringify({ v: 1, eq: state.eq })); } catch (e) {} syncAccount(); }
let syncT = 0;
function syncAccount() {
  const A = window.S9Account; if (!A) return;
  clearTimeout(syncT); syncT = setTimeout(() => {
    try {
      const gunSkins = {}; for (const [w, id] of Object.entries(state.eq)) if (id && id !== 'factory') gunSkins[w] = id;
      const body = { gunSkins };
      if (typeof A.api === 'function') { const r = A.api('/api/me/look', { method: 'PUT', body }); if (r && r.catch) r.catch(() => {}); }
      else if (typeof A.putLook === 'function') A.putLook(body);
    } catch (e) {}
  }, 500);
}
function pullAccount() {
  try { const A = window.S9Account; const p = A && (typeof A.getProfile === 'function' ? A.getProfile() : A.profile); const g = p && p.look && p.look.gunSkins;
    if (!g || typeof g !== 'object' || typeof g.then === 'function') return;
    let ch = false; for (const [w, id] of Object.entries(g)) if (BYID.has(id) && fits(BYID.get(id), w) && state.eq[w] !== id) { state.eq[w] = id; ch = true; }
    if (ch) { try { localStorage.setItem(LS_KEY, JSON.stringify({ v: 1, eq: state.eq })); } catch (e) {} refreshViewmodels(); }
  } catch (e) {}
}
const get = w => state.eq[w] && skinOf(state.eq[w]) && fits(skinOf(state.eq[w]), w) ? state.eq[w] : 'factory';

/* ======================================================================================= textures (lazy, shared) */
const TEXC = new Map();
let BLACK = null;
function blackTex() { if (!BLACK) { BLACK = new T.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); BLACK.needsUpdate = true; } return BLACK; }
let GREY = null;
function greyTex() { if (!GREY) { GREY = new T.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1); GREY.needsUpdate = true; } return GREY; }
const maxAniso = () => { const r = gv('renderer'); try { return Math.min(8, r.capabilities.getMaxAnisotropy()); } catch (e) { return 4; } };
function loadTex(file, srgb) {
  if (TEXC.has(file)) return TEXC.get(file);
  const t = new T.Texture(); t.wrapS = t.wrapT = T.RepeatWrapping; t.anisotropy = maxAniso(); if (srgb) t.encoding = T.sRGBEncoding;
  t.generateMipmaps = true; t.minFilter = T.LinearMipmapLinearFilter; t.userData.gsLoaded = false;
  const img = new Image(); img.decoding = 'async';
  t.userData.gsPromise = new Promise(res => { img.onload = () => { t.image = img; t.needsUpdate = true; t.userData.gsLoaded = true; res(true); }; img.onerror = () => res(false); });
  img.src = BASE + 'assets/tex/gunskins/' + file;
  TEXC.set(file, t); return t;
}
function skinTex(s) {
  const L = s.look; if (!L) return null;
  if (!s._tex) s._tex = { a: loadTex(L.tex + '_a.jpg', true), m: loadTex(L.tex + '_m.jpg', false), e: L.emi ? loadTex(L.tex + '_e.jpg', true) : null };
  return s._tex;
}
const texReady = s => { const t = skinTex(s); return t ? Promise.all([t.a, t.m, t.e].filter(Boolean).map(x => x.userData.gsPromise)) : Promise.resolve(); };

/* ======================================================================================= shared uniforms + shader */
const U = { time: { value: 0 } };
const colLin = (hex, k = 1) => new T.Color(hex || '#ffffff').convertSRGBToLinear().multiplyScalar(k);
const GS_VERT_PARS = `
attribute vec3 gsPos; attribute vec3 gsNor;
varying vec3 vGsP; varying vec3 vGsN;
uniform float gsSc; uniform float gsUnit;`;
const GS_VERT = `
vGsP = gsPos * gsUnit * gsSc; vGsN = gsNor;`;
const GS_FRAG_PARS = `
uniform sampler2D gsA; uniform sampler2D gsM; uniform sampler2D gsE; uniform float gsSc; uniform float gsUnit;
uniform float gsTime, gsPat, gsBump, gsMode, gsSpd, gsIri, gsGi, gsRS, gsMS;
uniform vec3 gsTint, gsFlat, gsGlow, gsAxis; uniform vec2 gsRM, gsFlow;
varying vec3 vGsP; varying vec3 vGsN;
vec3 gsW; vec2 gsUx, gsUy, gsUz, gsDx1, gsDy1, gsDx2, gsDy2, gsDx3, gsDy3;
void gsGrads() { gsDx1 = dFdx(gsUx); gsDy1 = dFdy(gsUx); gsDx2 = dFdx(gsUy); gsDy2 = dFdy(gsUy); gsDx3 = dFdx(gsUz); gsDy3 = dFdy(gsUz); }   // taken in uniform control flow: the branches below sample with explicit gradients (correct mip levels)
float gsHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec2 gsWarp(vec2 uv, float k) {
  float m = gsMode, t = gsTime * gsSpd; vec2 r = uv;
  if (m > 1.5 && m < 2.5) r = uv + gsFlow * gsTime;
  else if (m > 5.5 && m < 6.5) { vec2 c = fract(uv) - .5; float rr = length(c); float a = t / (rr * 4. + .25); float s = sin(a), co = cos(a); r = floor(uv) + .5 + vec2(co * c.x - s * c.y, s * c.x + co * c.y); }
  else if (m > 4.5 && m < 5.5) { float row = floor(uv.y * 24.); float g = step(.86, gsHash(vec2(row, floor(gsTime * 9. * gsSpd)))); r = uv + vec2(g * (gsHash(vec2(row, floor(gsTime * 7.))) - .5) * .25, 0.); }
  return r;
}
vec4 gsTri(sampler2D tx, float k) {   // most gun faces are axis-aligned: one fetch instead of three
  vec4 r;
  if (gsW.x > .97) r = textureGrad(tx, gsWarp(gsUx, k), gsDx1, gsDy1);
  else if (gsW.y > .97) r = textureGrad(tx, gsWarp(gsUy, k), gsDx2, gsDy2);
  else if (gsW.z > .97) r = textureGrad(tx, gsWarp(gsUz, k), gsDx3, gsDy3);
  else r = textureGrad(tx, gsWarp(gsUx, k), gsDx1, gsDy1) * gsW.x + textureGrad(tx, gsWarp(gsUy, k), gsDx2, gsDy2) * gsW.y + textureGrad(tx, gsWarp(gsUz, k), gsDx3, gsDy3) * gsW.z;
  return r;
}
vec4 gsTriE() {
  vec4 r;
  if (gsMode > .5 && gsMode < 1.5) { vec2 o = gsFlow * gsTime; if (gsW.x > .97) r = textureGrad(gsE, gsUx + o, gsDx1, gsDy1); else if (gsW.y > .97) r = textureGrad(gsE, gsUy + o, gsDx2, gsDy2); else if (gsW.z > .97) r = textureGrad(gsE, gsUz + o, gsDx3, gsDy3); else r = textureGrad(gsE, gsUx + o, gsDx1, gsDy1) * gsW.x + textureGrad(gsE, gsUy + o, gsDx2, gsDy2) * gsW.y + textureGrad(gsE, gsUz + o, gsDx3, gsDy3) * gsW.z; }
  else r = gsTri(gsE, 1.);
  return r;
}
vec3 gsHue(float h) { return clamp(abs(mod(h * 6. + vec3(0., 4., 2.), 6.) - 3.) - 1., 0., 1.); }
vec3 gsPerturb(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDirection) {
  vec3 vSigmaX = dFdx(surf_pos.xyz); vec3 vSigmaY = dFdy(surf_pos.xyz); vec3 vN = surf_norm;
  vec3 R1 = cross(vSigmaY, vN); vec3 R2 = cross(vN, vSigmaX); float fDet = dot(vSigmaX, R1) * faceDirection;
  vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
  return normalize(abs(fDet) * surf_norm - vGrad);
}`;
// body / trim / metal parts of a gun
const GS_FRAG_MAP = `
  vec3 gsn = normalize(vGsN); gsW = pow(abs(gsn), vec3(6.)); gsW /= (gsW.x + gsW.y + gsW.z + 1e-5);
  gsUx = vGsP.zy * vec2(-sign(gsn.x), 1.); gsUy = vGsP.xz; gsUz = vGsP.xy * vec2(sign(gsn.z), 1.);   // signs chosen so text and motifs read the right way round on every side gsGrads();
  vec4 gsAl = gsTri(gsA, 0.); vec4 gsMr = gsTri(gsM, 0.);
  vec3 gsCol = mix(gsFlat, gsAl.rgb * gsTint, gsPat);
  if (gsIri > 0.) { float fr = 1. - abs(dot(normalize(vNormal), normalize(vViewPosition))); gsCol = mix(gsCol, gsCol * (.35 + 1.3 * gsHue(fr * 1.6 + dot(vGsP, vec3(.13, .21, .17)) + gsTime * .05 * step(.5, gsMode))), gsIri * gsPat); }
  diffuseColor.rgb = gsCol;`;
const GS_FRAG_RM = `
  float roughnessFactor = mix(gsRM.x, gsMr.r * gsRS, gsPat);
  float metalnessFactor = mix(gsRM.y, gsMr.g * gsMS, gsPat);`;
const GS_FRAG_NORMAL = `
  if (gsBump > 0. && gsPat > 0.) {
    // relief from the height channel; fades out when a texel gets smaller than a pixel (no sparkle on far / small guns)
    float gsFade = clamp(1.6 - length(fwidth(vGsP)) * 700., 0., 1.);
    float gsH = gsMr.b; if (gsFade > 0.) normal = gsPerturb(-vViewPosition, normal, vec2(dFdx(gsH), dFdy(gsH)) * gsBump * gsPat * gsFade, faceDirection); }`;
const GS_FRAG_EMI = `
  if (gsGi > 0. && gsPat > 0.) {
    vec3 gse = gsTriE().rgb; float m = gsMode, t = gsTime * gsSpd;
    if (m > 2.5 && m < 3.5) { float a = dot(vGsP, gsAxis); gse *= .25 + .75 * pow(.5 + .5 * sin(t - a * 2.4), 3.) + .35 * step(.97, gsHash(vec2(floor(t * 3.), floor(a)))); }
    else if (m > 3.5 && m < 4.5) { vec2 cell = floor((gsUx * gsW.x + gsUy * gsW.y + gsUz * gsW.z) * 96.); gse *= .2 + 1.3 * pow(.5 + .5 * sin(t * 2. + gsHash(cell) * 6.283), 3.); }
    else if (m > 4.5 && m < 5.5) { gse *= .6 + .8 * step(.5, gsHash(vec2(floor(gsTime * 12.), floor(vGsP.y * 30.)))); }
    else if (m > 6.5 && m < 7.5) { vec2 c = fract(gsUx * gsW.x + gsUy * gsW.y + gsUz * gsW.z) - .5; float ang = atan(c.y, c.x); float sw = fract((ang / 6.2832) - t * .25); gse *= .02 + 1.8 * pow(sw, 8.); }
    totalEmissiveRadiance += gse * gsGlow * gsGi * gsPat;
  }`;
function patchStd(sh) {
  sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>' + GS_VERT_PARS).replace('#include <begin_vertex>', '#include <begin_vertex>' + GS_VERT);
  sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>' + GS_FRAG_PARS)
    .replace('#include <map_fragment>', GS_FRAG_MAP)
    .replace('#include <roughnessmap_fragment>', '').replace('#include <metalnessmap_fragment>', GS_FRAG_RM)
    .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>' + GS_FRAG_NORMAL)
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>' + GS_FRAG_EMI);
}
// accents (fins / holo / duck charm): one extra mesh per gun
const AC_VERT_PARS = GS_VERT_PARS + `
attribute vec3 gsK; varying vec3 vGsK; varying vec3 vGsCol;`;
const AC_VERT = GS_VERT + `
vGsK = gsK; vGsCol = color;`;
const AC_FRAG_PARS = GS_FRAG_PARS + `
uniform vec3 gsFx, gsFxBase; varying vec3 vGsK; varying vec3 vGsCol;`;
const AC_FRAG_MAP = `
  vec3 gsn = normalize(vGsN); gsW = pow(abs(gsn), vec3(6.)); gsW /= (gsW.x + gsW.y + gsW.z + 1e-5);
  gsUx = vGsP.zy; gsUy = vGsP.xz; gsUz = vGsP.xy; gsGrads();
  vec4 gsAl = gsTri(gsA, 0.);
  float gsHolo = vGsK.y;
  if (gsHolo > .5) {
    float a = dot(vGsP, gsAxis) / max(gsSc * gsUnit, 1e-3) * 60.;
    float scan = fract(a * .5 - gsTime * 1.6);
    float d = gsHash(vec2(floor(gsTime * 14.), 1.));
    if (scan > .6 || (d > .93 && scan > .3) || fract((gl_FragCoord.x + gl_FragCoord.y) * .5) > .5 && scan > .45) discard;
  }
  diffuseColor.rgb = mix(mix(gsFxBase * (.55 + .45 * gsAl.rgb), vGsCol, vGsK.z), vec3(0.), gsHolo);`;
const AC_FRAG_EMI = `
  { float a = dot(vGsP, gsAxis) / max(gsSc * gsUnit, 1e-3);
    float pulse = .65 + .35 * sin(gsTime * 3. - a * 18.);
    totalEmissiveRadiance += gsFx * (vGsK.x * pulse * 2.2 + vGsK.y * (1.25 + .45 * sin(gsTime * 5. + a * 40.))); }`;
function patchAccent(sh) {
  sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>' + AC_VERT_PARS).replace('#include <begin_vertex>', '#include <begin_vertex>' + AC_VERT);
  sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>' + AC_FRAG_PARS)
    .replace('#include <map_fragment>', AC_FRAG_MAP)
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>' + AC_FRAG_EMI);
}

/* ======================================================================================= part roles */
// role of a mesh in a gun: body (main surfaces), acc (painted panels), trim (secondary dark parts), metal (bright steel),
// grip (rubber), tank, wood; null = never touched (sights, lenses, glow, hands, reticles, flashes, displays)
let ROLEMAP = null, SIGHT = null, RIFLE = null;
function roleInit() {
  if (ROLEMAP) return true;
  const KITMAT = gv('KITMAT'), PAINTM = gv('PAINTM'), KIT = gv('KIT'), ASSET = gv('ASSET'); if (!KITMAT || !KIT || !ASSET || !ASSET.gunMat) return false;
  ROLEMAP = new Map();
  const R = { s9_dark: 'body', s9_black: 'trim', s9_steel: 'metal', s9_rubber: 'grip', s9_tank: 'tank', s9_wood: 'wood' };
  const kitMat = gv('kitMat');
  for (const tp of [false, true]) for (const n in R) { try { const m = kitMat(n, tp); ROLEMAP.set(m, R[n]); } catch (e) {} }
  SIGHT = new Set();
  for (const k in KIT) if (k === 'holo' || /^g_.+_sight$/.test(k)) for (const e of KIT[k]) SIGHT.add(e.geo);
  try { const p = ASSET.gunMat('carbine'), m = ASSET.gunMat('metal'); RIFLE = { paintN: p.normalMap, metalN: m.normalMap }; p.dispose(); m.dispose(); } catch (e) { RIFLE = {}; }
  return true;
}
// creature add-on weapons (modules/w_poopgun.js, modules/w_flytrap.js): the skin/leaves take the pattern, the harness the trim;
// eyes, mouth, teeth, tongue, glow parts, hands and the living stem are never touched
const CREATURE = {
  poopgun(m) {
    const c = m.color;
    if (m.vertexColors) return 'body';                                         // the critter's skin (both LODs)
    if (m.metalness >= .99) return 'metal';                                    // bright harness steel
    if (m.metalness >= .8) return 'trim';                                      // dark harness
    if (m.roughness >= .84 && m.roughness < .9 && c.r < .04) return 'grip';    // rubber grips (not the sleeve)
    if (c.b > c.g * 2 && c.b > .14 && c.b > c.r) return 'acc';                 // purple feet, lids, lips
    return null;
  },
  flytrap(m, kitRole) {
    if (kitRole === 'body' || kitRole === 'trim') return 'trim';             // its collar and harness are kit metal
    if (kitRole === 'metal' || kitRole === 'grip') return kitRole;
    if (!m.vertexColors) return null;
    if (m.side === T.DoubleSide) return 'acc';                                 // leaves
    const c = m.color, e = m.emissive;
    if (Math.abs(c.r - c.g) < .01 && Math.abs(c.g - c.b) < .01 && (!e || e.r < .1)) return 'body';   // flesh (not the pink mouth)
    return null;
  },
};
function roleOf(mesh, weapon) {
  const m = mesh.material; if (!m || Array.isArray(m) || !m.isMeshStandardMaterial) return null;
  if (mesh.userData.gsAccent) return null;
  const src = mesh.userData.gsOrig || m;
  if (src.transparent || src.depthTest === false || src === gv('GLOVE_M') || src === gv('SLEEVE_M')) return null;
  const r = ROLEMAP && ROLEMAP.get(src);
  if (CREATURE[weapon]) return CREATURE[weapon](src, r);
  if (SIGHT && SIGHT.has(mesh.geometry)) { if (r === 'body' || r === 'trim' || r === 'metal') return 'strim'; const PM = gv('PAINTM'); if (PM) for (const k in PM) if (PM[k] === src) return 'strim'; return null; }   // sight housing: flat trim colour, no pattern (stays readable)
  if (r) return r;
  const PAINTM = gv('PAINTM'); if (PAINTM) for (const k in PAINTM) if (PAINTM[k] === src) return 'acc';
  if (RIFLE && src.normalMap) { if (src.normalMap === RIFLE.paintN) return 'rbody'; if (src.normalMap === RIFLE.metalN) return 'rtrim'; }
  const hx = src.color ? src.color.getHex() : -1;
  if (weapon === 'pistol' && hx === 0x4c5158) return 'body';
  if (weapon === 'judge' && hx === 0xd8a640) return 'body';
  if (weapon === 'boomerang') { if (hx === 0x030304) return 'body'; if (hx === 0xb8bec8) return 'metal'; if (hx === 0x060607) return 'grip'; }
  return null;
}

/* ======================================================================================= pattern-space attributes */
// kit / viewmodel geometry is already in the gun's model space: gsPos/gsNor simply alias position/normal (no copy).
// The third-person rifle (LOD glTF nodes) gets baked rifle-space attributes once per shared geometry.
let LODM = null;
function lodInit() {
  if (LODM) return; LODM = new Map(); const A = gv('ASSET'); const lod = A && A.rifleLod; if (!lod) return;
  const root = lod.scene; root.updateMatrixWorld(true); const inv = root.matrixWorld.clone().invert();
  root.traverse(o => { if (o.isMesh) LODM.set(o.geometry, new T.Matrix4().multiplyMatrices(inv, o.matrixWorld)); });
}
function ensureAttrs(geo) {
  if (geo.attributes.gsPos) return;
  lodInit();
  const M = LODM.get(geo);
  if (M && !isIdentity(M)) {
    const p = geo.attributes.position, n = geo.attributes.normal, P = new Float32Array(p.count * 3), Nn = new Float32Array(p.count * 3), v = new T.Vector3(), nm = new T.Matrix3().getNormalMatrix(M);
    for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(M); P[i * 3] = v.x; P[i * 3 + 1] = v.y; P[i * 3 + 2] = v.z; if (n) { v.fromBufferAttribute(n, i).applyMatrix3(nm).normalize(); Nn[i * 3] = v.x; Nn[i * 3 + 1] = v.y; Nn[i * 3 + 2] = v.z; } }
    geo.setAttribute('gsPos', new T.BufferAttribute(P, 3)); geo.setAttribute('gsNor', new T.BufferAttribute(Nn, 3));
  } else {
    geo.setAttribute('gsPos', geo.attributes.position);
    if (geo.attributes.normal) geo.setAttribute('gsNor', geo.attributes.normal); else { geo.computeVertexNormals(); geo.setAttribute('gsNor', geo.attributes.normal); }
  }
}
const isIdentity = M => { const e = M.elements, I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; for (let i = 0; i < 16; i++) if (Math.abs(e[i] - I[i]) > 1e-4) return false; return true; };

/* ======================================================================================= materials (shared per finish x role x source class) */
const MATS = new Map();
const WSCALE = { pistol: 2.2, judge: 1.8, boomerang: 1.4 };   // small guns: their model space is smaller
const rifleRole = r => r === 'rbody' || r === 'rtrim';
function srcKey(src) {
  return [src.envMapIntensity.toFixed(3), src.normalMap ? src.normalMap.uuid : '-', src.aoMap ? src.aoMap.uuid : '-', src.emissiveMap ? src.emissiveMap.uuid : '-', src.emissive ? src.emissive.getHexString() : '-', (src.emissiveIntensity || 0).toFixed(2), src.normalScale ? src.normalScale.x.toFixed(2) : '', src.color ? src.color.getHexString() : '', src.vertexColors ? 'v' : '', src.side].join(',');
}
function roleLook(s, role) {
  const L = s.look, r = role === 'rbody' ? 'body' : role === 'rtrim' ? 'trim' : role;
  // returns { pat, tint, flat, rough, metal }
  if (r === 'body') return { pat: 1, tint: L.body || [1, 1, 1], flat: '#000000', rough: .5, metal: .5 };
  if (r === 'acc') return { pat: 1, tint: L.acc || [1.12, 1.12, 1.12], flat: '#000000', rough: .5, metal: .5 };
  if (role === 'rtrim') { const t = L.trim || {}; return { pat: 1, tint: (L.body || [1, 1, 1]).map(v => v * .72), flat: '#000000', rough: .5, metal: .5 }; }   // the rifle model's metal pieces are odd triangle islands: keep the pattern running over them
  if (r === 'trim') { const t = L.trim || {}; return { pat: t.pat ?? .5, tint: t.tint || [.5, .5, .5], flat: t.col || '#16181b', rough: t.rough ?? .5, metal: t.metal ?? .6 }; }
  if (r === 'strim') { const t = L.metal || {}; return { pat: 0, tint: [1, 1, 1], flat: t.col || (L.trim && L.trim.col) || '#16181b', rough: Math.max(.3, t.rough ?? .4), metal: .75 }; }   // sight housing: the finish's accent metal
  if (r === 'metal') { const t = L.metal || {}; return { pat: 0, tint: [1, 1, 1], flat: t.col || '#c4c8d0', rough: t.rough ?? .3, metal: 1 }; }
  if (r === 'grip') return L.grip ? { pat: 0, tint: [1, 1, 1], flat: L.grip, rough: .85, metal: 0 } : null;
  if (r === 'tank') return { pat: .6, tint: [.8, .8, .8], flat: (L.metal && L.metal.col) || '#8a2a10', rough: .35, metal: .7 };
  if (r === 'wood') return { pat: .8, tint: [.9, .85, .8], flat: '#3e1a0c', rough: .45, metal: .1 };
  return null;
}
function finishMat(s, role, src, weapon) {
  const rl = roleLook(s, role); if (!rl) return null;
  const wu = s.weapon === 'all' ? (WSCALE[weapon] || 1) : 1;   // collections: same pattern size on small handguns as on rifles
  const key = s.id + '|' + role + '|' + srcKey(src) + (wu !== 1 ? '|u' + wu : '') + ((weapon === 'carbine' || weapon === 'sniper') && src.emissive ? '|' + src.uuid : '');
  let m = MATS.get(key); if (m) return m;
  const tx = skinTex(s), L = s.look;
  m = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 1, envMapIntensity: src.envMapIntensity, normalMap: src.normalMap || null, normalScale: src.normalScale ? src.normalScale.clone() : new T.Vector2(1, 1),
    aoMap: src.aoMap || null, aoMapIntensity: src.aoMapIntensity ?? 1, emissiveMap: src.emissiveMap || null, emissiveIntensity: src.emissiveIntensity ?? 1 });
  if (src.emissive && !src.vertexColors) m.emissive = src.emissive;   // (creature skins: no inherited body glow, the finish decides)   // same Color object: the game's "heat" glow on the rifle keeps working
  m.name = 'gs:' + key;
  const lift = src.vertexColors ? Math.min(1.25, Math.max(src.color.r, src.color.g, src.color.b)) : 1;   // third-person creature mats are brightened for the dim world; a little of that, not the full x3
  if (lift !== 1) rl.tint = rl.tint.map(v => v * lift);
  const flat = colLin(rl.flat).multiplyScalar(lift);
  const u = m.userData.gsU = {
    gsA: { value: tx.a }, gsM: { value: tx.m }, gsE: { value: tx.e || blackTex() }, gsTime: U.time,
    gsSc: { value: L.sc || 2.4 }, gsUnit: { value: (rifleRole(role) ? .5 : 1) * wu }, gsPat: { value: rl.pat }, gsBump: { value: (L.bump ?? .5) * .25 },
    gsMode: { value: L.mode || 0 }, gsSpd: { value: L.spd || 1 }, gsIri: { value: L.iri || 0 }, gsGi: { value: tx.e ? (L.gi || 1.2) : 0 },
    gsRS: { value: L.rs || 1 }, gsMS: { value: L.ms || 1 }, gsTint: { value: new T.Vector3(...rl.tint) }, gsFlat: { value: new T.Vector3(flat.r, flat.g, flat.b) },
    gsGlow: { value: (() => { const c = colLin(L.glow || '#ffffff'); return new T.Vector3(c.r, c.g, c.b); })() }, gsAxis: { value: axisOf(weapon, rifleRole(role)) },
    gsRM: { value: new T.Vector2(rl.rough, rl.metal) }, gsFlow: { value: new T.Vector2(...(L.flow || [0, 0])) } };
  m.onBeforeCompile = sh => { Object.assign(sh.uniforms, u); patchStd(sh); };
  m.customProgramCacheKey = () => 'gs-std-2';
  MATS.set(key, m); return m;
}
const AXV = { kit: new T.Vector3(0, 0, -1), rifle: new T.Vector3(1, 0, 0) };
const axisOf = (weapon, rifle) => rifle ? AXV.rifle : AXV.kit;
const ACMATS = new Map();
function accentMat(s, weapon, rifle, envI) {
  const key = s.id + '|' + (rifle ? 'r' : 'k') + '|' + envI.toFixed(3); let m = ACMATS.get(key); if (m) return m;
  const tx = skinTex(s), L = s.look;
  m = new T.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: .3, metalness: .85, envMapIntensity: envI, side: T.DoubleSide });
  m.name = 'gs-accent:' + key;
  const fx = colLin(L.fxc || L.glow || '#ffffff'), base = colLin((L.metal && L.metal.col) || '#888888');
  const u = m.userData.gsU = { gsA: { value: tx.a }, gsM: { value: tx.m }, gsE: { value: blackTex() }, gsTime: U.time, gsSc: { value: L.sc || 2.4 }, gsUnit: { value: rifle ? .5 : 1 },
    gsPat: { value: 1 }, gsBump: { value: 0 }, gsMode: { value: 0 }, gsSpd: { value: 1 }, gsIri: { value: 0 }, gsGi: { value: 0 }, gsRS: { value: 1 }, gsMS: { value: 1 },
    gsTint: { value: new T.Vector3(1, 1, 1) }, gsFlat: { value: new T.Vector3() }, gsGlow: { value: new T.Vector3() }, gsAxis: { value: axisOf(weapon, rifle) }, gsRM: { value: new T.Vector2(.3, .85) }, gsFlow: { value: new T.Vector2() },
    gsFx: { value: new T.Vector3(fx.r, fx.g, fx.b) }, gsFxBase: { value: new T.Vector3(base.r, base.g, base.b) } };
  m.onBeforeCompile = sh => { Object.assign(sh.uniforms, u); patchAccent(sh); };
  m.customProgramCacheKey = () => 'gs-acc-2';
  ACMATS.set(key, m); return m;
}

/* ======================================================================================= accent geometry (baked glTF per weapon) */
const ACC = new Map();   // weapon -> Promise<{ fins, holo, duck } geometries> | result
function loadAccents(weapon) {
  if (ACC.has(weapon)) return Promise.resolve(ACC.get(weapon));
  const p = new Promise(res => {
    const L = T.GLTFLoader ? new T.GLTFLoader() : null; if (!L) return res(null);
    fetch(BASE + 'assets/models/gunskins/' + weapon + '.gltf.json').then(r => r.ok ? r.text() : null).then(txt => {
      if (!txt) return res(null);
      L.parse(txt, '', g => {
        const out = {}; g.scene.traverse(o => { if (o.isMesh) { const geo = o.geometry; const k = geo.attributes._gsk || geo.attributes._GSK; if (k) { geo.setAttribute('gsK', k); geo.deleteAttribute(k === geo.attributes._gsk ? '_gsk' : '_GSK'); }
          if (!geo.attributes.color) { const c = new Float32Array(geo.attributes.position.count * 3).fill(1); geo.setAttribute('color', new T.BufferAttribute(c, 3)); }
          if (!geo.attributes.gsK) geo.setAttribute('gsK', new T.BufferAttribute(new Float32Array(geo.attributes.position.count * 3), 3));
          ensureAttrs(geo); geo.computeBoundingSphere(); out[o.name.replace(/^.*?_/, '')] = geo; } });
        ACC.set(weapon, out); res(out);
      }, () => res(null));
    }).catch(() => res(null));
  });
  ACC.set(weapon, p); return p;
}

/* ======================================================================================= frames: where accents attach (same space as the bake) */
function frameOf(root, weapon) {
  const KIT = gv('KIT') || {};
  if (CREATURE[weapon]) {
    if (root.userData.ft) return root.userData.ft.inner;              // flytrap third person (before and after its model loads)
    if (root.userData.body) return root.userData.body;
    const W = (gv('WM') || {})[weapon]; if (W && W.group === root) return W.critter ? W.critter.root : (W.inner || null);
    return null;
  }
  if (weapon === 'carbine' || weapon === 'sniper') {
    if (root.userData.body && !root.userData.body.isMesh) return root.userData.body;   // third person: the cloned rifle scene
    let f = null; root.traverse(o => { if (!f && o.isMesh && (roleOf(o, weapon) === 'rbody')) f = o.parent; }); return f;
  }
  if (root.userData.body) return root.userData.body;
  const kitName = weapon === 'pistol' ? 'pistol' : weapon === 'judge' ? 'revolver' : null;
  let f = null;
  if (kitName && KIT[kitName]) { const gs = new Set(KIT[kitName].map(e => e.geo)); root.traverse(o => { if (!f && o.isMesh && gs.has(o.geometry)) f = o.parent; }); }
  if (!f && weapon === 'boomerang') root.traverse(o => { if (!f && o.isMesh && roleOf(o, weapon) === 'body') f = o.parent; });
  return f;
}

/* ======================================================================================= apply */
const isAnimated = s => !!(s && s.look && s.look.mode);
function apply(weapon, skinId, root, opts = {}) {
  if (!root || !weapon || weapon === 'knife') return false;
  if (!roleInit()) return false;
  let s = skinOf(skinId); if (!s || !fits(s, weapon)) s = FACTORY;
  root.userData.gsSkin = s.id; root.userData.gsWeapon = weapon;
  const meshes = [];
  root.traverse(o => { if (o.isMesh && !o.userData.gsAccent) meshes.push(o); });
  root.userData.gsMeshN = meshes.length;   // refresh re-applies when a model fills in later (creature guns load their parts after the skin was set)
  for (const o of meshes) {
    const role = roleOf(o, weapon); if (!role) continue;
    const src = o.userData.gsOrig || o.material;
    if (s === FACTORY) { if (o.userData.gsOrig) { o.material = o.userData.gsOrig; } continue; }
    const m = finishMat(s, role, src, weapon);
    if (!m) { if (o.userData.gsOrig) o.material = o.userData.gsOrig; continue; }
    if (!o.userData.gsOrig) o.userData.gsOrig = o.material;
    ensureAttrs(o.geometry);
    o.material = m;
  }
  tintGlow(root, weapon, s);
  setAccent(root, weapon, s, opts);
  if (weapon === 'flytrap' && !root.userData.gsWait) { const t = root.userData.ft, W = (gv('WM') || {}).flytrap, vm = W && W.group === root ? W : null;
    if ((t && !t.filled) || (vm && !vm.filled)) { root.userData.gsWait = true; const again = (n) => setTimeout(() => { if ((t && t.filled) || (vm && vm.filled)) { root.userData.gsWait = false; apply(weapon, root.userData.gsSkin, root); } else if (n < 120) again(n + 1); else root.userData.gsWait = false; }, 250); again(0); } }
  return true;
}
// the gun's own glow parts (muzzle rings, coils, energy cells) take the finish's glow colour at the same brightness
const _gc = new T.Color();
function tintGlow(root, weapon, s) {
  if (weapon === 'boomerang' || CREATURE[weapon]) return;   // boomerang glow is animated by the game; creatures' eyes are basic materials too
  const want = s !== FACTORY && s.look && s.look.glow ? s.look.glow : null;
  root.traverse(o => {
    const m = o.isMesh && o.material; if (!m || Array.isArray(m) || !m.isMeshBasicMaterial || m.map || m.transparent || m.depthTest === false || m.blending !== T.NormalBlending) return;
    if (!m.userData.gsGlow0) { const c = m.color; if (Math.max(c.r, c.g, c.b) < 1.2) return; m.userData.gsGlow0 = c.clone(); }
    const c0 = m.userData.gsGlow0;
    if (!want) { m.color.copy(c0); return; }
    _gc.set(want).convertSRGBToLinear(); const k = Math.max(c0.r, c0.g, c0.b) / Math.max(1e-3, _gc.r, _gc.g, _gc.b); m.color.copy(_gc).multiplyScalar(k);
  });
}
function removeAccent(root) { const a = root.userData.gsAcc; if (a) { if (a.parent) a.parent.remove(a); root.userData.gsAcc = null; } }
function setAccent(root, weapon, s, opts) {
  const fx = s.look && s.look.fx;
  if (!fx) { removeAccent(root); return; }
  const want = s.id + '|' + fx;
  if (root.userData.gsAcc && root.userData.gsAcc.userData.gsKey === want) return;
  removeAccent(root);
  const put = acc => {
    if (!acc || !acc[fx] || root.userData.gsSkin !== s.id) return;
    if (root.userData.gsAcc && root.userData.gsAcc.userData.gsKey === want) return;
    removeAccent(root);
    const f = frameOf(root, weapon); if (!f) return;
    let envI = 1; root.traverse(o => { if (o.isMesh && o.userData.gsOrig && o.userData.gsOrig.envMapIntensity !== undefined) envI = o.userData.gsOrig.envMapIntensity; });
    const mesh = new T.Mesh(acc[fx], accentMat(s, weapon, weapon === 'carbine' || weapon === 'sniper', envI));
    mesh.userData.gsAccent = true; mesh.userData.gsKey = want; mesh.castShadow = false; mesh.frustumCulled = true; mesh.name = 'gs-accent';
    f.add(mesh); root.userData.gsAcc = mesh;
  };
  const a = ACC.get(weapon);
  if (a && !(a instanceof Promise)) put(a); else loadAccents(weapon).then(put);
}

/* ======================================================================================= viewmodel + game hooks */
function vmRoot(weapon) { const WM = gv('WM'); return WM && WM[weapon] ? WM[weapon].group : null; }
/* ownership: finishes are owned items sold in the Shop (window.S9Shop, server-side inventory). Only owned finishes (or the
   factory one) can be equipped; the server re-checks on PUT /api/me/look. Bots, remote players and previews may show anything. */
function shopItem(s, weapon) {
  try { const D = window.S9Shop && window.S9Shop.data; if (!D || !D.items) return null;
    return D.items.find(i => i.type === 'gunskin' && i.skinId === s.id && (i.gun === weapon || i.gun === 'all')) || null; } catch (e) { return null; }
}
function owns(s, weapon) {
  if (!s || s.default) return true;
  if (typeof API.ownsOverride === 'function') return !!API.ownsOverride(s.id, weapon);
  const it = shopItem(s, weapon); if (it) return !!it.owned;
  // shop not loaded yet: trust only what the server already accepted on your account look
  try { const A = window.S9Account; const p = A && (typeof A.getProfile === 'function' ? A.getProfile() : A.profile); const g = p && p.look && p.look.gunSkins; if (g && typeof g.then !== 'function' && g[weapon] === s.id) return true; } catch (e) {}
  return false;
}
function applyToViewmodel(weapon, skinId, save = true) {
  const s = skinOf(skinId); if (!s || !fits(s, weapon)) return false;
  if (save && !owns(s, weapon)) return false;   // never equip a finish you don't own
  if (save) { state.eq[weapon] = s.id; saveState(); }   // save=false: show it on the viewmodel only (previews, tests)
  const g = vmRoot(weapon); if (g) { g.userData.gsTemp = !save; apply(weapon, s.id, g); }   // gsTemp: a try-on (preview/test), the refresh timer leaves it alone
  texReady(s);
  sendPresence();
  return true;
}
const meshCount = g => { let n = 0; g.traverse(o => { if (o.isMesh && !o.userData.gsAccent) n++; }); return n; };
function refreshViewmodels() { for (const w of WEAPON_IDS()) { const g = vmRoot(w); if (!g || g.userData.gsTemp) continue; const want = owns(skinOf(get(w)), w) ? get(w) : 'factory'; if ((g.userData.gsSkin || 'factory') !== want || (want !== 'factory' && g.userData.gsMeshN !== meshCount(g))) apply(w, want, g); }
  // re-prepare finishes only when a gun gets MORE parts than ever before (a creature gun's model filled in). Guns that add/remove
  // parts while animating must not trigger it again and again (each warm-up compiles every gun = a visible hitch)
  let grew = false; for (const w of WEAPON_IDS()) { const g = vmRoot(w), n = g ? meshCount(g) : 0; if (n > (wmax[w] || 0)) { if (wmax[w] !== undefined) grew = true; wmax[w] = n; } } if (grew) setTimeout(warm, 50); }   // a creature gun's model filled in: compile its finish programs now, not mid-match
const wmax = {};

// bots carry finishes too (a seeded pick per bot name and weapon, mostly factory) so the arsenal shows up in matches
const BOT_MIX = { factory: 40, common: 22, rare: 18, epic: 11, legendary: 6, mythic: 3 };
const hashStr = str => { let h = 2166136261; for (const ch of String(str)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; };
let botMode = 'random';
function botSkin(name, weapon) {
  if (botMode !== 'random') return 'factory';
  const opts = list(weapon); const h = hashStr(name + '|' + weapon); let r = (h % 1000) / 1000 * 100, acc = 0;
  for (const k of ['factory', 'common', 'rare', 'epic', 'legendary', 'mythic']) { acc += BOT_MIX[k]; if (r < acc) { const c = k === 'factory' ? [FACTORY] : opts.filter(s => s.rarity === k && !s.default); if (!c.length) return 'factory'; return c[(h >>> 10) % c.length].id; } }
  return 'factory';
}
let lastSentSkin = null, lastRoom = null;
function sendPresence() {
  const NET = gv('NET'), P = gv('P'); if (!NET || !NET.on || !NET.room || typeof NET.room.presence !== 'function' || !P) return;
  const id = owns(skinOf(get(P.weapon)), P.weapon) ? get(P.weapon) : 'factory'; if (id === lastSentSkin && NET.room === lastRoom) return;
  lastSentSkin = id; lastRoom = NET.room; try { const p = NET.room.presence({ gk: id === 'factory' ? '' : id }); if (p && p.catch) p.catch(() => {}); } catch (e) {}
}
function onRemote(E, pr) {
  const r = E && E.r; if (!r || !r.gunInner || !pr) return;
  const w = r.netW || (r.gunInner.userData && r.gunInner.userData.gsWeapon); const id = typeof pr.gk === 'string' && ID_RE.test(pr.gk) ? pr.gk : 'factory';
  const weapon = r.netW; if (!weapon || weapon === 'knife') return;
  const want = skinOf(id) && fits(skinOf(id), weapon) ? id : 'factory';
  if (r.gunInner.userData.gsSkin !== want || r.gunInner.userData.gsWeapon !== weapon) apply(weapon, want, r.gunInner);
}
let hooked = false;
function installHooks() {
  if (hooked) return true;
  if (typeof gv('buildBot') !== 'function' || typeof gv('rifleTP') !== 'function') return false;
  hooked = true;
  const wrap = (name, body) => { try { if (typeof gv(name) === 'function') (0, eval)(`${name} = (function (orig) { return ${body}; })(${name})`); } catch (e) { console.warn('gunskins: hook ' + name, e); } };
  // bots: a finish on the gun they are built with
  wrap('buildBot', 'function (profile) { const r = orig.apply(this, arguments); try { window.S9GunSkins && window.S9GunSkins._onBot(r); } catch (e) {} return r; }');
  // remote players: their finish travels in presence field gk (the finish of the gun in their hands)
  wrap('netReceive', 'function (E, pr) { const out = orig.apply(this, arguments); try { window.S9GunSkins && window.S9GunSkins._onRemote(E, pr); } catch (e) {} return out; }');
  wrap('netSend', 'function () { const out = orig.apply(this, arguments); try { window.S9GunSkins && window.S9GunSkins._send(); } catch (e) {} return out; }');
  // your own gun in the death cam keeps your finish
  wrap('startDeathcam', 'function () { const out = orig.apply(this, arguments); try { window.S9GunSkins && window.S9GunSkins._onDeathcam(); } catch (e) {} return out; }');
  // a gun dropped by a defeated bot keeps that bot\'s finish
  wrap('spawnDrop', 'function (id, at) { const n = (typeof DROPS !== "undefined") ? DROPS.length : 0; const out = orig.apply(this, arguments); try { window.S9GunSkins && window.S9GunSkins._onDrop(id, at, n); } catch (e) {} return out; }');
  // the shader warm-up also compiles the finish materials (no first-use hitch in a match)
  // a Finish chip on every Arsenal gun card
  wrap('renderArsenal', 'function () { const out = orig.apply(this, arguments); try { window.S9GunSkins && window.S9GunSkins._arsenal(); } catch (e) {} return out; }');
  wrap('warmShaders', 'function () { const out = orig.apply(this, arguments); try { window.S9GunSkins && window.S9GunSkins._warm(); } catch (e) {} return out; }');
  return true;
}
function onBot(r) { if (!r || !r.gunInner || r.remote) return; const w = r.weapon; if (!w || w === 'knife') return; apply(w, botSkin(r.name, w), r.gunInner); }
function onDeathcam() { const DC = gv('DC'), P = gv('P'); if (DC && DC.gun && P && P.weapon !== 'knife') apply(P.weapon, owns(skinOf(get(P.weapon)), P.weapon) ? get(P.weapon) : 'factory', DC.gun); }
function onDrop(id, at, n0) {
  const DROPS = gv('DROPS'), robots = gv('robots') || []; if (!DROPS || DROPS.length <= n0) return;
  const d = DROPS[DROPS.length - 1]; const r = robots.find(x => x.root && x.root.position === at); const sid = r && r.gunInner && r.gunInner.userData.gsSkin;
  if (!sid || sid === 'factory') return; let gun = null; (d.g || d.group || d.root || { traverse() {} }).traverse(o => { if (!gun && o.userData && o.userData.body) gun = o; });
  if (gun) apply(id, sid, gun);
}

/* ======================================================================================= time + warm-up */
let lastT = -1;
let lastRef = 0;
function tick() {
  requestAnimationFrame(tick); const now = performance.now();
  const G = gv('G'); const st = gv('state');
  // game time in a match (it stops while paused); the main menu keeps a wall clock so previews animate
  const t = G && st && st !== 'menu' && st !== 'loading' ? G.time : performance.now() / 1000;
  if (t !== lastT) { U.time.value = t % 3600; lastT = t; }
  if (now - lastRef > 700) { lastRef = now; try { refreshViewmodels(); } catch (e) {} }   // a rebuilt / late-filled viewmodel gets its finish within a second
}
function warm() {
  // compile one material of each program class into the scene + the viewmodel scene, into the game's real target
  try {
    const renderer = gv('renderer'), scene = gv('scene'), camera = gv('camera'), gunScene = gv('gunScene'), gunCam = gv('gunCam'), rt = gv('rt'); if (!renderer || !scene) return;
    const ids = new Set(Object.values(state.eq)); const sample = CAT.find(s => s.look && s.look.fx) || CAT[0]; if (sample) ids.add(sample.id);
    const tmp = [], add = (sc, m, geo) => { const me = new T.Mesh(geo, m); me.position.set(0, -500, 0); me.frustumCulled = false; sc.add(me); tmp.push([sc, me]); };
    const geo = new T.BoxGeometry(.01, .01, .01); ensureAttrs(geo); geo.setAttribute('gsK', new T.BufferAttribute(new Float32Array(geo.attributes.position.count * 3), 3)); geo.setAttribute('color', new T.BufferAttribute(new Float32Array(geo.attributes.position.count * 3).fill(1), 3));
    const WM = gv('WM') || {};
    for (const w of WEAPON_IDS()) { const g = WM[w] && WM[w].group; if (!g) continue; const s = skinOf(get(w)); const use = s && s !== FACTORY ? s : (sample || null); if (!use) continue;
      g.traverse(o => { if (o.isMesh) { const role = roleOf(o, w); if (!role) return; const m = finishMat(use, role, o.userData.gsOrig || o.material, w); if (m) { add(gunScene, m, geo); add(scene, m, geo); } } }); }
    // third-person guns (other players, bots, drops, killcam): each gun's own meshes, finished with a sample finish, into the world scene
    const rtp = gv('rifleTP'); const tps = [];
    if (sample && typeof rtp === 'function') for (const w of WEAPON_IDS()) { try { const tp = rtp(w); tp.position.set(0, -500, 0); scene.add(tp); tps.push(tp);
      tp.traverse(o => { if (o.isMesh) { const role = roleOf(o, w); if (!role) return; const m = finishMat(sample, role, o.userData.gsOrig || o.material, w); if (m) add(scene, m, geo); } }); } catch (e) {} }
    // every finish of every gun goes through the same few shader programs: one sample (with and without glow texture) covers them, the accents are separate programs
    if (sample) for (const rifle of [false, true]) for (const env of [1, .55]) { add(scene, accentMat(sample, 'carbine', rifle, env), geo); add(gunScene, accentMat(sample, 'carbine', rifle, env), geo); }
    const plain = CAT.find(s => s.look && !s.look.emi && !(s.look.fx));
    if (plain && plain !== sample) for (const w of WEAPON_IDS()) { const g = WM[w] && WM[w].group; if (!g) continue; g.traverse(o => { if (o.isMesh) { const role = roleOf(o, w); if (!role) return; const m = finishMat(plain, role, o.userData.gsOrig || o.material, w); if (m) { add(gunScene, m, geo); add(scene, m, geo); } } }); }
    const prev = renderer.getRenderTarget(); if (rt) renderer.setRenderTarget(rt);
    renderer.compile(scene, camera); if (gunScene) renderer.compile(gunScene, gunCam);
    renderer.setRenderTarget(prev);
    for (const [sc, me] of tmp) sc.remove(me); for (const tp of tps) { if (tp.parent) tp.parent.remove(tp); if (tp.userData.ft && gv('FLYTRAP')) { try { gv('FLYTRAP').TPS.delete(tp.userData.ft); } catch (e) {} } } geo.dispose();
  } catch (e) { console.warn('gunskins: warm', e); }
}

/* ======================================================================================= preview stage (one shared renderer, created on first use) */
let PV = null;
function stage() {
  if (PV) return PV;
  const renderer = new T.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  renderer.outputEncoding = T.sRGBEncoding; renderer.toneMapping = T.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1; renderer.setPixelRatio(1);
  const scene = new T.Scene();
  const env = new T.Scene(); env.add(new T.Mesh(new T.SphereGeometry(20, 24, 12), new T.MeshBasicMaterial({ color: new T.Color(.12, .13, .16), side: T.BackSide })));
  for (const [p, c, s] of [[[0, 10, 6], [4, 4, 4.2], [12, 4]], [[-12, 4, -6], [.6, 1.6, 2.6], [8, 5]], [[12, 5, -4], [2.6, 1.2, .6], [8, 5]], [[0, 2, 14], [1.6, 1.6, 1.7], [14, 3]], [[0, -9, 0], [.15, .15, .17], [20, 20]]]) { const m = new T.Mesh(new T.PlaneGeometry(...s), new T.MeshBasicMaterial({ color: new T.Color(...c), side: T.DoubleSide })); m.position.set(...p); m.lookAt(0, 0, 0); env.add(m); }
  const pm = new T.PMREMGenerator(renderer); scene.environment = pm.fromScene(env, .02).texture; pm.dispose();
  const key = new T.DirectionalLight(0xfff1e0, 1.6); key.position.set(1.5, 3, 2.5); scene.add(key);
  const rim = new T.DirectionalLight(0x8fc8ff, 1.2); rim.position.set(-2.5, 1.5, -2.5); scene.add(rim);
  scene.add(new T.HemisphereLight(0xc8d8ff, 0x201810, .5));
  const cam = new T.PerspectiveCamera(24, 1, .01, 50);
  const holder = new T.Group(); scene.add(holder);
  PV = { renderer, scene, cam, holder, guns: new Map() };
  return PV;
}
function pvGun(weapon) {
  const pv = stage(); let g = pv.guns.get(weapon); if (g) return g;
  const rtp = gv('rifleTP'); if (typeof rtp !== 'function') return null;
  const inner = rtp(weapon); g = new T.Group(); g.add(inner); g.userData.inner = inner;
  // the third-person model is the clean one (no hands); frame it by its bounding box
  inner.updateMatrixWorld(true); const b = visBox(inner), c = b.getCenter(new T.Vector3()), sz = b.getSize(new T.Vector3());
  inner.position.sub(c); g.userData.size = Math.max(sz.x, sz.y, sz.z); g.userData.sz = sz;
  // the side shown in studio views = the side you see in first person (the viewmodel's -x side, where charms and emitters sit)
  const f = frameOf(inner, weapon); let side = -Math.PI / 2;
  const vm = vmRoot(weapon), fv = vm && frameOf(vm, weapon);
  if (f && fv) {
    vm.updateMatrixWorld(true); f.updateMatrixWorld(true);
    // the viewmodel's -x axis, expressed in the frame (kit space or rifle space), then carried into the studio model
    const qRel = vm.getWorldQuaternion(new T.Quaternion()).invert().multiply(fv.getWorldQuaternion(new T.Quaternion()));
    const dF = new T.Vector3(-1, 0, 0).applyQuaternion(qRel.invert());
    const d = dF.applyQuaternion(f.getWorldQuaternion(new T.Quaternion()));
    if (Math.hypot(d.x, d.z) > .3) side = Math.atan2(-d.x, d.z);
  }
  if (weapon === 'carbine' || weapon === 'sniper') side = -Math.PI / 2;   // the shared rifle model only has a finished right side
  g.userData.side = side;
  pv.guns.set(weapon, g); return g;
}
function visBox(root) {   // bounding box of the visible meshes only (the rifle model carries hidden scope parts)
  const b = new T.Box3(), bx = new T.Box3(); root.updateMatrixWorld(true);
  root.traverse(o => { if (!o.isMesh || o.userData.gsAccent) return; let q = o; while (q) { if (!q.visible) return; q = q.parent; } if (!o.geometry.boundingBox) o.geometry.computeBoundingBox(); bx.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld); b.union(bx); });
  return b;
}
// opts: view 'side' | 'threeQ' | 'top' | 'front', w, h, t (animation time), yaw
function preview(canvas, weapon, skinId, opts = {}) {
  return ready.then(() => {
    const go = () => {
      if (!roleInit() || typeof gv('rifleTP') !== 'function') return new Promise(r => setTimeout(r, 250)).then(go);
      const s = skinOf(skinId) || FACTORY, pv = stage(), g = pvGun(weapon); if (!g) throw new Error('no gun ' + weapon);
      apply(weapon, s.id, g.userData.inner);
      const waits = [texReady(s)]; if (s.look && s.look.fx) waits.push(loadAccents(weapon).then(() => apply(weapon, s.id, g.userData.inner)));
      return Promise.all(waits).then(() => {
        const cv = canvas instanceof HTMLCanvasElement ? canvas : null; if (!cv) throw new Error('no canvas');
        const w = opts.w || cv.width || 512, h = opts.h || cv.height || 288;
        pv.holder.children.slice().forEach(c => pv.holder.remove(c)); pv.holder.add(g);
        const v = opts.view || 'threeQ', size = g.userData.size || .6;
        const yaw = (g.userData.side ?? -Math.PI / 2) + Math.PI / 2 + (opts.yaw ?? { side: -Math.PI / 2, threeQ: -Math.PI / 2 + .62, top: -Math.PI / 2, front: 0, back: Math.PI }[v] ?? -1);
        g.rotation.set(v === 'top' ? Math.PI / 2 : 0, yaw, 0);
        const el = { side: .02, threeQ: .3, top: 0, front: .1, back: .1 }[v] ?? .25;
        const sz = g.userData.sz || new T.Vector3(size, size, size), len = Math.max(sz.x, sz.z), tall = v === 'top' ? Math.min(sz.x, sz.z) : sz.y;
        const fitW = len * (v === 'threeQ' ? .86 : 1) / (w / h), fitH = tall * (v === 'threeQ' ? 1.15 : 1);
        const dist = Math.max(fitW, fitH) * 1.12 / (opts.zoom || 1) / (2 * Math.tan(pv.cam.fov * Math.PI / 360)) + Math.min(sz.x, sz.z) * .5;
        pv.renderer.setSize(w, h, false); pv.cam.aspect = w / h; pv.cam.updateProjectionMatrix();
        pv.cam.position.set(0, Math.sin(el) * dist, Math.cos(el) * dist); pv.cam.lookAt(0, 0, 0);
        const keepT = U.time.value; if (opts.t !== undefined) U.time.value = opts.t;
        pv.renderer.render(pv.scene, pv.cam);
        U.time.value = keepT;
        const ctx = cv.getContext('2d'); if (cv.width !== w) cv.width = w; if (cv.height !== h) cv.height = h; ctx.clearRect(0, 0, w, h);
        if (opts.bg !== false) { const gr = ctx.createRadialGradient(w * .5, h * .45, h * .1, w * .5, h * .5, Math.max(w, h) * .7); gr.addColorStop(0, opts.bg1 || '#3a3f4a'); gr.addColorStop(1, opts.bg2 || '#14161b'); ctx.fillStyle = gr; ctx.fillRect(0, 0, w, h); }
        ctx.drawImage(pv.renderer.domElement, 0, 0, w, h);
        return cv;
      });
    };
    return go();
  });
}


/* ======================================================================================= finish picker (Arsenal): a "Finish" chip on each gun card */
const escH = v => String(v == null ? '' : v).replace(/[&<>"'`]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
function playerLevel() {
  try { const A = window.S9Account; const p = A && (typeof A.getProfile === 'function' ? A.getProfile() : A.profile); if (p && p.level && typeof p.then !== 'function') return p.level | 0; } catch (e) {}
  try { const l = +localStorage.getItem('sector9-level'); if (l > 0) return l | 0; } catch (e) {}
  return 1;
}
// locked = the shop sells it and you don't own it, or your level is too low. The server re-checks ownership on PUT /api/me/look.
function lockInfo(s, weapon) {   // null = owned (equippable); else { price, level, itemId, levelOk }
  if (owns(s, weapon)) return null;
  const it = shopItem(s, weapon), D = window.S9Shop && window.S9Shop.data;
  const lvl = (it && it.minLevel) || s.unlockLevel || 1, have = (D && D.level) || playerLevel();
  return { price: it && Number.isFinite(+it.price) ? +it.price : null, level: lvl, levelOk: have >= lvl, itemId: it ? it.id : 'gs_' + s.id };
}
let uiCss = false;
function css() {
  if (uiCss) return; uiCss = true;
  const st = document.createElement('style'); st.textContent = `
.gsChip{display:flex;align-items:center;gap:6px;font:11px var(--mono,monospace);color:#cfd6df;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);padding:5px 8px;cursor:pointer;text-align:left;width:100%;box-sizing:border-box}
.gsChip:hover,.gsChip:focus-visible{border-color:rgba(255,154,60,.7);outline:none}.gsChip i{width:8px;height:8px;border-radius:50%;flex:none}.gsChip b{font-weight:700;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.gsChip span{margin-left:auto;opacity:.6;flex:none}
#gsPick{position:fixed;inset:0;z-index:60;background:rgba(6,7,10,.86);display:flex;align-items:center;justify-content:center;padding:16px}
#gsPick .gsBox{background:#111317;border:1px solid rgba(255,255,255,.12);width:min(1100px,100%);max-height:92vh;display:flex;flex-direction:column;font-family:var(--mono,monospace);color:#e8ecf1}
#gsPick header{display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.08)}#gsPick header h3{margin:0;font-size:16px;letter-spacing:.06em}#gsPick header button{margin-left:auto;background:none;border:1px solid rgba(255,255,255,.2);color:#fff;padding:6px 12px;cursor:pointer;font:inherit}
#gsPick .gsGrid{overflow:auto;padding:14px 16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px}
#gsPick .gsCard{background:linear-gradient(160deg,#181b21,#101216);border:1px solid rgba(255,255,255,.1);padding:8px;display:grid;gap:4px;cursor:pointer;text-align:left;color:inherit;font:inherit;position:relative;min-width:0}
#gsPick .gsShop{justify-self:start;margin-top:2px;background:#ff9a3c;color:#140b02;border:0;padding:5px 10px;font:700 11px var(--mono,monospace);cursor:pointer}#gsPick .gsShop:focus-visible{outline:2px solid #fff}#gsPick .gsPrice{font-size:11px;color:#ffd27a}
#gsPick .gsCard canvas{width:100%;height:auto;aspect-ratio:16/9;display:block;background:#1a1d23}#gsPick .gsCard.on{border-color:#ff9a3c;box-shadow:0 0 0 1px #ff9a3c inset}#gsPick .gsCard[aria-disabled=true]{cursor:default}#gsPick .gsCard[aria-disabled=true] canvas{opacity:.6}
#gsPick .gsCard b{font-size:13px}#gsPick .gsCard small{font-size:10px;letter-spacing:.08em}#gsPick .gsCard em{font-style:normal;font-size:10px;color:#9aa3ad}#gsPick .gsLock{position:absolute;top:12px;right:12px;background:rgba(0,0,0,.7);padding:2px 6px;font-size:10px}
#gsPick p.gsDesc{margin:0;padding:10px 16px 14px;border-top:1px solid rgba(255,255,255,.08);font-size:12px;color:#aab3bd;min-height:2.6em}
@media (max-width:520px){#gsPick{padding:0}#gsPick .gsBox{max-height:100vh;height:100%}#gsPick .gsGrid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:10px}}`;
  document.head.appendChild(st);
}
function chipHTML(w) { const s = skinOf(get(w)) || FACTORY; return `<i style="background:${RARITY[s.rarity].col}"></i><b>${escH(s.name)}</b><span>Finish &#9656;</span>`; }
function decorateArsenal() {
  const grid = document.getElementById('arsGrid'); if (!grid || !BYID.size) return; css();
  for (const card of grid.querySelectorAll('.wcard[data-id]')) {
    const w = card.dataset.id; if (!w || w === 'knife' || card.querySelector('.gsChip')) continue;
    const c = document.createElement('div'); c.className = 'gsChip'; c.setAttribute('role', 'button'); c.tabIndex = 0; c.dataset.gsw = w; c.innerHTML = chipHTML(w);
    c.title = 'Change finish'; card.appendChild(c);
  }
}
document.addEventListener('click', e => { const c = e.target.closest && e.target.closest('.gsChip'); if (c) { e.stopPropagation(); e.preventDefault(); openPicker(c.dataset.gsw); } }, true);
document.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('gsChip')) { e.preventDefault(); e.stopPropagation(); openPicker(e.target.dataset.gsw); } }, true);
let pickOpen = null;
function openPicker(w) {
  if (!w || !BYID.size) return; css(); closePicker(true);
  const el = document.createElement('div'); el.id = 'gsPick'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', 'Choose a finish');
  const W = (gv('WEAPONS') || {})[w], items = list(w), cur = owns(skinOf(get(w)), w) ? get(w) : 'factory';
  el.innerHTML = `<div class="gsBox"><header><h3>${escH(W ? W.name : w)} &middot; FINISHES</h3><button type="button" data-close>Close</button></header><div class="gsGrid">${items.map(s => { const lk = lockInfo(s, w);
    const tag = lk ? `<span class="gsLock">${lk.levelOk ? 'NOT OWNED' : 'LEVEL ' + (lk.level | 0)}</span><span class="gsPrice">${lk.price !== null ? (lk.price | 0).toLocaleString('en-US') + ' Shards' : 'Shop item'}${lk.levelOk ? '' : ' &middot; needs level ' + (lk.level | 0)}</span><button type="button" class="gsShop" data-shop="${escH(lk.itemId)}">Get in Shop</button>` : '';
    return `<div role="button" tabindex="0" class="gsCard${s.id === cur ? ' on' : ''}" data-sk="${escH(s.id)}" aria-pressed="${s.id === cur}"${lk ? ' aria-disabled="true"' : ''}><canvas width="380" height="214"></canvas><b>${escH(s.name)}</b><small style="color:${RARITY[s.rarity].col}">${RARITY[s.rarity].name.toUpperCase()}${s.animated ? ' &middot; ANIMATED' : ''}</small><em>${escH(s.collection ? 'Collection: ' + s.collection : s.default ? 'Default' : '')}</em>${tag}</div>`; }).join('')}</div><p class="gsDesc"></p></div>`;
  document.body.appendChild(el); pickOpen = el;
  const desc = el.querySelector('.gsDesc'), show = id => { const s = skinOf(id); desc.textContent = s ? s.desc || '' : ''; };
  show(cur);
  el.addEventListener('click', e => {
    e.stopPropagation();
    if (e.target === el || e.target.closest('[data-close]')) return closePicker();
    const sh = e.target.closest('[data-shop]'); if (sh) { closePicker(true); try { const S = window.S9Shop; if (S) { if (typeof S.openItem === 'function') S.openItem(sh.dataset.shop); else S.open(sh.dataset.shop); } } catch (x) {} return; }
    const b = e.target.closest('.gsCard'); if (!b) return; show(b.dataset.sk);
    if (b.getAttribute('aria-disabled') === 'true') return;
    applyToViewmodel(w, b.dataset.sk);
    for (const x of el.querySelectorAll('.gsCard')) { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-pressed', on); }
    try { const s = gv('sfx'); if (s && s.equip) s.equip(); } catch (x) {}
    const chip = document.querySelector(`.gsChip[data-gsw="${w}"]`); if (chip) chip.innerHTML = chipHTML(w);
  });
  el.addEventListener('mouseover', e => { const b = e.target.closest && e.target.closest('.gsCard'); if (b) show(b.dataset.sk); });
  el.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closePicker(); } else if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('gsCard')) { e.preventDefault(); e.target.click(); } }, true);
  el.querySelector('[data-close]').focus();
  // previews one after another (one shared renderer)
  (async () => { for (const b of el.querySelectorAll('.gsCard')) { if (pickOpen !== el) return; try { await preview(b.querySelector('canvas'), w, b.dataset.sk, { view: 'threeQ', w: 380, h: 214, t: 1.5 }); } catch (e) {} } })();
}
function closePicker(silent) { if (pickOpen) { const w = pickOpen; pickOpen = null; w.remove(); if (!silent) { const c = document.querySelector('.gsChip'); if (c) c.focus(); } } }
// the shop equips through the server; mirror it locally right away
addEventListener('s9:look', e => { const g = e.detail && e.detail.gunSkins; if (!g || typeof g !== 'object') return; for (const [w, id] of Object.entries(g)) if (ID_RE.test(w) && BYID.has(id) && fits(BYID.get(id), w)) { state.eq[w] = id; const vm = vmRoot(w); if (vm) apply(w, id, vm); } try { localStorage.setItem(LS_KEY, JSON.stringify({ v: 1, eq: state.eq })); } catch (x) {} });

/* ======================================================================================= boot */
let booted = false;
function onReady() {
  const go = () => {
    if (!window.__s9 || !roleInit() || !installHooks()) return setTimeout(go, 300);
    if (!booted) { booted = true; pullAccount(); refreshViewmodels(); decorateArsenal(); for (const r of gv('robots') || []) if (!r.remote && r.gunInner && !r.gunInner.userData.gsSkin) onBot(r); warm(); requestAnimationFrame(tick);
      // prefetch the textures + accents of the finishes you have equipped
      for (const w of Object.keys(state.eq)) { const s = skinOf(state.eq[w]); if (s && s !== FACTORY) { texReady(s); if (s.look && s.look.fx) loadAccents(w); } }
      setInterval(() => { pullAccount(); refreshViewmodels(); decorateArsenal(); }, 5000);
      addEventListener('s9modules', () => { refreshViewmodels(); decorateArsenal(); warm(); }); }
  };
  go();
}

const API = window.S9GunSkins = {
  ownsOverride: null, owns: (skinId, weapon) => owns(skinOf(skinId), weapon),
  version: 1, ready, RARITY, FACTORY,
  list, get, equipped: () => Object.assign({}, state.eq), skin: id => skinOf(id),
  apply, applyToViewmodel, preview, applyGunSkin: (w, id, target) => target ? apply(w, id, target) : applyToViewmodel(w, id),
  isAnimated, setBotMode(m) { botMode = m === 'factory' ? 'factory' : 'random'; },
  _onBot: onBot, _refresh: refreshViewmodels, _arsenal: decorateArsenal, openPicker, closePicker, _onRemote: onRemote, _send: sendPresence, _onDeathcam: onDeathcam, _onDrop: onDrop, _warm: warm,
  _state: state, _mats: MATS, _acc: ACC, _time: U.time, _loadAccents: loadAccents, _frameOf: frameOf, _roleOf: (o, w) => (roleInit(), roleOf(o, w)), _texReady: id => texReady(skinOf(id))
};
})();
