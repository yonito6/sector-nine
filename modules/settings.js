/* Sector Nine - Settings menu (Gameplay, Controls, Mouse, Crosshair, Video, Audio).
   Add-on module: loaded after index.html's main script. index.html keeps all its code inside an IIFE, so this module only
   talks to the game through window.__s9 (P, camera, renderer, AU, sfx, robots, keys, WEAPONS, state), the DOM (the old
   quick-settings sliders #msens/#mvol/#mq drive the game's own CFG), and input events (keys/mouse are re-mapped by
   capture-phase listeners that re-dispatch the game's default key codes). No index.html edits needed.
   Storage: localStorage 'sector9-settings' (+ PUT /api/me/settings through window.S9Account when logged in). */
(() => {
'use strict';
if (window.S9Settings) return;

/* ============ defaults (identical to data/settings_default.json, the QA test checks they match) ============ */
const DEFAULTS = {
  v: 1,
  gameplay: { damageNumbers: true, killFeedSize: 'normal', hitSound: true, colorblind: 'off' },
  controls: {
    adsMode: 'hold',
    binds: {
      forward: ['KeyW', ''], back: ['KeyS', ''], left: ['KeyA', ''], right: ['KeyD', ''],
      jump: ['Space', ''], crouch: ['KeyC', ''], crouchHold: ['ControlLeft', 'ControlRight'], sprint: ['ShiftLeft', 'ShiftRight'], dash: ['KeyE', ''],
      fire: ['Mouse0', ''], ads: ['Mouse2', ''], reload: ['KeyR', ''], grenade: ['KeyG', ''], overdrive: ['KeyF', ''],
      primary: ['Digit1', ''], secondary: ['Digit2', ''], knife: ['Digit3', ''], weapon4: ['Digit4', ''], swap: ['KeyQ', ''],
      interact: ['KeyX', ''], scoreboard: ['Tab', ''], pause: ['Escape', ''], ptt: ['KeyV', '']
    }
  },
  mouse: { sens: 1, adsMult: 1, invertY: false },
  crosshair: { style: 'crossdot', color: '#ece6d8', length: 9, thickness: 2, gap: 5, outline: true, outlineThickness: 1, outlineOpacity: .5, dot: 2, opacity: 1, dynamic: true, adsShow: false },
  video: { fov: 78, quality: 'medium', fps: true, shake: 1, brightness: 1, gamma: 1 },
  audio: { master: .8, effects: 1, ambience: 1, footsteps: 1, voice: 1, muteUnfocused: false }
};
// number limits and allowed values (used to clean anything loaded from storage, the server or a share code)
const NUM = {
  'mouse.sens': [.05, 10], 'mouse.adsMult': [.1, 3],
  'crosshair.length': [0, 30], 'crosshair.thickness': [1, 10], 'crosshair.gap': [-4, 30], 'crosshair.outlineThickness': [1, 4], 'crosshair.outlineOpacity': [0, 1],
  'crosshair.dot': [0, 10], 'crosshair.opacity': [.1, 1],
  'video.fov': [70, 110], 'video.shake': [0, 1], 'video.brightness': [.6, 1.5], 'video.gamma': [.6, 1.6],
  'audio.master': [0, 1], 'audio.effects': [0, 1], 'audio.ambience': [0, 1], 'audio.footsteps': [1, 2], 'audio.voice': [0, 1]
};
const ENUM = {
  'gameplay.killFeedSize': ['small', 'normal', 'large'], 'gameplay.colorblind': ['off', 'deuteranopia', 'protanopia', 'tritanopia'],
  'controls.adsMode': ['hold', 'toggle'], 'crosshair.style': ['cross', 'dot', 'circle', 'tshape', 'crossdot', 'chevron'],
  'video.quality': ['low', 'medium', 'high', 'ultra', 'auto']
};
const LS_KEY = 'sector9-settings';

/* ============ actions (what the game does) -> the key code index.html listens for ============ */
const ACTIONS = [
  ['Movement', 'forward', 'Move forward', 'KeyW'], ['Movement', 'back', 'Move back', 'KeyS'], ['Movement', 'left', 'Strafe left', 'KeyA'], ['Movement', 'right', 'Strafe right', 'KeyD'],
  ['Movement', 'jump', 'Jump (twice = double jump)', 'Space'], ['Movement', 'sprint', 'Sprint (hold)', 'ShiftLeft'], ['Movement', 'crouch', 'Crouch toggle / slide while sprinting', 'KeyC'],
  ['Movement', 'crouchHold', 'Crouch (hold)', 'ControlLeft'], ['Movement', 'dash', 'Dash · Use / Plant / Defuse', 'KeyE'],
  ['Combat', 'fire', 'Fire', 'Mouse0'], ['Combat', 'ads', 'Aim down sights', 'Mouse2'], ['Combat', 'reload', 'Reload', 'KeyR'], ['Combat', 'grenade', 'Plasma grenade (hold = throw far)', 'KeyG'], ['Combat', 'overdrive', 'Overdrive', 'KeyF'],
  ['Weapons', 'primary', 'Weapon 1 (primary)', 'Digit1'], ['Weapons', 'secondary', 'Weapon 2 (secondary)', 'Digit2'], ['Weapons', 'knife', 'Weapon 3 (knife)', 'Digit3'],
  ['Weapons', 'weapon4', 'Weapon 4 (reserved, no 4th slot yet)', 'Digit4'], ['Weapons', 'swap', 'Swap to last gun', 'KeyQ'],
  ['Interface', 'interact', 'Pick up weapon', 'KeyX'], ['Interface', 'scoreboard', 'Scoreboard (hold)', 'Tab'],
  ['Interface', 'pause', 'Pause menu (Esc always works)', 'Escape'], ['Interface', 'ptt', 'Push to talk (voice chat coming soon)', 'KeyV']
].map(([group, id, label, canon]) => ({ group, id, label, canon }));
const ACT = Object.fromEntries(ACTIONS.map(a => [a.id, a]));
// every code index.html reads (so a key that was re-bound AWAY from an action stops doing that action)
const GAME_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'KeyC', 'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'KeyE', 'KeyR', 'Digit1', 'Digit2', 'Digit3', 'KeyQ', 'KeyG', 'KeyF', 'KeyX', 'Tab', 'Mouse0', 'Mouse2']);

/* ============ helpers ============ */
const clone = o => JSON.parse(JSON.stringify(o));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const escH = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = id => document.getElementById(id);
const S9 = () => window.__s9;
const getP = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
function setP(o, path, v) { const ks = path.split('.'); let a = o; for (let i = 0; i < ks.length - 1; i++) a = a[ks[i]]; a[ks[ks.length - 1]] = v; }
const HEX = /^#[0-9a-f]{6}$/i, CODE = /^[A-Za-z0-9]{1,24}$/;

// cleans any object into a valid settings object (unknown keys dropped, wrong types -> default, numbers clamped)
function sanitize(src) {
  const out = clone(DEFAULTS);
  if (!src || typeof src !== 'object') return out;
  for (const sec of ['gameplay', 'mouse', 'crosshair', 'video', 'audio']) {
    const s = src[sec]; if (!s || typeof s !== 'object') continue;
    for (const k of Object.keys(DEFAULTS[sec])) {
      const path = `${sec}.${k}`, d = DEFAULTS[sec][k], v = s[k];
      if (typeof d === 'boolean') { if (typeof v === 'boolean') out[sec][k] = v; }
      else if (typeof d === 'number') { const n = typeof v === 'string' && v.trim() !== '' ? +v : v; if (typeof n === 'number' && isFinite(n)) out[sec][k] = clamp(n, ...(NUM[path] || [-1e9, 1e9])); }
      else if (ENUM[path]) { if (ENUM[path].includes(v)) out[sec][k] = v; }
      else if (k === 'color') { if (typeof v === 'string' && HEX.test(v)) out[sec][k] = v.toLowerCase(); }
    }
  }
  const c = src.controls;
  if (c && typeof c === 'object') {
    if (ENUM['controls.adsMode'].includes(c.adsMode)) out.controls.adsMode = c.adsMode;
    const b = c.binds;
    if (b && typeof b === 'object') {
      for (const a of ACTIONS) {
        const v = b[a.id]; if (!Array.isArray(v)) continue;
        const slots = [0, 1].map(i => (typeof v[i] === 'string' && (v[i] === '' || CODE.test(v[i])) ? v[i] : ''));
        if (a.id === 'pause') slots[0] = 'Escape'; else for (let i = 0; i < 2; i++) if (slots[i] === 'Escape') slots[i] = '';
        out.controls.binds[a.id] = slots;
      }
      // a key may only drive one action: later duplicates are dropped
      const seen = new Set();
      for (const a of ACTIONS) out.controls.binds[a.id] = out.controls.binds[a.id].map(k => { if (!k) return ''; if (seen.has(k)) return ''; seen.add(k); return k; });
    }
  }
  if (typeof src.updatedAt === 'number' && isFinite(src.updatedAt)) out.updatedAt = src.updatedAt;
  return out;
}

/* ============ state ============ */
let S = clone(DEFAULTS), loadNote = '';
let firstRun = true;
try {
  const raw = localStorage.getItem(LS_KEY);
  if (raw) { firstRun = false; let parsed = null; try { parsed = JSON.parse(raw); } catch (e) { loadNote = 'Your saved settings were damaged, so the defaults were loaded.'; } S = sanitize(parsed); }
} catch (e) {}

let saveT = 0, syncT = 0, syncState = '';
function save() {
  S.updatedAt = Date.now();
  try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) {}
  clearTimeout(syncT); syncT = setTimeout(syncRemote, 1200);
  clearTimeout(saveT); setStatus('Saved');
}
function account() {
  const A = window.S9Account; if (!A || typeof A.api !== 'function') return null;
  let on = false;
  try { const v = x => (typeof x === 'function' ? x.call(A) : x); on = typeof A.isLoggedIn === 'function' ? !!A.isLoggedIn() : !!v(A.token); } catch (e) {}
  return on ? A : null;
}
const acctProfile = () => { const A = window.S9Account; if (!A) return null; try { return typeof A.profile === 'function' ? A.profile() : A.profile; } catch (e) { return null; } };
let lastRemoteId = null;
function onAccountChange(profile) {
  if (!profile || !account()) { lastRemoteId = null; return; }
  if (profile.settings && typeof profile.settings === 'object' && Object.keys(profile.settings).length) applyRemote(profile.settings);
  else if (lastRemoteId !== profile.id) syncRemote();   // a fresh account: give it this device's settings
  lastRemoteId = profile.id;
}
async function syncRemote() {
  const A = account(); if (!A) return;
  const body = JSON.stringify({ settings: S });
  if (body.length > 8000) return;   // server limit is 8 KB
  try { syncState = 'syncing'; await A.api('/api/me/settings', { method: 'PUT', body: { settings: S } }); syncState = 'ok'; setStatus('Saved and synced to your account'); }
  catch (e) { syncState = 'err'; setStatus('Saved on this device (account sync failed, will retry on next change)'); }
}
// called by the accounts module (or our own listener) with profile.settings after login
function applyRemote(remote) {
  if (!remote || typeof remote !== 'object') return false;
  const r = sanitize(remote);
  if (S.updatedAt && r.updatedAt && r.updatedAt < S.updatedAt) { syncRemote(); return false; }   // this device is newer: push it up
  S = r; if (!S.updatedAt) S.updatedAt = Date.now();
  try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) {}
  applyAll(); if (open) renderTab();
  return true;
}
addEventListener('s9:account', e => { const p = e.detail && (e.detail.profile || e.detail); if (p && p.settings) applyRemote(p.settings); });

/* ============ key names ============ */
const KN = { Space: 'Space', ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift', ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl', AltLeft: 'L-Alt', AltRight: 'R-Alt', MetaLeft: 'Win', MetaRight: 'R-Win',
  Tab: 'Tab', Escape: 'Esc', Enter: 'Enter', Backspace: 'Backspace', CapsLock: 'Caps', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Insert: 'Ins', Delete: 'Del', Home: 'Home', End: 'End',
  PageUp: 'PgUp', PageDown: 'PgDn', IntlBackslash: '\\', ContextMenu: 'Menu',
  Mouse0: 'Mouse 1', Mouse2: 'Mouse 2', Mouse1: 'Mouse 3', Mouse3: 'Mouse 4', Mouse4: 'Mouse 5' };
const MOUSE_LONG = { Mouse0: 'Left click', Mouse2: 'Right click', Mouse1: 'Middle click', Mouse3: 'Mouse back', Mouse4: 'Mouse forward' };
function keyName(code, long) {
  if (!code) return '';
  if (long && MOUSE_LONG[code]) return MOUSE_LONG[code];
  if (KN[code]) return KN[code];
  let m; if ((m = /^Key([A-Z])$/.exec(code))) return m[1]; if ((m = /^Digit(\d)$/.exec(code))) return m[1];
  if ((m = /^Numpad(.+)$/.exec(code))) return 'Num ' + ({ Add: '+', Subtract: '-', Multiply: '*', Divide: '/', Decimal: '.', Enter: 'Enter' }[m[1]] || m[1]);
  return code;
}
const KEY_CHAR = code => { let m; if ((m = /^Key([A-Z])$/.exec(code))) return m[1].toLowerCase(); if ((m = /^Digit(\d)$/.exec(code))) return m[1]; return ({ Space: ' ', Tab: 'Tab', Escape: 'Escape', ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Control', ControlRight: 'Control' }[code] || code); };

/* ============ input remapping (physical key -> action -> the key code the game reads) ============ */
let physToAct = new Map();
function rebuildBinds() {
  physToAct = new Map();
  for (const a of ACTIONS) for (const k of S.controls.binds[a.id]) if (k && !physToAct.has(k)) physToAct.set(k, a.id);
  updateHudKeys();
}
const held = new Map();   // physical code -> action id (currently pressed through the remapper)
let synthing = false, adsOn = false;
const actHeld = a => { let n = 0; for (const v of held.values()) if (v === a) n++; return n; };
function canvas() { const s = S9(); return s && s.renderer && s.renderer.domElement; }
function synthKey(type, code, repeat) {
  synthing = true;
  try { document.dispatchEvent(new KeyboardEvent(type, { code, key: KEY_CHAR(code), repeat: !!repeat, bubbles: true, cancelable: true })); } finally { synthing = false; }
}
function synthMouse(type, button) {
  synthing = true;
  try {
    const ev = new MouseEvent(type, { button, buttons: type === 'mousedown' ? (button === 0 ? 1 : button === 2 ? 2 : 4) : 0, bubbles: true, cancelable: true });
    if (type === 'mousedown') (canvas() || document).dispatchEvent(ev); else window.dispatchEvent(ev);
  } finally { synthing = false; }
}
function emit(a, down, repeat) {
  const s = S9(), canon = ACT[a].canon;
  if (a === 'pause') { if (down && !repeat) { try { document.exitPointerLock(); } catch (e) {} synthKey('keydown', 'Escape'); synthKey('keyup', 'Escape'); } return; }
  if (canon.startsWith('Mouse')) {
    const b = +canon.slice(5);
    if (a === 'ads' && S.controls.adsMode === 'toggle' && s && s.P && s.P.weapon !== 'knife' && s.P.weapon !== 'boomerang') {
      if (!down || repeat) return;
      adsOn = !adsOn; synthMouse(adsOn ? 'mousedown' : 'mouseup', 2); return;
    }
    if (repeat) return;
    synthMouse(down ? 'mousedown' : 'mouseup', b); return;
  }
  synthKey(down ? 'keydown' : 'keyup', canon, repeat);
}
// returns true when the original event was replaced (so it must be stopped)
function route(phys, down, repeat) {
  const a = physToAct.get(phys);
  if (!a) return GAME_CODES.has(phys) ? 'swallow' : 'pass';
  const canon = ACT[a].canon, direct = phys === canon && !(a === 'ads' && S.controls.adsMode === 'toggle') && a !== 'pause';
  if (down) {
    if (held.has(phys) || repeat) { if (direct) return 'pass'; emit(a, true, true); return 'swallow'; }
    const first = actHeld(a) === 0; held.set(phys, a);
    if (!first) return 'swallow';
    if (direct) return 'pass';
    emit(a, true, false); return 'swallow';
  }
  if (!held.has(phys)) return direct ? 'pass' : 'swallow';
  held.delete(phys);
  if (actHeld(a) > 0) return 'swallow';
  if (direct) return 'pass';
  emit(a, false, false); return 'swallow';
}
function resetHeld() { held.clear(); adsOn = false; }

function onKey(e) {
  if (synthing) return;
  if (open) { panelKey(e); return; }
  const down = e.type === 'keydown';
  if (down && e.code === 'Enter' && e.altKey) { e.preventDefault(); e.stopImmediatePropagation(); toggleFullscreen(); return; }
  if (e.code === 'Escape') return;   // the browser and the game handle Esc (pause / release mouse)
  const s = S9(), st = s && s.state;
  if (!down && held.has(e.code)) { const r = route(e.code, false, false); if (r === 'swallow') { e.stopImmediatePropagation(); e.preventDefault(); } return; }
  if (st !== 'play' && st !== 'dead') return;
  const r = route(e.code, down, e.repeat);
  if (r === 'swallow') {
    e.stopImmediatePropagation();
    if (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow') || e.code === 'Backspace' || e.ctrlKey || e.metaKey || e.altKey) e.preventDefault();
  }
}
function onMouseBtn(e) {
  if (synthing) return;
  if (open) { panelMouse(e); return; }
  const s = S9(); if (!s || s.state !== 'play') return;
  const cv = canvas(); if (e.target !== cv && document.pointerLockElement !== cv) return;
  const down = e.type === 'mousedown', phys = 'Mouse' + e.button;
  if (!down && !held.has(phys) && !physToAct.has(phys) && !GAME_CODES.has(phys)) return;
  const r = route(phys, down, false);
  if (r === 'swallow') { e.stopImmediatePropagation(); if (e.button > 2) e.preventDefault(); }
  else if (e.button > 2 && physToAct.has(phys)) e.preventDefault();   // keep Mouse 4/5 from navigating back/forward
}
// mouse look: ADS multiplier + invert Y (the hip sensitivity itself goes into the game's own CFG.sens)
let carryX = 0, carryY = 0;
function onMove(e) {
  if (synthing) return;
  const s = S9(); if (!s || s.state !== 'play' || !s.P) return;
  const k = lerp(1, S.mouse.adsMult, clamp(s.P.ads || 0, 0, 1)), ky = S.mouse.invertY ? -k : k;
  if (k === 1 && ky === 1) return;
  e.stopImmediatePropagation();
  carryX += (e.movementX || 0) * k; carryY += (e.movementY || 0) * ky;
  const ix = Math.trunc(carryX), iy = Math.trunc(carryY); carryX -= ix; carryY -= iy;
  if (!ix && !iy) return;
  synthing = true;
  try { document.dispatchEvent(new MouseEvent('mousemove', { movementX: ix, movementY: iy, clientX: e.clientX, clientY: e.clientY, bubbles: true })); } finally { synthing = false; }
}
addEventListener('keydown', onKey, true); addEventListener('keyup', onKey, true);
addEventListener('mousedown', onMouseBtn, true); addEventListener('mouseup', onMouseBtn, true);
addEventListener('mousemove', onMove, true);
addEventListener('auxclick', e => { if (S9() && S9().state === 'play' && e.button > 2) e.preventDefault(); }, true);
addEventListener('blur', () => { resetHeld(); focusMuted = true; applyAudioGains(); });
addEventListener('focus', () => { focusMuted = false; applyAudioGains(); });

function updateHudKeys() {
  const k = id => keyName(S.controls.binds[id][0] || S.controls.binds[id][1]) || '-';
  const set = (sel, t) => { const el = document.querySelector(sel); if (el) el.textContent = t; };
  set('#abJump kbd', `${k('jump').toUpperCase()} ×2`); set('#abDash kbd', k('dash').toUpperCase()); set('#abSlide kbd', k('crouch').toUpperCase());
  set('#abNade kbd', k('grenade').toUpperCase()); set('#abOd kbd', k('overdrive').toUpperCase()); set('#dropHint kbd', k('interact').toUpperCase());
}

/* ============ game hooks: sensitivity, volume, quality via the game's own controls ============ */
function driveInput(id, value, evt) {
  const el = $(id); if (!el) return false;
  if (el.type === 'range') { el.min = id.endsWith('vol') ? '0' : '0.05'; el.max = id.endsWith('vol') ? '1' : '10'; el.step = 'any'; }
  if (String(el.value) === String(value) && evt !== 'force') return true;
  el.value = value; el.dispatchEvent(new Event(evt === 'change' ? 'change' : 'input', { bubbles: true })); return true;
}
for (const id of ['psens', 'msens', 'pvol', 'mvol']) { const el = $(id); if (el) { el.step = 'any'; } }
const Q_TO_GAME = { low: 'performance', medium: 'balanced', high: 'high', ultra: 'ultra' };
const GAME_TO_Q = { performance: 'low', balanced: 'medium', high: 'high', ultra: 'ultra' };
function autoQuality() { if (window.S9GFX && S9GFX.detected) return S9GFX.detected; const strong = (navigator.hardwareConcurrency || 4) >= 8 && (navigator.deviceMemory || 8) >= 8; return strong ? 'high' : 'balanced'; }   // graphics module reads the real GPU
function applyMouse() { driveInput('msens', String(S.mouse.sens)); }
function applyQualitySetting(force) {
  const sel = $('mq'); if (!sel) return;
  const want = S.video.quality === 'auto' ? (firstRun || force ? autoQuality() : null) : Q_TO_GAME[S.video.quality];
  if (want && sel.value !== want) { sel.value = want; sel.dispatchEvent(new Event('change', { bubbles: true })); }
}
// the player may still use the small quick sliders on the menu/pause screen: keep our copy in step with them
function watchQuick() {
  for (const p of ['m', 'p']) {
    const sv = $(p + 'sens'), vv = $(p + 'vol'), qv = $(p + 'q');
    if (sv) sv.addEventListener('input', e => { if (!e.isTrusted) return; S.mouse.sens = clamp(+sv.value, ...NUM['mouse.sens']); save(); if (open) renderTab(); });
    if (vv) vv.addEventListener('input', e => { if (!e.isTrusted) return; S.audio.master = clamp(+vv.value, 0, 1); save(); applyAudioGains(); if (open) renderTab(); });
    if (qv) qv.addEventListener('change', e => { if (!e.isTrusted) return; S.video.quality = GAME_TO_Q[qv.value] || 'medium'; save(); if (open) renderTab(); });
  }
}

/* ============ audio buses: effects / ambience / enemy footsteps / focus mute ============ */
// index.html builds its audio graph inside initAudio (first click). We record the connections it makes, then split what
// feeds the master into an effects bus and an ambience bus (anything fed by a looping source = wind / hum).
const AUD = { fx: null, amb: null, foot: null, wired: false, edges: [] };
let focusMuted = false;
const AN = window.AudioNode && AudioNode.prototype, nativeConnect = AN && AN.connect;
function startAudioWatch() {
  const s = S9(); if (!AN || (s && s.AU && s.AU.ctx)) return;
  AN.connect = function (dst, ...r) { if (AUD.edges && AUD.edges.length < 600) AUD.edges.push([this, dst]); return nativeConnect.call(this, dst, ...r); };
}
function wireAudio() {
  const s = S9(), AU = s && s.AU; if (!AU || !AU.ctx || !AU.master || AUD.wired) return;
  AUD.wired = true;
  if (AN && AN.connect !== nativeConnect) AN.connect = nativeConnect;
  const edges = AUD.edges || []; AUD.edges = null;
  const c = AU.ctx, M = AU.master;
  AUD.fx = c.createGain(); AUD.amb = c.createGain(); AUD.foot = c.createGain();
  AUD.fx.connect(M); AUD.amb.connect(M); AUD.foot.connect(AUD.fx);
  if (!edges.length) {   // audio was started before this module loaded: effects bus only covers new sounds
    try { AU.dry.disconnect(M); AU.dry.connect(AUD.fx); } catch (e) {}
  } else {
    const up = n => edges.filter(e => e[1] === n).map(e => e[0]);
    const loopFed = (n, d = 0) => (window.AudioBufferSourceNode && n instanceof AudioBufferSourceNode && n.loop) || (d < 5 && up(n).some(u => loopFed(u, d + 1)));
    const into = [...new Set(edges.filter(e => e[1] === M).map(e => e[0]))];
    for (const n of into) { if (n === AUD.fx || n === AUD.amb) continue; try { n.disconnect(M); n.connect(loopFed(n) ? AUD.amb : AUD.fx); } catch (e) {} }
  }
  // enemy footsteps get their own boost bus; hit sounds (which go straight to the master) join the effects bus
  if (s.sfx) {
    for (const k of ['foeStep', 'robotStep', 'botStep']) { const orig = s.sfx[k]; if (typeof orig !== 'function') continue; s.sfx[k] = function (...a) { const d = AU.dry; AU.dry = AUD.foot; try { return orig.apply(this, a); } finally { AU.dry = d; } }; }
  }
  applyAudioGains();
}
function applyAudioGains() {
  driveInput('mvol', String(S.audio.master));
  const s = S9(), AU = s && s.AU; if (!AUD.wired || !AU || !AU.ctx) return;
  const on = S.audio.muteUnfocused && focusMuted ? 0 : 1, t = AU.ctx.currentTime;
  const set = (g, v) => { if (!g) return; g.gain.cancelScheduledValues(t); g.gain.setTargetAtTime(v, t, .03); };
  set(AUD.fx, S.audio.effects * on); set(AUD.amb, S.audio.ambience * on); set(AUD.foot, S.audio.footsteps);
}
function hookSfx() {
  const s = S9(); if (!s || !s.sfx || s.sfx.__s9set) return; s.sfx.__s9set = true;
  const hit = s.sfx.hit;
  if (typeof hit === 'function') s.sfx.hit = function (...a) {
    if (!S.gameplay.hitSound) return;
    const AU = s.AU, m = AU && AU.master; if (AUD.fx && AU) AU.master = AUD.fx;
    try { return hit.apply(this, a); } finally { if (AU) AU.master = m; }
  };
}

/* ============ video: FOV, brightness, gamma, FPS, shake ============ */
// FOV: the camera keeps the game's own fov numbers (78 base, weapon ADS zooms); we only widen/narrow the projection by
// the same ratio in tan-space, so every zoom keeps its magnification and the game's ADS sensitivity stays consistent.
function fovActive() { const s = S9(); return s && (s.state === 'play' || s.state === 'paused'); }
function mapFov(f) { const r = Math.tan(S.video.fov * Math.PI / 360) / Math.tan(78 * Math.PI / 360); return 360 / Math.PI * Math.atan(Math.tan(f * Math.PI / 360) * r); }
function hookCamera() {
  const s = S9(); if (!s || !s.camera || s.camera.__s9fov) return;
  const cam = s.camera, proto = Object.getPrototypeOf(cam).updateProjectionMatrix;
  cam.__s9fov = true;
  cam.updateProjectionMatrix = function () {
    if (S.video.fov === 78 || !fovActive()) return proto.call(this);
    const f = this.fov; this.fov = mapFov(f); try { proto.call(this); } finally { this.fov = f; }
  };
}
// brightness/gamma live in the game's colour-grade shader: catch its material the first time the composer draws it
const GRADE = { mat: null };
function gammaPatch(m) {   // works on the game's own grade shader and on the graphics module's replacement
  const re = /pow\((clamp\(col, 0\., 1\.\)|col), vec3\(1\.\/2\.2\)\)/;
  if (m.uniforms.uGamma || !re.test(m.fragmentShader)) return;
  m.uniforms.uGamma = { value: 1 }; m.fragmentShader = 'uniform float uGamma;\n' + m.fragmentShader.replace(re, (all, x) => `pow(${x}, vec3(1./(2.2*uGamma)))`); m.needsUpdate = true;
}
function hookRenderer() {
  // the grade pass is a global of the game: take its material directly (no need to wait for a draw)
  if (!GRADE.mat && typeof grade !== 'undefined' && grade && grade.material && grade.material.uniforms && grade.material.uniforms.uExposure) {
    GRADE.mat = grade.material; GRADE.base = GRADE.base || grade.material.uniforms.uExposure.value; gammaPatch(GRADE.mat); applyGrade(); return; }
  const s = S9(); if (!s || !s.renderer || s.renderer.__s9grade) return;
  const R = s.renderer, orig = R.render; R.__s9grade = true;
  R.render = function (sc, cam) {
    const m = sc && sc.material;
    if (m && m.uniforms && m.uniforms.uExposure && !GRADE.mat) {
      GRADE.mat = m; GRADE.base = m.uniforms.uExposure.value;
      gammaPatch(m);
      R.render = orig; applyGrade();
    }
    return orig.call(this, sc, cam);
  };
}
function applyGrade() { const m = GRADE.mat; if (!m) return; m.uniforms.uExposure.value = (GRADE.base || .9) * S.video.brightness; if (m.uniforms.uGamma) m.uniforms.uGamma.value = S.video.gamma; }
function applyVideo() {
  const s = S9(); if (s && s.camera && fovActive()) s.camera.updateProjectionMatrix();
  document.documentElement.classList.toggle('s9-nofps', !S.video.fps);
  applyGrade();
}

/* ============ gameplay ============ */
const CB = { deuteranopia: '#ffd400', protanopia: '#2fb8ff', tritanopia: '#ff2e6e' };
function applyGameplay() {
  const r = document.documentElement;
  r.classList.toggle('s9-nodmg', !S.gameplay.damageNumbers);
  r.style.setProperty('--s9-kfeed', { small: '.82', normal: '1', large: '1.3' }[S.gameplay.killFeedSize]);
  r.classList.toggle('s9-cb', S.gameplay.colorblind !== 'off');
  r.style.setProperty('--s9-enemy', CB[S.gameplay.colorblind] || '#ff5a3c');
  cbDirty = true;
}
let cbDirty = true, cbCol = null;
function updateColorblind() {
  const s = S9(); if (!s || !s.robots || !s.THREE) return;
  const mode = S.gameplay.colorblind;
  if (mode === 'off') {
    if (cbDirty) { for (const r of s.robots) if (r.__s9cb && r.visor && !r.dead) { r.visor.emissive.copy(r.color); if (r.body) r.body.emissive.setRGB(0, 0, 0); r.__s9cb = false; } cbDirty = false; }
    return;
  }
  if (!cbCol || cbDirty) { cbCol = new s.THREE.Color(CB[mode]); cbDirty = false; }
  for (const r of s.robots) {
    if (r.dead || !r.visor || !r.root || !r.root.visible) continue;
    if (!r.visor.emissive.equals(cbCol)) r.visor.emissive.copy(cbCol);
    if (r.body && r.body.opacity >= 1) r.body.emissive.setRGB(cbCol.r * .16, cbCol.g * .16, cbCol.b * .16);
    r.__s9cb = true;
  }
}

/* ============ crosshair ============ */
function xhSize(c, dyn) { const g = Math.max(c.gap, 0) + (dyn ? 60 : 0); return 2 * Math.ceil(g + c.length * 1.1 + c.thickness + c.outlineThickness * 2 + c.dot + 8); }
// draws crosshair c into ctx (device pixels), centred, using gap g (in CSS px). k = device pixel scale.
function drawXH(ctx, c, g, k) {
  const W = ctx.canvas.width, H = ctx.canvas.height; ctx.clearRect(0, 0, W, H);
  const px = v => Math.round(v * k), cx = Math.floor(W / 2), cy = Math.floor(H / 2);
  const t = Math.max(1, px(c.thickness)), L = px(c.length), o = c.outline ? Math.max(1, px(c.outlineThickness)) : 0, gp = px(g);
  const odd = t % 2, h = Math.floor(t / 2), rects = [], strokes = [];
  const arms = { cross: 'udlr', crossdot: 'udlr', tshape: 'dlr' }[c.style] || '';
  if (L > 0) for (const a of arms) {
    if (a === 'u') rects.push([-h, -gp - L, t, L]);
    if (a === 'd') rects.push([-h, gp + odd, t, L]);
    if (a === 'l') rects.push([-gp - L, -h, L, t]);
    if (a === 'r') rects.push([gp + odd, -h, L, t]);
  }
  let dot = px(c.dot); if (c.style === 'dot') dot = Math.max(dot, px(3)); if (c.style === 'crossdot') dot = Math.max(dot, 1);
  if (dot > 0) { const d0 = Math.floor(dot / 2); rects.push([-d0 + (odd && dot % 2 ? 0 : 0), -d0, dot, dot]); }
  if (c.style === 'circle') strokes.push(['arc', Math.max(2, gp + L * .5)]);
  if (c.style === 'chevron' && L > 0) strokes.push(['chev', gp, L]);
  const path = s => { ctx.beginPath(); if (s[0] === 'arc') ctx.arc(cx + odd / 2, cy + odd / 2, s[1], 0, Math.PI * 2); else { const y0 = cy + s[1], d = s[2] * .72; ctx.moveTo(cx + .5 - d, y0 + d); ctx.lineTo(cx + .5, y0); ctx.lineTo(cx + .5 + d, y0 + d); } };
  ctx.lineJoin = 'miter'; ctx.lineCap = 'butt';
  if (o) {
    ctx.fillStyle = `rgba(0,0,0,${c.outlineOpacity})`; ctx.strokeStyle = ctx.fillStyle;
    ctx.globalCompositeOperation = 'source-over';
    for (const [x, y, w, hh] of rects) ctx.fillRect(cx + x - o, cy + y - o, w + 2 * o, hh + 2 * o);
    ctx.lineWidth = t + 2 * o; for (const s of strokes) { path(s); ctx.stroke(); }
    // the colour is drawn over a cleared hole so a see-through outline never darkens the colour itself
    ctx.globalCompositeOperation = 'destination-out'; ctx.fillStyle = '#000'; ctx.strokeStyle = '#000';
    for (const [x, y, w, hh] of rects) ctx.fillRect(cx + x, cy + y, w, hh);
    ctx.lineWidth = t; for (const s of strokes) { path(s); ctx.stroke(); }
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.fillStyle = c.color; ctx.strokeStyle = c.color; ctx.lineWidth = t;
  for (const [x, y, w, hh] of rects) ctx.fillRect(cx + x, cy + y, w, hh);
  for (const s of strokes) { path(s); ctx.stroke(); }
}
const XH = { el: null, ctx: null, gap: -1, key: '', vis: -1 };
function ensureGameXH() {
  if (XH.el && XH.el.isConnected) return true;
  const hud = $('hud'); if (!hud) return false;
  XH.el = document.createElement('canvas'); XH.el.id = 's9xh'; XH.el.setAttribute('aria-hidden', 'true');
  const ref = $('xh'); hud.insertBefore(XH.el, ref ? ref.nextSibling : null);
  XH.ctx = XH.el.getContext('2d'); XH.key = ''; return true;
}
function applyCrosshair() { XH.key = ''; drawPreview(); }
function updateGameXH() {
  const s = S9(); if (!s || !s.P || !ensureGameXH()) return;
  const P = s.P, c = S.crosshair, W = s.WEAPONS && s.WEAPONS[P.weapon];
  let g = c.gap;
  if (c.dynamic) g = (c.gap + Math.hypot(P.vel ? P.vel.x : 0, P.vel ? P.vel.z : 0) * 1.6 + (P.onGround ? 0 : 14) + (P.heat || 0) * 14) * (1 - (P.crouch || 0) * .3);
  const k = devicePixelRatio || 1, size = xhSize(c, c.dynamic), key = JSON.stringify(c) + k;
  if (key !== XH.key) { XH.key = key; XH.el.width = Math.ceil(size * k); XH.el.height = Math.ceil(size * k); XH.el.style.width = (XH.el.width / k) + 'px'; XH.el.style.height = (XH.el.height / k) + 'px'; XH.el.style.marginLeft = XH.el.style.marginTop = (-XH.el.width / k / 2) + 'px'; XH.gap = -1; }
  if (Math.abs(g - XH.gap) > .2) { XH.gap = g; drawXH(XH.ctx, c, g, k); }
  const scoped = W && W.scope && (P.ads || 0) > .6;
  const vis = P.sprint || scoped || ((P.ads || 0) > .4 && !c.adsShow) ? 0 : c.opacity;
  if (vis !== XH.vis) { XH.vis = vis; XH.el.style.opacity = String(vis); }
}
const COLORS = [['#ffffff', 'White'], ['#ece6d8', 'Bone (default)'], ['#00ff00', 'Green'], ['#adff2f', 'Yellow-green'], ['#ffff00', 'Yellow'], ['#00ffff', 'Cyan'], ['#ff00ff', 'Pink'], ['#ff0000', 'Red'], ['#ff9a3c', 'Sodium']];
const XH_PRESETS = [
  ['Default', {}],
  ['Pro green', { style: 'cross', color: '#00ff00', length: 5, thickness: 1, gap: 2, outline: true, outlineThickness: 1, outlineOpacity: 1, dot: 0, dynamic: false }],
  ['Dot', { style: 'dot', color: '#00ffff', dot: 4, outline: true, outlineOpacity: 1, dynamic: false }],
  ['Circle', { style: 'circle', color: '#ffffff', length: 6, thickness: 1, gap: 6, dot: 2, outline: true, outlineOpacity: .8 }],
  ['T-shape', { style: 'tshape', color: '#ffff00', length: 7, thickness: 2, gap: 3, dot: 0, outline: true, outlineOpacity: .7, dynamic: false }],
  ['Chevron', { style: 'chevron', color: '#ff9a3c', length: 10, thickness: 2, gap: 2, dot: 0, outline: true, outlineOpacity: .6 }]
];
function exportCode(c = S.crosshair) {
  return ['S9', 's', c.style, 'c', c.color.slice(1), 'l', c.length, 't', c.thickness, 'g', c.gap, 'o', c.outline ? 1 : 0, 'ot', c.outlineThickness, 'oo', Math.round(c.outlineOpacity * 100),
    'd', c.dot, 'a', Math.round(c.opacity * 100), 'dy', c.dynamic ? 1 : 0, 'ad', c.adsShow ? 1 : 0].join(';');
}
const STYLE_CODES = ENUM['crosshair.style'];
function importCode(code) {
  const parts = String(code || '').trim().split(';').map(x => x.trim());
  if (parts.length < 3) return { ok: false, msg: 'That is not a crosshair code.' };
  const out = clone(DEFAULTS.crosshair);
  if (parts[0].toUpperCase() === 'S9') {
    for (let i = 1; i + 1 < parts.length; i += 2) {
      const k = parts[i], v = parts[i + 1], n = +v;
      if (k === 's' && STYLE_CODES.includes(v)) out.style = v;
      else if (k === 'c' && /^[0-9a-f]{6}$/i.test(v)) out.color = '#' + v.toLowerCase();
      else if (k === 'l' && isFinite(n)) out.length = n; else if (k === 't' && isFinite(n)) out.thickness = n; else if (k === 'g' && isFinite(n)) out.gap = n;
      else if (k === 'o') out.outline = v === '1'; else if (k === 'ot' && isFinite(n)) out.outlineThickness = n; else if (k === 'oo' && isFinite(n)) out.outlineOpacity = n / 100;
      else if (k === 'd' && isFinite(n)) out.dot = n; else if (k === 'a' && isFinite(n)) out.opacity = n / 100;
      else if (k === 'dy') out.dynamic = v === '1'; else if (k === 'ad') out.adsShow = v === '1';
    }
    return { ok: true, c: sanitize({ crosshair: out }).crosshair, msg: 'Crosshair imported.' };
  }
  if (parts[0] === '0') {   // Valorant code: inner lines + centre dot + outline + colour are carried over
    const V = {}; let sec = 'P';
    for (let i = 1; i < parts.length;) { const t = parts[i]; if (/^[PAS]$/.test(t)) { sec = t; i++; continue; } if (sec === 'P') V[t] = parts[i + 1]; i += 2; }
    const VC = ['#ffffff', '#00ff00', '#7fff00', '#dfff00', '#ffff00', '#00ffff', '#ff00ff', '#ff0000'];
    const num = (k, d) => (V[k] !== undefined && isFinite(+V[k]) ? +V[k] : d);
    const ci = num('c', 0); out.color = ci === 8 && /^[0-9a-f]{6}/i.test(V.u || '') ? '#' + V.u.slice(0, 6).toLowerCase() : VC[ci] || '#ffffff';
    out.outline = num('h', 1) === 1; out.outlineThickness = num('t', 1); out.outlineOpacity = num('o', .5);
    const dotOn = num('d', 0) === 1, inner = num('0b', 1) === 1;
    out.dot = dotOn ? num('z', 2) : 0; out.length = num('0l', 6); out.thickness = num('0t', 2); out.gap = num('0o', 3); out.opacity = num('0a', .8);
    out.dynamic = num('0m', 0) === 1 || num('0f', 1) === 1;
    out.style = inner ? (dotOn ? 'crossdot' : 'cross') : 'dot'; if (!inner && !dotOn) { out.style = 'dot'; out.dot = 2; }
    return { ok: true, c: sanitize({ crosshair: out }).crosshair, msg: 'Valorant code imported (inner lines, dot, outline and colour).' };
  }
  return { ok: false, msg: 'That code is not a Sector Nine (S9;...) or Valorant (0;...) crosshair code.' };
}

/* ============ fullscreen ============ */
const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement || null;
async function toggleFullscreen() {
  try {
    if (fsEl()) await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else { const el = document.documentElement; await (el.requestFullscreen || el.webkitRequestFullscreen).call(el, { navigationUI: 'hide' }); }
  } catch (e) { note('The browser blocked full screen. Press F11 instead.', 'warn'); }
  syncFsButton();
}
function syncFsButton() {
  const on = !!fsEl();
  for (const b of document.querySelectorAll('[data-fs]')) {
    b.setAttribute('aria-pressed', String(on));
    const l = b.querySelector('.s9s-fsl'); if (l) l.textContent = on ? 'Windowed' : 'Full screen';
  }
  for (const b of document.querySelectorAll('[data-fsmode]')) b.setAttribute('aria-checked', String((b.dataset.fsmode === 'full') === on));
}
document.addEventListener('fullscreenchange', syncFsButton); document.addEventListener('webkitfullscreenchange', syncFsButton);

/* ============ panel UI ============ */
const CSS = `
#xh{display:none!important}
#s9xh{position:absolute;left:50%;top:50%;pointer-events:none;transition:opacity .1s}
.s9-nofps #fps{display:none}
.s9-nodmg #dnums{display:none}
#kfeed{zoom:var(--s9-kfeed,1)}
.s9-cb .tag s{background:var(--s9-enemy)!important}
.s9-cb .tag b{color:var(--s9-enemy)!important}
#s9set{position:fixed;inset:0;z-index:60;display:grid;grid-template-rows:auto auto minmax(0,1fr) auto;color:var(--ink,#ece6d8);font-family:var(--mono,monospace);
  background:radial-gradient(900px 500px at 85% -10%,rgba(255,154,60,.10),transparent 60%),linear-gradient(180deg,#0d1014,#08090b)}
#s9set[hidden]{display:none}
#s9set *{box-sizing:border-box}
.s9s-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px 20px;flex-wrap:wrap;padding:calc(18px + env(safe-area-inset-top,0px)) clamp(16px,4vw,56px) 14px}
.s9s-head .kicker{font-size:11px;letter-spacing:.3em;text-transform:uppercase;color:var(--sodium,#ff9a3c)}
.s9s-head h2{font-family:var(--display);font-weight:900;font-size:clamp(40px,6vw,64px);line-height:.85;margin:4px 0 0;letter-spacing:.02em}
.s9s-acts{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.s9s-btn{font-family:var(--mono);font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink);background:rgba(236,230,216,.04);border:1px solid var(--line);padding:10px 14px;cursor:pointer;display:inline-flex;gap:9px;align-items:center;min-height:40px}
.s9s-btn:hover{border-color:rgba(255,154,60,.6)}
.s9s-btn:focus-visible,.s9s-tab:focus-visible,.s9s-key:focus-visible,.s9s-seg button:focus-visible,.s9s-sw:focus-visible,.s9s-sw2:focus-visible{outline:2px solid var(--sodium);outline-offset:2px}
.s9s-btn kbd,.s9s-kbd{font-family:var(--mono);font-size:10px;letter-spacing:.06em;border:1px solid var(--line);border-bottom-width:2px;padding:1px 6px;color:var(--dim)}
.s9s-btn.pri{background:var(--sodium);color:#14100b;border-color:var(--sodium);font-weight:600}
.s9s-btn.pri kbd{color:#3a2a14;border-color:rgba(0,0,0,.25)}
.s9s-btn[aria-pressed=true]{border-color:var(--sodium);color:var(--sodium)}
.s9s-btn svg{width:16px;height:16px;flex:none}
.s9s-tabs{display:flex;gap:0;padding:0 clamp(16px,4vw,56px);border-bottom:1px solid var(--line);overflow-x:auto;scrollbar-width:none}
.s9s-tabs::-webkit-scrollbar{display:none}
@media (max-width:760px){.s9s-tabs{-webkit-mask:linear-gradient(90deg,#000 85%,transparent);mask:linear-gradient(90deg,#000 85%,transparent)}}
.s9s-tab{font-family:var(--display);font-weight:700;font-size:21px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);background:none;border:0;border-bottom:3px solid transparent;padding:12px 16px 9px;cursor:pointer;white-space:nowrap;margin-bottom:-1px}
.s9s-tab:hover{color:var(--ink)}
.s9s-tab[aria-selected=true]{color:var(--ink);border-bottom-color:var(--sodium)}
.s9s-body{overflow:auto;overscroll-behavior:contain;padding:20px clamp(16px,4vw,56px) 32px}
.s9s-inner{max-width:1120px;display:grid;gap:18px}
.s9s-sec{border:1px solid var(--line);background:rgba(236,230,216,.022)}
.s9s-sec>h3{margin:0;padding:10px 16px;font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:var(--sodium);font-weight:600;border-bottom:1px solid var(--line)}
.s9s-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.25fr);gap:10px 20px;align-items:center;padding:11px 16px;border-top:1px solid rgba(236,230,216,.07)}
.s9s-sec>h3+.s9s-row{border-top:0}
.s9s-row:hover{background:rgba(236,230,216,.025)}
.s9s-lab b{display:block;font-size:13px;font-weight:600;letter-spacing:.03em}
.s9s-lab>span{display:block;font-size:11px;color:var(--dim);margin-top:3px;line-height:1.5}
.s9s-ctl{font-size:12px;display:flex;gap:10px 12px;align-items:center;justify-content:flex-end;flex-wrap:wrap;min-width:0}
.s9s-ctl input[type=range]{flex:1 1 140px;min-width:0;accent-color:var(--sodium);height:22px}
.s9s-num{width:76px;background:#0b0d10;border:1px solid var(--line);color:var(--ink);font:inherit;font-size:13px;padding:7px 8px;text-align:right}
.s9s-num:focus-visible,.s9s-code:focus-visible{outline:2px solid var(--sodium);outline-offset:1px}
.s9s-seg{display:inline-flex;flex-wrap:wrap;border:1px solid var(--line)}
.s9s-seg button{font-family:var(--mono);font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);background:transparent;border:0;border-left:1px solid var(--line);padding:9px 12px;cursor:pointer;min-height:38px}
.s9s-seg button:first-child{border-left:0}
.s9s-seg button:hover{color:var(--ink)}
.s9s-seg button[aria-checked=true]{background:var(--sodium);color:#14100b;font-weight:600}
.s9s-sw{position:relative;width:52px;height:28px;border-radius:14px;border:1px solid var(--line);background:rgba(236,230,216,.08);cursor:pointer;flex:none;padding:0}
.s9s-sw::after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:var(--dim);transition:transform .15s,background .15s}
.s9s-sw[aria-checked=true]{background:rgba(255,154,60,.25);border-color:var(--sodium)}
.s9s-sw[aria-checked=true]::after{transform:translateX(24px);background:var(--sodium)}
.s9s-swl{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);min-width:3ch}
.s9s-note{padding:10px 14px;border:1px solid var(--line);border-left:3px solid var(--cyan,#7fe7ff);font-size:12px;line-height:1.5;background:rgba(127,231,255,.05);display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.s9s-note.warn{border-left-color:var(--alert,#ff4a3d);background:rgba(255,74,61,.07)}
.s9s-note[hidden]{display:none}
.s9s-foot{display:flex;justify-content:space-between;align-items:center;gap:10px 16px;flex-wrap:wrap;padding:12px clamp(16px,4vw,56px) calc(12px + env(safe-area-inset-bottom,0px));border-top:1px solid var(--line);background:rgba(8,9,11,.7)}
.s9s-status{font-size:11px;letter-spacing:.12em;color:var(--dim);text-transform:uppercase}
.s9s-status::before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;background:#5dff9a;margin-right:8px;vertical-align:1px}
/* keybinds */
.s9s-kb{display:grid;grid-template-columns:minmax(0,1fr) minmax(96px,150px) minmax(96px,150px);gap:0}
.s9s-kb>div{padding:7px 16px;border-top:1px solid rgba(236,230,216,.07);display:flex;align-items:center;min-width:0}
.s9s-kb>div.k{padding:5px 6px}
.s9s-kb .hd{font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--dim);border-top:0}
.s9s-kb .lab{font-size:13px;gap:8px}
.s9s-kb .lab.warn{color:var(--alert);box-shadow:inset 3px 0 0 var(--alert)}
.s9s-kb .lab small{color:var(--dim);font-size:10.5px}
.s9s-key{width:100%;font-family:var(--mono);font-size:12.5px;letter-spacing:.06em;color:var(--ink);background:rgba(236,230,216,.05);border:1px solid var(--line);border-bottom-width:2px;padding:8px 8px;cursor:pointer;min-height:38px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.s9s-key:hover{border-color:rgba(255,154,60,.6)}
.s9s-key.none{color:var(--dim)}
.s9s-key.fixed{cursor:default;opacity:.6}
.s9s-key.listen{border-color:var(--sodium);color:var(--sodium);animation:s9pulse 1s ease-in-out infinite}
@keyframes s9pulse{50%{background:rgba(255,154,60,.14)}}
/* crosshair */
.s9s-xh{display:grid;grid-template-columns:minmax(280px,440px) minmax(0,1fr);gap:18px;align-items:start}
.s9s-pv{position:sticky;top:0;display:grid;gap:10px;z-index:2}
.s9s-prev{position:relative;aspect-ratio:16/10;border:1px solid var(--line);overflow:hidden;background:#2a2620 center/cover no-repeat;background-image:linear-gradient(135deg,#3a3326,#1d1a15)}
.s9s-prev.img{background-size:240%}
.s9s-prev canvas{position:absolute;left:50%;top:50%;image-rendering:pixelated;image-rendering:crisp-edges}
.s9s-prev .s9s-pvtag{position:absolute;left:8px;bottom:8px;font-size:10px;letter-spacing:.16em;text-transform:uppercase;background:rgba(11,13,16,.7);padding:3px 7px;color:var(--ink)}
.s9s-pvbar{display:flex;gap:8px;flex-wrap:wrap;justify-content:space-between}
.s9s-sws{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.s9s-sw2{width:28px;height:28px;border:1px solid var(--line);cursor:pointer;padding:0;position:relative}
.s9s-sw2[aria-checked=true]{outline:2px solid var(--ink);outline-offset:2px}
.s9s-custom{display:inline-flex;gap:8px;align-items:center;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin-left:6px}
.s9s-sws input[type=color]{width:40px;height:30px;border:1px solid var(--line);background:none;padding:0;cursor:pointer}
.s9s-code{flex:1 1 220px;min-width:0;background:#0b0d10;border:1px solid var(--line);color:var(--ink);font:inherit;font-size:12px;padding:9px 10px}
.s9s-presets{display:flex;gap:6px;flex-wrap:wrap}
.s9s-presets button{font-family:var(--mono);font-size:11px;letter-spacing:.08em;color:var(--ink);background:rgba(236,230,216,.04);border:1px solid var(--line);padding:6px 10px;cursor:pointer;display:inline-flex;gap:7px;align-items:center}
.s9s-presets canvas{width:22px;height:22px;background:#3a3326}
.s9s-cbsw{display:inline-block;width:14px;height:14px;border-radius:50%;vertical-align:-2px;margin-right:8px;border:1px solid rgba(0,0,0,.5)}
@media (max-width:900px){.s9s-xh{grid-template-columns:1fr}.s9s-pv{position:sticky;top:-20px;background:#0b0d10;padding-bottom:8px}.s9s-prev{aspect-ratio:16/7}}
@media (max-width:640px){
  .s9s-row{grid-template-columns:1fr;gap:8px}.s9s-ctl{justify-content:flex-start}
  .s9s-head{align-items:center}.s9s-head h2{font-size:38px}
  .s9s-tab{font-size:18px;padding:11px 12px 8px}
  .s9s-kb{grid-template-columns:minmax(0,1fr) 92px 92px}.s9s-kb>div{padding:6px 8px}.s9s-kb .lab{font-size:12px}
  .s9s-btn .hide-s{display:none}
}`;
const TABS = [['gameplay', 'Gameplay'], ['controls', 'Controls'], ['mouse', 'Mouse'], ['crosshair', 'Crosshair'], ['video', 'Video'], ['audio', 'Audio']];
const FS_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M1.5 5.5v-4h4M10.5 1.5h4v4M14.5 10.5v4h-4M5.5 14.5h-4v-4"/></svg>';
let open = false, tab = 'gameplay', opener = null, listen = null, root = null, lastUndo = null, resetArm = '';
let pvMode = 'still', pvZoom = 2, pvT = 0, pvRaf = 0;

function buildPanel() {
  const st = document.createElement('style'); st.id = 's9set-css'; st.textContent = CSS; document.head.appendChild(st);
  root = document.createElement('div'); root.id = 's9set'; root.hidden = true;
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Settings');
  root.innerHTML = `
  <div class="s9s-head">
    <div><div class="kicker">Sector Nine</div><h2>Settings</h2></div>
    <div class="s9s-acts">
      <button class="s9s-btn" data-fs aria-pressed="false" title="Full screen / windowed (Alt+Enter)">${FS_SVG}<span class="s9s-fsl">Full screen</span><kbd class="hide-s">Alt+Enter</kbd></button>
      <button class="s9s-btn pri" data-close>Back<kbd>Esc</kbd></button>
    </div>
  </div>
  <div class="s9s-tabs" role="tablist" aria-label="Settings sections">${TABS.map(([id, l]) => `<button class="s9s-tab" role="tab" id="s9t-${id}" data-tab="${id}" aria-controls="s9s-body" aria-selected="false">${l}</button>`).join('')}</div>
  <div class="s9s-body" id="s9s-body" role="tabpanel"><div class="s9s-inner"></div></div>
  <div class="s9s-foot"><span class="s9s-status" aria-live="polite">Saved on this device</span>
    <div class="s9s-acts"><button class="s9s-btn" data-reset="tab">Reset this tab</button><button class="s9s-btn" data-reset="all">Reset everything</button></div></div>`;
  document.body.appendChild(root);
  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  root.addEventListener('change', onChange);
  root.addEventListener('contextmenu', e => { if (listen) e.preventDefault(); });
}
function setStatus(t) { const el = root && root.querySelector('.s9s-status'); if (el) el.textContent = account() && !/sync/i.test(t) ? t + ' · syncing to your account' : t === 'Saved' ? 'Saved on this device' : t; }
function note(msg, kind, undo) {
  const n = root && root.querySelector('.s9s-note.live'); if (!n) return;
  n.hidden = !msg; n.className = 's9s-note live' + (kind === 'warn' ? ' warn' : '');
  n.innerHTML = `<span>${escH(msg || '')}</span>${undo ? '<button class="s9s-btn" data-undo>Undo</button>' : ''}`;
}

/* row builders */
function rRange(path, label, help, o = {}) {
  const v = getP(S, path), [mn, mx] = NUM[path], k = o.k || 1, step = o.step || .01;
  const disp = (v * k).toFixed(o.dp ?? 2);
  return `<div class="s9s-row"><div class="s9s-lab"><b id="l-${path}">${label}</b>${help ? `<span>${help}</span>` : ''}</div>
  <div class="s9s-ctl"><input type="range" aria-labelledby="l-${path}" data-path="${path}" min="${o.min ?? mn}" max="${o.max ?? mx}" step="${step}" value="${v}">
  <input class="s9s-num" type="number" aria-label="${escH(label)} value" data-num="${path}" data-k="${k}" data-dp="${o.dp ?? 2}" min="${(o.min ?? mn) * k}" max="${(o.max ?? mx) * k}" step="${step * k}" value="${disp}">${o.unit ? `<span class="s9s-swl">${o.unit}</span>` : ''}</div>${o.extra ? `<div class="s9s-lab" style="grid-column:1/-1"><span data-extra="${path}">${o.extra()}</span></div>` : ''}</div>`;
}
function rToggle(path, label, help) {
  const v = getP(S, path);
  return `<div class="s9s-row"><div class="s9s-lab"><b id="l-${path}">${label}</b>${help ? `<span>${help}</span>` : ''}</div>
  <div class="s9s-ctl"><span class="s9s-swl" data-swl="${path}">${v ? 'On' : 'Off'}</span><button class="s9s-sw" role="switch" aria-labelledby="l-${path}" aria-checked="${v}" data-sw="${path}"></button></div></div>`;
}
function rSeg(path, label, help, opts) {
  const v = getP(S, path);
  return `<div class="s9s-row"><div class="s9s-lab"><b id="l-${path}">${label}</b>${help ? `<span>${help}</span>` : ''}</div>
  <div class="s9s-ctl"><div class="s9s-seg" role="radiogroup" aria-labelledby="l-${path}">${opts.map(([val, l]) => `<button role="radio" aria-checked="${v === val}" data-seg="${path}" data-val="${val}">${l}</button>`).join('')}</div></div></div>`;
}
const sec = (title, inner) => `<section class="s9s-sec"><h3>${title}</h3>${inner}</section>`;
const NOTE = () => `<div class="s9s-note live"${loadNote ? '' : ' hidden'}><span>${escH(loadNote)}</span></div>`;

// sensitivity equivalents: the game turns .0021 rad per mouse count at 1.0
const cm360 = s => (2 * Math.PI / (.0021 * s)) / 800 * 2.54;
const sensExtra = () => `≈ ${cm360(S.mouse.sens).toFixed(1)} cm per 360° at 800 DPI · same feel as CS2 ${(S.mouse.sens * .0021 * 180 / Math.PI / .022).toFixed(2)} · Valorant ${(S.mouse.sens * .0021 * 180 / Math.PI / .07).toFixed(3)}`;
const fovExtra = () => `${S.video.fov}° vertical ≈ ${Math.round(360 / Math.PI * Math.atan(Math.tan(S.video.fov * Math.PI / 360) * 16 / 9))}° horizontal on a 16:9 screen. Default 78.`;

function tabHTML(t) {
  if (t === 'gameplay') return NOTE() + sec('Feedback', rToggle('gameplay.damageNumbers', 'Damage numbers', 'Numbers that pop out of an enemy when you hit them.') +
      rToggle('gameplay.hitSound', 'Hit sound', 'The thock / ding you hear when a shot lands.') +
      rSeg('gameplay.killFeedSize', 'Kill feed size', 'Size of the kill list in the top right.', [['small', 'Small'], ['normal', 'Normal'], ['large', 'Large']])) +
    sec('Accessibility', rSeg('gameplay.colorblind', 'Colour-blind mode', 'Paints every enemy visor, body glow and health bar in one colour that stands out for your type of colour vision.',
      [['off', 'Off'], ['deuteranopia', 'Deuteranopia'], ['protanopia', 'Protanopia'], ['tritanopia', 'Tritanopia']]) +
      `<div class="s9s-row"><div class="s9s-lab"><b>Enemy colour</b><span>What enemies look like with the current mode.</span></div><div class="s9s-ctl"><span><i class="s9s-cbsw" style="background:${CB[S.gameplay.colorblind] || 'linear-gradient(90deg,#ff5a3c,#3fd0ff,#ffd23f)'}"></i>${S.gameplay.colorblind === 'off' ? 'Each player keeps their own colour' : escH(CB[S.gameplay.colorblind])}</span></div></div>`);
  if (t === 'controls') {
    let kb = '', g = '';
    for (const a of ACTIONS) {
      if (a.group !== g) { g = a.group; kb += `${kb ? '</div></section>' : ''}<section class="s9s-sec"><h3>${g}</h3><div class="s9s-kb"><div class="hd">Action</div><div class="hd k">Primary</div><div class="hd k">Secondary</div>`; }
      const b = S.controls.binds[a.id], none = !b[0] && !b[1];
      kb += `<div class="lab${none ? ' warn' : ''}" id="kb-${a.id}">${escH(a.label)}${none ? ' <small>(no key)</small>' : ''}</div>` + [0, 1].map(i => {
        const fixed = a.id === 'pause' && i === 0, code = b[i];
        return `<div class="k"><button class="s9s-key${code ? '' : ' none'}${fixed ? ' fixed' : ''}" data-bind="${a.id}" data-slot="${i}" aria-describedby="kb-${a.id}" ${fixed ? 'aria-disabled="true" title="Esc always opens the pause menu"' : ''}>${code ? escH(keyName(code, true)) : '—'}</button></div>`;
      }).join('');
    }
    kb += '</div></section>';
    return NOTE() + `<div class="s9s-note"><span>Click a key box, then press the new key or mouse button. <b>Esc</b> cancels, <b>Backspace</b> clears. A key can only do one thing: taking it from another action unbinds it there (you can undo).</span><button class="s9s-btn" data-reset="binds">Reset keys</button></div>` +
      sec('Aiming', rSeg('controls.adsMode', 'Aim down sights mode', 'Hold: aim while the button is held. Toggle: press once to aim, again to stop.', [['hold', 'Hold'], ['toggle', 'Toggle']])) + kb;
  }
  if (t === 'mouse') return NOTE() + sec('Sensitivity',
      rRange('mouse.sens', 'Sensitivity', 'How far you turn per mouse movement when not aiming.', { step: .01, dp: 2, extra: sensExtra }) +
      rRange('mouse.adsMult', 'Aiming / scoped multiplier', '1.00 = same feel as hip fire (the game already slows aim to match each scope zoom). Lower = slower while aiming.', { step: .01, dp: 2 }) +
      rToggle('mouse.invertY', 'Invert vertical look', 'Mouse forward looks down.')) +
    `<div class="s9s-note"><span>Raw input: the game asks the browser for <b>unadjusted movement</b> (no Windows mouse acceleration) whenever your browser supports it, so only this sensitivity and your mouse DPI matter. Turn off "Enhance pointer precision" in Windows if your browser does not support it.</span></div>`;
  if (t === 'crosshair') return NOTE() + xhTabHTML();
  if (t === 'video') return NOTE() + sec('Display',
      `<div class="s9s-row"><div class="s9s-lab"><b id="l-dm">Display mode</b><span>Full screen hides the browser bars. Shortcut <kbd class="s9s-kbd">Alt+Enter</kbd> (or the browser's <kbd class="s9s-kbd">F11</kbd>).</span></div>
      <div class="s9s-ctl"><div class="s9s-seg" role="radiogroup" aria-labelledby="l-dm"><button role="radio" data-fsmode="window" aria-checked="${!fsEl()}">Windowed</button><button role="radio" data-fsmode="full" aria-checked="${!!fsEl()}">Full screen</button></div></div></div>` +
      rRange('video.fov', 'Field of view', 'Wider shows more around you, narrower makes targets look bigger.', { step: 1, dp: 0, unit: '°', extra: fovExtra }) +
      rToggle('video.fps', 'FPS counter', 'Frames per second at the bottom of the screen.')) +
    sec('Quality', rSeg('video.quality', 'Graphics quality', 'Low = no shadows, lower resolution, no glow (smoothest). Auto picks for your computer. The game may still lower quality by itself if frames drop.',
      [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['auto', 'Auto']])) +
    sec('Image', rRange('video.brightness', 'Brightness', '', { step: .01, k: 100, dp: 0, unit: '%' }) + rRange('video.gamma', 'Gamma', 'Brightens dark corners without washing out bright areas.', { step: .01, dp: 2 })) +
    sec('Comfort', rRange('video.shake', 'Camera shake', 'Screen shake from explosions, hits and landing. 0% = steady camera.', { step: .01, k: 100, dp: 0, unit: '%' }) +
      `<div class="s9s-row"><div class="s9s-lab"><b>Motion blur</b><span>Sector Nine never uses motion blur, nothing to turn off.</span></div><div class="s9s-ctl"><span class="s9s-swl">Always off</span></div></div>`);
  if (t === 'audio') return NOTE() + sec('Volume',
      rRange('audio.master', 'Master volume', '', { step: .01, k: 100, dp: 0, unit: '%' }) +
      rRange('audio.effects', 'Effects', 'Guns, hits, explosions, abilities.', { step: .01, k: 100, dp: 0, unit: '%' }) +
      rRange('audio.ambience', 'Music & ambience', 'Wind and the map hum (there is no music track yet).', { step: .01, k: 100, dp: 0, unit: '%' }) +
      rRange('audio.footsteps', 'Enemy footsteps boost', 'Makes enemy steps louder than the rest so you hear people coming. 100% = normal.', { step: .01, k: 100, dp: 0, unit: '%' }) +
      `<div class="s9s-row"><div class="s9s-lab"><b>Voice chat</b><span>Coming with voice chat; push-to-talk key is already in Controls.</span></div><div class="s9s-ctl"><input type="range" disabled min="0" max="1" step=".01" value="${S.audio.voice}" aria-label="Voice chat volume (coming soon)"><span class="s9s-swl">Soon</span></div></div>`) +
    sec('Behaviour', rToggle('audio.muteUnfocused', 'Mute when the window is in the background', 'Silences the game when you switch to another window (it is always silent while paused or when the tab is hidden).'));
  return '';
}
function xhTabHTML() {
  const c = S.crosshair;
  const styleSeg = rSeg('crosshair.style', 'Style', '', [['cross', 'Cross'], ['crossdot', 'Cross + dot'], ['dot', 'Dot'], ['circle', 'Circle'], ['tshape', 'T-shape'], ['chevron', 'Chevron']]);
  const colour = `<div class="s9s-row"><div class="s9s-lab"><b id="l-xc">Colour</b></div><div class="s9s-ctl"><div class="s9s-sws" role="radiogroup" aria-labelledby="l-xc">${COLORS.map(([h, n]) => `<button class="s9s-sw2" role="radio" title="${n}" aria-label="${n}" aria-checked="${c.color === h}" data-color="${h}" style="background:${h}"></button>`).join('')}<label class="s9s-custom">Custom <input type="color" data-colorpick value="${c.color}" aria-label="Custom colour"></label></div></div></div>`;
  return `<div class="s9s-xh"><div class="s9s-pv">
      <div class="s9s-prev" id="s9pv"><canvas id="s9pvc"></canvas><span class="s9s-pvtag" id="s9pvtag">Preview · actual size ×${pvZoom}</span></div>
      <div class="s9s-pvbar"><div class="s9s-seg" role="radiogroup" aria-label="Preview">${[['still', 'Still'], ['move', 'Moving'], ['ads', 'Aiming']].map(([v, l]) => `<button role="radio" data-pv="${v}" aria-checked="${pvMode === v}">${l}</button>`).join('')}</div>
      <div class="s9s-seg" role="radiogroup" aria-label="Zoom">${[1, 2, 4].map(z => `<button role="radio" data-pz="${z}" aria-checked="${pvZoom === z}">×${z}</button>`).join('')}</div></div>
      <div class="s9s-sec"><h3>Share code</h3><div class="s9s-row" style="grid-template-columns:1fr"><div class="s9s-ctl" style="justify-content:flex-start">
        <input class="s9s-code" id="s9code" aria-label="Crosshair code" spellcheck="false" autocomplete="off" value="${escH(exportCode())}">
        <button class="s9s-btn" data-xh="copy">Copy</button><button class="s9s-btn" data-xh="import">Import</button></div>
        <div class="s9s-lab"><span>Paste a Sector Nine code (S9;…) or a Valorant code (0;P;…) and press Import.</span></div></div></div>
      <div class="s9s-presets" aria-label="Presets">${XH_PRESETS.map(([n], i) => `<button data-preset="${i}"><canvas width="22" height="22" data-pi="${i}"></canvas>${n}</button>`).join('')}</div>
    </div><div style="display:grid;gap:18px;min-width:0">
      ${sec('Shape', styleSeg + colour + rRange('crosshair.length', 'Line length', '', { step: 1, dp: 0, unit: 'px' }) + rRange('crosshair.thickness', 'Line thickness', '', { step: 1, dp: 0, unit: 'px' }) +
        rRange('crosshair.gap', 'Gap', 'Space between the centre and the lines (ring size for Circle).', { step: 1, dp: 0, unit: 'px' }) + rRange('crosshair.dot', 'Centre dot size', '0 = no dot.', { step: 1, dp: 0, unit: 'px' }) +
        rRange('crosshair.opacity', 'Opacity', '', { step: .01, k: 100, dp: 0, unit: '%' }))}
      ${sec('Outline', rToggle('crosshair.outline', 'Outline', 'A dark edge so the crosshair stays visible on bright walls.') + rRange('crosshair.outlineThickness', 'Outline thickness', '', { step: 1, dp: 0, unit: 'px' }) +
        rRange('crosshair.outlineOpacity', 'Outline opacity', '', { step: .01, k: 100, dp: 0, unit: '%' }))}
      ${sec('Behaviour', rToggle('crosshair.dynamic', 'Dynamic spread', 'Lines open up while you move, jump or fire, showing your real accuracy.') +
        rToggle('crosshair.adsShow', 'Show crosshair while aiming', 'Keeps it on screen when you aim down sights (scopes always use their own reticle).'))}
    </div></div>`;
}

let pvImg = null;
function drawPreview() {
  if (!open || tab !== 'crosshair' || !root) return;
  const cv = $('s9pvc'); if (!cv) return;
  const c = S.crosshair, k = devicePixelRatio || 1, size = xhSize(c, true);
  cv.width = Math.ceil(size * k); cv.height = Math.ceil(size * k);
  const css = cv.width / k * pvZoom; cv.style.width = css + 'px'; cv.style.height = css + 'px'; cv.style.marginLeft = cv.style.marginTop = (-css / 2) + 'px';
  let g = c.gap, vis = c.opacity;
  if (pvMode === 'move' && c.dynamic) g = c.gap + (Math.sin(pvT * 3) * .5 + .5) * 12;
  if (pvMode === 'ads' && !c.adsShow) vis = 0;
  drawXH(cv.getContext('2d'), c, g, k); cv.style.opacity = String(vis);
  const tg = $('s9pvtag'); if (tg) tg.textContent = pvMode === 'ads' && !c.adsShow ? 'Aiming: crosshair hidden (turn on "Show while aiming")' : `Preview · actual size ×${pvZoom}`;
  const code = $('s9code'); if (code && document.activeElement !== code) code.value = exportCode();
}
function drawPresetIcons() {
  for (const cv of root.querySelectorAll('canvas[data-pi]')) { const p = Object.assign(clone(DEFAULTS.crosshair), XH_PRESETS[+cv.dataset.pi][1]); const sc = Math.min(1, 9 / (Math.max(p.gap, 0) + p.length + 2)); drawXH(cv.getContext('2d'), Object.assign(p, { length: Math.max(1, Math.round(p.length * sc)), gap: Math.round(p.gap * sc) }), Math.round(p.gap * sc), 1); }
}
function pvLoop(t) { pvRaf = 0; if (!open || tab !== 'crosshair') return; pvT = t / 1000; if (pvMode === 'move') { drawPreview(); pvRaf = requestAnimationFrame(pvLoop); } }

function renderTab() {
  if (!root) return;
  for (const b of root.querySelectorAll('.s9s-tab')) { const on = b.dataset.tab === tab; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; }
  root.querySelector('#s9s-body').setAttribute('aria-labelledby', 's9t-' + tab);
  const tb = root.querySelector(`[data-tab="${tab}"]`); if (tb && tb.scrollIntoView) tb.scrollIntoView({ block: 'nearest', inline: 'center' });
  const inner = root.querySelector('.s9s-inner'), body = root.querySelector('.s9s-body'), sc = body.scrollTop;
  inner.innerHTML = tabHTML(tab); body.scrollTop = sc;
  if (tab === 'crosshair') {
    const pv = $('s9pv');
    if (!pvImg) { pvImg = new Image(); pvImg.onload = () => { pvImg.ok = true; const p = $('s9pv'); if (p) { p.classList.add('img'); p.style.backgroundImage = `url(${pvImg.src})`; } }; pvImg.src = 'assets/ui/map_dunes.jpg'; }
    else if (pvImg.ok && pv) { pv.classList.add('img'); pv.style.backgroundImage = `url(${pvImg.src})`; }
    drawPreview(); drawPresetIcons();
    if (pvMode === 'move' && !pvRaf) pvRaf = requestAnimationFrame(pvLoop);
  }
  syncFsButton();
}
function refreshControls(path) {
  // keep both halves of a slider/number pair and dependent texts in step without rebuilding (keeps focus while dragging)
  const v = getP(S, path);
  for (const r of root.querySelectorAll(`[data-path="${path}"]`)) if (+r.value !== v) r.value = v;
  for (const n of root.querySelectorAll(`[data-num="${path}"]`)) if (document.activeElement !== n) n.value = (v * +n.dataset.k).toFixed(+n.dataset.dp);
  const ex = root.querySelector(`[data-extra="${path}"]`); if (ex) ex.textContent = path === 'mouse.sens' ? sensExtra() : path === 'video.fov' ? fovExtra() : '';
}
function set(path, v, opts = {}) {
  const d = getP(DEFAULTS, path);
  if (typeof d === 'number') v = clamp(+v, ...NUM[path]); if (typeof d === 'number' && !isFinite(v)) return;
  setP(S, path, v); save(); applySection(path.split('.')[0]);
  if (opts.rerender) renderTab(); else refreshControls(path);
  if (path.startsWith('crosshair.')) drawPreview();
}
function applySection(secName) {
  if (secName === 'mouse') applyMouse();
  else if (secName === 'audio') applyAudioGains();
  else if (secName === 'video') { applyVideo(); applyQualitySetting(); }
  else if (secName === 'crosshair') applyCrosshair();
  else if (secName === 'gameplay') applyGameplay();
  else if (secName === 'controls') rebuildBinds();
}
function applyAll() { rebuildBinds(); applyMouse(); applyAudioGains(); applyVideo(); applyQualitySetting(); applyCrosshair(); applyGameplay(); }

function onInput(e) {
  const t = e.target;
  if (t.dataset.path) set(t.dataset.path, +t.value);
  else if (t.dataset.colorpick !== undefined) { set('crosshair.color', t.value.toLowerCase()); for (const b of root.querySelectorAll('[data-color]')) b.setAttribute('aria-checked', String(b.dataset.color === S.crosshair.color)); }
}
function onChange(e) {
  const t = e.target;
  if (t.dataset.num) { const v = +t.value / +t.dataset.k; if (isFinite(v) && t.value !== '') set(t.dataset.num, v); t.value = (getP(S, t.dataset.num) * +t.dataset.k).toFixed(+t.dataset.dp); refreshControls(t.dataset.num); }
}
function onClick(e) {
  const b = e.target.closest('button'); if (!b || !root.contains(b)) return;
  if (b.dataset.tab) { tab = b.dataset.tab; stopListen(); resetArm = ''; renderTab(); b.focus(); return; }
  if (b.hasAttribute('data-close')) { close(); return; }
  if (b.hasAttribute('data-fs')) { toggleFullscreen(); return; }
  if (b.dataset.fsmode) { if ((b.dataset.fsmode === 'full') !== !!fsEl()) toggleFullscreen(); return; }
  if (b.dataset.sw) { set(b.dataset.sw, !getP(S, b.dataset.sw)); b.setAttribute('aria-checked', String(getP(S, b.dataset.sw))); const l = root.querySelector(`[data-swl="${b.dataset.sw}"]`); if (l) l.textContent = getP(S, b.dataset.sw) ? 'On' : 'Off'; return; }
  if (b.dataset.seg) { set(b.dataset.seg, b.dataset.val, { rerender: b.dataset.seg === 'gameplay.colorblind' }); for (const x of root.querySelectorAll(`[data-seg="${b.dataset.seg}"]`)) x.setAttribute('aria-checked', String(x.dataset.val === b.dataset.val)); return; }
  if (b.dataset.color) { set('crosshair.color', b.dataset.color); for (const x of root.querySelectorAll('[data-color]')) x.setAttribute('aria-checked', String(x === b)); const cp = root.querySelector('[data-colorpick]'); if (cp) cp.value = b.dataset.color; return; }
  if (b.dataset.pv) { pvMode = b.dataset.pv; for (const x of root.querySelectorAll('[data-pv]')) x.setAttribute('aria-checked', String(x === b)); drawPreview(); if (pvMode === 'move' && !pvRaf) pvRaf = requestAnimationFrame(pvLoop); return; }
  if (b.dataset.pz) { pvZoom = +b.dataset.pz; for (const x of root.querySelectorAll('[data-pz]')) x.setAttribute('aria-checked', String(x === b)); drawPreview(); return; }
  if (b.dataset.preset !== undefined) { S.crosshair = Object.assign(clone(DEFAULTS.crosshair), XH_PRESETS[+b.dataset.preset][1]); save(); applyCrosshair(); renderTab(); note(`Preset "${XH_PRESETS[+b.dataset.preset][0]}" applied.`); return; }
  if (b.dataset.xh === 'copy') { const code = exportCode(); const inp = $('s9code'); if (inp) { inp.value = code; inp.select(); } try { navigator.clipboard.writeText(code).then(() => note('Code copied. Send it to a friend.'), () => note('Code selected, press Ctrl+C to copy.')); } catch (x) { note('Code selected, press Ctrl+C to copy.'); } return; }
  if (b.dataset.xh === 'import') { doImport(); return; }
  if (b.dataset.bind) { if (b.classList.contains('fixed')) { note('Esc always opens the pause menu. You can add a second pause key next to it.'); return; } startListen(b); return; }
  if (b.hasAttribute('data-undo')) { if (lastUndo) { S.controls.binds = lastUndo; lastUndo = null; save(); rebuildBinds(); renderTab(); note('Undone.'); } return; }
  if (b.dataset.reset) {
    const what = b.dataset.reset, label = what === 'all' ? 'Reset everything' : what === 'binds' ? 'Reset keys' : 'Reset this tab';
    if (resetArm !== what) { resetArm = what; b.textContent = 'Click again to confirm'; setTimeout(() => { if (resetArm === what) { resetArm = ''; if (b.isConnected) b.textContent = label; } }, 3000); return; }
    resetArm = ''; reset(what === 'tab' ? tab : what === 'binds' ? 'binds' : 'all'); renderTab(); note(what === 'all' ? 'Every setting is back to default.' : 'Back to default.'); return;
  }
}
function doImport() {
  const inp = $('s9code'), r = importCode(inp ? inp.value : '');
  if (!r.ok) { note(r.msg, 'warn'); return; }
  S.crosshair = r.c; save(); applyCrosshair(); renderTab(); note(r.msg);
}
function reset(what) {
  if (what === 'all') { S = clone(DEFAULTS); if (S.video.quality === 'auto') {} }
  else if (what === 'binds') { S.controls.binds = clone(DEFAULTS.controls.binds); }
  else if (DEFAULTS[what]) S[what] = clone(DEFAULTS[what]);
  save(); applyAll();
}

/* key rebinding */
function startListen(btn) {
  stopListen();
  listen = { id: btn.dataset.bind, slot: +btn.dataset.slot, btn, t: performance.now() };
  btn.classList.add('listen'); btn.textContent = 'Press a key…';
}
function stopListen() { if (!listen) return; const l = listen; listen = null; if (l.btn.isConnected) { l.btn.classList.remove('listen'); const c = S.controls.binds[l.id][l.slot]; l.btn.textContent = c ? keyName(c, true) : '—'; } }
function assign(code) {
  const { id, slot } = listen; stopListen();
  const before = clone(S.controls.binds), B = S.controls.binds;
  if (code === '') { B[id][slot] = ''; save(); rebuildBinds(); renderTab(); return; }
  if (B[id][slot] === code) { renderTab(); return; }
  let taken = null;
  for (const a of ACTIONS) for (let i = 0; i < 2; i++) if (B[a.id][i] === code && !(a.id === id && i === slot)) { taken = a; B[a.id][i] = ''; }
  B[id][slot] = code; save(); rebuildBinds(); renderTab();
  if (taken && taken.id !== id) {
    lastUndo = before; const left = B[taken.id][0] || B[taken.id][1];
    note(`${keyName(code, true)} was used by "${taken.label}". It now does "${ACT[id].label}" only${left ? '' : `, and "${taken.label}" has no key`}.`, 'warn', true);
  } else note(`"${ACT[id].label}" is now ${keyName(code, true)}.`);
}
function panelKey(e) {
  // while the panel is open the game never sees keys (so Enter on the menu doesn't start a match, WASD doesn't walk)
  e.stopImmediatePropagation();
  if (e.type !== 'keydown') return;
  if (listen) {
    e.preventDefault();
    if (e.code === 'Escape') { stopListen(); return; }
    if (e.code === 'Backspace' || e.code === 'Delete') { assign(''); return; }
    if (!e.code || !CODE.test(e.code)) return;
    assign(e.code); return;
  }
  if (e.code === 'Escape') { e.preventDefault(); close(); return; }
  if (e.code === 'Enter' && e.altKey) { e.preventDefault(); toggleFullscreen(); return; }
  if (e.target && e.target.id === 's9code' && e.code === 'Enter') { e.preventDefault(); doImport(); return; }
  const tb = e.target && e.target.closest && e.target.closest('.s9s-tab');
  if (tb && (e.code === 'ArrowRight' || e.code === 'ArrowLeft')) { e.preventDefault(); const i = TABS.findIndex(x => x[0] === tab), n = TABS[(i + (e.code === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length][0]; tab = n; renderTab(); root.querySelector(`[data-tab="${n}"]`).focus(); }
}
function panelMouse(e) {
  if (!listen || e.type !== 'mousedown') return;
  if (performance.now() - listen.t < 120 && e.button === 0 && e.target === listen.btn) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (e.button > 4) return;
  // eat only the click / auxclick / context menu that belongs to THIS press, never a later real click
  const btn = e.button, t0 = performance.now();
  const swallow = ev => { if (ev.button === btn && performance.now() - t0 < 1500) { ev.preventDefault(); ev.stopImmediatePropagation(); } done(); };
  const done = () => { for (const k of ['click', 'auxclick', 'contextmenu']) removeEventListener(k, swallow, true); removeEventListener('mouseup', onUp, true); };
  const onUp = ev => { if (ev.button !== btn) return; setTimeout(done, 0); };
  for (const k of ['click', 'auxclick', 'contextmenu']) addEventListener(k, swallow, true);
  addEventListener('mouseup', onUp, true); setTimeout(done, 1500);
  assign('Mouse' + btn);
}

/* open / close */
function openPanel(which, from) {
  if (!root) return;
  if (which && TABS.some(t => t[0] === which)) tab = which;
  opener = from || document.activeElement;
  open = true; root.hidden = false; resetHeld(); renderTab();
  const b = root.querySelector(`[data-tab="${tab}"]`); if (b) b.focus({ preventScroll: true });
}
function close() {
  if (!open) return;
  stopListen(); open = false; root.hidden = true; resetArm = ''; loadNote = '';
  if (pvRaf) { cancelAnimationFrame(pvRaf); pvRaf = 0; }
  // never re-lock the pointer: you land back on the menu / pause screen exactly as you left it
  if (opener && opener.isConnected && typeof opener.focus === 'function' && !opener.closest('[hidden]')) opener.focus({ preventScroll: true });
}
function injectButtons() {
  const add = (afterId, id) => {
    if ($(id)) return; const ref = $(afterId); if (!ref) return;
    const b = document.createElement('button'); b.className = 'ghost'; b.id = id; b.type = 'button'; b.textContent = 'Settings';
    ref.insertAdjacentElement('afterend', b); b.addEventListener('click', () => openPanel(null, b));
  };
  add('btnArsenal', 'btnSettings'); add('btnArsenal2', 'btnSettings2');
}

/* ============ per-frame work (runs just before the game's own frame) ============ */
let lastTrauma = 0, lastState = '';
function tick() {
  const s = S9(); if (!s) return;
  const st = s.state;
  if (st !== lastState) { if (st !== 'play' && st !== 'dead') resetHeld(); if (st !== 'play') adsOn = false; lastState = st; if (fovActive() && s.camera) s.camera.updateProjectionMatrix(); }
  if (!AUD.wired && s.AU && s.AU.ctx && s.AU.master) wireAudio();
  if (s.P) { const t = s.P.trauma || 0; if (S.video.shake < 1 && t > lastTrauma + 1e-5) s.P.trauma = lastTrauma + (t - lastTrauma) * S.video.shake; lastTrauma = s.P.trauma || 0; }
  if (st === 'play' || st === 'dead' || st === 'paused') { updateColorblind(); updateGameXH(); }
}
function hookFrame() {
  // index.html's loop calls requestAnimationFrame(frame) every frame: run tick() right before it, so camera shake and
  // enemy colours are applied before that frame renders. Falls back to our own loop if the game's loop isn't seen.
  const raf = window.requestAnimationFrame.bind(window); let seen = false;
  window.requestAnimationFrame = function (cb) {
    if (typeof cb === 'function' && cb.name === 'frame') { seen = true; return raf(t => { try { tick(); } catch (e) {} cb(t); }); }
    return raf(cb);
  };
  setTimeout(() => { if (!seen) { const loop = () => { try { tick(); } catch (e) {} raf(loop); }; raf(loop); } }, 1500);
}

/* ============ boot ============ */
const api = {
  DEFAULTS: clone(DEFAULTS), ACTIONS: ACTIONS.map(a => ({ ...a })),
  get: () => clone(S), set: (path, v) => set(path, v, { rerender: true }),
  open: (t) => openPanel(t), close, isOpen: () => open, reset: w => { reset(w || 'all'); if (open) renderTab(); },
  exportCrosshair: () => exportCode(), importCrosshair: code => { const r = importCode(code); if (r.ok) { S.crosshair = r.c; save(); applyCrosshair(); if (open) renderTab(); } return r; },
  applyRemote, keyName, toggleFullscreen, sync: syncRemote,
  _audio: AUD, _grade: GRADE, _drawXH: drawXH
};
window.S9Settings = api;
startAudioWatch();
function init() {
  const s = S9();
  if (!s || !s.camera || !document.body || !$('btnArsenal')) { setTimeout(init, 100); return; }
  if (!root) buildPanel();
  injectButtons(); hookCamera(); hookRenderer(); hookSfx(); watchQuick(); hookFrame();
  if (firstRun) { const sv = $('msens'), vv = $('mvol'), qv = $('mq'); if (sv) S.mouse.sens = clamp(+sv.value || 1, ...NUM['mouse.sens']); if (vv) S.audio.master = clamp(+vv.value, 0, 1); if (qv && GAME_TO_Q[qv.value]) S.video.quality = GAME_TO_Q[qv.value]; }
  applyAll();
  const A = window.S9Account;
  if (A && typeof A.onChange === 'function') A.onChange(onAccountChange);
  if (account()) onAccountChange(acctProfile());
  if (loadNote) { try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) {} }
}
init();
})();
