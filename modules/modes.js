/* Sector Nine game modes, client side: Free for all, Team deathmatch, Demolition.
   The SERVER decides scores, rounds, teams and everything about the charge (match.js); this file shows it and sends
   the player's requests (plant/defuse/pick up, deaths). Loaded after the main game script (uses its globals).
   Demolition, like CS/Valorant: Strike Force (attack) plants the charge at site A or B; Sentinels (defend) stop the plant
   or defuse it. Freeze time at round start, no respawn inside a round (dead players spectate a teammate), the charge
   beeps faster as it runs out, sides swap at halftime, first to 7 rounds. */
(() => {
  'use strict';
  const TEAM = { atk: { name: 'Strike Force', css: '#ff8a3d', col: [1, .42, .12] }, def: { name: 'Sentinels', css: '#3dc8ff', col: [.15, .72, 1] } };
  const REASON = { eliminated: 'Enemy team eliminated', defused: 'Charge defused', exploded: 'Charge detonated', time: 'Time ran out' };
  const MX = { v: null, teams: new Map(), off: 0, freezeEnd: 0, roundEnd: 0, carrier: null, kits: new Set(), bomb: null, act: null, holdE: false, pickT: 0, beepT: 0, layout: null, siteObjs: [], bombObj: null, carryObj: null, spec: null, allowRespawn: false, lastRound: 0, over: false };
  let LAYOUTS = null;
  fetch('data/demo_layouts.json').then(r => r.json()).then(j => { LAYOUTS = j; }).catch(() => {});

  const room = () => NET && NET.on && NET.room;
  const mode = () => (room() && room().meta && room().meta.mode) || 'ffa';
  const teamMode = () => !!room() && mode() !== 'ffa';
  const demo = () => !!room() && mode() === 'demo' && NET.inMatch;
  const myId = () => room() ? room().myId : null;
  const myTeam = () => MX.teams.get(myId()) || null;
  const sNow = () => Date.now() - MX.off;          // the server's clock, as well as we know it
  const left = t => Math.max(0, (t - sNow()) / 1000);
  const layout = () => (LAYOUTS && LAYOUTS[CUR_MAP]) || null;
  const send = o => { const r = room(); if (r && r.send) r.send(o); };
  window.MODE = { MX, teamOf: id => MX.teams.get(id) || null, myTeam, mode, demo, teamMode, layout };
  // what the host sends with "start": the demolition sites for the chosen map
  window.MODE.startExtras = meta => { const L = LAYOUTS && meta && LAYOUTS[meta.map]; return meta && meta.mode === 'demo' && L ? { sites: L.sites } : {}; };
  window.MODE.layouts = () => LAYOUTS;
  // movement is locked during freeze time and while planting/defusing
  window.MODE_frozen = () => demo() && (sNow() < MX.freezeEnd || !!MX.holdAct);

  /* ---------- hooks into the game ---------- */
  // team spawns
  const _pickSpawn = pickSpawn;
  pickSpawn = function (forEnt) {
    const L = layout(), t = myTeam();
    if (forEnt === PLAYER_ENT && teamMode() && L && t) {
      const pts = L[t], used = new Set([...robots].filter(r => r.remote && !r.dead).map(r => Math.round(r.root.position.x) + ',' + Math.round(r.root.position.z)));
      const free = pts.filter(q => !used.has(Math.round(q[0]) + ',' + Math.round(q[1])));
      const q = (free.length ? free : pts)[Math.floor(Math.random() * (free.length || pts.length))];
      const c = nearestOk(cellOf(q[0], q[1]), 6); return new THREE.Vector3(cellX(c), NAV.h[c], cellZ(c));
    }
    return _pickSpawn.apply(this, arguments);
  };
  // no respawn inside a demolition round (the next round brings everyone back)
  const _respawn = respawnPlayer;
  respawnPlayer = function () { if (demo() && !MX.allowRespawn) return; return _respawn.apply(this, arguments); };
  // face the enemy side after a team spawn
  const faceForward = () => { const L = layout(), t = myTeam(); if (!L || !t) return; const other = L[t === 'atk' ? 'def' : 'atk'][0]; P.yaw = Math.atan2(-(other[0] - P.pos.x), -(other[1] - P.pos.z)); };
  // tell the server about my death (it scores it); the victim decides deaths, the killer id comes along
  const _die = playerDie;
  playerDie = function (killer, weapon, crit) {
    const r = _die.apply(this, arguments);
    if (room() && NET.inMatch) send({ k: 'die', by: killer && killer.netId ? killer.netId : null, w: weapon || '', h: !!crit });
    if (MX.holdAct) stopAct();
    return r;
  };
  // no friendly fire in team modes (both on the shooter's side and the victim's side)
  const sameTeam = r => teamMode() && r && r.remote && myTeam() && MX.teams.get(r.netId) === myTeam();
  const _dmg = damageBot;
  damageBot = function (r, dmg, crit, point, dir, zone, attacker) { if (attacker === PLAYER_ENT && sameTeam(r)) return; return _dmg.apply(this, arguments); };
  const _hurt = hurtPlayer;
  hurtPlayer = function (dmg, from, attacker) { if (attacker && sameTeam(attacker)) return; return _hurt.apply(this, arguments); };
  // after the online match is set up, put me at my team's spawn
  const _start = startOnlineMatch;
  startOnlineMatch = function () {
    MX.over = false; MX.lastRound = 0; clearBomb(); buildSites(); if (mode() === 'demo') demoArt();
    const r = _start.apply(this, arguments);
    if (teamMode()) { P.pos.copy(pickSpawn(PLAYER_ENT)); faceForward(); }
    recolorAll(); hud(true); return r;
  };

  /* ---------- server match messages ---------- */
  function onMatch(d) {
    const v = d.v; if (v && v.now) { const off = Date.now() - v.now; MX.off = MX.off ? MX.off + (off - MX.off) * .2 : off; }
    if (v) applyView(v);
    for (const e of d.e || []) event(e);
    hud(true);
  }
  function applyView(v) {
    MX.v = v; MX.teams.clear(); MX.kits.clear();
    for (const [id, team, , , , kit] of v.pl || []) { if (team) MX.teams.set(id, team); if (kit) MX.kits.add(id); }
    MX.bomb = v.bomb; MX.act = v.act;
    if (v.mode === 'demo') { if (v.phase === 'freeze') MX.freezeEnd = v.end; else if (v.phase === 'live') { MX.roundEnd = v.end; if (MX.freezeEnd > sNow()) MX.freezeEnd = 0; } }
    recolorAll(); syncBomb();
  }
  function event(e) {
    switch (e.k) {
      case 'round':
        MX.freezeEnd = e.freezeEnd; MX.roundEnd = e.roundEnd; MX.carrier = e.carrier; MX.lastRound = e.round; clearBomb();
        if (NET.inMatch) roundRespawn();
        { const t = myTeam(), goal = t === 'atk' ? (MX.carrier === myId() ? 'You carry the charge: plant it at site A or B (hold E)' : 'Escort the charge to site A or B') : 'Defend sites A and B'; banner(`ROUND ${e.round}`, `${t ? TEAM[t].name + ' · ' : ''}${goal}`); }
        sfx.wave(); break;
      case 'live': callout('GO', 'multi'); tone('go'); break;
      case 'roundEnd': { const mine = e.winner === myTeam(); banner(`${TEAM[e.winner].name.toUpperCase()} WIN`, `${REASON[e.reason] || ''} · ${e.score.atk} : ${e.score.def}`); tone(mine ? 'win' : 'lose'); stopAct(); break; }
      case 'halftime': banner('HALFTIME', 'Switching sides'); break;
      case 'matchEnd': { MX.over = true; const t = myTeam(), w = e.winner, mine = w === t || w === myId(); banner(mine ? 'VICTORY' : w === 'draw' ? 'DRAW' : 'DEFEAT', TEAM[w] ? `${TEAM[w].name} win the match` : 'Match over'); tone(mine ? 'win' : 'lose'); break; }
      case 'toLobby': if (NET.inMatch && typeof toRoomLobby === 'function') toRoomLobby('Match over. The host can change the map or mode and start again.'); clearBomb(); break;
      case 'planted': MX.bomb = { s: 'planted', p: e.pos, site: e.site, ex: e.explodeAt }; MX.beepT = 0; syncBomb(); callout(`CHARGE PLANTED · SITE ${e.site}`, 'multi'); kfeedText(`Charge planted at site ${e.site}`); tone('planted'); if (e.id === myId()) stopAct(true); break;
      case 'defused': callout('CHARGE DEFUSED', 'multi'); kfeedText('Charge defused'); tone('defused'); MX.bomb && (MX.bomb.s = 'defused'); syncBomb(); if (e.id === myId()) stopAct(true); break;
      case 'exploded': detonate(e.pos); break;
      case 'bombDrop': kfeedText('The charge was dropped'); break;
      case 'bombPick': if (e.id === myId()) callout('YOU PICKED UP THE CHARGE', ''); break;
      case 'actStart': if (e.id === myId()) { MX.myAct = { kind: e.kind, end: e.end, start: sNow(), kit: e.kit }; } else actSound(e); break;
      case 'actCancel': if (e.id === myId()) { MX.myAct = null; } break;
    }
  }
  // round start: everyone back at their team spawn with full health and ammo
  function roundRespawn() {
    const paused = state === 'paused';
    MX.allowRespawn = true; try { respawnPlayer(); } finally { MX.allowRespawn = false; }
    faceForward(); if (paused) setState('paused');
    MX.spec = null;
  }

  /* ---------- plant / defuse / pick up (hold E) ---------- */
  function stopAct(quiet) { if (MX.holdAct && !quiet) send({ k: 'act', on: false }); MX.holdAct = null; MX.myAct = null; }
  function siteHere() { const L = layout(); if (!L) return null; for (const s of L.sites) if (Math.hypot(P.pos.x - s.x, P.pos.z - s.z) <= s.r && Math.abs(P.pos.y - s.y) < 2.5) return s.id; return null; }
  function updateAct(dt) {
    if (!demo() || state !== 'play' || P.dead) { if (MX.holdAct) stopAct(); return; }
    const me = myId(), B = MX.bomb, t = myTeam(), e = !!keys.KeyE, live = MX.v && MX.v.phase === 'live';
    if (e && !MX.holdAct && live) {
      if (t === 'atk' && B && B.s === 'carried' && B.c === me && siteHere()) { MX.holdAct = 'plant'; MX.holdT = 0; }
      else if (t === 'def' && B && B.s === 'planted' && B.p && Math.hypot(P.pos.x - B.p[0], P.pos.z - B.p[2]) < 1.9) { MX.holdAct = 'defuse'; MX.holdT = 0; }
    } else if (!e && MX.holdAct) stopAct();
    // keep asking until the server confirms (my newest position may reach it a moment after the request)
    if (MX.holdAct && !MX.myAct && (MX.holdT -= dt) <= 0) { MX.holdT = .3; send({ k: 'act', on: true, kind: MX.holdAct }); }
    // walk over a dropped charge to pick it up
    if (t === 'atk' && B && B.s === 'dropped' && B.p && Math.hypot(P.pos.x - B.p[0], P.pos.z - B.p[2]) < 1.6 && (MX.pickT -= dt) <= 0) { MX.pickT = .4; send({ k: 'pick' }); }
  }

  // E is also Dash: where an action is possible (plant / defuse / pick up the charge), E does the action instead of dashing
  function canUse() {
    if (!demo() || state !== 'play' || P.dead || !MX.v || MX.v.phase !== 'live') return false; const B = MX.bomb, t = myTeam(), me = myId(); if (!B) return false;
    if (t === 'atk' && B.s === 'carried' && B.c === me && siteHere()) return true;
    if (t === 'def' && B.s === 'planted' && B.p && Math.hypot(P.pos.x - B.p[0], P.pos.z - B.p[2]) < 1.9) return true;
    return false;
  }
  window.MODE.canUse = canUse;
  if (typeof tryDash === 'function') { const _dash = tryDash; tryDash = function () { if (canUse() || MX.holdAct) return; return _dash.apply(this, arguments); }; }

  /* ---------- the charge in the world ---------- */
  function chargeMesh(planted) {
    if (DEMO_ART()) { const c = S9Demo.makeCharge(planted ? 'planted' : 'dropped'); if (planted && c.setTime) c.setTime(40, 40); return c; }
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(.42, .14, .28), new THREE.MeshStandardMaterial({ color: 0x2b2f35, metalness: .6, roughness: .45 }));
    body.position.y = .07; g.add(body);
    const lid = new THREE.Mesh(new THREE.BoxGeometry(.3, .02, .18), new THREE.MeshStandardMaterial({ color: 0x15181c, metalness: .3, roughness: .6 })); lid.position.set(-.03, .15, 0); g.add(lid);
    const led = new THREE.Mesh(new THREE.SphereGeometry(.022, 10, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(3, .2, .1) })); led.position.set(.15, .155, .08); g.add(led); g.userData.led = led;
    for (const s of [-1, 1]) { const w = new THREE.Mesh(new THREE.CylinderGeometry(.008, .008, .3, 6), new THREE.MeshStandardMaterial({ color: s > 0 ? 0xc0392b : 0x2471a3 })); w.rotation.z = Math.PI / 2; w.position.set(0, .145, s * .1); g.add(w); }
    return g;
  }
  const DEMO_ART = () => !!(window.S9Demo && S9Demo._loaded);
  function demoArt() { if (!window.S9Demo || S9Demo._loading) return; S9Demo._loading = S9Demo.load().then(() => { try { S9Demo.warmup(renderer, scene, camera); } catch (e) {} S9Demo._loaded = true; buildSites(); syncBomb(); }).catch(() => {}); }
  function clearBomb() { if (MX.bombObj) { scene.remove(MX.bombObj); if (MX.bombObj.dispose) MX.bombObj.dispose(); MX.bombObj = null; } if (MX.carrierBot && MX.carrierBot.demoCharge) { S9Demo.detach(MX.carrierBot.demoCharge); MX.carrierBot.demoCharge = null; MX.carrierBot = null; } if (MX.carryObj) { MX.carryObj.parent && MX.carryObj.parent.remove(MX.carryObj); MX.carryObj = null; } }
  function syncBomb() {
    const B = MX.bomb; if (!demo() || !B) { clearBomb(); return; }
    // on the ground (dropped or planted)
    if ((B.s === 'dropped' || B.s === 'planted') && B.p) {
      if (!MX.bombObj || MX.bombObj.userData.kind !== B.s) { if (MX.bombObj) scene.remove(MX.bombObj); MX.bombObj = chargeMesh(B.s === 'planted'); MX.bombObj.userData.kind = B.s; scene.add(MX.bombObj); }
      MX.bombObj.position.set(B.p[0], groundAt(B.p[0], B.p[2], B.p[1] + .5, .2), B.p[2]);
    } else if (MX.bombObj) { scene.remove(MX.bombObj); MX.bombObj = null; }
    // on a remote carrier's back
    const carrier = B.s === 'carried' && B.c !== myId() ? robots.find(r => r.netId === B.c) : null;
    const spine = carrier && carrier.B && (carrier.B.spine2 || carrier.B.spine1 || carrier.B.spine);
    if (carrier && DEMO_ART()) { if (MX.carrierBot !== carrier) { if (MX.carrierBot && MX.carrierBot.demoCharge) { S9Demo.detach(MX.carrierBot.demoCharge); MX.carrierBot.demoCharge = null; } carrier.demoCharge = S9Demo.attachCarried(carrier); MX.carrierBot = carrier; } }
    else if (!carrier && MX.carrierBot && MX.carrierBot.demoCharge) { S9Demo.detach(MX.carrierBot.demoCharge); MX.carrierBot.demoCharge = null; MX.carrierBot = null; }
    if (spine && !DEMO_ART()) { if (!MX.carryObj) { MX.carryObj = chargeMesh(false); MX.carryObj.scale.setScalar(100 / Math.max(1e-3, spine.getWorldScale(new THREE.Vector3()).x * 100)); } if (MX.carryObj.parent !== spine) { spine.add(MX.carryObj); MX.carryObj.position.set(0, .05 / spine.getWorldScale(new THREE.Vector3()).x, -.16 / spine.getWorldScale(new THREE.Vector3()).x); MX.carryObj.rotation.set(Math.PI / 2, 0, 0); } }
    else if (MX.carryObj) { MX.carryObj.parent && MX.carryObj.parent.remove(MX.carryObj); MX.carryObj = null; }
  }
  // the beeps get faster as the charge runs out (1 s apart at 40 s -> 0.1 s in the last seconds), blinking with them
  function updateBeep(dt) {
    const B = MX.bomb; if (!demo() || !B || B.s !== 'planted' || !B.ex) return;
    const T = left(B.ex), iv = Math.max(.1, Math.min(1, .1 + T / 40 * .9));
    MX.beepT -= dt; if (MX.beepT <= 0) { MX.beepT = iv; beep(T < 1.5); if (MX.bombObj && MX.bombObj.userData.led) { const L = MX.bombObj.userData.led; L.visible = true; setTimeout(() => { L.visible = false; }, 70); } }
    const c = MX.bombObj; if (c && c.setTime) { c.setTime(T, 40); c.setBlink(T < 5 ? 6 : T < 15 ? 3 : 1); const a = MX.act && MX.act.kind === 'defuse' ? MX.act : null; c.setDefuse(a ? Math.min(1, Math.max(0, (sNow() - a.start) / Math.max(1, a.end - a.start))) : null); }
  }
  function detonate(p) {
    if (!p) return; const pos = new THREE.Vector3(p[0], p[1] + .4, p[2]);
    for (let k = 0; k < 4; k++) setTimeout(() => explode(pos.clone().add(new THREE.Vector3(rand(-2, 2), rand(0, 1.5), rand(-2, 2))), null, 'charge'), k * 90);
    lightFlash(pos, 0xffaa55, 30, 40); P.trauma = 1; clearBomb(); MX.bomb = { s: 'exploded' };
    // the blast: deadly close up, hurts out to ~16 m (behind walls too, like CS)
    const d = Math.hypot(P.pos.x - p[0], P.pos.y - p[1], P.pos.z - p[2]); if (state === 'play' && !P.dead && d < 16) hurtPlayer(d < 7 ? 500 : 500 * (1 - (d - 7) / 9), pos, null, false, 'charge');
  }

  /* ---------- sites ---------- */
  function buildSites() {
    for (const o of MX.siteObjs) scene.remove(o); MX.siteObjs = [];
    if (mode() !== 'demo' || !layout()) return;
    for (const s of layout().sites) {
      let g;
      if (DEMO_ART()) g = S9Demo.makeSite(s.id);
      else {
        g = new THREE.Group();
        const ring = new THREE.Mesh(new THREE.RingGeometry(s.r - .12, s.r, 48), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, .9, .2), transparent: true, opacity: .55, depthWrite: false, side: THREE.DoubleSide }));
        ring.rotation.x = -Math.PI / 2; ring.position.y = .03; g.add(ring);
        const cv = document.createElement('canvas'); cv.width = cv.height = 128; const c = cv.getContext('2d'); c.font = 'bold 110px Arial'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = 'rgba(255,170,60,.9)'; c.fillText(s.id, 64, 70);
        const letter = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false }));
        letter.rotation.x = -Math.PI / 2; letter.position.y = .04; g.add(letter);
      }
      g.position.set(s.x, s.y || 0, s.z); scene.add(g); MX.siteObjs.push(g);
    }
  }

  /* ---------- spectating a teammate while dead (demolition) ---------- */
  let specHidden = null;
  window.MODE_preRender = function (dt) {
    { const r = room(); if (r && r.server && r.onMatch !== onMatch) { r.onMatch = onMatch; r.onNote = r.onNote || (msg => onlineMsg(msg, true)); const q = r.mxQueue || []; r.mxQueue = []; for (const d of q) onMatch(d); } }   // attach to any room, however it was opened
    updateAct(dt); updateBeep(dt); syncBombLight(); hudTick();
    if (!demo() || state !== 'dead' || P.dieT < 6.5) { MX.spec = null; return; }
    const mates = robots.filter(r => r.remote && !r.dead && MX.teams.get(r.netId) === myTeam());
    if (!mates.length) return;
    if (!MX.spec || !mates.includes(MX.spec)) MX.spec = mates[0];
    const r = MX.spec, e = r.root.position;
    camera.position.set(e.x, e.y + 1.62 - (r.crouch || 0) * .5, e.z); camera.rotation.set(r.aimPitch || 0, (r.aimYaw || 0) - Math.PI, 0, 'YXZ');
    r.root.visible = false; specHidden = r;
    $('mxSpec').hidden = false; $('mxSpec').textContent = `Spectating ${r.name} · next round brings you back`;
  };
  window.MODE_postRender = function () { if (specHidden) { specHidden.root.visible = true; specHidden = null; } if (!MX.spec && $('mxSpec')) $('mxSpec').hidden = true; };
  function syncBombLight() { if (demo() && MX.bomb && MX.bomb.s === 'carried') syncBomb(); }

  /* ---------- team colours ---------- */
  function recolorAll() {
    for (const r of robots) if (r.remote) {
      const t = teamMode() ? MX.teams.get(r.netId) : null;
      if (t && r.visor && r.visor.emissive) { const c = TEAM[t].col; r.visor.emissive.setRGB(c[0] * 1.6, c[1] * 1.6, c[2] * 1.6); }
      r.mxTeam = t;
    }
  }

  /* ---------- sounds ---------- */
  function beep(last) { if (!AU.ctx || !MX.bombObj) return; const t = AU.ctx.currentTime, d = bus({ pos: MX.bombObj.position, verb: .15, ref: 6, vol: 1.1 }); osc(d, t, last ? .09 : .06, 'square', last ? 2900 : 2350, last ? 2900 : 2350, .22); }
  function tone(kind) {
    if (!AU.ctx) return; const t = AU.ctx.currentTime, d = AU.dry;
    if (kind === 'go') { osc(d, t, .12, 'triangle', 880, 880, .18); osc(d, t + .14, .2, 'triangle', 1320, 1320, .18); }
    else if (kind === 'win') { [523, 659, 784, 1046].forEach((f, i) => osc(d, t + i * .11, .22, 'triangle', f, f, .16)); }
    else if (kind === 'lose') { [392, 330, 262].forEach((f, i) => osc(d, t + i * .14, .26, 'sawtooth', f, f * .98, .08)); }
    else if (kind === 'planted') { osc(d, t, .3, 'square', 600, 900, .12); osc(d, t + .32, .3, 'square', 900, 600, .12); }
    else if (kind === 'defused') { osc(d, t, .5, 'sine', 1200, 300, .2); }
  }
  function actSound(e) {   // someone else planting/defusing: keypad clicks / tool noise you can hear nearby
    if (!AU.ctx) return; const who = robots.find(r => r.netId === e.id); if (!who) return; const d = bus({ pos: who.root.position, ref: 4, vol: .9 }), t = AU.ctx.currentTime;
    for (let i = 0; i < (e.kind === 'plant' ? 6 : 4); i++) osc(d, t + i * .28, .05, 'square', e.kind === 'plant' ? 1800 + i * 120 : 700, e.kind === 'plant' ? 1800 + i * 120 : 500, .1);
  }

  /* ---------- HUD: score + round timer, alive players, charge status, plant/defuse bar ---------- */
  const css = document.createElement('style');
  css.textContent = `#mxHud{position:fixed;top:10px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:10px;font:700 15px/1 system-ui,sans-serif;color:#fff;z-index:30;pointer-events:none;text-shadow:0 1px 3px #000}
#mxHud[hidden]{display:none}#mxHud .sc{min-width:34px;padding:6px 8px;border-radius:6px;text-align:center;font-size:20px}#mxHud .atk{background:rgba(255,138,61,.85)}#mxHud .def{background:rgba(61,200,255,.85)}
#mxHud .mid{display:flex;flex-direction:column;align-items:center;gap:4px;min-width:96px}#mxHud .clk{font-size:22px;font-variant-numeric:tabular-nums}#mxHud .rd{font-size:11px;opacity:.85;letter-spacing:.08em}
#mxHud .alive{display:flex;gap:3px}#mxHud .alive i{width:7px;height:12px;border-radius:2px;background:currentColor;opacity:.95}#mxHud .alive i.d{opacity:.2}
#mxHud .bomb{font-size:11px;padding:3px 7px;border-radius:5px;background:rgba(0,0,0,.55);letter-spacing:.06em}#mxHud .bomb.hot{background:rgba(220,40,30,.85);animation:mxp .5s infinite alternate}
@keyframes mxp{to{opacity:.55}}#mxBar{position:fixed;left:50%;top:62%;transform:translateX(-50%);width:min(320px,70vw);z-index:30;pointer-events:none;font:700 13px system-ui;color:#fff;text-align:center;text-shadow:0 1px 3px #000}
#mxBar[hidden]{display:none}#mxBar .tr{height:8px;border-radius:4px;background:rgba(0,0,0,.6);margin-top:6px;overflow:hidden}#mxBar .fl{height:100%;width:0;background:linear-gradient(90deg,#ffb347,#ff6a2a)}
#mxTip{position:fixed;left:50%;bottom:120px;transform:translateX(-50%);font:600 13px system-ui;color:#fff;background:rgba(0,0,0,.55);padding:6px 12px;border-radius:6px;z-index:30;pointer-events:none}#mxTip[hidden]{display:none}
#mxSpec{position:fixed;left:50%;bottom:40px;transform:translateX(-50%);font:600 14px system-ui;color:#fff;background:rgba(0,0,0,.6);padding:8px 14px;border-radius:8px;z-index:31}#mxSpec[hidden]{display:none}
#mxFreeze{position:fixed;left:50%;top:38%;transform:translateX(-50%);font:800 44px system-ui;color:#fff;text-shadow:0 2px 10px #000;z-index:30;pointer-events:none}#mxFreeze[hidden]{display:none}`;
  document.head.appendChild(css);
  const root = document.createElement('div');
  root.innerHTML = `<div id="mxHud" hidden><div class="sc atk" id="mxSa">0</div><div class="alive" id="mxAa" style="color:${TEAM.atk.css}"></div><div class="mid"><div class="clk" id="mxClk">0:00</div><div class="rd" id="mxRd"></div><div class="bomb" id="mxBomb" hidden></div></div><div class="alive" id="mxAd" style="color:${TEAM.def.css}"></div><div class="sc def" id="mxSd">0</div></div>
<div id="mxBar" hidden><span id="mxBarT"></span><div class="tr"><div class="fl" id="mxBarF"></div></div></div><div id="mxTip" hidden></div><div id="mxSpec" hidden></div><div id="mxFreeze" hidden></div>`;
  document.body.appendChild(root);
  const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  let hudT = 0;
  function hud() {
    const on = teamMode() && NET.inMatch && MX.v; $('mxHud').hidden = !on; if (!on) { $('mxBar').hidden = $('mxTip').hidden = $('mxFreeze').hidden = true; return; }
    const v = MX.v, mine = myTeam(), flip = mine === 'def';   // my team always on the left
    const L = flip ? 'def' : 'atk', R = flip ? 'atk' : 'def';
    $('mxSa').className = 'sc ' + L; $('mxSd').className = 'sc ' + R; $('mxAa').style.color = TEAM[L].css; $('mxAd').style.color = TEAM[R].css;
    if (v.mode === 'demo') { $('mxSa').textContent = v.score[L]; $('mxSd').textContent = v.score[R]; }
    else { $('mxSa').textContent = (v.tk || {})[L] || 0; $('mxSd').textContent = (v.tk || {})[R] || 0; }
    const dots = t => (v.pl || []).filter(p => p[1] === t).map(p => `<i class="${p[4] ? '' : 'd'}"></i>`).join('');
    $('mxAa').innerHTML = v.mode === 'demo' ? dots(L) : ''; $('mxAd').innerHTML = v.mode === 'demo' ? dots(R) : '';
    $('mxRd').textContent = v.mode === 'demo' ? `ROUND ${v.round} · ${mine ? TEAM[mine].name.toUpperCase() : ''}` : `FIRST TO ${v.limit}`;
  }
  function hudTick() {
    if ((hudT += 1) % 6) return;   // ~10x a second is plenty
    if (!teamMode() || !NET.inMatch || !MX.v) return; const v = MX.v, B = MX.bomb, me = myId();
    let clock = v.mode === 'demo' ? (v.phase === 'freeze' ? left(MX.freezeEnd) : B && B.s === 'planted' ? null : left(MX.roundEnd)) : v.end ? left(v.end) : null;   // no time limit unless the host set one
    $('mxClk').textContent = clock === null ? (v.mode === 'demo' ? '💣' : '') : fmt(clock);
    const fr = demo() && sNow() < MX.freezeEnd; $('mxFreeze').hidden = !fr; if (fr) $('mxFreeze').textContent = Math.ceil(left(MX.freezeEnd));
    // charge status line
    const bt = $('mxBomb');
    if (v.mode === 'demo' && B) { bt.hidden = false; bt.className = 'bomb' + (B.s === 'planted' ? ' hot' : ''); bt.textContent = B.s === 'planted' ? `CHARGE PLANTED · ${B.site}` : B.s === 'dropped' ? 'CHARGE DROPPED' : B.s === 'carried' ? (B.c === me ? 'YOU HAVE THE CHARGE' : myTeam() === 'atk' ? 'TEAMMATE HAS THE CHARGE' : '') : ''; if (!bt.textContent) bt.hidden = true; }
    else bt.hidden = true;
    // what I can do right now
    let tip = '';
    if (demo() && state === 'play' && !P.dead && v.phase === 'live') {
      if (myTeam() === 'atk' && B && B.s === 'carried' && B.c === me) tip = siteHere() ? 'Hold E to plant the charge' : 'Take the charge to site A or B';
      else if (myTeam() === 'def' && B && B.s === 'planted' && B.p && Math.hypot(P.pos.x - B.p[0], P.pos.z - B.p[2]) < 1.9) tip = MX.kits.has(me) ? 'Hold E to defuse (kit: 4 s)' : 'Hold E to defuse (7 s)';
      else if (myTeam() === 'def' && MX.kits.has(me)) tip = '';
    }
    $('mxTip').hidden = !tip; $('mxTip').textContent = tip;
    // my plant/defuse progress
    const a = MX.myAct;
    if (a && MX.holdAct) { $('mxBar').hidden = false; const tot = a.end - a.start, p = Math.min(1, Math.max(0, 1 - (a.end - sNow()) / Math.max(1, tot))); $('mxBarF').style.width = (p * 100).toFixed(1) + '%'; $('mxBarT').textContent = a.kind === 'plant' ? 'PLANTING…' : a.kit ? 'DEFUSING WITH KIT…' : 'DEFUSING…'; }
    else $('mxBar').hidden = true;
  }

  /* ---------- room screen: mode picker + map preview + teams ---------- */
  function injectRoomUi() {
    const addMode = (afterId, id) => {
      const ref = $(afterId); if (!ref || $(id)) return; const lab = document.createElement('label'); lab.className = 'mxModeLab';
      lab.innerHTML = `Mode <select id="${id}"><option value="ffa">Free for all</option><option value="tdm">Team deathmatch</option><option value="demo">Demolition (4+ players)</option></select>`;
      (ref.closest('label') || ref).insertAdjacentElement('afterend', lab);
    };
    addMode('rMap', 'rMode'); addMode('eMap', 'eMode');
    for (const [sel, img] of [['rMap', 'rPrev'], ['eMap', 'ePrev']]) {
      const s = $(sel); if (!s || $(img)) continue; const box = document.createElement('div'); box.className = 'mxPrev'; box.innerHTML = `<img id="${img}" alt=""><span id="${img}T"></span>`;
      (s.closest('label') || s).insertAdjacentElement('afterend', box);
      const upd = () => { const m = MAPS.find(q => q.id === s.value); $(img).src = `assets/ui/map_${s.value}.jpg`; $(img + 'T').textContent = m ? m.tag || '' : ''; };
      s.addEventListener('change', upd); upd();
    }
    const st = document.createElement('style'); st.textContent = `.mxPrev{display:flex;flex-direction:column;gap:4px;margin:6px 0}.mxPrev img{width:100%;max-width:360px;aspect-ratio:16/9;object-fit:cover;border-radius:8px;border:1px solid rgba(255,255,255,.15);background:#111}.mxPrev span{font-size:12px;opacity:.75}.mxModeLab{display:block;margin:6px 0}
.oteam{font-size:11px;font-weight:700;padding:2px 6px;border-radius:4px;margin-left:6px}.oteam.atk{background:${TEAM.atk.css};color:#000}.oteam.def{background:${TEAM.def.css};color:#000}`;
    document.head.appendChild(st);
    const em = $('eMode'); if (em) em.addEventListener('input', () => { $('oEdit').dataset.dirty = '1'; $('oEditMsg').textContent = 'Unsaved changes'; });
  }
  injectRoomUi();
  // keep the edit panel's mode in sync, show teams in the lobby list
  if (typeof renderRoom === 'function') {
    const _rr = renderRoom;
    renderRoom = function (m) {
      const r = _rr.apply(this, arguments); if (!m) return r;
      if ($('eMode') && !$('oEdit').dataset.dirty) $('eMode').value = m.mode || 'ffa';
      if ($('ePrev') && $('eMap')) { $('eMap').dispatchEvent(new Event('change')); }
      const need = m.mode === 'demo' ? 4 : 2, host = NET.room && NET.room.isHost;
      $('oRoomInfo').textContent = `${({ ffa: 'Free for all', tdm: 'Team deathmatch', demo: 'Demolition' })[m.mode || 'ffa']} · ` + $('oRoomInfo').textContent;
      if (!m.started && host) { $('btnStart').disabled = m.count < need; if (m.count < need) $('btnStart').textContent = `Waiting for players (${m.count}/${need})`; }
      return r;
    };
  }
  // hook the room so match messages reach us
  const _open = openRoom;
  openRoom = async function () { const ok = await _open.apply(this, arguments); const r = NET.room; if (ok && r) { r.onMatch = onMatch; r.onNote = msg => onlineMsg(msg, true); } return ok; };
})();
