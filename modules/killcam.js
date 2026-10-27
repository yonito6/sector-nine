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
const KC = window.S9KC = { ver: 2, clip: null, log: null, errors: 0 };

/* ---------- tuning (the Unity port can read these from killcam.INTEGRATE.md) ---------- */
const RS = 5.5;          // respawn delay while a killcam runs: index.html frame loop `const RS = REC.on ? 5.5 : 4.7` (we never extend it)
const DCT = .85;         // you see your own body start to fall this long before the killcam takes over (CoD-style quick cut)
const SLOW = .35;        // slow motion speed on the final shot
const SLOW_PRE = .6;     // ...for this many replay-seconds before the death
const POST = .4;         // replay-seconds shown after the killing shot (you go down, the killer keeps moving)
const END_PAD = .12;     // the killcam finishes this long before the respawn
const FINAL_LEN = 5.2;    // the final killcam (match-winning kill, shown to everyone at match end) runs this long
const HIST = 7.5;        // seconds of history kept (the killcam uses ~3-4 s of it; the rest covers long slow frames)
const S_ = 18;           // numbers per recorded sample:
// 0 x,1 y,2 z,3 aimYaw,4 aimPitch,5 crouch,6 ads,7 reload 0-1 (-1 none),8 weapon index,9 on ground,10 alert,11 dead,
// 12 dead time,13 visible,14 body yaw,15 knife swing 0-1 (-1 none),16 hp,17 sprinting
const ANGLE = new Set([3, 14]), DISCRETE = [8, 9, 10, 11, 13, 17];
const R = { tracks: new Map(), shots: [], fires: [], hits: [], throws: [], booms: [], kills: [], proj: [], projHad: false, lastT: -1, n: 0, cur: null, death: null, pid: new WeakMap(), pidN: 0 };
let WIDS = null; const widx = w => { if (!WIDS) WIDS = Object.keys(WEAPONS); const i = WIDS.indexOf(w); return i < 0 ? 0 : i; }, wname = i => (WIDS || Object.keys(WEAPONS))[i | 0] || 'carbine';
const hasW = w => typeof w === 'string' && Object.prototype.hasOwnProperty.call(WEAPONS, w);
const smooth = x => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
const V = new Float64Array(S_), SA = new Float64Array(S_), SB = new Float64Array(S_);
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const warnOnce = (e) => { KC.errors++; if (KC.errors < 4) console.warn('[killcam]', e); };

/* ================= recording ================= */
function trk(ent) { let t = R.tracks.get(ent); if (!t) { t = { ent, t: [], v: [] }; R.tracks.set(ent, t); } return t; }
function pushS(tr, t, vals) { tr.t.push(t); for (let i = 0; i < S_; i++) tr.v.push(vals[i]); }
function botVals(r) {
  const p = r.root.position, w = r.remote ? (hasW(r.kcW) ? r.kcW : r.netW || 'carbine') : r.weapon;
  V[0] = p.x; V[1] = p.y; V[2] = p.z; V[3] = r.aimYaw || 0; V[4] = r.aimPitch || 0; V[5] = r.crouch || 0;
  V[6] = r.remote ? (r.kcAds || 0) : (r.ads || 0);
  V[7] = r.remote ? (r.kcRp !== undefined ? r.kcRp : r.reload > 0 ? .5 : -1) : r.reload > 0 ? clamp(1 - r.reload / ((BOTW[r.weapon] || {}).reload || 2), 0, 1) : -1;
  V[8] = widx(w); V[9] = r.onGround === false ? 0 : 1;
  V[10] = r.remote || r.targetVis || G.time - r.lastSeenT < 4 || G.time - r.lastHurt < 4 || r.mode === 'fight' ? 1 : 0;
  V[11] = r.dead ? 1 : 0; V[12] = r.deadT || 0; V[13] = r.root.visible ? 1 : 0; V[14] = r.bodyYaw || 0; V[15] = r.remote && r.kcSw !== undefined ? r.kcSw : -1; V[16] = r.hp || 0; V[17] = 0;
  return V;
}
function meVals() {
  V[0] = P.pos.x; V[1] = P.pos.y; V[2] = P.pos.z; V[3] = wrapPi(P.yaw + Math.PI); V[4] = P.pitch; V[5] = P.crouch || 0; V[6] = P.ads || 0;
  V[7] = P.reload > 0 && P.reloadDur ? clamp(1 - P.reload / P.reloadDur, 0, 1) : -1; V[8] = widx(P.weapon); V[9] = P.onGround ? 1 : 0; V[10] = P.sprint ? 0 : 1;
  V[11] = P.dead ? 1 : 0; V[12] = P.dieT || 0; V[13] = 1; V[14] = V[3]; V[15] = P.swingT > 0 && P.swingDur ? clamp(1 - P.swingT / P.swingDur, 0, 1) : -1; V[16] = P.hp; V[17] = P.sprint ? 1 : 0;
  return V;
}
function resetRec() { R.tracks.clear(); for (const k of ['shots', 'fires', 'hits', 'throws', 'booms', 'kills', 'proj']) R[k].length = 0; R.lastT = -1; R.death = null; }
function trimRec(t) {
  const lim = t - HIST;
  for (const [ent, tr] of R.tracks) {
    let n = 0; while (n < tr.t.length && tr.t[n] < lim) n++;
    if (n) { tr.t.splice(0, n); tr.v.splice(0, n * S_); }
    if (!tr.t.length || (t - tr.t[tr.t.length - 1] > 2 && ent !== PLAYER_ENT && !robots.includes(ent))) R.tracks.delete(ent);
  }
  for (const k of ['shots', 'fires', 'hits', 'throws', 'booms', 'kills', 'proj']) { const A = R[k]; let n = 0; while (n < A.length && A[n].t < lim) n++; if (n) A.splice(0, n); }
}
function recording() { return state === 'play' || (state === 'dead' && R.death && G.time - R.death.t < POST + .25); }
function record() {
  const t = G.time; if (t < R.lastT - .25) resetRec();
  if (t - R.lastT < 1 / 125) return; R.lastT = t;
  pushS(trk(PLAYER_ENT), t, meVals());
  for (const r of robots) if (!r.kcGhost) pushS(trk(r), t, botVals(r));
  // grenades, rockets and slow projectiles in flight
  const it = [];
  const add = (m, kind) => { if (!m || !m.parent) return; let id = R.pid.get(m); if (!id) { id = ++R.pidN; R.pid.set(m, id); } it.push([id, m, m.position.x, m.position.y, m.position.z, kind]); };
  for (const n of NADES) add(n.m, 'nade'); for (const q of ROCKETS) add(q.m, 'rocket'); for (const q of PROJ) add(q.m, 'proj');
  if (it.length || R.projHad) R.proj.push({ t, it }); R.projHad = it.length > 0;
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
  const r = _updateRobots.apply(this, arguments);
  if (!menu) { try { if (recording()) record(); if (state === 'dead' && KC.clip && !KC.live) buildGhosts(1); } catch (e) { warnOnce(e); } }
  return r;
};
const _hurtPlayer = hurtPlayer;
hurtPlayer = function (dmg, from, attacker, crit, weapon) {
  const hp0 = P.hp, live = state === 'play' && !P.dead;
  const res = _hurtPlayer.apply(this, arguments);
  if (live && P.hp < hp0) { const h = { t: G.time, ent: attacker || null, dmg: hp0 - P.hp, crit: !!crit, weapon, kill: !!P.dead }; R.hits.push(h); if (R.cur && R.cur.net && R.cur.ent === attacker) R.cur.hit = h; }
  return res;
};
const _playerDie = playerDie;
playerDie = function (killer, weapon, crit) {
  R.death = { t: G.time, wall: performance.now(), killer: killer || null, weapon: weapon || 'carbine', crit: !!crit, hp: killer && killer.hp, ts: null };
  return _playerDie.apply(this, arguments);
};
const _killEntity = killEntity;
killEntity = function (v, k, weapon, crit) { if (state === 'play' || state === 'dead') R.kills.push({ t: G.time, wall: performance.now(), v, k, weapon, crit: !!crit, hp: k && k.isPlayer ? P.hp : k && k.hp }); return _killEntity.apply(this, arguments); };
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
      st.sw = P.swingT > 0 && P.swingDur ? R2(clamp(1 - P.swingT / P.swingDur, 0, 1)) : -1; st.wid = P.weapon; st.sp = P.sprint ? 1 : 0;
      st.yw4 = R4(P.yaw + Math.PI); st.pt4 = R4(P.pitch);
    }
    return p0.apply(this, arguments);
  };
  try { return _netSend.apply(this, arguments); } finally { room.presence = p0; }
};
const _netReceive = netReceive;
netReceive = function (E, pr) {
  const r = E && E.r; if (!r || !pr) return _netReceive.apply(this, arguments);
  const L = E.last || {}, shot0 = L.shot | 0, nade0 = L.nade | 0, proj0 = L.proj || 0, wasDead = P.dead, rDead = r.dead;
  R.cur = { ent: r, t: G.time, net: true, hit: null };
  let res; try { res = _netReceive.apply(this, arguments); } finally { var cur = R.cur; R.cur = null; }
  if (!Array.isArray(pr.x)) return res;
  if ((pr.sh | 0) > shot0 && Array.isArray(pr.sx) && recording()) R.fires.push({ t: G.time, ent: r });
  r.kcAds = clamp(+pr.ad || 0, 0, 1); r.kcRp = pr.rp === undefined ? undefined : clamp(+pr.rp, -1, 1); r.kcSw = pr.sw === undefined ? undefined : clamp(+pr.sw, -1, 1);
  if (hasW(pr.wid)) r.kcW = pr.wid;
  const H = r.kcHist || (r.kcHist = []), ts = +pr.ts || performance.now(), aw = performance.now();
  if (!H.length || ts > H[H.length - 1].ts) {
    const yw = Number.isFinite(+pr.yw4) ? +pr.yw4 : +pr.yw || 0, pt = Number.isFinite(+pr.pt4) ? +pr.pt4 : +pr.pt || 0;
    H.push({ ts, aw, x: +pr.x[0] || 0, y: +pr.x[1] || 0, z: +pr.x[2] || 0, yaw: yw, pitch: pt, cr: +pr.cr || 0, g: pr.g ? 1 : 0, w: hasW(pr.wid) ? pr.wid : NET_W[pr.w | 0] || 'carbine',
      ad: r.kcAds, rp: r.kcRp !== undefined ? r.kcRp : pr.rl ? .5 : -1, sw: r.kcSw !== undefined ? r.kcSw : -1, dd: pr.dd ? 1 : 0, hp: +pr.hp || 0, sp: pr.sp ? 1 : 0,
      shot: (pr.sh | 0) > shot0 && Array.isArray(pr.sx) ? { n: Math.min(6, (pr.sh | 0) - shot0), sx: pr.sx.slice(0, 6).map(Number) } : null,
      nade: (pr.ns | 0) > nade0 ? 1 : 0, proj: Array.isArray(pr.pj) && pr.pj[0] > proj0 ? 1 : 0, hit: cur && cur.hit ? { crit: cur.hit.crit, kill: cur.hit.kill } : null });
    while (H.length > 2 && aw - H[0].aw > HIST * 1000) H.shift();
  }
  if (!wasDead && P.dead && R.death && P.killer === r) R.death.ts = ts;   // this state carried the killing hit
  if (!rDead && r.dead && (state === 'play' || state === 'dead')) { const mine = NET.room && pr.kb === NET.room.myId, k = mine ? PLAYER_ENT : remoteById(pr.kb);
    if (k) R.kills.push({ t: G.time, wall: aw, v: r, k, weapon: NET_W[pr.kw | 0] || 'carbine', crit: !!pr.kh, hp: k.isPlayer ? P.hp : k.hp }); }
  return res;
};

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
  targetsDirty = true; g.tag.remove(); g.kcGhost = true; g.kcEnt = ent; g.root.visible = false; g.gun.visible = false; g.guns = { [g.weapon]: g.gunInner }; g.curW = g.weapon;
  g.kcScene = scene; GH.set(ent, g); return g;
}
function dropGhost(g) { scene.remove(g.root); scene.remove(g.gun); try { g.mixer.stopAllAction(); g.mixer.uncacheRoot(g.mixer.getRoot()); freeBotGpu(g.root); freeBotGpu(g.gun); } catch (e) {} GH.delete(g.kcEnt); }
function ghostFor(ent) { let g = GH.get(ent); if (g && g.kcScene !== scene) { dropGhost(g); g = null; } return g || makeGhost(ent); }
// build the actors the replay needs, a few per frame while the death cam runs (no hitch at the moment you die)
function buildGhosts(max) {
  const c = KC.clip; if (!c) return; let made = 0;
  for (const ent of c.cast) { const g = GH.get(ent); if (g && g.kcScene === scene) continue; ghostFor(ent); if (++made >= max) return; }
}
function setGhostWeapon(g, w) {
  if (g.curW === w) return; g.curW = w;
  if (w === 'knife' || !hasW(w)) return;
  if (!g.guns[w]) { try { g.guns[w] = rifleTP(w); } catch (e) { g.guns[w] = g.guns[Object.keys(g.guns)[0]]; } }
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
  const tr = { t: [], v: [], fires: [], shots: [], hits: [], throws: [] }, gap = w => Math.min(.06, 60 / (((WEAPONS[w] || {}).rpm) || 600));
  let deadSince = null;
  for (const h of H) {
    const tg = deathT - (wall - (h.ts + off)) / 1000; if (tg < deathT - HIST || (tr.t.length && tg <= tr.t[tr.t.length - 1])) continue;
    if (h.dd) { if (deadSince === null) deadSince = tg; } else deadSince = null;
    V[0] = h.x; V[1] = h.y; V[2] = h.z; V[3] = h.yaw; V[4] = h.pitch; V[5] = h.cr; V[6] = h.ad; V[7] = h.rp; V[8] = widx(h.w); V[9] = h.g; V[10] = 1; V[11] = h.dd;
    V[12] = deadSince === null ? 0 : tg - deadSince; V[13] = 1; V[14] = h.yaw; V[15] = h.sw; V[16] = h.hp; V[17] = h.sp;
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
function speedAt(rt, c) {   // replay speed: 1x, easing into slow motion for the final shot, then back
  const sA = c.deathT - SLOW_PRE, sB = c.deathT + .03;
  const w = rt < sA ? smooth((rt - (sA - .12)) / .12) : rt < sB ? 1 : 1 - smooth((rt - sB) / .18);
  return 1 - (1 - SLOW) * w;
}
// I = { killer, victim, t (death time), wall, weapon, crit, hp, final }: any killer (bot, online player, you) and any victim
function makeClip(I) {
  const killer = I.killer, victim = I.victim; if (!killer || !victim || killer === victim) return null;
  for (const [e, g] of GH) if (e !== PLAYER_ENT && !robots.includes(e)) dropGhost(g);   // players who left / old matches
  const deathT = I.t, me = R.tracks.get(victim); if (!me || me.t.length < 10) return null;
  let kind = 'bot', ktr = null;
  if (killer === PLAYER_ENT) { const t0 = R.tracks.get(PLAYER_ENT); if (t0) { ktr = { t: t0.t, v: t0.v }; kind = 'me'; } }
  else if (killer.remote) { ktr = netTrack(killer, deathT, I.wall); if (ktr) kind = 'net'; }
  if (!ktr) { const t0 = R.tracks.get(killer); if (!t0) return null; ktr = { t: t0.t, v: t0.v }; }   // live reference: post-death samples keep coming in
  if (ktr.t.length < 8) return null;
  const c = { killer, victim, kind, ktr, deathT, t1: deathT + POST, weapon: I.weapon, crit: !!I.crit, hp: Math.max(0, Math.ceil(I.hp || 0)), me, final: !!I.final };
  // how much history fits before the respawn: slow-motion part costs more real time
  let slowCost = 0; for (let rt = c.deathT - SLOW_PRE - .15; rt < c.t1; rt += 1 / 480) slowCost += 1 / 480 / speedAt(rt, c);
  const avail = c.final ? FINAL_LEN : RS - DCT - END_PAD;
  let t0 = c.deathT - SLOW_PRE - .15 - (avail - slowCost);
  t0 = Math.max(t0, ktr.t[0] + .06, me.t[0] + .06);
  if (t0 > deathT - .6) return null;           // too little footage (you were killed right after spawning): normal death cam
  c.t0 = t0;
  // real time -> replay time table (smooth slow motion, same every run)
  const tab = [t0]; let rt = t0; while (rt < c.t1) { rt = Math.min(c.t1, rt + speedAt(rt, c) / 240); tab.push(rt); }
  c.tab = tab; c.dur = (tab.length - 1) / 240;
  // the killer's events
  if (kind === 'bot' || kind === 'me') {
    const inW = e => e.ent === killer && e.t >= t0 - .5 && e.t <= c.t1 + .1;
    c.fires = (kind === 'me' ? R.shots : R.fires).filter(inW).map(e => e.t).filter((t, i, a) => i === 0 || t !== a[i - 1]);
    c.kshots = R.shots.filter(inW).map(s => ({ t: s.t, b: s.b, c: s.c, w: s.w, l: s.l, wid: null }));
    c.khits = R.hits.filter(inW).map(h => ({ t: h.t, crit: h.crit, kill: h.kill }));
    c.kthrows = R.throws.filter(inW).map(e => e.t);
    c.victimDelay = 0;
  } else {
    c.fires = ktr.fires; c.kshots = ktr.shots.map(s => ({ t: s.t, b: s.b, c: null, w: 0, l: 0, wid: s.w })); c.khits = ktr.hits; c.kthrows = ktr.throws;
    // what they saw of you was older than what you saw: their interpolation delay + the network both ways
    const myPing = NET.room && NET.room.ping ? +NET.room.ping() || 0 : 0;
    c.victimDelay = victim === PLAYER_ENT ? clamp(((killer.target || 100) + myPing + (+killer.ping || 0)) / 1000, .04, .4) : 0;
  }
  if (!c.khits.some(h => h.kill)) c.khits.push({ t: deathT, crit: c.crit, kill: true });   // grenade/rocket kills: the blast is the hit
  // a hit always comes from a shot: if a shot's state never reached us (states are merged in bundles), add it at the hit
  if (c.kind === 'net' && WEAPONS[c.weapon] && c.weapon !== 'knife' && !WEAPONS[c.weapon].projectile && WEAPONS[c.weapon].mode !== 'proj') {
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
  c.cast = [victim]; for (const [ent, tr] of R.tracks) if (ent !== victim && ent !== killer && tr.t.length && tr.t[tr.t.length - 1] >= t0 && tr.t[0] <= c.t1) c.cast.push(ent);
  return c;
}

/* ================= HUD ================= */
let D0 = null;
function dom() {
  if (D0) return D0;
  const kc = $('killcam'); if (!kc) return null;
  const st = document.createElement('style'); st.id = 'kcStyle';
  st.textContent = `#killcam{--kcc:#ff4a3d}
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
#kcSkip{position:absolute;right:calc(16px + env(safe-area-inset-right,0px));bottom:calc(12vh + 34px);pointer-events:auto;cursor:pointer;background:rgba(11,13,16,.78);color:var(--ink,#e8edf2);border:1px solid rgba(255,255,255,.18);padding:7px 12px;font:600 12px/1 var(--mono,ui-monospace,monospace);letter-spacing:.12em}
#kcSkip kbd{font:inherit;color:var(--sodium,#ffb84a);margin-right:6px}
#kcHm{position:absolute;left:50%;top:50%;width:0;height:0;opacity:0}#kcHm i{position:absolute;width:2px;height:10px;background:#fff;left:-1px;top:-5px;box-shadow:0 0 0 1px rgba(0,0,0,.4)}
#kcHm.crit i{background:#ffd27a}#kcHm.kill i{background:#ff4a3d;height:14px;top:-7px;width:3px;left:-1.5px}
#kcFx{position:absolute;inset:0;pointer-events:none;opacity:0;background:radial-gradient(ellipse at center,rgba(255,60,40,0) 40%,rgba(255,40,30,.55))}
#kcDown{position:absolute;left:50%;top:calc(130px + env(safe-area-inset-top,0px));transform:translateX(-50%);font:700 12px/1 var(--mono,ui-monospace,monospace);letter-spacing:.2em;color:#ffd27a;background:rgba(11,13,16,.7);padding:5px 10px}#kcDown[hidden]{display:none}
@media (max-width:560px){#kcBan b{font-size:17px;max-width:34vw}#kcBan>div{padding:7px 9px}#kcBan .kh{min-width:64px}#kcBan .kw svg{display:none}#kcSkip{bottom:calc(12vh + 92px);right:50%;transform:translateX(50%)}}`;
  document.head.appendChild(st);
  const hm = '<i style="transform:rotate(45deg) translateY(-10px)"></i><i style="transform:rotate(135deg) translateY(-10px)"></i><i style="transform:rotate(225deg) translateY(-10px)"></i><i style="transform:rotate(315deg) translateY(-10px)"></i>';
  kc.insertAdjacentHTML('beforeend', `<div id="kcHm">${hm}</div><div id="kcDown" hidden>KILLER DOWN</div><div id="kcBan"><div><small>KILLED BY</small><b id="kcBName"></b></div><div class="kw"><span id="kcBW"></span><em id="kcBHs" hidden>HEADSHOT</em></div><div class="kh"><small>THEIR HP</small><i><s id="kcBHp"></s></i><span id="kcBHpT"></span></div></div><button id="kcSkip" type="button"><kbd>SPACE</kbd>SKIP</button><div id="kcFx"></div>`);
  $('kcSkip').addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); skip(); });
  $('kcSkip').addEventListener('pointerdown', e => e.stopPropagation());
  D0 = { kc, hm: $('kcHm'), fx: $('kcFx'), down: $('kcDown'), cross: $('kcCross'), xi: [...$('kcCross').children] };
  return D0;
}
const WNAME = { nade: 'Plasma grenade', nova: 'Nova launcher' };
function fillBanner(c) {
  const d = dom(); if (!d) return; const k = c.killer;
  d.kc.style.setProperty('--kcc', k.cssCol || '#ff4a3d');
  $('kcBName').textContent = String(k.name || 'Enemy');
  $('kcBan').firstChild.firstChild.textContent = c.final ? `FINAL KILL ON ${String(c.victim.name || '').toUpperCase()}` : 'KILLED BY';
  const tb = $('killcam').querySelector('.kc-top b'); if (tb) tb.textContent = c.final ? 'FINAL KILLCAM' : 'KILLCAM';
  const w = c.weapon, nm = (WEAPONS[w] && WEAPONS[w].name) || WNAME[w] || String(w || '');
  const ic = (typeof ICON === 'object' && (ICON[w] || ICON.rifle)) || '';
  $('kcBW').innerHTML = ic + '<span></span>'; $('kcBW').lastChild.textContent = nm;
  $('kcBHs').hidden = !c.crit;
  const hp = clamp(c.hp, 0, 100); $('kcBan').querySelector('.kh small').textContent = c.killer === PLAYER_ENT ? 'YOUR HP' : 'THEIR HP'; $('kcBHp').style.transform = `scaleX(${hp / 100})`; $('kcBHp').style.background = hp > 50 ? '#5dff9a' : hp > 25 ? '#ffd166' : '#ff6b5d';
  $('kcBHpT').textContent = c.hp > 0 ? `${c.hp} HP` : 'DOWN';
  $('kcName').textContent = String(k.name || ''); $('kcName').style.color = k.cssCol || '';
  d.cross.style.color = k.cssCol || '#fff';
}

/* ================= start / stop / skip ================= */
const DCT0 = DC.T;
const _startKillcam = startKillcam;
startKillcam = function (killer) {
  REC.on = false; KC.clip = null; KC.live = false; KC.skipped = false; DC.T = DCT0;
  const D = R.death; let c = null;
  try { if (D && killer && killer !== PLAYER_ENT) c = makeClip({ killer, victim: PLAYER_ENT, t: D.t, wall: D.wall, weapon: D.weapon, crit: D.crit, hp: D.hp }); } catch (e) { warnOnce(e); c = null; }
  if (!c) return;                                   // self, world, no footage: the normal death cam shows instead
  KC.clip = c; KC.first = true; KC.rt = c.t0; KC.lastRt = c.t0 - 1e-4; KC.bob = 0; KC.hmT = 0; KC.started = performance.now();
  DC.T = Math.max(DCT, RS - END_PAD - c.dur);      // short footage: the death cam simply runs a bit longer
  REC.on = true; REC.deathT = c.deathT; REC.killer = killer; REC.ki = robots.indexOf(killer); REC.lastRt = -1e9;
  fillBanner(c); if (KC.log) KC.log.length = 0; if (KC.snd) KC.snd.length = 0;
};
const _stopKillcam = stopKillcam;
stopKillcam = function () {
  const was = REC.on || KC.clip; REC.on = false; KC.live = false; KC.inReplay = false;
  hideGhosts(); hideProxies();
  if ($('scope')) setStyle($('scope'), 'opacity', '0');
  if ($('killcam')) $('killcam').hidden = true; if ($('death')) $('death').classList.remove('kc'); if ($('hud')) $('hud').classList.remove('kcview');
  if (D0) { D0.fx.style.opacity = '0'; D0.hm.style.opacity = '0'; D0.down.hidden = true; }
  if (was && camera.fov < 40) { camera.fov = 62; camera.updateProjectionMatrix(); }
  DC.T = DCT0; KC.clip = null; if (!KC.fin) duck(false);
};
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
    const S = [...AUD.srcs]; AUD.srcs.clear(); for (const x of S) { try { x.stop(t + .12); } catch (e) {} } }
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
const _applyReplay = applyReplay, _restoreReplay = restoreReplay;
applyReplay = function () {
  const c = KC.clip; if (!c || !REC.on) return false;
  try { if (P.dieT > RS + .25) { stopKillcam(); $('death').hidden = false; return false; } return applyClip(c, Math.max(0, P.dieT - DC.T)); } catch (e) { warnOnce(e); KC.inReplay = false; try { restoreClip(); } catch (e2) {} REC.on = false; KC.clip = null; return false; }
};
restoreReplay = function () { try { restoreClip(); } catch (e) { warnOnce(e); } };
// pose the world as it was at replay time and look through the killer's eyes; el = seconds since the replay started
// (past the end the last frame holds: no flash of the normal HUD before the respawn; with no respawn coming, e.g.
// Demolition, applyReplay hands over to the spectator view at RS + 0.25 s)
function applyClip(c, el) {
  const d = dom();
  buildGhosts(99);
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
  lin(K, rt, SB); if (SB[11] > .5) { kDown = true; let i = seg(K.t, rt); while (i > 0 && K.v[i * S_ + 11] > .5) i--; tk = K.t[i]; lin(K, tk, SB); }
  let thrW = 0; for (const t of c.kthrows) { const q = rt - t; if (q > -.15 && q < .6) thrW = Math.max(thrW, q < 0 ? 1 + q / .15 : q < .45 ? 1 : 1 - (q - .45) / .15); }   // a throw takes the gun off their eye
  const kw = wname(SB[8]), W = WEAPONS[kw] || WEAPONS.carbine, cr = SB[5], ads = clamp(SB[6], 0, 1) * (1 - thrW), rl = SB[7], sw = SB[15], gnd = SB[9] > .5, sprint = SB[17] > .5;
  viewAt(K, tk, VIEW);
  velAt(K, tk, _a); const hs = Math.hypot(_a.x, _a.z), air = !gnd || Math.abs(_a.y) > 2;
  if (!air && !kDown) KC.bob += dt * hs * (sprint ? 1.25 : 1.45);
  const bobAmt = clamp(hs / 6, 0, 1.3) * (1 - ads * .85), kick = kDown ? 0 : kickAt(rt, c.fires), kAmp = clamp((W.kick || 1.5) / 1.5, .6, 2.6);
  const scoped = !!W.scope && ads > .85 && rl < 0 && !kDown;
  const eye = VIEW.y + (c.kind === 'bot' ? lerp(1.62, 1.12, cr) : lerp(1.65, 1.05, cr));
  camera.position.set(VIEW.x, eye + Math.sin(KC.bob * 2) * .04 * bobAmt, VIEW.z);
  let pitch = VIEW.pitch + kick * .011 * kAmp * (scoped ? .6 : 1), yaw = VIEW.yaw + Math.PI;
  if (scoped) { const t2 = rt; pitch += Math.sin(t2 * .9) * .0016; yaw += Math.sin(t2 * .63 + 1) * .002; }
  camera.rotation.set(pitch, yaw, Math.sin(KC.bob) * .008 * bobAmt - cr * .02, 'YXZ');
  camera.updateMatrixWorld();
  { const base = lerp(sprint ? 84 : 78, W.adsFov || 60, ads), z = slow && !scoped ? (1 - sp) / (1 - SLOW) : 0, fv = base - 6 * ez(z);
    if (Math.abs(camera.fov - fv) > .01) { camera.fov = fv; camera.updateProjectionMatrix(); }
    const gf = lerp(60, 50, ads); if (Math.abs(gunCam.fov - gf) > .01) { gunCam.fov = gf; gunCam.updateProjectionMatrix(); } }
  // yaw rate drives the weapon sway, like a mouse does
  const yr = wrapPi(herm(K, tk + .03, 3, true) - herm(K, tk - .03, 3, true)) / .06, pr = (herm(K, tk + .03, 4) - herm(K, tk - .03, 4)) / .06;
  // ---- their weapon, in their hands ----
  const vm = WM[kw] || WM.carbine;
  live.vm = { gv: gunVisible, vis: [], vm, pos: vm.group.position.clone(), rot: vm.group.rotation.clone(), fl: vm.flash ? vm.flash.visible : false, ret: vm.reticle ? vm.reticle.visible : null, rear: vm.rear ? vm.rear.visible : null,
    mag: vm.mag ? [vm.mag.position.clone(), vm.mag.visible] : null, arm: vm.leftArm ? vm.leftArm.position.clone() : null };
  for (const id in WM) if (WM[id].group.visible) { live.vm.vis.push(WM[id].group); WM[id].group.visible = false; }
  let thr = 0; for (const t of c.kthrows) { const k = (rt - t) / .45; if (k >= 0 && k <= 1) thr = Math.max(thr, Math.sin(Math.PI * k)); }
  const showVm = !scoped && !kDown;
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
  if (vm.group.visible && KC.onVm) { try { KC.onVm(vm, kw); } catch (e) { warnOnce(e); } }   // generic hook: a custom weapon module animates its own viewmodel here
  if (vm.group.visible) vm.group.updateMatrixWorld(true);
  // ---- their shots: tracer from their muzzle, flash, sound, sparks ----
  for (const s of c.kshots) if (s.t > prev && s.t <= rt) {
    const mw = muzzleWorld(vm, scoped, _a), ww = WEAPONS[s.wid || kw] || W, wid = s.wid || kw, life = 1 / Math.max(sp, SLOW);
    if (wid === 'arc') zap(mw.clone(), s.b.clone(), new THREE.Color(...(ww.glow || [1, 2, 4])).multiplyScalar(1.4));
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
  for (const s of c.oshots) if (s.t > prev && s.t <= rt) _tracer(s.a, s.b, s.c, s.w, s.l / Math.max(sp, SLOW));
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
    d.hm.className = KC.hmK || ''; d.hm.style.opacity = KC.hmT > 0 ? '1' : '0'; d.hm.style.transform = `scale(${KC.hmT > 0 ? 1 + KC.hmT * 1.2 : 1})`;
    if (!first && d.fx.style.opacity !== '0') { d.fx.style.transition = 'opacity .35s'; d.fx.style.opacity = '0'; }
    const xh = !scoped && ads < .45 && !kDown, gap = (5 + hs * 1.6 + (air ? 14 : 0) + Math.min(1, kick * .7) * 14) * (1 - cr * .3);
    d.cross.style.opacity = xh ? '1' : '0';
    if (xh) { const [u, dn, l, r] = d.xi; u.style.top = `${(-gap - 11).toFixed(1)}px`; dn.style.top = `${gap.toFixed(1)}px`; l.style.left = `${(-gap - 11).toFixed(1)}px`; r.style.left = `${gap.toFixed(1)}px`; for (const q of [u, dn, l, r]) q.style.display = kw === 'knife' ? 'none' : ''; }
    d.down.hidden = !kDown;
  }
  setStyle($('scope'), 'opacity', scoped ? '1' : '0');
  { const A = KC.aud, r = speedAt(rt, c);
    if (!kDown) {
      if (!air && A.air) fxSound('land', { rate: r, t: rt }, 'step'); A.air = air;
      if (!air && hs > 1) { A.step += hs * dt; if (A.step > (sprint ? 2.5 : 1.9)) { A.step = 0; fxSound(sprint ? 'stepSprint' : cr > .5 ? 'stepCrouch' : 'step', { rate: r, vol: .9, t: rt }, 'step'); } }
      if (rl >= 0 && A.rl < .14 && rl >= .14) fxSound(kw === 'sniper' ? 'bolt' : 'magOut', { rate: r, t: rt }, 'reload');
      if (rl >= 0 && A.rl < .58 && rl >= .58) fxSound('magIn', { rate: r, t: rt }, 'reload');
      if (ads >= .5 && A.ads < .5 && rl < 0) fxSound('adsIn', { rate: r, t: rt }, 'ads');
      if (kw === 'knife' && sw >= 0 && A.sw < 0) fxSound('knifeSwing', { rate: r, t: rt }, 'swing');
    }
    A.rl = rl; A.ads = ads; A.sw = sw;
    if (gm && gm.root.visible && rt < c.deathT) { const vh = Math.hypot(gm.vel.x, gm.vel.z); if (gm.onGround && vh > 1) { A.vstep += vh * dt; if (A.vstep > 2.1) { A.vstep = 0; fxSound('step', { rate: r, pos: gm.root.position.clone(), ref: 3, vol: 1.1, t: rt, who: 'victim' }, 'step'); } } }
  }
  setText('kcTime', rt >= c.deathT - .02 ? 'ELIMINATED' : slow ? 'SLOW MOTION' : `-${Math.max(0, c.deathT - rt).toFixed(1)}s`);
  if (KC.log) KC.log.push({ final: c.final, el, rt, wall: performance.now(), x: camera.position.x, y: camera.position.y, z: camera.position.z, yaw: camera.rotation.y, pitch: camera.rotation.x, fov: camera.fov, scoped, ads, kw, vm: vm.group.visible, xh: d ? d.cross.style.opacity === '1' : false,
    hm: KC.hmT > 0, kDown, slow, me: gm ? meInfo(gm) : null, cast: c.cast.length, proxies: [...PX.values()].filter(m => m.visible).length });
  return true;
}
function meInfo(g) {   // test probe: where you are on the killer's screen and how your legs move
  const p = g.root.position; _c.set(p.x, p.y + 1.2, p.z); const toMe = _d.subVectors(_c, camera.position), dist = toMe.length(); toMe.normalize();
  const fwd = _b.set(0, 0, -1).applyQuaternion(camera.quaternion), A = g.act, foot = g.kcFoot || (g.kcFoot = g.model.getObjectByName('mixamorigLeftFoot'));
  let fy = null; if (foot) { foot.getWorldPosition(_a); fy = [_a.x - p.x, _a.y - p.y, _a.z - p.z]; }
  return { vis: g.root.visible, ang: Math.acos(clamp(fwd.dot(toMe), -1, 1)), dist, walk: A.walk.w + A.jog.w + A.sprint.w + A.cwalk.w, air: A.air.w, death: A.death.getEffectiveWeight(), foot: fy, hs: Math.hypot(g.vel.x, g.vel.z) };
}
function restoreClip() {
  if (!KC.inReplay) return; KC.inReplay = false;
  hideGhosts(); hideProxies(); showLive();
  const v = live.vm; if (v) { const vm = v.vm; vm.group.position.copy(v.pos); vm.group.rotation.copy(v.rot); if (vm.flash) vm.flash.visible = v.fl; if (vm.reticle && v.ret !== null) vm.reticle.visible = v.ret; if (vm.rear && v.rear !== null) vm.rear.visible = v.rear;
    if (v.mag) { vm.mag.position.copy(v.mag[0]); vm.mag.visible = v.mag[1]; } if (v.arm) vm.leftArm.position.copy(v.arm);
    vm.group.visible = false; for (const g of v.vis) g.visible = true; gunVisible = v.gv; live.vm = null; }
}

/* ================= FINAL KILLCAM: the match-winning kill, from the winner's eyes, for everyone at match end ================= */
const _endMatch = endMatch;
endMatch = function (winner) {
  const was = G.ended, res = _endMatch.apply(this, arguments);
  if (!was && G.ended && winner && state === 'matchend') { try { startFinal(winner); } catch (e) { warnOnce(e); } }
  return res;
};
function startFinal(winner) {
  let K = null; for (let i = R.kills.length - 1; i >= 0; i--) { const k = R.kills[i]; if (k.k === winner && k.v !== winner && G.time - k.t < 3) { K = k; break; } }
  if (!K) return;
  const c = makeClip({ killer: winner, victim: K.v, t: K.t, wall: K.wall, weapon: K.weapon, crit: K.crit, hp: K.hp, final: true });
  if (!c) return;
  stopKillcam(); KC.fin = c; KC.clip = c; KC.first = true; KC.rt = c.t0; KC.bob = 0; KC.hmT = 0; c.startWall = 0;
  fillBanner(c); if (KC.log) KC.log.length = 0; if (KC.snd) KC.snd.length = 0;
  $('mend').hidden = true; $('hud').hidden = false; $('hud').classList.add('kcview'); $('death').hidden = true; $('killcam').hidden = false;
}
function endFinal() {
  const c = KC.fin; if (!c) return; KC.fin = null; KC.clip = null; KC.live = false; duck(false);
  hideGhosts(); hideProxies(); setStyle($('scope'), 'opacity', '0'); $('killcam').hidden = true; $('hud').classList.remove('kcview');
  if (state === 'matchend') { $('hud').hidden = true; $('mend').hidden = false; }
  if (camera.fov < 40) { camera.fov = 62; camera.updateProjectionMatrix(); }
  const tb = $('killcam').querySelector('.kc-top b'); if (tb) tb.textContent = 'KILLCAM';
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
    if (!c.startWall) c.startWall = performance.now();
    const el = (performance.now() - c.startWall) / 1000;
    if (el > c.dur + .9) { endFinal(); return _render.apply(this, arguments); }
    let ok = false; try { ok = applyClip(c, el); } catch (e) { warnOnce(e); KC.inReplay = false; }
    try { return _render.apply(this, arguments); } finally { if (ok) restoreClip(); }
  };
}
// stopping (respawn / any state change) also ends a final killcam that is still up
{ const _stop = stopKillcam; stopKillcam = function () { if (KC.fin && state !== 'matchend') endFinal(); return _stop.apply(this, arguments); }; }
addEventListener('keydown', e => { if (e.code === 'Space' && KC.fin && state === 'matchend') { e.preventDefault(); endFinal(); } });

/* ---------- test hooks ---------- */
KC.R = R; KC.ghosts = GH; KC.consts = { RS, DCT, SLOW, SLOW_PRE, POST, END_PAD, HIST };
KC.orig = { recFrame: _recFrame, recShot: _recShot, recFire: _recFire, startKillcam: _startKillcam, stopKillcam: _stopKillcam, applyReplay: _applyReplay, restoreReplay: _restoreReplay };
KC.ready = true;
})();
