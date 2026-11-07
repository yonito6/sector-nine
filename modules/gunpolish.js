/* Sector Nine — gun model polish (window.S9GunPolish)
   Swaps polished base models in at load time, without touching index.html or the shipped kit:
   - assets/models/guns_polish/kit_polish.gltf.json (built by render/guns_polish/polish.py + pack_polish.py) holds
       pistol, revolver                 -> sculpted M-2 pistol and Judge (replace KIT.pistol / KIT.revolver)
       g_<gun>                          -> reworked bodies: void, sniper (new: the Longbow had no body of its own), breacher,
                                           inferno, nova, stinger, wasp
       g_<gun>_sight                    -> new optics: seeker, triad, titan, void, sniper, wasp, cryo
       pm_*                             -> new mounted parts: Void/Helix ring rotors, Void spear crown, Helix fork, Triad
                                           barrels, Ricochet disc cradle, Cryo crystal blades, Arc orb cage
   - Same material slot names as the kit (s9_skin/dark/black/rubber/steel/wood/glow/paint), so the game's materials,
     the gun-skin roles (modules/gunskins.js) and the "heat"/glow effects keep working. Sights are given cloned
     materials so finishes never paint them (same rule as the original optics).
   - Hands, muzzle/tracer origin, ADS sight line and reticle position are untouched (parts keep the old envelopes).
   - The Void's charge animation (spinning, pulsing rings) now spins the whole carrier on its bearing and pulses
     the glow instead of scaling, so the rings never detach from the barrel.
   - assets/models/guns_polish/mounts.gltf.json (render/guns_polish/mounts.py): pm_<gun>_mount = rail mount under every
     optic (receiver pad set into the receiver, rail jaws round the optic clamp with cross bolts, saddles that close the
     deck-to-housing gap, scope rings / cradles on tube optics); contact AO baked in vertex colour; first person only.
   API: ready (true when swapped), enabled(), disable() / enable() (live rollback), report(), _parts.
   Load order: anywhere; works before or after the game boots (rebuilds the affected viewmodels + bot guns). */
(() => {
'use strict';
if (window.S9GunPolish && window.S9GunPolish.version) return;
const T = window.THREE;
const gv = name => { try { return (0, eval)(`typeof ${name} !== 'undefined' ? ${name} : undefined`); } catch (e) { return undefined; } };
const BASE = (() => { try { const s = document.currentScript && document.currentScript.src; return s && /modules\/gunpolish\.js/.test(s) ? s.replace(/modules\/gunpolish\.js.*$/, '') : ''; } catch (e) { return ''; } })();
const FILE = 'assets/models/guns_polish/kit_polish.gltf.json';
const REPLACE = ['pistol', 'revolver', 'g_seeker_sight', 'g_triad_sight', 'g_titan_sight', 'g_void_sight', 'g_void', 'g_sniper', 'g_sniper_sight',
  'g_breacher', 'g_inferno', 'g_nova', 'g_stinger', 'g_wasp', 'g_wasp_sight', 'g_cryo_sight', 'g_triad', 'g_arc', 'g_ricochet_sight', 'g_breacher_sight', 'g_inferno_sight'];
const RINGS = { void: 'pm_void_ring', helix: 'pm_helix_ring' };
const AFFECTED = ['pistol', 'judge', 'seeker', 'triad', 'titan', 'void', 'helix', 'ricochet', 'sniper', 'breacher', 'inferno', 'nova', 'stinger', 'wasp', 'cryo', 'arc'];
const EXTRA = ['pm_void_ring', 'pm_helix_ring', 'pm_ricochet_hub', 'pm_triad_muzzle', 'pm_cryo_prongs', 'pm_arc_cage', 'pm_void_nose', 'pm_helix_fork', 'pm_inferno_pilot'];
// extra mounted parts: kit name -> [gun, VM-space position]
const MOUNTS = [['pm_void_nose', 'void', [0, -.01, -.8]], ['pm_helix_fork', 'helix', [0, -.005, -.88]], ['pm_cryo_prongs', 'cryo', [0, -.01, -.65]], ['pm_arc_cage', 'arc', 'orb'], ['pm_inferno_pilot', 'inferno', 'pilot']];
// the Longbow gets its own unique body + scope (it used to share the carbine's third-person mesh); placement in VM gun space
const SNIPER_META = { muzzle: [0, 0, -.955], fore: [0, -.17, -.38], fs: 'under', a: {} }, SNIPER_PAINT = 0xb08a2a;
// handguns: the ADS view is held a little further out so the gun's rear doesn't cover what you aim at (sights stay on the line)
const ADS_Z = { judge: -.47, pistol: -.43 };
const API = window.S9GunPolish = { version: 1, ready: false, error: null };
let PARTS = null, ORIG = {}, on = false, wrapped = false;
const SIGHTGEO = new Set();
const RINGGEO = new Map();         // merged ring-carrier geometry per gun (+ third person)        // geometries of replaced optics (materials cloned so finishes skip them)

/* ------------------------------------------------------------------ load + convert (same rules as index.html kitInit) */
function parseKit(gltf) {
  const out = {}; gltf.scene.updateMatrixWorld(true);
  for (const root of gltf.scene.children) {
    const by = {}, inv = root.matrixWorld.clone().invert();
    root.traverse(o => { if (!o.isMesh) return;
      const g = o.geometry.clone().applyMatrix4(new T.Matrix4().multiplyMatrices(inv, o.matrixWorld));
      for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
      if (!g.attributes.uv) g.setAttribute('uv', new T.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
      const g2 = g.index ? g.toNonIndexed() : g, mn = (o.material && o.material.name || 's9_dark').replace(/\.\d+$/, ''); (by[mn] = by[mn] || []).push(g2); });
    out[root.name.replace(/^k_/, '')] = Object.entries(by).map(([m, list]) => { const geo = T.BufferGeometryUtils.mergeBufferGeometries(list); geo.setAttribute('uv2', geo.attributes.uv); geo.computeBoundingSphere(); return { m, geo }; });
  }
  return out;
}
const MFILE = 'assets/models/guns_polish/mounts.gltf.json';
const MOUNT_GUNS = ['carbine', 'sniper', 'helix', 'cryo', 'wasp', 'nova', 'stinger', 'titan', 'triad', 'arc', 'ricochet', 'seeker', 'breacher', 'inferno', 'void'];
let MPARTS = null;
const mountsLoaded = fetch(BASE + MFILE).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }).then(txt => new Promise((res, rej) => {
  new T.GLTFLoader().parse(txt, '', g => res(parseMounts(g)), rej); })).then(p => (MPARTS = p)).catch(e => { console.warn('gunpolish: mounts', e); return null; });
function parseMounts(gltf) {   // like parseKit, but keeps the baked contact-AO vertex colour
  const out = {}; gltf.scene.updateMatrixWorld(true);
  for (const root of gltf.scene.children) {
    const by = {}, inv = root.matrixWorld.clone().invert();
    root.traverse(o => { if (!o.isMesh) return;
      let g = o.geometry.clone().applyMatrix4(new T.Matrix4().multiplyMatrices(inv, o.matrixWorld)); g = g.index ? g.toNonIndexed() : g;
      const n = g.attributes.position.count;
      if (!g.attributes.color) g.setAttribute('color', new T.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
      else if (g.attributes.color.itemSize === 4) { const c = g.attributes.color, a = new Float32Array(n * 3); for (let i = 0; i < n; i++) { a[i * 3] = c.getX(i); a[i * 3 + 1] = c.getY(i); a[i * 3 + 2] = c.getZ(i); } g.setAttribute('color', new T.BufferAttribute(a, 3)); }
      for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) g.deleteAttribute(k);
      if (!g.attributes.uv) g.setAttribute('uv', new T.BufferAttribute(new Float32Array(n * 2), 2));
      const mn = (o.material && o.material.name || 's9_dark').replace(/\.\d+$/, ''); (by[mn] = by[mn] || []).push(g); });
    out[root.name.replace(/^k_/, '')] = Object.entries(by).map(([m, list]) => { const geo = T.BufferGeometryUtils.mergeBufferGeometries(list); geo.setAttribute('uv2', geo.attributes.uv); geo.computeBoundingSphere(); return { m, geo }; });
  }
  return out;
}
const MOUNTMAT = new Map();
function mountMat(slot) {   // the gun's own kit material + vertex colour (contact AO); finishes still find it (alias)
  let c = MOUNTMAT.get(slot); if (c) return c;
  const src = gv('kitMat')(slot, false); c = src.clone(); c.vertexColors = true; c.name = (src.name || slot) + '|gp-mount';
  if (src.userData && src.userData.tile) c.userData.tile = src.userData.tile; c.userData.gpDim = true;
  try { window.S9GunSkins && S9GunSkins.alias && S9GunSkins.alias(c, src); } catch (e) {}
  MOUNTMAT.set(slot, c); return c;
}
function addMount(id, vm) {   // first person only (bots' guns are too small on screen to show the gap)
  if (!on || !MPARTS || !vm || !vm.group || vm.group.userData.gpMount) return false;
  const parts = MPARTS['pm_' + id + '_mount']; if (!parts) return false;
  const g = new T.Group(); g.name = 'gp-mount';
  for (const { m, geo } of parts) { const me = new T.Mesh(geo, mountMat(m)); me.castShadow = false; me.name = 'gp-mount-' + m; g.add(me); }
  vm.group.add(g); vm.group.userData.gpMount = g; return true;
}
function removeMount(vm) { const g = vm && vm.group && vm.group.userData.gpMount; if (!g) return; if (g.parent) g.parent.remove(g); delete vm.group.userData.gpMount; }
function mountAll() { const WM = gv('WM'); if (!WM) return 0; let n = 0; for (const id of MOUNT_GUNS) if (WM[id]) { if (on) { if (addMount(id, WM[id])) n++; } else removeMount(WM[id]); } return n; }
const loaded = fetch(BASE + FILE).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }).then(txt => new Promise((res, rej) => {
  const L = new T.GLTFLoader(); L.parse(txt, '', g => res(parseKit(g)), e => rej(e));
})).then(p => { PARTS = p; for (const n of REPLACE) if (p[n]) for (const e of p[n]) if (/_sight$/.test(n)) SIGHTGEO.add(e.geo); return p; })
  .catch(e => { API.error = String(e && e.message || e); console.warn('gunpolish: load', e); return null; });

/* ------------------------------------------------------------------ materials */
const SIGHTMAT = new Map();
function sightMat(m) {   // a twin of a kit/paint material that gun finishes don't recognise (optics are never painted)
  let c = SIGHTMAT.get(m); if (c) return c;
  c = m.clone(); c.name = (m.name || '') + '|gp-sight'; if (m.userData && m.userData.tile) c.userData.tile = m.userData.tile; SIGHTMAT.set(m, c); return c;
}

/* ------------------------------------------------------------------ hooks: builders read KIT at call time; we post-process their output */
const P3f = (tp, s) => v => tp ? new T.Vector3(-v[0] * s, v[1] * s, -v[2] * s) : new T.Vector3(v[0], v[1], v[2]);
function postUnique(g, id, tp, out) {
  if (!on || !out) return out;
  const KIT = gv('KIT'), GMETA = gv('GMETA'), kitPart = gv('kitPart'); if (!KIT || !GMETA || !kitPart) return out;
  const s = tp ? .6 : 1, P3 = P3f(tp, s), A = (GMETA[id] || {}).a || {};
  // optics: give the replaced sight its own material twins
  g.traverse(o => { if (o.isMesh && SIGHTGEO.has(o.geometry) && o.material && !o.material.isMeshBasicMaterial && !o.material.transparent) o.material = sightMat(o.material); });
  // ring carriers instead of the bare glow tori
  const rn = RINGS[id];
  if (rn && KIT[rn] && A.rings) {
    const want = A.rings.map(P3), tori = [];
    for (const m of out.fx) if (m.isMesh && m.geometry && m.geometry.type === 'TorusGeometry' && want.some(w => w.distanceToSquared(m.position) < 1e-8)) tori.push(m);
    if (tori.length) {
      const glow = out.glow.clone(); glow.userData.gpBase = out.glow.color.clone();
      // all rings of a gun merged into ONE mesh per material (draw calls stay flat); the group sits on the bore axis so it can spin
      const axis = new T.Vector3(tori[0].position.x, tori[0].position.y, 0), key = id + (tp ? '|tp' : '');
      let geos = RINGGEO.get(key);
      if (!geos) {
        geos = KIT[rn].map(e => { const parts = tori.map(t => { const m = new T.Matrix4().makeTranslation(t.position.x - axis.x, t.position.y - axis.y, t.position.z); if (tp) m.multiply(new T.Matrix4().makeRotationY(Math.PI)); m.multiply(new T.Matrix4().makeScale(s, s, s)); return e.geo.clone().applyMatrix4(m); });
          const g2 = T.BufferGeometryUtils.mergeBufferGeometries(parts); g2.computeBoundingSphere(); return { m: e.m, geo: g2 }; });
        RINGGEO.set(key, geos);
      }
      const c = new T.Group(); c.position.copy(axis); c.name = 'gp-rings'; g.add(c);
      const pm = gv('paintMat');
      for (const e of geos) { const mat = e.m === 's9_glow' ? glow : e.m === 's9_paint' && pm ? pm(id, tp) : gv('kitMat')(e.m, tp); const me = new T.Mesh(e.geo, mat); me.castShadow = false; c.add(me); }
      for (const t of tori) if (t.parent) t.parent.remove(t);
      const carriers = [c];
      out.fx = out.fx.filter(m => !tori.includes(m)); out.ringCarriers = carriers; out.ringGlow = glow;
      // Void: the game spins/pulses hw.rings while charging. Give it stand-ins and drive the carriers from them (spin on the bearing, glow pulse).
      if (out.rings) out.rings = tori.map(() => new T.Object3D());
    }
  }
  // Triad: a three-barrel burst cluster instead of the open glow rings round the shroud
  if (id === 'triad' && KIT.pm_triad_muzzle && A.rings) {
    const want = A.rings.map(P3), tori = out.fx.filter(m => m.isMesh && m.geometry && m.geometry.type === 'TorusGeometry' && want.some(w => w.distanceToSquared(m.position) < 1e-8));
    for (const t of tori) if (t.parent) t.parent.remove(t);
    out.fx = out.fx.filter(m => !tori.includes(m));
    const k = kitPart('pm_triad_muzzle', tp, out.glow, out.glow); k.scale.setScalar(s); if (tp) k.rotation.y = Math.PI; k.position.copy(P3([0, -.008, -.6])); k.name = 'gp-muzzle'; g.add(k);
  }
  // Cryo: crystal emitter blades instead of plain glow cones
  if (id === 'cryo' && KIT.pm_cryo_prongs) { const cones = out.fx.filter(m => m.isMesh && m.geometry && m.geometry.type === 'ConeGeometry'); for (const c of cones) if (c.parent) c.parent.remove(c); out.fx = out.fx.filter(m => !cones.includes(m)); }
  // Arc: the orb reads as cyan plasma inside its cage instead of a blown-out white disc
  if (id === 'arc') for (const m of out.fx) if (m.isMesh && m.geometry && m.geometry.type === 'IcosahedronGeometry') { const om = out.glow.clone(); om.color.multiplyScalar(.42); m.material = om; out.orbMat = om; }
  for (const [name, gun, at] of MOUNTS) {
    if (gun !== id || !KIT[name]) continue;
    const pos = typeof at === 'string' ? (A[at] ? P3(A[at]) : null) : P3(at); if (!pos) continue;
    const k = kitPart(name, tp, null, out.glow); paintParts(k, name, id, tp); k.scale.setScalar(s); if (tp) k.rotation.y = Math.PI; k.position.copy(pos); k.name = 'gp-' + name; g.add(k);
  }
  // Ricochet: bearing under the loaded disc
  if (id === 'ricochet' && KIT.pm_ricochet_hub && out.spin && out.spinAxis === 'y') {
    const h = kitPart('pm_ricochet_hub', tp, null, out.glow); paintParts(h, 'pm_ricochet_hub', id, tp); h.scale.setScalar(s); if (tp) h.rotation.y = Math.PI; h.position.copy(out.spin.position); h.name = 'gp-hub'; g.add(h);
  }
  return out;
}
function paintParts(part, name, id, tp) {   // 's9_paint' slots take the gun's own paint (like the bodies do)
  const KIT = gv('KIT'), paintMat = gv('paintMat'); if (!KIT[name] || typeof paintMat !== 'function') return;
  const geos = new Set(KIT[name].filter(e => e.m === 's9_paint').map(e => e.geo)); if (!geos.size) return;
  const pm = paintMat(id, tp); part.traverse(o => { if (o.isMesh && geos.has(o.geometry)) o.material = pm; });
}
function postRevolver(g, id, tp, out) {
  if (!on) return out;
  // richer polished gold (same colour value, so finishes still recognise the Judge's body)
  g.traverse(o => { if (o.isMesh && o.material && o.material.isMeshStandardMaterial && o.material.color && o.material.color.getHex() === 0xd8a640) { o.material.metalness = .92; o.material.roughness = .3; } });
  return out;
}
function installWraps() {
  if (wrapped) return true;
  if (typeof gv('buildUniqueParts') !== 'function' || typeof gv('buildRevolverParts') !== 'function') return false;
  wrapped = true;
  const wrap = (name, body) => { try { (0, eval)(`${name} = (function (orig) { return ${body}; })(${name})`); } catch (e) { console.warn('gunpolish: hook ' + name, e); } };
  wrap('buildUniqueParts', 'function (g, id, tp) { const out = orig.apply(this, arguments); try { return window.S9GunPolish._postUnique(g, id, tp, out); } catch (e) { console.warn("gunpolish", e); return out; } }');
  wrap('buildRevolverParts', 'function (g, id, tp) { const out = orig.apply(this, arguments); try { return window.S9GunPolish._postRevolver(g, id, tp, out); } catch (e) { return out; } }');
  return true;
}

/* ------------------------------------------------------------------ swap / rollback */
function setKit(enable) {
  const KIT = gv('KIT');
  for (const n of REPLACE) { if (!PARTS[n]) continue; if (!(n in ORIG)) ORIG[n] = KIT[n]; KIT[n] = enable ? PARTS[n] : ORIG[n]; }
  for (const n of EXTRA) { if (enable && PARTS[n]) KIT[n] = PARTS[n]; else delete KIT[n]; }
  for (const n of REPLACE) if (KIT[n] === undefined) delete KIT[n];
  const GMETA = gv('GMETA'), GPAINT = gv('GPAINT');
  if (GMETA) { if (enable && PARTS.g_sniper) GMETA.sniper = SNIPER_META; else if (GMETA.sniper === SNIPER_META) delete GMETA.sniper; }
  if (GPAINT) { if (enable) GPAINT.sniper = SNIPER_PAINT; else if (GPAINT.sniper === SNIPER_PAINT) delete GPAINT.sniper; }
}
const booted = () => !!window.__s9 && gv('state') !== 'loading';
function rebuildViewmodels() {
  const WM = gv('WM'), gunScene = gv('gunScene'), buildGunVM = gv('buildGunVM'); if (!WM || !gunScene || typeof buildGunVM !== 'function') return 0;
  let n = 0; const before = new Set(); gunScene.traverse(o => { if (o.material) [].concat(o.material).forEach(m => before.add(m)); });
  for (const id of AFFECTED) {
    const old = WM[id]; if (!old) continue;
    const vis = old.group.visible; gunScene.remove(old.group);
    const vm = id === 'sniper' ? buildSniperVM() : buildGunVM(id); vm.group.visible = vis;
    if (on && ADS_Z[id] && vm.adsPos) vm.adsPos.z = ADS_Z[id];
    // the game dims every first-person material once at boot (x .55); do the same for materials that are new here
    if (booted()) vm.group.traverse(o => { if (o.material) [].concat(o.material).forEach(m => { if (!before.has(m) && !m.userData.gpDim && m.envMapIntensity !== undefined && !SIGHTMAT_HAS(m)) { m.envMapIntensity *= .55; m.userData.gpDim = true; } }); });
    addMount(id, vm);
    WM[id] = vm; n++;
    try { const GS = window.S9GunSkins; if (GS && GS.apply && GS.get) GS.apply(id, GS.get(id), vm.group); } catch (e) {}
  }
  const P = gv('P'); try { if (P && AFFECTED.includes(P.weapon) && WM[P.weapon]) gv('setModel')(P.weapon); } catch (e) {}
  return n;
}
// first-person Longbow: the game builds it from the CC0 rifle; with the polish it is built like the other unique guns
// (buildGunVM routes 'sniper' to the rifle builder, so build under a temporary alias, then drop the alias)
function buildSniperVM() {
  const GUN_SCALE = gv('GUN_SCALE') || .62, hip = new T.Vector3(.21, -.24, -.48);
  if (!on || !gv('KIT').g_sniper) { const vm = Object.assign(gv('buildRifleVM')('sniper'), { hip, adsPos: new T.Vector3(0, -.1075 * GUN_SCALE, -.3) }); return vm; }
  const A = 'gpsniper', W = gv('WEAPONS'), GM = gv('GMETA'), KIT = gv('KIT'), GP = gv('GPAINT'); let vm;
  W[A] = W.sniper; GM[A] = GM.sniper; KIT['g_' + A] = KIT.g_sniper; KIT['g_' + A + '_sight'] = KIT.g_sniper_sight; GP[A] = GP.sniper;
  try { vm = gv('buildGunVM')(A); } finally { delete W[A]; delete GM[A]; delete KIT['g_' + A]; delete KIT['g_' + A + '_sight']; delete GP[A]; }
  vm.hip = hip; return vm;
}
const SIGHTMAT_HAS = m => { for (const v of SIGHTMAT.values()) if (v === m) return true; return false; };
function rebuildBots() {
  const robots = gv('robots') || [], rifleTP = gv('rifleTP'); let n = 0;
  for (const r of robots) { const w = r.netW || r.weapon; if (!r.gun || !r.gunInner || !AFFECTED.includes(w)) continue;
    const keep = r.gunInner.userData.gsSkin; r.gun.remove(r.gunInner); r.gunInner = rifleTP(w); r.gun.add(r.gunInner);
    if (r.gunInner.userData.muzzle && r.muzzle) r.muzzle.position.copy(r.gunInner.userData.muzzle);
    try { const GS = window.S9GunSkins; if (GS && keep) GS.apply(w, keep, r.gunInner); } catch (e) {} n++; }
  return n;
}
function refresh() {
  const a = rebuildViewmodels(), b = rebuildBots(); mountAll();
  try { if (booted() && typeof gv('warmShaders') === 'function') gv('warmShaders')(); } catch (e) {}
  return { viewmodels: a, bots: b };
}
function enable() { if (!PARTS || on) return false; on = true; setKit(true); const r = refresh(); overrideAccents(); return r; }
function disable() { if (!PARTS || !on) return false; on = false; setKit(false); restoreAccents(); return refresh(); }

/* ------------------------------------------------------------------ gun-skin accents re-baked against the polished models */
const ACCDIR = 'assets/models/guns_polish/accents/';
let accSaved = null;
function parseAccents(txt) {
  return new Promise(res => { const L = new T.GLTFLoader(); L.parse(txt, '', g => { const out = {};
    g.scene.traverse(o => { if (!o.isMesh) return; const geo = o.geometry, k = geo.attributes._gsk || geo.attributes._GSK;
      if (k) { geo.setAttribute('gsK', k); geo.deleteAttribute(k === geo.attributes._gsk ? '_gsk' : '_GSK'); }
      if (!geo.attributes.color) geo.setAttribute('color', new T.BufferAttribute(new Float32Array(geo.attributes.position.count * 3).fill(1), 3));
      if (!geo.attributes.gsK) geo.setAttribute('gsK', new T.BufferAttribute(new Float32Array(geo.attributes.position.count * 3), 3));
      geo.setAttribute('gsPos', geo.attributes.position); geo.setAttribute('gsNor', geo.attributes.normal);
      geo.computeBoundingSphere(); out[o.name.replace(/^.*?_/, '')] = geo; });
    res(out); }, () => res(null)); });
}
function overrideAccents() {
  const GS = window.S9GunSkins; if (!GS || !GS._acc) return;
  if (!accSaved) accSaved = new Map(AFFECTED.map(w => [w, GS._acc.get(w)]));
  for (const w of AFFECTED) {
    const p = fetch(BASE + ACCDIR + w + '.gltf.json').then(r => r.ok ? r.text() : null).then(t => t ? parseAccents(t) : null).then(a => {
      if (!a) { if (accSaved.get(w) === undefined) GS._acc.delete(w); else GS._acc.set(w, accSaved.get(w)); return GS._loadAccents(w); }
      if (on) GS._acc.set(w, a); return a; });
    GS._acc.set(w, p);
    p.then(() => { try { const WM = gv('WM'); if (on && WM && WM[w] && WM[w].group.userData.gsSkin) { const g = WM[w].group, sk = g.userData.gsSkin; GS.apply(w, 'factory', g); GS.apply(w, sk, g); } } catch (e) {} });
  }
}
function restoreAccents() {
  const GS = window.S9GunSkins; if (!GS || !GS._acc || !accSaved) return;
  for (const [w, v] of accSaved) { if (v === undefined) GS._acc.delete(w); else GS._acc.set(w, v); }
  accSaved = null;
}

/* ------------------------------------------------------------------ per-frame: Void charge drives the ring carriers */
let lastT = 0;
function tick() {
  requestAnimationFrame(tick);
  if (!on) return;
  const WM = gv('WM'); const hw = WM && WM.void && WM.void.hw; if (!hw || !hw.ringCarriers || !hw.rings) return;
  if (!WM.void.group.visible) return;
  const P = gv('P'), ch = P ? (P.charge || 0) : 0;
  if (hw.ringCarriers[0] && hw.rings[0]) hw.ringCarriers[0].rotation.z = hw.rings[0].rotation.z;   // the whole rotor turns on its bearings
  if (hw.ringGlow && hw.ringGlow.userData.gpBase) { const sc = hw.rings[0] ? hw.rings[0].scale.x : 1; hw.ringGlow.color.copy(hw.ringGlow.userData.gpBase).multiplyScalar(1 + ch * 1.6 + Math.abs(sc - 1) * 2); }
}

/* ------------------------------------------------------------------ boot */
function report() {
  const KIT = gv('KIT') || {}, tri = list => (list || []).reduce((a, e) => a + (e.geo.index ? e.geo.index.count : e.geo.attributes.position.count) / 3, 0);
  const parts = {}; for (const n of REPLACE.concat(Object.values(RINGS), 'pm_ricochet_hub')) parts[n] = { now: Math.round(tri(KIT[n])), orig: n in ORIG ? Math.round(tri(ORIG[n])) : null };
  const mounts = {}; const WM = gv('WM') || {};
  for (const id of MOUNT_GUNS) { const g = WM[id] && WM[id].group.userData.gpMount; mounts[id] = g ? Math.round(g.children.reduce((a, m) => a + m.geometry.attributes.position.count / 3, 0)) : 0; }
  return { on, ready: API.ready, error: API.error, parts, mounts };
}
function start() {
  Promise.all([loaded, mountsLoaded]).then(([p]) => {
    if (!p) return;
    const go = () => {
      const KIT = gv('KIT');
      if (!KIT || !KIT.pistol || !installWraps()) return setTimeout(go, 200);
      on = true; setKit(true);
      // wait until the first-person models exist (the game builds them right after its assets load)
      const fin = () => { const WM = gv('WM'); if (!WM || !WM.pistol) return setTimeout(fin, 200); refresh(); overrideAccents(); API.ready = true; window.dispatchEvent(new Event('s9gunpolish')); };
      fin();
    };
    go(); requestAnimationFrame(tick);
  });
}
Object.assign(API, { MOUNT_GUNS, _mounts: () => MPARTS, enable, disable, enabled: () => on, report, refresh, _postUnique: postUnique, _postRevolver: postRevolver, _parts: () => PARTS, AFFECTED });
start();
})();
