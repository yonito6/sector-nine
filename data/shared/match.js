// Sector Nine match rules, run by the server (the single source of truth for scores, rounds, teams and the bomb).
// Pure logic: no sockets, no timers of its own. The server calls tick(now) ~10x a second and feeds player reports in;
// everything that happens comes back as events. Written to port 1:1 to a Unity/C# server later.
//
// Modes
//   ffa   Free for all: everyone for themselves, respawn, first to `kills`. No clock unless the host set a time limit
//         (then best score when time runs out). Scores never reset mid-match: only reaching the goal (or the host's
//         time limit, or the host ending it) finishes a match.
//   tdm   Team deathmatch: two teams, respawn at your team's spawn, first team to `kills` team kills.
//   demo  Demolition (4+ players): Strike Force (attack) must plant the charge at site A or B and keep it alive;
//         Sentinels (defend) stop the plant or defuse it. No respawn inside a round. First to ROUNDS_TO_WIN rounds,
//         sides swap at halftime.
'use strict';

// the rules themselves (times, rounds, radii) live in modes.json: shared with the game client's offline vs-bots matches
// (the site ships an identical copy) and portable to the Unity port as data
const RULES = require('./modes.json').rules;
const TEAMS = ['atk', 'def'];          // Strike Force / Sentinels (in demo the sides swap at halftime; in tdm they are just "red/blue")
const TEAM_NAME = { atk: 'Strike Force', def: 'Sentinels' };

function newMatch(opts) {
  const mode = RULES[opts.mode] ? opts.mode : 'ffa';
  return {
    mode, rules: RULES[mode], map: opts.map, killLimit: Math.max(1, opts.kills | 0 || 15), sites: opts.sites || null,
    balance: opts.balance === 'manual' ? 'manual' : 'auto', teamLock: !!opts.teamLock,   // team balance: auto (kept even) or manual (any split)
    timeLimit: mode === 'demo' ? 0 : Math.max(0, Math.min(3600, (opts.time | 0) || RULES[mode].matchTime || 0)),   // seconds, 0 = none
    phase: 'warmup', phaseEnd: 0, startedAt: 0, round: 0, score: { atk: 0, def: 0 }, swapped: false,
    players: new Map(),   // id -> { id, n, team, kills, deaths, alive, kit, pos:[x,y,z], posT, x:{headshots, perWeapon, streak, bestStreak} }
    gone: new Map(),      // players who left or dropped: their record waits here so they can rejoin with the same score
    bomb: null,           // demo: { state:'carried'|'dropped'|'planted'|'defused'|'exploded', carrier, pos, site, plantedAt, explodeAt }
    act: null,            // demo: the plant or defuse in progress { kind, id, start, end, pos }
    events: [], over: false, winner: null,
  };
}

// --- players -----------------------------------------------------------------------------------------
let joinSeq = 0;
function addPlayer(M, id, n, now, want) {
  if (M.players.has(id)) return;
  const p = { id, n, team: null, kills: 0, deaths: 0, score: 0, alive: M.mode !== 'demo' || M.phase === 'warmup', kit: false, pos: null, posT: 0, x: newExtras() };
  p.joinSeq = ++joinSeq;
  if (M.rules.teams) p.team = M.balance === 'manual' && TEAMS.includes(want) ? want : smallerTeam(M);   // manual: the team they picked in the lobby
  M.players.set(id, p);
  emit(M, { k: 'join', id, team: p.team });
}
function removePlayer(M, id, now) {
  const p = M.players.get(id); if (!p) return;
  M.players.delete(id);
  if (M.bomb && M.bomb.carrier === id) dropBomb(M, p.pos, now);
  if (M.act && M.act.id === id) M.act = null;
  emit(M, { k: 'leave', id });
  if (M.mode === 'demo' && M.phase === 'live') checkRoundEnd(M, now);
}
// leave/drop: like removePlayer, but the record is kept (M.gone) so restore() can put them back with the same score/team
function detach(M, id, now) {
  const p = M.players.get(id); if (!p) return false;
  removePlayer(M, id, now);
  p.alive = false; p.kit = false; p.respawnAt = 0; p.goneAt = now; M.gone.set(id, p);
  return true;
}
// rejoin: same id, same team, same kills/deaths/score. Demolition mid-round: dead until the next round.
function restore(M, id, now) {
  const p = M.gone.get(id); if (!p || M.players.has(id)) return false;
  M.gone.delete(id); delete p.goneAt;
  p.alive = M.mode !== 'demo' ? true : (M.phase === 'freeze' || M.phase === 'warmup');
  p.respawnAt = 0; p.pos = null; p.posT = 0;
  M.players.set(id, p);
  emit(M, { k: 'rejoin', id, team: p.team, alive: p.alive });
  if (M.mode === 'demo' && M.phase === 'live') checkRoundEnd(M, now);
  return true;
}
function forget(M, id) { return M.gone.delete(id); }
function newExtras() { return { headshots: 0, perWeapon: Object.create(null), streak: 0, bestStreak: 0 }; }
const WEAPON_RE = /^[a-z0-9_-]{1,16}$/;
function smallerTeam(M) { const c = { atk: 0, def: 0 }; for (const p of M.players.values()) if (p.team) c[p.team]++; return c.atk <= c.def ? 'atk' : 'def'; }
// a team change. Auto balance: only between rounds / in warm-up, and only if it keeps the teams within one player.
// Manual balance: any split (room size is the only limit), unless the host locked the teams. force = the host moving someone.
function setTeam(M, id, team, force) {
  const p = M.players.get(id); if (!p || !M.rules.teams || !TEAMS.includes(team) || p.team === team) return false;
  if (M.mode === 'demo' && M.phase === 'live') return false;                 // never in the middle of a round
  if (!force) {
    if (M.balance === 'manual') { if (M.teamLock) return false; }
    else { const c = { atk: 0, def: 0 }; for (const q of M.players.values()) if (q.team) c[q.team]++; if ((c[team] + 1) - (c[p.team] - 1) > 1) return false; }
  }
  p.team = team; if (team === 'atk') p.kit = false;
  if (M.bomb && M.bomb.carrier === id && team !== 'atk') {   // the carrier changed sides: the charge goes to another attacker
    const atk = [...M.players.values()].filter(q => q.team === 'atk'); M.bomb.carrier = atk.length ? atk[Math.floor(Math.random() * atk.length)].id : null;
    M.bomb.pos = M.bomb.carrier && M.players.get(M.bomb.carrier).pos ? M.players.get(M.bomb.carrier).pos.slice() : M.bomb.pos;
    emit(M, { k: 'bombPick', id: M.bomb.carrier });
  }
  emit(M, { k: 'team', id, team, by: force ? 'host' : 'self' }); return true;
}
// how many on each side (for "can this start")
function teamCounts(M) { const c = { atk: 0, def: 0 }; for (const p of M.players.values()) if (p.team) c[p.team]++; return c; }
function report(M, id, st, now) {   // latest position from the player's state stream
  const p = M.players.get(id); if (!p || !st || !Array.isArray(st.x)) return;
  const np = [+st.x[0] || 0, +st.x[1] || 0, +st.x[2] || 0];
  if (p.pos && p.alive) { const d = dist(p.pos, np); if (d < 6) { const x = p.x || (p.x = newExtras()); x.moved = (x.moved || 0) + d; } }   // metres travelled (respawn jumps ignored): AFK check
  p.pos = np; p.posT = now;
  if (p.lifeDead && !st.dd && now - (p.lastDeathAt || 0) > 250) p.lifeDead = false;   // the victim's own state says it is alive again: new life (states in flight right after a death are ignored)
  if (M.bomb && M.bomb.state === 'carried' && M.bomb.carrier === id) M.bomb.pos = p.pos.slice();
  if (M.act && M.act.id === id && dist(p.pos, M.act.pos) > M.rules.moveTolerance) cancelAct(M, 'moved');
}

// --- match flow --------------------------------------------------------------------------------------
function start(M, now) {
  M.startedAt = now; M.over = false; M.winner = null; M.score = { atk: 0, def: 0 }; M.round = 0; M.swapped = false;
  M.gone.clear();
  for (const p of M.players.values()) { p.kills = 0; p.deaths = 0; p.score = 0; p.x = newExtras(); }
  if (M.rules.teams) { if (M.balance === 'manual') { for (const p of M.players.values()) if (!p.team) p.team = smallerTeam(M); } else balance(M); }
  if (M.mode === 'demo') startRound(M, now);
  else { M.phase = 'live'; M.phaseEnd = M.timeLimit ? now + M.timeLimit * 1000 : 0; for (const p of M.players.values()) p.alive = true; emit(M, { k: 'start', mode: M.mode, end: M.phaseEnd, limit: M.killLimit }); }
}
// auto balance between rounds: when one side has 2+ more players (people left / joined), the most recent joiner of the
// bigger side moves over, and everyone is told
function rebalance(M) {
  for (;;) {
    const c = teamCounts(M); if (Math.abs(c.atk - c.def) < 2) return;
    const big = c.atk > c.def ? 'atk' : 'def', to = big === 'atk' ? 'def' : 'atk';
    const p = [...M.players.values()].filter(q => q.team === big).sort((a, b) => (b.joinSeq || 0) - (a.joinSeq || 0))[0];
    p.team = to; p.kit = false; emit(M, { k: 'team', id: p.id, team: to, by: 'balance' }); emit(M, { k: 'rebalanced', id: p.id, n: p.n, team: to });
  }
}
function balance(M) {   // shuffle-free balance: move players from the bigger team until sizes differ by at most one
  const list = [...M.players.values()];
  for (const p of list) if (!p.team) p.team = smallerTeam(M);
  for (;;) { const a = list.filter(p => p.team === 'atk'), d = list.filter(p => p.team === 'def'); if (Math.abs(a.length - d.length) <= 1) break; const big = a.length > d.length ? a : d; big[big.length - 1].team = big === a ? 'def' : 'atk'; }
}
function startRound(M, now) {
  const R = M.rules; M.round++;
  if (M.round === R.halftimeAfter + 1 && !M.swapped) {   // halftime: everyone swaps sides, scores follow the teams
    M.swapped = true; for (const p of M.players.values()) p.team = p.team === 'atk' ? 'def' : 'atk';
    M.score = { atk: M.score.def, def: M.score.atk }; emit(M, { k: 'halftime' });
  }
  if (M.balance !== 'manual') rebalance(M);
  M.phase = 'freeze'; M.phaseEnd = now + R.freeze * 1000; M.act = null;
  for (const p of M.players.values()) { p.alive = true; p.kit = false; }
  // the charge goes to a random attacker; one defuse kit per two defenders, given to random defenders
  const atk = [...M.players.values()].filter(p => p.team === 'atk'), def = [...M.players.values()].filter(p => p.team === 'def');
  const carrier = atk.length ? atk[Math.floor(Math.random() * atk.length)] : null;
  M.bomb = { state: 'carried', carrier: carrier ? carrier.id : null, pos: carrier && carrier.pos ? carrier.pos.slice() : null, site: null, plantedAt: 0, explodeAt: 0 };
  shuffle(def).slice(0, Math.ceil(def.length / 2)).forEach(p => { p.kit = true; });
  emit(M, { k: 'round', round: M.round, freezeEnd: M.phaseEnd, roundEnd: M.phaseEnd + R.roundTime * 1000, carrier: M.bomb.carrier, kits: def.filter(p => p.kit).map(p => p.id) });
}
function endRound(M, winner, reason, now) {
  if (M.phase === 'roundEnd' || M.over) return;
  M.score[winner]++; M.phase = 'roundEnd'; M.phaseEnd = now + M.rules.endPause * 1000; M.act = null;
  for (const p of M.players.values()) if (p.team === winner) p.score += 1;
  emit(M, { k: 'roundEnd', winner, reason, score: { ...M.score } });
  if (M.score[winner] >= M.rules.roundsToWin) finish(M, winner, now);
}
function finish(M, winner, now) {
  M.over = true; M.winner = winner; M.phase = 'over'; M.phaseEnd = now + 12000;
  emit(M, { k: 'matchEnd', winner, score: { ...M.score }, table: table(M) });
}
function table(M) { return [...M.players.values(), ...M.gone.values()].map(p => ({ id: p.id, n: p.n, team: p.team, kills: p.kills, deaths: p.deaths, score: p.score, left: M.gone.has(p.id) ? 1 : 0 })).sort((a, b) => b.kills - a.kills || a.deaths - b.deaths); }

// a death, reported by the victim (victim-side death decision; the killer's id comes with it)
function death(M, victimId, killerId, weapon, head, now) {
  const v = M.players.get(victimId); if (!v || M.over) return;
  if (M.mode === 'demo' && (M.phase !== 'live' && M.phase !== 'freeze' || !v.alive)) return;
  if (M.mode !== 'demo' && v.lifeDead && !v.alive) return;   // this life already ended (gun + bomb / two sources / late duplicate, even > 250 ms apart): one death per life; a state from the victim showing it alive again (report) starts the next life
  if (v.lastDeathAt && now - v.lastDeathAt < 250) return;   // the same death reported twice (e.g. an add-on loaded twice): count it once
  v.lastDeathAt = now;
  v.deaths++; v.alive = false; v.lifeDead = true;
  const k = killerId && killerId !== victimId ? M.players.get(killerId) : null;
  const teamKill = k && M.rules.teams && k.team === v.team;
  if (k && !teamKill) {
    k.kills++; k.score += head ? 2 : 1;
    const x = k.x || (k.x = newExtras()); if (head) x.headshots++; x.streak++; if (x.streak > x.bestStreak) x.bestStreak = x.streak;
    if (WEAPON_RE.test(weapon || '') && (x.perWeapon[weapon] || Object.keys(x.perWeapon).length < 40)) { const w = x.perWeapon[weapon] || (x.perWeapon[weapon] = { kills: 0, headshots: 0 }); w.kills++; if (head) w.headshots++; }
  }
  if (v.x) v.x.streak = 0;
  if (k && teamKill) k.score -= 1;
  emit(M, { k: 'death', victim: victimId, killer: k ? k.id : null, weapon, head: !!head, teamKill: !!teamKill });
  if (M.bomb && M.bomb.carrier === victimId) dropBomb(M, v.pos, now);
  if (M.act && M.act.id === victimId) cancelAct(M, 'died');
  if (M.mode === 'demo') { checkRoundEnd(M, now); return; }
  // respawning modes: back in after a short wait, at their own spawn
  v.respawnAt = now + (M.rules.respawn || 2) * 1000;
  if (M.mode === 'ffa' && k && k.kills >= M.killLimit) finish(M, k.id, now);
  if (M.mode === 'tdm' && k && !teamKill) { const tk = teamKills(M, k.team); if (tk >= M.killLimit) finish(M, k.team, now); }
}
function teamKills(M, team) { let n = 0; for (const p of M.players.values()) if (p.team === team) n += p.kills; for (const p of M.gone.values()) if (p.team === team) n += p.kills; return n; }   // a player who left still counts for the team
function checkRoundEnd(M, now) {
  if (M.phase !== 'live' && M.phase !== 'freeze') return;
  const alive = t => [...M.players.values()].some(p => p.team === t && p.alive);
  const planted = M.bomb && M.bomb.state === 'planted';
  if (!alive('def')) endRound(M, 'atk', 'eliminated', now);
  else if (!alive('atk') && !planted) endRound(M, 'def', 'eliminated', now);
}

// --- the charge ----------------------------------------------------------------------------------------
function dropBomb(M, pos, now) { if (!M.bomb || M.bomb.state !== 'carried') return; M.bomb.state = 'dropped'; M.bomb.carrier = null; M.bomb.pos = pos ? pos.slice() : M.bomb.pos; emit(M, { k: 'bombDrop', pos: M.bomb.pos }); }
// the carrier drops the charge on purpose (drop key): it lands at their feet; they cannot re-pick it for 1.5 s (so it is not grabbed straight back)
function dropByPlayer(M, id, now) {
  const p = M.players.get(id), B = M.bomb; if (!p || !B || B.state !== 'carried' || B.carrier !== id || !p.alive || !p.pos || M.phase === 'over' || (M.act && M.act.id === id)) return false;
  dropBomb(M, p.pos, now); B.noPick = { id, until: now + 1500 }; return true;
}
function pickBomb(M, id, now) {
  const p = M.players.get(id), B = M.bomb; if (!p || !B || B.state !== 'dropped' || p.team !== 'atk' || !p.alive || !p.pos || !B.pos) return false;
  if (B.noPick && B.noPick.id === id && now < B.noPick.until) return false;
  if (dist(p.pos, B.pos) > M.rules.useRadius + .6) return false;
  B.state = 'carried'; B.carrier = id; emit(M, { k: 'bombPick', id }); return true;
}
function siteAt(M, pos) { if (!M.sites || !pos) return null; for (const s of M.sites) if (Math.hypot(pos[0] - s.x, pos[2] - s.z) <= (s.r || M.rules.siteRadius) && Math.abs(pos[1] - (s.y || 0)) < 2.5) return s.id; return null; }
// plant / defuse: the player asks to start; the server times it and finishes it only if they stayed alive and in place
function beginAct(M, id, kind, now) {
  const p = M.players.get(id), B = M.bomb, R = M.rules; if (!p || !B || !p.alive || !p.pos || M.phase !== 'live' || M.act) return false;
  if (kind === 'plant') { if (p.team !== 'atk' || B.state !== 'carried' || B.carrier !== id) return false; const s = siteAt(M, p.pos); if (!s) return false; M.act = { kind, id, start: now, end: now + R.plantTime * 1000, pos: p.pos.slice(), site: s }; }
  else if (kind === 'defuse') { if (p.team !== 'def' || B.state !== 'planted' || dist(p.pos, B.pos) > R.useRadius + .4) return false; M.act = { kind, id, start: now, end: now + (p.kit ? R.defuseKitTime : R.defuseTime) * 1000, pos: p.pos.slice(), kit: p.kit }; }
  else return false;
  emit(M, { k: 'actStart', kind, id, end: M.act.end, kit: !!M.act.kit, site: M.act.site || null }); return true;
}
function cancelAct(M, why) { if (!M.act) return; const a = M.act; M.act = null; emit(M, { k: 'actCancel', kind: a.kind, id: a.id, why }); }
function stopAct(M, id) { if (M.act && M.act.id === id) cancelAct(M, 'released'); }

// --- clock -------------------------------------------------------------------------------------------
function tick(M, now) {
  if (M.phase === 'warmup') return;
  if (M.over) { if (now >= M.phaseEnd) { M.phase = 'warmup'; emit(M, { k: 'toLobby' }); } return; }
  if (M.mode !== 'demo') {
    for (const p of M.players.values()) if (!p.alive && p.respawnAt && now >= p.respawnAt) { p.alive = true; p.lifeDead = false; p.respawnAt = 0; emit(M, { k: 'respawn', id: p.id }); }
    if (M.phaseEnd && now >= M.phaseEnd) { const t = table(M); if (M.mode === 'tdm') { const a = teamKills(M, 'atk'), d = teamKills(M, 'def'); finish(M, a === d ? 'draw' : a > d ? 'atk' : 'def', now); } else finish(M, t.length ? t[0].id : null, now); }
    return;
  }
  const R = M.rules, B = M.bomb;
  if (M.phase === 'freeze' && now >= M.phaseEnd) { M.phase = 'live'; M.phaseEnd = now + R.roundTime * 1000; emit(M, { k: 'live', end: M.phaseEnd }); }
  else if (M.phase === 'roundEnd' && now >= M.phaseEnd) { startRound(M, now); return; }
  if (M.phase !== 'live') return;
  if (M.act && now >= M.act.end) {
    const a = M.act; M.act = null;
    if (a.kind === 'plant') { B.state = 'planted'; B.carrier = null; B.pos = a.pos.slice(); B.site = a.site; B.plantedAt = now; B.explodeAt = now + R.bombTime * 1000; emit(M, { k: 'planted', id: a.id, site: a.site, pos: B.pos, explodeAt: B.explodeAt }); }
    else { B.state = 'defused'; emit(M, { k: 'defused', id: a.id, kit: !!a.kit }); const p = M.players.get(a.id); if (p) p.score += 2; endRound(M, 'def', 'defused', now); return; }
  }
  if (B && B.state === 'planted' && now >= B.explodeAt) { B.state = 'exploded'; emit(M, { k: 'exploded', pos: B.pos, site: B.site }); endRound(M, 'atk', 'exploded', now); return; }
  if (B && B.state !== 'planted' && now >= M.phaseEnd) { endRound(M, 'def', 'time', now); return; }
  checkRoundEnd(M, now);
}

// a compact view of the match for clients (sent on every change + once a second)
function view(M, now) {
  const B = M.bomb;
  return { balance: M.balance, teamLock: M.teamLock, mid: M.startedAt, mode: M.mode, phase: M.phase, end: M.phaseEnd, now, round: M.round, time: M.timeLimit, score: M.score, swapped: M.swapped, over: M.over, winner: M.winner,
    tk: M.mode === 'tdm' ? { atk: teamKills(M, 'atk'), def: teamKills(M, 'def') } : null, limit: M.killLimit,
    pl: [...M.players.values()].map(p => [p.id, p.team, p.kills, p.deaths, p.alive ? 1 : 0, p.kit ? 1 : 0, p.score]),
    bomb: B ? { s: B.state, c: B.carrier, p: B.pos ? B.pos.map(v => Math.round(v * 100) / 100) : null, site: B.site, ex: B.explodeAt } : null,
    act: M.act ? { kind: M.act.kind, id: M.act.id, end: M.act.end, start: M.act.start } : null };
}

const dist = (a, b) => a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : Infinity;
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function emit(M, e) { M.events.push(e); }
function drain(M) { const e = M.events; M.events = []; return e; }

module.exports = { RULES, TEAMS, TEAM_NAME, newMatch, teamCounts, addPlayer, removePlayer, detach, restore, forget, setTeam, report, start, death, pickBomb, dropByPlayer, beginAct, stopAct, tick, view, drain, table };
