/* Sector Nine - Radar / minimap (top-left) + full map overlay (M).
   Add-on module, loaded after index.html's main script. Talks to the game only through window.__s9 (P, robots, camera,
   NAV, world.colliders, MAPFX, HALF, CUR_MAP, lineOfSight, state), window.MODE (teams + the demolition charge),
   window.SPECTATE (who a spectator follows) and the DOM. No index.html / modes.js edits.

   Fair competitive rules (CS2 / Valorant / CoD conventions):
   - Always shown: you + your view cone, teammates (team modes) in team colour, bomb sites, the charge (planted: everyone;
     carried / dropped: attackers only), jump pads and teleporters.
   - Enemies ONLY when revealed: a red ping for ~2 s where they fired an unsuppressed weapon nearby (CoD), or while you or
     a teammate can see them (CS2 spotting: in their view cone + clear line of sight), then a fading "last seen" ghost.
   - Free for all: no enemy dots except firing pings. Never a hidden enemy's live position (no wallhack).
   - Online it uses only what the client already has: other players' streamed state and their shot events (`sh` sequence
     -> r.firedT, sector-nine-server/PROTOCOL.md "Radar reveals").
   Map art: built once per map from the level geometry (collision boxes + NAV heights + pads/teleporters/hazards) into a
   cached canvas at devicePixelRatio; each frame only blits that cache and draws a few dots (Canvas 2D: no WebGL, no shaders).
   Config: data/radar.json (the Unity port reads the same file). Settings: Settings > Gameplay > Radar
   (localStorage 'sector9-radar'). API for tests: window.S9Radar. */
(() => {
'use strict';
if (window.S9Radar) return;

/* ============ config (identical to data/radar.json; the gate test checks they match) ============ */
const DEF = {
  v: 1,
  about: 'Minimap / radar config (modules/radar.js). Engine-neutral so the Unity port reads the same file. Distances in metres, times in ms, sizes in CSS px.',
  layout: {
    desktop: { sizes: { small: 160, medium: 200, large: 250 }, top: 18, left: 22 },
    phone: { sizes: { small: 84, medium: 100, large: 120 }, top: 54, left: 10, maxWidth: 700, maxHeight: 460 },
    hudGap: 12,
    rimPx: 2
  },
  view: { range: 30, zoomMin: .6, zoomMax: 1.8, zoomDefault: 1, coneLen: .42, coneDeg: 0, edgeClampAllies: true },
  reveal: { fireMs: 2000, fireFadeMs: 600, fireRange: 50, silentWeapons: ['knife'], spotHz: 10, spotRange: 70, spotFovDeg: 100, spotHoldMs: 260, lastSeenMs: 1500, maxRaysPerTick: 4, deadAllyMs: 4000 },
  bomb: { droppedVisibleTo: 'atk', carriedVisibleTo: 'atk', plantedVisibleTo: 'all', defusedMs: 3000 },
  colors: {
    panel: 'rgba(11,13,16,.74)', rim: 'rgba(236,230,216,.32)', north: '#ff9a3c', me: '#ece6d8', meOutline: '#0b0d10', cone: 'rgba(236,230,216,.16)',
    ffaAlly: '#7fe7ff', teams: { atk: '#ff8a3d', def: '#3dc8ff' }, enemy: '#ff2e4d', enemyOutline: '#ffffff',
    bomb: '#ffb347', bombPlanted: '#ff4a3d', bombDefused: '#5dff9a', site: '#ff9a3c', pad: '#7fe7ff', teleport: ['#c38bff', '#5dff9a', '#ffd23f', '#ff7ad9']
  },
  art: {
    ppmMin: 6, ppmMax: 16, maxPx: 4096, radarOversample: 1.4, overheadMinY: 2.3, wallMinY: 1.75, coverMinY: .45,
    ground: '#4b5560', levels: ['#4b5560', '#617080', '#7b8998', '#97a4b2'], levelStep: 2.2, floorEdge: 'rgba(6,7,10,.55)',
    cover: '#aaa395', wall: '#e6dfcf', wallEdge: '#06070a', edgePx: 1.6,
    hazards: { lava: 'rgba(255,110,40,.75)', acid: 'rgba(110,255,90,.6)', ice: 'rgba(120,200,255,.55)', water: 'rgba(80,160,255,.55)' }
  },
  bigMap: { key: 'KeyM', fill: .86, keyChoices: ['KeyM', 'KeyN', 'KeyB', 'KeyK', 'KeyL', 'KeyJ', 'KeyH', 'KeyU', 'KeyI', 'KeyO', 'KeyP', 'KeyZ', 'KeyT', 'KeyY', 'CapsLock', 'Backquote', 'Comma', 'Period'] },
  budgets: { tickMsAvg: .35, tickMsP99: 1.5, drawOpsBase: 24, drawOpsPerEntity: 4, raysPerSecond: 40, cacheBuildsPerMap: 1 }
};
const clone = o => JSON.parse(JSON.stringify(o));
const merge = (a, b) => { const o = clone(a); for (const k in b) o[k] = (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && o[k] && typeof o[k] === 'object') ? merge(o[k], b[k]) : b[k]; return o; };
let C = clone(DEF), silent = new Set(C.reveal.silentWeapons);
fetch('data/radar.json').then(r => r.ok ? r.json() : null).then(j => { if (j && j.v === 1) { C = merge(DEF, j); silent = new Set(C.reveal.silentWeapons); layout(); art = null; } }).catch(() => {});

const $ = id => document.getElementById(id);
const S9 = () => window.__s9;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const TAU = Math.PI * 2;

/* ============ settings (Settings > Gameplay > Radar) ============ */
const LS = 'sector9-radar';
function cleanSet(s) {
  s = s && typeof s === 'object' ? s : {};
  const keyOk = typeof s.key === 'string' && C.bigMap.keyChoices.includes(s.key);
  return { on: s.on !== false, size: ['small', 'medium', 'large'].includes(s.size) ? s.size : 'medium', rotate: s.rotate !== false,
    zoom: clamp(isFinite(+s.zoom) && s.zoom !== null && s.zoom !== '' ? +s.zoom : C.view.zoomDefault, C.view.zoomMin, C.view.zoomMax), key: keyOk ? s.key : C.bigMap.key };
}
let SET = (() => { try { return cleanSet(JSON.parse(localStorage.getItem(LS) || '{}')); } catch (e) { return cleanSet({}); } })();
function saveSet() { try { localStorage.setItem(LS, JSON.stringify(SET)); } catch (e) {} }
function setOpt(k, v) { const n = cleanSet(Object.assign({}, SET, { [k]: v })); const zoomed = n.zoom !== SET.zoom || n.size !== SET.size; SET = n; saveSet(); layout(); if (zoomed && art) art.small = null; refreshSettingsUi(); return clone(SET); }

/* ============ DOM ============ */
const css = document.createElement('style');
css.id = 's9radar-css';
css.textContent = `
#s9radar{position:absolute;top:calc(var(--rdr-top,18px) + env(safe-area-inset-top,0px));left:calc(var(--rdr-left,22px) + env(safe-area-inset-left,0px));width:var(--rdr-size,200px);height:var(--rdr-size,200px);border-radius:50%;
  background:rgba(11,13,16,.9);box-shadow:0 0 0 1px rgba(236,230,216,.28),0 0 0 3px rgba(11,13,16,.55),0 6px 22px rgba(0,0,0,.45);pointer-events:none;z-index:2}
#s9radar[hidden]{display:none}
#s9radar .vp{position:absolute;inset:var(--rdr-rim,2px);border-radius:50%;overflow:hidden;background:rgba(11,13,16,.92);transform:translateZ(0)}
#s9radar .vp canvas.map{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform;display:block}
#s9radar canvas.dyn{position:absolute;inset:0;width:100%;height:100%;display:block;border-radius:50%}
#s9radar canvas.me{position:absolute;left:50%;top:50%;will-change:transform;display:block}
#s9radar .n{position:absolute;left:50%;top:50%;font:800 calc(var(--rdr-size,200px) * .075)/1 var(--display,Impact,sans-serif);color:#ff9a3c;text-shadow:0 0 3px #0b0d10,0 0 2px #0b0d10;will-change:transform}
#s9radar::after{content:"";position:absolute;inset:-5px;border-radius:50%;border:1px solid rgba(255,154,60,.22);clip-path:polygon(0 0,38% 0,38% 6%,0 6%,0 0,100% 0,100% 100%,62% 100%,62% 94%,100% 94%,100% 100%,0 100%);pointer-events:none}
body.s9radar .hud .corner.tl{top:calc(var(--rdr-top,18px) + var(--rdr-size,200px) + var(--rdr-gap,12px) + env(safe-area-inset-top,0px))}
#s9bigmap{position:fixed;inset:0;z-index:40;display:grid;place-items:center;background:rgba(5,6,8,.74);pointer-events:none;font-family:var(--mono,monospace)}
#s9bigmap[hidden]{display:none}
#s9bigmap .bm{position:relative;width:var(--bm-size,600px);display:grid;gap:8px}
#s9bigmap .bmh{display:flex;align-items:baseline;justify-content:space-between;gap:12px;color:var(--ink,#ece6d8);text-shadow:0 1px 3px #000}
#s9bigmap .bmh b{font:800 clamp(18px,2.6vw,26px)/1 var(--display,Impact,sans-serif);letter-spacing:.08em;text-transform:uppercase}
#s9bigmap .bmh span{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim,#8b9097)}
#s9bigmap .bmh kbd{font:600 11px var(--mono,monospace);color:var(--sodium,#ff9a3c);border:1px solid rgba(255,154,60,.5);padding:1px 6px;margin-left:6px}
#s9bigmap .bmc{position:relative;width:var(--bm-size,600px);height:var(--bm-size,600px);background:rgba(11,13,16,.86);border:1px solid rgba(236,230,216,.22);clip-path:polygon(18px 0,100% 0,100% calc(100% - 18px),calc(100% - 18px) 100%,0 100%,0 18px);box-shadow:0 10px 40px rgba(0,0,0,.6)}
#s9bigmap canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
#s9bigmap .lg{display:flex;flex-wrap:wrap;gap:6px 14px;padding:7px 10px;background:rgba(11,13,16,.9);border:1px solid rgba(236,230,216,.14);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim,#8b9097)}
#s9bigmap .lg i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:-1px}
#s9rdrSec select{font-family:var(--mono);font-size:12px;color:var(--ink);background:#0b0d10;border:1px solid var(--line);padding:7px 8px;min-height:38px}
#s9rdrSec .warn{color:var(--alert,#ff4a3d);font-size:11px;flex-basis:100%;text-align:right}
`;
document.head.appendChild(css);
const el = document.createElement('div'); el.id = 's9radar'; el.hidden = true; el.setAttribute('aria-hidden', 'true');
const vp = document.createElement('div'); vp.className = 'vp'; el.appendChild(vp);   // the map layer: a cached canvas moved by a GPU transform (never re-drawn per frame)
const cv = document.createElement('canvas'); cv.className = 'dyn'; el.appendChild(cv); const ctx = cv.getContext('2d');   // dots only
const meCv = document.createElement('canvas'); meCv.className = 'me'; el.appendChild(meCv);   // your arrow + view cone, drawn once, rotated by a transform
const nEl = document.createElement('b'); nEl.className = 'n'; nEl.textContent = 'N'; el.appendChild(nEl);
const big = document.createElement('div'); big.id = 's9bigmap'; big.hidden = true; big.setAttribute('role', 'dialog'); big.setAttribute('aria-label', 'Map');
big.innerHTML = `<div class="bm"><div class="bmh"><b id="s9bmName">Map</b><span>North up<kbd id="s9bmKey">M</kbd></span></div><div class="bmc"><canvas id="s9bmArt"></canvas><canvas id="s9bmDyn"></canvas></div><div class="lg" id="s9bmLg"></div></div>`;
let mounted = false;
function mount() {
  if (mounted) return true; const hud = $('hud'); if (!hud || !document.body) return false;
  hud.appendChild(el); document.body.appendChild(big); mounted = true; layout(); return true;
}

/* ============ layout: desktop vs phone, size, and the HUD under it ============ */
let isPhone = false, sizeCss = 200, dpr = 1, meKey = '';
function layout() {
  const w = innerWidth, h = innerHeight, L = C.layout;
  isPhone = (matchMedia && matchMedia('(pointer:coarse)').matches) || w <= L.phone.maxWidth || h <= L.phone.maxHeight;
  const P = isPhone ? L.phone : L.desktop;
  sizeCss = P.sizes[SET.size] || P.sizes.medium; dpr = clamp(devicePixelRatio || 1, 1, 3);
  const r = document.documentElement.style;
  r.setProperty('--rdr-size', sizeCss + 'px'); r.setProperty('--rdr-rim', L.rimPx + 'px'); meKey = ''; r.setProperty('--rdr-top', P.top + 'px'); r.setProperty('--rdr-left', P.left + 'px'); r.setProperty('--rdr-gap', L.hudGap + 'px');
  const W = Math.round(sizeCss * dpr); if (cv.width !== W) { cv.width = cv.height = W; coneGrad = null; }
  const side = Math.floor(Math.min(w * C.bigMap.fill, (h - 90) * C.bigMap.fill + 40, 1400)); big.style.setProperty('--bm-size', Math.max(200, side) + 'px');
  bigDirty = true; if (art) art.small = null;
}
addEventListener('resize', () => layout());

/* ============ the map art: built once per map (and per size / zoom / screen density), cached ============ */
let art = null;   // { key, map, navH, nCol, half, pad, small: {cv, ppm}, big: {cv, ppm}, builds }
const STATS = { idleMs: 0, boxTests: 0, builds: 0, buildMs: 0, lastBuildMs: 0, frames: 0, drawn: 0, opsMax: 0, ops: 0, rays: 0, raysWindow: [], fireReveals: 0, spots: 0, tick: new Float32Array(600), tickN: 0, errors: 0 };
function sceneKey(s) { return s.CUR_MAP + '|' + s.HALF; }
function ensureArt(s) {
  const N = s.NAV; if (!s.CUR_MAP || !N || !N.h || !s.world) return false;
  const ld = $('mapload'); if (ld && !ld.hidden) return !!(art && art.small && art.key === sceneKey(s) && art.navH === N.h);   // loading: never build from a half-built level
  const nCol = s.world.colliders.length;
  if (!art || art.navH !== N.h || art.nCol !== nCol || art.key !== sceneKey(s)) {
    art = { key: sceneKey(s), map: s.CUR_MAP, navH: N.h, nCol, half: s.HALF, pad: 2, small: null, big: null, boxes: boxList(s) };
  }
  const t0 = performance.now(); let built = false;
  if (!art.small) { const need = (sizeCss * dpr / 2) / (C.view.range / SET.zoom) * C.art.radarOversample; const ppS = clamp(Math.ceil(need), C.art.ppmMin, C.art.ppmMax); art.small = buildArt(s, ppS, need / C.art.radarOversample / ppS); built = true; }
  if (!art.big) { const side = parseFloat(big.style.getPropertyValue('--bm-size')) || 600; const wantB = side * dpr / (2 * art.half + 2 * art.pad), ppB = clamp(Math.ceil(wantB), C.art.ppmMin, C.art.ppmMax); art.big = buildArt(s, ppB, wantB / ppB); built = true; bigDirty = true; }
  if (built) { STATS.builds++; STATS.lastBuildMs = performance.now() - t0; STATS.buildMs += STATS.lastBuildMs; }
  return true;
}
// collision boxes as a flat array for the cheap sight pre-check (segment vs box), built with the art
function boxList(s) { const c = s.world.colliders, a = new Float32Array(c.length * 6); let n = 0; for (const b of c) { if (!b || !b.min) continue; a.set([b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z], n * 6); n++; } return a.subarray(0, n * 6); }
// true when a collision box cuts the segment a->b (boxes holding an end point are ignored: you stand in / on them)
function boxBlocked(B, ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az; STATS.boxTests++;
  for (let i = 0; i < B.length; i += 6) {
    const x0 = B[i], y0 = B[i + 1], z0 = B[i + 2], x1 = B[i + 3], y1 = B[i + 4], z1 = B[i + 5];
    if ((ax > x0 && ax < x1 && ay > y0 && ay < y1 && az > z0 && az < z1) || (bx > x0 && bx < x1 && by > y0 && by < y1 && bz > z0 && bz < z1)) continue;
    let t0 = .02, t1 = .98;
    if (Math.abs(dx) < 1e-9) { if (ax <= x0 || ax >= x1) continue; } else { let u = (x0 - ax) / dx, w = (x1 - ax) / dx; if (u > w) { const q = u; u = w; w = q; } if (u > t0) t0 = u; if (w < t1) t1 = w; if (t0 > t1) continue; }
    if (Math.abs(dy) < 1e-9) { if (ay <= y0 || ay >= y1) continue; } else { let u = (y0 - ay) / dy, w = (y1 - ay) / dy; if (u > w) { const q = u; u = w; w = q; } if (u > t0) t0 = u; if (w < t1) t1 = w; if (t0 > t1) continue; }
    if (Math.abs(dz) < 1e-9) { if (az <= z0 || az >= z1) continue; } else { let u = (z0 - az) / dz, w = (z1 - az) / dz; if (u > w) { const q = u; u = w; w = q; } if (u > t0) t0 = u; if (w < t1) t1 = w; if (t0 > t1) continue; }
    return true;
  }
  return false;
}
function buildArt(s, ppm, scr) {
  scr = scr || 1;
  const A = C.art, H = s.HALF, pad = 2, span = 2 * H + 2 * pad;
  if (span * ppm > A.maxPx) ppm = A.maxPx / span;
  const W = Math.ceil(span * ppm), c = document.createElement('canvas'); c.width = c.height = W;
  const g = c.getContext('2d'), toW = () => { g.setTransform(ppm, 0, 0, ppm, (H + pad) * ppm, (H + pad) * ppm); };
  const lo = -H - pad, hi = H + pad;
  const inMap = b => b.max.x > lo && b.min.x < hi && b.max.z > lo && b.min.z < hi;
  const rect = (ctx2, b) => { const x0 = Math.max(lo, b.min.x), z0 = Math.max(lo, b.min.z), x1 = Math.min(hi, b.max.x), z1 = Math.min(hi, b.max.z); ctx2.rect(x0, z0, x1 - x0, z1 - z0); };
  // strokes are sized in SCREEN device pixels: `scr` = screen device px per art px (radar art is oversampled, the full map ~1:1)
  const ep = Math.max(1, A.edgePx / scr), lw = ep / ppm;
  toW();
  // the playable ground (mid tone); everything outside it stays the dark void of the radar
  g.fillStyle = A.ground; g.fillRect(-H, -H, 2 * H, 2 * H);
  // hazards (lava / acid / ice pools)
  const FX = s.MAPFX;
  if (FX && FX.hazards) for (const z of FX.hazards) { g.fillStyle = A.hazards[z.kind] || A.hazards.lava; g.fillRect(z.x0, z.z0, z.x1 - z.x0, z.z1 - z.z0); }
  // collision boxes = the real shape of the level (movement collides with exactly these)
  const cols = s.world.colliders.filter(b => b && b.min && inMap(b) && !(!b.walk && b.min.y > A.overheadMinY) && b.max.y > -1);
  const floors = cols.filter(b => b.walk || b.max.y <= A.coverMinY).sort((a, b) => a.max.y - b.max.y);
  const cover = cols.filter(b => !b.walk && b.max.y > A.coverMinY && b.max.y <= A.wallMinY);
  const walls = cols.filter(b => !b.walk && b.max.y > A.wallMinY);
  const lowWalk = floors.filter(b => !(b.walk && b.max.y > A.overheadMinY)), highWalk = floors.filter(b => b.walk && b.max.y > A.overheadMinY);
  // floors: distinct shade per height level (ground / raised / upper / top), dark edge where the level changes
  const lvl = y => A.levels[Math.max(0, Math.min(A.levels.length - 1, Math.floor((y + .2) / A.levelStep)))];
  g.lineWidth = lw; g.strokeStyle = A.floorEdge;
  for (const b of lowWalk) { const L = lvl(b.max.y); if (L === A.ground && b.max.y < .2) continue; g.beginPath(); rect(g, b); g.fillStyle = L; g.fill(); if (L !== A.ground) g.stroke(); }
  // cover (crates, low walls) then walls: each one solid union, outlined only on its outer edge (no seams between neighbouring boxes)
  const solid = (list, fillCol) => {
    if (!list.length) return;
    const m = document.createElement('canvas'); m.width = m.height = W; const mg = m.getContext('2d');
    mg.setTransform(ppm, 0, 0, ppm, (H + pad) * ppm, (H + pad) * ppm); mg.beginPath(); for (const b of list) rect(mg, b); mg.fillStyle = '#fff'; mg.fill();
    const tint = col => { const t = document.createElement('canvas'); t.width = t.height = W; const tg = t.getContext('2d'); tg.drawImage(m, 0, 0); tg.globalCompositeOperation = 'source-in'; tg.fillStyle = col; tg.fillRect(0, 0, W, W); return t; };
    const edge = tint(A.wallEdge), fill = tint(fillCol), o = Math.max(1, Math.round(ep));
    g.setTransform(1, 0, 0, 1, 0, 0);
    for (const [dx, dy] of [[-o, 0], [o, 0], [0, -o], [0, o], [-o, -o], [o, o], [-o, o], [o, -o]]) g.drawImage(edge, dx, dy);
    g.drawImage(fill, 0, 0); toW();
  };
  solid(cover, A.cover); solid(walls, A.wall);
  // catwalks / bridges / sniper decks above the walls: their level shade with a light rim
  g.lineWidth = lw; g.strokeStyle = A.wall;
  for (const b of highWalk) { g.beginPath(); rect(g, b); g.fillStyle = lvl(b.max.y); g.fill(); g.stroke(); }
  // jump pads + teleporters (static: part of the art)
  const CC = C.colors;
  if (FX && FX.pads) for (const p of FX.pads) {
    g.beginPath(); g.arc(p.x, p.z, 1.05, 0, TAU); g.fillStyle = 'rgba(127,231,255,.18)'; g.fill(); g.lineWidth = Math.max(lw * 1.2, .16); g.strokeStyle = CC.pad; g.stroke();
    g.beginPath(); g.moveTo(p.x - .5, p.z + .25); g.lineTo(p.x, p.z - .35); g.lineTo(p.x + .5, p.z + .25); g.lineWidth = Math.max(lw * 1.2, .14); g.stroke();
  }
  if (FX && FX.tele) FX.tele.forEach((t, i) => {
    const col = CC.teleport[i % CC.teleport.length];
    for (const e of [t.a, t.b]) { if (!e || !e.position) continue; const p = e.position;
      g.beginPath(); g.arc(p.x, p.z, 1.2, 0, TAU); g.fillStyle = 'rgba(195,139,255,.16)'; g.fill(); g.lineWidth = Math.max(lw * 1.3, .18); g.strokeStyle = col; g.stroke();
      g.beginPath(); g.arc(p.x, p.z, .45, 0, TAU); g.fillStyle = col; g.fill(); }
  });
  // map border
  g.lineWidth = lw * 1.25; g.strokeStyle = A.wall; g.strokeRect(-H, -H, 2 * H, 2 * H);
  return { cv: c, ppm, W, lo, walls: walls.length, cover: cover.length, floors: floors.length };
}

/* ============ who we are looking from (you, the spectated player, a teammate while dead) ============ */
const MODEx = () => window.MODE || null;
const teamMode = () => { const M = MODEx(); try { return !!(M && M.teamMode && M.teamMode()); } catch (e) { return false; } };
const myTeam = () => { const M = MODEx(); try { return M && M.myTeam ? M.myTeam() : null; } catch (e) { return null; } };
// team of any robot: remote players through MODE.teamOf(netId); offline bots through MODE.teamOfBot(r) (if the offline-modes
// work adds it) or the r.mxTeam / r.team tag
function teamOf(r) {
  if (!teamMode()) return null; const M = MODEx();
  try { if (M.teamOfBot) { const t = M.teamOfBot(r); if (t) return t; } if (r.remote && r.netId != null && M.teamOf) { const t = M.teamOf(r.netId); if (t) return t; } } catch (e) {}
  return r.mxTeam || r.team || null;
}
function myNetId(s) { const M = MODEx(); try { if (M && M.myId) { const id = M.myId(); if (id != null) return id; } } catch (e) {} const R = s.NET && s.NET.room; return R ? R.myId : null; }
function followed(s) {
  const SP = window.SPECTATE;
  if (SP && SP.on) { if (SP.free) return { free: true }; const r = SP.target != null ? s.robots.find(q => q.netId === SP.target) : null; return r ? { r } : null; }
  const M = MODEx(); if (M && M.MX && M.MX.spec && s.state === 'dead') return { r: M.MX.spec };
  return null;
}
const V = { x: 0, z: 0, yaw: 0, team: null, self: null, alive: false, me: false, id: null, eyeY: 0 };
let _eul = null;
function viewer(s) {
  const f = s.state === 'dead' || (window.SPECTATE && SPECTATE.on) ? followed(s) : null;
  if (f && f.free) { const c = s.camera; _eul = _eul || new s.THREE.Euler(); _eul.setFromQuaternion(c.quaternion, 'YXZ'); Object.assign(V, { x: c.position.x, z: c.position.z, yaw: _eul.y, team: null, self: null, alive: false, me: false, id: null, eyeY: c.position.y }); return V; }
  if (f && f.r) { const r = f.r, p = r.root.position; Object.assign(V, { x: p.x, z: p.z, yaw: (r.aimYaw || 0) - Math.PI, team: window.SPECTATE && SPECTATE.on ? teamOf(r) : myTeam(), self: r, alive: !r.dead, me: false, id: r.netId, eyeY: p.y + 1.55 }); return V; }
  const P = s.P; Object.assign(V, { x: P.pos.x, z: P.pos.z, yaw: P.yaw, team: teamMode() ? myTeam() : null, self: null, alive: !P.dead && s.state !== 'dead', me: true, id: myNetId(s), eyeY: P.pos.y + (P.camY || 1.6) });
  return V;
}
function visible(s) {
  if (!SET.on || !art) return false;
  const hud = $('hud'); if (!hud || hud.hidden || hud.classList.contains('kcview') || document.body.classList.contains('kcFinal')) return false;
  const kc = $('killcam'); if (kc && !kc.hidden) return false;
  const st = s.state;
  if (st === 'play' || st === 'paused') return !(window.SPECTATE && SPECTATE.on) || !!followed(s);
  if (st === 'dead') return !!followed(s);   // dead: only while spectating someone (the killcam / death screen own the view)
  return false;
}

/* ============ reveals: firing pings (CoD) + spotting (CS2) ============ */
const RS = new WeakMap();
const rs = r => { let o = RS.get(r); if (!o) { o = { pf: r.firedT || 0, fireT: -1e9, fx: 0, fz: 0, spotT: -1e9, sx: 0, sz: 0, dead: !!r.dead, deadT: -1e9, dx: 0, dz: 0 }; RS.set(r, o); } return o; };
let lastSpot = 0, spotIdx = 0, now = 0;
let _va = null, _vb = null;
function updateReveals(s, v) {
  for (const r of s.robots) {
    const o = rs(r), ft = r.firedT || 0, p = r.root.position;
    if (ft > o.pf + 1e-4 && ft >= 1 && !r.dead) {   // r.firedT jumps up on every shot (bots: botShoot; online: a new `sh` shot sequence)
      const w = r.remote ? r.netW : r.weapon;
      if (!silent.has(w)) { o.fireT = now; o.fx = p.x; o.fz = p.z; STATS.fireReveals++; }
    }
    o.pf = ft;
    if (r.dead && !o.dead) { o.deadT = now; o.dx = p.x; o.dz = p.z; }
    o.dead = !!r.dead;
  }
  if (!v.team || !teamMode()) return;   // spotting is a team-mode thing; free for all = firing pings only
  if (now - lastSpot < 1000 / C.reveal.spotHz) return;
  lastSpot = now;
  const R = C.reveal, range2 = R.spotRange * R.spotRange, half = R.spotFovDeg * Math.PI / 360, cosH = Math.cos(half), LOS = s.lineOfSight;
  if (typeof LOS !== 'function') return;
  _va = _va || new s.THREE.Vector3(); _vb = _vb || new s.THREE.Vector3();
  // observers: the viewer (if alive) + every living teammate, each with their own eyes and view cone
  const obs = [];
  if (v.alive) obs.push({ x: v.x, y: v.eyeY, z: v.z, yaw: v.yaw, r: v.self });
  for (const r of s.robots) if (!r.dead && r !== v.self && teamOf(r) === v.team) { const p = r.root.position; obs.push({ x: p.x, y: p.y + 1.55, z: p.z, yaw: (r.aimYaw || 0) - Math.PI, r }); }
  const foes = s.robots.filter(r => !r.dead && r.root.visible !== false && teamOf(r) !== v.team);
  if (!obs.length || !foes.length) return;
  // cheap part now (view cone, range, collision-box pre-check: microseconds); the real line-of-sight raycasts (~0.5-1.5 ms each)
  // run in the browser's idle time between frames, so they never lengthen a frame
  const n = foes.length; spotIdx = (spotIdx + 1) % n; SPOTQ.length = 0;
  for (let k = 0; k < n && SPOTQ.length < R.maxRaysPerTick; k++) {
    const e = foes[(spotIdx + k) % n], p = e.root.position;
    for (const b of obs) {
      const dx = p.x - b.x, dz = p.z - b.z, d2 = dx * dx + dz * dz; if (d2 > range2 || d2 < 1e-4) continue;
      const d = Math.sqrt(d2), fx = -Math.sin(b.yaw), fz = -Math.cos(b.yaw); if ((dx * fx + dz * fz) / d < cosH) continue;   // outside their view cone
      if (boxBlocked(art.boxes, b.x, b.y, b.z, p.x, p.y + 1.3, p.z)) continue;   // a wall / crate in between: not seen
      SPOTQ.push({ e, r: b.r || null, viewer: !b.r }); break;
    }
  }
  if (SPOTQ.length && !spotSched) { spotSched = true; idle(runSpots); }
}
// idle-time raycasts: positions are read again at the moment of the ray (both ends), so a spot is never older than the check
const SPOTQ = []; let spotSched = false;
const idle = cb => (window.requestIdleCallback ? requestIdleCallback(cb, { timeout: 120 }) : setTimeout(() => cb({ didTimeout: true, timeRemaining: () => 0 }), 16));
function runSpots(dl) {
  spotSched = false; const s = S9(); if (!s || !art || typeof s.lineOfSight !== 'function') { SPOTQ.length = 0; return; }
  const t0 = performance.now(); let rays = 0;
  _va = _va || new s.THREE.Vector3(); _vb = _vb || new s.THREE.Vector3();
  while (SPOTQ.length) {
    if (rays && !(dl && dl.timeRemaining && dl.timeRemaining() > 1.5)) break;   // out of idle time: the rest waits for the next pass
    const q = SPOTQ.shift(), e = q.e; if (e.dead) continue;
    let bx, by, bz;
    if (q.r) { if (q.r.dead) continue; const p = q.r.root.position; bx = p.x; by = p.y + 1.55; bz = p.z; } else { if (!V.alive) continue; bx = V.x; by = V.eyeY; bz = V.z; }
    const p = e.root.position; if (boxBlocked(art.boxes, bx, by, bz, p.x, p.y + 1.3, p.z)) continue;
    rays++; _va.set(bx, by, bz); _vb.set(p.x, p.y + 1.3, p.z);
    if (s.lineOfSight(_va, _vb)) { const o = rs(e); o.spotT = performance.now(); o.sx = p.x; o.sz = p.z; STATS.spots++;
      if (trace) { SPOTLOG.push({ foe: e.name, by: q.r ? q.r.name : 'viewer', from: [bx, by, bz].map(v => +v.toFixed(2)), to: [p.x, p.y + 1.3, p.z].map(v => +v.toFixed(2)) }); if (SPOTLOG.length > 50) SPOTLOG.shift(); } }
  }
  const t = performance.now(); STATS.rays += rays; STATS.idleMs += t - t0; STATS.raysWindow.push(t, rays); while (STATS.raysWindow.length > 2 && STATS.raysWindow[0] < t - 1000) STATS.raysWindow.splice(0, 2);
  if (SPOTQ.length && !spotSched) { spotSched = true; idle(runSpots); }
}

/* ============ drawing ============ */
let coneGrad = null, coneGradR = 0, bigDirty = true, bigOpen = false;
const SPLIT = [0, 0, 0, 0, 0], TRACE = [], SPOTLOG = [], TICKBIG = new Uint8Array(600); let trace = false, lastBigDraw = -1e9, lastFull = 0, lastVis = null;
let recBig = false;
function rec(k, wx, wz, x, y, extra) { if (!trace) return; TRACE.push(Object.assign({ k, big: recBig, wx: +wx.toFixed(2), wz: +wz.toFixed(2), x: +x.toFixed(1), y: +y.toFixed(1) }, extra || {})); }
function arrow(g, x, y, ang, size, fill, stroke) {
  g.save(); g.translate(x, y); g.rotate(ang); g.beginPath(); g.moveTo(0, -size); g.lineTo(size * .72, size * .78); g.lineTo(0, size * .36); g.lineTo(-size * .72, size * .78); g.closePath();
  g.lineJoin = 'round'; g.lineWidth = Math.max(1.5, size * .28); g.strokeStyle = stroke; g.stroke(); g.fillStyle = fill; g.fill(); g.restore(); STATS.ops++;
}
function dot(g, x, y, r, fill, stroke, lw, alpha) { g.globalAlpha = alpha == null ? 1 : alpha; g.beginPath(); g.arc(x, y, r, 0, TAU); if (stroke) { g.lineWidth = lw; g.strokeStyle = stroke; g.stroke(); } if (fill) { g.fillStyle = fill; g.fill(); } g.globalAlpha = 1; STATS.ops++; }
function bombIcon(g, x, y, s, col, pulse) {
  if (pulse) dot(g, x, y, s * (1.3 + .5 * pulse), null, col, Math.max(1, s * .22), .8 - .6 * pulse);
  g.save(); g.translate(x, y); g.fillStyle = '#0b0d10'; g.fillRect(-s * .9 - 1, -s * .6 - 1, s * 1.8 + 2, s * 1.2 + 2); g.fillStyle = col; g.fillRect(-s * .9, -s * .6, s * 1.8, s * 1.2);
  g.fillStyle = '#0b0d10'; g.fillRect(-s * .5, -s * .25, s * .6, s * .5); g.restore(); STATS.ops++;
}
function siteMark(g, x, y, s, id) {
  dot(g, x, y, s, 'rgba(255,154,60,.16)', C.colors.site, Math.max(1, s * .12));
  g.font = `800 ${Math.round(s * 1.25)}px ${fontD()}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = Math.max(2, s * .2); g.strokeStyle = '#0b0d10'; g.strokeText(id, x, y + s * .06); g.fillStyle = C.colors.site; g.fillText(id, x, y + s * .06); STATS.ops++;
}
const fontCache = {};
const cssVar = (k, d) => (getComputedStyle(document.documentElement).getPropertyValue(k) || '').trim() || d;
const fontD = () => fontCache.d || (fontCache.d = cssVar('--display', 'Impact, sans-serif'));
const fontM = () => fontCache.m || (fontCache.m = cssVar('--mono', 'monospace'));
function bombState(s) {
  const M = MODEx(); if (!M || !M.MX) return null; let demo = false;
  try { demo = (M.demo && M.demo()) || (M.mode && M.mode() === 'demo' && teamMode()); } catch (e) {}
  if (!demo) return null; return { B: M.MX.bomb || null, sites: (M.layout && M.layout() && M.layout().sites) || [] };
}
// what to draw this frame (shared by the radar and the full map): pure data, no drawing
const ENT = [];
function collect(s, v) {
  ENT.length = 0; const R = C.reveal, CC = C.colors, tm = teamMode() && !!v.team, fr2 = R.fireRange * R.fireRange;
  for (const r of s.robots) {
    if (r === v.self) continue;
    const o = rs(r), p = r.root.position, t = tm ? teamOf(r) : null, ally = tm && t === v.team;
    if (ally) {
      if (!r.dead) ENT.push({ k: 'ally', r, x: p.x, z: p.z, yaw: (r.aimYaw || 0) - Math.PI, col: CC.teams[t] || CC.ffaAlly, name: r.name });
      else if (now - o.deadT < R.deadAllyMs) ENT.push({ k: 'deadAlly', r, x: o.dx, z: o.dz, col: CC.teams[t] || CC.ffaAlly });
      continue;
    }
    if (r.dead) continue;
    // enemy (or anyone, in free for all): only when revealed
    if (tm && now - o.spotT < R.spotHoldMs) { ENT.push({ k: 'enemy', r, x: o.sx, z: o.sz, a: 1 }); continue; }   // where they were SEEN (never follows them out of sight)
    const fa = now - o.fireT;
    if (fa < R.fireMs && (o.fx - v.x) ** 2 + (o.fz - v.z) ** 2 <= fr2) { ENT.push({ k: 'fire', r, x: o.fx, z: o.fz, a: fa < R.fireMs - R.fireFadeMs ? 1 : (R.fireMs - fa) / R.fireFadeMs }); continue; }
    if (tm && now - o.spotT < R.lastSeenMs) ENT.push({ k: 'ghost', r, x: o.sx, z: o.sz, a: 1 - (now - o.spotT) / R.lastSeenMs });
  }
  const bs = bombState(s);
  if (bs) {
    for (const st of bs.sites) ENT.push({ k: 'site', x: st.x, z: st.z, id: st.id });
    const B = bs.B, vis = who => who === 'all' || (v.team && who === v.team);
    if (B && B.s === 'carried' && vis(C.bomb.carriedVisibleTo)) {
      if (B.c != null && B.c === v.id) ENT.push({ k: 'bomb', s: 'carried', x: v.x, z: v.z, self: true });
      else { const c = s.robots.find(q => !q.dead && (q.netId === B.c || (q.netId == null && q.name === B.c))); if (c && teamOf(c) === v.team) ENT.push({ k: 'bomb', s: 'carried', x: c.root.position.x, z: c.root.position.z }); }
    } else if (B && B.s === 'dropped' && B.p && vis(C.bomb.droppedVisibleTo)) ENT.push({ k: 'bomb', s: 'dropped', x: B.p[0], z: B.p[2] });
    else if (B && B.s === 'planted' && B.p && vis(C.bomb.plantedVisibleTo)) ENT.push({ k: 'bomb', s: 'planted', x: B.p[0], z: B.p[2], site: B.site });
    else if (B && B.s === 'defused' && B.p) { if (!B.__rdrT) B.__rdrT = now; if (now - B.__rdrT < C.bomb.defusedMs) ENT.push({ k: 'bomb', s: 'defused', x: B.p[0], z: B.p[2] }); }
  }
  return ENT;
}
// draw markers. proj(wx, wz) -> [x, y] in device px; rot = map rotation; sc = device px per CSS px marker scale
const _pp = [0, 0];
const LABELS = [];
function drawMarkers(g, v, proj, rot, unit, R, names) {
  LABELS.length = 0;
  const CC = C.colors, t = now / 1000;
  const inside = (x, y) => R == null || x * x + y * y <= (R - unit * 3) * (R - unit * 3);
  const edge = (x, y) => { const d = Math.hypot(x, y), m = R - unit * 4; return d > m ? [x / d * m, y / d * m, true] : [x, y, false]; };
  // sites under everything else
  for (const e of ENT) if (e.k === 'site') { const [x, y] = proj(e.x, e.z); siteMark(g, x, y, unit * 5.2, e.id); rec('site', e.x, e.z, x, y, { id: e.id }); }
  for (const e of ENT) if (e.k === 'deadAlly') { const [x, y] = proj(e.x, e.z); if (!inside(x, y)) continue; const a = unit * 2.6; g.beginPath(); g.moveTo(x - a, y - a); g.lineTo(x + a, y + a); g.moveTo(x + a, y - a); g.lineTo(x - a, y + a); g.lineWidth = unit * 1.3; g.strokeStyle = e.col; g.globalAlpha = .8; g.stroke(); g.globalAlpha = 1; STATS.ops++; rec('deadAlly', e.x, e.z, x, y); }
  for (const e of ENT) if (e.k === 'bomb' && !e.self) {
    let [x, y] = proj(e.x, e.z), cl = false; if (R != null) [x, y, cl] = edge(x, y);
    const col = e.s === 'planted' ? CC.bombPlanted : e.s === 'defused' ? CC.bombDefused : CC.bomb, pulse = e.s === 'planted' ? (t * 1.6) % 1 : 0;
    if (e.s === 'dropped' && Math.floor(t * 2.5) % 2) g.globalAlpha = .55;
    if (e.s !== 'carried') bombIcon(g, x, y, unit * 3.2, col, pulse); g.globalAlpha = 1; rec('bomb', e.x, e.z, x, y, { s: e.s, edge: cl });
  }
  for (const e of ENT) if (e.k === 'ghost' || e.k === 'fire' || e.k === 'enemy') {
    const [x, y] = proj(e.x, e.z); if (!inside(x, y)) continue;
    if (e.k === 'ghost') dot(g, x, y, unit * 2.4, null, CC.enemy, unit * 1.1, e.a * .8);
    else { if (e.k === 'fire') dot(g, x, y, unit * (2.6 + 3 * (1 - e.a)), null, CC.enemy, unit * .8, e.a * .45); dot(g, x, y, unit * 2.6, CC.enemy, CC.meOutline, unit * 1.1, e.a); }
    rec(e.k, e.x, e.z, x, y, { id: e.r && (e.r.netId != null ? e.r.netId : e.r.name) });
  }
  for (const e of ENT) if (e.k === 'ally') {
    let [x, y] = proj(e.x, e.z), cl = false; if (R != null) { if (C.view.edgeClampAllies) [x, y, cl] = edge(x, y); else if (!inside(x, y)) continue; }
    arrow(g, x, y, rot - e.yaw, unit * (cl ? 3.2 : 4), e.col, CC.meOutline);
    const carrying = ENT.some(b => b.k === 'bomb' && b.s === 'carried' && !b.self && Math.abs(b.x - e.x) < .01 && Math.abs(b.z - e.z) < .01);
    if (carrying) bombIcon(g, x + unit * 4.2, y - unit * 4.2, unit * 2.2, CC.bomb, 0);
    if (names && e.name) {   // names on the full map; labels that would overlap step down a line
      g.font = `600 ${Math.round(unit * 4.4)}px ${fontM()}`; g.textAlign = 'center'; g.textBaseline = 'top';
      const w = g.measureText(e.name).width, h = unit * 5.4; let ly = y + unit * 5;
      for (let k = 0; k < 4 && LABELS.some(L => Math.abs(L[0] - x) < (L[2] + w) / 2 && Math.abs(L[1] - ly) < h); k++) ly += h;
      LABELS.push([x, ly, w]);
      g.lineWidth = unit * 1.2; g.strokeStyle = 'rgba(0,0,0,.85)'; g.strokeText(e.name, x, ly); g.fillStyle = e.col; g.fillText(e.name, x, ly); STATS.ops++; }
    rec('ally', e.x, e.z, x, y, { edge: cl, id: e.r.netId != null ? e.r.netId : e.r.name, carrying });
  }
}
function viewerMark(g, v, x, y, rot, unit, coneR, s) {
  // view cone (horizontal field of view of the real camera)
  const cam = s.camera, hfov = 2 * Math.atan(Math.tan((cam.fov || 78) * Math.PI / 360) * (cam.aspect || 1.7)), half = C.view.coneDeg ? C.view.coneDeg * Math.PI / 360 : Math.min(hfov / 2, 1.2);
  const dir = rot - v.yaw - Math.PI / 2;
  if (!coneGrad || coneGradR !== coneR || coneGrad.__x !== x || coneGrad.__y !== y) { coneGrad = g.createRadialGradient(x, y, 0, x, y, coneR); coneGrad.addColorStop(0, C.colors.cone); coneGrad.addColorStop(1, 'rgba(236,230,216,0)'); coneGrad.__x = x; coneGrad.__y = y; coneGradR = coneR; }
  g.beginPath(); g.moveTo(x, y); g.arc(x, y, coneR, dir - half, dir + half); g.closePath(); g.fillStyle = coneGrad; g.fill(); STATS.ops++;
  const tm = teamMode() && v.team, col = tm ? (C.colors.teams[v.team] || C.colors.me) : C.colors.me;
  arrow(g, x, y, rot - v.yaw, unit * 5, C.colors.me, tm ? col : C.colors.meOutline);
  const me = ENT.find(e => e.k === 'bomb' && e.self); if (me) { bombIcon(g, x + unit * 5, y + unit * 5, unit * 2.4, C.colors.bomb, 0); rec('bomb', v.x, v.z, x, y, { s: 'carried', self: true }); }
}
let lastRot = 0, lastArrow = 0;
let lastMapT = '', lastNT = '', lastMeT = '', dynEmpty = false;
// your arrow + view cone (horizontal field of view of the real camera): drawn once, then only rotated by a transform
function drawMe(v, s, coneR) {
  const tm = teamMode() && v.team, stroke = tm ? (C.colors.teams[v.team] || C.colors.me) : C.colors.meOutline, cam = s.camera;
  const hfov = 2 * Math.atan(Math.tan((cam.fov || 78) * Math.PI / 360) * (cam.aspect || 1.7)), half = C.view.coneDeg ? C.view.coneDeg * Math.PI / 360 : Math.min(hfov / 2, 1.2);
  const key = [stroke, coneR.toFixed(1), half.toFixed(3), dpr, sizeCss].join('|'); if (key === meKey) return; meKey = key;
  const side = Math.ceil(coneR * 2 + 4), u = Math.max(.75, sizeCss / 200);
  meCv.width = meCv.height = Math.round(side * dpr); meCv.style.width = meCv.style.height = side + 'px'; meCv.style.marginLeft = meCv.style.marginTop = (-side / 2) + 'px';
  const g = meCv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, side * dpr / 2, side * dpr / 2); g.clearRect(-side, -side, side * 2, side * 2);
  const gr = g.createRadialGradient(0, 0, 0, 0, 0, coneR); gr.addColorStop(0, C.colors.cone); gr.addColorStop(1, 'rgba(236,230,216,0)');
  g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, coneR, -Math.PI / 2 - half, -Math.PI / 2 + half); g.closePath(); g.fillStyle = gr; g.fill();
  arrow(g, 0, 0, 0, u * 5, C.colors.me, stroke);
}
function drawRadar(s, v) {
  const Rc = sizeCss / 2 - C.layout.rimPx, range = C.view.range / SET.zoom, cssPpm = Rc / range, rot = SET.rotate ? v.yaw : 0;
  lastRot = rot; lastArrow = rot - v.yaw;
  // the map: the cached canvas itself, moved + turned by a GPU transform (no per-frame drawing)
  const A = art.small;
  if (A.cv.parentNode !== vp) { vp.textContent = ''; A.cv.className = 'map'; A.cv.style.width = A.cv.style.height = A.W + 'px'; vp.appendChild(A.cv); lastMapT = ''; }
  const k = cssPpm / A.ppm, mt = `translate(${Rc.toFixed(2)}px,${Rc.toFixed(2)}px) rotate(${rot.toFixed(4)}rad) translate(${((A.lo - v.x) * cssPpm).toFixed(2)}px,${((A.lo - v.z) * cssPpm).toFixed(2)}px) scale(${k.toFixed(5)})`;
  if (mt !== lastMapT) { A.cv.style.transform = mt; lastMapT = mt; }
  const c = Math.cos(rot), sn = Math.sin(rot), nr = Rc - sizeCss * .07;
  const nt = `translate(-50%,-50%) translate(${(sn * nr).toFixed(1)}px,${(-c * nr).toFixed(1)}px)`; if (nt !== lastNT) { nEl.style.transform = nt; lastNT = nt; }
  drawMe(v, s, Rc * C.view.coneLen * 2);
  const at = `rotate(${lastArrow.toFixed(4)}rad)`; if (at !== lastMeT) { meCv.style.transform = at; lastMeT = at; }
  // dots: a small 2D canvas, cleared + drawn only when there is something to show
  const W = cv.width, has = ENT.length > 0;
  if (!has && dynEmpty) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, W); STATS.ops++; dynEmpty = !has; if (!has) return;
  const R = Rc * dpr, ppm = cssPpm * dpr, unit = dpr * Math.max(.75, sizeCss / 200);
  const proj = (wx, wz) => { const dx = (wx - v.x) * ppm, dz = (wz - v.z) * ppm; _pp[0] = dx * c - dz * sn; _pp[1] = dx * sn + dz * c; return _pp; };
  ctx.save(); ctx.beginPath(); ctx.arc(W / 2, W / 2, R, 0, TAU); ctx.clip(); ctx.translate(W / 2, W / 2);
  drawMarkers(ctx, v, proj, rot, unit, R, false);
  if (ENT.some(e => e.k === 'bomb' && e.self)) { bombIcon(ctx, unit * 5, unit * 5, unit * 2.4, C.colors.bomb, 0); rec('bomb', v.x, v.z, 0, 0, { s: 'carried', self: true }); }
  ctx.restore();
}
function drawBig(s, v) {
  const a = $('s9bmArt'), d = $('s9bmDyn'); if (!a || !d) return;
  const side = Math.round((parseFloat(big.style.getPropertyValue('--bm-size')) || 600) * dpr);
  if (a.width !== side) { a.width = a.height = d.width = d.height = side; bigDirty = true; }
  const A = art.big, span = 2 * art.half + 2 * art.pad, ppm = side / span;
  if (bigDirty) { const g = a.getContext('2d'); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, side, side); g.imageSmoothingQuality = 'high'; g.drawImage(A.cv, 0, 0, side, side); bigDirty = false;
    const def = (s.MAPS || []).find(m => m.id === s.CUR_MAP); $('s9bmName').textContent = def ? def.name : s.CUR_MAP; $('s9bmKey').textContent = keyLabel(SET.key); legend(s); }
  const g = d.getContext('2d'); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, side, side);
  const proj = (wx, wz) => { _pp[0] = (wx - A.lo) * ppm; _pp[1] = (wz - A.lo) * ppm; return _pp; };
  const unit = dpr * clamp(side / dpr / 520, .9, 1.6);
  recBig = true;
  try { drawMarkers(g, v, proj, 0, unit, null, true); const [x, y] = proj(v.x, v.z); viewerMark(g, v, x, y, 0, unit, unit * 60, s); } finally { recBig = false; }
  coneGrad = null;   // the radar's cone gradient is positioned for the radar canvas
}
function legend(s) {
  const CC = C.colors, tm = teamMode(), t = myTeam(), bs = bombState(s), items = [[CC.me, 'You'], ...(tm && t ? [[CC.teams[t], 'Team']] : []), [CC.enemy, tm ? 'Enemy (seen / firing)' : 'Enemy (firing)'], [CC.pad, 'Jump pad'], [CC.teleport[0], 'Teleporter'], ...(bs ? [[CC.site, 'Bomb site'], [CC.bomb, 'Charge']] : [])];
  $('s9bmLg').innerHTML = items.map(([c, l]) => `<span><i style="background:${c}"></i>${l}</span>`).join('');
}
function keyLabel(code) { try { if (window.S9Settings && S9Settings.keyName) return S9Settings.keyName(code, true); } catch (e) {} return code.replace(/^Key/, ''); }

/* ============ frame ============ */
function frame() {
  const s = S9(); if (!s || !mount()) return;
  now = performance.now(); STATS.ops = 0; if (trace) TRACE.length = 0;
  if (!ensureArt(s)) { el.hidden = true; if (bigOpen) setBig(false); return; }
  const vis = visible(s);
  document.body.classList.toggle('s9radar', vis);
  if (el.hidden === vis) el.hidden = !vis;
  if (!vis) { if (bigOpen) setBig(false); return; }
  // the minimap refreshes at ~30 Hz (every 2nd frame at 60 fps, every 4th at 144): half the work, same look; test mode (trace) and a dirty big map always draw
  if (!trace && !bigDirty && lastFull > 0 && now - lastFull < 24 && lastVis === vis) return;
  lastFull = now; lastVis = vis;
  const v = viewer(s);
  const t1 = performance.now(); updateReveals(s, v); const t2 = performance.now();
  collect(s, v); const t3 = performance.now();
  drawRadar(s, v); const t4 = performance.now();
  SPLIT[0] += t2 - t1; SPLIT[1] += t3 - t2; SPLIT[2] += t4 - t3; SPLIT[3]++;
  if (bigOpen && (bigDirty || trace || now - lastBigDraw >= 66)) { const tb = performance.now(); drawBig(s, v); lastBigDraw = now; SPLIT[4] += performance.now() - tb; }   // full map: markers at ~15 Hz are plenty (it does not turn), saves most of its per-frame cost
  STATS.frames++; STATS.drawn++; if (STATS.ops > STATS.opsMax) STATS.opsMax = STATS.ops;
}
function loop() {
  const t0 = performance.now();
  try { frame(); } catch (e) { STATS.errors++; if (STATS.errors < 4) console.warn('[radar]', e); }
  TICKBIG[STATS.tickN % STATS.tick.length] = bigOpen ? 1 : 0; STATS.tick[STATS.tickN++ % STATS.tick.length] = performance.now() - t0;
  requestAnimationFrame(loop);
}
// build the map art while the loading screen is still up (before the first match frame), not in the first frame of play
if (typeof loadMap === 'function') { const _lm = loadMap; loadMap = async function () { const r = await _lm.apply(this, arguments); try { const s = S9(); if (s) { mount(); ensureArt(s); } } catch (e) {} return r; }; }

/* ============ full map (M, toggle) ============ */
function setBig(on) {
  on = !!on; if (on === bigOpen) return; bigOpen = on; big.hidden = !on; bigDirty = true;
  if (on) { const s = S9(); if (s && art) { const v = viewer(s); collect(s, v); drawBig(s, v); } }
}
function canOpenBig() { const s = S9(); return !!(s && art && visible(s)); }
addEventListener('keydown', e => {
  if (e.code !== SET.key || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (!bigOpen && !canOpenBig()) return;
  e.preventDefault(); setBig(!bigOpen);
}, true);

/* ============ Settings > Gameplay > Radar (injected into the settings panel; see radar.INTEGRATE.md for the native hook) ============ */
function boundElsewhere(code) { try { const b = window.S9Settings && S9Settings.get().controls.binds; if (!b) return null; for (const id in b) if (b[id].includes(code)) { const a = S9Settings.ACTIONS.find(x => x.id === id); return a ? a.label : id; } } catch (e) {} return null; }
function secHTML() {
  const sw = (k, lab, help) => `<div class="s9s-row"><div class="s9s-lab"><b id="l-rdr-${k}">${lab}</b><span>${help}</span></div><div class="s9s-ctl"><span class="s9s-swl">${SET[k] ? 'On' : 'Off'}</span><button class="s9s-sw" role="switch" aria-labelledby="l-rdr-${k}" aria-checked="${SET[k]}" data-rdr-sw="${k}"></button></div></div>`;
  const seg = (k, lab, help, opts) => `<div class="s9s-row"><div class="s9s-lab"><b id="l-rdr-${k}">${lab}</b><span>${help}</span></div><div class="s9s-ctl"><div class="s9s-seg" role="radiogroup" aria-labelledby="l-rdr-${k}">${opts.map(([v, l]) => `<button role="radio" aria-checked="${String(SET[k]) === String(v)}" data-rdr-seg="${k}" data-val="${v}">${l}</button>`).join('')}</div></div></div>`;
  const taken = boundElsewhere(SET.key);
  return `<section class="s9s-sec" id="s9rdrSec"><h3>Radar</h3>` +
    sw('on', 'Radar', 'The round minimap in the top left. Enemies only show when they fire or a teammate sees them.') +
    seg('size', 'Radar size', 'Phones use a smaller radar that stays clear of the touch controls.', [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']]) +
    seg('rotate', 'Orientation', 'Rotate: the map turns so your view is always up (CS / CoD default). North up: the map stays fixed and your arrow turns.', [['true', 'Rotate'], ['false', 'North up']]) +
    `<div class="s9s-row"><div class="s9s-lab"><b id="l-rdr-zoom">Zoom</b><span>Higher shows a smaller area in more detail.</span></div><div class="s9s-ctl"><input type="range" aria-labelledby="l-rdr-zoom" data-rdr-zoom min="${C.view.zoomMin}" max="${C.view.zoomMax}" step="0.05" value="${SET.zoom}"><span class="s9s-swl" id="s9rdrZv">${SET.zoom.toFixed(2)}×</span></div></div>` +
    `<div class="s9s-row"><div class="s9s-lab"><b id="l-rdr-key">Full map key</b><span>Opens the big map (press again to close).</span></div><div class="s9s-ctl"><select aria-labelledby="l-rdr-key" data-rdr-key>${C.bigMap.keyChoices.map(k => `<option value="${k}"${k === SET.key ? ' selected' : ''}>${keyLabel(k)}</option>`).join('')}</select>${taken ? `<span class="warn">Also used by "${taken}" in Controls: that action wins. Pick another key.</span>` : ''}</div></div>` +
    `</section>`;
}
function settingsRoot() { return $('s9set'); }
function injectSettings() {
  const root = settingsRoot(); if (!root) return; const tb = root.querySelector('.s9s-tab[aria-selected="true"]'), inner = root.querySelector('.s9s-inner');
  if (!tb || !inner || tb.dataset.tab !== 'gameplay' || inner.querySelector('#s9rdrSec')) return;
  inner.insertAdjacentHTML('beforeend', secHTML()); const sec = inner.querySelector('#s9rdrSec');
  sec.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; e.stopPropagation();
    if (b.dataset.rdrSw) setOpt(b.dataset.rdrSw, !SET[b.dataset.rdrSw]);
    else if (b.dataset.rdrSeg) setOpt(b.dataset.rdrSeg, b.dataset.rdrSeg === 'rotate' ? b.dataset.val === 'true' : b.dataset.val); });
  sec.addEventListener('input', e => { if (e.target.dataset.rdrZoom !== undefined) { e.stopPropagation(); setOpt('zoom', +e.target.value); } });
  sec.addEventListener('change', e => { e.stopPropagation(); if (e.target.dataset.rdrKey !== undefined) { setOpt('key', e.target.value); } });
}
function refreshSettingsUi() {
  const root = settingsRoot(), sec = root && root.querySelector('#s9rdrSec'); if (!sec) return;
  const z = sec.querySelector('[data-rdr-zoom]'), focusZ = document.activeElement === z;
  if (!focusZ) { sec.outerHTML = ''; injectSettings(); } else { const zv = $('s9rdrZv'); if (zv) zv.textContent = SET.zoom.toFixed(2) + '×'; }
}
let obs = null;
function hookSettings() {
  const root = settingsRoot(), inner = root && root.querySelector('.s9s-inner');
  if (!inner) { if (hookSettings.n = (hookSettings.n || 0) + 1, hookSettings.n < 600) setTimeout(hookSettings, 500); return; }
  obs = new MutationObserver(() => injectSettings()); obs.observe(inner, { childList: true }); injectSettings();
}

/* ============ API (tests, other modules, Unity port notes) ============ */
window.S9Radar = {
  ver: 1,
  get cfg() { return clone(C); }, DEF: clone(DEF),
  settings: () => clone(SET), set: (k, v) => setOpt(k, v),
  open: () => setBig(true), close: () => setBig(false), isOpen: () => bigOpen,
  stats: () => { const n = Math.min(STATS.tickN, STATS.tick.length), a = Array.from(STATS.tick.slice(0, n)).sort((x, y) => x - y);
    let rps = 0; for (let i = 1; i < STATS.raysWindow.length; i += 2) rps += STATS.raysWindow[i];
    return { idleMs: +STATS.idleMs.toFixed(2), boxTests: STATS.boxTests, builds: STATS.builds, buildMs: +STATS.buildMs.toFixed(2), lastBuildMs: +STATS.lastBuildMs.toFixed(2), frames: STATS.frames, opsMax: STATS.opsMax, ops: STATS.ops, rays: STATS.rays, raysLastSecond: rps, fireReveals: STATS.fireReveals, spots: STATS.spots, errors: STATS.errors,
      tickAvg: n ? +(a.reduce((x, y) => x + y, 0) / n).toFixed(4) : 0, tickP99: n ? +a[Math.min(n - 1, Math.floor(n * .99))].toFixed(4) : 0, tickN: n, top: Array.from(STATS.tick.slice(0, n)).map((t, i) => [+t.toFixed(2), TICKBIG[i]]).sort((x, y) => y[0] - x[0]).slice(0, 6), bigAvg: +(SPLIT[4] / Math.max(1, SPLIT[3])).toFixed(4) }; },
  split: () => SPLIT.slice(0, 3).map(x => +(x / Math.max(1, SPLIT[3])).toFixed(4)),
  resetStats: () => { SPLIT.fill(0); STATS.boxTests = 0; STATS.idleMs = 0; STATS.tick.fill(0); STATS.tickN = 0; STATS.opsMax = 0; STATS.rays = 0; STATS.fireReveals = 0; STATS.spots = 0; },
  set trace(on) { trace = !!on; }, get trace() { return trace; },
  debug: () => { const s = S9(); return { visible: !el.hidden, phone: isPhone, size: sizeCss, dpr, rot: lastRot, arrowRot: lastArrow, rotate: SET.rotate, zoom: SET.zoom,
    viewer: { x: V.x, z: V.z, yaw: V.yaw, team: V.team, me: V.me, id: V.id }, art: art ? { map: art.map, half: art.half, small: art.small && { W: art.small.W, ppm: art.small.ppm, walls: art.small.walls, cover: art.small.cover, floors: art.small.floors }, big: art.big && { W: art.big.W, ppm: art.big.ppm } } : null,
    marks: TRACE.slice(), spots: SPOTLOG.slice(), bigOpen, cur: s && s.CUR_MAP }; },
  // world -> radar CSS px relative to the radar centre (uses the current viewer + rotation)
  project: (wx, wz) => { const R = (cv.width / 2 - C.layout.rimPx * dpr) / dpr, ppm = R / (C.view.range / SET.zoom), rot = lastRot, dx = (wx - V.x) * ppm, dz = (wz - V.z) * ppm; return [dx * Math.cos(rot) - dz * Math.sin(rot), dx * Math.sin(rot) + dz * Math.cos(rot)]; },
  artCanvas: which => art && art[which || 'small'] ? art[which || 'small'].cv : null,
  rebuild: () => { art = null; }
};
function boot() { if (!S9() || !document.body) { setTimeout(boot, 100); return; } mount(); layout(); hookSettings(); requestAnimationFrame(loop); }
boot();
})();
