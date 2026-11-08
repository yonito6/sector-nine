/* Sector Nine · KILLCAM v2 (modules/killcam.js)
   Replays the last seconds before you died from your killer's own eyes, the way CoD / CS:GO "killer replay" /
   Overwatch do it: their camera and real view angles (smoothly interpolated, no jitter), their weapon in their hands
   (hip or aimed down sights, scope overlay when they scoped in, recoil, muzzle flash, tracers from their muzzle),
   their crosshair and hitmarkers when a shot hit you, you (and everyone else) walking exactly as recorded, slow motion
   on the final shot, a banner with the killer's name, weapon, HP left and headshot tag. SPACE (or the button) skips.
   Loaded after the main game script; it hooks the game by wrapping its global functions (see killcam.INTEGRATE.md).
   Everything is recorded on YOUR machine: bots = their AI state every frame, online players = the states they send
   (plus a few extra fields this module adds to what you send: aim-down-sights amount, reload/knife progress, exact
   weapon, high-precision view angles). Nothing here can change health, scores or the match. */
(() => {
'use strict';
if (window.S9KC) return;
const KC = window.S9KC = { ver: 3, clip: null, log: null, errors: 0 };

/* ---------- tuning (the Unity port can read these from killcam.INTEGRATE.md) ---------- */
const RS = 5.5;          // respawn delay while a killcam runs: index.html frame loop `const RS = REC.on ? 5.5 : 4.7` (we never extend it)
const DCT = .85;         // you see your own body start to fall this long before the killcam takes over (CoD-style quick cut)
const SLOW = .35;        // slow motion speed on the final shot
const SLOW_PRE = .6;     // ...for this many replay-seconds before the death
const POST = .4;         // replay-seconds shown after the killing shot (you go down, the killer keeps moving)
const END_PAD = .12;     // the killcam finishes this long before the respawn
const FINAL_SLOWMO = 1000;   // ms of live slow motion on the match-winning kill before the final killcam cuts in (CoD / Valorant style)
const FINAL_LEN = 5.2;    // the final killcam (match-winning kill, shown to everyone at match end) runs this long
const HIST = 7.5;        // seconds of history kept (the killcam uses ~3-4 s of it; the rest covers long slow frames)
const HZ = 60;           // fixed recording tick: every actor is sampled on the same 1/60 s grid (frames in between are interpolated)
const S_ = 19;           // numbers per recorded sample:
// 0 x,1 y,2 z,3 aimYaw,4 aimPitch,5 crouch,6 ads,7 reload 0-1 (-1 none),8 weapon index,9 on ground,10 alert,11 dead,
// 12 dead time,13 visible,14 body yaw,15 knife swing 0-1 (-1 none),16 hp,17 sprinting (1) / silent walk (2),18 eye height above the feet
const ANGLE = [3, 14], DISCRETE = [8, 9, 10, 11, 13, 17];
// kills that are replayed as a third-person orbit around the blast instead of the killer's eyes
const BLAST = new Set(['nade', 'nova', 'seeker', 'charge']);
const R = { spawns: [], hitLog: [], tracks: new Map(), shots: [], fires: [], hits: [], throws: [], booms: [], kills: [], proj: [], projHad: false, lastT: -1, n: 0, cur: null, death: null, pid: new WeakMap(), pidN: 0 };
let WIDS = null; const widx = w => { if (!WIDS) WIDS = Object.keys(WEAPONS); const i = WIDS.indexOf(w); return i < 0 ? 0 : i; }, wname = i => (WIDS || Object.keys(WEAPONS))[i | 0] || 'carbine';
const hasW = w => typeof w === 'string' && Object.prototype.hasOwnProperty.call(WEAPONS, w);
const smooth = x => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
const V = new Float64Array(S_), SA = new Float64Array(S_), SB = new Float64Array(S_);
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const warnOnce = (e) => { KC.errors++; if (KC.errors < 4) console.warn('[killcam]', e); };

/* ================= recording ================= */
function trk(ent) { let t = R.tracks.get(ent); if (!t) { t = { ent, t: [], v: [] }; R.tracks.set(ent, t); } return t; }
function pushS(tr, t, vals) { tr.t.push(t); for (let i = 0; i < S_; i++) tr.v.push(vals[i]); }
// fixed-tick recorder: the frame's values land on the 1/HZ grid, interpolated from the previous frame (angles the short
// way round, on/off fields from the nearer frame, teleports/respawns never interpolated)
const VI = new Float64Array(S_);
function tick(ent, vals, t) {
  const tr = trk(ent);
  if (!tr.prev || t - tr.prevT > .5 || t < tr.prevT) { tr.prev = tr.prev || new Float64Array(S_); tr.prev.set(vals); tr.prevT = t; tr.k = Math.floor(t * HZ) + 1; pushS(tr, t, vals); return; }
  const a0 = tr.prev, span = t - tr.prevT, jump = (vals[0] - a0[0]) ** 2 + (vals[2] - a0[2]) ** 2 > 9 || vals[11] !== a0[11];
  for (; tr.k / HZ <= t + 1e-9; tr.k++) {
    const tk = tr.k / HZ, a = span > 1e-6 ? clamp((tk - tr.prevT) / span, 0, 1) : 1;
    if (jump) { VI.set(a >= .999 ? vals : a0); }
    else { for (let f = 0; f < S_; f++) VI[f] = a0[f] + (vals[f] - a0[f]) * a; for (const f of ANGLE) VI[f] = a0[f] + wrapPi(vals[f] - a0[f]) * a;
      const src = a < .5 ? a0 : vals; for (const f of DISCRETE) VI[f] = src[f]; if (a0[7] < 0 || vals[7] < 0) VI[7] = src[7]; if (a0[15] < 0 || vals[15] < 0) VI[15] = src[15]; }
    if (!tr.t.length || tk > tr.t[tr.t.length - 1] + 1e-6) pushS(tr, tk, VI);
  }
  tr.prev.set(vals); tr.prevT = t;
}
function botVals(r) {
  const p = r.root.position, w = r.remote ? (hasW(r.kcW) ? r.kcW : r.netW || 'carbine') : r.weapon;
  V[0] = p.x; V[1] = p.y; V[2] = p.z; V[3] = r.aimYaw || 0; V[4] = r.aimPitch || 0; V[5] = r.crouch || 0;
  V[6] = r.remote ? (r.kcAds || 0) : (r.ads || 0);
  V[7] = r.remote ? (r.kcRp !== undefined ? r.kcRp : r.reload > 0 ? .5 : -1) : r.reload > 0 ? clamp(1 - r.reload / ((BOTW[r.weapon] || {}).reload || 2), 0, 1) : -1;
  V[8] = widx(w); V[9] = r.onGround === false ? 0 : 1;
  V[10] = r.remote || r.targetVis || G.time - r.lastSeenT < 4 || G.time - r.lastHurt < 4 || r.mode === 'fight' ? 1 : 0;
  V[11] = r.dead ? 1 : 0; V[12] = r.deadT || 0; V[13] = r.root.visible ? 1 : 0; V[14] = r.bodyYaw || 0; V[15] = r.remote && r.kcSw !== undefined ? r.kcSw : -1; V[16] = r.hp || 0; V[17] = (r.remote ? r.netWalk : r.walk) ? 2 : 0;   // 2 = silent walk
  V[18] = r.remote && Number.isFinite(r.kcEy) ? r.kcEy : lerp(1.62, 1.12, r.crouch || 0);   // the game's own eye height (entEye)
  return V;
}
function meVals() {
  V[0] = P.pos.x; V[1] = P.pos.y; V[2] = P.pos.z; V[3] = wrapPi(P.yaw + Math.PI); V[4] = P.pitch; V[5] = P.crouch || 0; V[6] = P.ads || 0;
  V[7] = P.reload > 0 && P.reloadDur ? clamp(1 - P.reload / P.reloadDur, 0, 1) : -1; V[8] = widx(P.weapon); V[9] = P.onGround ? 1 : 0; V[10] = P.sprint ? 0 : 1;
  V[11] = P.dead ? 1 : 0; V[12] = P.dieT || 0; V[13] = 1; V[14] = V[3]; V[15] = P.swingT > 0 && P.swingDur ? clamp(1 - P.swingT / P.swingDur, 0, 1) : -1; V[16] = P.hp; V[17] = P.sprint ? 1 : P.walk ? 2 : 0;
  V[18] = Number.isFinite(P.smoothY) ? clamp(P.smoothY - P.pos.y, .8, 1.8) : P.camY || 1.65;   // your real eye (step-up smoothing included)
  return V;
}
KC.meNow = () => Array.from(meVals());   // what the recorder stores for you right now (tests: 17 = 2 while silent-walking)
function resetRec() { R.tracks.clear(); R.spawns.length = 0; for (const k of ['shots', 'fires', 'hits', 'throws', 'booms', 'kills', 'proj']) R[k].length = 0; R.lastT = -1; R.death = null; }
// drop the oldest n numbers in place (splice(0, n) also builds an array of the removed ones every trim; copyWithin boxes
// every double it moves): a plain loop moves them unboxed
function dropFront(A, n) { const L = A.length; for (let i = n; i < L; i++) A[i - n] = A[i]; A.length = L - n; }
function trimRec(t) {
  const lim = t - HIST;
  for (const [ent, tr] of R.tracks) {
    let n = 0; while (n < tr.t.length && tr.t[n] < lim) n++;
    if (n) { dropFront(tr.t, n); dropFront(tr.v, n * S_); }
    if (!tr.t.length || (t - tr.t[tr.t.length - 1] > 2 && ent !== PLAYER_ENT && !robots.includes(ent))) R.tracks.delete(ent);
  }
  for (const k of ['shots', 'fires', 'hits', 'throws', 'booms', 'kills', 'proj']) { const A = R[k]; let n = 0; while (n < A.length && A[n].t < lim) n++; if (n) A.splice(0, n); }
}
function recording() { return state === 'play' || (state === 'dead' && R.death && G.time - R.death.t < POST + .25); }
function record() {
  const t = G.time; if (t < R.lastT - .25) resetRec();
  if (t <= R.lastT) return; R.lastT = t;
  tick(PLAYER_ENT, meVals(), t);
  for (const r of robots) if (!r.kcGhost) tick(r, botVals(r), t);
  if (t - (R.lastPT || -9) < 1 / HZ - 1e-6) return; R.lastPT = t;
  // grenades, rockets and slow projectiles in flight
  let it = null;   // (no list or closure built on the many ticks with nothing in flight)
  if (NADES.length || ROCKETS.length || PROJ.length) {
    it = [];
    const add = (m, kind) => { if (!m || !m.parent) return; let id = R.pid.get(m); if (!id) { id = ++R.pidN; R.pid.set(m, id); } it.push([id, m, m.position.x, m.position.y, m.position.z, kind]); };
    for (const n of NADES) add(n.m, 'nade'); for (const q of ROCKETS) add(q.m, 'rocket'); for (const q of PROJ) add(q.m, 'proj');
  }
  const had = !!(it && it.length);
  if (had || R.projHad) R.proj.push({ t, it: it || [] }); R.projHad = had;
  if (++R.n % 60 === 0) trimRec(t);
  if (AU.ctx && !AUD.pre) prerender();
  REC.frames = R.tracks.get(PLAYER_ENT).t;   // older tests read REC.frames.length
}

const entW = e => !e ? null : e === PLAYER_ENT ? P.weapon : e.remote ? (hasW(e.kcW) ? e.kcW : e.netW || 'carbine') : e.weapon;
/* ---------- hooks: record what happens ---------- */
const _recFrame = recFrame; recFrame = function () {};                  // replaced by record() (runs after the bots move)
const _recShot = recShot;
recShot = function (a, b, color, width, life) {
  if (KC.inReplay || !recording()) return;
  let ent = R.cur && R.cur.t === G.time ? R.cur.ent : null;
  if (!ent && state === 'play' && a.distanceTo(_a.set(P.pos.x, P.pos.y + (P.camY || 1.6), P.pos.z)) < 2.5) ent = PLAYER_ENT;
  R.shots.push({ t: G.time, ent, wid: entW(ent), a: a.clone(), b: b.clone(), c: color.clone(), w: width, l: life });
};
const _recFire = recFire;
recFire = function (r) { if (!recording()) return; R.cur = { ent: r, t: G.time }; R.fires.push({ t: G.time, ent: r }); };
const _tracer = tracer;
tracer = function () { if (KC.live && !KC.inReplay) return; return _tracer.apply(this, arguments); };   // live shots don't flash through the replay
// while the replay fills the screen the live bots are invisible: they keep moving, aiming and shooting, but their
// skeletons are not re-posed (the replay's own actors are) so the killcam costs no more than normal play
const _animateBot = animateBot;
animateBot = function (r) { if (KC.live && !KC.inReplay && r && !r.kcGhost) return; return _animateBot.apply(this, arguments); };
const _updateRobots = updateRobots;
updateRobots = function (dt, menu) {
  // offline, the match is over while the final killcam fills the screen: the hidden live bots need not wander behind it
  if (menu && KC.fin && KC.fin.shown && state === 'matchend' && !NET.on) return;
  const r = _updateRobots.apply(this, arguments);
  if (!menu) { try { if (recording()) record(); if (state === 'dead' && KC.clip && !KC.live) buildGhosts(1);
    // spectator mode switched on while a replay runs: spectate.js holds the death timer at 0, so the replay would never get
    // another frame and its overlay would stay frozen on top of the spectator view. End it here (this runs every frame).
    if ((REC.on || KC.clip) && !KC.fin && window.SPECTATE && window.SPECTATE.on) stopKillcam(); } catch (e) { warnOnce(e); } }
  return r;
};
const _hurtPlayer = hurtPlayer;
hurtPlayer = function (dmg, from, attacker, crit, weapon) {
  const hp0 = P.hp, live = state === 'play' && !P.dead;
  // online: a hit carries an index into NET_W, whose order depends on which add-ons each client loaded: the exact id rides along in `wn`
  let hq = null; if (R.cur && R.cur.net && R.cur.ent === attacker && R.cur.hq && R.cur.hq.length) { hq = R.cur.hq.shift(); if (hq.wn && hasW(hq.wn) && hq.wn !== weapon) weapon = hq.wn; }
  if (live && R.cur && R.cur.net && R.cur.ent === attacker) R.cur.hitSeq = hq ? hq.s : (R.cur.E && R.cur.E.last ? R.cur.E.last.hit | 0 : 0);
  const res = _hurtPlayer.call(this, dmg, from, attacker, crit, weapon);
  if (live && P.hp < hp0) { const h = { t: G.time, ent: attacker || null, dmg: hp0 - P.hp, crit: !!crit, weapon, kill: !!P.dead }; R.hits.push(h); if (R.cur && R.cur.net && R.cur.ent === attacker) R.cur.hit = h; }
  return res;
};
const _playerDie = playerDie;
playerDie = function (killer, weapon, crit) {
  const k = killer || null, kp = k && k !== PLAYER_ENT && k.root ? k.root.position : null;
  R.death = { t: G.time, wall: performance.now(), killer: k, weapon: weapon || 'carbine', crit: !!crit, hp: k && k.hp, ts: null, dist: kp ? Math.hypot(kp.x - P.pos.x, kp.y - P.pos.y, kp.z - P.pos.z) : 0,
    skin: k && k !== PLAYER_ENT ? skinOfEnt(k, weapon) : 'factory', seq: R.cur && R.cur.net && R.cur.ent === k ? R.cur.hitSeq | 0 : 0, pos: [P.pos.x, P.pos.y, P.pos.z] };
  if (k && k.remote && k.netId && !BLAST.has(R.death.weapon)) askHistory(k, R.death);   // (blasts replay as an orbit: their view is not needed)
  const res = _playerDie.apply(this, arguments);
  try { deathCard(R.death); } catch (e) { warnOnce(e); }
  return res;
};
const _killEntity = killEntity;
killEntity = function (v, k, weapon, crit) { if (state === 'play' || state === 'dead') R.kills.push({ t: G.time, wall: performance.now(), v, k, weapon, crit: !!crit, hp: k && k.isPlayer ? P.hp : k && k.hp }); return _killEntity.apply(this, arguments); };
// the Vortex boomerang makes no tracer or recFire, so its throws were never recorded (player report: "killcam with boomerang doesn't show the animation")
const _boomThrow = typeof boomThrow === 'function' ? boomThrow : null;
if (_boomThrow) boomThrow = function () {
  if (recording()) { const p = camera.position; const r = _boomThrow.apply(this, arguments); const o = BOOM.out; R.fires.push({ t: G.time, ent: PLAYER_ENT }); R.shots.push({ t: G.time, ent: PLAYER_ENT, wid: 'boomerang', boom: true, a: p.clone(), b: o && o.p ? o.p.clone() : p.clone(), c: new THREE.Color(1, 1, 1), w: 0, l: 0 }); return r; }
  return _boomThrow.apply(this, arguments);
};
const _throwNade = throwNade;
throwNade = function (owner) { if (recording() && owner) R.throws.push({ t: G.time, ent: owner, kind: 'nade' }); return _throwNade.apply(this, arguments); };
const _launchRocket = launchRocket;
launchRocket = function (owner) { if (recording() && owner) { R.throws.push({ t: G.time, ent: owner, kind: 'rocket' }); R.fires.push({ t: G.time, ent: owner }); } return _launchRocket.apply(this, arguments); };
const _spawnProj = spawnProj;
spawnProj = function (kind, owner) { if (recording() && owner && owner !== PLAYER_ENT) R.fires.push({ t: G.time, ent: owner }); return _spawnProj.apply(this, arguments); };
const _explode = explode;
explode = function (p, owner, weapon) { if (recording()) R.booms.push({ t: G.time, p: p.clone(), weapon: weapon || 'nade' }); return _explode.apply(this, arguments); };

/* ---------- online: what we send and keep from other players ---------- */
const R2 = v => Math.round(v * 100) / 100, R4 = v => Math.round(v * 1e4) / 1e4;
const _netSend = netSend;
netSend = function () {
  const room = NET && NET.room; if (!NET.on || !room || typeof room.presence !== 'function') return _netSend.apply(this, arguments);
  const p0 = room.presence;
  room.presence = function (st) {
    if (st && typeof st === 'object' && st.v === 1) {
      st.ad = R2(P.ads || 0); st.rp = P.reload > 0 && P.reloadDur ? R2(clamp(1 - P.reload / P.reloadDur, 0, 1)) : -1;
      st.sw = P.swingT > 0 && P.swingDur ? R2(clamp(1 - P.swingT / P.swingDur, 0, 1)) : -1; st.wid = P.weapon; st.sp = P.sprint ? 1 : P.walk ? 2 : 0;
      st.yw4 = R4(P.yaw + Math.PI); st.pt4 = R4(P.pitch);
      st.ey = R2(Number.isFinite(P.smoothY) ? clamp(P.smoothY - P.pos.y, .8, 1.8) : P.camY || 1.65);   // your real eye height
      st.kwn = P.dead && R.death && hasW(R.death.weapon) ? R.death.weapon : '';                         // exact weapon that killed you
    }
    return p0.apply(this, arguments);
  };
  try { return _netSend.apply(this, arguments); } finally { room.presence = p0; }
};
const _netHit = netHit;
netHit = function (dmg, crit, weapon, target) {
  const res = _netHit.apply(this, arguments);
  try { const h = NET.hits && NET.hits[NET.hits.length - 1]; if (h && h.s === NET.seq.hit) { if (typeof weapon === 'string' && hasW(weapon)) h.wn = weapon; R.hitLog.push({ s: h.s, t: G.time, wall: performance.now(), target: target || null, w: weapon }); if (R.hitLog.length > 60) R.hitLog.shift(); } } catch (e) { warnOnce(e); }
  return res;
};
const _netReceive = netReceive;
netReceive = function (E, pr) {
  const r = E && E.r; if (!r || !pr) return _netReceive.apply(this, arguments);
  const L = E.last || {}, shot0 = L.shot | 0, nade0 = L.nade | 0, proj0 = L.proj || 0, wasDead = P.dead, rDead = r.dead;
  const myId = NET.room && NET.room.myId, hq = [];
  if (Array.isArray(pr.hl)) for (const h of pr.hl) if (h && (h.s | 0) > (L.hit | 0) && (!h.t || h.t === myId)) hq.push({ s: h.s | 0, wn: typeof h.wn === 'string' ? h.wn : null });
  R.cur = { ent: r, t: G.time, net: true, hit: null, hq, E };
  let res; try { res = _netReceive.apply(this, arguments); } finally { var cur = R.cur; R.cur = null; }
  if (!Array.isArray(pr.x)) return res;
  if ((pr.sh | 0) > shot0 && Array.isArray(pr.sx) && recording()) R.fires.push({ t: G.time, ent: r });
  r.kcAds = clamp(+pr.ad || 0, 0, 1); r.kcRp = pr.rp === undefined ? undefined : clamp(+pr.rp, -1, 1); r.kcSw = pr.sw === undefined ? undefined : clamp(+pr.sw, -1, 1);
  if (hasW(pr.wid)) r.kcW = pr.wid;
  const ey = +pr.ey; r.kcEy = Number.isFinite(ey) && ey > .5 && ey < 2 ? ey : undefined;
  r.kcGk = typeof pr.gk === 'string' && /^[A-Za-z0-9_-]{0,32}$/.test(pr.gk) ? pr.gk || 'factory' : r.kcGk || 'factory';
  const H = r.kcHist || (r.kcHist = []), ts = +pr.ts || performance.now(), aw = performance.now();
  if (!H.length || ts > H[H.length - 1].ts) {
    const yw = Number.isFinite(+pr.yw4) ? +pr.yw4 : +pr.yw || 0, pt = Number.isFinite(+pr.pt4) ? +pr.pt4 : +pr.pt || 0;
    H.push({ ts, aw, x: +pr.x[0] || 0, y: +pr.x[1] || 0, z: +pr.x[2] || 0, yaw: yw, pitch: pt, cr: +pr.cr || 0, g: pr.g ? 1 : 0, w: hasW(pr.wid) ? pr.wid : NET_W[pr.w | 0] || 'carbine',
      ad: r.kcAds, ey: r.kcEy, gk: r.kcGk, rp: r.kcRp !== undefined ? r.kcRp : pr.rl ? .5 : -1, sw: r.kcSw !== undefined ? r.kcSw : -1, dd: pr.dd ? 1 : 0, hp: +pr.hp || 0, sp: pr.sp === 2 ? 2 : pr.sp ? 1 : 0,
      shot: (pr.sh | 0) > shot0 && Array.isArray(pr.sx) ? { n: Math.min(6, (pr.sh | 0) - shot0), sx: pr.sx.slice(0, 6).map(Number) } : null,
      nade: (pr.ns | 0) > nade0 ? 1 : 0, proj: Array.isArray(pr.pj) && pr.pj[0] > proj0 ? 1 : 0, hit: cur && cur.hit ? { crit: cur.hit.crit, kill: cur.hit.kill } : null });
    while (H.length > 2 && aw - H[0].aw > HIST * 1000) H.shift();
  }
  if (!wasDead && P.dead && R.death && P.killer === r) R.death.ts = ts;   // this state carried the killing hit
  if (!rDead && r.dead && (state === 'play' || state === 'dead')) { const mine = NET.room && pr.kb === NET.room.myId, k = mine ? PLAYER_ENT : remoteById(pr.kb);
    if (k) R.kills.push({ t: G.time, wall: aw, v: r, k, weapon: hasW(pr.kwn) ? pr.kwn : NET_W[pr.kw | 0] || 'carbine', crit: !!pr.kh, hp: k.isPlayer ? P.hp : k.hp }); }
  return res;
};

/* ---------- gun finishes (modules/gunskins.js) and soldier looks (modules/skins.js) ---------- */
const GS = () => window.S9GunSkins && window.S9GunSkins.version ? window.S9GunSkins : null;
const NOFIN = new Set(['knife', 'nade', 'charge', 'ftspit', 'ftpoison']);
function skinOfEnt(e, w) {   // the finish on the gun this entity holds / killed with ('factory' when unknown)
  const gs = GS(); if (!gs || !e || NOFIN.has(w)) return 'factory';
  try {
    if (e === PLAYER_ENT) { const id = gs.get(w); return gs.owns(id, w) ? id : 'factory'; }
    if (e.remote) { const cw = hasW(e.kcW) ? e.kcW : e.netW; return cw === w && e.kcGk ? e.kcGk : 'factory'; }
    const ud = e.gunInner && e.gunInner.userData; return ud && ud.gsSkin && (ud.gsWeapon || e.weapon) === w ? ud.gsSkin : 'factory';
  } catch (x) { return 'factory'; }
}
function skinInfo(id) {   // { name, rarity, col } or null for the factory finish
  const gs = GS(); if (!gs || !id || id === 'factory') return null;
  const s = gs.skin(id); if (!s || s.default || s.id === 'factory') return null; const R0 = (gs.RARITY || {})[s.rarity] || { name: '', col: '#b8c0cc' };
  return { id: s.id, name: String(s.name || s.id), rarity: R0.name || s.rarity, col: R0.col || '#b8c0cc' };
}

/* ---------- online: ask the killer for their own view (60 Hz, exact aim, exact shot/hit times) ----------
   The victim sends {k:'kc', to:killerId, q:1, s:hitSeq}; the game server relays it to that one player; the killer's
   client answers {k:'kc', to:victimId, a:1, s, ...} with its own recorded track around the killing hit (delta-coded).
   Old servers / peer-to-peer rooms simply never answer: the replay then uses the ~30 Hz states we already have. */
const KCQ = { pend: null, lis: false, st: { asked: 0, answered: 0, bytes: 0, got: 0, used: 0, late: 0, bad: '' } }; KC.q = KCQ.st;
const srvRoom = () => !!(NET && NET.on && NET.room && NET.room.server && typeof srvSend === 'function' && typeof SRV === 'object' && SRV && SRV.ws && SRV.ws.readyState === 1);
function listen() {
  if (KCQ.lis || typeof SRV !== 'object' || !SRV || !SRV.on) return; KCQ.lis = true;
  SRV.on.add(d => { if (d && d.k === 'kc' && typeof d.f === 'string') { try { if (d.a) gotHistory(d); else if (d.q === 1) answer(d); } catch (e) { warnOnce(e); } } });
}
try { listen(); } catch (e) {}   // the killer side must be listening from the start
function askHistory(k, D) {
  listen(); if (!srvRoom()) return;
  KCQ.pend = { id: k.netId, ent: k, seq: D.seq | 0, sent: performance.now(), death: D, got: null }; KCQ.st.asked++;
  srvSend({ k: 'kc', to: k.netId, q: 1, s: D.seq | 0 });
}
const SHP = new Float32Array(32);   // scratch: the killer's recorded state at the replay time (HP bar)
const PK = 1000;   // packet time unit: ms
function answer(d) {
  const vic = d.f, seq = d.s | 0; let H = null;
  for (let i = R.hitLog.length - 1; i >= 0; i--) { const h = R.hitLog[i]; if (h.target === vic && (!seq || h.s === seq)) { H = h; break; } }
  if (!H) for (let i = R.hitLog.length - 1; i >= 0; i--) if (R.hitLog[i].target === vic) { H = R.hitLog[i]; break; }
  if (!H) return;
  const send = () => {
    const tr = R.tracks.get(PLAYER_ENT); if (!tr || tr.t.length < 10 || !srvRoom()) return;
    const th = H.t, a = th - 4.6, b = th + POST + .3, W = [], wi = w => { let i = W.indexOf(w); if (i < 0) { W.push(w); i = W.length - 1; } return i; };
    const cols = 15, q = [], last = new Array(cols).fill(0); let n = 0;
    for (let i = 0; i < tr.t.length; i++) { const t = tr.t[i]; if (t < a || t > b) continue; const o = i * S_, v = tr.v;
      const row = [Math.round((t - th) * PK), Math.round(v[o] * 100), Math.round(v[o + 1] * 100), Math.round(v[o + 2] * 100), Math.round(v[o + 3] * 1e4), Math.round(v[o + 4] * 1e4), Math.round(v[o + 5] * 100), Math.round(v[o + 6] * 100),
        Math.round(v[o + 7] * 100), wi(wname(v[o + 8])), v[o + 9] | 0, Math.round(v[o + 15] * 100), v[o + 17] | 0, Math.round(v[o + 18] * 100), Math.round(v[o + 16])];
      for (let c = 0; c < cols; c++) { q.push(c === 4 && n ? Math.round(wrapPi((row[c] - last[c]) / 1e4) * 1e4) : row[c] - last[c]); last[c] = row[c]; } n++; }
    if (n < 10) return;
    const shots = [], seen = new Set();
    for (const x of R.shots) if (x.ent === PLAYER_ENT && x.t >= a && x.t <= b) { const k = Math.round((x.t - th) * PK); shots.push([k, Math.round(x.b.x * 100), Math.round(x.b.y * 100), Math.round(x.b.z * 100), wi(x.wid || P.weapon)]); seen.add(k); }
    const hits = R.hitLog.filter(h => h.target === vic && h.t >= a && h.t <= b).map(h => [Math.round((h.t - th) * PK), h === H ? 1 : 0]);
    const thr = R.throws.filter(x => x.ent === PLAYER_ENT && x.t >= a && x.t <= b).map(x => Math.round((x.t - th) * PK));
    const fin = {}; for (const w of W) { const id = skinOfEnt(PLAYER_ENT, w); if (id !== 'factory') fin[w] = id; }
    const msg = JSON.stringify({ k: 'kc', to: vic, a: 1, s: H.s, v: 1, n, W, d: q, shots, hits, thr, fin }); KCQ.st.answered++; KCQ.st.bytes = msg.length;
    srvSend(msg);
  };
  // answer quickly (a little after the killing hit so the shot's recoil is in); the moments after the kill come from the states
  const wait = Math.max(0, Math.min(.2, H.t + .15 - G.time));
  if (wait <= 0) send(); else setTimeout(() => { try { send(); } catch (e) { warnOnce(e); } }, wait * 1000);
}
function gotHistory(d) {
  const P0 = KCQ.pend; KCQ.st.got++; if (!P0 || d.f !== P0.id || !Array.isArray(d.d) || !Array.isArray(d.W) || d.v !== 1) { KCQ.st.bad = 'match ' + (P0 && P0.id) + ' ' + d.f; return; }
  const n = d.n | 0, cols = 15; if (n < 10 || d.d.length !== n * cols || n > 2000) { KCQ.st.bad = 'size ' + n + ' ' + d.d.length; return; }
  const deathT = P0.death.t, tr = { t: [], v: [], fires: [], shots: [], hits: [], throws: [], hi: true }, last = new Array(cols).fill(0), Wn = d.W.map(w => hasW(w) ? w : 'carbine');
  for (let i = 0; i < n; i++) { for (let c = 0; c < cols; c++) last[c] += +d.d[i * cols + c] || 0;
    const t = deathT + last[0] / PK; if (tr.t.length && t <= tr.t[tr.t.length - 1]) continue;
    V[0] = last[1] / 100; V[1] = last[2] / 100; V[2] = last[3] / 100; V[3] = last[4] / 1e4; V[4] = last[5] / 1e4; V[5] = last[6] / 100; V[6] = last[7] / 100; V[7] = last[8] / 100; V[8] = widx(Wn[last[9]] || 'carbine');
    V[9] = last[10]; V[10] = 1; V[11] = 0; V[12] = 0; V[13] = 1; V[14] = V[3]; V[15] = last[11] / 100; V[16] = last[14]; V[17] = last[12]; V[18] = last[13] / 100; pushS(tr, t, V); }
  if (tr.t.length < 10) return;
  let lt = -9; for (const x of d.shots || []) { if (!Array.isArray(x)) continue; const t = deathT + x[0] / PK; tr.shots.push({ t, b: new THREE.Vector3(x[1] / 100, x[2] / 100, x[3] / 100), w: Wn[x[4]] || 'carbine' }); if (t !== lt) { tr.fires.push(t); lt = t; } }
  for (const x of d.hits || []) if (Array.isArray(x)) tr.hits.push({ t: deathT + x[0] / PK, crit: false, kill: !!x[1] });
  for (const x of d.thr || []) tr.throws.push(deathT + (+x || 0) / PK);
  tr.fires.sort((a, b) => a - b); tr.fin = d.fin && typeof d.fin === 'object' ? d.fin : {};
  P0.got = tr; P0.gotAt = performance.now(); KC.hiN = (KC.hiN || 0) + 1;
  // the replay has not started yet: rebuild it on the killer's own view
  P0.gotWall = performance.now(); if (KC.live || KC.fin) KCQ.st.late++;
  if (KC.clip && !KC.live && KC.clip.killer === P0.ent && KC.clip.deathT === deathT) { const c = makeClip(KC.clip.I); if (c) { KCQ.st.used++; KCQ.st.ms = Math.round(performance.now() - P0.sent); KC.clip = c; fillBanner(c); try { prewarm(c); } catch (e) { warnOnce(e); } DC.T = Math.max(DCT, RS - END_PAD - c.dur); } }
}

/* ================= sampling ================= */
function seg(T, t) { const n = T.length; if (n < 2 || t <= T[0]) return 0; if (t >= T[n - 1]) return n - 2; let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; } return lo; }
// every field at time t (linear; angles the short way round; on/off fields from the nearer sample; teleports snap)
function lin(tr, t, out) {
  const T = tr.t, n = T.length; if (!n) return false;
  const i = seg(T, t), j = Math.min(i + 1, n - 1), a = i * S_, b = j * S_, W = tr.v;
  let k = T[j] > T[i] ? clamp((t - T[i]) / (T[j] - T[i]), 0, 1) : 0;
  const dx = W[b] - W[a], dz = W[b + 2] - W[a + 2]; if (dx * dx + dz * dz > 9) k = k < .5 ? 0 : 1;
  for (let f = 0; f < S_; f++) out[f] = W[a + f] + (W[b + f] - W[a + f]) * k;
  for (const f of ANGLE) out[f] = W[a + f] + wrapPi(W[b + f] - W[a + f]) * k;
  const d = k < .5 ? a : b; for (const f of DISCRETE) out[f] = W[d + f];
  if (W[a + 7] < 0 || W[b + 7] < 0) out[7] = W[d + 7]; if (W[a + 15] < 0 || W[b + 15] < 0) out[15] = W[d + 15]; if (W[a + 11] !== W[b + 11]) out[12] = W[d + 12];
  return t >= T[0] - .06 && t <= T[n - 1] + .06;
}
// smooth (C1) curve through the samples for the camera: cubic Hermite with tangents from the neighbours
function herm(tr, t, f, ang) {
  const T = tr.t, W = tr.v, n = T.length; if (n === 1) return W[f];
  const i = seg(T, t), j = i + 1, i0 = Math.max(i - 1, 0), j1 = Math.min(j + 1, n - 1);
  let p1 = W[i * S_ + f], p2 = W[j * S_ + f], p0 = W[i0 * S_ + f], p3 = W[j1 * S_ + f];
  if (ang) { p0 = p1 + wrapPi(p0 - p1); p2 = p1 + wrapPi(p2 - p1); p3 = p2 + wrapPi(p3 - p2); }
  const h = T[j] - T[i]; if (h <= 1e-6) return p1;
  const s = clamp((t - T[i]) / h, 0, 1), s2 = s * s, s3 = s2 * s;
  const m1 = (p2 - p0) / Math.max(1e-4, T[j] - T[i0]), m2 = (p3 - p1) / Math.max(1e-4, T[j1] - T[i]);
  return (2 * s3 - 3 * s2 + 1) * p1 + (s3 - 2 * s2 + s) * h * m1 + (-2 * s3 + 3 * s2) * p2 + (s3 - s2) * h * m2;
}
const TAPS = [-2, -1, 0, 1, 2], TW = [1, 2, 3, 2, 1];
// view angles like a hand on a mouse: the Hermite curve, lightly averaged over +-40 ms so turn-rate corners don't snap
function viewAt(tr, t, out) {
  const y0 = herm(tr, t, 3, true); let ys = 0, ps = 0, ws = 0;
  for (let k = 0; k < 5; k++) { const tt = t + TAPS[k] * .02; ys += TW[k] * wrapPi(herm(tr, tt, 3, true) - y0); ps += TW[k] * herm(tr, tt, 4, false); ws += TW[k]; }
  out.yaw = y0 + ys / ws; out.pitch = ps / ws; out.x = herm(tr, t, 0); out.y = herm(tr, t, 1); out.z = herm(tr, t, 2);
  return out;
}
function velAt(tr, t, out) { lin(tr, t - .05, SA); lin(tr, t + .05, SB); return out.set((SB[0] - SA[0]) / .1, (SB[1] - SA[1]) / .1, (SB[2] - SA[2]) / .1); }

/* ================= replay actors ("ghosts"): own copies, so the live bots keep playing undisturbed ================= */
const GH = new Map();
function makeGhost(ent) {
  const isMe = ent === PLAYER_ENT;
  const col = isMe ? (NET.on ? NET_COLORS[(NET.color | 0) % NET_COLORS.length] : [1, .55, .2]) : [ent.color.r, ent.color.g, ent.color.b];
  const w0 = isMe ? P.weapon : ent.remote ? (ent.netW || 'carbine') : ent.weapon, w = w0 === 'knife' || !hasW(w0) ? 'carbine' : w0;
  const n0 = robots.length, g = buildBot({ name: isMe ? 'You' : ent.name, color: col, weapon: BOTW[w] ? w : 'carbine', skill: 1 });
  const i = robots.indexOf(g); if (i >= 0) robots.splice(i, 1); if (robots.length !== n0) console.warn('[killcam] robots changed');
  ghostLook(g, ent, isMe);
  targetsDirty = true; g.tag.remove(); g.kcGhost = true; g.kcEnt = ent; g.root.visible = false; g.gun.visible = false; g.guns = { [g.weapon]: g.gunInner }; g.curW = g.weapon;
  g.kcScene = scene; GH.set(ent, g); dressGhost(g, ent); return g;
}
// the replay actor wears what that player really wears: your own soldier look and gun finishes (skins.js would
// otherwise treat "You" as a bot and pick a random look), a remote player's look + finish from their state
function lookOf(ent) {   // the look this player is wearing RIGHT NOW (what the live game shows), or null when unknown
  const SK = window.S9Skins; if (!SK || !SK.version) return null;
  try {
    if (ent === PLAYER_ENT) { let l = SK.look; if (l && typeof SK.owns === 'function' && !SK.owns(l.skin)) l = SK.parseLook(SK.lookCode(Object.assign({}, l, { skin: 'std', h: 0 }))); return l || null; }
    if (ent.remote && NET.peers) { for (const E of NET.peers.values()) if (E.r === ent) return E.pres ? SK.readRemoteLook(E.pres) : null; }
  } catch (e) {}
  return null;
}
function finFor(ent, w) {
  const c = KC.clip; if (c && ent === c.killer && c.fin && c.fin[w]) return c.fin[w];
  return skinOfEnt(ent, w);
}
function dressGhost(g, ent) {
  try { const l = lookOf(ent), SK = window.S9Skins; g.kcLook = l && SK.lookCode ? SK.lookCode(l) : ''; if (l && SK && SK.apply) SK.apply(g, l.skin, l); } catch (e) { warnOnce(e); }
  try { const gs = GS(); if (gs && g.weapon && g.gunInner) gs.apply(g.weapon, finFor(ent, g.weapon), g.gunInner); } catch (e) { warnOnce(e); }
}
function dropGhost(g) { scene.remove(g.root); scene.remove(g.gun); try { g.mixer.stopAllAction(); g.mixer.uncacheRoot(g.mixer.getRoot()); freeBotGpu(g.root); freeBotGpu(g.gun); } catch (e) {} GH.delete(g.kcEnt); }
// buildBot() gives every new fighter a random bot skin picked from its name. The replay must show who really died / killed:
// your own worn soldier skin, and an online player's skin as they sent it. (Bots already get the same look as the live bot.)
function ghostLook(g, ent, isMe) {
  try {
    const SK = window.S9Skins; if (!SK || typeof SK.apply !== 'function') return;
    let l = null;
    if (isMe) { l = SK.look; if (l && typeof SK.owns === 'function' && !SK.owns(l.skin)) l = SK.parseLook(SK.lookCode(Object.assign({}, l, { skin: 'std', h: 0 }))); }
    else if (ent.remote && NET && NET.peers) { for (const e of NET.peers.values()) if (e.r === ent) { l = e.pres && SK.parseLook(e.pres.lk); break; } }
    if (l && l.skin) SK.apply(g, l.skin, l);
  } catch (e) { warnOnce(e); }
}
function ghostFor(ent) { let g = GH.get(ent); if (g && g.kcScene !== scene) { dropGhost(g); g = null; } return g || makeGhost(ent); }
// build the actors the replay needs, a few per frame while the death cam runs (no hitch at the moment you die)
function buildGhosts(max) {
  const c = KC.clip; if (!c) return; let made = 0;
  // ghosts are cached between kills: re-dress any whose player changed look since (or whose look had not arrived yet)
  if (c.kcDressed !== true) { c.kcDressed = true; for (const ent of c.cast) { const g = GH.get(ent); if (!g || g.kcScene !== scene) continue; try { const l = lookOf(ent), SK = window.S9Skins; if (l && SK.lookCode(l) !== g.kcLook) dressGhost(g, ent); } catch (e) { warnOnce(e); } } }
  for (const ent of c.cast) { const g = GH.get(ent); if (g && g.kcScene === scene) continue; ghostFor(ent); if (++made >= max) return; }
}
function setGhostWeapon(g, w) {
  if (g.curW === w) return; g.curW = w;
  if (w === 'knife' || !hasW(w)) return;
  if (!g.guns[w]) { try { g.guns[w] = rifleTP(w); const gs = GS(); if (gs) gs.apply(w, finFor(g.kcEnt, w), g.guns[w]); } catch (e) { g.guns[w] = g.guns[Object.keys(g.guns)[0]]; } }
  g.gun.remove(g.gunInner); g.gunInner = g.guns[w]; g.gun.add(g.gunInner); g.muzzle.position.copy(g.gunInner.userData.muzzle || g.muzzle.position);
}
function poseDeadGhost(g, deadT) {
  const D = g.act.death;
  if (g.preQ) { [g.B.hips, g.B.spine, g.B.spine1, g.B.spine2, g.B.neck].forEach((b, i) => b && b.quaternion.copy(g.preQ[i])); g.preQ = null; }
  for (const k in g.act) if (k !== 'death') { g.act[k].w = 0; g.act[k].setEffectiveWeight(0); }
  if (!g.kcDying) { D.reset(); D.play(); g.kcDying = true; }
  D.enabled = true; D.setEffectiveWeight(1); D.w = 1; D.time = Math.min(Math.max(0, deadT), D.getClip().duration - 1e-3); g.mixer.update(0);
  g.gun.visible = false; g.flash.visible = false;
}
// pose one actor from its recording; dt = replay time since the last frame (slow motion slows the legs too)
function poseGhost(g, tr, t, dt, first, opt) {
  const ok = lin(tr, opt && opt.tPos !== undefined ? opt.tPos : t, V); if (!ok || !V[13]) { g.root.visible = false; g.gun.visible = false; return false; }
  const p = g.root.position; p.set(V[0], V[1], V[2]);
  if (opt && opt.y !== undefined) p.y = opt.y;
  g.root.visible = true;
  const dead = opt && opt.dead !== undefined ? opt.dead : V[11] > .5;
  if (dead) { poseDeadGhost(g, opt && opt.deadT !== undefined ? opt.deadT : V[12]); g.root.updateMatrixWorld(true); return true; }
  if (g.kcDying) { g.kcDying = false; g.act.death.stop(); g.act.death.setEffectiveWeight(0); g.act.death.w = 0; g.preQ = null; }
  const w = wname(V[8]); setGhostWeapon(g, w);
  velAt(tr, opt && opt.tPos !== undefined ? opt.tPos : t, _d); g.vel.set(_d.x, 0, _d.z);
  g.onGround = V[9] > .5 && Math.abs(_d.y) < 2.5; g.aimYaw = V[3]; g.aimPitch = V[4]; g.crouch = V[5];
  const rl = V[7]; if (rl >= 0) { if (!(g.reload > 0)) { g.act.reload.reset().play(); } g.reload = 1; g.act.reload.time = rl * g.act.reload.getClip().duration; } else g.reload = 0;
  const alert = V[10] > .5; g.targetVis = alert; g.lastSeenT = alert ? G.time : -99; g.lastHurt = -99; g.mode = alert ? 'fight' : 'roam';
  // their gun kicks and flashes on every recorded shot
  const f = opt && opt.fires; let lf = -9; if (f) for (let i = f.length - 1; i >= 0; i--) if (f[i] <= t) { lf = f[i]; break; }
  g.shotKick = clamp(1 - (t - lf) * 9, 0, 1); g.flashT = lf + .045 - t; g.flinch = 0; g.hitT = 0; g.shield = 0; g.chillT = 0; g.burnT = 0;
  if (first) { g.bodyYaw = V[14]; g.legYaw = 0; g.backK = 0; for (const k in g.act) { g.act[k].w = 0; g.act[k].setEffectiveWeight(0); } animateBot(g, .3); }
  else animateBot(g, Math.max(0, dt));
  g.gun.visible = w !== 'knife'; g.glint.visible = false; g.bubble.visible = false;
  g.root.updateMatrixWorld(true);
  return true;
}

/* ================= the clip: everything needed to replay one death ================= */
function netTrack(r, deathT, wall) {
  const H = r.kcHist || []; if (H.length < 4) return null;
  let off = Infinity; for (const h of H) if (wall - h.aw < 4000) off = Math.min(off, h.aw - h.ts);
  if (!Number.isFinite(off)) return null;
  const tr = { t: [], v: [], fires: [], shots: [], hits: [], throws: [], fin: {} }, gap = w => Math.min(.06, 60 / (((WEAPONS[w] || {}).rpm) || 600));
  let deadSince = null;
  for (const h of H) {
    const tg = deathT - (wall - (h.ts + off)) / 1000; if (tg < deathT - HIST || (tr.t.length && tg <= tr.t[tr.t.length - 1])) continue;
    if (h.dd) { if (deadSince === null) deadSince = tg; } else deadSince = null;
    if (h.gk && h.gk !== 'factory' && !NOFIN.has(h.w)) tr.fin[h.w] = h.gk;
    V[0] = h.x; V[1] = h.y; V[2] = h.z; V[3] = h.yaw; V[4] = h.pitch; V[5] = h.cr; V[6] = h.ad; V[7] = h.rp; V[8] = widx(h.w); V[9] = h.g; V[10] = 1; V[11] = h.dd;
    V[12] = deadSince === null ? 0 : tg - deadSince; V[13] = 1; V[14] = h.yaw; V[15] = h.sw; V[16] = h.hp; V[17] = h.sp; V[18] = Number.isFinite(h.ey) ? h.ey : lerp(1.65, 1.05, h.cr);
    pushS(tr, tg, V);
    if (h.shot) { const n = h.shot.n, sx = h.shot.sx, gp = gap(h.w); for (let k = 0; k < n; k++) { const tf = tg - (n - 1 - k) * gp; tr.fires.push(tf); tr.shots.push({ t: tf, b: new THREE.Vector3(sx[3], sx[4], sx[5]), w: h.w }); } }
    if (h.proj) tr.fires.push(tg);
    if (h.nade) tr.throws.push(tg);
    if (h.hit) tr.hits.push({ t: tg, crit: h.hit.crit, kill: h.hit.kill });
  }
  if (tr.t.length < 4) return null;
  tr.fires.sort((a, b) => a - b);
  return tr;
}
// the start of the actor's current life: after its last death or teleport (respawn) before time t
function lastSpawn(tr, t) {
  const T = tr.t, W = tr.v; let i = Math.min(seg(T, t) + 1, T.length - 1);
  while (i > 0 && T[i] > t) i--;
  for (; i > 0; i--) { const a = (i - 1) * S_, b = i * S_; if (W[a + 11] > .5 && W[b + 11] < .5) return T[i]; if ((W[b] - W[a]) ** 2 + (W[b + 2] - W[a + 2]) ** 2 > 9 && T[i] - T[i - 1] < .3) return T[i]; if (T[i] - T[i - 1] > 1.5) return T[i]; }   // (a long hole = paused / dead; a lag spike is not a respawn)
  return -1e9;
}
// the killer's own 60 Hz view ends a moment after the kill: continue it with their states (same positions, their clock)
function withTail(hi, st) {
  if (!st || !st.t.length) return hi; const end = hi.t[hi.t.length - 1]; if (st.t[st.t.length - 1] <= end + 1 / HZ) return hi;
  const out = { t: hi.t.slice(), v: hi.v.slice(), fires: hi.fires.slice(), shots: hi.shots.slice(), hits: hi.hits.slice(), throws: hi.throws.slice(), fin: Object.assign({}, st.fin || {}, hi.fin || {}), hi: true };
  for (let i = 0; i < st.t.length; i++) if (st.t[i] > end + 1 / HZ) { out.t.push(st.t[i]); for (let f = 0; f < S_; f++) out.v.push(st.v[i * S_ + f]); }
  for (const f of st.fires) if (f > end + .02) out.fires.push(f); for (const x of st.shots) if (x.t > end + .02) out.shots.push(x);
  return out;
}
function speedAt(rt, c) {   // replay speed: 1x, easing into slow motion for the final shot, then back
  const sA = c.deathT - SLOW_PRE, sB = c.deathT + .03;
  const w = rt < sA ? smooth((rt - (sA - .12)) / .12) : rt < sB ? 1 : 1 - smooth((rt - sB) / .18);
  return 1 - (1 - SLOW) * w;
}
// I = { killer, victim, t (death time), wall, weapon, crit, hp, final }: any killer (bot, online player, you) and any victim
function makeClip(I) {
  const killer = I.killer || null, victim = I.victim; if (!victim || killer === victim) return null;
  if (!killer && !BLAST.has(I.weapon)) return null;   // world deaths: only blasts (the demolition charge) get a replay
  for (const [e, g] of GH) if (e !== PLAYER_ENT && !robots.includes(e)) dropGhost(g);   // players who left / old matches
  const deathT = I.t, me = R.tracks.get(victim); if (!me || me.t.length < 10) return null;
  let kind = 'bot', ktr = null; const pend = KCQ.pend;
  if (!killer) { ktr = { t: me.t, v: me.v }; kind = 'world'; }
  else if (killer === PLAYER_ENT) { const t0 = R.tracks.get(PLAYER_ENT); if (t0) { ktr = { t: t0.t, v: t0.v }; kind = 'me'; } }
  else if (killer.remote) { const st = netTrack(killer, deathT, I.wall);
    if (pend && pend.ent === killer && pend.got && pend.death && pend.death.t === deathT) { ktr = withTail(pend.got, st); kind = 'net'; } else { ktr = st; if (ktr) kind = 'net'; } }
  if (!ktr) { const t0 = R.tracks.get(killer); if (!t0) return null; ktr = { t: t0.t, v: t0.v }; }   // live reference: post-death samples keep coming in
  if (ktr.t.length < 8) return null;
  const orbit = BLAST.has(I.weapon) || !killer;   // grenades, rockets, the charge: a third-person orbit around the blast
  const c = { I, killer, victim, kind, ktr, deathT, t1: deathT + POST + (orbit ? .5 : 0), weapon: I.weapon, crit: !!I.crit, hp: Math.max(0, Math.ceil(I.hp || 0)), me, final: !!I.final, orbit, hi: !!ktr.hi, dist: I.dist || 0 };
  c.skin = I.skin || 'factory'; if (ktr.fin && ktr.fin[I.weapon]) c.skin = ktr.fin[I.weapon];
  c.fin = Object.assign({}, ktr.fin || {}); if (!NOFIN.has(I.weapon) && c.skin !== 'factory') c.fin[I.weapon] = c.fin[I.weapon] || c.skin;
  // how much history fits before the respawn: slow-motion part costs more real time
  let slowCost = 0; for (let rt = c.deathT - SLOW_PRE - .15; rt < c.t1; rt += 1 / 480) slowCost += 1 / 480 / speedAt(rt, c);
  const avail = c.final ? FINAL_LEN : RS - DCT - END_PAD;
  let t0 = c.deathT - SLOW_PRE - .15 - (avail - slowCost);
  // never show anything from before the victim's or the killer's last (re)spawn: no corpse, no teleport inside the replay
  t0 = Math.max(t0, ktr.t[0] + .06, me.t[0] + .06, lastSpawn(me, deathT) + .08, orbit ? -1e9 : lastSpawn(ktr, deathT) + .08);
  c.minT0 = Math.max(ktr.t[0] + .06, me.t[0] + .06, lastSpawn(me, deathT) + .08, orbit ? -1e9 : lastSpawn(ktr, deathT) + .08);   // (tests: the oldest footage that exists)
  if (t0 > deathT - .45) return null;          // too little footage (killed right after spawning): normal death cam
  c.t0 = t0;
  // real time -> replay time table (smooth slow motion, same every run)
  const tab = [t0]; let rt = t0; while (rt < c.t1) { rt = Math.min(c.t1, rt + speedAt(rt, c) / 240); tab.push(rt); }
  c.tab = tab; c.dur = (tab.length - 1) / 240;
  // the killer's events
  if (kind === 'bot' || kind === 'me') {
    const inW = e => e.ent === killer && e.t >= t0 - .5 && e.t <= c.t1 + .1;
    c.fires = (kind === 'me' ? R.shots : R.fires).filter(inW).map(e => e.t).filter((t, i, a) => i === 0 || t !== a[i - 1]);
    c.kshots = R.shots.filter(inW).map(s => ({ t: s.t, b: s.b, c: s.c, w: s.w, l: s.l, wid: s.boom ? 'boomerang' : null }));
    c.khits = R.hits.filter(inW).map(h => ({ t: h.t, crit: h.crit, kill: h.kill }));
    c.kthrows = R.throws.filter(inW).map(e => e.t);
    c.victimDelay = 0;
  } else {
    c.fires = ktr.fires; c.kshots = ktr.shots.map(s => ({ t: s.t, b: s.b, c: null, w: 0, l: 0, wid: s.w })); c.khits = ktr.hits; c.kthrows = ktr.throws;
    // what they saw of you was older than what you saw: their interpolation delay + the network both ways
    const myPing = NET.room && NET.room.ping ? +NET.room.ping() || 0 : 0;
    c.victimDelay = victim === PLAYER_ENT ? clamp(((killer.target || 100) + myPing + (+killer.ping || 0)) / 1000, .04, .4) : 0;
  }
  if (c.weapon === 'boomerang' && c.kind === 'net' && !c.fires.some(f => f <= deathT && f > deathT - BOOM_FLY)) { c.fires = c.fires.slice(); c.fires.push(deathT - .7); c.fires.sort((x, y) => x - y); }   // throw never reached us: the blade left ~0.7 s before it landed
  if (!c.khits.some(h => h.kill)) c.khits.push({ t: deathT, crit: c.crit, kill: true });   // grenade/rocket kills: the blast is the hit
  // a hit always comes from a shot: if a shot's state never reached us (states are merged in bundles), add it at the hit
  if (c.kind === 'net' && WEAPONS[c.weapon] && c.weapon !== 'knife' && !WEAPONS[c.weapon].projectile && WEAPONS[c.weapon].mode !== 'proj' && c.weapon !== 'boomerang') {
    c.fires = c.fires.slice(); c.kshots = c.kshots.slice();
    for (const h of c.khits) if (!c.fires.some(f => f >= h.t - .25 && f <= h.t + .02)) { lin(me, h.t, SA); c.fires.push(h.t); c.kshots.push({ t: h.t, b: new THREE.Vector3(SA[0], SA[1] + 1.25, SA[2]), c: null, w: 0, l: 0, wid: c.weapon }); }
    c.fires.sort((x, y) => x - y);
  }
  c.oshots = R.shots.filter(s => s.ent !== killer && s.t >= t0 - .05 && s.t <= c.t1 + .05);
  c.booms = R.booms.filter(b => b.t >= t0 - .05 && b.t <= c.t1 + .05);
  c.proj = R.proj.filter(f => f.t >= t0 - .2 && f.t <= c.t1 + .2);
  c.fireMap = new Map(); for (const f of R.fires) if (f.t >= t0 - .5) { const a = c.fireMap.get(f.ent) || []; a.push(f.t); c.fireMap.set(f.ent, a); }
  c.ofires = []; for (const f of R.fires) if (f.ent !== killer && f.t > t0 && f.t <= c.t1) c.ofires.push({ t: f.t, ent: f.ent });
  if (killer !== PLAYER_ENT) { let lt = -9; for (const q of R.shots) if (q.ent === PLAYER_ENT && q.t > t0 && q.t <= c.t1 && q.t !== lt) { lt = q.t; c.ofires.push({ t: q.t, ent: PLAYER_ENT }); } }
  c.ofires.sort((a, b) => a.t - b.t);
  c.cast = [victim]; for (const [ent, tr] of R.tracks) if (ent !== victim && (ent !== killer || orbit) && tr.t.length && tr.t[tr.t.length - 1] >= t0 && tr.t[0] <= c.t1) c.cast.push(ent);
  return c;
}

/* ================= HUD ================= */
let D0 = null;
function dom() {
  if (D0) return D0;
  const kc = $('killcam'); if (!kc) return null;
  const st = document.createElement('style'); st.id = 'kcStyle';
  st.textContent = `#killcam{--kcc:#ff4a3d}
body.kcFinal #rfx .rfx-final,body.kcFinal #mend{display:none!important}
#death.kc #deathBy{display:none}
#kcBan{position:absolute;left:50%;bottom:calc(12vh + 30px);transform:translateX(-50%);display:flex;align-items:stretch;max-width:calc(100vw - 32px);background:rgba(11,13,16,.84);border:1px solid rgba(255,255,255,.08);border-left:4px solid var(--kcc);box-shadow:0 6px 24px rgba(0,0,0,.45);font-family:var(--mono,ui-monospace,monospace)}
#kcBan>div{padding:8px 14px;display:flex;flex-direction:column;justify-content:center;gap:3px;min-width:0}
#kcBan small{font-size:10px;letter-spacing:.2em;color:var(--dim,#9aa3ad);white-space:nowrap}
#kcBan b{font-family:var(--display,inherit);font-size:22px;letter-spacing:.04em;color:var(--kcc);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:42vw}
#kcBan .kw{border-left:1px solid rgba(255,255,255,.08);color:var(--ink,#e8edf2)}#kcBan .kw span{display:flex;align-items:center;gap:8px;font-size:13px;letter-spacing:.06em;white-space:nowrap}
#kcBan .kw svg{width:34px;height:12px;flex:none}
#kcBan em{font-style:normal;font-size:10px;font-weight:700;letter-spacing:.18em;color:#120a00;background:#ffd27a;padding:2px 6px;align-self:flex-start}#kcBan em[hidden]{display:none}
#kcBan .kh{border-left:1px solid rgba(255,255,255,.08);min-width:86px}#kcBan .kh i{display:block;height:5px;background:rgba(255,255,255,.12)}#kcBan .kh s{display:block;height:100%;background:#5dff9a;transform-origin:left}
#kcBan .kh span{font-size:12px;letter-spacing:.08em;color:var(--ink,#e8edf2);white-space:nowrap}
#kcBan .kf,#kcCard .kf{display:flex;align-items:center;gap:6px;font-size:11px;letter-spacing:.08em;white-space:nowrap;color:var(--rc,#b8c0cc)}#kcBan .kf[hidden],#kcCard .kf[hidden]{display:none}
#kcBan .kf i,#kcCard .kf i{width:7px;height:7px;transform:rotate(45deg);background:var(--rc,#b8c0cc);box-shadow:0 0 6px var(--rc,#b8c0cc);flex:none}
#kcBan .kf small,#kcCard .kf small{font-size:9px;letter-spacing:.18em;color:var(--dim,#9aa3ad)}
#kcBan .kd{border-left:1px solid rgba(255,255,255,.08);min-width:56px}#kcBan .kd span{font-size:13px;letter-spacing:.06em;color:var(--ink,#e8edf2)}#kcBan .kd[hidden]{display:none}
#kcCard{display:flex;align-items:stretch;background:rgba(11,13,16,.84);border:1px solid rgba(255,255,255,.08);border-left:4px solid var(--kcc,#ff4a3d);font-family:var(--mono,ui-monospace,monospace);max-width:calc(100vw - 32px);box-shadow:0 6px 24px rgba(0,0,0,.45)}
#kcCard[hidden],#death.kc #kcCard{display:none}#death.kcc #deathBy{display:none}
#kcCard>div{padding:8px 14px;display:flex;flex-direction:column;justify-content:center;gap:3px;min-width:0}#kcCard>div+div{border-left:1px solid rgba(255,255,255,.08)}#kcCard>div[hidden]{display:none}
#kcCard small{font-size:10px;letter-spacing:.2em;color:var(--dim,#9aa3ad);white-space:nowrap}#kcCard b{font-family:var(--display,inherit);font-size:22px;letter-spacing:.04em;color:var(--kcc,#ff4a3d);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40vw}
#kcCard .kw{display:flex;align-items:center;gap:8px;font-size:13px;letter-spacing:.06em;white-space:nowrap;color:var(--ink,#e8edf2)}#kcCard .kw svg{width:34px;height:12px;flex:none}
#kcCard em{font-style:normal;font-size:10px;font-weight:700;letter-spacing:.18em;color:#120a00;background:#ffd27a;padding:2px 6px;align-self:flex-start}#kcCard em[hidden]{display:none}
#kcCard span.hp{font-size:12px;letter-spacing:.08em;color:var(--ink,#e8edf2);white-space:nowrap}
#kcSkip{position:absolute;right:calc(16px + env(safe-area-inset-right,0px));bottom:calc(12vh + 34px);pointer-events:auto;cursor:pointer;background:rgba(11,13,16,.78);color:var(--ink,#e8edf2);border:1px solid rgba(255,255,255,.18);padding:7px 12px;font:600 12px/1 var(--mono,ui-monospace,monospace);letter-spacing:.12em}
#kcSkip kbd{font:inherit;color:var(--sodium,#ffb84a);margin-right:6px}
#kcHm{position:absolute;left:50%;top:50%;width:0;height:0;opacity:0}#kcHm i{position:absolute;width:2px;height:10px;background:#fff;left:-1px;top:-5px;box-shadow:0 0 0 1px rgba(0,0,0,.4)}
#kcHm.crit i{background:#ffd27a}#kcHm.kill i{background:#ff4a3d;height:14px;top:-7px;width:3px;left:-1.5px}
#kcFx{position:absolute;inset:0;pointer-events:none;opacity:0;background:radial-gradient(ellipse at center,rgba(255,60,40,0) 40%,rgba(255,40,30,.55))}
#kcYou{position:absolute;left:0;top:0;transform:translate(-50%,-100%);font:700 10px/1 var(--mono,ui-monospace,monospace);letter-spacing:.18em;color:#fff;text-shadow:0 1px 2px #000;display:flex;flex-direction:column;align-items:center;gap:2px;opacity:0;will-change:transform}
#kcYou i{width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-top:7px solid var(--yc,#ff8a3d);filter:drop-shadow(0 1px 1px #000)}
#kcDown{position:absolute;left:50%;top:calc(130px + env(safe-area-inset-top,0px));transform:translateX(-50%);font:700 12px/1 var(--mono,ui-monospace,monospace);letter-spacing:.2em;color:#ffd27a;background:rgba(11,13,16,.7);padding:5px 10px}#kcDown[hidden]{display:none}
@media (max-width:560px){#kcBan b{font-size:17px;max-width:34vw}#kcBan>div{padding:7px 9px}#kcBan .kh{min-width:64px}#kcBan .kw svg{display:none}#kcBan .kd{display:none}#kcBan .kf small{display:none}#kcCard b{font-size:17px}#kcCard>div{padding:7px 9px}#kcCard .kw svg{display:none}#kcCard .kd{display:none}#kcCard .kf small{display:none}#kcSkip{bottom:calc(12vh + 118px);right:50%;transform:translateX(50%)}}`;
  document.head.appendChild(st);
  const hm = '<i style="transform:rotate(45deg) translateY(-10px)"></i><i style="transform:rotate(135deg) translateY(-10px)"></i><i style="transform:rotate(225deg) translateY(-10px)"></i><i style="transform:rotate(315deg) translateY(-10px)"></i>';
  kc.insertAdjacentHTML('beforeend', `<div id="kcYou"><span></span><i></i></div><div id="kcHm">${hm}</div><div id="kcDown" hidden>KILLER DOWN</div><div id="kcBan"><div><small>KILLED BY</small><b id="kcBName"></b></div><div class="kw"><span id="kcBW"></span><span class="kf" id="kcBF" hidden><i></i><span></span><small></small></span><em id="kcBHs" hidden>HEADSHOT</em></div><div class="kh"><small>THEIR HP</small><i><s id="kcBHp"></s></i><span id="kcBHpT"></span></div><div class="kd"><small>DISTANCE</small><span id="kcBD"></span></div></div><button id="kcSkip" type="button"><kbd>SPACE</kbd>SKIP</button><div id="kcFx"></div>`);
  $('kcSkip').addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); skip(); });
  $('kcSkip').addEventListener('pointerdown', e => e.stopPropagation());
  D0 = { kc, you: $('kcYou'), hm: $('kcHm'), fx: $('kcFx'), down: $('kcDown'), cross: $('kcCross'), xi: [...$('kcCross').children] };
  return D0;
}
const WNAME = { nade: 'Plasma grenade', nova: 'Nova launcher', charge: 'The charge', ftspit: 'Flytrap spit', ftpoison: 'Flytrap poison' };
const wTitle = w => (WEAPONS[w] && WEAPONS[w].name) || WNAME[w] || String(w || '');
const wIcon = w => (typeof ICON === 'object' && (ICON[w] || ((w === 'ftspit' || w === 'ftpoison') && ICON.flytrap) || ICON.rifle)) || '';
// "what killed you": weapon icon + name + its finish (name in the finish's rarity colour); the same on the death card and the killcam banner
function fillWeapon(elW, elF, w, skin) {
  elW.innerHTML = wIcon(w) + '<span></span>'; elW.lastChild.textContent = wTitle(w);
  const si = skinInfo(skin); elF.hidden = !si;
  if (si) { elF.style.setProperty('--rc', si.col); elF.children[1].textContent = si.name; elF.children[2].textContent = String(si.rarity || '').toUpperCase(); elF.title = si.rarity + ' finish'; }
  return si;
}
function fillBanner(c) {
  const d = dom(); if (!d) return; const k = c.killer || { name: wTitle(c.weapon).toUpperCase(), cssCol: '#ffb84a', hp: 0 };
  d.kc.style.setProperty('--kcc', k.cssCol || '#ff4a3d');
  $('kcBName').textContent = String(k.name || 'Enemy');
  $('kcBan').firstChild.firstChild.textContent = c.final ? `FINAL KILL ON ${String(c.victim.name || '').toUpperCase()}` : 'KILLED BY';
  const tb = $('killcam').querySelector('.kc-top b'); if (tb) tb.textContent = c.final ? 'FINAL KILLCAM' : c.orbit ? 'BLAST REPLAY' : 'KILLCAM';
  const si = fillWeapon($('kcBW'), $('kcBF'), c.weapon, c.skin);
  KC.shown = { killer: String(k.name || ''), weapon: c.weapon, title: wTitle(c.weapon), skin: c.skin || 'factory', fin: si, dist: Math.round(c.dist || 0), orbit: !!c.orbit, hi: !!c.hi };
  $('kcBHs').hidden = !c.crit; $('kcBHs').textContent = c.weapon === 'knife' ? 'BACKSTAB' : 'HEADSHOT';
  const hp = clamp(c.hp, 0, 100); $('kcBan').querySelector('.kh small').textContent = c.killer === PLAYER_ENT ? 'YOUR HP' : 'THEIR HP'; $('kcBan').querySelector('.kh').hidden = !c.killer; $('kcBHp').style.transform = `scaleX(${hp / 100})`; $('kcBHp').style.background = hp > 50 ? '#5dff9a' : hp > 25 ? '#ffd166' : '#ff6b5d';
  $('kcBHpT').textContent = c.hp > 0 ? `${c.hp} HP` : 'DOWN';
  $('kcBD').textContent = c.dist > 0 ? `${Math.round(c.dist)} m` : '-'; $('kcBD').parentNode.hidden = !(c.dist > 0);
  $('kcName').textContent = String(k.name || ''); $('kcName').style.color = k.cssCol || '';
  d.cross.style.color = k.cssCol || '#fff';
}
// the death screen's killer card (shown while you fall, and instead of the killcam when there is none)
function deathCard(D) {
  const el = $('death'); if (!el) return; dom();
  let card = $('kcCard');
  if (!card) { el.insertAdjacentHTML('beforeend', '<div id="kcCard" hidden><div><small>KILLED BY</small><b id="kcCName"></b></div><div><span class="kw" id="kcCW"></span><span class="kf" id="kcCF" hidden><i></i><span></span><small></small></span><em id="kcCHs" hidden>HEADSHOT</em></div><div><small>THEIR HP</small><span class="hp" id="kcCHp"></span></div><div class="kd"><small>DISTANCE</small><span class="hp" id="kcCD"></span></div></div>');
    card = $('kcCard'); const t = $('deathT'); if (t) el.insertBefore(card, t); }
  const k = D && D.killer;
  if (!k || k === PLAYER_ENT) { card.hidden = true; el.classList.remove('kcc'); KC.card = null; return; }
  card.style.setProperty('--kcc', k.cssCol || '#ff4a3d'); $('kcCName').textContent = String(k.name || 'Enemy');
  const si = fillWeapon($('kcCW'), $('kcCF'), D.weapon, D.skin);
  $('kcCHs').hidden = !D.crit; $('kcCHs').textContent = D.weapon === 'knife' ? 'BACKSTAB' : 'HEADSHOT'; const hp = Math.max(0, Math.ceil(D.hp || 0)); $('kcCHp').textContent = hp > 0 ? `${hp} HP` : 'DOWN';
  $('kcCD').textContent = D.dist > 0 ? `${Math.round(D.dist)} m` : '-'; $('kcCD').parentNode.hidden = !(D.dist > 0);
  card.hidden = false; el.classList.add('kcc');
  KC.card = { killer: String(k.name || ''), weapon: D.weapon, title: wTitle(D.weapon), skin: D.skin || 'factory', fin: si, dist: Math.round(D.dist || 0) };
}

/* ================= start / stop / skip ================= */
const DCT0 = DC.T;
const _startKillcam = startKillcam;
startKillcam = function (killer) {
  REC.on = false; KC.clip = null; KC.live = false; KC.skipped = false; DC.T = DCT0;
  const D = R.death; let c = null;
  if (window.SPECTATE && window.SPECTATE.on) return;   // watching as a spectator: no killcam
  const world = D && !D.killer && BLAST.has(D.weapon);  // the demolition charge (no killer): orbit replay of the blast
  try { if (D && ((killer && killer !== PLAYER_ENT) || world)) c = makeClip({ killer: world ? null : killer, victim: PLAYER_ENT, t: D.t, wall: D.wall, weapon: D.weapon, crit: D.crit, hp: D.hp, dist: D.dist, skin: D.skin }); } catch (e) { warnOnce(e); c = null; }
  KC.lastMiss = c ? null : { why: !D ? 'no death' : !killer && !world ? 'no killer' : 'no footage', t: D && D.t };
  if (!c) return;                                   // self, world, no footage: the normal death cam shows instead
  KC.clip = c; KC.first = true; KC.rt = c.t0; KC.lastRt = c.t0 - 1e-4; KC.bob = 0; KC.hmT = 0; KC.started = performance.now();
  DC.T = Math.max(DCT, RS - END_PAD - c.dur);      // short footage: the death cam simply runs a bit longer
  REC.on = true; REC.deathT = c.deathT; REC.killer = killer; REC.ki = robots.indexOf(killer); REC.lastRt = -1e9;
  KC.hpKey = null; fillBanner(c); if (KC.log) KC.log.length = 0; if (KC.snd) KC.snd.length = 0;
  // after the actors are built (one per frame), before the replay: build + compile, then draw it off screen at a few moments
  // (one step per task, ~a frame apart, so the death cam never stalls on all of it at once)
  const warm = () => { try { const k = KC.clip; if (k && k.deathT === c.deathT && !KC.live && warmStep(k)) setTimeout(warm, 16); } catch (e) { warnOnce(e); } };
  setTimeout(warm, Math.max(100, (DC.T - .45) * 1000));
};
const _stopKillcam = stopKillcam;
stopKillcam = function () {
  const was = REC.on || KC.clip; REC.on = false; KC.live = false; KC.inReplay = false;
  hideGhosts(); hideProxies();
  if ($('scope')) setStyle($('scope'), 'opacity', '0');
  if ($('killcam')) $('killcam').hidden = true; if ($('death')) $('death').classList.remove('kc'); if ($('hud')) $('hud').classList.remove('kcview');
  if (D0) { D0.fx.style.opacity = '0'; D0.hm.style.opacity = '0'; D0.down.hidden = true; D0.you.style.opacity = '0'; } KC.youSet = false;
  if (was && camera.fov < 40) { camera.fov = 62; camera.updateProjectionMatrix(); }
  DC.T = DCT0; KC.clip = null; if (!KC.fin) duck(false);
  vmRestore(); restoreHands();
};
// the killer's finish on the first-person gun during the replay; your own finishes come back afterwards
function vmFinish(vm, kw, c) {
  const gs = GS(); if (!gs || !vm || !vm.group) return; const want = (c.fin && c.fin[kw]) || 'factory', g = vm.group;
  if ((g.userData.gsSkin || 'factory') === want && g.userData.gsTemp) return;
  if ((g.userData.gsSkin || 'factory') === want && !KC.vmTouched) return;
  (KC.vmTouched || (KC.vmTouched = new Set())).add(kw); g.userData.gsTemp = true;
  try { gs.apply(kw, want, g); } catch (e) { warnOnce(e); }
}
// put the killer's finish on their gun and compile it now, during the death cam, not on the first replay frame (a hitch)
function prewarm(c) {
  if (!c) return; const t0 = performance.now(), ws = new Set(c.orbit ? [] : [c.weapon]);
  try { const K = c.ktr; for (let i = 0; i < K.t.length; i += 6) if (K.t[i] >= c.t0) ws.add(wname(K.v[i * S_ + 8])); } catch (e) {}
  const shown = [], gh = [], extra = [];
  try { buildGhosts(99);
    // every gun an actor holds during the clip is built (and its finish applied) now, not when they switch to it mid-replay
    for (const ent of c.cast) { const g = GH.get(ent), tr = ent === c.victim ? c.me : R.tracks.get(ent); if (!g || !tr) continue; const w0 = g.curW, seen = new Set();
      for (let i = 0; i < tr.t.length; i += 4) if (tr.t[i] >= c.t0 - .1 && tr.t[i] <= c.t1) { const w = wname(tr.v[i * S_ + 8]); if (!seen.has(w)) { seen.add(w); setGhostWeapon(g, w); } }
      if (w0) setGhostWeapon(g, w0); }
    for (const g of GH.values()) if (g.kcScene === scene && !g.root.visible) { g.root.visible = true; g.gun.visible = true; g.root.position.y -= 400; g.gun.position.y -= 400; gh.push(g);
      for (const k in g.guns) if (g.guns[k] !== g.gunInner && !g.guns[k].parent) { g.gun.add(g.guns[k]); extra.push(g.guns[k]); } } } catch (e) { warnOnce(e); }
  for (const w of ws) { const vm = WM[w]; if (!vm || !vm.group) continue; vmFinish(vm, w, c); if (!vm.group.visible) { vm.group.visible = true; shown.push(vm.group); } }
  try { if (shown.length && typeof renderer === 'object' && renderer.compile && typeof gunScene === 'object') { const prev = renderer.getRenderTarget(); if (typeof rt === 'object' && rt && rt.isWebGLRenderTarget) renderer.setRenderTarget(rt); renderer.compile(gunScene, gunCam); renderer.setRenderTarget(prev); } } catch (e) { warnOnce(e); }
  try { if (gh.length && renderer.compile) { const prev = renderer.getRenderTarget(); if (typeof rt === 'object' && rt && rt.isWebGLRenderTarget) renderer.setRenderTarget(rt); renderer.compile(scene, camera); renderer.setRenderTarget(prev); } } catch (e) { warnOnce(e); }
  for (const m of extra) if (m.parent) m.parent.remove(m);
  for (const g of gh) { g.root.visible = false; g.gun.visible = false; g.root.position.y += 400; g.gun.position.y += 400; }
  for (const g of shown) g.visible = false;
  KC.warmMs = performance.now() - t0;
}
function vmRestore() {
  if (!KC.vmTouched) return; const S = KC.vmTouched; KC.vmTouched = null;
  for (const w of S) { const g = WM[w] && WM[w].group; if (g) g.userData.gsTemp = false; }
  try { const gs = GS(); if (gs && gs._refresh) gs._refresh(); } catch (e) { warnOnce(e); }
}
function skip() {
  if (KC.fin) { endFinal(); return; }
  if (state !== 'dead' || !REC.on || !KC.clip) return;
  const k = KC.clip.killer; KC.skipped = true; stopKillcam();
  // back to your body, watching the killer live until the respawn (which comes no later than before)
  camera.position.set(P.pos.x, P.pos.y + 2.4, P.pos.z); if (k && !k.dead && k.root) camera.lookAt(k.root.position.x, k.root.position.y + 1.3, k.root.position.z);
  camera.fov = 62; camera.updateProjectionMatrix(); $('death').hidden = false;
}
KC.skip = skip;
addEventListener('keydown', e => { if (e.code === 'Space' && state === 'dead' && KC.live) { e.preventDefault(); skip(); setTimeout(() => { if (keys) keys[e.code] = false; }, 0); } });

/* ================= replay audio =================
   The live game is muted while the replay is on screen (master ducked to 0), and the replay plays on its own bus
   (own compressor, reverb and echo) straight into the output: the killer's own gun close and dry like your own gun,
   every shot at the moment its muzzle flash shows, hit-confirms on you, their footsteps / reload / scope / throws,
   the kill and your death sound once. Everything is a pre-rendered buffer, so slow motion plays it slowed and
   pitched down by exactly the replay speed. Live sound comes back as soon as the replay ends. */
const AUD = { out: null, dry: null, verb: null, echo: null, ctx: null, buf: {}, pre: false, srcs: new Set(), ducked: false };
const PRE = { step: ['step', [false, false, false], .4], stepSprint: ['step', [true, false, false], .4], stepCrouch: ['step', [false, false, true], .4], land: ['step', [false, true, false], .5],
  magOut: ['magOut', [], .4], magIn: ['magIn', [], .4], bolt: ['bolt', [], .4], adsIn: ['adsIn', [], .3], knifeSwing: ['knifeSwing', [false], .5], knifeHit: ['knifeHit', [], .5],
  nadeThrow: ['nadeThrow', [null], .4], explode: ['explode', [null], 2.2], death: ['death', [], 2.2], kill: ['killConfirm', [false, 1], 1.4], killHead: ['killConfirm', [true, 1], 1.6] };
// render one of the game's own synthesised sounds into a buffer (same recipe, so it sounds exactly like the live game)
function renderSfx(name, args, dur) {
  const sr = AU.ctx.sampleRate, off = new OfflineAudioContext(2, Math.ceil(sr * dur), sr), dst = off.destination;
  const dry = off.createGain(); dry.connect(dst);
  const verb = off.createConvolver(); verb.buffer = AU.verb.buffer; const vg = off.createGain(); vg.gain.value = .3; verb.connect(vg); vg.connect(dst);
  const echo = off.createDelay(1); echo.delayTime.value = .27; const fb = off.createGain(), lp = off.createBiquadFilter(); fb.gain.value = .28; lp.type = 'lowpass'; lp.frequency.value = 1400;
  echo.connect(lp); lp.connect(fb); fb.connect(echo); const eo = off.createGain(); eo.gain.value = .2; lp.connect(eo); eo.connect(dst);
  const S = { ctx: AU.ctx, dry: AU.dry, master: AU.master, verb: AU.verb, echo: AU.echo };
  Object.assign(AU, { ctx: off, dry, master: dry, verb, echo });
  try { sfx[name].apply(sfx, args); } finally { Object.assign(AU, S); }
  return off.startRendering();
}
function prerender() {
  AUD.pre = true; if (typeof OfflineAudioContext === 'undefined' || !AU.verb) return;
  for (const k in PRE) { const [n, a, d] = PRE[k]; if (!sfx[n]) continue; try { renderSfx(n, a, d).then(b => { AUD.buf[k] = b; }).catch(() => {}); } catch (e) { warnOnce(e); } }
}
function audioBus() {
  if (!AU.ctx || !AU.out || !AU.verb) return false;
  if (AUD.ctx === AU.ctx && AUD.out) return true;
  const c = AU.ctx; AUD.ctx = c;
  const comp = c.createDynamicsCompressor(); comp.threshold.value = -9; comp.knee.value = 10; comp.ratio.value = 3; comp.attack.value = .003; comp.release.value = .3; comp.connect(AU.out);
  AUD.out = c.createGain(); AUD.out.gain.value = 0; AUD.out.connect(comp);
  AUD.dry = c.createGain(); AUD.dry.connect(AUD.out);
  AUD.verb = c.createConvolver(); AUD.verb.buffer = AU.verb.buffer; const vg = c.createGain(); vg.gain.value = .3; AUD.verb.connect(vg); vg.connect(AUD.out);
  AUD.echo = c.createDelay(1); AUD.echo.delayTime.value = .27; const fb = c.createGain(), lp = c.createBiquadFilter(); fb.gain.value = .28; lp.type = 'lowpass'; lp.frequency.value = 1400;
  AUD.echo.connect(lp); lp.connect(fb); fb.connect(AUD.echo); const eo = c.createGain(); eo.gain.value = .2; lp.connect(eo); eo.connect(AUD.out);
  AUD.tap = c.createAnalyser(); AUD.tap.fftSize = 1024; AUD.out.connect(AUD.tap);   // (tests listen here)
  if (!AUD.pre) prerender();
  return true;
}
function duck(on) {
  if (!AU.ctx || !AU.master || !audioBus()) return;
  const t = AU.ctx.currentTime, m = AU.master.gain, o = AUD.out.gain, vol = CFG.vol;
  if (on && !AUD.ducked) { AUD.ducked = true; m.cancelScheduledValues(t); m.setValueAtTime(m.value, t); m.linearRampToValueAtTime(0, t + .06); o.cancelScheduledValues(t); o.setValueAtTime(o.value, t); o.linearRampToValueAtTime(vol, t + .04); }
  else if (!on && AUD.ducked) { AUD.ducked = false; m.cancelScheduledValues(t); m.setValueAtTime(m.value, t); m.linearRampToValueAtTime(vol, t + .12); o.cancelScheduledValues(t); o.setValueAtTime(o.value, t); o.linearRampToValueAtTime(0, t + .1);
    const S = [...AUD.srcs]; AUD.srcs.clear(); for (const x of S) { try { x.stop(t + .12); } catch (e) {} }
    // failsafe: the game's sound must never stay ducked after a replay (any interrupted ramp)
    setTimeout(() => { try { if (!AUD.ducked && AU.ctx && AU.master && Math.abs(AU.master.gain.value - CFG.vol) > .02) { const n = AU.ctx.currentTime; AU.master.gain.cancelScheduledValues(n); AU.master.gain.setValueAtTime(CFG.vol, n); } } catch (e) {} }, 500); }
}
KC.audio = AUD;
// route the game's own sound helpers (bus/nz/osc) onto the replay bus for one call
function onKc(fn) { const S = [AU.dry, AU.master, AU.verb, AU.echo]; AU.dry = AUD.dry; AU.master = AUD.dry; AU.verb = AUD.verb; AU.echo = AUD.echo; try { return fn(); } finally { [AU.dry, AU.master, AU.verb, AU.echo] = S; } }
function playBuf(buf, o, logInfo) {
  if (!buf || !AUD.out || !AU.ctx) return null;
  const c = AU.ctx, src = c.createBufferSource(); src.buffer = buf; src.playbackRate.value = o.rate || 1;
  const d = onKc(() => bus({ pos: o.pos || null, verb: o.verb || 0, echo: o.echo || 0, ref: o.ref || 5, vol: o.vol || 1 }));
  let head = src; if (o.pos && o.lp) { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = o.lp; src.connect(f); head = f; }
  if (head !== src) head.connect(d); else src.connect(d);
  const when = c.currentTime + Math.max(0, o.delay || 0); src.start(when); AUD.srcs.add(src); src.onended = () => AUD.srcs.delete(src);
  if (KC.snd) KC.snd.push(Object.assign({ wall: performance.now(), when, ctxNow: c.currentTime, delay: when - c.currentTime, rate: o.rate || 1 }, logInfo));
  return when;
}
function gunSound(wid, o, who) {   // a weapon's own voice (WEAPONS[id].sound), pre-rendered by the game
  const W = WEAPONS[wid] || {}, name = W.sound || (wid === 'knife' ? null : 'shot'); if (!name || !GUN_VOICE[name]) return null;
  if (!GSND[name]) GSND[name] = gsBuild(GUN_VOICE[name].dur, GUN_VOICE[name].fn);
  const v = GUN_VOICE[name];
  return playBuf(GSND[name], { rate: o.rate * rand(.97, 1.03), pos: o.pos, lp: o.pos ? clamp(16000 - camera.position.distanceTo(o.pos) * 220, 1800, 16000) : 0, verb: o.pos ? v.verb * .7 : v.verb, echo: v.echo, vol: v.vol * (o.vol || 1), delay: o.delay }, { kind: 'gun', name, wid, who, t: o.t });
}
function fxSound(key, o, kind) { return playBuf(AUD.buf[key], o, { kind: kind || key, name: key, who: o.who || 'killer', t: o.t }); }

/* ================= replay frame ================= */
const live = { bots: [], misc: [], vm: null };
const LVM = { gv: false, vis: [], vm: null, pos: new THREE.Vector3(), rot: new THREE.Euler(), fl: false, ret: null, rear: null, hasMag: false, magP: new THREE.Vector3(), magV: false, hasArm: false, arm: new THREE.Vector3() };
function hideGhosts() { for (const g of GH.values()) { g.root.visible = false; g.gun.visible = false; } }
const PX = new Map();
function hideProxies() { for (const m of PX.values()) m.visible = false; }
function proxyFor(id, src) {
  let m = PX.get(id); if (m && m.parent !== scene) { PX.delete(id); m = null; }
  if (!m) { m = src.clone(); m.visible = false; scene.add(m); PX.set(id, m); if (PX.size > 40) { const [k0, m0] = PX.entries().next().value; scene.remove(m0); PX.delete(k0); } }
  return m;
}
function hideLive() {
  live.bots.length = 0; live.misc.length = 0;
  for (const r of robots) { live.bots.push(r, r.root.visible, r.gun.visible); r.root.visible = false; r.gun.visible = false; }
  const hideObj = o => { if (o && o.visible) { live.misc.push(o); o.visible = false; } };
  hideObj(DC.body); hideObj(DC.gun); if (REC.avatar) { hideObj(REC.avatar.g); hideObj(REC.avatar.gun); }
  for (const n of NADES) hideObj(n.m); for (const q of ROCKETS) hideObj(q.m); for (const q of PROJ) hideObj(q.m);
}
function showLive() {
  for (let i = 0; i < live.bots.length; i += 3) { const r = live.bots[i]; r.root.visible = live.bots[i + 1]; r.gun.visible = live.bots[i + 2]; }
  for (const o of live.misc) o.visible = true; live.bots.length = 0; live.misc.length = 0;
}
function rtAt(el, c) { const x = el * 240, i = Math.floor(x); if (i >= c.tab.length - 1) return c.t1; if (i < 0) return c.t0; return c.tab[i] + (c.tab[i + 1] - c.tab[i]) * (x - i); }
function kickAt(rt, fires) {   // recoil as a smooth pulse per shot (rises in ~15 ms, settles in ~0.3 s)
  let k = 0; for (let i = fires.length - 1; i >= 0; i--) { const d = rt - fires[i]; if (d < 0) continue; if (d > .5) break; k += Math.exp(-d * 13) * (1 - Math.exp(-d * 70)); }
  return Math.min(k, 1.8);
}
const VIEW = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
// someone else's shot that flies past the killer's head: drawn through the lens it filled the screen with a giant white wedge
// (the beam is a few cm wide, a few cm from the eye). Like any shooter, a tracer stops 1.5 m before it reaches the camera.
const _nb = new THREE.Vector3(), _nd = new THREE.Vector3(), _nc = new THREE.Vector3();
function nearCam(a, b) {
  const L = _nd.subVectors(b, a).length(); if (L < 1e-4) return null; _nd.multiplyScalar(1 / L);
  const tc = clamp(_nc.subVectors(camera.position, a).dot(_nd), 0, L); _nb.copy(a).addScaledVector(_nd, tc);
  if (_nb.distanceToSquared(camera.position) > .7 * .7) return b;
  const end = tc - 1.5; return end < 1 ? null : _nb.copy(a).addScaledVector(_nd, end);
}
const _ndc = new THREE.Vector3();
function muzzleWorld(vm, scoped, out) {   // the killer's muzzle as seen on screen, put into the world so tracers leave their gun
  camera.updateMatrixWorld(); const fwd = _c.set(0, 0, -1).applyQuaternion(camera.quaternion);
  if (scoped || !vm || !vm.flash) return out.copy(camera.position).addScaledVector(fwd, 2.2).addScaledVector(_d.set(0, -1, 0).applyQuaternion(camera.quaternion), .05);
  vm.group.updateMatrixWorld(true); gunCam.updateMatrixWorld(); vm.flash.getWorldPosition(_ndc); _ndc.project(gunCam);
  _ndc.z = .5; _ndc.unproject(camera); const dir = _ndc.sub(camera.position).normalize();
  return out.copy(camera.position).addScaledVector(dir, 1.0);
}
function burst(p) {   // a replayed explosion: looks only, no damage
  for (let i = 0; i < 50; i++) { const a = rand(0, 6.28), e = rand(-.2, 1), s = rand(3, 14); FX.spawn(p, Math.cos(a) * s * (1 - e * .5), e * s, Math.sin(a) * s * (1 - e * .5), .5, 2.4, 4, rand(.05, .12), rand(.3, .8), 8, 1.6); }
  for (let i = 0; i < 12; i++) FX.spawn(p, rand(-3, 3), rand(0, 4), rand(-3, 3), 3, 2.2, 4, rand(.6, 1.1), rand(.15, .3), 0, 3, 4);
  for (let i = 0; i < 10; i++) SMOKE.spawn(p, rand(-2, 2), rand(.5, 3), rand(-2, 2), .14, .16, .2, rand(.6, 1.1), rand(1.5, 3), -.4, 1.5, 1.4, .7);
  lightFlash(p, 0x66ccff, 12, 18);
}
const ez = x => x * x * (3 - 2 * x);
/* ---------- camera vs the map: world.colliders are the solid boxes the game collides with ---------- */
const CAM_R = .18;
function unclip(p, footY, walk) {   // push the eye out of any solid box (toward the side the body is on); returns metres moved
  const C = (typeof world === 'object' && world && world.colliders) || []; let moved = 0;
  for (let pass = 0; pass < 2; pass++) for (const b of C) {
    if (b.walk && !walk) continue;
    if (p.x <= b.min.x - CAM_R || p.x >= b.max.x + CAM_R || p.z <= b.min.z - CAM_R || p.z >= b.max.z + CAM_R || p.y <= b.min.y - CAM_R || p.y >= b.max.y + CAM_R) continue;
    if (footY !== undefined && b.max.y <= footY + .35) continue;           // a step / the floor under you
    const down = footY !== undefined && b.min.y > footY + .6 ? p.y - (b.min.y - CAM_R) : 1e9;   // a ceiling over the head: stay under it
    const dx0 = p.x - (b.min.x - CAM_R), dx1 = b.max.x + CAM_R - p.x, dz0 = p.z - (b.min.z - CAM_R), dz1 = b.max.z + CAM_R - p.z, m = Math.min(dx0, dx1, dz0, dz1, down);
    if (m === down) p.y -= down; else if (m === dx0) p.x -= dx0; else if (m === dx1) p.x += dx1; else if (m === dz0) p.z -= dz0; else p.z += dz1;
    moved += m;
  }
  return moved;
}
const BODY_R = .62, KEEP = .95;
// the replay camera never sits inside (or right up against) a body: a knife lunge carries the killer into the victim.
// Pull it back along the view (the target stays in the middle) to ~1 m, like a melee killcam; sideways only if needed
function unclipActors(p, c) {
  let moved = 0; _c.set(0, 0, -1).applyQuaternion(camera.quaternion); let fx = _c.x, fz = _c.z; const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
  for (const g of GH.values()) { if (!g.root.visible || g.kcEnt === c.killer) continue; const q = g.root.position; if (p.y < q.y - .2 || p.y > q.y + 2.1) continue;
    const dx = p.x - q.x, dz = p.z - q.z, d = Math.hypot(dx, dz); if (d >= KEEP) continue;
    // solve |p - s*f - q| = KEEP for s >= 0
    const b = dx * fx + dz * fz, cc = d * d - KEEP * KEEP, disc = b * b - cc;
    if (b <= .05 && disc > 0) { const sb = b + Math.sqrt(disc); p.x -= fx * sb; p.z -= fz * sb; moved += sb; }
    else if (d < BODY_R) { let nx = dx, nz = dz; if (d < 1e-3) { nx = -fx; nz = -fz; } const L = Math.hypot(nx, nz) || 1; p.x = q.x + nx / L * BODY_R; p.z = q.z + nz / L * BODY_R; moved += BODY_R - d; } }
  return moved;
}
function inBody(p, c) {   // test probe
  for (const g of GH.values()) { if (!g.root.visible || g.kcEnt === c.killer) continue; const q = g.root.position; if (Math.hypot(p.x - q.x, p.z - q.z) < BODY_R - .05 && p.y > q.y - .2 && p.y < q.y + 2.1) return true; }
  return false;
}
function inWall(p) {   // test probe: the camera is inside a solid box (not counting its own clearance)
  const C = (typeof world === 'object' && world && world.colliders) || [];
  for (const b of C) if (!b.walk && p.x > b.min.x + .02 && p.x < b.max.x - .02 && p.y > b.min.y + .02 && p.y < b.max.y - .02 && p.z > b.min.z + .02 && p.z < b.max.z - .02) return true;
  return false;
}
function segHit(a, b, walk) {   // first solid box along a -> b (0-1), slab test against the colliders (walk: ramps/stairs count too)
  const C = (typeof world === 'object' && world && world.colliders) || []; let best = 1;
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  for (const B of C) { if (B.walk && !walk) continue; let t0 = 0, t1 = best;
    for (const [o, d, lo, hi] of [[a.x, dx, B.min.x, B.max.x], [a.y, dy, B.min.y, B.max.y], [a.z, dz, B.min.z, B.max.z]]) {
      if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) { t0 = 2; break; } continue; }
      let u = (lo - o) / d, v = (hi - o) / d; if (u > v) { const w = u; u = v; v = w; } t0 = Math.max(t0, u); t1 = Math.min(t1, v); if (t0 > t1) break; }
    if (t0 <= t1 && t0 < best && t0 > 0) best = t0; }
  return best;
}
function orbitPos(O, k, out) { const a = lerp(O.a0, O.a1, k), r = lerp(O.r0, O.r1, k); return out.set(O.center.x + Math.sin(a) * r, O.center.y + lerp(2.6, 1.9, k), O.center.z + Math.cos(a) * r); }
// grenade / rocket / charge kills: a slow orbit around the blast, the thrower and you both in view
const _oc = new THREE.Vector3(), _ol = new THREE.Vector3(), _ov = new THREE.Vector3();
function orbitCam(c, rt) {
  if (!c.orb) {
    lin(c.me, c.deathT, SA); const vp = new THREE.Vector3(SA[0], SA[1], SA[2]);
    let bp = null, bd = 1e9; for (const b of c.booms) { const d = Math.abs(b.t - c.deathT) + b.p.distanceTo(vp) * .02; if (d < bd && Math.abs(b.t - c.deathT) < .4) { bd = d; bp = b.p.clone(); } }
    const center = bp || vp.clone().setY(vp.y + .6);
    let kp = null; if (c.killer !== c.victim) { if (lin(c.ktr, c.deathT - .8, SB)) kp = new THREE.Vector3(SB[0], SB[1], SB[2]); }
    const from = kp ? Math.atan2(kp.x - center.x, kp.z - center.z) : 0;
    // candidate start angles round the blast: room for the camera (no wall in the way), you and the thrower in sight,
    // ideally behind you looking toward where the throw came from; then drift ~70 degrees toward the clearer side
    const eyeOf = (a, r) => _ov.set(center.x + Math.sin(a) * r, center.y + 2.4, center.z + Math.cos(a) * r), up = new THREE.Vector3(center.x, center.y + .8, center.z);
    // (visibility by a real ray against the map meshes: stairs, rails and props hide you too)
    const sees = (e, x, y, z) => { try { return lineOfSight(e, _oc.set(x, y, z)); } catch (er) { return segHit(e, _oc.set(x, y, z), true) > .98; } };
    let best = null;
    for (let k = 0; k < 16; k++) { const a = from + Math.PI + (k - 8) / 16 * Math.PI * 2;
      let sc = 0; for (const [da, w] of [[0, 3], [.6, 1], [-.6, 1]]) sc += segHit(up, eyeOf(a + da, 6.2), true) * w;
      for (const [aa, rr] of [[a, 6.2], [a + .6, 4.8], [a - .6, 4.8]]) { const e = eyeOf(aa, rr).clone(); if (sees(e, vp.x, vp.y + 1.1, vp.z)) sc += 1.6; if (sees(e, center.x, center.y + .4, center.z)) sc += .8; if (kp && sees(e, kp.x, kp.y + 1.3, kp.z)) sc += .5; }
      sc -= Math.abs(wrapPi(a - (from + Math.PI))) * .35;
      if (!best || sc > best.sc) best = { a, sc }; }
    const side = segHit(up, eyeOf(best.a + .7, 6.2), true) >= segHit(up, eyeOf(best.a - .7, 6.2), true) ? 1 : -1;
    c.orb = { center, vp, kp, a0: best.a - side * .25, a1: best.a + side * .95, r0: 6.2, r1: 4.6, score: best.sc };
    // how far out the camera may go along the whole path, worked out once: the safe distance is the minimum over a
    // window and blended between samples, so a wall coming into the line pulls the camera in smoothly (no pop)
    const N = 48, raw = [], O = c.orb; for (let i = 0; i <= N; i++) { const k = i / N; orbitPos(O, k, _oc); _ov.copy(O.center); _ov.y += .8; raw.push(Math.max(.15, Math.min(1, segHit(_ov, _oc, true)) - .06)); }
    O.safe = raw.map((_, i) => { let m = 1; for (let j = Math.max(0, i - 3); j <= Math.min(N, i + 3); j++) m = Math.min(m, raw[j]); return m; });
  }
  const O = c.orb, k = smooth((rt - c.t0) / Math.max(.1, c.t1 - c.t0));
  orbitPos(O, k, _oc); _ov.copy(O.center); _ov.y += .8;
  { const x = k * (O.safe.length - 1), i = Math.min(O.safe.length - 2, Math.floor(x)), f = O.safe[i] + (O.safe[i + 1] - O.safe[i]) * (x - i); if (f < 1) _oc.lerpVectors(_ov, _oc, f); }
  unclip(_oc, undefined, true);
  // look: early at you (with the grenade coming), at the blast when it goes off
  const kb = smooth((rt - (c.deathT - .5)) / .5);
  lin(c.me, Math.min(rt, c.deathT), SA); _ol.set(SA[0], SA[1] + 1.1, SA[2]).lerp(_ov.copy(O.center).setY(O.center.y + .5), kb * .7);
  camera.position.copy(_oc); camera.up.set(0, 1, 0); camera.lookAt(_ol); camera.rotation.setFromQuaternion(camera.quaternion, 'YXZ'); camera.rotation.z = 0; camera.updateMatrixWorld();
  if (Math.abs(camera.fov - 62) > .01) { camera.fov = 62; camera.updateProjectionMatrix(); }
}
const _applyReplay = applyReplay, _restoreReplay = restoreReplay;
applyReplay = function () {
  const c = KC.clip; if (!c || !REC.on) return false;
  try { if (P.dieT > RS + .25 || (window.SPECTATE && window.SPECTATE.on)) { stopKillcam(); if (!(window.SPECTATE && window.SPECTATE.on)) $('death').hidden = false; return false; } return applyClip(c, Math.max(0, P.dieT - DC.T)); } catch (e) { warnOnce(e); KC.inReplay = false; try { restoreClip(); } catch (e2) {} restoreHands(); REC.on = false; KC.clip = null; return false; }
};
restoreReplay = function () { try { restoreClip(); } catch (e) { warnOnce(e); } };
// pose the world as it was at replay time and look through the killer's eyes; el = seconds since the replay started
// (past the end the last frame holds: no flash of the normal HUD before the respawn; with no respawn coming, e.g.
// Demolition, applyReplay hands over to the spectator view at RS + 0.25 s)
function applyClip(c, el) {
  const d = dom();
  buildGhosts(99);
  try { const SK = window.S9Skins; if (SK && SK.handsFor) { const l = c.killer && c.killer !== PLAYER_ENT ? lookOf(c.killer) : null, hk = l ? SK.lookCode(l) : 'me'; if (KC.hk !== hk) { KC.hk = hk; SK.handsFor(l); } } } catch (e) { warnOnce(e); }   // the killer's own gloves, not yours
  const first = KC.first, rt = first ? rtAt(el, c) : Math.max(KC.rt, rtAt(el, c)); KC.first = false;   // replay time never runs backwards (no repeated sounds)
  const dt = first ? 0 : Math.max(0, rt - KC.rt), prev = first ? c.t0 : KC.rt; KC.rt = rt; KC.live = true; KC.inReplay = true;
  const nowW = performance.now(), wallDt = first ? 0 : clamp((nowW - (KC.wall || nowW)) / 1000, 0, .1); KC.wall = nowW;
  if (first) { duck(true); KC.aud = { rl: -1, ads: 0, sw: -1, step: 0, vstep: 0, air: false, vair: false, killed: false }; }
  const sched = t => Math.min(.04, Math.max(0, wallDt - (rt - t) / Math.max(speedAt(t, c), .05)));   // capped: a sound never lags its flash by more than 40 ms   // where inside the last frame this event fell
  const sp = speedAt(rt, c), slow = sp < .9;
  if (first) { $('killcam').hidden = false; $('death').classList.add('kc'); $('hud').classList.add('kcview'); if (d) { d.fx.style.transition = 'none'; d.fx.style.background = 'rgba(255,255,255,.55)'; d.fx.style.opacity = '1'; } }
  hideLive();
  // ---- everyone else, as you saw them ----
  for (const ent of c.cast) {
    if (ent === c.victim) continue; const tr = R.tracks.get(ent), g = GH.get(ent); if (!tr || !g) continue;
    poseGhost(g, tr, rt, dt, first, { fires: c.fireMap.get(ent) });
  }
  // ---- the victim (you): walking exactly as recorded, then going down when the shot lands ----
  const gm = GH.get(c.victim);
  if (gm) {
    const dl = c.victimDelay, dead = rt >= c.deathT;
    if (!dead) poseGhost(gm, c.me, rt, dt, first, { tPos: Math.max(c.me.t[0], rt - dl), dead: false, fires: c.fireMap.get(c.victim) });
    else { lin(c.me, rt, SA); poseGhost(gm, c.me, rt, dt, first, { tPos: c.deathT - dl, y: SA[1], dead: true, deadT: (rt - c.deathT) * 1.15 }); }
  }
  // ---- the killer's eyes ----
  const K = c.ktr; let tk = rt, kDown = false;
  lin(K, rt, SB); if (SB[11] > .5 && !c.orbit) { kDown = true; let i = seg(K.t, rt); while (i > 0 && K.v[i * S_ + 11] > .5) i--; tk = K.t[i]; lin(K, tk, SB); }
  let thrW = 0; for (const t of c.kthrows) { const q = rt - t; if (q > -.15 && q < .6) thrW = Math.max(thrW, q < 0 ? 1 + q / .15 : q < .45 ? 1 : 1 - (q - .45) / .15); }   // a throw takes the gun off their eye
  const kw = wname(SB[8]), W = WEAPONS[kw] || WEAPONS.carbine, cr = SB[5], ads = clamp(SB[6], 0, 1) * (1 - thrW), rl = SB[7], sw = SB[15], gnd = SB[9] > .5, sprint = SB[17] > .5 && SB[17] < 1.5, walkQ = SB[17] > 1.5;
  viewAt(K, tk, VIEW);
  velAt(K, tk, _a); const hs = Math.hypot(_a.x, _a.z), air = !gnd || Math.abs(_a.y) > 2;
  if (!air && !kDown) KC.bob += dt * hs * (sprint ? 1.25 : 1.45);
  const bobAmt = clamp(hs / 6, 0, 1.3) * (1 - ads * .85), kick = kDown ? 0 : kickAt(rt, c.fires), kAmp = clamp((W.kick || 1.5) / 1.5, .6, 2.6);
  const scoped = !c.orbit && !!W.scope && ads > .85 && rl < 0 && !kDown;
  if (c.orbit) { orbitCam(c, rt); KC.wallFix = 0; } else {
  const eyeH = clamp(herm(K, tk, 18), .8, 1.8) || 1.6;   // their recorded eye height (crouch, step-up smoothing)
  camera.position.set(VIEW.x, VIEW.y + eyeH + Math.sin(KC.bob * 2) * .03 * bobAmt, VIEW.z);
  KC.wallFix = unclip(camera.position, VIEW.y);          // never inside a wall or a ceiling
  let pitch = VIEW.pitch + kick * .011 * kAmp * (scoped ? .6 : 1), yaw = VIEW.yaw + Math.PI;
  if (scoped) { const t2 = rt; pitch += Math.sin(t2 * .9) * .0016; yaw += Math.sin(t2 * .63 + 1) * .002; }
  camera.rotation.set(clamp(pitch, -1.5, 1.5), yaw, 0, 'YXZ');   // no camera roll in the replay
  { const m = unclipActors(camera.position, c); if (m) { KC.wallFix += m; unclip(camera.position, VIEW.y); } }
  camera.updateMatrixWorld();
  { const base = lerp(sprint ? 84 : 78, W.adsFov || 60, ads), z = slow && !scoped ? (1 - sp) / (1 - SLOW) : 0, fv = base - 6 * ez(z);
    if (Math.abs(camera.fov - fv) > .01) { camera.fov = fv; camera.updateProjectionMatrix(); }
    const gf = lerp(60, 50, ads); if (Math.abs(gunCam.fov - gf) > .01) { gunCam.fov = gf; gunCam.updateProjectionMatrix(); } }
  }
  // yaw rate drives the weapon sway, like a mouse does
  const yr = wrapPi(herm(K, tk + .03, 3, true) - herm(K, tk - .03, 3, true)) / .06, pr = (herm(K, tk + .03, 4) - herm(K, tk - .03, 4)) / .06;
  // ---- their weapon, in their hands ----
  const vm = WM[kw] || WM.carbine;
  if (!c.orbit) vmFinish(vm, kw, c);
  { const v = LVM; v.gv = gunVisible; v.vis.length = 0; v.vm = vm; v.pos.copy(vm.group.position); v.rot.copy(vm.group.rotation); v.fl = vm.flash ? vm.flash.visible : false; v.ret = vm.reticle ? vm.reticle.visible : null; v.rear = vm.rear ? vm.rear.visible : null;
    v.hasMag = !!vm.mag; if (vm.mag) { v.magP.copy(vm.mag.position); v.magV = vm.mag.visible; } v.hasArm = !!vm.leftArm; if (vm.leftArm) v.arm.copy(vm.leftArm.position); live.vm = v; }   // (one record reused every frame: no garbage)
  for (const id in WM) if (WM[id].group.visible) { live.vm.vis.push(WM[id].group); WM[id].group.visible = false; }
  let thr = 0; for (const t of c.kthrows) { const k = (rt - t) / .45; if (k >= 0 && k <= 1) thr = Math.max(thr, Math.sin(Math.PI * k)); }
  const showVm = !scoped && !kDown && !c.orbit;
  vm.group.visible = showVm; gunVisible = showVm;
  { const tilt = rl >= 0 ? Math.sin(Math.PI * clamp(rl * 1.05, 0, 1)) : 0, magDrop = rl < 0 || kw === 'sniper' ? 0 : rl < .14 ? 0 : rl < .34 ? (rl - .14) / .2 : rl < .52 ? 1 : rl < .66 ? 1 - (rl - .52) / .14 : 0;
    if (vm.mag && vm.magPos) { vm.mag.position.set(vm.magPos.x, vm.magPos.y - magDrop * .35, vm.magPos.z + magDrop * .05); vm.mag.visible = !(rl >= 0 && magDrop > .97); }
    if (vm.leftArm) vm.leftArm.position.set(0, -magDrop * .2, magDrop * .28);
    const sx = clamp(-yr * .006, -.035, .035) * (1 - ads * .7), sy = clamp(pr * .006, -.03, .03) * (1 - ads * .7), spP = sprint && !ads ? 1 : 0;
    const hip = vm.hip || HIP_POS, ap = vm.adsPos || hip, base = _b.copy(hip).lerp(ap, ads), kz = kick * .045 * (1 - ads * .4), kr = kick;
    vm.group.position.set(base.x + Math.sin(KC.bob) * .014 * bobAmt + sx - spP * .06, base.y + Math.abs(Math.cos(KC.bob)) * .012 * bobAmt + sy - tilt * .05 - spP * .05 - thr * .25, base.z + kz);
    vm.group.rotation.set(kr * .06 * (1 - ads * .5) + tilt * .35 - spP * .2 + sy * 1.5 - thr * .6, spP * .55 + sx * 2 + (1 - ads) * .1, spP * .35 + tilt * .55);
    if (kw === 'knife' && sw >= 0) { const k = sw, s = k < .2 ? ez(k / .2) : k < .5 ? 1 - 2 * ez((k - .2) / .3) : -1 + ez((k - .5) / .5);
      vm.group.position.x += s * .13; vm.group.position.y += s * .05 + (k < .6 ? .03 : 0); vm.group.rotation.z += s * .95; vm.group.rotation.y += s * .55; vm.group.rotation.x -= Math.abs(s) * .25; }
    if (vm.reticle) vm.reticle.visible = ads > .5; if (vm.rear) vm.rear.visible = ads < .6;
    let lf = -9; for (let i = c.fires.length - 1; i >= 0; i--) if (c.fires[i] <= rt) { lf = c.fires[i]; break; }
    if (vm.flash) { vm.flash.visible = showVm && rt - lf < .05; if (vm.flash.visible) vm.flash.rotation.z = rand(0, 6.28); }
    if (vm.glow && kw === 'knife') vm.glow.color.setRGB(.5, 2.6, 3.6).multiplyScalar(sw >= 0 ? 1.8 : 1);
  }
  grade.uniforms.uAds.value = ads;
  if (kw === 'boomerang' && vm.boom) { try { poseBoomKC(vm, rt, dt, c, K); } catch (e) { warnOnce(e); } } else hideKcBlade();
  if (vm.group.visible && KC.onVm) { try { KC.onVm(vm, kw); } catch (e) { warnOnce(e); } }   // generic hook: a custom weapon module animates its own viewmodel here
  if (vm.group.visible) vm.group.updateMatrixWorld(true);
  // ---- their shots: tracer from their muzzle, flash, sound, sparks ----
  for (const s of c.kshots) if (s.t > prev && s.t <= rt) {
    const kg = c.orbit ? GH.get(c.killer) : null, mw = kg && kg.root.visible ? kg.muzzle.getWorldPosition(_a) : muzzleWorld(vm, scoped, _a), ww = WEAPONS[s.wid || kw] || W, wid = s.wid || kw, life = 1 / Math.max(sp, SLOW);
    if (wid === 'boomerang') { /* the blade itself is drawn flying (poseBoomKC) */ continue; }
    else if (wid === 'arc') zap(mw.clone(), s.b.clone(), new THREE.Color(...(ww.glow || [1, 2, 4])).multiplyScalar(1.4));
    else if (wid === 'inferno') { const dir = _c.subVectors(s.b, mw).normalize(); for (let k = 0; k < 14; k++) { const v = rand(9, 14); FX.spawn(mw, dir.x * v + rand(-1.2, 1.2), dir.y * v + rand(-.6, 1.2), dir.z * v + rand(-1.2, 1.2), 3, rand(.8, 1.4), .2, rand(.08, .16), rand(.45, .7), -1.5, 1.4, .45); } }
    else { const col = s.c || new THREE.Color(...(ww.tracer || [5, 3.6, 2.2])), wd = s.w || (ww.beam ? .07 : ww.oneShot ? .035 : .022), lf2 = (s.l || (ww.beam ? .3 : ww.oneShot ? .14 : .06)) * life;
      _tracer(mw, s.b, col, scoped ? wd * .6 : wd, lf2); }
    for (let i = 0; i < 3; i++) FX.spawn(s.b, rand(-2, 2), rand(0, 3), rand(-2, 2), 6, 3.2, 1.2, .03, .2, 14, 1);
    if (!scoped) lightFlash(mw, 0xffaa55, 2.5, 7);
  }
  // sounds: the killer's gun (once per trigger pull, close and dry), everyone else's gunfire from where they stood
  for (const f of c.fires) if (f > prev && f <= rt) { lin(K, f, SA); const w = wname(SA[8]), r = speedAt(f, c); gunSound(w, { rate: r, delay: sched(f), t: f }, 'killer'); if (w === 'sniper') fxSound('bolt', { rate: r, delay: sched(f) + .11 / r, t: f }, 'bolt'); }
  for (const f of c.ofires) if (f.t > prev && f.t <= rt) { const tr = R.tracks.get(f.ent); if (!tr || !lin(tr, f.t, SA)) continue; const pos = new THREE.Vector3(SA[0], SA[1] + 1.4, SA[2]);
    gunSound(wname(SA[8]), { rate: speedAt(f.t, c), delay: sched(f.t), pos, vol: .8, t: f.t }, f.ent === c.victim ? 'victim' : 'other'); }
  for (const s of c.oshots) if (s.t > prev && s.t <= rt) { const b = nearCam(s.a, s.b); if (b) _tracer(s.a, b, s.c, s.w, s.l / Math.max(sp, SLOW)); }
  for (const t of c.kthrows) if (t > prev && t <= rt) fxSound('nadeThrow', { rate: speedAt(t, c), delay: sched(t), t }, 'throw');
  for (const b of c.booms) if (b.t > prev && b.t <= rt) { burst(b.p); fxSound('explode', { rate: speedAt(b.t, c), delay: sched(b.t), pos: b.p.clone(), ref: 8, vol: 1.3, t: b.t, who: 'world' }, 'boom'); }
  // grenades / rockets / bolts in the air
  hideProxies();
  if (c.proj.length) { const F = c.proj; let i = 0; while (i < F.length - 2 && F[i + 1].t < rt) i++; const A = F[i], B = F[Math.min(i + 1, F.length - 1)];
    if (A && rt >= A.t - .02 && rt <= B.t + .05) { const k = B.t > A.t ? clamp((rt - A.t) / (B.t - A.t), 0, 1) : 0;
      for (const a of A.it) { const b = B.it.find(x => x[0] === a[0]) || a; const m = proxyFor(a[0], a[1]); m.position.set(lerp(a[2], b[2], k), lerp(a[3], b[3], k), lerp(a[4], b[4], k)); m.visible = true; if (a[5] === 'nade') m.rotation.x = rt * 9; } } }
  // ---- HUD: their crosshair, hitmarkers, scope ----
  for (const h of c.khits) if (h.t > prev && h.t <= rt) { KC.hmT = h.kill ? .5 : .22; KC.hmK = h.kill ? 'kill' : h.crit ? 'crit' : ''; if (AU.hitBuf) playBuf(AU.hitBuf[h.crit ? 'head' : 'body'], { rate: speedAt(h.t, c) * (1 + Math.min(4, KC.aud.hits = (KC.aud.hits || 0) + 1) * .02), vol: h.crit ? 1.15 : .95, delay: sched(h.t) }, { kind: 'hit', name: h.crit ? 'head' : 'body', who: 'killer', t: h.t });
    if (h.kill && !KC.aud.killed) { KC.aud.killed = true; fxSound(h.crit ? 'killHead' : 'kill', { rate: speedAt(h.t, c), delay: sched(h.t), t: h.t }, 'kill'); fxSound('death', { rate: speedAt(h.t, c), delay: sched(h.t), vol: .8, t: h.t, who: 'victim' }, 'death'); }
    if (kw === 'knife') fxSound('knifeHit', { rate: speedAt(h.t, c), delay: sched(h.t), t: h.t }, 'knifeHit'); if (h.kill && d) { d.fx.style.transition = 'none'; d.fx.style.background = ''; d.fx.style.opacity = '.9'; } }
  KC.hmT = Math.max(0, (KC.hmT || 0) - dt);
  if (d) {
    d.hm.className = KC.hmK || ''; d.hm.style.opacity = KC.hmT > 0 && !c.orbit ? '1' : '0'; d.hm.style.transform = `scale(${KC.hmT > 0 ? 1 + KC.hmT * 1.2 : 1})`;
    if (!first && d.fx.style.opacity !== '0') { d.fx.style.transition = 'opacity .35s'; d.fx.style.opacity = '0'; }
    const xh = !scoped && ads < .45 && !kDown && !c.orbit, gap = (5 + hs * 1.6 + (air ? 14 : 0) + Math.min(1, kick * .7) * 14) * (1 - cr * .3);
    d.cross.style.opacity = xh ? '1' : '0';
    if (xh) { const [u, dn, l, r] = d.xi; u.style.top = `${(-gap - 11).toFixed(1)}px`; dn.style.top = `${gap.toFixed(1)}px`; l.style.left = `${(-gap - 11).toFixed(1)}px`; r.style.left = `${gap.toFixed(1)}px`; for (const q of [u, dn, l, r]) q.style.display = kw === 'knife' ? 'none' : ''; }
    d.down.hidden = !kDown;
    // the killer's HP bar follows their recorded HP frame by frame (drops at the exact moment of each hit you landed); the last moments say "Killer had N HP"
    if (c.killer && !c.orbit && K && K.t && K.t.length) {
      lin(K, rt, SHP); let hpNow = Math.ceil(clamp(SHP[16], 0, 100)); if (!(SHP[16] > 0) && c.hp > 0 && rt < c.deathT) hpNow = c.hp;
      const endTxt = rt >= c.t1 - .6, key = hpNow + (endTxt ? 'e' : '');
      if (KC.hpKey !== key) { KC.hpKey = key; const bar = $('kcBHp'), tx = $('kcBHpT'); if (bar) { bar.style.transform = `scaleX(${hpNow / 100})`; bar.style.background = hpNow > 50 ? '#5dff9a' : hpNow > 25 ? '#ffd166' : '#ff6b5d'; }
        if (tx) tx.textContent = endTxt ? `${c.killer === PLAYER_ENT ? 'You' : 'Killer'} had ${hpNow} HP` : hpNow > 0 ? `${hpNow} HP` : 'DOWN'; KC.hpShown = hpNow; }
    }
  }
  setStyle($('scope'), 'opacity', scoped ? '1' : '0');
  if (d && d.you) { let show = false;   // a marker over the victim (you), like the name tag over you in a CoD killcam
    if (gm && gm.root.visible && rt < c.deathT + .05) { _ndc.set(gm.root.position.x, gm.root.position.y + 2.05, gm.root.position.z).project(camera);
      if (_ndc.z < 1 && Math.abs(_ndc.x) < 1.05 && Math.abs(_ndc.y) < 1.05) { show = true; d.you.style.transform = `translate(${((_ndc.x + 1) / 2 * innerWidth).toFixed(1)}px,${((1 - _ndc.y) / 2 * innerHeight).toFixed(1)}px) translate(-50%,-100%)`; } }
    if (show && !KC.youSet) { KC.youSet = true; d.you.firstChild.textContent = c.victim === PLAYER_ENT ? 'YOU' : String(c.victim.name || '').toUpperCase(); d.you.style.setProperty('--yc', c.victim === PLAYER_ENT ? (NET.on ? '#' + new THREE.Color(...NET_COLORS[(NET.color | 0) % NET_COLORS.length]).getHexString() : '#ff8a3d') : (c.victim.cssCol || '#fff')); }
    d.you.style.opacity = show ? (scoped ? '.75' : '1') : '0'; }
  { const A = KC.aud, r = speedAt(rt, c);
    if (!kDown && !c.orbit) {
      if (!air && A.air) fxSound('land', { rate: r, t: rt }, 'step'); A.air = air;
      if (!air && hs > 1 && !walkQ) { A.step += hs * dt; if (A.step > (sprint ? 2.5 : 1.9)) { A.step = 0; fxSound(sprint ? 'stepSprint' : cr > .5 ? 'stepCrouch' : 'step', { rate: r, vol: .9, t: rt }, 'step'); } }
      if (rl >= 0 && A.rl < .14 && rl >= .14) fxSound(kw === 'sniper' ? 'bolt' : 'magOut', { rate: r, t: rt }, 'reload');
      if (rl >= 0 && A.rl < .58 && rl >= .58) fxSound('magIn', { rate: r, t: rt }, 'reload');
      if (ads >= .5 && A.ads < .5 && rl < 0) fxSound('adsIn', { rate: r, t: rt }, 'ads');
      if (kw === 'knife' && sw >= 0 && A.sw < 0) fxSound('knifeSwing', { rate: r, t: rt }, 'swing');
    }
    A.rl = rl; A.ads = ads; A.sw = sw;
    if (gm && gm.root.visible && rt < c.deathT) { const vh = Math.hypot(gm.vel.x, gm.vel.z); if (gm.onGround && vh > 1) { A.vstep += vh * dt; if (A.vstep > 2.1) { A.vstep = 0; fxSound('step', { rate: r, pos: gm.root.position.clone(), ref: 3, vol: 1.1, t: rt, who: 'victim' }, 'step'); } } }
  }
  setText('kcTime', rt >= c.deathT - .02 ? 'ELIMINATED' : slow ? 'SLOW MOTION' : `-${Math.max(0, c.deathT - rt).toFixed(1)}s`);
  if (KC.log && renderer.info && renderer.info.programs) { const P0 = renderer.info.programs; if (first || !KC.prgSeen) { KC.prgSeen = new Set(P0.map(p => p.id)); KC.newPrg = []; } else if (P0.length !== KC.prgN) { for (const p of P0) if (!KC.prgSeen.has(p.id)) { KC.prgSeen.add(p.id); KC.newPrg.push([+(rt - c.deathT).toFixed(3), p.name, String(p.cacheKey).slice(0, 160)]); } } KC.prgN = P0.length; }
  if (KC.log) KC.log.push({ hpb: KC.hpShown, hpt: SHP[16], hptx: $('kcBHpT') ? $('kcBHpT').textContent : '', final: c.final, el, rt, wall: performance.now(), x: camera.position.x, y: camera.position.y, z: camera.position.z, yaw: camera.rotation.y, pitch: camera.rotation.x, fov: camera.fov, scoped, ads, kw, vm: vm.group.visible, xh: d ? d.cross.style.opacity === '1' : false,
    hm: KC.hmT > 0, kDown, slow, me: gm ? meInfo(gm) : null, inWall: inWall(camera.position), inBody: inBody(camera.position, c), occ: gm && gm.root.visible ? !lineOfSight(camera.position, _ndc.set(gm.root.position.x, gm.root.position.y + 1.1, gm.root.position.z)) : null, fix: +(KC.wallFix || 0).toFixed(3), orbit: !!c.orbit, hi: !!c.hi,
    fin: c.fin && c.fin[kw] || 'factory', vmFin: vm.group.visible ? vm.group.userData.gsSkin || 'factory' : null, roll: camera.rotation.z, scopeOp: scoped, prg: renderer.info && renderer.info.programs ? renderer.info.programs.length : 0, cast: c.cast.length, proxies: [...PX.values()].filter(m => m.visible).length, ft: document.timeline ? +document.timeline.currentTime || 0 : 0, gunHand: gunHandGap() });
  return true;
}
function gunHandGap() {   // test probe: the farthest any actor's gun sits from its right hand this frame (m)
  let m = 0; for (const g of GH.values()) { if (!g.root.visible || !g.gun.visible || !g.B || !g.B.rhand) continue; g.B.rhand.getWorldPosition(_c); m = Math.max(m, _c.distanceTo(g.gun.position)); }
  return +m.toFixed(3);
}
function meInfo(g) {   // test probe: where you are on the killer's screen and how your legs move
  const p = g.root.position; _c.set(p.x, p.y + 1.2, p.z); const toMe = _d.subVectors(_c, camera.position), dist = toMe.length(); toMe.normalize();
  const fwd = _b.set(0, 0, -1).applyQuaternion(camera.quaternion), A = g.act, foot = g.kcFoot || (g.kcFoot = g.model.getObjectByName('mixamorigLeftFoot'));
  let fy = null; if (foot) { foot.getWorldPosition(_a); fy = [_a.x - p.x, _a.y - p.y, _a.z - p.z]; }
  return { vis: g.root.visible, ang: Math.acos(clamp(fwd.dot(toMe), -1, 1)), dist, walk: A.walk.w + A.jog.w + A.sprint.w + A.cwalk.w, air: A.air.w, death: A.death.getEffectiveWeight(), foot: fy, hs: Math.hypot(g.vel.x, g.vel.z) };
}
/* ---- Vortex boomerang in the killer's hands (killcam audit, player report #1: "kill cam with boomerang doesn't show the animation").
   The throws are the recorded fire times: the blade is wound up and spun in the fingers just before each one, the arm whips on
   release, the hand is empty while the blade flies (it is drawn flying toward you on the throw that killed you), and the
   catch snaps it home. Same poses as the game's own poseBoomVM. */
const BOOM_FLY = 1.7, KB = { m: null, blade: null, halo: null, ang: 0, ang2: 0 };
function kcBlade() {
  if (KB.m && KB.m.parent === scene) return KB.m;
  if (KB.m) { try { KB.m.parent && KB.m.parent.remove(KB.m); } catch (e) {} KB.m = null; }
  if (typeof buildBoomBlade !== 'function' || typeof boomMats !== 'function') return null;
  const mats = (typeof BOOM_MATS !== 'undefined' && BOOM_MATS) || boomMats(new THREE.Color(...WEAPONS.boomerang.glow).multiplyScalar(1.3));
  const m = new THREE.Group(), blade = buildBoomBlade(mats); blade.scale.setScalar(1.25); m.add(blade);
  try { const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex(T.glow), color: new THREE.Color(...WEAPONS.boomerang.glow).multiplyScalar(.5), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })); halo.scale.setScalar(1.1); m.add(halo); KB.halo = halo; } catch (e) {}
  m.visible = false; m.frustumCulled = false; scene.add(m); KB.m = m; KB.blade = blade; return m;
}
function hideKcBlade() { if (KB.m) KB.m.visible = false; }
function resetBoomVm() { const vm = WM && WM.boomerang, B = vm && vm.boom; if (B) { B.blade.visible = true; B.blur.visible = B.ring.visible = true; B.blur.material.opacity = 0; B.ring.material.opacity = 0; } }
const KV = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, _bq = new THREE.Euler(), _bf = new THREE.Vector3(), _bs = new THREE.Vector3(), _be = new THREE.Vector3();
function poseBoomKC(vm, rt, dt, c, K) {
  const B = vm.boom, g = vm.group; if (!B) return;
  let charge = 0, tw = -1, flyD = -1, catchK = 0, fl = -9;
  for (const f of c.fires) {
    const d = rt - f;
    if (d > -.32 && d < 0) charge = Math.max(charge, clamp((d + .32) / .3, 0, 1));   // winding up before the throw
    if (d >= 0 && d < .28) tw = d / .28;                                              // the arm whips through the release
    if (d >= 0 && d < BOOM_FLY) { flyD = d; fl = f; }                                  // the blade is away
    if (d >= BOOM_FLY && d < BOOM_FLY + .32) catchK = Math.max(catchK, (BOOM_FLY + .32 - d) / .32);   // caught: snaps home
  }
  const out = flyD >= 0, k = charge, sk = k * k * (3 - 2 * k);
  B.blade.visible = !out; B.blur.visible = B.ring.visible = !out;
  KB.ang = (KB.ang || 0) + dt * (sk * 34 + catchK * 20);
  if (sk < .02 && catchK <= 0) { const T2 = Math.PI * 2, rest = Math.round(KB.ang / T2) * T2; KB.ang = rest + (KB.ang - rest) * Math.exp(-14 * Math.max(dt, .016)); }
  B.spin.position.set(lerp(.17, .02, sk), lerp(0, .06, sk), lerp(-.005, -.02, sk)); B.spin.scale.setScalar(lerp(1, .72, sk));
  B.spin.rotation.set(0, KB.ang, 0);
  B.holder.rotation.x = lerp(.75, .16, sk); B.holder.rotation.z = lerp(-.25, -.08, sk); B.holder.rotation.y = lerp(.35, 0, sk);
  B.blur.material.opacity = sk * .3; B.ring.material.opacity = sk * .7; B.ring.rotation.y = -KB.ang * .35;
  g.position.y -= sk * .015; g.position.x += sk * .02; g.position.z -= sk * .05; g.rotation.z -= sk * .1;
  const whip = tw >= 0 ? Math.sin(Math.PI * tw) : 0;
  g.position.z -= whip * .22; g.position.x -= whip * .09; g.position.y += whip * .05; g.rotation.y -= whip * .7; g.rotation.z += whip * .4; g.rotation.x -= whip * .25;
  const reach = out ? clamp((flyD / BOOM_FLY - .5) / .5, 0, 1) : 0;
  g.position.z -= reach * .12; g.position.y += reach * .045; g.position.x -= reach * .03; g.rotation.x += reach * .15;
  g.position.x += k * .04 - (out ? .04 : 0); g.position.y += k * .02 - (out ? .02 : 0) - catchK * .06; g.position.z += k * .08 + catchK * .05;
  g.rotation.y += k * .25; g.rotation.z += -catchK * .3; g.rotation.x += k * .06 + catchK * .2;
  B.fingers.forEach((f, i) => { f.rotation.copy(f.userData.rest); if (out) { f.rotation.y = -.5 - i * .08; f.position.y = .012; } else f.position.y = .004 - i * .002; });
  B.glow.color.copy(B.col).multiplyScalar(1 + sk * 2.2 + catchK * 2);
  g.updateMatrixWorld(true);
  // the flying blade, in the world: the throw that killed you flies at you; any other throw flies out along the crosshair and curls home
  const m = out && kcBlade(); if (!m) { hideKcBlade(); return; }
  viewAt(K, fl, KV); lin(K, fl, SA);
  const eyeH = c.kind === 'bot' ? 1.62 : 1.65;
  _bf.set(0, 0, -1).applyEuler(_bq.set(KV.pitch, KV.yaw + Math.PI, 0, 'YXZ'));
  _bs.set(KV.x, KV.y + eyeH - .25, KV.z).addScaledVector(_bf, .6);
  const dd = c.deathT - fl, fatal = dd > .05 && dd <= BOOM_FLY && c.me;
  if (fatal) {
    lin(c.me, Math.max(c.me.t[0], c.deathT - c.victimDelay), SB); _be.set(SB[0], SB[1] + 1.1, SB[2]);
    const u = clamp(flyD / dd, 0, 1);   // arrives exactly when the shot lands, then rides on the body
    m.position.lerpVectors(_bs, _be, u < 1 ? 1 - (1 - u) * (1 - u) : 1);
    if (flyD > dd) m.position.y -= Math.min(.3, (flyD - dd) * .2);
  } else {
    const OUT = .8, u = flyD / OUT;
    _be.copy(_bs).addScaledVector(_bf, 16);
    if (u < 1) m.position.lerpVectors(_bs, _be, 1 - (1 - u) * (1 - u)); else { const h = clamp((flyD - OUT) / (BOOM_FLY - OUT), 0, 1), e = h * h * (3 - 2 * h); m.position.lerpVectors(_be, _bs, e); m.position.y += Math.sin(Math.PI * e) * 1.3; }
  }
  KB.ang2 += dt * 26; KB.blade.rotation.set(.12 * Math.sin(flyD * 3), KB.ang2, 0);
  m.visible = true;
}
// your own gloves come back when the replay ends (not after every replay frame: that swapped the hands twice per frame)
function restoreHands() { if (KC.hk) { KC.hk = null; try { window.S9Skins.handsFor(null); } catch (e) {} } }
function restoreClip() {
  if (!KC.inReplay) return; KC.inReplay = false;
  hideKcBlade(); resetBoomVm();
  hideGhosts(); hideProxies(); showLive();
  const v = live.vm; if (v) { const vm = v.vm; vm.group.position.copy(v.pos); vm.group.rotation.copy(v.rot); if (vm.flash) vm.flash.visible = v.fl; if (vm.reticle && v.ret !== null) vm.reticle.visible = v.ret; if (vm.rear && v.rear !== null) vm.rear.visible = v.rear;
    if (v.hasMag && vm.mag) { vm.mag.position.copy(v.magP); vm.mag.visible = v.magV; } if (v.hasArm && vm.leftArm) vm.leftArm.position.copy(v.arm);
    vm.group.visible = false; for (const g of v.vis) g.visible = true; gunVisible = v.gv; live.vm = null; }
}

/* ---- warm-up: draw the replay once, off screen, before it is shown ----
   The first replay frame used to pay for everything the live view had not drawn yet: shader programs (gun finishes on the
   killer's viewmodel and on the actors, lit materials seen from the killer's side of the map, splats and cilia that were off
   screen), texture uploads and the driver's own first-draw work. renderer.compile() alone misses the last two and anything
   hidden at that moment, so the replay is drawn for real at a few moments of the clip into the composer's own target (the
   next composer.render clears and redraws it: nothing reaches the screen), with exactly what the replay will show posed. */
const WARM_N = 5, _wp = new THREE.Vector3(), _wq = new THREE.Quaternion(), _wu = new THREE.Vector3();
function warmTimes(c) { return [c.t0 + .02, (c.t0 + c.deathT) / 2, c.deathT - .06, Math.min(c.t1, c.deathT + .3)]; }
function warmRender(c, t) {
  if (typeof renderer !== 'object' || !renderer || typeof gunScene !== 'object') return;
  const t0w = performance.now(), fov = camera.fov, gv0 = gunVisible, vis = [], sm = renderer.shadowMap, smA = sm.autoUpdate, smN = sm.needsUpdate;
  _wp.copy(camera.position); _wq.copy(camera.quaternion); _wu.copy(camera.up);
  let vm = null, vp = null, vr = null;
  try {
    buildGhosts(99);
    for (const ent of c.cast) {
      const g = GH.get(ent), tr = ent === c.victim ? c.me : R.tracks.get(ent); if (!g || !tr) continue;
      if (ent === c.victim && t >= c.deathT) { lin(c.me, t, SA); poseGhost(g, c.me, t, 0, true, { tPos: c.deathT - c.victimDelay, y: SA[1], dead: true, deadT: (t - c.deathT) * 1.15 }); }
      else poseGhost(g, tr, t, 0, true, ent === c.victim ? { tPos: Math.max(c.me.t[0], t - c.victimDelay), dead: false } : { fires: c.fireMap.get(ent) });
    }
    const K = c.ktr; lin(K, t, SB);
    if (c.orbit) orbitCam(c, t);
    else { viewAt(K, t, VIEW); const eyeH = clamp(herm(K, t, 18), .8, 1.8) || 1.6; camera.position.set(VIEW.x, VIEW.y + eyeH, VIEW.z); camera.rotation.set(clamp(VIEW.pitch, -1.5, 1.5), VIEW.yaw + Math.PI, 0, 'YXZ'); }
    camera.updateMatrixWorld();
    if (!c.orbit) { const kw = wname(SB[8]); vm = WM[kw] || WM.carbine; vmFinish(vm, kw, c); vp = vm.group.position.clone(); vr = vm.group.rotation.clone();
      for (const id in WM) if (WM[id].group.visible) { vis.push(WM[id].group); WM[id].group.visible = false; }
      vm.group.position.copy(vm.hip || HIP_POS); vm.group.visible = true; vm.group.updateMatrixWorld(true); gunVisible = true; }
    sm.autoUpdate = false; sm.needsUpdate = false;   // (the static shadow map is not re-drawn from here)
    const prev = renderer.getRenderTarget(); renderer.setRenderTarget(rt);
    try { renderer.render(scene, camera); if (vm) { renderer.clearDepth(); renderer.render(gunScene, gunCam); } } finally { renderer.setRenderTarget(prev); }
  } finally {
    sm.autoUpdate = smA; sm.needsUpdate = smN;
    hideGhosts();
    if (vm) { vm.group.visible = false; vm.group.position.copy(vp); vm.group.rotation.copy(vr); for (const g of vis) g.visible = true; }
    gunVisible = gv0; camera.position.copy(_wp); camera.quaternion.copy(_wq); camera.up.copy(_wu);
    if (camera.fov !== fov) { camera.fov = fov; camera.updateProjectionMatrix(); } camera.updateMatrixWorld();
    KC.warmRenderMs = (KC.warmRenderMs || 0) + performance.now() - t0w;
  }
}
// the overlay too: its first paint used to land on the first replay frames (the browser's own GPU raster compiles a shader
// for every new kind of paint: the banner's shadows and text, the vignette and kill-flash gradients, the scope ring, the
// marker over the victim, each a 20-40 ms stall of the GPU process that the 3D frames queue behind). The final killcam shows
// it all at 1% opacity during the live slow motion before the replay (painted for real, invisible), then at full opacity.
function warmDom(on) {
  const d = dom(), kc = $('killcam'), sc = $('scope'); if (!d || !kc) return;
  if (on) { kc.hidden = false; kc.style.opacity = '.01'; d.fx.style.transition = 'none'; d.fx.style.background = ''; d.fx.style.opacity = '1'; d.hm.style.opacity = '1'; d.down.hidden = false;
    d.you.style.opacity = '1'; if (!d.you.firstChild.textContent) d.you.firstChild.textContent = 'YOU'; d.cross.style.opacity = '1'; if (sc) { setStyle(sc, 'opacity', '.01'); KC.scopeWarm = true; } }
  else { kc.style.opacity = ''; d.fx.style.opacity = '0'; d.hm.style.opacity = '0'; d.down.hidden = true; d.you.style.opacity = '0'; if (sc && KC.scopeWarm) { setStyle(sc, 'opacity', '0'); KC.scopeWarm = false; } }
}
// ...and once per session, in the menu (where a hitch shows nowhere): a copy of the whole overlay (banner, top bar, kill flash,
// vignette, scope ring, marker, hitmarker) is painted at 1% opacity for a few frames, so the browser has compiled every one
// of those paint shaders before any killcam runs. The ids are the originals' (the styles are id-based); the copy sits after
// them in the page, so every lookup still finds the real elements, and it is removed after ~6 frames.
let ovWarm = 0;
function warmOverlayOnce() {
  if (ovWarm || typeof state === 'undefined' || state !== 'menu' || document.hidden) return; const d = dom(), kc = $('killcam'), sc = $('scope'); if (!d || !kc) return; ovWarm = 1;
  try {
    const box = document.createElement('div'); box.setAttribute('aria-hidden', 'true'); box.style.cssText = 'position:fixed;inset:0;opacity:.01;pointer-events:none;z-index:1;contain:strict';
    const k = kc.cloneNode(true); k.hidden = false; k.style.opacity = '1'; for (const e of k.querySelectorAll('[hidden]')) e.hidden = false;
    for (const e of k.querySelectorAll('#kcFx,#kcYou,#kcHm,#kcCross')) e.style.opacity = '1';
    const y = k.querySelector('#kcYou span'); if (y) y.textContent = 'YOU'; const b = k.querySelector('#kcBName'); if (b) b.textContent = 'FINAL KILL'; const t = k.querySelector('.kc-top b'); if (t) t.textContent = 'FINAL KILLCAM';
    box.appendChild(k); if (sc) { const q = sc.cloneNode(true); q.style.opacity = '1'; box.appendChild(q); }
    document.body.appendChild(box);
    let n = 0; const done = () => { if (++n < 6) { requestAnimationFrame(done); return; } box.remove(); ovWarm = 2; }; requestAnimationFrame(done);
  } catch (e) { warnOnce(e); }
}
{ const tryWarm = () => { if (ovWarm) return; warmOverlayOnce(); if (!ovWarm) setTimeout(tryWarm, 1500); }; setTimeout(tryWarm, 2500); }
KC.overlayWarm = () => ovWarm;
// one step per call: 0 = build every gun + finish and compile (prewarm), 1.. = a real draw at one moment of the clip
function warmStep(c) {
  const i = c.warmI | 0; if (i >= WARM_N) return false; c.warmI = i + 1;
  if (i === 0) prewarm(c); else warmRender(c, warmTimes(c)[i - 1]);
  return true;
}

/* ================= FINAL KILLCAM: the match-winning kill, from the winner's eyes, for everyone at match end ================= */
/* Like CoD / Valorant: the match-ending kill plays full screen FIRST; the results / podium (modules/roundfx.js) and the XP /
   Shards summaries (profile.js, shop.js) come only after the replay ends or is skipped. Offline, roundfx celebrates inside
   endMatch, so it is switched off for that one call and started from endFinal with the same standings it would have used.
   Any results element that still shows up (an online server matchEnd) is hidden while the replay is on screen. */
const finalKillOf = winner => { for (let i = R.kills.length - 1; i >= 0; i--) { const k = R.kills[i]; if (k.k === winner && k.v !== winner && G.time - k.t < 3) return k; } return null; };
const HOLD = { list: [] };
function holdSummaries() {   // XP / Shards popups wait for the replay (they then go through roundfx's own wait for its podium)
  for (const [o, k] of [[window.S9Profile, 'matchXp'], [window.S9Shop, 'matchCoins'], [window.S9Shop, 'showLastMatch']]) {
    if (!o || typeof o[k] !== 'function' || o[k].__kcHold) continue; const f = o[k];
    const w = function () { if (!KC.fin) return f.apply(this, arguments); const a = arguments, me = this; return new Promise(res => HOLD.list.push(() => { try { res(f.apply(me, a)); } catch (e) { res(null); } })); };
    w.__kcHold = true; for (const p in f) { try { w[p] = f[p]; } catch (e) {} } o[k] = w; }
}
function releaseSummaries() { const L = HOLD.list.splice(0); for (const fn of L) setTimeout(fn, 0); }
function rfxTable(winner) {   // the same standings roundfx builds in its endMatch hook
  const st = typeof standings === 'function' ? standings() : [], n = NET;
  const table = st.map((e, i) => ({ id: e.isPlayer ? 'me' : 'bot' + i, n: e.isPlayer ? ((n && n.nick) || 'You') : e.name, kills: e.kills | 0, deaths: e.deaths | 0, score: e.score | 0 }));
  return { result: 'win', mode: 'ffa', offline: true, table, me: 'me', winner: winner && !winner.isPlayer ? 'bot' + st.indexOf(winner) : winner ? 'me' : null };
}
const _endMatch = endMatch;
endMatch = function (winner) {
  const was = G.ended, RF = window.S9RoundFX;
  const defer = !was && !!winner && !NET.on && !!finalKillOf(winner) && !!(RF && RF.enabled && typeof RF.celebrate === 'function');
  // roundfx loads AFTER this module, so its own endMatch hook runs around this one and checks RF.enabled once we return:
  // switched back on right away, it built the podium at once (a ~2 s freeze on the winning kill: its soldier portraits
  // compile in their own WebGL context) and played its fanfare / cheers under the replay. It comes back on after this
  // whole call (a microtask), so the podium starts only from endFinal, whichever order the add-ons load in.
  if (defer) RF.enabled = false;
  let res; try { res = _endMatch.apply(this, arguments); } catch (e) { if (defer) RF.enabled = true; throw e; }
  if (defer) Promise.resolve().then(() => { RF.enabled = true; });
  let started = false;
  if (!was && G.ended && winner && state === 'matchend') { try { started = startFinal(winner); } catch (e) { warnOnce(e); } }
  if (defer) { const o = rfxTable(winner); if (started) KC.finDefer = o; else { try { RF.celebrate(o); } catch (e) { warnOnce(e); } } }
  return res;
};
function startFinal(winner) {
  const K = finalKillOf(winner);
  if (!K) return false;
  const c = makeClip({ killer: winner, victim: K.v, t: K.t, wall: K.wall, weapon: K.weapon, crit: K.crit, hp: K.hp, final: true });
  if (!c) return false;
  holdSummaries(); document.body.classList.add('kcFinal'); KC.finEndT = G.endT;   // (offline: the results get their full time after the replay)
  stopKillcam(); KC.fin = c; KC.clip = c; KC.first = true; KC.rt = c.t0; KC.bob = 0; KC.hmT = 0; c.startWall = 0;
  KC.hpKey = null; fillBanner(c); if (KC.log) KC.log.length = 0; if (KC.snd) KC.snd.length = 0;
  $('mend').hidden = true; $('hud').hidden = false; $('death').hidden = true;
  c.holdUntil = performance.now() + FINAL_SLOWMO; c.shown = false; c.warmI = 0;   // first the live final kill in slow motion (the replay screen opens in composer.render below)
  return true;
}
function endFinal() {
  const c = KC.fin; if (!c) return; KC.fin = null; KC.clip = null; KC.live = false; duck(false); vmRestore(); restoreHands();
  if (c.domWarm && !c.shown) { try { warmDom(false); } catch (e) { warnOnce(e); } }
  hideGhosts(); hideProxies(); setStyle($('scope'), 'opacity', '0'); $('killcam').hidden = true; $('hud').classList.remove('kcview');
  if (state === 'matchend') { $('hud').hidden = true; $('mend').hidden = false; }
  if (camera.fov < 40) { camera.fov = 62; camera.updateProjectionMatrix(); }
  const tb = $('killcam').querySelector('.kc-top b'); if (tb) tb.textContent = 'KILLCAM';
  document.body.classList.remove('kcFinal');
  // now the results: roundfx's podium (deferred above), then the held XP / Shards summaries
  if (state === 'matchend' && KC.finEndT > 0) {   // the replay time is given back; online, never past the server's own results clock (it sends toLobby at its phaseEnd)
    let t = Math.max(G.endT, KC.finEndT);
    if (NET.on) { try { const M = window.MODE && window.MODE.MX, v = M && M.v; if (v && v.over && v.end > 0) t = Math.min(t, Math.max(0, (v.end - (Date.now() - (M.off || 0))) / 1000)); } catch (e) {} }
    G.endT = t; }
  KC.finEndT = 0;
  const o = KC.finDefer; KC.finDefer = null;
  if (o && state === 'matchend') { try { const RF = window.S9RoundFX; if (RF && RF.enabled && RF.celebrate) RF.celebrate(o); } catch (e) { warnOnce(e); } }
  releaseSummaries();
  { const f = KC.afterFinal; KC.afterFinal = null; if (typeof f === 'function' && state === 'matchend') { try { f(); } catch (e) { warnOnce(e); } } }   // roundfx's online podium (held while the replay played)
}
KC.endFinal = endFinal;
// the match-end screen has no replay hook in the frame loop, so the final killcam poses the world around the render itself
if (typeof composer === 'object' && composer && typeof composer.render === 'function') {
  const _render = composer.render;
  composer.render = function () {
    const c = KC.fin;
    if (!c) return _render.apply(this, arguments);
    if (state !== 'matchend') { endFinal(); return _render.apply(this, arguments); }
    if (c.cast.some(e => !GH.has(e))) { buildGhosts(2); return _render.apply(this, arguments); }   // actors first, a couple per frame (no hitch)
    if (!c.shown) {
      // slow-mo on the final kill; results stay hidden. Meanwhile the replay is drawn once off screen, one step per frame
      // (warmStep), so its first frames are not the ones that compile shaders / upload textures. It opens when both are done.
      if (!c.domWarm) { c.domWarm = true; try { warmDom(true); } catch (e) { warnOnce(e); } }
      let warming = false; if (c.warmI < WARM_N) { try { warming = warmStep(c); } catch (e) { warnOnce(e); c.warmI = WARM_N; } }
      if (performance.now() < c.holdUntil || warming) { hitstop = Math.max(hitstop, .1); const m = $('mend'); if (m) m.hidden = true; return _render.apply(this, arguments); }
      try { warmDom(false); } catch (e) { warnOnce(e); }
      c.shown = true; $('hud').classList.add('kcview'); $('killcam').hidden = false;
    }
    // the replay clock steps by this frame's own time (rdt: the vsync-aligned rAF delta, capped at 50 ms, the same clock the
    // normal killcam runs on through P.dieT). performance.now() read here also counted however long this frame's game code
    // took, so every frame landed a slightly different amount of replay time later (micro-stutter at any refresh rate), and
    // after one slow frame the replay jumped ahead to catch up (a skipped moment)
    const rdt = clamp(+arguments[0] || 0, 0, .05);
    if (!c.startWall) { c.startWall = performance.now(); c.el = 0; } else c.el += rdt;
    const el = c.el;
    if (el > c.dur + .9) { endFinal(); return _render.apply(this, arguments); }
    let ok = false; try { ok = applyClip(c, el); } catch (e) { warnOnce(e); KC.inReplay = false; }
    try { return _render.apply(this, arguments); } finally { if (ok) restoreClip(); }
  };
}
// stopping (respawn / any state change) also ends a final killcam that is still up
{ const _stop = stopKillcam; stopKillcam = function () { if (KC.fin && state !== 'matchend') endFinal(); return _stop.apply(this, arguments); }; }
addEventListener('keydown', e => { if (e.code === 'Space' && KC.fin && state === 'matchend') { e.preventDefault(); endFinal(); } });

/* ---------- test hooks ---------- */
KC.R = R; KC.ghosts = GH; KC.ghostFor = ghostFor; KC.lookOf = lookOf; KC.redress = buildGhosts; KC.duck = duck; KC.wTitle = wTitle; KC.ghostLook = ghostLook; KC.poseBoomKC = poseBoomKC; KC.boomBlade = () => KB; KC.consts = { RS, DCT, SLOW, SLOW_PRE, POST, END_PAD, HIST };
KC.orig = { recFrame: _recFrame, recShot: _recShot, recFire: _recFire, startKillcam: _startKillcam, stopKillcam: _stopKillcam, applyReplay: _applyReplay, restoreReplay: _restoreReplay };
KC.ready = true;
})();
