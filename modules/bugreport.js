/* Sector Nine - in-game bug reports.
   Adds "Report a bug" to the pause menu (Esc) and the main menu. The player picks a category, writes a title and what
   happened, and can point at the broken spot in the map with the crosshair (up to 3 pins). The game attaches its own
   context (version, map, mode, weapon, position, FPS, ping, room, browser/GPU, recent console errors and kill feed) and
   shows exactly what will be sent before sending. Reports go to POST {server}/api/bugs; only the owner can read them.
   Nothing is changed automatically: the team reads each report, checks it, and fixes it only when the owner decides.

   Add-on module, no index.html edits needed besides the script tag. Load it EARLY (before the main game script) so it
   catches console errors from the start; it waits for the game (window.__s9) on its own. It talks to the game through
   window.__s9 and the game's globals (setState, kfeed, kfeedAdd are wrapped; SRV, CFG, PR, NET are only read).
   Never blocks gameplay: the form only opens from the pause/main menu and closes itself if the match resumes.
   Security: all text goes in through textContent/value (never innerHTML); nothing secret lives in this file. */
(() => {
'use strict';
if (window.S9Bug) return;

const DEFAULT_SRV = 'https://sector-nine-server-production.up.railway.app';
const MAX_SHOT = 150 * 1024, MAX_PIN_SHOT = 80 * 1024, MAX_PINS = 3, QUEUE_KEY = 'sector9-bugq', QUEUE_MAX = 3;
const CATS = [['gameplay', 'Gameplay'], ['map', 'Map bug - point at it'], ['graphics', 'Graphics'], ['sound', 'Sound'], ['online', 'Online / connection'], ['controls', 'Controls'], ['ui', 'Menus / UI'], ['cheating', 'Cheating / player report'], ['other', 'Something else']];
const FREQS = [['once', 'It happened once'], ['sometimes', 'Sometimes'], ['always', 'Every time']];
const T0 = performance.now();

/* ================= capture from load: console errors/warnings + uncaught errors ================= */
const LOGS = [];
const fmt = a => { try { if (a instanceof Error) return a.name + ': ' + a.message + (a.stack ? ' @ ' + String(a.stack).split('\n')[1] || '' : '').trim(); if (typeof a === 'object') return JSON.stringify(a).slice(0, 200); return String(a); } catch (e) { return '[unprintable]'; } };
function logPush(kind, parts) {
  try { const t = ((performance.now() - T0) / 1000).toFixed(1); LOGS.push(`${t}s ${kind}: ` + parts.map(fmt).join(' ').replace(/\s+/g, ' ').slice(0, 380)); if (LOGS.length > 30) LOGS.shift(); } catch (e) {}
}
for (const k of ['error', 'warn']) { const orig = console[k]; console[k] = function (...a) { logPush(k, a); return orig.apply(this, a); }; }
addEventListener('error', e => { if (e && e.message) logPush('uncaught', [e.message + (e.filename ? ' (' + String(e.filename).split('/').pop() + ':' + e.lineno + ')' : '')]); });
addEventListener('unhandledrejection', e => logPush('promise', [e && e.reason]));

/* ================= small helpers ================= */
const S9 = () => window.__s9;
const $ = id => document.getElementById(id);
const g = (f, d = null) => { try { const v = f(); return v === undefined ? d : v; } catch (e) { return d; } };
const r3 = v => Math.round(v * 1000) / 1000;
const vec = v => v ? [r3(v.x), r3(v.y), r3(v.z)] : null;
function el(tag, attrs, kids) {
  const e = document.createElement(tag);
  for (const k in attrs || {}) { const v = attrs[k]; if (v == null || v === false) continue; if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v); }
  for (const c of [].concat(kids || [])) if (c != null) e.append(c);
  return e;
}
const b64bytes = d => d ? Math.floor((d.length - d.indexOf(',') - 1) * 3 / 4) : 0;
const kb = n => Math.max(1, Math.round(n / 1024)) + ' KB';
const ls = { get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }, set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } } };

function serverBase() {
  let u = g(() => new URLSearchParams(location.search).get('srv'));
  if (!u) u = g(() => (typeof SRV !== 'undefined' && SRV.url) || null);   // eslint-disable-line no-undef
  if (!u || !/^(wss?|https?):\/\/[^\s/]+/i.test(u)) u = DEFAULT_SRV;
  return u.replace(/^ws(s?):\/\//i, 'http$1://').replace(/\/+$/, '');
}
let VERSION = null;
function gameVersion() {
  if (VERSION) return VERSION;
  const v = g(() => window.S9_VERSION || window.VERSION || (typeof S9_VERSION !== 'undefined' ? S9_VERSION : null)); // eslint-disable-line no-undef
  if (v) return (VERSION = String(v).slice(0, 40));
  // no version constant: fingerprint of the game's own inline code (changes with every build of index.html)
  let h = 0x811c9dc5, n = 0;
  for (const s of document.scripts) { if (s.src) continue; const t = s.textContent; n += t.length; for (let i = 0; i < t.length; i += 7) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } }
  return (VERSION = 'v-' + n.toString(36) + '-' + h.toString(36));
}
let GPU = null;
function gpuName() {
  if (GPU !== null) return GPU;
  GPU = g(() => { const gl = S9().renderer.getContext(), x = gl.getExtension('WEBGL_debug_renderer_info'); return String(x ? gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)); }, '') || '';
  return GPU;
}
function osName() {
  const ua = navigator.userAgent;
  return g(() => navigator.userAgentData && navigator.userAgentData.platform) || (/Windows NT 10/.test(ua) ? 'Windows 10/11' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : navigator.platform || '');
}
function account() {
  const A = window.S9Account; if (!A) return { prof: null, token: null };
  const prof = g(() => typeof A.profile === 'function' ? A.profile() : A.profile), token = g(() => typeof A.token === 'function' ? A.token() : A.token);
  return { prof: prof && prof.id ? prof : null, token: typeof token === 'string' && token.length < 600 ? token : null };
}

/* ================= kill feed (the HUD keeps only 6 for 6 s, we keep the last 10 as text) ================= */
const KILLS = []; let kfTag = null;
function hookGame() {
  if (typeof window.kfeed === 'function' && !window.kfeed.__s9bug) {
    const old = window.kfeed; window.kfeed = function (killer, victim, weapon, crit, wb) { kfTag = String(weapon || '') + (crit ? ', head' : '') + (wb ? ', wall' : ''); try { return old.apply(this, arguments); } finally { kfTag = null; } }; window.kfeed.__s9bug = true;
  }
  if (typeof window.kfeedAdd === 'function' && !window.kfeedAdd.__s9bug) {
    const old = window.kfeedAdd; window.kfeedAdd = function (html) {
      try { const t = document.createElement('template'); t.innerHTML = String(html); const txt = t.content.textContent.replace(/\s+/g, ' ').trim(); if (txt) { KILLS.unshift(`${Math.round(g(() => S9().G.time, 0))}s ${txt}${kfTag ? ' [' + kfTag + ']' : ''}`.slice(0, 160)); if (KILLS.length > 10) KILLS.pop(); } } catch (e) {}
      return old.apply(this, arguments);
    }; window.kfeedAdd.__s9bug = true;
  }
  if (typeof window.setState === 'function' && !window.setState.__s9bug) {
    const old = window.setState; window.setState = function (s) {
      const prev = g(() => S9().state); const out = old.apply(this, arguments);
      try { onState(s, prev); } catch (e) {}
      return out;
    }; window.setState.__s9bug = true;
  }
}

/* ================= screenshots of the game canvas (never the menus) ================= */
// a WebGL canvas can only be read right after the game drew it: a rAF callback queued now runs after the game's frame
const afterFrame = () => new Promise(res => requestAnimationFrame(() => res()));
function grabCanvas(maxW) {
  const src = g(() => S9().renderer.domElement); if (!src || !src.width) return null;
  const s = Math.min(1, maxW / src.width), c = document.createElement('canvas'); c.width = Math.max(2, Math.round(src.width * s)); c.height = Math.max(2, Math.round(src.height * s));
  try { c.getContext('2d').drawImage(src, 0, 0, c.width, c.height); } catch (e) { return null; }
  return c;
}
function encode(c, max) {
  if (!c) return null; let cv = c;
  for (let k = 0; k < 6; k++) {
    for (const q of [.72, .6, .5, .4]) { const d = g(() => cv.toDataURL('image/jpeg', q)); if (d && d.startsWith('data:image/jpeg') && b64bytes(d) <= max) return d; }
    const n = document.createElement('canvas'); n.width = Math.max(2, Math.round(cv.width * .75)); n.height = Math.max(2, Math.round(cv.height * .75)); n.getContext('2d').drawImage(cv, 0, 0, n.width, n.height); cv = n;
  }
  return null;
}
let pauseShot = null;   // canvas grabbed when the pause menu opened
async function capturePause() { await afterFrame(); if (g(() => S9().state) === 'paused' && !AIM.on) pauseShot = { c: grabCanvas(1024), at: Date.now() }; }

/* ================= what the game knows (attached automatically) ================= */
function context() {
  const s = S9() || {}, P = s.P || {}, N = s.NET || {};
  const hist = g(() => s.perf.hist.slice(-600), []) || [];
  let fps = { avg: null, slowPct: null, p95ms: null, samples: hist.length };
  if (hist.length > 10) { const mean = hist.reduce((a, b) => a + b, 0) / hist.length, srt = [...hist].sort((a, b) => a - b); fps = { avg: Math.round(1000 / mean), slowPct: Math.round(hist.filter(x => x > 25).length / hist.length * 1000) / 10, p95ms: Math.round(srt[Math.floor(srt.length * .95)] * 10) / 10, samples: hist.length }; }
  const map = g(() => s.CUR_MAP, '') || '';
  const online = !!N.on;
  const ping = online ? g(() => { const r = (typeof SRV !== 'undefined' && SRV.rtt) || N.rtt; return r ? Math.round(r) : null; }) : null;   // eslint-disable-line no-undef
  const acc = account().prof;
  return {
    version: gameVersion(), url: location.origin + location.pathname, map, mapName: g(() => (s.MAPS.find(m => m.id === map) || {}).name, '') || '',
    mode: online ? String(g(() => N.room && N.room.mode, '') || 'online') : 'bots', state: g(() => s.state, '') || '',
    weapon: g(() => P.weapon, '') || '', pos: vec(P.pos), yaw: g(() => r3(P.yaw)), pitch: g(() => r3(P.pitch)), hp: g(() => Math.round(P.hp)), dead: !!P.dead,
    fps, ping,
    online: { on: online, room: online ? String(N.code || g(() => N.room.code, '') || '') : '', players: online ? g(() => N.peers.size + 1, 1) : 0, host: false, server: online ? serverBase().replace(/^https?:\/\//, '') : '' },
    browser: navigator.userAgent, os: osName(), gpu: gpuName(), lang: navigator.language || '',
    screen: { w: screen.width, h: screen.height, dpr: r3(devicePixelRatio || 1), vw: innerWidth, vh: innerHeight },
    quality: g(() => typeof CFG !== 'undefined' && CFG.q, '') || '', renderScale: g(() => typeof PR !== 'undefined' ? r3(PR) : null),   // eslint-disable-line no-undef
    errors: LOGS.slice(-30), kills: KILLS.slice(0, 10),
    account: acc ? { id: String(acc.id), nick: String(acc.nick || '') } : null,
    uptimeS: Math.round((performance.now() - T0) / 1000), matchTimeS: g(() => Math.round(s.G.time), 0),
  };
}

/* ================= map pins: raycast what the player SEES, compare with what the game COLLIDES with ================= */
const AIM = { on: false, yaw: 0, pitch: 0, saved: null, locked: false, drag: null, layer: null };
const PIN_COLS = [0x7fe7ff, 0xff9a3c, 0xb6ff6a];
let markers = [];
function visibleTargets(s) {
  const out = [], THREE = s.THREE;
  s.scene.traverseVisible(o => {
    if (!o.isMesh || o.userData.s9bug) return;
    const ms = [].concat(o.material || []); if (!ms.length || ms.every(m => !m || m.visible === false)) return;
    const m = ms[0]; if (m && m.blending === THREE.AdditiveBlending && m.depthWrite === false) return;   // muzzle flashes, glows, decals
    if (m && m.transparent && m.opacity < .05) return;
    out.push(o);
  });
  return out;
}
function inTree(o, root) { for (let x = o; x; x = x.parent) if (x === root) return true; return false; }
function matName(m) {
  if (!m) return '';
  if (m.name) return m.name;
  const k = g(() => { /* eslint-disable no-undef */
    if (typeof MKMAT !== 'undefined') for (const set of Object.values(MKMAT)) for (const [n, v] of Object.entries(set || {})) if (v === m) return n;
    if (typeof MAT !== 'undefined') for (const [n, v] of Object.entries(MAT)) if (v === m) return n;
    return null; /* eslint-enable no-undef */ });
  return k || m.type;
}
function texName(m) {
  const t = m && m.map; if (!t) return '';
  if (t.name) return t.name; const src = g(() => t.image && (t.image.currentSrc || t.image.src), '') || '';
  return /^(data|blob):/.test(src) ? 'embedded' : src.split('/').slice(-2).join('/');
}
function userDataText(ud) {
  try { const o = {}; for (const [k, v] of Object.entries(ud || {})) { if (v == null || typeof v !== 'object') o[k] = v; else if (Array.isArray(v) && v.length <= 6 && v.every(x => typeof x !== 'object')) o[k] = v; } return JSON.stringify(o).slice(0, 400); } catch (e) { return ''; }
}
function probe() {
  const s = S9(), THREE = s.THREE, cam = s.camera; cam.updateMatrixWorld();
  const rc = new THREE.Raycaster(); rc.layers.enableAll(); rc.setFromCamera(new THREE.Vector2(0, 0), cam); rc.far = 600;
  const origin = rc.ray.origin.clone(), dir = rc.ray.direction.clone();
  const hits = rc.intersectObjects(visibleTargets(s), false);
  const h = hits[0] || null;
  const pin = { point: null, normal: null, distance: null, mesh: null, piece: '', pieceNear: null, collider: {}, mismatch: 'nothing', mismatchText: 'Nothing visible was hit (sky or too far).',
    cam: { pos: vec(cam.position), yaw: r3(AIM.yaw), pitch: r3(AIM.pitch), fov: r3(cam.fov) }, player: vec(s.P.pos), map: s.CUR_MAP || '', at: Date.now() };
  if (h) {
    const o = h.object, mats = [].concat(o.material), m = mats[(h.face && h.face.materialIndex) || 0] || mats[0];
    const n = h.face ? h.face.normal.clone().transformDirection(o.matrixWorld) : dir.clone().negate(); if (n.dot(dir) > 0) n.negate();
    const parents = []; for (let x = o.parent; x && x !== s.scene && parents.length < 6; x = x.parent) parents.push(x.name || x.type);
    const geo = o.geometry, tris = geo ? Math.round((geo.index ? geo.index.count : (geo.attributes.position || { count: 0 }).count) / 3) : 0;
    Object.assign(pin, { point: vec(h.point), normal: vec(n), distance: r3(h.distance),
      mesh: { name: o.name || '', type: o.type, material: matName(m), color: m && m.color ? '#' + m.color.getHexString() : '', surface: String(o.userData.surface || ''), texture: texName(m),
        parents, userData: userDataText(o.userData), uuid: o.uuid, inMap: inTree(o, s.MAPROOT), triangles: tris } });
    if (!pin.mesh.name && pin.mesh.inMap) pin.mesh.name = (o.userData.dyn ? 'map kit, merged ' : 'map, merged ') + pin.mesh.material;
  }
  // what bullets / sight lines stop at (the game's own test: world.meshes, with exact kit-piece shapes)
  const W = s.world, ray2 = new THREE.Raycaster(origin, dir, 0, 600);
  const bh = g(() => ray2.intersectObjects(W.meshes, false)[0], null);
  if (bh) { pin.collider.bulletDist = r3(bh.distance); if (bh.mkWhy) pin.collider.bulletPiece = String(bh.mkWhy); }
  if (bh && bh.mkWhy && (!h || Math.abs(bh.distance - h.distance) < .6)) pin.piece = String(bh.mkWhy);
  // what the player's body collides with (axis-aligned boxes)
  let rayD = null, rayP = null, tmp = new THREE.Vector3();
  for (const b of W.colliders) { if (b.containsPoint(origin)) continue; const p = rc.ray.intersectBox(b, tmp); if (p) { const d = origin.distanceTo(p); if (rayD === null || d < rayD) { rayD = d; rayP = p.clone(); } } }
  pin.collider.rayDist = rayD === null ? null : r3(rayD); pin.collider.rayPoint = vec(rayP);
  if (h) {
    const pt = h.point; let best = null, bd = Infinity;
    for (const b of W.colliders) { const d = b.distanceToPoint(pt); if (d < bd - 1e-6 || (Math.abs(d - bd) < 1e-6 && best && vol(b) < vol(best))) { bd = d; best = b; } }
    if (best) { pin.collider.nearest = { min: vec(best.min), max: vec(best.max) }; pin.collider.nearestDist = r3(bd); pin.collider.walk = !!best.walk; }
    pin.collider.groundY = g(() => r3(s.groundAt(pt.x, pt.z, pt.y, .25)));
    // nearest placed kit piece (kit maps log every placement)
    const log = g(() => s.MKLOG[s.CUR_MAP]);
    if (log && log.pieces && log.pieces.length) { let bp = null, bpd = Infinity; for (const p of log.pieces) { const d = Math.hypot(p.x - pt.x, p.z - pt.z); if (d < bpd) { bpd = d; bp = p; } } if (bp) pin.pieceNear = { piece: bp.piece, x: bp.x, z: bp.z, y: bp.y || 0, quarterTurns: bp.quarterTurns || 0, dist: r3(bpd) }; }
    verdict(pin, h, rayD);
  } else if (rayD !== null) {   // nothing visible, but something solid: the purest invisible wall
    Object.assign(pin, { point: vec(rayP), normal: vec(dir.clone().negate()), distance: r3(rayD), mesh: { name: '(nothing visible)', type: '', material: '', inMap: false },
      mismatch: 'invisible_wall', mismatchText: `Nothing is drawn here, but a collision box blocks the way ${rayD.toFixed(2)} m from the camera: an invisible wall.` });
  }
  return pin;
}
const vol = b => (b.max.x - b.min.x) * (b.max.y - b.min.y) * (b.max.z - b.min.z);
function verdict(pin, h, rayD) {
  const TOL = .3, dv = h.distance, n = pin.normal, c = pin.collider;
  if (rayD !== null && rayD < dv - TOL) { pin.mismatch = 'invisible_wall'; pin.mismatchText = `A collision box blocks ${(dv - rayD).toFixed(2)} m in front of the visible surface: an invisible wall or an oversized box.`; return; }
  if (n[1] > .7) {   // floor-like: where would a player standing here end up?
    const gy = c.groundY, y = pin.point[1];
    if (gy !== null && Math.abs(gy - y) <= TOL) { pin.mismatch = 'ok'; pin.mismatchText = 'Floor: the visible surface and the walkable height agree.'; return; }
    if (gy !== null && gy < y - TOL) { pin.mismatch = 'no_floor_collision'; pin.mismatchText = `Visible floor at height ${y.toFixed(2)} but a player would stand at ${gy.toFixed(2)}: they would fall through or sink in.`; return; }
    pin.mismatch = 'floating_floor'; pin.mismatchText = `A collision box top (${gy}) is above the visible floor (${y.toFixed(2)}): players would float.`; return;
  }
  if ((c.nearestDist == null || c.nearestDist > TOL) && (rayD === null || rayD > dv + TOL)) {
    pin.mismatch = 'walk_through'; pin.mismatchText = 'The visible surface has no collision box here: players can walk through it' + (c.bulletDist != null && Math.abs(c.bulletDist - dv) < .6 ? ' (bullets do stop on it).' : ' and bullets pass through (fine only for decoration like railings or light strips).'); return;
  }
  pin.mismatch = 'ok'; pin.mismatchText = 'The visible surface and its collision box agree here.';
}
function makeMarker(p, i) {
  const s = S9(), THREE = s.THREE, grp = new THREE.Group(); grp.userData.s9bug = true;
  const col = PIN_COLS[i % PIN_COLS.length];
  const core = new THREE.Mesh(new THREE.SphereGeometry(.07, 12, 8), new THREE.MeshBasicMaterial({ color: col, toneMapped: false, fog: false }));
  const halo = new THREE.Mesh(new THREE.SphereGeometry(.2, 16, 10), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: .35, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false }));
  halo.renderOrder = 999;
  const n = new THREE.Vector3(...(p.normal || [0, 1, 0])).normalize();
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(.012, .012, .45, 6), core.material); stick.position.copy(n).multiplyScalar(.225); stick.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
  const head = new THREE.Mesh(new THREE.SphereGeometry(.05, 10, 8), core.material); head.position.copy(n).multiplyScalar(.45);
  for (const m of [core, halo, stick, head]) { m.userData.s9bug = true; m.castShadow = m.receiveShadow = false; m.frustumCulled = false; grp.add(m); }
  grp.position.set(...p.point); s.scene.add(grp); return grp;
}
function clearMarkers() {
  for (const m of markers) { try { m.parent && m.parent.remove(m); m.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); } catch (e) {} }
  markers = [];
}
function syncMarkers() { clearMarkers(); FORM.pins.forEach((p, i) => { if (p.point) markers.push(makeMarker(p, i)); }); }

/* ================= aiming mode ================= */
function syncPause() {
  const pz = $('pause'); if (!pz || g(() => S9().state) !== 'paused') return;
  pz.hidden = !UI.root.hidden || AIM.on;
}
function setGun(v) { try { if (typeof gunVisible !== 'undefined') gunVisible = v; } catch (e) {} }   // eslint-disable-line no-undef
function canAim() { const s = S9(); return !!(s && s.state === 'paused' && s.CUR_MAP && s.P && !s.P.dead); }
function applyAim() { const cam = S9().camera; cam.rotation.set(AIM.pitch, AIM.yaw, 0); cam.updateMatrixWorld(); }
function startAim() {
  if (AIM.on || FORM.pins.length >= MAX_PINS || !canAim()) return false;
  const s = S9(), cam = s.camera;
  AIM.on = true; AIM.saved = { x: cam.rotation.x, y: cam.rotation.y, z: cam.rotation.z }; AIM.yaw = cam.rotation.y; AIM.pitch = cam.rotation.x; AIM.drag = null;
  UI.root.hidden = true; syncPause(); setGun(false);
  document.documentElement.classList.add('s9bug-aiming');
  UI.aimN.textContent = `Pin ${FORM.pins.length + 1} of ${MAX_PINS}`; UI.aim.hidden = false; applyAim();
  AIM.locked = false; setHint();
  const cv = s.renderer.domElement;
  try { const r = cv.requestPointerLock(); if (r && r.catch) r.catch(() => setHint()); } catch (e) {}
  return true;
}
function setHint() {
  AIM.locked = !!document.pointerLockElement;
  UI.hint.textContent = AIM.locked ? 'Aim at the broken spot and click (Esc to cancel)' : 'Drag to aim, then click the broken spot (Esc to cancel)';
}
function endAim(keepView) {
  if (!AIM.on) return;
  AIM.on = false; UI.aim.hidden = true; document.documentElement.classList.remove('s9bug-aiming');
  const cam = g(() => S9().camera); if (cam && AIM.saved && !keepView) { cam.rotation.set(AIM.saved.x, AIM.saved.y, AIM.saved.z); cam.updateMatrixWorld(); }
  if (document.pointerLockElement) try { document.exitPointerLock(); } catch (e) {}
  if (g(() => S9().state) === 'paused') { setGun(true); syncPause(); }
}
function cancelAim() { if (!AIM.on) return; endAim(); if (g(() => S9().state) === 'paused' || g(() => S9().state) === 'menu') showForm(); }
async function placePin() {
  if (!AIM.on || AIM.busy) return null;
  if (FORM.pins.length >= MAX_PINS) { cancelAim(); return null; }
  AIM.busy = true;
  try {
    const p = probe();
    if (!p.point) { UI.hint.textContent = 'Nothing there to pin (sky or too far). Aim at the map and click.'; return null; }
    FORM.pins.push(p); syncMarkers();
    UI.aim.hidden = true; await afterFrame(); await afterFrame();   // one clean frame with the marker and without our crosshair
    p.shot = encode(grabCanvas(640), MAX_PIN_SHOT);
    endAim(); showForm(); renderPins(); preview();
    return p;
  } finally { AIM.busy = false; }
}
function aimLook(dx, dy) {
  const sens = g(() => (typeof CFG !== 'undefined' && +CFG.sens) || 1, 1), fov = g(() => S9().camera.fov, 78), k = .0021 * sens * Math.min(1, fov / 78);   // eslint-disable-line no-undef
  AIM.yaw -= dx * k; AIM.pitch = Math.max(-1.5, Math.min(1.5, AIM.pitch - dy * k)); applyAim();
}
document.addEventListener('mousemove', e => {
  if (!AIM.on) return;
  if (document.pointerLockElement) aimLook(e.movementX || 0, e.movementY || 0);
  else if (AIM.drag) { const dx = e.clientX - AIM.drag.x, dy = e.clientY - AIM.drag.y; AIM.drag.x = e.clientX; AIM.drag.y = e.clientY; AIM.drag.moved += Math.abs(dx) + Math.abs(dy); aimLook(dx, dy); }
}, true);
document.addEventListener('mousedown', e => {
  if (!AIM.on) return; e.stopPropagation(); e.preventDefault();
  if (e.button !== 0) return;
  if (document.pointerLockElement) placePin(); else AIM.drag = { x: e.clientX, y: e.clientY, moved: 0 };
}, true);
document.addEventListener('mouseup', e => { if (!AIM.on || e.button !== 0 || !AIM.drag) return; const moved = AIM.drag.moved; AIM.drag = null; if (moved < 5) placePin(); }, true);
document.addEventListener('pointerlockchange', () => { if (!AIM.on) return; if (document.pointerLockElement) { setHint(); return; } if (AIM.locked) cancelAim(); else setHint(); });
document.addEventListener('keydown', e => { if (AIM.on && e.code === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancelAim(); } }, true);

/* ================= the form ================= */
const FORM = { pins: [], ctx: null, shot: null, draft: null, sending: false };
const UI = {};
const CSS = `
#s9bug{position:fixed;inset:0;z-index:60;display:grid;place-items:center;padding:20px 16px;background:linear-gradient(90deg,rgba(11,13,16,.96) 0 50%,rgba(11,13,16,.6));overflow:auto;font-family:var(--mono,"IBM Plex Mono",ui-monospace,Consolas,monospace);color:var(--ink,#ece6d8)}
#s9bug[hidden],#s9bug-aim[hidden],#s9bug-toast[hidden],#s9bug [hidden]{display:none!important}
#s9bug .s9b-sheet{width:min(600px,100%);justify-self:start;margin-left:clamp(0px,6vw,90px);display:grid;gap:14px;min-width:0}
#s9bug .s9b-kicker{font-size:12px;letter-spacing:.3em;text-transform:uppercase;color:var(--sodium,#ff9a3c)}
#s9bug h2{font-family:var(--display,Impact,"Arial Narrow",sans-serif);font-weight:900;font-size:clamp(40px,7vw,72px);line-height:.85;margin:0}
#s9bug .s9b-grid{display:grid;grid-template-columns:1.3fr 1fr;gap:12px}
#s9bug label.s9b-f{display:grid;gap:6px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim,#8b9097);min-width:0}
#s9bug label.s9b-f span.s9b-n{float:right;letter-spacing:.04em;text-transform:none}
#s9bug input[type=text],#s9bug select,#s9bug textarea{width:100%;box-sizing:border-box;background:var(--bg,#0b0d10);color:var(--ink,#ece6d8);border:1px solid var(--line,rgba(236,230,216,.18));font:13px/1.45 var(--mono,ui-monospace,monospace);padding:9px 10px;letter-spacing:normal;text-transform:none;border-radius:0}
#s9bug textarea{resize:vertical;min-height:96px;max-height:40vh}
#s9bug input:focus-visible,#s9bug select:focus-visible,#s9bug textarea:focus-visible{outline:2px solid var(--sodium,#ff9a3c);outline-offset:1px}
#s9bug .s9b-pins{display:grid;gap:8px;border:1px solid var(--line,rgba(236,230,216,.18));padding:12px;background:rgba(127,231,255,.04)}
#s9bug .s9b-pins[hidden]{display:none}
#s9bug .s9b-pin{display:grid;grid-template-columns:64px 1fr auto;gap:10px;align-items:center;font-size:12px}
#s9bug .s9b-pin img{width:64px;height:36px;object-fit:cover;border:1px solid var(--line,rgba(236,230,216,.18))}
#s9bug .s9b-pin b{display:block;font-size:12px;color:var(--cyan,#7fe7ff)} #s9bug .s9b-pin small{color:var(--dim,#8b9097);display:block;overflow-wrap:anywhere}
#s9bug .s9b-check{display:flex;gap:10px;align-items:center;font-size:12px;color:var(--ink,#ece6d8);flex-wrap:wrap}
#s9bug .s9b-check input{accent-color:var(--sodium,#ff9a3c);width:16px;height:16px;margin:0}
#s9bug .s9b-check img{height:40px;border:1px solid var(--line,rgba(236,230,216,.18))}
#s9bug details{border-top:1px solid var(--line,rgba(236,230,216,.18));padding-top:10px;font-size:12px;min-width:0}
#s9bug summary{cursor:pointer;color:var(--dim,#8b9097);letter-spacing:.12em;text-transform:uppercase;font-size:11px}
#s9bug pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:30vh;overflow:auto;background:rgba(0,0,0,.35);padding:10px;margin:8px 0 0;font-size:11px;line-height:1.45;color:var(--dim,#8b9097)}
#s9bug .s9b-row{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
#s9bug .s9b-go{font-family:var(--display,Impact,sans-serif);font-weight:900;font-size:22px;letter-spacing:.08em;text-transform:uppercase;color:#14100b;background:var(--sodium,#ff9a3c);border:0;padding:12px 26px 10px;cursor:pointer;clip-path:polygon(0 0,100% 0,100% 70%,calc(100% - 12px) 100%,0 100%)}
#s9bug .s9b-go:hover{background:#ffb066} #s9bug .s9b-go[disabled]{opacity:.5;cursor:wait}
#s9bug .s9b-ghost{font-family:var(--mono,ui-monospace,monospace);font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--ink,#ece6d8);background:transparent;border:1px solid var(--line,rgba(236,230,216,.18));padding:10px 14px;cursor:pointer}
#s9bug .s9b-ghost[disabled]{opacity:.4;cursor:default}
#s9bug .s9b-x{background:none;border:0;color:var(--dim,#8b9097);font-size:18px;cursor:pointer;padding:4px 8px}
#s9bug .s9b-go:focus-visible,#s9bug .s9b-ghost:focus-visible,#s9bug .s9b-x:focus-visible{outline:2px solid var(--ink,#ece6d8);outline-offset:3px}
#s9bug .s9b-msg{font-size:12px;color:var(--dim,#8b9097);line-height:1.5} #s9bug .s9b-msg.err{color:var(--alert,#ff4a3d)} #s9bug .s9b-msg.ok{color:#9dffb0}
#s9bug .s9b-note{font-size:11.5px;color:var(--dim,#8b9097);line-height:1.5;margin:0}
#s9bug .s9b-done{display:grid;gap:14px} #s9bug .s9b-done[hidden]{display:none}
#s9bug .s9b-done b{font-family:var(--display,Impact,sans-serif);font-size:34px;font-weight:900}
#s9bug-aim{position:fixed;inset:0;z-index:58;cursor:crosshair}
#s9bug-aim .s9b-hint{position:absolute;left:50%;top:calc(16% + env(safe-area-inset-top,0px));transform:translateX(-50%);max-width:calc(100% - 32px);box-sizing:border-box;text-align:center;font:600 13px/1.4 var(--mono,ui-monospace,monospace);letter-spacing:.06em;color:var(--ink,#ece6d8);background:rgba(11,13,16,.78);border:1px solid rgba(127,231,255,.45);padding:9px 14px}
#s9bug-aim .s9b-pinN{position:absolute;left:50%;top:calc(16% + 48px);transform:translateX(-50%);font:11px var(--mono,monospace);letter-spacing:.2em;text-transform:uppercase;color:var(--cyan,#7fe7ff)}
#s9bug-aim .s9b-cross{position:absolute;left:50%;top:50%;width:34px;height:34px;margin:-17px 0 0 -17px;border:2px solid var(--cyan,#7fe7ff);border-radius:50%;box-shadow:0 0 10px rgba(127,231,255,.8),inset 0 0 6px rgba(127,231,255,.5);pointer-events:none}
#s9bug-aim .s9b-cross::before,#s9bug-aim .s9b-cross::after{content:"";position:absolute;background:var(--cyan,#7fe7ff)}
#s9bug-aim .s9b-cross::before{left:50%;top:-9px;bottom:-9px;width:2px;margin-left:-1px;-webkit-mask:linear-gradient(#000 0 9px,transparent 9px calc(100% - 9px),#000 0);mask:linear-gradient(#000 0 9px,transparent 9px calc(100% - 9px),#000 0)}
#s9bug-aim .s9b-cross::after{left:50%;top:50%;width:4px;height:4px;margin:-2px 0 0 -2px;border-radius:50%}
html.s9bug-aiming #hud{visibility:hidden}
#s9bug-toast{position:fixed;left:50%;bottom:calc(28px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:61;max-width:calc(100% - 32px);box-sizing:border-box;font:12px/1.4 var(--mono,ui-monospace,monospace);letter-spacing:.06em;color:var(--ink,#ece6d8);background:rgba(11,13,16,.9);border-left:3px solid var(--sodium,#ff9a3c);padding:10px 14px;pointer-events:none}
@media (max-width:520px){#s9bug .s9b-grid{grid-template-columns:1fr}#s9bug .s9b-sheet{margin-left:0}#s9bug{background:rgba(11,13,16,.95);place-items:start center}}
@media (prefers-reduced-motion:no-preference){#s9bug .s9b-sheet{animation:s9bIn .16s ease-out}@keyframes s9bIn{from{opacity:0;transform:translateX(-10px)}}}
`;
function buildUI() {
  document.head.appendChild(el('style', { id: 's9bug-css', text: CSS }));
  const opt = ([v, t]) => el('option', { value: v, text: t });
  UI.cat = el('select', { id: 's9bCat' }, [el('option', { value: '', text: 'Choose one' }), ...CATS.map(opt)]);
  UI.freq = el('select', { id: 's9bFreq' }, FREQS.map(opt)); UI.freq.value = 'sometimes';
  UI.title = el('input', { id: 's9bTitle', type: 'text', maxlength: '80', autocomplete: 'off', spellcheck: 'true', placeholder: 'e.g. I fell through the floor next to the cargo ramp' });
  UI.titleN = el('span', { class: 's9b-n', text: '0/80' });
  UI.desc = el('textarea', { id: 's9bDesc', maxlength: '2000', rows: '5', placeholder: 'What did you do, what did you expect, and what happened instead?' });
  UI.descN = el('span', { class: 's9b-n', text: '0/2000' });
  UI.pinList = el('div', { class: 's9b-pinlist' });
  UI.pinBtn = el('button', { type: 'button', class: 's9b-ghost', id: 's9bPinBtn', text: 'Point at the spot', onclick: () => { if (!startAim()) renderPins(); } });
  UI.pinNote = el('div', { class: 's9b-msg' });
  UI.pins = el('div', { class: 's9b-pins', id: 's9bPins', hidden: true }, [el('div', { class: 's9b-kicker', text: 'Map pins' }), UI.pinList, el('div', { class: 's9b-row' }, [UI.pinBtn, UI.pinNote])]);
  UI.shotOn = el('input', { type: 'checkbox', id: 's9bShot', checked: true });
  UI.shotImg = el('img', { alt: 'Screenshot that will be attached', hidden: true });
  UI.shotLbl = el('span', { text: 'Include a screenshot of the game' });
  UI.json = el('pre', { id: 's9bJson' });
  UI.what = el('details', { id: 's9bWhat' }, [el('summary', { text: 'Exactly what will be sent' }), UI.json]);
  UI.send = el('button', { type: 'button', class: 's9b-go', id: 's9bSend', text: 'Send report', onclick: submit });
  UI.back = el('button', { type: 'button', class: 's9b-ghost', id: 's9bBack', text: 'Back', onclick: close });
  UI.msg = el('div', { class: 's9b-msg', id: 's9bMsg', role: 'status', 'aria-live': 'polite' });
  UI.form = el('div', { class: 's9b-formbody' }, []);
  UI.doneT = el('b', { id: 's9bDone' }); UI.doneS = el('div', { class: 's9b-msg' });
  UI.done = el('div', { class: 's9b-done', hidden: true }, [UI.doneT, UI.doneS, el('div', { class: 's9b-row' }, [el('button', { type: 'button', class: 's9b-go', id: 's9bDoneBack', text: 'Back to the game', onclick: close })])]);
  UI.body = el('div', { style: 'display:grid;gap:14px;min-width:0' }, [
    el('div', { class: 's9b-grid' }, [el('label', { class: 's9b-f' }, ['What kind of problem', UI.cat]), el('label', { class: 's9b-f' }, ['How often', UI.freq])]),
    UI.pins,
    el('label', { class: 's9b-f' }, [el('span', {}, ['Short title ', UI.titleN]), UI.title]),
    el('label', { class: 's9b-f' }, [el('span', {}, ['What happened ', UI.descN]), UI.desc]),
    el('label', { class: 's9b-check' }, [UI.shotOn, UI.shotLbl, UI.shotImg]),
    UI.what,
    el('div', { class: 's9b-row' }, [UI.send, UI.back]), UI.msg,
    el('p', { class: 's9b-note', text: 'We read every report and check it ourselves before anything in the game is changed. Please do not write passwords or private details.' }),
  ]);
  UI.root = el('div', { id: 's9bug', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 's9bugH', hidden: true }, [
    el('div', { class: 's9b-sheet' }, [el('div', { class: 's9b-kicker', text: 'Bug report · goes to the Sector Nine team' }), el('h2', { id: 's9bugH', text: 'Report a bug' }), UI.body, UI.done])]);
  UI.hint = el('div', { class: 's9b-hint', role: 'status' }); UI.aimN = el('div', { class: 's9b-pinN' });
  UI.aim = el('div', { id: 's9bug-aim', hidden: true }, [UI.hint, UI.aimN, el('div', { class: 's9b-cross' })]);
  UI.toast = el('div', { id: 's9bug-toast', role: 'status', hidden: true });
  document.body.append(UI.root, UI.aim, UI.toast);
  // typing in the form must never reach the game (Enter would start a match from the main menu)
  // (window capture phase: runs before the game and the other modules; typing itself is not affected)
  for (const t of ['keydown', 'keyup', 'keypress']) addEventListener(t, e => {
    if (UI.root.hidden || AIM.on) return;
    e.stopImmediatePropagation();
    if (t === 'keydown' && e.code === 'Escape') { e.preventDefault(); close(); }
  }, true);
  UI.root.addEventListener('mousedown', e => e.stopPropagation()); UI.root.addEventListener('wheel', e => e.stopPropagation(), { passive: true });
  const counts = () => { UI.titleN.textContent = `${UI.title.value.length}/80`; UI.descN.textContent = `${UI.desc.value.length}/2000`; };
  for (const x of [UI.title, UI.desc]) x.addEventListener('input', () => { counts(); preview(); });
  UI.freq.addEventListener('change', preview); UI.shotOn.addEventListener('change', preview);
  UI.cat.addEventListener('change', () => { renderPins(); preview(); if (UI.cat.value === 'map' && !FORM.pins.length && canAim()) startAim(); });
  UI.counts = counts;
}
function addButtons() {
  const mk = (id, ref) => {
    if ($(id)) return true; const r = $(ref); if (!r || !r.parentNode) return false;
    const b = el('button', { type: 'button', class: 'ghost', id, text: 'Report a bug', onclick: e => { e.stopPropagation(); open(); } });
    r.parentNode.insertBefore(b, r.nextSibling); return true;
  };
  const a = mk('btnBug', $('btnLobby') ? 'btnLobby' : 'btnArsenal2'), b = mk('btnBugMenu', 'btnOnline');
  return a && b;
}
function renderPins() {
  const isMap = UI.cat.value === 'map'; UI.pins.hidden = !isMap && !FORM.pins.length;
  UI.pinList.textContent = '';
  FORM.pins.forEach((p, i) => {
    const what = p.piece ? p.piece.replace(/#\d+$/, '') : p.pieceNear && p.pieceNear.dist < 3 ? p.pieceNear.piece : (p.mesh && (p.mesh.name || p.mesh.material)) || 'surface';
    const img = p.shot ? el('img', { src: p.shot, alt: `Pin ${i + 1} screenshot` }) : el('span', { text: '' });
    UI.pinList.append(el('div', { class: 's9b-pin' }, [img, el('div', {}, [el('b', { text: `Pin ${i + 1}: ${what}` }), el('small', { text: `${p.distance} m away · ${p.mismatchText}` })]),
      el('button', { type: 'button', class: 's9b-x', 'aria-label': `Remove pin ${i + 1}`, text: '×', onclick: () => { FORM.pins.splice(i, 1); syncMarkers(); renderPins(); preview(); } })]));
  });
  const full = FORM.pins.length >= MAX_PINS, can = canAim();
  UI.pinBtn.disabled = full || !can;
  UI.pinBtn.textContent = FORM.pins.length ? `Add another pin (${FORM.pins.length}/${MAX_PINS})` : 'Point at the spot';
  UI.pinNote.textContent = full ? `That's the maximum of ${MAX_PINS} pins.` : !can ? (g(() => S9().state) === 'menu' ? 'To pin a spot, open this from the pause menu (Esc) during a match.' : 'Pins work while you are alive in a match.') : 'The menu hides, aim at the broken spot with the crosshair and click.';
}
function payload() {
  const shot = UI.shotOn.checked ? FORM.shot : null;
  return { category: UI.cat.value, frequency: UI.freq.value, title: UI.title.value.trim(), description: UI.desc.value.trim(), context: FORM.ctx, screenshot: shot || undefined,
    pins: FORM.pins.length ? FORM.pins.map(p => Object.assign({}, p)) : undefined };
}
function preview() {
  if (UI.root.hidden) return;
  const p = payload();
  const view = JSON.parse(JSON.stringify(p, (k, v) => (k === 'screenshot' || k === 'shot') && typeof v === 'string' ? `[JPEG image of the game, ${kb(b64bytes(v))}]` : v));
  view.sentTo = serverBase() + '/api/bugs'; if (account().token) view.login = 'your login token (only to check it is really you)';
  UI.json.textContent = JSON.stringify(view, null, 2);
  UI.shotImg.hidden = !(UI.shotOn.checked && FORM.shot); if (FORM.shot) UI.shotImg.src = FORM.shot;
  UI.shotLbl.textContent = FORM.shot ? `Include a screenshot of the game (${kb(b64bytes(FORM.shot))})` : 'Include a screenshot of the game (not available)';
  UI.shotOn.disabled = !FORM.shot;
}
function showForm() { UI.root.hidden = false; syncPause(); renderPins(); preview(); }
let opening = false;
async function open() {
  if (opening || !S9()) return; opening = true;
  try {
    hookGame();
    const st = g(() => S9().state);
    if (st !== 'paused' && st !== 'menu' && st !== 'matchend') return;
    if (!FORM.ctx || FORM.closedAt) { FORM.ctx = context(); FORM.shot = null; }
    FORM.closedAt = 0;
    // screenshot: the one taken when the pause menu opened, else the frame on screen now
    if (!FORM.shot) { let c = st === 'paused' && pauseShot && pauseShot.c; if (!c) { await afterFrame(); c = grabCanvas(1024); } FORM.shot = encode(c, MAX_SHOT); }
    UI.done.hidden = true; UI.body.hidden = false; UI.msg.textContent = ''; UI.msg.className = 's9b-msg'; UI.send.disabled = false;
    UI.counts(); showForm(); syncMarkers();
    setTimeout(() => { try { (UI.cat.value ? UI.title : UI.cat).focus({ preventScroll: true }); } catch (e) {} }, 0);
  } finally { opening = false; }
}
function close() {
  if (AIM.on) endAim();
  UI.root.hidden = true; clearMarkers(); syncPause();
  FORM.closedAt = Date.now();   // draft text stays, the context is refreshed on the next open
  if (FORM.sentOk) { resetForm(); FORM.sentOk = false; }
  const st = g(() => S9().state); const back = st === 'paused' ? $('btnBug') : st === 'menu' ? $('btnBugMenu') : null;
  if (back) try { back.focus({ preventScroll: true }); } catch (e) {}
}
function resetForm() { FORM.pins = []; FORM.ctx = null; FORM.shot = null; UI.cat.value = ''; UI.freq.value = 'sometimes'; UI.title.value = ''; UI.desc.value = ''; UI.shotOn.checked = true; UI.counts(); }
function onState(s, prev) {
  if (s === 'paused' && prev !== 'paused') capturePause();
  if (s !== 'paused' && AIM.on) endAim();
  if ((s === 'play' || s === 'dead') && !UI.root.hidden) close();   // the match took over: never block gameplay (the draft is kept)
  if (s !== 'paused') pauseShot = null;
}
function say(t, kind) { UI.msg.textContent = t; UI.msg.className = 's9b-msg' + (kind ? ' ' + kind : ''); }

/* ================= sending + offline queue ================= */
async function post(body) {
  const tok = account().token;
  const r = await fetch(serverBase() + '/api/bugs', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, tok ? { authorization: 'Bearer ' + tok } : {}), body: JSON.stringify(body), mode: 'cors', credentials: 'omit', cache: 'no-store' });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, j: j || {} };
}
const ERR = { too_long: 'That text is too long.', bad_field: 'Please check the fields.', bad_screenshot: 'The screenshot could not be used, untick it and try again.', rate_limited: 'You have sent several reports in a short time. Please wait a bit and try again.', too_big: 'The report is too big, untick the screenshot and try again.' };
async function submit() {
  if (FORM.sending) return;
  const p = payload();
  if (!p.category) { say('Pick what kind of problem it is.', 'err'); UI.cat.focus(); return; }
  if (p.title.length < 3) { say('Give it a short title (at least 3 letters).', 'err'); UI.title.focus(); return; }
  if (p.description.length < 5) { say('Describe what happened (a sentence is enough).', 'err'); UI.desc.focus(); return; }
  FORM.sending = true; UI.send.disabled = true; say('Sending...');
  API._last = p;
  try {
    let res = null; try { res = await post(p); } catch (e) { res = null; }
    if (res && res.status === 200 && res.j.ok) return done(`Thanks, report #${res.j.id} sent`, res.j.duplicate ? 'Someone reported the same thing a moment ago, we added yours to it. We will check it and fix it if it is a real bug.' : 'We will check it and fix it if it is a real bug.', res.j.id);
    if (!res || res.status >= 500 || res.status === 0) {   // no connection or the server is down: keep it and retry later
      const ok = enqueue(p); if (ok) return done('Saved, it will be sent soon', 'No connection to the report server right now. Your report is kept on this device and sent automatically when the connection is back.', null);
      say('Could not reach the report server. Please try again later.', 'err'); return;
    }
    const e = res.j.error; say((ERR[e] || 'The report was not accepted.') + (res.j.field && e !== 'rate_limited' ? ` (${res.j.field})` : ''), 'err');
  } finally { FORM.sending = false; UI.send.disabled = false; }
}
function done(title, sub, id) {
  UI.body.hidden = true; UI.done.hidden = false; UI.doneT.textContent = title; UI.doneS.textContent = sub; FORM.sentOk = true; API._lastId = id;
  clearMarkers(); setTimeout(() => { try { $('s9bDoneBack').focus({ preventScroll: true }); } catch (e) {} }, 0);
}
function enqueue(p) {
  const q = (ls.get(QUEUE_KEY) || []).slice(-(QUEUE_MAX - 1)); const item = { p, t: Date.now() };
  q.push(item); if (ls.set(QUEUE_KEY, q)) return true;
  // storage full: drop the pictures, keep the words
  item.p = Object.assign({}, p, { screenshot: undefined, pins: p.pins && p.pins.map(x => Object.assign({}, x, { shot: undefined })) });
  return ls.set(QUEUE_KEY, q) || ls.set(QUEUE_KEY, [item]);
}
let flushing = false;
async function flush() {
  if (flushing) return 0; const q = ls.get(QUEUE_KEY); if (!Array.isArray(q) || !q.length) return 0;
  flushing = true; let sent = 0;
  try {
    const left = [];
    for (const it of q) {
      if (!it || !it.p || Date.now() - it.t > 7 * 86400000) continue;   // a week old: drop it
      let res = null; try { res = await post(it.p); } catch (e) {}
      if (res && res.status === 200 && res.j.ok) { sent++; toast(`Bug report #${res.j.id} sent. Thank you!`); API._lastId = res.j.id; }
      else if (!res || res.status >= 500 || res.status === 429) left.push(it);   // keep for later; a 4xx means it will never be accepted
    }
    ls.set(QUEUE_KEY, left.length ? left : null);
  } finally { flushing = false; }
  return sent;
}
let toastT = 0;
function toast(t) { UI.toast.textContent = t; UI.toast.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { UI.toast.hidden = true; }, 4500); }

/* ================= public API (tests + other modules) ================= */
const API = {
  open, close, flush,
  get isOpen() { return !UI.root.hidden; }, get aiming() { return AIM.on; }, get pins() { return FORM.pins; }, get markers() { return markers.length; },
  get queue() { return (ls.get(QUEUE_KEY) || []).length; }, server: serverBase, context, version: gameVersion,
  startAim, cancelAim, pin: placePin,
  aim(yaw, pitch) { if (!AIM.on) return false; AIM.yaw = yaw; AIM.pitch = Math.max(-1.5, Math.min(1.5, pitch)); applyAim(); return true; },
  aimAt(x, y, z) { if (!AIM.on) return false; const c = S9().camera.position, dx = x - c.x, dy = y - c.y, dz = z - c.z; return API.aim(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz))); },
  _last: null, _lastId: null, _pauseShot: () => !!(pauseShot && pauseShot.c), _probe: probe,
};
window.S9Bug = API;

/* ================= boot: wait for the game ================= */
let booted = false;
function boot() {
  if (booted) return true;
  if (!document.body || !S9() || !$('pause') || !$('menu')) return false;
  booted = true;
  try { buildUI(); hookGame(); addButtons(); } catch (e) { logPush('bugreport', [e]); }
  setTimeout(flush, 4000); setInterval(() => { if (g(() => S9().state) !== 'play') flush(); }, 60000);
  addEventListener('online', () => flush());
  // other modules may rebuild the menu rows later: put our buttons back if they disappear
  setInterval(() => { try { addButtons(); hookGame(); } catch (e) {} }, 2000);
  return true;
}
if (!boot()) { const t = setInterval(() => { if (boot()) clearInterval(t); }, 250); }
})();
