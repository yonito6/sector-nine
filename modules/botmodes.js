/* Sector Nine: every mode vs bots (modules/botmodes.js).
   Play vs bots used to be Free for all only. This add-on adds offline Team deathmatch and Demolition with bot teammates and
   bot enemies (3v3, 4v4 or 5v5) on any map, at Easy / Normal / Hard, and difficulty for FFA too.
   - RULES: the match runs in this browser with the SAME rules code as the online server: data/shared/match.js is a byte-copy
     of sector-nine-server/match.js and data/modes.json of its modes.json (qa/gate.d/botmodes.js checks both). A local "room"
     feeds modes.js exactly the messages the server would ({v, e} through MODE.local), so the HUD, round banners,
     scoreboard, kill feed, charge, plant/defuse bar, spectating and the end screen are the online ones.
   - BOTS: team-aware (they never target or hurt teammates; their bullets pass teammates), TDM squads that group, share
     what they see and push together; Demolition attackers carry, escort, plant and guard the charge, pick it up when it
     drops; defenders hold both sites, rotate on contact, retake, defuse (kit first). Tuning: data/botmodes.json.
   - Bot matches never earn XP or Shards (nothing here talks to the server).
   Hooks only (no index.html edits): wraps startMatch, menuScene, pickSpawn, killEntity, damageBot, traceShot, perceive,
   think, moveBot, combatBot, updateTags, boardHTML, MODE_preRender. Load AFTER modes, roundfx and menu.
   Test API: window.S9BotModes (see bottom). */
(() => {
  'use strict';
  if (window.S9BotModes) return;
  const $ = id => document.getElementById(id);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TEAM = { atk: { name: 'Strike Force', css: '#ff8a3d', col: [1, .42, .12] }, def: { name: 'Sentinels', css: '#3dc8ff', col: [.15, .72, 1] } };
  const MODE_NAME = { ffa: 'Free for all', tdm: 'Team deathmatch', demo: 'Demolition' };
  const CFG_KEY = 'sector9-botcfg';
  const S = window.S9BotModes = {
    ready: false, on: false, M: null, LR: null, speed: 1, rulesOver: null, err: null,
    cfg: { mode: 'ffa', size: 4, diff: 'normal' },
    stats: { ffBlocked: 0, teamKills: 0, plants: [], defuses: [], picks: 0, rounds: [], halftimes: 0, events: 0, matchEnd: null, deaths: 0 },
  };
  try { Object.assign(S.cfg, JSON.parse(localStorage.getItem(CFG_KEY) || '{}')); } catch (e) {}
  const saveCfg = () => { try { localStorage.setItem(CFG_KEY, JSON.stringify(S.cfg)); } catch (e) {} };

  /* ---------------- shared rules: the server's own match.js + modes.json, loaded as data ---------------- */
  let MT = null, BOT = null;
  S.loading = Promise.all([
    fetch('data/modes.json').then(r => r.json()), fetch('data/shared/match.js').then(r => r.text()), fetch('data/botmodes.json').then(r => r.json())
  ]).then(([rules, src, bot]) => {
    const mod = { exports: {} };
    // CommonJS in a private function scope: none of match.js's names leak into the page
    new Function('module', 'exports', 'require', src)(mod, mod.exports, p => { if (/modes\.json$/.test(p)) return rules; throw new Error('botmodes: unexpected require ' + p); });
    MT = S.MT = mod.exports; BOT = S.BOT = bot; S.rules = rules; S.ready = true;
    if (!BOT.difficulty[S.cfg.diff]) S.cfg.diff = 'normal';
    if (!BOT.match.teamSizes.includes(+S.cfg.size)) S.cfg.size = BOT.match.defaultTeamSize;
    if (!BOT.match.modes.includes(S.cfg.mode)) S.cfg.mode = 'ffa';
    try { menuUi(); } catch (e) { S.err = String(e && e.stack || e); }
  }).catch(e => { S.err = String(e && e.stack || e); console.warn('botmodes: rules failed to load', e); });

  /* ---------------- helpers ---------------- */
  const D = () => BOT.difficulty[S.cfg.diff] || BOT.difficulty.normal;
  const clock = () => 1e6 + G.time * 1000;               // match time stops while paused (offline, like the FFA clock)
  const mode = () => S.M ? S.M.mode : 'ffa';
  const R = () => S.M.rules;
  const layout = () => (window.MODE && MODE.layout && MODE.layout()) || null;
  const idOf = e => !e ? null : e === PLAYER_ENT ? 'me' : e.mxBot ? e.netId : null;
  const ent = id => id === 'me' ? PLAYER_ENT : robots.find(r => r.mxBot && r.netId === id) || null;
  const teamOf = e => !S.on || !e ? null : e === PLAYER_ENT ? S.myTeam : e.mxBot ? e.mxTeam : null;
  const same = (a, b) => { const ta = teamOf(a), tb = teamOf(b); return !!(ta && tb && ta === tb); };
  const posOf = e => e === PLAYER_ENT ? P.pos : e.root.position;
  const alive = e => e === PLAYER_ENT ? (state === 'play' && !P.dead) : !e.dead;
  const d2 = (a, x, z) => Math.hypot(a.x - x, a.z - z);
  const rnd = (a) => a[0] + Math.random() * (a[1] - a[0]);
  const snap = (x, z) => { const c = nearestOk(cellOf(x, z), 6); return { x: cellX(c), z: cellZ(c), y: NAV.h[c] }; };
  const frozen = () => S.on && mode() === 'demo' && S.M.phase === 'freeze';
  const bots = () => robots.filter(r => r.mxBot);

  /* ---------------- the local room (what the server is online) ---------------- */
  function makeRoom(meta) {
    const LR = { local: true, server: true, myId: 'me', inMatch: true, meta, onMatch: null, peers: () => [],
      send(o) {   // the same requests modes.js sends the server: plant/defuse (act) and pick up; deaths come from killEntity
        if (!S.on || !o) return; const now = clock();
        if (o.k === 'act') { reportAll(now); if (o.on) MT.beginAct(S.M, 'me', o.kind === 'defuse' ? 'defuse' : 'plant', now); else MT.stopAct(S.M, 'me'); flush(); }
        else if (o.k === 'pick') { reportAll(now); if (MT.pickBomb(S.M, 'me', now)) flush(); }
        else if (o.k === 'drop') { reportAll(now); if (MT.dropByPlayer(S.M, 'me', now)) flush(); }
      } };
    return LR;
  }
  function dispatch(d) {
    const LR = S.LR; if (!LR) return;
    if (MODE.MX) MODE.MX.off = Date.now() - d.v.now;   // our clock is the match clock (it stops while paused)
    const h = typeof LR.onMatch === 'function' ? LR.onMatch : MODE.local.onMatch;
    try { h.call(LR, d); } catch (e) { S.err = String(e && e.stack || e); console.warn('botmodes dispatch', e); }
  }
  function flush(force) {
    const M = S.M; if (!M) return; const now = clock(), ev = MT.drain(M);
    if (!ev.length && !force && now - (S.viewT || 0) < 250) return;
    S.viewT = now; syncTeams();
    dispatch({ v: MT.view(M, now), e: ev });
    for (const e of ev) { S.stats.events++; try { onEvent(e); } catch (err) { S.err = String(err && err.stack || err); console.warn('botmodes event', e.k, err); } }
  }
  function reportAll(now) {
    const M = S.M;
    if (alive(PLAYER_ENT)) MT.report(M, 'me', { x: [P.pos.x, P.pos.y, P.pos.z] }, now);
    for (const r of robots) if (r.mxBot && !r.dead) { const p = r.root.position; MT.report(M, r.netId, { x: [p.x, p.y, p.z] }, now); }
  }

  /* ---------------- teams: colours follow the side (halftime swaps them) ---------------- */
  function syncTeams() {
    const M = S.M; const me = M.players.get('me'); S.myTeam = me ? me.team : null;
    if (mode() !== 'ffa' && S.myTeam && PLAYER_ENT.cssCol !== TEAM[S.myTeam].css) PLAYER_ENT.cssCol = TEAM[S.myTeam].css;
    for (const r of robots) if (r.mxBot) { const p = M.players.get(r.netId); const t = p ? p.team : null; if (t && r.mxTeam !== t) teamLook(r, t); }
  }
  function teamLook(r, t) {
    r.mxTeam = t; const c = TEAM[t].col, k = r.mxShade || 0;
    r.color.setRGB(c[0] * (1 - k * .25), c[1] * (1 - k * .25), c[2] * (1 - k * .25)); r.cssCol = TEAM[t].css;
    if (r.body) r.body.color.setRGB(1, 1, 1).lerp(r.color, .3);
    if (r.visor && !r.dead) r.visor.emissive.setRGB(c[0] * 1.6, c[1] * 1.6, c[2] * 1.6);
  }

  /* ---------------- match start / end ---------------- */
  const _startMatch = startMatch;
  startMatch = async function (mapId) {
    if (S.on) stopLocal();
    const want = S.startOpts || !S.ready || BOT.match.modes.includes(S.cfg.mode) ? S.cfg.mode : 'ffa';   // a mode switched off in botmodes.json is never started from the menu
    if (want === 'ffa' || !S.ready || !window.MODE || !MODE.local) {
      const r = await _startMatch.apply(this, arguments);
      if (S.ready) { const sk = D().skill; for (const b of robots) if (!b.remote) b.skill = rnd(sk); }   // difficulty for FFA too
      return r;
    }
    // loading a map takes several frames: keep the end screen's "next match" countdown from starting a second match meanwhile
    const was = G.starting; G.starting = true;
    try { return await startLocal(Object.assign({}, S.startOpts || {}, { mode: want, map: mapId })); } finally { G.starting = was; }
  };
  async function startLocal(o) {
    const cfg = S.cfg, md = o.mode || cfg.mode, size = Math.max(2, Math.min(5, +(o.size || cfg.size) || 4));
    if (o.diff && BOT.difficulty[o.diff]) cfg.diff = o.diff;
    await loadMap(o.map || mapIdFor(md));
    if (md === 'demo' && window.S9Demo && !S9Demo._loaded) {   // the charge + site art, compiled BEFORE the match (never mid-match)
      if (!S9Demo._loading) S9Demo._loading = S9Demo.load().then(() => { try { S9Demo.warmup(renderer, scene, camera); } catch (e) {} S9Demo._loaded = true; }).catch(() => {});
      await S9Demo._loading;
    }
    KILL_LIMIT = 1e9; $('hMode').textContent = `${MODE_NAME[md]} · vs bots · ${size}v${size}`;
    clearDynamic(); while (robots.length) removeRobot(robots[0]);
    // the match: the server's rules, our clock
    G.time = 0;
    const L = layout() || {}, tdmKills = o.kills || size * BOT.match.tdmKillsPerPlayer;
    const M = MT.newMatch({ mode: md, map: CUR_MAP, kills: tdmKills, sites: L.sites || null, time: md === 'tdm' ? BOT.match.tdmTimeLimit : 0, balance: 'manual', teamLock: true });
    if (S.rulesOver && S.rulesOver[md]) M.rules = Object.assign({}, M.rules, S.rulesOver[md]);   // tests: fast timers
    S.M = M; S.on = true; S.stats = { ffBlocked: 0, teamKills: 0, plants: [], defuses: [], picks: 0, rounds: [], halftimes: 0, events: 0, matchEnd: null, deaths: 0, mode: md, map: CUR_MAP, size };
    S.plan = { site: null, assign: new Map(), rotateTo: null, rotateAt: 0, seen: { A: new Set(), B: new Set() }, switched: false, hold: new Map(), guard: new Map() };
    S.squad = { atk: { until: 0 }, def: { until: 0 } }; S.intel = { atk: null, def: null }; S.ending = false; S.viewT = 0; S.startT = performance.now();
    const myT = o.team || (Math.random() < .5 ? 'atk' : 'def'), other = myT === 'atk' ? 'def' : 'atk';
    const nick = (typeof NET !== 'undefined' && NET.nick) || 'You';
    MT.addPlayer(M, 'me', nick, 0, myT);
    const names = BOT_NAMES.slice().sort(() => Math.random() - .5), W = BOT.match.weapons, sk = D().skill;
    let n = 0;
    for (const [t, count] of [[myT, size - 1], [other, size]]) for (let i = 0; i < count; i++) {
      const id = 'b' + (++n), c = TEAM[t].col;
      const r = buildBot({ name: names[n - 1], color: c, weapon: W[i % W.length], skill: rnd(sk) });
      r.mxBot = true; r.netId = id; r.campCd = 1e12; r.mxShade = (i % 3) * .5; r.mxIdx = i; teamLook(r, t);
      MT.addPlayer(M, id, r.name, 0, t);
    }
    Object.assign(PLAYER_ENT, { kills: 0, deaths: 0, score: 0, heads: 0, streak: 0, name: 'You' });
    resetPlayer(); setModel(P.weapon); if (station) station.cd = 0; P.shield = 2;
    for (const p of PADS) { p.ready = true; p.t = 0; p.item.visible = true; }
    Object.assign(G, { firstBlood: false, time: 0, matchT: 1e12, ended: false, endT: 0, score: 0, kills: 0, heads: 0, fired: 0, hits: 0, headHits: 0, dmg: 0, bestStreak: 0, combo: 0, comboT: 0, multi: 0, multiT: 0, heartT: 0, wave: 0, queue: [] });
    if (renderer.shadowMap.enabled !== QUALITY[CFG.q].shadow > 0) applyQuality();
    $('feed').innerHTML = ''; $('kfeed').innerHTML = ''; updateHud(true);
    const meta = { mode: md, map: CUR_MAP, kills: tdmKills, name: 'Bot match', started: true, count: size * 2, players: [...M.players.values()].map(p => ({ id: p.id, n: p.n, team: p.team })) };
    S.LR = makeRoom(meta); MODE.local.set(S.LR); MODE.local.begin(); document.body.classList.add('s9bm-team');
    MT.start(M, clock()); syncTeams(); if (md === 'demo') newRoundPlan();
    // teams known before anyone spawns: put everyone at their side's spawn, then hand the start events over (next frame,
    // so the round-flow overlay is attached and plays its intro)
    dispatch({ v: MT.view(M, clock()), e: [] }); MODE.local.placeMe();
    for (const r of bots()) { respawnBot(r, true); r.respawnT = 1e9; }
    S.pendingStart = 2;
    keepDemoPrograms(md === 'demo');
    warmShaders(); try { renderer.compile(scene, camera); } catch (e) {}
    if (S.keeper) S.keeper.visible = false;
    return true;
  }
  // demoassets disposes a charge's own materials whenever one is removed (and its warm-up disposes what it compiled), so
  // the next plant / drop / carrier would compile the same shader again mid-match. One hidden charge of each kind that is
  // never disposed keeps those programs alive for the whole session.
  function keepDemoPrograms(on) {
    if (!on || S.keeper || !(window.S9Demo && S9Demo._loaded)) { if (S.keeper) S.keeper.visible = !!on; return; }
    const g = new THREE.Group(); g.name = 's9bm_keeper'; g.position.set(0, -400, 0);
    try { for (const k of ['planted', 'carried', 'dropped']) g.add(S9Demo.makeCharge(k)); if (S9Demo.makeKit) g.add(S9Demo.makeKit()); } catch (e) {}
    g.traverse(o => { o.frustumCulled = false; }); scene.add(g); S.keeper = g;
  }
  function mapIdFor(md) { const id = nextMapId(); return id; }
  function stopLocal() {
    if (!S.on) return; S.on = false; S.M = null;
    if (S.LR) S.LR.inMatch = false; S.LR = null;
    try { MODE.local.set(null); } catch (e) {}
    KILL_LIMIT = 30; PLAYER_ENT.cssCol = '#ffb066'; S.myTeam = null; document.body.classList.remove('s9bm-team');
  }
  // the FFA clock / kill-limit end never applies to a team match (the shared rules decide when it ends)
  const _endMatch = endMatch;
  endMatch = function () { if (S.on) return; return _endMatch.apply(this, arguments); };
  // going online always ends a bot match first (the online room takes over modes.js again)
  if (typeof startOnlineMatch === 'function') { const _som = startOnlineMatch; startOnlineMatch = function () { if (S.on) stopLocal(); return _som.apply(this, arguments); }; }
  if (typeof openRoom === 'function') { const _or = openRoom; openRoom = function () { if (S.on) stopLocal(); return _or.apply(this, arguments); }; }
  // team sizes stay exact: nothing but the bots this module built may live in a team match. The title-screen roster
  // (7 free-for-all bots, newRoster) must never be rebuilt on top of a running match (seen: 4 + 7 = 11 enemies).
  const _newRoster = newRoster;
  newRoster = function () { if (S.on && mode() !== 'ffa') return; return _newRoster.apply(this, arguments); };
  function purgeStrays() { if (!S.on || mode() === 'ffa') return 0; let n = 0; for (const r of robots.slice()) if (!r.mxBot && !r.remote) { removeRobot(r); n++; } if (n) { S.stats.strays = (S.stats.strays || 0) + n; targetsDirty = true; } return n; }
  S.purgeStrays = purgeStrays;
  const _menuScene = menuScene;
  menuScene = function () { if (S.on) stopLocal(); return _menuScene.apply(this, arguments); };
  function endScreen(e) {
    if (G.ended) return; G.ended = true; G.endT = 16;
    const w = e.winner, mine = S.myTeam, res = w === 'draw' ? 'draw' : w === mine ? 'win' : 'lose';
    const sc = mode() === 'demo' ? e.score : { atk: teamKills('atk'), def: teamKills('def') };
    $('mendKicker').textContent = w === 'draw' ? `${MODE_NAME[mode()]} · draw ${sc.atk} : ${sc.def}` : `${TEAM[w].name} win ${sc[w]} : ${sc[w === 'atk' ? 'def' : 'atk']} · ${MODE_NAME[mode()]}`;
    $('mendTitle').innerHTML = res === 'win' ? 'Victory' : res === 'draw' ? 'Draw' : 'Defeat';
    $('mendBoard').innerHTML = teamBoard();
    $('mendStats').textContent = `${PLAYER_ENT.kills} kills · ${PLAYER_ENT.deaths} deaths · ${PLAYER_ENT.heads} headshots · accuracy ${G.fired ? Math.round(G.hits / G.fired * 100) : 0}% · bot matches don't earn XP or Shards`;
    if (res === 'win') sfx.clear();
    setState('matchend'); if (document.pointerLockElement) document.exitPointerLock();
  }
  const teamKills = t => { let n = 0; for (const p of S.M.players.values()) if (p.team === t) n += p.kills; return n; };

  /* ---------------- what happens in the match (after modes.js has shown it) ---------------- */
  function onEvent(e) {
    const M = S.M; if (!M) return;
    switch (e.k) {
      case 'round':
        S.stats.rounds.push({ round: e.round, myTeam: S.myTeam });
        for (const r of bots()) { r.mxAct = null; if (r.dead || true) { respawnBot(r, true); r.respawnT = 1e9; } }
        newRoundPlan(); break;
      case 'respawn': { const r = ent(e.id); if (r && r !== PLAYER_ENT && r.dead) { respawnBot(r); r.respawnT = 1e9; } break; }
      case 'halftime': S.stats.halftimes++; S.stats.swapAt = M.round; break;
      case 'planted': S.stats.plants.push({ id: e.id, site: e.site, round: M.round }); for (const r of bots()) if (r.netId === e.id) r.mxAct = null; break;
      case 'defused': S.stats.defuses.push({ id: e.id, round: M.round }); for (const r of bots()) if (r.netId === e.id) r.mxAct = null; break;
      case 'bombPick': S.stats.picks++; break;
      case 'actCancel': { const r = ent(e.id); if (r && r !== PLAYER_ENT) r.mxAct = null; break; }
      case 'death': S.stats.deaths++; if (e.teamKill) S.stats.teamKills++; break;
      case 'roundEnd': { const st = S.stats.rounds[S.stats.rounds.length - 1]; if (st) Object.assign(st, { winner: e.winner, reason: e.reason, score: e.score }); for (const r of bots()) r.mxAct = null; break; }
      case 'exploded': blast(e.pos); break;
      case 'matchEnd':
        S.stats.matchEnd = { winner: e.winner, score: e.score, myTeam: S.myTeam, table: e.table }; S.ending = true;
        setTimeout(() => { if (S.on && S.M === M) endScreen(e); }, mode() === 'demo' ? 3600 : 1600); break;
    }
  }
  // the charge's blast also takes out bots (online, each player's own game applies it to them)
  function blast(p) {
    if (!p) return;
    for (const r of bots()) { if (r.dead) continue; const q = r.root.position, d = Math.hypot(q.x - p[0], q.y - p[1], q.z - p[2]); if (d >= 16) continue;
      const pt = q.clone(); pt.y += 1; const dir = pt.clone().sub(new THREE.Vector3(p[0], p[1], p[2])).normalize(); r.shield = 0;
      damageBot(r, d < 7 ? 500 : 500 * (1 - (d - 7) / 9), false, pt, dir, 'body', null, 'nade'); }
  }

  /* ---------------- per frame: clock, positions, bot plant/defuse/pick up, flush ---------------- */
  function step(dt) {
    const M = S.M; if (!M || S.ending && M.over && G.ended) return;
    const now = clock();
    reportAll(now);
    if (M.mode === 'demo' && M.phase === 'live') objectives(now);
    MT.tick(M, now);
    flush();
  }
  function preTick(rdt) {
    if (!S.on || !S.M) return;
    purgeStrays();
    if (S.pendingStart > 0) { if (--S.pendingStart === 0) flush(true); return; }
    if (state === 'play' || state === 'dead') {
      step(rdt);
      // tests only: run the world (bots, grenades, projectiles, match clock) several steps per frame
      for (let k = 1; k < (S.speed | 0); k++) { const dt = Math.min(rdt, 1 / 30); G.time += dt; updateRobots(dt, false); updateNades(dt); updateProj(dt); updateRockets(dt); step(dt); }
      if (mode() === 'demo' && state === 'dead') { const t = $('deathT'); if (t && !/spectat/i.test(t.textContent)) t.textContent = 'Out for this round · spectating your team'; }
    }
  }
  // the per-frame hook rides the MODE_preRender chain; a module that later REPLACES the chain (instead of wrapping it) cut botmodes off:
  // no extra world steps, no match clock (Demolition stuck in freeze, TDM never at its kill target; 2026-11-08). Self-heal: re-hook
  // whenever a match runs and the hook has not ticked for 0.5 s. S.frameId guards against a double call in one frame.
  const hookPre = () => { const pre = window.MODE_preRender; const w = function (dt) { const fid = S.rafId; if (fid !== S.lastFid) { S.lastFid = fid; S.lastTick = performance.now(); try { preTick(dt); } catch (e) { S.err = String(e && e.stack || e); if (!S.errLogged) { S.errLogged = 1; console.warn('botmodes', e); } } } if (pre) return pre.apply(this, arguments); }; w.__s9bm = true; window.MODE_preRender = w; };
  hookPre(); S.rehooks = 0; S.rafId = 0; S.lastTick = performance.now();
  { const raf = () => { S.rafId++; requestAnimationFrame(raf); }; requestAnimationFrame(raf); }
  setInterval(() => { try { if (S.on && S.M && (state === 'play' || state === 'dead') && performance.now() - S.lastTick > 500) { S.rehooks++; hookPre(); console.warn('botmodes: per-frame hook was cut off (MODE_preRender replaced); re-hooked', S.rehooks); } } catch (e) {} }, 250);

  /* ---------------- game hooks ---------------- */
  // spawns: bots at their side's spawn (the player's own spawn is modes.js's)
  const _pickSpawn = pickSpawn;
  pickSpawn = function (forEnt) {
    const L = layout();
    if (S.on && forEnt && forEnt.mxBot && forEnt.mxTeam && L && L[forEnt.mxTeam]) {
      const pts = L[forEnt.mxTeam], taken = [PLAYER_ENT, ...robots].filter(e => e !== forEnt && alive(e) && teamOf(e) === forEnt.mxTeam).map(posOf);
      const free = pts.filter(q => taken.every(t => Math.hypot(t.x - q[0], t.z - q[1]) > 1.3));
      const q = free.length ? free[(forEnt.mxIdx || 0) % free.length] : pts[Math.floor(Math.random() * pts.length)];
      const c = nearestOk(cellOf(q[0] + (free.length ? 0 : Math.random() - .5), q[1]), 6); return new THREE.Vector3(cellX(c), NAV.h[c], cellZ(c));
    }
    return _pickSpawn.apply(this, arguments);
  };
  // every death goes to the match (the victim's position first, so a dropped charge lands where the carrier fell)
  const _kill = killEntity;
  killEntity = function (v, k) {
    const res = _kill.apply(this, arguments);
    if (S.on && S.M) {
      const vid = idOf(v), now = clock();
      if (vid) { const p = posOf(v); MT.report(S.M, vid, { x: [p.x, p.y, p.z] }, now); MT.death(S.M, vid, idOf(k), String(arguments[2] || ''), !!arguments[3], now); }
      if (v && v.mxBot) { v.respawnT = 1e9; v.mxAct = null; }
      flush(true);
    }
    return res;
  };
  // no friendly fire between bots (the player's side is in modes.js)
  const _dmg = damageBot;
  damageBot = function (r, dmg, crit, point, dir, zone, attacker) {
    if (S.on && attacker && attacker !== r && same(attacker, r)) { S.stats.ffBlocked++; return; }
    return _dmg.apply(this, arguments);
  };
  const _hurt = hurtPlayer;
  hurtPlayer = function (dmg, from, attacker) {
    if (S.on && attacker && attacker !== PLAYER_ENT && same(attacker, PLAYER_ENT)) { S.stats.ffBlocked++; return; }
    return _hurt.apply(this, arguments);
  };
  // a bot's bullet passes its teammates (it never stops on a friend's back)
  const _trace = traceShot;
  traceShot = function (o, d, shooter) {
    if (!S.on || !shooter || !shooter.mxBot || mode() === 'ffa') return _trace.apply(this, arguments);
    if (targetsDirty) rebuildTargets();
    const hid = []; for (const r of robots) if (r !== shooter && !r.dead && r.mxTeam === shooter.mxTeam) { r.dead = true; hid.push(r); }
    const meMate = S.myTeam === shooter.mxTeam && !P.dead; if (meMate) P.dead = true;
    try { return _trace.apply(this, arguments); } finally { for (const r of hid) r.dead = false; if (meMate) P.dead = false; }
  };
  // bots only ever look for enemies
  const _perceive = perceive;
  perceive = function (r, ents) {
    if (S.on && r.mxBot && S.passive && r.mxTeam === S.passive) { r.target = null; r.targetVis = false; return; }   // tests only
    if (S.on && r.mxBot && mode() !== 'ffa') ents = ents.filter(e => e !== r && teamOf(e) !== r.mxTeam && (!S.passive || teamOf(e) !== S.passive));   // (tests: a passive side is out of the fight)
    const out = _perceive.call(this, r, ents);
    if (S.on && r.mxBot && r.targetVis && r.target) shareIntel(r);
    return out;
  };
  const _think = think;
  think = function (r, ents) {
    if (!S.on || !r.mxBot || mode() === 'ffa') return _think.apply(this, arguments);
    if (mode() !== 'ffa') ents = ents.filter(e => e !== r && teamOf(e) !== r.mxTeam);
    if (S.passive && r.mxTeam === S.passive) { r.hasGoal = false; r.mode = 'camp'; return; }
    return brain(r, ents);
  };
  const _move = moveBot;
  moveBot = function (r, dt) {
    if (S.on && r.mxBot && (frozen() || r.mxAct || S.passive === r.mxTeam)) { r.vel.x = r.vel.z = 0; r.crouch = damp(r.crouch, r.mxAct ? 1 : 0, 8, dt); return; }
    return _move.apply(this, arguments);
  };
  const _combat = combatBot;
  combatBot = function (r, dt) {
    if (S.on && r.mxBot && (frozen() || r.mxAct || S.passive === r.mxTeam)) { r.fireCd -= dt; r.flashT -= dt; r.firedT -= dt; r.glint.visible = false; return; }
    return _combat.apply(this, arguments);
  };
  // names + HP over TEAMMATE bots (like online teammates); never over enemies
  const _tags = updateTags;
  updateTags = function () {
    _tags.apply(this, arguments);
    if (!S.on || mode() === 'ffa') return;
    for (const r of robots) {
      if (!r.mxBot || r.mxTeam !== S.myTeam || r.dead || !(state === 'play' || state === 'dead')) continue;
      _tp.set(r.root.position.x, r.root.position.y + 2.05, r.root.position.z);
      const dd = camera.position.distanceTo(_tp); _tp.project(camera);
      if (!(_tp.z < 1 && Math.abs(_tp.x) < 1.1 && Math.abs(_tp.y) < 1.1 && dd < 55)) continue;
      const t = r.tag, x = (_tp.x * .5 + .5) * VW, y = (-_tp.y * .5 + .5) * VH;
      setStyle(t, 'transform', `translate(${x.toFixed(0)}px,${y.toFixed(0)}px) translate(-50%,-100%) scale(${clamp(14 / dd, .6, 1).toFixed(2)})`);
      if (t._n !== r.name) { t._n = r.name; t.firstChild.textContent = r.name; t.firstChild.style.color = r.cssCol; }
      const hp = Math.max(0, Math.round(r.hp)); if (t._hp !== hp) { t._hp = hp; t.querySelector('s').style.transform = `scaleX(${hp / 100})`; }
      setStyle(t, 'opacity', '1');
    }
  };
  const _tp = new THREE.Vector3();
  // scoreboard (Tab): two teams, like CS / Valorant
  const _board = boardHTML;
  boardHTML = function () { if (S.on && mode() !== 'ffa' && S.M) return teamBoard(); return _board.apply(this, arguments); };
  function teamBoard() {
    const M = S.M, pct = (a, b) => b ? Math.round(a / b * 100) + '%' : '—';
    const myT = S.myTeam || 'atk', order = [myT, myT === 'atk' ? 'def' : 'atk'];
    const sc = M.mode === 'demo' ? M.score : { atk: teamKills('atk'), def: teamKills('def') };
    const rows = t => [...M.players.values()].filter(p => p.team === t).sort((a, b) => b.kills - a.kills || a.deaths - b.deaths).map(p => {
      const e = ent(p.id), me = p.id === 'me', st = me ? { s: G.fired || 0, h: G.hits || 0, hh: G.headHits || 0 } : { s: (e && e.shots) || 0, h: (e && e.hits) || 0, hh: (e && e.headHits) || 0 };
      const dead = M.mode === 'demo' && !p.alive;
      return `<tr class="${me ? 'me' : ''}"${dead ? ' style="opacity:.5"' : ''}><td></td><td><i style="background:${TEAM[t].css}"></i>${esc(me ? 'You' : p.n)}${p.id === (M.bomb && M.bomb.carrier) && t === myT && M.bomb.state === 'carried' ? ' 💣' : ''}</td><td>${p.kills}</td><td>${p.deaths}</td><td>${(p.kills / Math.max(1, p.deaths)).toFixed(2)}</td><td>${pct(st.h, st.s)}</td><td>${pct(st.hh, st.h)}</td><td>${p.score}</td><td>${me ? '—' : 'BOT'}</td></tr>`; }).join('');
    const head = t => `<tr class="s9bm-th"><td colspan="9" style="color:${TEAM[t].css};font-weight:800;letter-spacing:.08em;padding-top:10px">${TEAM[t].name.toUpperCase()} · ${sc[t] | 0}${t === myT ? ' · YOUR TEAM' : ''}</td></tr>`;
    const me = PLAYER_ENT;
    return `<table><thead><tr><th>#</th><th>Player</th><th>K</th><th>D</th><th>K/D</th><th>Acc</th><th>HS</th><th>Score</th><th>Ping</th></tr></thead><tbody>${order.map(t => head(t) + rows(t)).join('')}</tbody></table>
  <div class="mystats"><div><b>${(me.kills / Math.max(1, me.deaths)).toFixed(2)}</b><span>K/D</span></div><div><b>${pct(G.hits || 0, G.fired || 0)}</b><span>Accuracy</span></div><div><b>${me.heads}</b><span>Headshot kills</span></div><div><b>${Math.round(G.dmg || 0).toLocaleString()}</b><span>Damage</span></div><div><b>${M.mode === 'demo' ? 'Round ' + M.round : 'First to ' + M.killLimit}</b><span>${MODE_NAME[M.mode]}</span></div></div>`;
  }

  /* ================= bot brains ================= */
  function goTo(r, x, z, m) {
    const s = snap(x, z);
    if (!r.hasGoal || !r.path || Math.hypot(r.goal.x - s.x, r.goal.z - s.z) > 1.5) setGoal(r, s.x, s.z);
    r.mode = m || 'roam'; r.mxHold = false;
  }
  function hold(r, lx, lz) { const p = r.root.position; r.hasGoal = false; r.path = null; r.mode = 'camp'; r.mxHold = true; r.lookYaw = Math.atan2(lx - p.x, lz - p.z) + Math.sin(G.time * .5 + (r.mxIdx || 0)) * .45; }
  const arrived = (r, x, z, k = 1.4) => d2(r.root.position, x, z) < k;
  function shareIntel(r) {
    const t = r.target, p = posOf(t), now = G.time;
    S.intel[r.mxTeam] = { x: p.x, z: p.z, t: now };
    const T = BOT.tdm;
    for (const o of robots) if (o !== r && o.mxBot && !o.dead && o.mxTeam === r.mxTeam && !o.targetVis && d2(o.root.position, p.x, p.z) < T.intelShareDist && (!o.hunt || now - o.lastSeenT > 2)) { o.hunt = t; o.lastSeen.copy(p); o.lastSeenT = now - .5; }
    if (mode() === 'demo') {   // what the sides learn about the sites
      for (const s of (layout() || {}).sites || []) if (d2(p, s.x, s.z) < BOT.demo.seenNearSite) {
        if (r.mxTeam === 'atk') S.plan.seen[s.id].add(idOf(t));
        else if (S.plan.rotateTo !== s.id && !(S.M.bomb && S.M.bomb.state === 'planted')) { S.plan.rotateTo = s.id; S.plan.rotateAt = clock() + D().rotateDelay * 1000; }
      }
    }
  }
  function brain(r, ents) {
    if (frozen() || r.mxAct) return;
    if (r.targetVis && r.target) { _think(r, ents); return; }           // a fight: the normal fight/cover logic (no camping)
    if (r.mode === 'cover' && r.hasGoal && G.time - r.lastHurt < 3) return;
    const huntFor = D().hunt, p = r.root.position;
    if (r.hunt && alive(r.hunt) && teamOf(r.hunt) !== r.mxTeam && G.time - r.lastSeenT < huntFor && huntOk(r)) {
      const dl = d2(p, r.lastSeen.x, r.lastSeen.z);
      if (r.nadeCd <= 0 && dl > 7 && dl < 24 && G.time - r.lastSeenT > .6 && Math.random() < .5 * D().nades * r.skill && !matesNear(r, r.lastSeen, 7)) botNade(r, r.lastSeen);
      goTo(r, r.lastSeen.x, r.lastSeen.z, 'hunt'); return;
    }
    if (mode() === 'tdm') tdm(r); else demo(r);
  }
  const matesNear = (r, q, rad) => [PLAYER_ENT, ...robots].some(e => e !== r && alive(e) && teamOf(e) === r.mxTeam && d2(posOf(e), q.x, q.z) < rad);
  function huntOk(r) {   // demolition: don't leave the objective to chase someone across the map
    if (mode() !== 'demo') return true; const g = objectivePoint(r); return !g || d2(r.lastSeen, g.x, g.z) < BOT.demo.huntNearGoal;
  }

  // TEAM DEATHMATCH: the team picks a push target (fresh intel, else where the enemy roughly is), everyone moves there in a
  // loose group; stragglers regroup first
  function tdm(r) {
    const T = BOT.tdm, t = r.mxTeam, sq = S.squad[t], now = G.time, p = r.root.position;
    if (r.hp < 45 && PADS.some(q => q.ready && q.kind === 'hp' && d2(p, q.x, q.z) < 25)) { const q = PADS.filter(q => q.ready && q.kind === 'hp').sort((a, b) => d2(p, a.x, a.z) - d2(p, b.x, b.z))[0]; goTo(r, q.x, q.z, 'heal'); return; }
    if (now >= sq.until || !sq.goal) {
      const I = S.intel[t]; let g = null;
      if (I && now - I.t < T.intelLife) g = { x: I.x, z: I.z };
      else { const foes = [PLAYER_ENT, ...robots].filter(e => alive(e) && teamOf(e) && teamOf(e) !== t); if (foes.length) { const e = posOf(foes[Math.floor(Math.random() * foes.length)]); g = { x: e.x + rand(-8, 8), z: e.z + rand(-8, 8) }; } }
      if (!g) { const q = POI[Math.floor(Math.random() * POI.length)]; g = { x: q[0], z: q[1] }; }
      sq.goal = snap(g.x, g.z); sq.until = now + rnd(T.squadEvery);
    }
    const mates = robots.filter(o => o.mxBot && !o.dead && o.mxTeam === t);
    let cx = 0, cz = 0; for (const o of mates) { cx += o.root.position.x; cz += o.root.position.z; } cx /= mates.length || 1; cz /= mates.length || 1;
    if (mates.length > 1 && d2(p, cx, cz) > T.regroupDist) { goTo(r, cx, cz, 'regroup'); return; }
    const a = (r.mxIdx || 0) * 2.1 + (t === 'atk' ? 0 : 1), s = T.squadSpread[0] + ((r.mxIdx || 0) % 3) * (T.squadSpread[1] - T.squadSpread[0]) / 2;
    const gx = sq.goal.x + Math.cos(a) * s, gz = sq.goal.z + Math.sin(a) * s;
    if (arrived(r, gx, gz, 1.6)) { const I = S.intel[t]; hold(r, I ? I.x : sq.goal.x * 2 - p.x, I ? I.z : sq.goal.z * 2 - p.z); return; }
    goTo(r, gx, gz, 'push');
  }

  // DEMOLITION
  function newRoundPlan() {
    const L = layout(); if (!L) return;
    const M = S.M, ids = s => [...M.players.values()].filter(p => p.team === s);
    S.plan = { site: L.sites[Math.floor(Math.random() * L.sites.length)].id, assign: new Map(), rotateTo: null, rotateAt: 0, seen: { A: new Set(), B: new Set() }, switched: false, hold: new Map(), guard: new Map(), t0: clock() };
    ids('def').forEach((p, i) => S.plan.assign.set(p.id, L.sites[i % L.sites.length].id));
    S.intel = { atk: null, def: null };
  }
  const site = id => ((layout() || {}).sites || []).find(s => s.id === id);
  function spawnCentre(t) { const L = layout(); let x = 0, z = 0; for (const q of L[t]) { x += q[0]; z += q[1]; } return { x: x / L[t].length, z: z / L[t].length }; }
  function ringPoint(c, ring, toward, key, r) {   // a walkable spot ring[0..1] m from c, biased toward a point; cached per bot
    let s = S.plan.hold.get(key); if (s) return s;
    for (let k = 0; k < 14; k++) {
      const base = toward ? Math.atan2(toward.z - c.z, toward.x - c.x) : rand(0, 6.28), a = base + rand(-1.1, 1.1) * (toward ? 1 : 3), d = rnd(ring);
      const x = c.x + Math.cos(a) * d, z = c.z + Math.sin(a) * d; if (!walkableAt(x, z)) continue;
      const q = snap(x, z); if (c.y !== undefined && !lineOfSight(new THREE.Vector3(q.x, q.y + 1.5, q.z), new THREE.Vector3(c.x, (c.y || 0) + .6, c.z))) continue;
      s = q; break;
    }
    s = s || snap(c.x + rand(-2, 2), c.z + rand(-2, 2)); S.plan.hold.set(key, s); return s;
  }
  function objectivePoint(r) {
    const M = S.M, B = M.bomb; if (!B) return null;
    if (B.state === 'planted' || B.state === 'dropped') return B.pos ? { x: B.pos[0], z: B.pos[2] } : null;
    if (r.mxTeam === 'atk') return site(S.plan.site);
    return site(S.plan.assign.get(r.netId) || 'A');
  }
  function demo(r) {
    const M = S.M, B = M.bomb, p = r.root.position, id = r.netId, Dm = BOT.demo; if (!B || M.phase !== 'live') return;
    if (r.mxTeam === 'atk') {
      // switch site once if the planned one is held by several defenders and the clock is running
      if (!S.plan.switched && B.state !== 'planted' && (clock() - S.plan.t0) / 1000 > R().roundTime * Dm.siteSwitchAfter && S.plan.seen[S.plan.site].size >= Dm.siteSwitchSeen) { S.plan.switched = true; S.plan.site = S.plan.site === 'A' ? 'B' : 'A'; S.plan.hold.clear(); }
      const st = site(S.plan.site);
      if (B.state === 'planted' && B.pos) { const c = { x: B.pos[0], y: B.pos[1], z: B.pos[2] }, g = ringPoint(c, Dm.postPlantRing, null, 'pp' + id, r); if (arrived(r, g.x, g.z)) hold(r, c.x, c.z); else goTo(r, g.x, g.z, 'guard'); return; }
      if (B.state === 'dropped' && B.pos) {
        const near = [...robots].filter(o => o.mxBot && !o.dead && o.mxTeam === 'atk').sort((a, b) => d2(a.root.position, B.pos[0], B.pos[2]) - d2(b.root.position, B.pos[0], B.pos[2]))[0];
        const meNearer = alive(PLAYER_ENT) && S.myTeam === 'atk' && d2(P.pos, B.pos[0], B.pos[2]) < d2(near.root.position, B.pos[0], B.pos[2]) - 6;
        if (near === r && !meNearer) { goTo(r, B.pos[0], B.pos[2], 'pick'); return; }
        const g = ringPoint({ x: B.pos[0], z: B.pos[2] }, [3, 6], null, 'dp' + id, r); if (arrived(r, g.x, g.z)) hold(r, st.x, st.z); else goTo(r, g.x, g.z, 'escort'); return;
      }
      if (B.state === 'carried' && B.carrier === id) {   // the carrier: straight to the site
        const tgt = S.plan.hold.get('plant') || (() => { const q = snap(st.x + rand(-1, 1), st.z + rand(-1, 1)); S.plan.hold.set('plant', q); return q; })();
        goTo(r, tgt.x, tgt.z, 'carry'); return;
      }
      // escorts: into the site ahead of the carrier, but never too far ahead
      const car = ent(B.carrier), g = ringPoint(st, [2, 6], spawnCentre('atk'), 'es' + id, r);
      if (car && alive(car)) { const cd = d2(posOf(car), st.x, st.z), md = d2(p, st.x, st.z); if (md < cd - D().escortLead && md > 7) { hold(r, st.x, st.z); return; } }
      if (arrived(r, g.x, g.z)) hold(r, spawnCentre('def').x, spawnCentre('def').z); else goTo(r, g.x, g.z, 'escort');
      return;
    }
    // defenders
    if (B.state === 'planted' && B.pos) {
      const bx = B.pos[0], bz = B.pos[2];
      const mates = robots.filter(o => o.mxBot && !o.dead && o.mxTeam === 'def');
      const defuser = M.act && M.act.kind === 'defuse' ? M.act.id : null;
      // the kit holder (else the nearest) goes for the charge, the others cover it
      const pick = mates.slice().sort((a, b) => (M.players.get(b.netId).kit - M.players.get(a.netId).kit) * 30 + d2(a.root.position, bx, bz) - d2(b.root.position, bx, bz))[0];
      if (r === pick || (!defuser && d2(p, bx, bz) < 6) || mates.length === 1) { goTo(r, bx, bz, 'defuse'); return; }
      const g = ringPoint({ x: bx, y: B.pos[1], z: bz }, [3, 7], spawnCentre('def'), 'rt' + id, r); if (arrived(r, g.x, g.z)) hold(r, spawnCentre('atk').x, spawnCentre('atk').z); else goTo(r, g.x, g.z, 'retake'); return;
    }
    if (B.state === 'dropped' && B.pos) {   // someone sits on a dropped charge
      const near = robots.filter(o => o.mxBot && !o.dead && o.mxTeam === 'def').sort((a, b) => d2(a.root.position, B.pos[0], B.pos[2]) - d2(b.root.position, B.pos[0], B.pos[2]))[0];
      if (near === r && d2(p, B.pos[0], B.pos[2]) < 30) { const g = ringPoint({ x: B.pos[0], z: B.pos[2] }, [4, 7], null, 'gd' + id, r); if (arrived(r, g.x, g.z)) hold(r, B.pos[0], B.pos[2]); else goTo(r, g.x, g.z, 'guard'); return; }
    }
    let mine = S.plan.assign.get(id) || 'A';
    const ro = S.plan.rotateTo;
    if (ro && ro !== mine && clock() >= S.plan.rotateAt) {   // rotate, but leave one anchor on the other site
      const anchors = robots.filter(o => o.mxBot && !o.dead && o.mxTeam === 'def' && (S.plan.assign.get(o.netId) || 'A') === mine);
      if (anchors.length > 1 && anchors.indexOf(r) > 0 || anchors.length === 1 && Math.random() < .25) { S.plan.assign.set(id, ro); mine = ro; S.plan.hold.delete('hd' + id); }
    }
    const st = site(mine), g = ringPoint(st, BOT.demo.holdRing, spawnCentre('atk'), 'hd' + id, r);
    if (arrived(r, g.x, g.z)) { const a = spawnCentre('atk'); hold(r, a.x, a.z); } else goTo(r, g.x, g.z, 'hold');
  }
  // every frame during a live round: start the plant / defuse / pick-up the moment a bot is in place
  function objectives(now) {
    const M = S.M, B = M.bomb, Dm = BOT.demo, dd = D(); if (!B) return;
    for (const r of robots) {
      if (!r.mxBot || r.dead) continue; const p = r.root.position, id = r.netId;
      if (r.mxAct) {   // planting / defusing: hold still; give up only to fight back (difficulty) unless it's nearly done
        if (!M.act || M.act.id !== id) { r.mxAct = null; continue; }
        const left = (M.act.end - now) / 1000, threat = r.targetVis && r.target && d2(posOf(r.target), p.x, p.z) < 12;
        const late = B.state === 'planted' && B.explodeAt && (B.explodeAt - now) / 1000 < (M.act.end - now) / 1000 + Dm.lateDefuseMargin;
        if (threat && dd.cancelActOnSight && left > 1 && !late && G.time - r.lastHurt < .5) { MT.stopAct(M, id); r.mxAct = null; }
        continue;
      }
      if (M.act) continue;
      const safe = !(r.targetVis && r.target && d2(posOf(r.target), p.x, p.z) < 9 && dd.cancelActOnSight);
      if (r.mxTeam === 'atk' && B.state === 'carried' && B.carrier === id && safe && r.onGround) {
        const s = ((layout() || {}).sites || []).find(s => Math.hypot(p.x - s.x, p.z - s.z) <= (s.r || R().siteRadius) * Dm.plantInside && Math.abs(p.y - (s.y || 0)) < 2.5);
        if (s && MT.beginAct(M, id, 'plant', now)) { r.mxAct = 'plant'; r.hasGoal = false; r.path = null; r.vel.set(0, 0, 0); }
      } else if (r.mxTeam === 'atk' && B.state === 'dropped' && B.pos && d2(p, B.pos[0], B.pos[2]) < Dm.pickReach) { MT.pickBomb(M, id, now); }
      else if (r.mxTeam === 'def' && B.state === 'planted' && B.pos && d2(p, B.pos[0], B.pos[2]) < Dm.defuseReach && r.onGround && (safe || (B.explodeAt - now) / 1000 < (M.players.get(id).kit ? R().defuseKitTime : R().defuseTime) + Dm.lateDefuseMargin * 2)) {
        if (MT.beginAct(M, id, 'defuse', now)) { r.mxAct = 'defuse'; r.hasGoal = false; r.path = null; r.vel.set(0, 0, 0); }
      }
    }
  }

  /* ================= menu: Play vs bots -> mode, team size, difficulty (+ the existing map cards) ================= */
  function menuUi() {
    if (document.getElementById('s9bm')) return;
    const st = document.createElement('style');
    st.textContent = `#s9bm{margin-top:14px}#s9bm .s9m-cards{grid-template-columns:repeat(${BOT.match.modes.length},minmax(0,1fr))}#s9bm .s9bm-row{display:flex;flex-wrap:wrap;gap:12px 22px}#s9bm .s9bm-row>.s9m-field{margin-bottom:0;min-width:0}
#s9bm .s9m-card[disabled],#s9bm .s9m-chip[disabled]{opacity:.35;pointer-events:none}#s9bmLite{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin:8px 0}#s9bmLite select{font:inherit;padding:4px 6px}
@media (max-width:640px){#s9bm .s9m-cards{grid-template-columns:1fr}#s9bm .s9m-card{min-width:0}#s9bm .s9m-card span{white-space:normal}}
body.s9bm-team #matchbar,body.s9bm-team #hPlace{display:none!important}`;
    document.head.appendChild(st);
    const grid = $('s9mBotGrid'), pv = grid && grid.parentElement && grid.parentElement.querySelector('.s9m-pvcol');
    const DIF = BOT.difficulty, SZ = BOT.match.teamSizes;
    if (pv) {
      const icon = k => { const c = document.querySelector(`#s9mModes [data-s9mode="${k}"] svg`); return c ? c.outerHTML : ''; };
      const box = document.createElement('div'); box.id = 's9bm'; box.className = 's9m-panel';
      box.innerHTML = `<div class="s9m-field"><span class="s9m-lab">Mode</span><div class="s9m-cards" role="radiogroup" aria-label="Bot match mode" id="s9bmMode">${BOT.match.modes.map(k => `<button type="button" class="s9m-card" role="radio" data-bm="${k}" aria-checked="false">${icon(k)}<b>${MODE_NAME[k]}</b><span>${{ ffa: 'You + 7 bots. First to 30 kills.', tdm: 'Bot teammates vs bots. Most team kills.', demo: 'Plant or defuse. First to 7 rounds.' }[k]}</span></button>`).join('')}</div></div>
<div class="s9bm-row"><div class="s9m-field"><span class="s9m-lab">Team size</span><div class="s9m-chips" role="radiogroup" aria-label="Team size" id="s9bmSize">${SZ.map(n => `<button type="button" class="s9m-chip s9m-chipw" role="radio" data-bs="${n}" aria-checked="false">${n}v${n}</button>`).join('')}</div></div>
<div class="s9m-field"><span class="s9m-lab">Difficulty</span><div class="s9m-chips" role="radiogroup" aria-label="Difficulty" id="s9bmDiff">${Object.entries(DIF).map(([k, v]) => `<button type="button" class="s9m-chip s9m-chipw" role="radio" data-bd="${k}" aria-checked="false" title="${esc(v.line)}">${esc(v.label)}</button>`).join('')}</div></div></div>`;
      pv.appendChild(box);
      box.addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b || b.disabled) return;
        if (b.dataset.bm) S.cfg.mode = b.dataset.bm; else if (b.dataset.bs) S.cfg.size = +b.dataset.bs; else if (b.dataset.bd) S.cfg.diff = b.dataset.bd; else return;
        try { if (window.S9Menu && S9Menu.sfx) S9Menu.sfx(); } catch (x) {}
        saveCfg(); syncUi();
      });
      const h = document.querySelector('[data-scr="bots"] .s9m-head p, [data-scr="bots"] .s9m-head span'); if (h && /Pick a map/.test(h.textContent)) h.textContent = 'Pick the mode, the map and the bots, then press Play.';
    } else {   // older menu: a compact row next to the Play button
      const play = $('btnPlay'); if (!play) return;
      const row = document.createElement('div'); row.id = 's9bmLite';
      row.innerHTML = `<select id="s9bmModeSel" aria-label="Bot match mode">${BOT.match.modes.map(k => `<option value="${k}">${MODE_NAME[k]}</option>`).join('')}</select><select id="s9bmSizeSel" aria-label="Team size">${SZ.map(n => `<option value="${n}">${n}v${n}</option>`).join('')}</select><select id="s9bmDiffSel" aria-label="Difficulty">${Object.entries(DIF).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select>`;
      play.insertAdjacentElement('beforebegin', row);
      row.addEventListener('change', () => { S.cfg.mode = $('s9bmModeSel').value; S.cfg.size = +$('s9bmSizeSel').value; S.cfg.diff = $('s9bmDiffSel').value; saveCfg(); syncUi(); });
    }
    syncUi();
  }
  function syncUi() {
    const c = S.cfg, set = (box, attr, val) => { if (box) for (const b of box.querySelectorAll(`[${attr}]`)) b.setAttribute('aria-checked', b.getAttribute(attr) === String(val) ? 'true' : 'false'); };
    set($('s9bmMode'), 'data-bm', c.mode); set($('s9bmSize'), 'data-bs', c.size); set($('s9bmDiff'), 'data-bd', c.diff);
    if ($('s9bmSize')) for (const b of $('s9bmSize').querySelectorAll('button')) b.disabled = c.mode === 'ffa';
    if ($('s9bmModeSel')) { $('s9bmModeSel').value = c.mode; $('s9bmSizeSel').value = c.size; $('s9bmDiffSel').value = c.diff; $('s9bmSizeSel').disabled = c.mode === 'ffa'; }
    const dl = (BOT.difficulty[c.diff] || {}).label || '';
    const tags = c.mode === 'ffa' ? ['Free for all', 'You + 7 bots', 'First to 30 kills', dl] : c.mode === 'tdm' ? ['Team deathmatch', `${c.size}v${c.size} · bot teammates`, `First to ${c.size * BOT.match.tdmKillsPerPlayer} team kills`, dl] : ['Demolition', `${c.size}v${c.size} · bot teammates`, 'First to 7 rounds · halftime swap', dl];
    const rules = document.querySelector('[data-scr="bots"] .s9m-rules');
    if (rules) { const sp = rules.querySelectorAll('.s9m-tag'); tags.forEach((t, i) => { let el = sp[i]; if (!el) { el = document.createElement('span'); el.className = 's9m-tag'; rules.appendChild(el); } const ic = el.querySelector('svg'); el.textContent = t; if (ic) el.prepend(ic); }); }
    const home = $('s9mBots'); if (home) { const p = home.querySelector('p'); if (p) p.textContent = c.mode === 'ffa' ? 'You against 7 bots. Everyone respawns. First to 30 kills wins.' : `${MODE_NAME[c.mode]} with bot teammates: ${c.size}v${c.size}, ${dl}.`; const t = $('s9mBotsTags'); const f = t && t.querySelector('.s9m-tag'); if (f) { const ic = f.querySelector('svg'); f.textContent = MODE_NAME[c.mode]; if (ic) f.prepend(ic); } }
  }
  // the menu may be built after we load: retry until its bots screen exists
  { let n = 0; const iv = setInterval(() => { if (!S.ready) { if (++n > 600) clearInterval(iv); return; } if ($('s9mBotGrid') && !$('s9bm')) { const lite = $('s9bmLite'); if (lite) lite.remove(); try { menuUi(); } catch (e) { S.err = String(e); } } if ($('s9bm') || ++n > 600) clearInterval(iv); }, 250); }

  /* ================= test API ================= */
  S.start = async (o = {}) => { await S.loading; S.passive = null; S.speed = 1; S.startOpts = o; if (o.mode) S.cfg.mode = o.mode; if (o.size) S.cfg.size = o.size; if (o.diff) S.cfg.diff = o.diff; if (o.rules) S.rulesOver = o.rules; initAudio(); await startMatch(o.map); setState('play'); return S.info(); };
  S.stop = () => { S.startOpts = null; stopLocal(); };
  S.info = () => { const M = S.M; if (!M) return { on: S.on }; return { on: S.on, robots: robots.length, teamBots: { mine: robots.filter(r => r.mxBot && r.mxTeam === S.myTeam).length, foes: robots.filter(r => r.mxBot && r.mxTeam !== S.myTeam).length }, strays: S.stats.strays || 0, mode: M.mode, map: M.map, phase: M.phase, round: M.round, score: { ...M.score }, swapped: M.swapped, over: M.over, winner: M.winner, myTeam: S.myTeam, bomb: M.bomb && { s: M.bomb.state, c: M.bomb.carrier, site: M.bomb.site }, act: M.act && { kind: M.act.kind, id: M.act.id },
    players: [...M.players.values()].map(p => ({ id: p.id, team: p.team, alive: p.alive, kills: p.kills, deaths: p.deaths, kit: p.kit })),
    bots: bots().map(r => ({ id: r.netId, team: r.mxTeam, dead: r.dead, mode: r.mode, act: r.mxAct || null, x: +r.root.position.x.toFixed(1), z: +r.root.position.z.toFixed(1), skill: +r.skill.toFixed(2) })),
    tk: M.mode === 'tdm' ? { atk: teamKills('atk'), def: teamKills('def') } : null, limit: M.killLimit, stats: S.stats, err: S.err }; };
})();
