/* Sector Nine: player profile, stats, match history, rank ladder, level-up popup, end-of-match XP panel.
   window.S9Profile = { open(tab?), close(), setProfile(p), levelUp(oldLevel, newLevel, rewards), matchXp({xpBreakdown, before, after}) }
   Data contract: the `profile` JSON in AGENTS_BRIEF.md (accounts agent). Levels: 50 levels = 10 ranks x 5 steps, then prestige.
   Every string from the profile is escaped before it goes into HTML. Animations use transform/opacity only. */
(function () {
  'use strict';
  if (window.S9Profile) return;

  /* ---------------- levels contract ---------------- */
  let RANKS = ['Recruit', 'Private', 'Corporal', 'Sergeant', 'Lieutenant', 'Captain', 'Major', 'Colonel', 'General', 'Sector Legend'];
  const STEPS = ['I', 'II', 'III', 'IV', 'V'];
  const MAX_LV = 50;
  let NEED = [0]; // NEED[L] = XP to go from level L to L+1
  for (let L = 1; L <= MAX_LV; L++) NEED[L] = Math.round(400 + 120 * L + 6 * L * L);
  let CUM = [0, 0]; // CUM[L] = total XP at the start of level L
  const rebuildCum = () => { CUM = [0, 0]; for (let L = 2; L <= MAX_LV; L++) CUM[L] = CUM[L - 1] + NEED[L - 1]; };
  rebuildCum();
  const rankOf = L => Math.min(9, Math.floor((Math.max(1, L) - 1) / 5));
  const stepOf = L => ((Math.max(1, L) - 1) % 5) + 1;
  const levelFromTotal = t => { t = Math.max(0, num(t)); let L = 1; while (L < MAX_LV && t >= CUM[L + 1]) L++; return { level: L, xpIn: L >= MAX_LV ? NEED[L] : t - CUM[L], need: NEED[L] }; };

  /* ---------------- safe helpers ---------------- */
  const esc = v => String(v == null ? '' : v).replace(/[&<>"'`]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
  const safeId = v => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
  function num(v) { v = +v; return Number.isFinite(v) ? v : 0; }
  const int = v => Math.max(0, Math.round(num(v)));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const ratio = (a, b) => (b > 0 ? a / b : a > 0 ? a : 0); // K/D with 0 deaths = kills (game convention)
  const pctOrNull = (a, b) => (b > 0 ? clamp(a / b * 100, 0, 100) : null);
  const fmtN = v => Math.round(num(v)).toLocaleString('en-US');
  const fmtC = v => { v = num(v); const a = Math.abs(v); return a >= 1e6 ? (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M' : a >= 1e4 ? (v / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'K' : fmtN(v); };
  const fmtP = (p, d = 1) => (p == null ? '—' : p.toFixed(d) + '%');
  const fmtR = v => num(v).toFixed(2);
  const fmtTime = s => { s = int(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h}h ${m}m` : `${m}m`; };
  const toDate = v => { if (v == null || v === '') return null; const d = new Date(typeof v === 'number' && v < 1e11 ? v * 1000 : v); return isNaN(d) ? null : d; };
  const fmtSince = v => { const d = toDate(v); return d ? d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '—'; };
  const fmtAgo = v => { const d = toDate(v); if (!d) return '—'; const s = (Date.now() - d) / 1000; if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; if (s < 86400) return Math.floor(s / 3600) + 'h ago'; if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago'; return d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' }); };
  const MODES = { ffa: 'Free for all', tdm: 'Team deathmatch', demo: 'Demolition' };
  const MODE_SHORT = { ffa: 'FFA', tdm: 'TDM', demo: 'DEMO' };
  const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } };

  function mapsList() {
    try { const s = window.__s9; const m = (s && s.MAPS) || (typeof MAPS !== 'undefined' ? MAPS : null); if (Array.isArray(m) && m.length) return m.map(x => ({ id: safeId(x.id), name: String(x.name || x.id) })); } catch (e) {}
    return EXTRA.maps || [];
  }
  const mapName = id => { const m = mapsList().find(x => x.id === safeId(id)); return m ? m.name : String(id || 'Unknown map'); };
  function weaponInfo(id) {
    try { const s = window.__s9; const W = (s && s.WEAPONS) || (typeof WEAPONS !== 'undefined' ? WEAPONS : null); if (W && W[id]) return { name: String(W[id].name || id), cls: String(W[id].cls || '') }; } catch (e) {}
    const w = EXTRA.weapons && EXTRA.weapons[id]; return w ? { name: String(w.name || id), cls: String(w.cls || '') } : { name: String(id), cls: '' };
  }

  /* optional data files (portable JSON): levels.json (accounts agent), skins.json (skins agent), map list when running outside the game */
  const EXTRA = { rewards: null, maps: null, weapons: null };
  function loadJSON(u) { return fetch(u, { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null); }
  const dataReady = Promise.all([
    loadJSON('data/levels.json').then(j => {
      if (!j) return;
      const rk = j.ranks || (j.levels && j.levels.ranks);
      if (Array.isArray(rk) && rk.length === 10) RANKS = rk.map((r, i) => String((r && r.name) || r || RANKS[i]));
      const lv = Array.isArray(j.levels) ? j.levels : Array.isArray(j.table) ? j.table : null;
      if (lv) { lv.forEach(e => { const L = int(e.level), n = num(e.xpToNext != null ? e.xpToNext : e.xpForNext != null ? e.xpForNext : e.need); if (L >= 1 && L <= MAX_LV && n > 0) NEED[L] = n; }); rebuildCum(); }
    }),
    loadJSON('data/skins.json').then(j => { if (j) EXTRA.rewards = parseRewards(j); }),
    loadJSON('data/gunskins.json').then(j => { if (j && Array.isArray(j.skins)) EXTRA.gun = j.skins.filter(x => x && x.name && num(x.unlockLevel) > 1).map(x => ({ kind: 'Gun skin', name: (x.weapon && x.weapon !== 'all' ? weaponInfo(x.weapon).name.replace(/^[A-Z0-9]+-d+s+/, '') + ' ' : '') + x.name, level: int(x.unlockLevel) })); }),
    mapsList().length ? null : loadJSON('data/maps/index.json').then(j => { if (j && Array.isArray(j.maps)) EXTRA.maps = j.maps.map(m => ({ id: safeId(m.id), name: String(m.name || m.id) })); }),
    loadJSON('data/weapons.json').then(j => { if (j && j.weapons) EXTRA.weapons = j.weapons; })
  ]);
  // skins.json format is owned by the skins agent; accept anything that carries a name + an unlock level or rank
  function parseRewards(j) {
    const out = Array.from({ length: 10 }, () => []); let seen = 0;
    const walk = (o, kind, key) => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) { o.forEach(x => walk(x, kind, key)); return; }
      const u = o.unlock && typeof o.unlock === 'object' ? o.unlock : o;
      const lvl = num(u.level != null ? u.level : o.unlockLevel != null ? o.unlockLevel : o.levelReq);
      const rk = u.rank != null ? u.rank : o.unlockRank;
      if (o.name && (lvl > 0 || rk != null)) {
        let ri = lvl > 0 ? rankOf(lvl) : typeof rk === 'number' ? rk : RANKS.findIndex(n => n.toLowerCase() === String(rk).toLowerCase());
        if (ri >= 0 && ri < 10) { out[ri].push({ name: String(o.name), kind: String(o.type || o.kind || kind || 'Skin'), level: lvl > 0 ? lvl : ri * 5 + 1 }); seen++; }
        return;
      }
      for (const k in o) if (o[k] && typeof o[k] === 'object') walk(o[k], /skin|gun|weapon|char|emblem|card|banner/i.test(k) ? k.replace(/s$/, '') : kind, k);
    };
    walk(j, '');
    out.forEach(a => a.sort((x, y) => x.level - y.level));
    return seen ? out : null;
  }

  // every unlock we know about, by level: skins.json, gunskins.json, S9Skins (soldier skins + emblems)
  function catalogue() {
    const out = [], seen = new Set(), add = (kind, name, level) => { level = int(level); if (!name || level < 2 || level > MAX_LV) return; const k = kind + '|' + name; if (seen.has(k)) return; seen.add(k); out.push({ kind, name: String(name), level }); };
    try { const S = window.S9Skins; if (S) { const d = typeof S.data === 'function' ? S.data() : null; if (d && Array.isArray(d.skins)) d.skins.forEach(x => add('Skin', x.name, x.unlockLevel)); if (typeof S.emblems === 'function') (S.emblems() || []).forEach(x => add('Emblem', x.name, x.level)); } } catch (e) {}
    if (EXTRA.rewards) EXTRA.rewards.forEach(a => a.forEach(x => add(/gun|weapon/i.test(x.kind) ? 'Gun skin' : 'Skin', x.name, x.level)));
    (EXTRA.gun || []).forEach(x => add(x.kind, x.name, x.level));
    return out.sort((a, b) => a.level - b.level);
  }
  const rewardsBetween = (a, b) => catalogue().filter(x => x.level > a && x.level <= b);

  /* ---------------- profile normalisation (never trust shape / numbers) ---------------- */
  let PROFILE = null; // null = guest
  function normalize(p) {
    if (!p || typeof p !== 'object' || p.guest) return null;
    const level = clamp(Math.round(num(p.level)) || 1, 1, MAX_LV);
    const need = num(p.xpForNext) > 0 ? num(p.xpForNext) : NEED[level];
    const maxed = level >= MAX_LV;
    const xpIn = maxed ? need : clamp(num(p.xpInLevel), 0, need);
    const ri = p.rank && Number.isFinite(+p.rank.i) ? clamp(Math.round(+p.rank.i), 0, 9) : rankOf(level);
    const step = p.rank && Number.isFinite(+p.rank.step) ? clamp(Math.round(+p.rank.step), 1, 5) : stepOf(level);
    const s = p.stats && typeof p.stats === 'object' ? p.stats : {};
    const st = {};
    for (const k of ['matches', 'wins', 'losses', 'kills', 'deaths', 'assists', 'headshots', 'shots', 'hits', 'damage', 'playSeconds', 'bestStreak', 'mvps', 'plants', 'defuses', 'roundsWon', 'roundsPlayed']) st[k] = int(s[k]);
    if (st.hits > st.shots) st.hits = st.shots;
    const obj = (o, keys) => { const r = {}; if (o && typeof o === 'object') for (const id in o) { if (!o[id] || typeof o[id] !== 'object') continue; const e = {}; for (const k of keys) e[k] = int(o[id][k]); r[safeId(id)] = e; } return r; };
    st.perMap = obj(s.perMap, ['matches', 'wins', 'kills', 'deaths']);
    st.perMode = obj(s.perMode, ['matches', 'wins', 'plants', 'defuses', 'roundsWon', 'roundsPlayed']);
    st.perWeapon = obj(s.perWeapon, ['kills', 'shots', 'hits', 'headshots']);
    const recent = (Array.isArray(p.recent) ? p.recent : []).slice(-20).filter(r => r && typeof r === 'object').map(r => ({
      at: r.at, mode: safeId(r.mode) || 'ffa', map: safeId(r.map), win: !!r.win, kills: int(r.kills), deaths: int(r.deaths), xp: int(r.xp),
      shots: r.shots != null ? int(r.shots) : null, hits: r.hits != null ? int(r.hits) : null, mvp: !!r.mvp
    }));
    // oldest -> newest (sort if timestamps exist)
    if (recent.every(r => toDate(r.at))) recent.sort((a, b) => toDate(a.at) - toDate(b.at));
    const look = p.look && typeof p.look === 'object' ? p.look : {};
    return {
      id: String(p.id == null ? '' : p.id), nick: String(p.nick || 'Operator').slice(0, 40), level, xpIn, need, maxed,
      xp: num(p.xp), rank: { i: ri, name: RANKS[ri], step }, prestige: clamp(Math.round(num(p.prestige)), 0, 99), created: p.created,
      look: { skin: look.skin == null ? '' : String(look.skin), color: look.color, emblem: look.emblem, gunSkins: look.gunSkins || {} }, stats: st, recent, raw: p
    };
  }

  /* ---------------- rank emblems ---------------- */
  // Real art: assets/ui/badges/rank_<i>.png. Until it exists we draw a metal emblem per rank on a canvas (same slot, same size).
  const BADGE_OK = {}; // i -> false once the PNG failed
  const EMBLEM = {};
  const TIERS = [
    ['#2c3238', '#7d8892', '#dfe6ec'], ['#4a2a14', '#a8622f', '#f2b77f'], ['#4f2c12', '#c07436', '#ffcf98'], ['#3b4652', '#a9b6c4', '#f6f9fc'],
    ['#5e400a', '#cf9a27', '#ffe7a3'], ['#6a4708', '#e7b13a', '#fff1be'], ['#123e4a', '#4fc0d9', '#e0fbff'], ['#0f4734', '#35b583', '#ccffe9'],
    ['#4e0f15', '#d4434d', '#ffc2bf'], ['#2c0f4f', '#9d5cff', '#ffe08a']
  ];
  function emblem(i) {
    i = clamp(i | 0, 0, 9); if (EMBLEM[i]) return EMBLEM[i];
    const S = 384, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d'); const [d, m, l] = TIERS[i];
    const cx = S / 2, cy = S / 2 + 6;
    const hex = (r, yo = 0) => { g.beginPath(); for (let k = 0; k < 6; k++) { const a = Math.PI / 6 + k * Math.PI / 3; const x = cx + Math.cos(a) * r * .92, y = cy + yo + Math.sin(a) * r * (k === 1 ? 1.1 : 1); k ? g.lineTo(x, y) : g.moveTo(x, y); } g.closePath(); };
    // wings for the officer ranks
    if (i >= 6) {
      g.save(); const wg = g.createLinearGradient(0, cy - 80, 0, cy + 80); wg.addColorStop(0, l); wg.addColorStop(1, d); g.fillStyle = wg;
      for (const sx of [-1, 1]) for (let f = 0; f < (i >= 8 ? 4 : 3); f++) {
        g.beginPath(); const y0 = cy - 70 + f * 34, x0 = cx + sx * 104;
        g.moveTo(x0, y0); g.quadraticCurveTo(x0 + sx * 70, y0 - 30 + f * 6, x0 + sx * (82 - f * 12), y0 + 6); g.quadraticCurveTo(x0 + sx * 40, y0 + 18, x0, y0 + 26); g.closePath(); g.fill();
      }
      g.restore();
    }
    if (i === 9) { g.save(); g.globalAlpha = .55; const rg = g.createRadialGradient(cx, cy, 40, cx, cy, 190); rg.addColorStop(0, 'rgba(255,224,138,.9)'); rg.addColorStop(1, 'rgba(157,92,255,0)'); g.fillStyle = rg; g.fillRect(0, 0, S, S); g.restore(); }
    // rim
    hex(140); const rim = g.createLinearGradient(cx - 140, cy - 140, cx + 140, cy + 140); rim.addColorStop(0, l); rim.addColorStop(.45, m); rim.addColorStop(1, d); g.fillStyle = rim; g.fill();
    g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.55)'; g.stroke();
    // inner field
    hex(116); const fld = g.createRadialGradient(cx, cy - 40, 10, cx, cy, 150); fld.addColorStop(0, '#2a2f36'); fld.addColorStop(1, '#0c0e11'); g.fillStyle = fld; g.fill();
    g.lineWidth = 2; g.strokeStyle = l; g.globalAlpha = .5; g.stroke(); g.globalAlpha = 1;
    // engraved Sector Nine mark lines
    g.save(); hex(116); g.clip(); g.globalAlpha = .07; g.strokeStyle = '#fff'; g.lineWidth = 1; for (let y = cy - 130; y < cy + 130; y += 9) { g.beginPath(); g.moveTo(cx - 140, y); g.lineTo(cx + 140, y + 30); g.stroke(); } g.restore();
    const metal = (x0, y0, x1, y1) => { const q = g.createLinearGradient(x0, y0, x1, y1); q.addColorStop(0, l); q.addColorStop(.5, m); q.addColorStop(1, d); return q; };
    g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = 8; g.shadowOffsetY = 3;
    const chevron = y => { g.beginPath(); g.moveTo(cx - 70, y - 18); g.lineTo(cx, y + 26); g.lineTo(cx + 70, y - 18); g.lineTo(cx + 70, y + 6); g.lineTo(cx, y + 50); g.lineTo(cx - 70, y + 6); g.closePath(); g.fillStyle = metal(cx, y - 18, cx, y + 50); g.fill(); };
    const bar = (y) => { g.fillStyle = metal(cx, y, cx, y + 26); g.fillRect(cx - 62, y, 124, 26); };
    const star = (x, y, r) => { g.beginPath(); for (let k = 0; k < 10; k++) { const a = -Math.PI / 2 + k * Math.PI / 5, rr = k % 2 ? r * .42 : r; k ? g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr) : g.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); } g.closePath(); g.fillStyle = metal(x, y - r, x, y + r); g.fill(); };
    if (i === 0) chevron(cy - 22);
    else if (i === 1) { chevron(cy - 48); chevron(cy + 4); }
    else if (i === 2) { chevron(cy - 70); chevron(cy - 22); chevron(cy + 26); }
    else if (i === 3) { chevron(cy - 78); chevron(cy - 34); chevron(cy + 10); g.beginPath(); g.moveTo(cx - 70, cy + 64); g.quadraticCurveTo(cx, cy + 102, cx + 70, cy + 64); g.lineWidth = 16; g.strokeStyle = metal(cx, cy + 60, cx, cy + 100); g.stroke(); }
    else if (i === 4) bar(cy - 13);
    else if (i === 5) { bar(cy - 36); bar(cy + 10); }
    else if (i === 6) star(cx, cy, 58);
    else if (i === 7) { star(cx - 44, cy, 40); star(cx + 44, cy, 40); }
    else if (i === 8) { star(cx - 62, cy + 14, 32); star(cx, cy - 22, 36); star(cx + 62, cy + 14, 32); }
    else { star(cx, cy - 4, 72); g.shadowBlur = 0; g.font = '900 30px "Big Shoulders Stencil Display", Impact, sans-serif'; g.textAlign = 'center'; g.fillStyle = '#14100b'; g.fillText('IX', cx, cy + 8); }
    g.shadowColor = 'transparent';
    // top gem
    g.beginPath(); g.arc(cx, cy - 128, 11, 0, Math.PI * 2); g.fillStyle = l; g.fill(); g.lineWidth = 3; g.strokeStyle = d; g.stroke();
    return (EMBLEM[i] = c.toDataURL('image/png'));
  }
  const fromBadges = (fn, i) => { try { const B = window.S9Badges; const u = B && typeof B[fn] === 'function' ? B[fn](i) : null; return typeof u === 'string' && u ? u : null; } catch (e) { return null; } };
  const badgeSrc = (i, small) => (BADGE_OK[i] === false ? emblem(i) : (small && fromBadges('small', i)) || fromBadges('rank', i) || `assets/ui/badges/rank_${i}${small ? '_128' : ''}.png`);
  function badgeHTML(i, step, cls = '', extra = '') {
    i = clamp(i | 0, 0, 9);
    return `<div class="s9p-badge t${i} ${cls}" data-rank="${i}">${extra}<img class="s9p-bimg" src="${esc(badgeSrc(i, /sm/.test(cls)))}" alt="${esc(RANKS[i])} badge" draggable="false" onerror="S9Profile._fb(this)">${step ? pipsHTML(step) : ''}</div>`;
  }
  const pipsHTML = (step, n = 5) => `<div class="s9p-pips" aria-label="Step ${STEPS[step - 1] || ''} of V">${Array.from({ length: n }, (_, k) => `<i class="${k < step ? 'on' : ''}"></i>`).join('')}</div>`;
  const starsHTML = n => { n = n | 0; if (!n) return ''; const shown = Math.min(n, 5); return `<div class="s9p-stars" title="Prestige ${n}" aria-label="Prestige ${n}">${'<i>★</i>'.repeat(shown)}${n > 5 ? `<b>×${n}</b>` : ''}</div>`; };

  /* ---------------- CSS ---------------- */
  const CSS = `
.s9p,.s9p *,.s9p-pop,.s9p-pop *{box-sizing:border-box}
.s9p{--pk:#ff9a3c;--pc:#7fe7ff;--pw:#d9761c;--pl:#1f9cbd;--ink:#ece6d8;--dim:#8b9097;--mute:#5d636b;--ln:rgba(236,230,216,.12);--ln2:rgba(236,230,216,.22);--gl:rgba(255,255,255,.035);
  position:fixed;inset:0;z-index:1000;display:flex;flex-direction:column;color:var(--ink);font-family:var(--mono,"IBM Plex Mono",ui-monospace,Consolas,monospace);font-variant-numeric:tabular-nums;
  background:radial-gradient(1100px 620px at 12% -12%,rgba(255,154,60,.13),transparent 62%),radial-gradient(900px 700px at 112% 112%,rgba(127,231,255,.08),transparent 60%),rgba(8,10,13,.9);
  -webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);opacity:0;transform:scale(1.015);transition:opacity .22s ease,transform .22s ease;contain:layout paint}
.s9p.on{opacity:1;transform:none}
.s9p[hidden]{display:none!important}
.s9p::before{content:"";position:absolute;inset:0;pointer-events:none;opacity:.5;background:repeating-linear-gradient(0deg,rgba(255,255,255,.018) 0 1px,transparent 1px 3px)}
.s9p-top{position:relative;display:flex;flex-wrap:wrap;align-items:center;gap:10px 22px;padding:calc(14px + env(safe-area-inset-top,0px)) clamp(16px,3vw,44px) 0;border-bottom:1px solid var(--ln)}
.s9p-id{display:flex;align-items:center;gap:12px;min-width:0;flex:1 1 auto;padding-bottom:12px}
.s9p-id .s9p-badge{--sz:44px}
.s9p-id b{display:block;font-family:var(--display,Impact,sans-serif);font-weight:900;font-size:26px;line-height:1;letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:52vw}
.s9p-id span{font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--dim)}
.s9p-tabs{display:flex;gap:4px;order:3;flex:1 0 100%;overflow-x:auto;scrollbar-width:none;margin:0 -4px}
.s9p-tabs::-webkit-scrollbar{display:none}
.s9p-tab{appearance:none;background:none;border:0;color:var(--dim);font:600 12px/1 var(--mono,monospace);letter-spacing:.2em;text-transform:uppercase;padding:12px 14px 14px;cursor:pointer;position:relative;white-space:nowrap}
.s9p-tab::after{content:"";position:absolute;left:14px;right:14px;bottom:-1px;height:2px;background:var(--pk);transform:scaleX(0);transition:transform .2s ease}
.s9p-tab:hover{color:var(--ink)}.s9p-tab[aria-selected=true]{color:var(--ink)}.s9p-tab[aria-selected=true]::after{transform:scaleX(1)}
.s9p-tab:focus-visible,.s9p button:focus-visible{outline:2px solid var(--pk);outline-offset:2px}
.s9p-x{appearance:none;margin-left:auto;align-self:flex-start;background:transparent;border:1px solid var(--ln2);color:var(--ink);font:12px/1 var(--mono,monospace);letter-spacing:.16em;text-transform:uppercase;padding:11px 14px;cursor:pointer}
.s9p-x:hover{border-color:var(--pk)}
.s9p-x kbd{font:inherit;color:var(--dim);margin-left:8px}
.s9p-body{position:relative;flex:1;overflow:auto;overscroll-behavior:contain;padding:22px clamp(16px,3vw,44px) calc(40px + env(safe-area-inset-bottom,0px))}
.s9p-wrap{max-width:1440px;margin:0 auto;display:grid;gap:22px;animation:s9pIn .28s ease both}
@keyframes s9pIn{from{opacity:0;transform:translateY(8px)}}
.s9p-h{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin:4px 0 -8px}
.s9p-h h3{margin:0;font-family:var(--display,Impact,sans-serif);font-weight:900;font-size:26px;letter-spacing:.04em;text-transform:uppercase}
.s9p-h span{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--dim)}
.s9p-card{position:relative;background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.015));border:1px solid var(--ln);padding:18px}
.s9p-card::before{content:"";position:absolute;left:-1px;top:-1px;width:14px;height:14px;border-left:2px solid var(--pk);border-top:2px solid var(--pk);pointer-events:none}
.s9p-lab{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--dim)}
.s9p-grid{display:grid;gap:12px}
/* badge */
.s9p-badge{--sz:200px;position:relative;width:var(--sz);flex:none;display:grid;justify-items:center;gap:calc(var(--sz)*.04)}
.s9p-bimg{width:var(--sz);height:var(--sz);object-fit:contain;display:block;filter:drop-shadow(0 6px 14px rgba(0,0,0,.6));user-select:none}
.s9p-pips{display:flex;gap:max(3px,calc(var(--sz)*.03))}
.s9p-pips i{width:max(6px,calc(var(--sz)*.07));height:max(6px,calc(var(--sz)*.07));transform:rotate(45deg);border:1px solid var(--ln2);background:rgba(255,255,255,.04)}
.s9p-pips i.on{background:var(--pk);border-color:var(--pk);box-shadow:0 0 8px rgba(255,154,60,.55)}
.s9p-glow{position:absolute;left:50%;top:calc(var(--sz)/2);width:calc(var(--sz)*1.55);height:calc(var(--sz)*1.55);margin:calc(var(--sz)*-.775) 0 0 calc(var(--sz)*-.775);border-radius:50%;pointer-events:none;
  background:conic-gradient(from 0deg,transparent 0 8%,rgba(255,154,60,.22) 12%,transparent 18% 33%,rgba(127,231,255,.16) 38%,transparent 44% 58%,rgba(255,154,60,.2) 63%,transparent 69% 83%,rgba(127,231,255,.14) 88%,transparent 94%);
  -webkit-mask:radial-gradient(closest-side,#000 30%,transparent);mask:radial-gradient(closest-side,#000 30%,transparent);animation:s9pSpin 18s linear infinite;will-change:transform}
@keyframes s9pSpin{to{transform:rotate(360deg)}}
.s9p-stars{display:flex;gap:3px;align-items:center;color:#ffd76a;font-size:18px;text-shadow:0 0 10px rgba(255,215,106,.6)}
.s9p-stars i{font-style:normal}.s9p-stars b{font-size:13px;margin-left:4px;color:var(--ink)}
/* overview */
.s9p-ov{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr);gap:22px;align-items:start}
.s9p-hero{display:grid;grid-template-columns:auto minmax(0,1fr);gap:26px;align-items:center;padding:26px;overflow:hidden}
.s9p-hero::after{content:"";position:absolute;right:-60px;top:-60px;width:260px;height:260px;background:radial-gradient(closest-side,rgba(255,154,60,.12),transparent);pointer-events:none}
.s9p-nick{font-family:var(--display,Impact,sans-serif);font-weight:900;font-size:clamp(30px,3.4vw,48px);line-height:.95;letter-spacing:.02em;word-break:break-word;margin:4px 0 6px}
.s9p-lvl{display:flex;align-items:flex-end;gap:14px;margin-top:10px}
.s9p-lvl strong{font-family:var(--display,Impact,sans-serif);font-weight:900;font-size:clamp(76px,7.4vw,120px);line-height:.78;color:var(--ink)}
.s9p-lvl div{display:grid;gap:4px;padding-bottom:4px}
.s9p-rank{white-space:nowrap;font-family:var(--display,Impact,sans-serif);font-weight:900;font-size:clamp(19px,1.9vw,26px);letter-spacing:.04em;text-transform:uppercase;color:var(--pk);line-height:1}
.s9p-xp{margin-top:18px;display:grid;gap:7px}
.s9p-xpbar{position:relative;height:12px;background:rgba(236,230,216,.08);overflow:hidden;clip-path:polygon(0 0,100% 0,calc(100% - 8px) 100%,0 100%)}
.s9p-xpbar>i{position:absolute;inset:0;background:linear-gradient(90deg,#b4561a,var(--pk) 70%,#ffd0a0);transform-origin:left;transform:scaleX(0);transition:transform 1.3s cubic-bezier(.2,.8,.2,1);will-change:transform}
.s9p-xpbar>i::after{content:"";position:absolute;right:0;top:0;bottom:0;width:30px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.7))}
.s9p-xpbar>b{position:absolute;inset:0;background:repeating-linear-gradient(90deg,transparent 0 calc(10% - 2px),rgba(8,10,13,.85) calc(10% - 2px) 10%);pointer-events:none}
.s9p-xprow{display:flex;justify-content:space-between;gap:10px;font-size:12px;color:var(--dim);flex-wrap:wrap}
.s9p-xprow b{color:var(--ink);font-weight:600}
.s9p-tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.s9p-tile{transition:transform .2s cubic-bezier(.2,1.4,.4,1),border-color .2s;position:relative;padding:16px 16px 14px;background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.012));border:1px solid var(--ln);display:grid;gap:6px;min-width:0}
.s9p-tile .v{font-family:var(--mono,monospace);font-weight:600;font-size:clamp(26px,2.4vw,36px);line-height:1;letter-spacing:-.01em;white-space:nowrap}
.s9p-tile .v small{font-size:.5em;color:var(--dim);margin-left:3px;font-weight:400}
.s9p-tile .s{font-size:11.5px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.s9p-tile:hover{transform:translateY(-3px);border-color:var(--ln2)}
.s9p-tile.hl{border-color:rgba(255,154,60,.45)}
.s9p-tile.hl::before{content:"";position:absolute;left:0;top:0;bottom:0;width:2px;background:var(--pk)}
.s9p-meter{height:4px;background:rgba(236,230,216,.1);overflow:hidden;margin-top:2px}
.s9p-meter i{display:block;height:100%;background:var(--pk);transform-origin:left;border-radius:0 2px 2px 0}
.s9p-side{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}
.s9p-form{display:flex;flex-wrap:wrap;gap:4px;margin-top:10px}
.s9p-form i{width:26px;height:26px;display:grid;place-items:center;font:600 11px/1 var(--mono,monospace);font-style:normal;color:#0b0d10;border-radius:2px}
.s9p-form i.w{background:var(--pw)}.s9p-form i.l{background:rgba(31,156,189,.32);color:var(--ink)}
.s9p-skin{display:grid;grid-template-rows:auto 1fr auto;min-height:220px}
.s9p-skinview{position:relative;display:grid;place-items:center;height:180px;overflow:hidden}
.s9p-skinview svg{height:150px;width:auto;opacity:.92}
/* stats */
.s9p-tiles.t4{grid-template-columns:repeat(4,minmax(0,1fr))}
.s9p-tiles.t5{grid-template-columns:repeat(5,minmax(0,1fr))}
.s9p-charts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.s9p-chart{display:grid;gap:10px;min-width:0}
.s9p-chart svg{width:100%;height:auto;display:block;overflow:visible}
.s9p-chart .ax{stroke:rgba(236,230,216,.1);stroke-width:1}
.s9p-chart .ref{stroke:rgba(236,230,216,.28);stroke-width:1}
.s9p-chart text{font:10px var(--mono,monospace);fill:var(--dim)}
.s9p-chart .ln{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.s9p-chart .hit{fill:transparent;cursor:crosshair}
.s9p-chart .hit:hover+.dot,.s9p-chart .dot.end{opacity:1}
.s9p-chart .dot{pointer-events:none;opacity:0;stroke:#0d1116;stroke-width:2;transition:opacity .12s}
.s9p-legend{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--dim)}
.s9p-legend span{display:inline-flex;align-items:center;gap:6px}.s9p-legend span::before{content:"";width:10px;height:10px;border-radius:2px;background:var(--c)}
.s9p-legend b{color:var(--ink);font-weight:600}
.s9p-empty{font-size:12px;color:var(--dim);padding:22px 0;text-align:center;border:1px dashed var(--ln)}
.s9p-modes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.s9p-mode{display:grid;gap:12px}
.s9p-mode h4{margin:0;font-family:var(--display,Impact,sans-serif);font-weight:900;font-size:24px;letter-spacing:.04em;text-transform:uppercase;display:flex;justify-content:space-between;align-items:baseline}
.s9p-mode h4 small{font:11px var(--mono,monospace);letter-spacing:.18em;color:var(--dim)}
.s9p-kv{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.s9p-kv div{display:grid;gap:3px}.s9p-kv b{font-size:20px;font-weight:600}.s9p-kv span{font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
.s9p-maps{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}
.s9p-map{position:relative;overflow:hidden;border:1px solid var(--ln);background:#0d1116;display:grid;min-height:150px}
.s9p-map img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.55;transition:transform .5s ease,opacity .3s}
.s9p-map:hover img{transform:scale(1.05);opacity:.7}
.s9p-map::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(8,10,13,.15) 0,rgba(8,10,13,.92) 72%)}
.s9p-map>div{position:relative;z-index:1;align-self:end;padding:12px 14px;display:grid;gap:8px}
.s9p-map h5{margin:0;font-family:var(--display,Impact,sans-serif);font-weight:900;font-size:22px;letter-spacing:.03em;text-transform:uppercase;line-height:1}
.s9p-map .kv{display:grid;grid-template-columns:repeat(4,auto);justify-content:space-between;gap:6px;font-size:11px;color:var(--dim)}
.s9p-map .kv b{display:block;color:var(--ink);font-size:16px;font-weight:600}
.s9p-map.none img{opacity:.22;filter:grayscale(1)}
.s9p-map .s9p-mtag{position:absolute;z-index:1;top:10px;right:10px;font-size:10px;letter-spacing:.18em;text-transform:uppercase;padding:4px 7px;background:rgba(8,10,13,.75);border:1px solid var(--ln2)}
.s9p-map .s9p-mtag.best{border-color:var(--pk);color:var(--pk)}
.s9p-tbl{width:100%;border-collapse:collapse;font-size:13px}
.s9p .s9p-tbl th{font-weight:600;font:600 10.5px var(--mono,monospace);letter-spacing:.16em;text-transform:uppercase;color:var(--dim);text-align:right;padding:0;border-bottom:1px solid var(--ln2)}
.s9p-tbl th button{appearance:none;background:none;border:0;color:inherit;font:inherit;letter-spacing:inherit;text-transform:inherit;padding:10px 10px;cursor:pointer;width:100%;text-align:inherit}
.s9p-tbl th[aria-sort] button{color:var(--ink)}
.s9p-tbl th[aria-sort=descending] button::after{content:" ▾";color:var(--pk)}.s9p-tbl th[aria-sort=ascending] button::after{content:" ▴";color:var(--pk)}
.s9p-tbl th:first-child,.s9p-tbl td:first-child{text-align:left}
.s9p .s9p-tbl td i,.s9p .s9p-meter i{display:block;width:auto;height:100%;margin:0;vertical-align:baseline}.s9p .s9p-tbl td{border-top:0;color:inherit;background:none;padding:9px 10px;text-align:right;border-bottom:1px solid var(--ln);white-space:nowrap}
.s9p-tbl tr:hover td{background:rgba(255,255,255,.025)}
.s9p-wpn{display:flex;align-items:center;gap:12px}
.s9p-wpn img{width:74px;height:30px;object-fit:contain;opacity:.9}
.s9p-wpn b{display:block;font-weight:600}.s9p-wpn small{color:var(--dim);font-size:11px}
.s9p-cell{display:inline-grid;gap:4px;justify-items:end;min-width:70px}
.s9p-cell .s9p-meter{width:70px}
/* matches */
.s9p-sum{display:flex;gap:28px;flex-wrap:wrap;align-items:flex-end}
.s9p-sum div{display:grid;gap:4px}.s9p-sum b{font-size:28px;font-weight:600}
.s9p-ml{display:grid;gap:6px}
.s9p-m{position:relative;display:grid;grid-template-columns:96px minmax(0,1.3fr) minmax(0,1.6fr) 90px 70px 90px 90px;align-items:center;gap:12px;padding:0 16px 0 0;min-height:62px;border:1px solid var(--ln);background:linear-gradient(90deg,rgba(255,255,255,.04),rgba(255,255,255,.01));overflow:hidden}
.s9p-m::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--rc)}
.s9p-m.w{--rc:var(--pw)}.s9p-m.l{--rc:var(--pl)}
.s9p-m .th{align-self:stretch;position:relative;overflow:hidden;background:#0d1116}
.s9p-m .th img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.7}
.s9p-m .res{font-family:var(--display,Impact,sans-serif);font-weight:900;font-size:22px;letter-spacing:.04em;text-transform:uppercase}
.s9p-m.w .res{color:var(--pk)}.s9p-m.l .res{color:#8fd5e8}
.s9p-m .mm b{display:block;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.s9p-m .mm small{color:var(--dim);font-size:11px;letter-spacing:.1em;text-transform:uppercase}
.s9p-m .n{text-align:right}.s9p-m .n b{display:block;font-size:16px;font-weight:600}.s9p-m .n small{color:var(--dim);font-size:10px;letter-spacing:.14em;text-transform:uppercase}
.s9p-m .xp b{color:var(--pk)}
.s9p-mvp{display:inline-block;font-size:9.5px;letter-spacing:.16em;padding:2px 5px;border:1px solid #ffd76a;color:#ffd76a;margin-left:6px;vertical-align:2px}
/* ranks */
.s9p-ladder{display:grid;gap:8px}
.s9p-rr{display:grid;grid-template-columns:84px minmax(150px,1fr) minmax(0,3fr) minmax(0,1.4fr);gap:16px;align-items:center;padding:12px 16px;border:1px solid var(--ln);background:linear-gradient(90deg,rgba(255,255,255,.035),rgba(255,255,255,.01))}
.s9p-rr .s9p-badge{--sz:72px}
.s9p-rr.lock .s9p-bimg{filter:grayscale(.8) brightness(.78)}
.s9p-rr.cur{border-color:rgba(255,154,60,.55);background:linear-gradient(90deg,rgba(255,154,60,.12),rgba(255,255,255,.01))}
.s9p-rr h5{margin:0;font-family:var(--display,Impact,sans-serif);font-weight:900;font-size:24px;text-transform:uppercase;letter-spacing:.03em;line-height:1}
.s9p-rr .lv{font-size:11px;color:var(--dim);letter-spacing:.12em;text-transform:uppercase;margin-top:5px}
.s9p-steps{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:4px}
.s9p-st{position:relative;padding:8px 8px 9px;background:rgba(236,230,216,.05);display:grid;gap:3px;overflow:hidden;min-width:0}
.s9p-st b{font-size:13px}.s9p-st span{font-size:10.5px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.s9p-st.done{background:rgba(255,154,60,.16)}.s9p-st.done b{color:var(--pk)}
.s9p-st.cur{outline:1px solid var(--pk);background:rgba(255,154,60,.08)}
.s9p-st.cur i{position:absolute;left:0;bottom:0;height:3px;width:100%;background:var(--pk);transform-origin:left}
.s9p-rw{display:flex;flex-wrap:wrap;gap:5px}
.s9p-rw span{font-size:10.5px;padding:4px 7px;border:1px solid var(--ln2);color:var(--ink);white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.s9p-rw span em{font-style:normal;color:var(--dim);margin-right:4px}
.s9p-rr.lock .s9p-rw span{color:var(--dim)}
.s9p-here{font-size:10px;letter-spacing:.18em;color:#0b0d10;background:var(--pk);padding:3px 6px;margin-left:8px;vertical-align:4px}
/* guest */
.s9p-guest{display:grid;justify-items:center;text-align:center;gap:16px;padding:44px 22px}
.s9p-guest h3{margin:0;font-family:var(--display,Impact,sans-serif);font-weight:900;font-size:clamp(34px,4vw,54px);line-height:.95;text-transform:uppercase}
.s9p-guest p{margin:0;max-width:520px;color:var(--dim);line-height:1.6;font-size:13px}
.s9p-guest .s9p-bimg{filter:grayscale(1) brightness(.6)}
.s9p-cta{appearance:none;font-family:var(--display,Impact,sans-serif);font-weight:900;font-size:24px;letter-spacing:.08em;text-transform:uppercase;color:#14100b;background:var(--pk);border:0;padding:13px 28px 11px;cursor:pointer;clip-path:polygon(0 0,100% 0,100% 70%,calc(100% - 14px) 100%,0 100%)}
.s9p-cta:hover{background:#ffb066}
.s9p-perks{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
.s9p-perks span{font-size:11px;letter-spacing:.12em;text-transform:uppercase;padding:6px 10px;border:1px solid var(--ln2);color:var(--dim)}
.s9p-banner{display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap;padding:12px 16px;border:1px solid rgba(255,154,60,.4);background:rgba(255,154,60,.07);font-size:13px}
.s9p-banner .s9p-cta{font-size:18px;padding:9px 18px 8px}
/* tooltip */
.s9p-tip{position:fixed;z-index:1200;pointer-events:none;background:rgba(8,10,13,.96);border:1px solid var(--ln2,rgba(236,230,216,.22));color:#ece6d8;font:12px/1.45 "IBM Plex Mono",ui-monospace,monospace;padding:7px 10px;white-space:pre;opacity:0;transform:translateY(4px);transition:opacity .1s,transform .1s}
.s9p-tip.on{opacity:1;transform:none}
/* injected menu button */
button.s9p-open b{margin-left:8px;color:var(--sodium,#ff9a3c);font-weight:600}
/* popups */
.s9p-pop{--pk:#ff9a3c;--ink:#ece6d8;--dim:#8b9097;--bz:300px;position:fixed;inset:0;z-index:1100;display:grid;place-items:center;padding:20px;overflow:hidden;color:var(--ink);font-family:var(--mono,"IBM Plex Mono",monospace);font-variant-numeric:tabular-nums;background:rgba(6,8,10,.74);opacity:0;transition:opacity .25s ease;-webkit-user-select:none;user-select:none}
.s9p-pop.on{opacity:1}.s9p-pop[hidden]{display:none!important}
.s9p-pop.k-rank,.s9p-pop.k-prestige{background:rgba(3,4,6,0);transition:opacity .25s ease,background-color .5s ease}
.s9p-pop.k-rank.on,.s9p-pop.k-prestige.on{background:rgba(3,4,6,.93)}
.s9p-pop .vig{position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at center,transparent 35%,rgba(0,0,0,.75));opacity:0;transition:opacity .6s}
.s9p-pop.k-rank .vig,.s9p-pop.k-prestige .vig{opacity:1}
.s9p-lu{position:relative;display:grid;justify-items:center;gap:10px;text-align:center;width:min(820px,100%)}
.s9p-lu .fx{position:absolute;left:50%;top:calc(var(--bz)/2);width:0;height:0;pointer-events:none}
.s9p-lu .fx>*{position:absolute;left:0;top:0;border-radius:50%}
.s9p-rays{width:900px;height:900px;margin:-450px 0 0 -450px;opacity:0;background:repeating-conic-gradient(from 0deg,rgba(255,206,140,.30) 0 3deg,transparent 3deg 12deg);-webkit-mask:radial-gradient(closest-side,#000 14%,transparent 70%);mask:radial-gradient(closest-side,#000 14%,transparent 70%)}
.s9p-burst{width:760px;height:760px;margin:-380px 0 0 -380px;opacity:0;transform:scale(.3);background:repeating-conic-gradient(from 7deg,rgba(255,200,130,.34) 0 4deg,transparent 4deg 15deg);-webkit-mask:radial-gradient(closest-side,#000 18%,transparent 72%);mask:radial-gradient(closest-side,#000 18%,transparent 72%)}
.s9p-flash{width:440px;height:440px;margin:-220px 0 0 -220px;opacity:0;transform:scale(.2);background:radial-gradient(closest-side,rgba(255,244,225,.98),rgba(255,154,60,.5) 40%,transparent 72%)}
.s9p-ring{width:260px;height:260px;margin:-130px 0 0 -130px;opacity:0;border:2px solid rgba(255,214,160,.9);box-shadow:0 0 24px rgba(255,154,60,.6),inset 0 0 18px rgba(255,154,60,.4)}
.s9p-parts i{position:absolute;left:-4px;top:-4px;width:8px;height:8px;border-radius:2px;background:var(--c,#ffcf8a);box-shadow:0 0 8px var(--c,#ff9a3c);opacity:0}
.s9p-parts i.ln{width:3px;height:18px;left:-1.5px;top:-9px;border-radius:2px}
.s9p-flip{position:relative;width:var(--bz);height:var(--bz);perspective:1000px;z-index:1}
.s9p-flip>.spin{position:absolute;inset:0;will-change:transform}
.s9p-flip .s9p-badge{--sz:var(--bz);position:absolute;inset:0}
.s9p-flip .s9p-pips{display:none}.s9p-flip .s9p-bimg{filter:none}
.s9p-frames{position:absolute;left:50%;top:50%;width:calc(var(--bz)*1.4);height:calc(var(--bz)*1.4);margin:calc(var(--bz)*-.7) 0 0 calc(var(--bz)*-.7);object-fit:contain;pointer-events:none;z-index:2}
.s9p-lu h2{margin:0;font-family:var(--display,Impact,sans-serif);font-weight:900;font-size:clamp(46px,min(9vw,11vh),104px);line-height:.85;letter-spacing:.02em;text-transform:uppercase;display:flex;gap:.22em;justify-content:center}
.s9p-lu .k{font-size:12px;letter-spacing:.34em;text-transform:uppercase;color:var(--pk)}
.s9p-lu .rk{font-family:var(--display,Impact,sans-serif);font-weight:900;font-size:30px;letter-spacing:.06em;text-transform:uppercase;color:var(--pk);line-height:1}
.s9p-pop.k-rank .rk,.s9p-pop.k-prestige .rk{font-size:clamp(36px,min(7vw,8.5vh),84px);color:var(--ink);padding:6px 22px 2px;border:3px solid var(--pk);text-shadow:0 0 22px rgba(255,154,60,.55);box-shadow:0 0 30px rgba(255,154,60,.25),inset 0 0 20px rgba(255,154,60,.18);transform:rotate(-2deg)}
.s9p-pop.k-prestige .rk{border-color:#ffd76a;color:#ffe9a8}
.s9p-lu .multi{font-size:13px;letter-spacing:.2em;text-transform:uppercase;color:var(--ink);padding:4px 10px;background:rgba(255,154,60,.18);border:1px solid rgba(255,154,60,.5)}
.s9p-lu .s9p-stars{font-size:28px}
.s9p-cards{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;max-width:780px;margin-top:6px}
.s9p-rc{width:150px;display:grid;justify-items:center;gap:6px;padding:12px 10px 11px;border:1px solid rgba(255,154,60,.5);background:linear-gradient(180deg,rgba(255,154,60,.16),rgba(255,154,60,.03));position:relative;overflow:hidden}
.s9p-rc::after{content:"";position:absolute;inset:0;background:linear-gradient(115deg,transparent 35%,rgba(255,255,255,.35) 50%,transparent 65%);transform:translateX(-120%)}
.s9p-rc img{width:56px;height:56px;object-fit:contain}
.s9p-rc svg{width:44px;height:44px;margin:6px 0}
.s9p-rc em{font-style:normal;font-size:9.5px;letter-spacing:.2em;text-transform:uppercase;color:var(--dim)}
.s9p-rc b{font-size:12.5px;font-weight:600;line-height:1.3;word-break:break-word}
.s9p-lu .hint{font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;color:var(--dim)}
.s9p-roll{display:inline-block;position:relative;height:.86em;line-height:.86;overflow:hidden;vertical-align:top}
.s9p-roll>span{display:block;height:.86em;transition:transform .42s cubic-bezier(.3,1.5,.5,1)}
.s9p-roll.go>span{transform:translateY(-100%)}
/* entry choreography (all transform/opacity) */
.s9p-lu .in{opacity:0;transform:translateY(12px)}
.s9p-pop.run .s9p-lu .in{animation:s9pUp .45s cubic-bezier(.2,.8,.2,1) forwards;animation-delay:var(--d,0s)}
.s9p-pop.run .s9p-flip>.spin{animation:s9pHalfA .38s cubic-bezier(.55,0,.9,.45) .15s both}
.s9p-pop.run .s9p-flip>.spin.b{animation:s9pHalfB .6s cubic-bezier(.2,1,.3,1.25) both}
.s9p-pop.run .s9p-burst{animation:s9pBurst 2.6s ease-out .62s forwards}
.s9p-pop.run .s9p-flash{animation:s9pFlash .9s ease-out .6s forwards}
.s9p-pop.run .s9p-ring{animation:s9pRing .9s ease-out .62s forwards}
.s9p-pop.run .s9p-parts i{animation:s9pPart var(--t,1.1s) cubic-bezier(.15,.7,.3,1) calc(.62s + var(--dl,0s)) forwards}
.s9p-pop.run .s9p-rc{opacity:0;transform:translateY(40px) scale(.92);animation:s9pCard .5s cubic-bezier(.2,1.3,.4,1) forwards;animation-delay:var(--d,0s)}
.s9p-pop.run .s9p-rc::after{animation:s9pShine .9s ease-out forwards;animation-delay:calc(var(--d,0s) + .35s)}
/* rank-up / prestige: longer, bigger */
.s9p-pop.k-rank,.s9p-pop.k-prestige{--bz:340px}
.s9p-pop.run.k-rank .s9p-flip>.spin,.s9p-pop.run.k-prestige .s9p-flip>.spin{animation:s9pRevA .95s cubic-bezier(.5,0,.85,.5) .35s both}
.s9p-pop.run.k-rank .s9p-flip>.spin.b,.s9p-pop.run.k-prestige .s9p-flip>.spin.b{animation:s9pHalfB .75s cubic-bezier(.2,1,.3,1.3) both}
.s9p-pop.run.k-rank .s9p-rays,.s9p-pop.run.k-prestige .s9p-rays{animation:s9pRays 7s linear 1.2s forwards}
.s9p-pop.run.k-rank .s9p-burst,.s9p-pop.run.k-prestige .s9p-burst{animation-delay:1.45s}
.s9p-pop.run.k-rank .s9p-flash,.s9p-pop.run.k-prestige .s9p-flash{animation-delay:1.42s}
.s9p-pop.run.k-rank .s9p-ring,.s9p-pop.run.k-prestige .s9p-ring{animation-delay:1.45s}
.s9p-pop.run.k-rank .s9p-parts i,.s9p-pop.run.k-prestige .s9p-parts i{animation-delay:calc(1.45s + var(--dl,0s))}
.s9p-pop.run.k-rank .rk.in,.s9p-pop.run.k-prestige .rk.in{transform:scale(2.6) rotate(-8deg);animation:s9pStamp .38s cubic-bezier(.5,0,.75,0) forwards;animation-delay:var(--d,0s)}
.s9p-pop.run.k-rank .s9p-lu.shake,.s9p-pop.run.k-prestige .s9p-lu.shake{animation:s9pShake .32s ease-out}
.s9p-pop.k-prestige .s9p-ring{border-color:#ffe39a}
.s9p-pop.k-prestige .s9p-parts i{--c:#ffe08a}
@keyframes s9pHalfA{0%{transform:perspective(900px) rotateY(0) scale(.86)}100%{transform:perspective(900px) rotateY(90deg) scale(1.08)}}
@keyframes s9pHalfB{0%{transform:perspective(900px) rotateY(-90deg) scale(1.12)}100%{transform:perspective(900px) rotateY(0) scale(1)}}
@keyframes s9pRevA{0%{transform:perspective(900px) rotateY(0) scale(.3);opacity:0}25%{opacity:1}100%{transform:perspective(900px) rotateY(450deg) scale(1.1);opacity:1}}
@keyframes s9pBurst{0%{opacity:0;transform:scale(.3) rotate(0)}18%{opacity:1}100%{opacity:0;transform:scale(1.25) rotate(40deg)}}
@keyframes s9pRays{0%{opacity:0;transform:rotate(0)}12%{opacity:1}100%{opacity:.75;transform:rotate(60deg)}}
@keyframes s9pFlash{0%{opacity:0;transform:scale(.2)}22%{opacity:1}100%{opacity:0;transform:scale(1.7)}}
@keyframes s9pRing{0%{opacity:1;transform:scale(.4)}100%{opacity:0;transform:scale(2.4)}}
@keyframes s9pPart{0%{opacity:1;transform:translate(0,0) rotate(var(--r,0deg)) scale(1)}70%{opacity:1}100%{opacity:0;transform:translate(var(--x),var(--y)) rotate(var(--r,0deg)) scale(.25)}}
@keyframes s9pUp{to{opacity:1;transform:none}}
@keyframes s9pStamp{0%{opacity:0;transform:scale(2.6) rotate(-8deg)}60%{opacity:1}100%{opacity:1;transform:scale(1) rotate(-2deg)}}
@keyframes s9pShake{0%,100%{transform:none}20%{transform:translate(-7px,4px)}40%{transform:translate(6px,-4px)}60%{transform:translate(-4px,2px)}80%{transform:translate(2px,-1px)}}
@keyframes s9pCard{to{opacity:1;transform:none}}
@keyframes s9pShine{to{transform:translateX(120%)}}
/* skip: jump every animation to its final frame */
.s9p-pop.skip *,.s9p-pop.skip *::after{animation-delay:0s!important;animation-duration:.01s!important;transition-duration:0s!important}
/* end-of-match XP panel */
.s9p-mx{width:min(580px,100%);display:grid;gap:16px;padding:24px;background:linear-gradient(180deg,rgba(20,23,28,.97),rgba(11,13,16,.97));border:1px solid rgba(236,230,216,.14);position:relative;transform:translateY(14px);transition:transform .3s cubic-bezier(.2,.8,.2,1)}
.s9p-pop.on .s9p-mx{transform:none}
.s9p-mx::before{content:"";position:absolute;left:-1px;top:-1px;width:16px;height:16px;border-left:2px solid var(--pk);border-top:2px solid var(--pk)}
.s9p-mx>.mflash{position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at 50% 85%,rgba(255,236,205,.55),rgba(255,154,60,.18) 45%,transparent 75%);opacity:0}
.s9p-mx>.mflash.go{animation:s9pMFlash .6s ease-out}
@keyframes s9pMFlash{0%{opacity:0}18%{opacity:1}100%{opacity:0}}
.s9p-mx .hd{display:flex;align-items:center;gap:16px}
.s9p-mx .hb{position:relative;width:84px;height:84px;flex:none;perspective:600px}
.s9p-mx .hb .s9p-badge{--sz:84px;position:absolute;inset:0}
.s9p-mx .hb .s9p-badge.flip{animation:s9pHFlip .62s cubic-bezier(.4,0,.2,1)}
@keyframes s9pHFlip{0%{transform:rotateY(0) scale(1)}50%{transform:rotateY(90deg) scale(1.2)}100%{transform:rotateY(0) scale(1)}}
.s9p-mx .hb .fx{position:absolute;left:42px;top:42px;width:0;height:0;pointer-events:none}
.s9p-mx .hb .fx .s9p-ring{width:90px;height:90px;margin:-45px 0 0 -45px;border-radius:50%;position:absolute}
.s9p-mx .hb .fx.go .s9p-ring{animation:s9pRing .7s ease-out forwards}
.s9p-mx .hb .fx.go .s9p-parts i{animation:s9pPart var(--t,.8s) cubic-bezier(.15,.7,.3,1) var(--dl,0s) forwards}
.s9p-mx h3{margin:0;font-family:var(--display,Impact,sans-serif);font-weight:900;font-size:40px;line-height:.9;text-transform:uppercase}
.s9p-mx .xrows{display:grid;gap:2px}
.s9p-mx .xrow{display:flex;justify-content:space-between;padding:7px 2px;border-bottom:1px solid rgba(236,230,216,.08);font-size:13px;opacity:.18;transform:translateX(-6px);transition:opacity .2s,transform .2s}
.s9p-mx .xrow.in{opacity:1;transform:none}
.s9p-mx .xrow b{color:var(--pk);font-weight:600;display:inline-block;transition:transform .15s}
.s9p-mx .xrow.cnt b{transform:scale(1.14)}
.s9p-mx .xrow.tot{border-bottom:0;font-size:15px;padding-top:10px;opacity:1;transform:none}.s9p-mx .xrow.tot b{font-size:20px}
.s9p-mx .lvl{display:flex;justify-content:space-between;align-items:baseline;font-size:12px;color:var(--dim)}
.s9p-mx .lvl strong{font-family:var(--display,Impact,sans-serif);font-weight:900;font-size:34px;color:var(--ink);margin-left:6px}
.s9p-mx .up{font-family:var(--display,Impact,sans-serif);font-weight:900;font-size:22px;color:var(--pk);letter-spacing:.06em;opacity:0;transform:scale(.6);transition:opacity .2s,transform .35s cubic-bezier(.2,1.6,.4,1);white-space:nowrap}
.s9p-mx .up.on{opacity:1;transform:none}
.s9p-xpw{position:relative}
.s9p-mx .s9p-xpbar{height:16px}
.s9p-mx .s9p-xpbar>i{transition:none}
.s9p-xpw .gl{position:absolute;inset:-8px -6px;pointer-events:none;opacity:0;background:radial-gradient(closest-side,rgba(255,154,60,.35),transparent);transition:opacity .3s}
.s9p-xpw.charging .gl{opacity:1}
.s9p-xpw .head{position:absolute;left:0;top:50%;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;pointer-events:none;opacity:0;background:radial-gradient(closest-side,#fff,rgba(255,190,120,.85) 35%,rgba(255,154,60,0));transition:opacity .2s;will-change:transform}
.s9p-xpw.charging .head{opacity:1}
.s9p-mx .ft{display:flex;justify-content:space-between;align-items:center;gap:10px}
.s9p-mx .ft .hint{font-size:10.5px;letter-spacing:.18em;text-transform:uppercase;color:var(--dim)}
.s9p-mx.done .ft .hint{opacity:0}
.s9p-mx .ft div{display:flex;gap:10px;margin-left:auto}
.s9p-mx .s9p-cta{font-size:20px;padding:10px 22px 9px}
.s9p-ghost{appearance:none;background:transparent;border:1px solid rgba(236,230,216,.22);color:var(--ink);font:12px var(--mono,monospace);letter-spacing:.16em;text-transform:uppercase;padding:10px 14px;cursor:pointer}
@media (max-width:640px){.s9p-pop{--bz:210px}.s9p-pop.k-rank,.s9p-pop.k-prestige{--bz:230px}.s9p-rc{width:calc(50% - 6px)}.s9p-lu{gap:8px}.s9p-mx{padding:18px}.s9p-mx h3{font-size:28px;white-space:nowrap}}
@media (max-height:900px) and (min-width:641px){.s9p-pop{--bz:210px}.s9p-pop.k-rank,.s9p-pop.k-prestige{--bz:220px}.s9p-rc{padding:9px 10px 8px}.s9p-rc img{width:44px;height:44px}.s9p-lu{gap:8px}}
/* responsive */
@media (max-width:1180px){.s9p-ov{grid-template-columns:1fr}.s9p-tiles.t5{grid-template-columns:repeat(3,minmax(0,1fr))}.s9p-charts{grid-template-columns:repeat(2,minmax(0,1fr))}.s9p-rr{grid-template-columns:72px minmax(130px,1fr) minmax(0,3fr)}.s9p-rr .s9p-rw{grid-column:2/-1}}
@media (max-width:860px){.s9p-modes{grid-template-columns:1fr}.s9p-m{grid-template-columns:76px minmax(0,1fr) 64px 64px 70px;grid-template-areas:"th res kd ratio xp" "th mm mm mm when"}.s9p-m{padding:8px 12px 8px 0;row-gap:4px}
  .s9p-m .th{grid-area:th}.s9p-m .resw{grid-area:res}.s9p-m .mm{grid-area:mm}.s9p-m .kd{grid-area:kd}.s9p-m .ra{grid-area:ratio}.s9p-m .xp{grid-area:xp}.s9p-m .when{grid-area:when}
  .s9p-tiles.t4{grid-template-columns:repeat(2,minmax(0,1fr))}.s9p-charts{grid-template-columns:1fr}}
@media (max-width:640px){.s9p-hero{grid-template-columns:1fr;justify-items:center;text-align:center;padding:22px 16px}.s9p-hero .s9p-badge{--sz:150px}.s9p-lvl{justify-content:center}.s9p-xp{width:100%;text-align:left}.s9p-hero .s9p-stars{justify-content:center}
  .s9p-tiles,.s9p-tiles.t5{grid-template-columns:repeat(2,minmax(0,1fr))}.s9p-side{grid-template-columns:1fr}.s9p-tile{padding:13px 12px 12px}
  .s9p-x span{display:none}.s9p-x kbd{margin:0}.s9p-id b{font-size:22px}
  .s9p-rr{grid-template-columns:56px minmax(0,1fr);gap:10px 12px;padding:12px}.s9p-rr .s9p-badge{--sz:56px}.s9p-rr .s9p-steps,.s9p-rr .s9p-rw,.s9p-rr>*:nth-child(3){grid-column:1/-1}
  .s9p-st{padding:6px 5px}.s9p-st span{font-size:9.5px}
  .s9p-wpn img{width:48px}.s9p-tbl .hs-sm{display:none}.s9p-tbl td,.s9p-tbl th button{padding-left:6px;padding-right:6px}.s9p-cell{min-width:0}.s9p-cell .s9p-meter{width:52px}
  .s9p-maps{grid-template-columns:1fr 1fr}.s9p-map{min-height:132px}.s9p-map h5{font-size:17px}.s9p-map .kv{grid-template-columns:repeat(2,auto)}
  .s9p-sum{gap:18px}}
@media (max-width:420px){.s9p-maps{grid-template-columns:1fr}.s9p-map .kv{grid-template-columns:repeat(4,auto)}.s9p-map{min-height:118px}.s9p-wpn img{display:none}.s9p-wpn small{display:none}.s9p-cell .s9p-meter{width:40px}.s9p-tile .v{font-size:24px}}
@media (prefers-reduced-motion:reduce){.s9p-glow{animation:none}.s9p,.s9p-wrap{transition:none;animation:none}}
`;

  /* ---------------- DOM ---------------- */
  let root, body, tip, luPop, mxPop, curTab = 'overview', wSort = { key: 'kills', dir: -1 };
  const TABS = [['overview', 'Overview'], ['stats', 'Stats'], ['matches', 'Match history'], ['ranks', 'Ranks']];
  function ensureDom() {
    if (root) return;
    const st = document.createElement('style'); st.id = 's9p-css'; st.textContent = CSS; document.head.appendChild(st);
    root = document.createElement('div'); root.className = 's9p'; root.id = 's9profile'; root.hidden = true; root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Player profile');
    root.innerHTML = `<header class="s9p-top"><div class="s9p-id" id="s9pId"></div>
      <nav class="s9p-tabs" role="tablist">${TABS.map(([k, n]) => `<button class="s9p-tab" role="tab" data-tab="${k}" aria-selected="false">${n}</button>`).join('')}</nav>
      <button class="s9p-x" id="s9pClose" aria-label="Close profile"><span>Close</span><kbd>Esc</kbd></button></header>
      <div class="s9p-body" id="s9pBody"></div>`;
    document.body.appendChild(root);
    body = root.querySelector('#s9pBody');
    tip = document.createElement('div'); tip.className = 's9p-tip'; document.body.appendChild(tip);
    root.querySelector('#s9pClose').addEventListener('click', close);
    root.querySelector('.s9p-tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) show(b.dataset.tab); });
    root.querySelector('.s9p-tabs').addEventListener('keydown', e => { if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return; const i = TABS.findIndex(t => t[0] === curTab); const n = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length][0]; show(n); root.querySelector(`[data-tab="${n}"]`).focus(); });
    body.addEventListener('click', e => {
      const s = e.target.closest('[data-sort]'); if (s) { const k = s.dataset.sort; wSort = wSort.key === k ? { key: k, dir: -wSort.dir } : { key: k, dir: k === 'name' ? 1 : -1 }; const t = body.querySelector('#s9pWeap'); if (t) t.outerHTML = weaponsTable(); return; }
      if (e.target.closest('[data-signin]')) signIn();
      const g = e.target.closest('[data-goto]'); if (g) show(g.dataset.goto);
    });
    // chart / cell tooltips (hit targets are larger than the marks)
    const tipMove = e => { const t = e.target.closest && e.target.closest('[data-tip]'); if (!t) { tip.classList.remove('on'); return; } tip.textContent = t.getAttribute('data-tip'); tip.classList.add('on'); const w = tip.offsetWidth, h = tip.offsetHeight; tip.style.left = clamp(e.clientX + 14, 6, innerWidth - w - 6) + 'px'; tip.style.top = clamp(e.clientY - h - 12, 6, innerHeight - h - 6) + 'px'; };
    root.addEventListener('pointermove', tipMove); root.addEventListener('pointerleave', () => tip.classList.remove('on'));
  }

  /* ---------------- tab renderers ---------------- */
  function idHTML(P) {
    if (!P) return `${badgeHTML(0, 0, "sm")}<div><span>Guest operator</span><b>Not signed in</b></div>`;
    return `${badgeHTML(P.rank.i, 0, "sm")}<div><span>${esc(P.rank.name)} ${STEPS[P.rank.step - 1]} · Level ${P.level}</span><b>${esc(P.nick)}</b></div>`;
  }
  const tile = (label, value, sub, extra = '', cls = '') => `<div class="s9p-tile ${cls}" data-stat="${esc(label)}"><div class="s9p-lab">${esc(label)}</div><div class="v">${value}</div>${sub != null ? `<div class="s">${sub}</div>` : ''}${extra}</div>`;
  const meter = p => `<div class="s9p-meter"><i style="transform:scaleX(${p == null ? 0 : (clamp(p, 0, 100) / 100).toFixed(4)})"></i></div>`;
  function derived(P) {
    const s = P.stats; const kd = ratio(s.kills, s.deaths);
    const decided = s.wins + s.losses, mt = Math.max(s.matches, decided);
    return { kd, win: pctOrNull(s.wins, decided || s.matches), acc: pctOrNull(s.hits, s.shots), hs: pctOrNull(s.headshots, s.kills), mt, decided };
  }
  function guestHTML(compact) {
    if (compact) return `<div class="s9p-banner"><span>You are playing as a guest. Sign in to save your level, stats and match history.</span><button class="s9p-cta" data-signin>Sign in</button></div>`;
    return `<div class="s9p-card s9p-guest">${badgeHTML(0, 1)}<h3>Sign in to save<br>your progress</h3>
      <p>Guests play with everything unlocked for the match, but nothing is kept. With a free account every kill, win and headshot counts toward your level, your rank badge and your career stats, on any computer.</p>
      <div class="s9p-perks"><span>50 levels · 10 ranks</span><span>Prestige stars</span><span>Stats per map and weapon</span><span>Last 20 matches</span></div>
      <button class="s9p-cta" data-signin>Sign in or create account</button>
      <button class="s9p-ghost" data-goto="ranks">See the rank ladder</button></div>`;
  }
  function overviewHTML(P) {
    if (!P) return guestHTML(false);
    const s = P.stats, d = derived(P);
    const frac = P.maxed ? 1 : clamp(P.xpIn / (P.need || 1), 0, 1);
    const nextL = Math.min(MAX_LV, P.level + 1), nextRank = rankOf(nextL);
    const toNext = Math.max(0, Math.round(P.need - P.xpIn));
    const form = P.recent.slice(-10);
    const perMatch = s.matches ? Math.round(s.playSeconds / s.matches / 60) : 0;
    const skinName = P.look.skin ? P.look.skin.replace(/[_-]+/g, ' ') : 'Default operator';
    return `<div class="s9p-ov">
      <div class="s9p-card s9p-hero">${badgeHTML(P.rank.i, P.rank.step, 's9p-hbig', '<div class="s9p-glow"></div>')}
        <div style="min-width:0;position:relative;z-index:1"><div class="s9p-lab">Operator · member since ${esc(fmtSince(P.created))}</div>
          <div class="s9p-nick" id="s9pNick">${esc(P.nick)}</div>${starsHTML(P.prestige)}
          <div class="s9p-lvl"><strong id="s9pLevel">${P.level}</strong><div><span class="s9p-lab">Level${P.prestige ? ` · prestige ${P.prestige}` : ''}</span><span class="s9p-rank" id="s9pRankName">${esc(P.rank.name)} ${STEPS[P.rank.step - 1]}</span></div></div>
          <div class="s9p-xp"><div class="s9p-xprow"><span><b id="s9pXpNow">${fmtN(P.xpIn)}</b> / ${fmtN(P.need)} XP</span><span>${P.maxed ? 'Max level reached' : `${fmtN(toNext)} XP to level ${nextL}`}</span></div>
            <div class="s9p-xpbar" role="progressbar" aria-valuemin="0" aria-valuemax="${Math.round(P.need)}" aria-valuenow="${Math.round(P.xpIn)}"><i id="s9pXpFill" data-frac="${frac.toFixed(4)}"></i><b></b></div>
            <div class="s9p-xprow"><span>${P.maxed ? (P.prestige ? `Prestige ${P.prestige} · ${esc(RANKS[9])} V` : 'Prestige unlocked') : `Next: ${esc(RANKS[nextRank])} ${STEPS[stepOf(nextL) - 1]}`}</span><span>Total ${fmtC(P.xp || CUM[P.level] + P.xpIn)} XP</span></div></div>
        </div></div>
      <div class="s9p-grid">
        <div class="s9p-tiles">
          ${tile('K/D ratio', fmtR(d.kd), `${fmtN(s.kills)} kills · ${fmtN(s.deaths)} deaths`, '', 'hl')}
          ${tile('Win rate', fmtP(d.win, 0), `${fmtN(s.wins)} won · ${fmtN(s.losses)} lost`, meter(d.win))}
          ${tile('Accuracy', fmtP(d.acc), `${fmtC(s.hits)} hits of ${fmtC(s.shots)} shots`, meter(d.acc))}
          ${tile('Headshots', fmtP(d.hs, 0), `${fmtN(s.headshots)} of your kills`, meter(d.hs))}
          ${tile('Matches', fmtN(s.matches), `${fmtN(s.mvps)} MVP · best streak ${fmtN(s.bestStreak)}`)}
          ${tile('Play time', fmtTime(s.playSeconds), s.matches ? `about ${perMatch} min per match` : 'no matches yet')}
        </div>
        <div class="s9p-side">
          <div class="s9p-card"><div class="s9p-lab">Recent form · last ${form.length || 0}</div>
            ${form.length ? `<div class="s9p-form" aria-label="Recent results">${form.map(r => `<i class="${r.win ? 'w' : 'l'}" data-tip="${esc(`${r.win ? 'Win' : 'Loss'} · ${mapName(r.map)}\n${MODE_SHORT[r.mode] || r.mode.toUpperCase()} · ${r.kills}/${r.deaths}`)}">${r.win ? 'W' : 'L'}</i>`).join('')}</div>
              <div class="s9p-xprow" style="margin-top:12px"><span>Avg K/D <b>${fmtR(ratio(form.reduce((a, r) => a + r.kills, 0), form.reduce((a, r) => a + r.deaths, 0)))}</b></span><span>XP <b>+${fmtN(form.reduce((a, r) => a + r.xp, 0))}</b></span></div>
              <button class="s9p-ghost" style="margin-top:14px" data-goto="matches">Match history</button>` : '<div class="s9p-empty" style="margin-top:12px">Play your first match to see your form here.</div>'}
          </div>
          <div class="s9p-card s9p-skin"><div class="s9p-lab">Current look</div><div class="s9p-skinview" id="s9pSkin">${skinSilhouette()}</div><div class="s9p-xprow"><b>${esc(skinName)}</b><span>${esc(RANKS[P.rank.i])} badge</span></div></div>
        </div>
      </div></div>`;
  }
  const skinSilhouette = () => `<svg viewBox="0 0 120 200" aria-hidden="true"><defs><linearGradient id="s9pSil" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a4048"/><stop offset="1" stop-color="#15181c"/></linearGradient></defs>
    <path fill="url(#s9pSil)" stroke="rgba(255,154,60,.5)" stroke-width="1.2" d="M60 8c11 0 19 8 19 20 0 9-4 15-9 18l2 6 22 8c7 3 10 8 11 15l4 44-10 2-5-36-2 0 2 108H70l-6-70h-8l-6 70H31l2-108h-2l-5 36-10-2 4-44c1-7 4-12 11-15l22-8 2-6c-5-3-9-9-9-18 0-12 8-20 19-20z"/>
    <path d="M47 24h26v7H47z" fill="#ff9a3c" opacity=".85"/></svg>`;

  /* charts: crisp inline SVG, one axis, 2px lines, hover targets bigger than the marks */
  function lineChart(vals, o) {
    const W = 320, H = 120, pl = 30, pr = 34, pt = 10, pb = 18;
    if (vals.length < 2) return `<div class="s9p-empty">${esc(o.empty || 'Play two matches to see a trend.')}</div>`;
    const max = Math.max(o.minMax || 0, ...vals.map(v => v.y)) * 1.1 || 1, n = vals.length;
    const X = i => pl + (W - pl - pr) * (i / (n - 1)), Y = v => pt + (H - pt - pb) * (1 - v / max);
    const pts = vals.map((v, i) => [X(i), Y(v.y)]);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
    const area = d + `L${X(n - 1).toFixed(1)} ${H - pb}L${pl} ${H - pb}Z`;
    const ticks = [0, max / 1.1 / 2, max / 1.1].map(t => +t.toFixed(o.dec == null ? 1 : o.dec));
    const last = vals[n - 1];
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.label)}">
      ${ticks.map(t => `<line class="ax" x1="${pl}" x2="${W - pr}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}"/><text x="${pl - 6}" y="${(Y(t) + 3).toFixed(1)}" text-anchor="end">${o.fmt(t)}</text>`).join('')}
      ${o.ref != null && o.ref < max ? `<line class="ref" x1="${pl}" x2="${W - pr}" y1="${Y(o.ref).toFixed(1)}" y2="${Y(o.ref).toFixed(1)}"/>` : ''}
      <path d="${area}" fill="${o.color}" opacity=".1"/><path class="ln" d="${d}" stroke="${o.color}"/>
      ${pts.map((p, i) => `<circle class="hit" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="9" data-tip="${esc(vals[i].tip)}"/><circle class="dot${i === n - 1 ? ' end' : ''}" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4" fill="${o.color}"/>`).join('')}
      <text x="${(pts[n - 1][0] + 8).toFixed(1)}" y="${(pts[n - 1][1] + 4).toFixed(1)}" style="fill:#ece6d8;font-weight:600">${o.fmt(last.y)}</text>
      <text x="${pl}" y="${H - 3}">oldest</text><text x="${W - pr}" y="${H - 3}" text-anchor="end">latest</text></svg>`;
  }
  function wlBar(w, l) {
    const t = w + l; if (!t) return '<div class="s9p-empty">No finished matches yet.</div>';
    const W = 320, gap = 2, ww = (W - (w && l ? gap : 0)) * w / t, lw = W - ww - (w && l ? gap : 0);
    const seg = (x, wd, c, tipT, first, lastSeg) => { if (wd <= 0) return ''; const r = Math.min(4, wd / 2), h = 24; const l0 = first ? r : 0, r0 = lastSeg ? r : 0;
      return `<path d="M${x + l0} 0H${x + wd - r0}${r0 ? `Q${x + wd} 0 ${x + wd} ${r0}V${h - r0}Q${x + wd} ${h} ${x + wd - r0} ${h}` : `V${h}`}H${x + l0}${l0 ? `Q${x} ${h} ${x} ${h - l0}V${l0}Q${x} 0 ${x + l0} 0` : `V0`}Z" fill="${c}"/><rect x="${x}" y="-6" width="${wd}" height="36" fill="transparent" data-tip="${esc(tipT)}"/>`; };
    return `<svg viewBox="0 -6 ${W} 36" role="img" aria-label="Wins ${w}, losses ${l}">${seg(0, ww, '#d9761c', `Wins ${w} (${Math.round(w / t * 100)}%)`, true, !l)}${seg(ww + (w && l ? gap : 0), lw, '#1f9cbd', `Losses ${l} (${Math.round(l / t * 100)}%)`, !w, true)}</svg>`;
  }
  function columns(vals, o) {
    if (!vals.length) return `<div class="s9p-empty">${esc(o.empty)}</div>`;
    const W = 320, H = 120, pl = 30, pb = 18, pt = 10, n = vals.length, max = Math.max(1, ...vals.map(v => v.y)) * 1.1;
    const band = (W - pl) / n, bw = Math.min(16, band - 2), Y = v => pt + (H - pt - pb) * (1 - v / max);
    const ticks = [0, Math.round(max / 1.1 / 2), Math.round(max / 1.1)];
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.label)}">${ticks.map(t => `<line class="ax" x1="${pl}" x2="${W}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}"/><text x="${pl - 6}" y="${(Y(t) + 3).toFixed(1)}" text-anchor="end">${fmtC(t)}</text>`).join('')}
      ${vals.map((v, i) => { const x = pl + band * i + (band - bw) / 2, y = Y(v.y), h = H - pb - y, r = Math.min(4, h, bw / 2); return `<path d="M${x.toFixed(1)} ${H - pb}V${(y + r).toFixed(1)}Q${x.toFixed(1)} ${y.toFixed(1)} ${(x + r).toFixed(1)} ${y.toFixed(1)}H${(x + bw - r).toFixed(1)}Q${(x + bw).toFixed(1)} ${y.toFixed(1)} ${(x + bw).toFixed(1)} ${(y + r).toFixed(1)}V${H - pb}Z" fill="${v.c || o.color}"/><rect x="${(pl + band * i).toFixed(1)}" y="0" width="${band.toFixed(1)}" height="${H - pb}" fill="transparent" data-tip="${esc(v.tip)}"/>`; }).join('')}
      <text x="${pl}" y="${H - 3}">oldest</text><text x="${W}" y="${H - 3}" text-anchor="end">latest</text></svg>`;
  }
  function weaponsTable() {
    const P = PROFILE; const rows = Object.entries(P ? P.stats.perWeapon : {}).map(([id, w]) => { const info = weaponInfo(id); return { id, name: info.name, cls: info.cls, kills: w.kills, shots: w.shots, acc: pctOrNull(Math.min(w.hits, w.shots), w.shots), hs: pctOrNull(Math.min(w.headshots, w.kills), w.kills) }; });
    const k = wSort.key, dir = wSort.dir;
    rows.sort((a, b) => { const x = a[k], y = b[k]; if (k === 'name') return dir * String(x).localeCompare(String(y)); return dir * ((x == null ? -1 : x) - (y == null ? -1 : y)) || b.kills - a.kills; });
    const th = (key, label, cls = '') => `<th class="${cls}" ${wSort.key === key ? `aria-sort="${wSort.dir > 0 ? 'ascending' : 'descending'}"` : ''}><button data-sort="${key}">${label}</button></th>`;
    if (!rows.length) return `<div id="s9pWeap" class="s9p-empty">No weapon kills yet. Your arsenal stats appear after your first match.</div>`;
    const maxK = Math.max(1, ...rows.map(r => r.kills));
    return `<div id="s9pWeap" class="s9p-card" style="padding:6px 8px;overflow-x:auto"><table class="s9p-tbl"><thead><tr>${th('name', 'Weapon')}${th('kills', 'Kills')}${th('acc', 'Accuracy')}${th('hs', 'HS %')}${th('shots', 'Shots', 'hs-sm')}</tr></thead><tbody>
      ${rows.map(r => `<tr data-w="${esc(r.id)}" data-kills="${r.kills}" data-acc="${r.acc == null ? -1 : r.acc.toFixed(3)}" data-hs="${r.hs == null ? -1 : r.hs.toFixed(3)}" data-shots="${r.shots}" data-name="${esc(r.name)}">
        <td><div class="s9p-wpn"><img src="assets/ui/w_${safeId(r.id)}.png" alt="" loading="lazy" onerror="this.style.visibility='hidden'"><div><b>${esc(r.name)}</b><small>${esc(r.cls)}</small></div></div></td>
        <td><div class="s9p-cell"><b>${fmtN(r.kills)}</b>${meter(r.kills / maxK * 100)}</div></td><td>${fmtP(r.acc)}</td><td>${fmtP(r.hs, 0)}</td><td class="hs-sm">${fmtC(r.shots)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  function statsHTML(P) {
    if (!P) return guestHTML(false);
    const s = P.stats, d = derived(P), m = s.matches;
    const per = v => (m ? (v / m).toFixed(1) : '0.0');
    const R = P.recent;
    const kdVals = R.map((r, i) => ({ y: ratio(r.kills, r.deaths), tip: `Match ${i + 1} · ${mapName(r.map)}\n${r.kills} kills / ${r.deaths} deaths · K/D ${fmtR(ratio(r.kills, r.deaths))}` }));
    const accR = R.filter(r => r.shots > 0);
    const accVals = accR.map((r, i) => ({ y: clamp(Math.min(r.hits, r.shots) / r.shots * 100, 0, 100), tip: `${mapName(r.map)}\n${Math.min(r.hits, r.shots)} hits / ${r.shots} shots · ${(Math.min(r.hits, r.shots) / r.shots * 100).toFixed(1)}%` }));
    const accChart = accVals.length >= 2 ? `<div class="s9p-card s9p-chart"><div class="s9p-lab">Accuracy per match</div>${lineChart(accVals, { label: 'Accuracy per match', color: '#d9761c', fmt: v => Math.round(v) + '%', minMax: 10, dec: 0 })}</div>`
      : `<div class="s9p-card s9p-chart"><div class="s9p-lab">XP gained per match</div>${columns(R.map(r => ({ y: r.xp, c: r.win ? '#d9761c' : '#1f9cbd', tip: `${r.win ? 'Win' : 'Loss'} · ${mapName(r.map)}\n+${fmtN(r.xp)} XP` })), { label: 'XP per match', color: '#d9761c', empty: 'Your XP per match shows up here.' })}<div class="s9p-legend"><span style="--c:#d9761c">Win</span><span style="--c:#1f9cbd">Loss</span></div></div>`;
    const modes = ['ffa', 'tdm', 'demo'].map(k => {
      const md = s.perMode[k] || { matches: 0, wins: 0, plants: 0, defuses: 0, roundsWon: 0, roundsPlayed: 0 }; const wr = pctOrNull(md.wins, md.matches);
      let extra = '';
      if (k === 'demo') { const rw = md.roundsWon || s.roundsWon, rp = md.roundsPlayed || s.roundsPlayed; const rwp = pctOrNull(Math.min(rw, rp), rp);
        extra = `<div class="s9p-kv"><div><b>${fmtN(md.plants || s.plants)}</b><span>Plants</span></div><div><b>${fmtN(md.defuses || s.defuses)}</b><span>Defuses</span></div><div><b>${fmtP(rwp, 0)}</b><span>Rounds won</span></div></div>`; }
      return `<div class="s9p-card s9p-mode" data-mode="${k}"><h4>${MODES[k]}<small>${MODE_SHORT[k]}</small></h4>
        <div class="s9p-kv"><div><b>${fmtN(md.matches)}</b><span>Matches</span></div><div><b>${fmtN(md.wins)}</b><span>Wins</span></div><div><b>${fmtP(wr, 0)}</b><span>Win rate</span></div></div>${meter(wr)}${extra}</div>`;
    }).join('');
    const maps = mapsList(); const known = new Set(maps.map(x => x.id)); for (const id in s.perMap) if (!known.has(id)) maps.push({ id, name: id });
    let best = null, bestWr = -1; for (const x of maps) { const pm = s.perMap[x.id]; if (pm && pm.matches >= 3) { const wr = pm.wins / pm.matches; if (wr > bestWr) { bestWr = wr; best = x.id; } } }
    maps.sort((a, b) => ((s.perMap[b.id] || {}).matches || 0) - ((s.perMap[a.id] || {}).matches || 0));
    const mapCards = maps.map(x => { const pm = s.perMap[x.id] || { matches: 0, wins: 0, kills: 0, deaths: 0 }; const none = !pm.matches;
      return `<div class="s9p-map${none ? ' none' : ''}" data-map="${esc(x.id)}"><img src="assets/ui/map_${safeId(x.id)}.jpg" alt="" loading="lazy" onerror="this.remove()">${best === x.id ? '<span class="s9p-mtag best">Best map</span>' : none ? '<span class="s9p-mtag">Not played</span>' : ''}
        <div><h5>${esc(x.name)}</h5><div class="kv"><div>Matches<b>${fmtN(pm.matches)}</b></div><div>Wins<b>${fmtN(pm.wins)}</b></div><div>Win %<b>${fmtP(pctOrNull(Math.min(pm.wins, pm.matches), pm.matches), 0)}</b></div><div>K/D<b>${fmtR(ratio(pm.kills, pm.deaths))}</b></div></div>${meter(pctOrNull(Math.min(pm.wins, pm.matches), pm.matches))}</div></div>`; }).join('');
    const dmgRound = s.roundsPlayed ? s.damage / s.roundsPlayed : m ? s.damage / m : 0;
    return `
      <div class="s9p-h"><h3>Career</h3><span>${fmtN(m)} matches · ${fmtTime(s.playSeconds)} played</span></div>
      <div class="s9p-tiles t4">
        ${tile('Kills', fmtC(s.kills), `${per(s.kills)} per match`, '', 'hl')}${tile('Deaths', fmtC(s.deaths), `${per(s.deaths)} per match`)}
        ${tile('Assists', fmtC(s.assists), `${per(s.assists)} per match`)}${tile('Headshots', fmtC(s.headshots), `${fmtP(d.hs, 0)} of kills`)}
        ${tile('Damage', fmtC(s.damage), `${fmtN(dmgRound)} per ${s.roundsPlayed ? 'round' : 'match'}`)}${tile('MVPs', fmtN(s.mvps), m ? `${fmtP(pctOrNull(s.mvps, m), 0)} of matches` : 'no matches yet')}
        ${tile('Best streak', fmtN(s.bestStreak), 'kills without dying')}${tile('K/D ratio', fmtR(d.kd), `${fmtP(d.acc)} accuracy`)}
      </div>
      <div class="s9p-h"><h3>Per match</h3><span>averages</span></div>
      <div class="s9p-tiles t5">${tile('Kills', per(s.kills))}${tile('Deaths', per(s.deaths))}${tile('Assists', per(s.assists))}${tile('Damage', m ? fmtN(s.damage / m) : '0')}${tile('Damage / round', fmtN(dmgRound), s.roundsPlayed ? `${fmtN(s.roundsPlayed)} rounds` : 'per match (no rounds yet)')}</div>
      <div class="s9p-h"><h3>Trends</h3><span>last ${R.length} matches</span></div>
      <div class="s9p-charts">
        <div class="s9p-card s9p-chart"><div class="s9p-lab">K/D per match · line at 1.0 = even</div>${lineChart(kdVals, { label: 'K/D per match', color: '#d9761c', fmt: v => v.toFixed(1), ref: 1, minMax: 1.5 })}</div>
        <div class="s9p-card s9p-chart"><div class="s9p-lab">Wins and losses · career</div><div class="s9p-legend"><span style="--c:#d9761c">Wins <b>${fmtN(s.wins)}</b></span><span style="--c:#1f9cbd">Losses <b>${fmtN(s.losses)}</b></span><span>Win rate <b>${fmtP(d.win, 0)}</b></span></div>${wlBar(s.wins, s.losses)}
          ${R.length ? `<div class="s9p-lab" style="margin-top:6px">Last ${R.length}</div><div class="s9p-form" style="margin-top:0">${R.map(r => `<i class="${r.win ? 'w' : 'l'}" style="width:20px;height:20px;font-size:10px" data-tip="${esc(`${r.win ? 'Win' : 'Loss'} · ${mapName(r.map)}`)}">${r.win ? 'W' : 'L'}</i>`).join('')}</div>` : ''}</div>
        ${accChart}
      </div>
      <div class="s9p-h"><h3>Modes</h3></div><div class="s9p-modes">${modes}</div>
      <div class="s9p-h"><h3>Maps</h3><span>${maps.filter(x => (s.perMap[x.id] || {}).matches).length} of ${maps.length} played</span></div><div class="s9p-maps">${mapCards}</div>
      <div class="s9p-h"><h3>Weapons</h3><span>click a column to sort</span></div>${weaponsTable()}`;
  }
  function matchesHTML(P) {
    if (!P) return guestHTML(false);
    const R = P.recent.slice().reverse();
    if (!R.length) return `<div class="s9p-card s9p-empty" style="padding:50px 20px">No matches yet. Your last 20 matches will be listed here with the map, result, kills and XP.</div>`;
    const w = R.filter(r => r.win).length, k = R.reduce((a, r) => a + r.kills, 0), dd = R.reduce((a, r) => a + r.deaths, 0), xp = R.reduce((a, r) => a + r.xp, 0);
    return `<div class="s9p-card s9p-sum"><div><span class="s9p-lab">Last ${R.length}</span><b>${w}W · ${R.length - w}L</b></div><div><span class="s9p-lab">K/D</span><b>${fmtR(ratio(k, dd))}</b></div><div><span class="s9p-lab">Kills</span><b>${fmtN(k)}</b></div><div><span class="s9p-lab">XP earned</span><b>+${fmtN(xp)}</b></div></div>
      <div class="s9p-ml" id="s9pMatchList">${R.map(r => `<div class="s9p-m ${r.win ? 'w' : 'l'}" data-match>
        <div class="th"><img src="assets/ui/map_${safeId(r.map)}.jpg" alt="" loading="lazy" onerror="this.remove()"></div>
        <div class="resw"><div class="res">${r.win ? 'Victory' : 'Defeat'}</div></div>
        <div class="mm"><b>${esc(mapName(r.map))}${r.mvp ? '<span class="s9p-mvp">MVP</span>' : ''}</b><small>${esc(MODES[r.mode] || r.mode)}</small></div>
        <div class="n kd"><b>${r.kills} – ${r.deaths}</b><small>K – D</small></div>
        <div class="n ra"><b>${fmtR(ratio(r.kills, r.deaths))}</b><small>K/D</small></div>
        <div class="n xp"><b>+${fmtN(r.xp)}</b><small>XP</small></div>
        <div class="n when"><b style="font-size:12px;font-weight:400">${esc(fmtAgo(r.at))}</b></div></div>`).join('')}</div>`;
  }
  function ranksHTML(P) {
    const lvl = P ? P.level : 1, xpIn = P ? P.xpIn : 0, rw = EXTRA.rewards;
    const total = P ? CUM[P.level] + P.xpIn : 0, legend = CUM[MAX_LV];
    const rows = RANKS.map((name, i) => {
      const cls = rankOf(lvl) > i ? 'done' : rankOf(lvl) === i ? 'cur' : 'lock';
      const steps = STEPS.map((sn, k) => { const L = i * 5 + k + 1; const sc = L < lvl ? 'done' : L === lvl ? 'cur' : ''; const fr = L === lvl ? (P && P.maxed ? 1 : clamp(xpIn / NEED[L], 0, 1)) : 0;
        return `<div class="s9p-st ${sc}" data-tip="${esc(`${name} ${sn} · level ${L}\nUnlocks at ${fmtN(CUM[L])} total XP\n${L < MAX_LV ? `${fmtN(NEED[L])} XP to level ${L + 1}` : 'Final level, prestige next'}`)}"><b>${sn}</b><span>Lv ${L} · ${fmtC(CUM[L])}</span>${sc === 'cur' ? `<i style="transform:scaleX(${fr.toFixed(3)})"></i>` : ''}</div>`; }).join('');
      const all = catalogue().filter(x => rankOf(x.level) === i), more = Math.max(0, all.length - 5);
      const items = [{ kind: 'Badge', name: `${name} emblem` }].concat(all.slice(0, 5).map(x => ({ kind: x.kind, name: `${x.name} (Lv ${x.level})` }))).concat(more ? [{ kind: '+' + more, name: 'more unlocks' }] : []);
      return `<div class="s9p-rr ${cls}" data-rankrow="${i}">${badgeHTML(i, 0, "sm")}<div><h5>${esc(name)}${cls === 'cur' ? '<span class="s9p-here">You</span>' : ''}</h5><div class="lv">Levels ${i * 5 + 1}–${i * 5 + 5} · from ${fmtC(CUM[i * 5 + 1])} XP</div></div>
        <div class="s9p-steps">${steps}</div><div class="s9p-rw">${items.map(x => `<span title="${esc(x.kind + ': ' + x.name)}"><em>${esc(x.kind)}</em>${esc(x.name)}</span>`).join('')}</div></div>`;
    }).join('');
    const prest = `<div class="s9p-rr ${P && P.prestige ? 'done' : 'lock'}" data-rankrow="p"><div class="s9p-stars" style="justify-content:center;font-size:30px"><i>★</i></div><div><h5>Prestige${P && P.prestige ? ` ${P.prestige}` : ''}</h5><div class="lv">After ${esc(RANKS[9])} V</div></div>
      <div style="font-size:12px;color:var(--dim);line-height:1.6">Reach level 50, then prestige: you go back to Recruit I and earn a gold star that shows next to your badge for good. Your stats are never reset.</div><div class="s9p-rw"><span><em>Badge</em>Prestige star</span></div></div>`;
    return `${P ? '' : guestHTML(true)}<div class="s9p-card s9p-sum"><div><span class="s9p-lab">Your rank</span><b>${esc(RANKS[rankOf(lvl)])} ${STEPS[stepOf(lvl) - 1]}</b></div><div><span class="s9p-lab">Level</span><b>${lvl} / ${MAX_LV}</b></div><div><span class="s9p-lab">Total XP</span><b>${fmtC(total)}</b></div><div style="flex:1;min-width:220px"><span class="s9p-lab">Road to ${esc(RANKS[9])} V · ${fmtP(clamp(total / legend * 100, 0, 100), 1)}</span>${meter(clamp(total / legend * 100, 0, 100))}</div></div>
      <div class="s9p-lab">XP: kill 100 · headshot +50 · assist 40 · win 500 · loss 150 · plant 150 · defuse 200 · round win 120 · MVP 200 · first match of the day +500</div>
      <div class="s9p-ladder">${rows}${prest}</div>`;
  }

  function render() {
    if (!root) return;
    root.querySelector('#s9pId').innerHTML = idHTML(PROFILE);
    root.querySelectorAll('.s9p-tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === curTab)));
    const P = PROFILE;
    const html = curTab === 'stats' ? statsHTML(P) : curTab === 'matches' ? matchesHTML(P) : curTab === 'ranks' ? ranksHTML(P) : overviewHTML(P);
    body.innerHTML = `<div class="s9p-wrap" data-view="${curTab}">${html}</div>`;
    body.scrollTop = 0;
    if (curTab === 'overview' && P) {
      const f = body.querySelector('#s9pXpFill'); if (f) requestAnimationFrame(() => requestAnimationFrame(() => { f.style.transform = `scaleX(${f.dataset.frac})`; }));
      const el = body.querySelector('#s9pSkin');
      if (el && window.S9Skins && typeof window.S9Skins.preview === 'function') { try { const r = window.S9Skins.preview(el, P.look); if (r && r.catch) r.catch(() => {}); } catch (e) { console.warn('S9Skins.preview failed', e); } }
    }
    if (curTab === 'ranks') { const c = body.querySelector('.s9p-rr.cur'); if (c && c.scrollIntoView) setTimeout(() => { const top = c.offsetTop - body.clientHeight / 3; body.scrollTo({ top: Math.max(0, top), behavior: reduced() ? 'auto' : 'smooth' }); }, 60); }
  }
  function show(tab) { if (!TABS.some(t => t[0] === tab)) tab = 'overview'; curTab = tab; render(); }

  /* ---------------- open / close ---------------- */
  let lastFocus = null;
  function pullAccount() {
    const A = window.S9Account; if (!A || PROFILE) return;
    try { if (!A.__s9p && typeof A.onChange === 'function') { A.__s9p = true; A.onChange(p => setProfile(p)); } const p = typeof A.profile === 'function' ? A.profile() : typeof A.getProfile === 'function' ? A.getProfile() : A.profile; if (p && typeof p.then === 'function') p.then(x => { if (x && !PROFILE) setProfile(x); }).catch(() => {}); else if (p) PROFILE = normalize(p); } catch (e) {}
  }
  function open(tab) {
    ensureDom(); pullAccount(); lastFocus = document.activeElement;
    curTab = TABS.some(t => t[0] === tab) ? tab : curTab || 'overview';
    root.hidden = false; render(); void root.offsetWidth; root.classList.add('on');
    const t = root.querySelector('.s9p-tab[aria-selected=true]'); if (t) t.focus({ preventScroll: true });
    dataReady.then(() => { if (isOpen()) render(); });
    return api;
  }
  function close() {
    if (!root || root.hidden) return api;
    root.classList.remove('on'); tip.classList.remove('on'); root.hidden = true;
    if (lastFocus && lastFocus.focus && document.contains(lastFocus)) try { lastFocus.focus({ preventScroll: true }); } catch (e) {}
    return api;
  }
  const isOpen = () => !!(root && !root.hidden);
  function setProfile(p) { PROFILE = normalize(p); updateButtons(); if (isOpen()) render(); return api; }
  function signIn() {
    const A = window.S9Account;
    if (A) { for (const f of ['open', 'show', 'login', 'signIn']) if (typeof A[f] === 'function') { close(); try { A[f]('signin'); } catch (e) { console.warn(e); } return; } }
    const b = root.querySelector('[data-signin]'); if (b) { b.textContent = 'Accounts are coming soon'; b.disabled = true; }
  }

  /* ---------------- sound: synthesized with WebAudio, no files ----------------
     Volume = game master volume (CFG.vol) x effects volume (S9Settings, if present). UI sounds go straight to the speakers
     (not through the game's pause-mute), through our own limiter, so they also play on menus / pause / match end. */
  const SFX = (() => {
    const st = { played: 0, errors: 0, last: '' }; let vcache = { t: -1e9, a: null };
    let ctx = null, bus = null, verb = null, noise = null, charge = null, lastTick = 0;
    const vol = () => {
      let m = 0.8; try { if (typeof CFG !== 'undefined' && CFG && Number.isFinite(+CFG.vol)) m = +CFG.vol; } catch (e) {}
      let fx = 1; const S = window.S9Settings;
      try { const a = S && typeof S.get === 'function' && vcache.t > performance.now() - 500 ? vcache.a : S && typeof S.get === 'function' ? (vcache = { t: performance.now(), a: (S.get() || {}).audio }).a : null; if (a && typeof a === 'object') { if (Number.isFinite(+a.master)) m = +a.master; if (Number.isFinite(+a.effects)) return clamp(m, 0, 1) * clamp(+a.effects, 0, 1); } } catch (e) {}
      if (S) for (const k of ['effectsVolume', 'effects', 'sfxVolume', 'sfx', 'uiVolume']) {
        let v; try { v = typeof S.get === 'function' ? S.get(k) : undefined; if (v == null && S.values) v = S.values[k]; if (v == null) v = S[k]; } catch (e) {}
        if (v != null && Number.isFinite(+v)) { fx = +v > 1 ? +v / 100 : +v; break; }
      }
      return clamp(m, 0, 1) * clamp(fx, 0, 1);
    };
    function init() {
      if (ctx) { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); return ctx; }
      try {
        const g = window.__s9 && window.__s9.AU; ctx = (g && g.ctx) || (typeof AU !== 'undefined' && AU && AU.ctx) || null;
        if (!ctx) { const C = window.AudioContext || window.webkitAudioContext; if (!C) return null; ctx = new C(); }
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        const lim = ctx.createDynamicsCompressor(); lim.threshold.value = -12; lim.knee.value = 8; lim.ratio.value = 8; lim.attack.value = .002; lim.release.value = .25; lim.connect(ctx.destination);
        bus = ctx.createGain(); bus.gain.value = vol() * .9; bus.connect(lim);
        const len = ctx.sampleRate * 1.8 | 0, ir = ctx.createBuffer(2, len, ctx.sampleRate);
        for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2); }
        verb = ctx.createConvolver(); verb.buffer = ir; const vg = ctx.createGain(); vg.gain.value = .32; verb.connect(vg); vg.connect(bus);
        noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate); const nd = noise.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
      } catch (e) { st.errors++; ctx = null; }
      return ctx;
    }
    // every sound plays into a "scene" gain so a skip can fade the rest of a fanfare out smoothly
    function scene() { if (!init()) return null; try { bus.gain.setTargetAtTime(vol() * .9, ctx.currentTime, .02); const g = ctx.createGain(); g.connect(bus); g.connect(verb); return g; } catch (e) { st.errors++; return null; } }
    function fade(g, t = .12) { if (!g || !ctx) return; try { g.gain.cancelScheduledValues(ctx.currentTime); g.gain.setTargetAtTime(0, ctx.currentTime, t / 3); setTimeout(() => { try { g.disconnect(); } catch (e) {} }, t * 1000 + 400); } catch (e) {} }
    const run = (name, fn) => { try { if (!vol() || !init()) return; const s = scene(); if (!s) return; fn(ctx.currentTime + .01, s); st.played++; st.last = name; return s; } catch (e) { st.errors++; } };
    function tone(dst, t, f, d, o = {}) {
      const os = ctx.createOscillator(), g = ctx.createGain(); os.type = o.type || 'sine'; os.frequency.setValueAtTime(f, t); if (o.to) os.frequency.exponentialRampToValueAtTime(o.to, t + (o.glide || d)); if (o.det) os.detune.value = o.det;
      const a = o.a || .005, pk = o.v || .2; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(pk, t + a); g.gain.exponentialRampToValueAtTime(.0008, t + d);
      let out = g; if (o.lp) { const f2 = ctx.createBiquadFilter(); f2.type = 'lowpass'; f2.frequency.setValueAtTime(o.lp, t); if (o.lpTo) f2.frequency.exponentialRampToValueAtTime(o.lpTo, t + d); f2.Q.value = o.q || .7; g.connect(f2); out = f2; }
      os.connect(g); out.connect(dst); os.start(t); os.stop(t + d + .05);
    }
    function nz(dst, t, d, o = {}) {
      const s = ctx.createBufferSource(); s.buffer = noise; s.loop = true; const f = ctx.createBiquadFilter(); f.type = o.type || 'bandpass'; f.frequency.setValueAtTime(o.f || 800, t); if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t + d); f.Q.value = o.q || 1.2;
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(o.v || .2, t + (o.a || d * .6)); g.gain.exponentialRampToValueAtTime(.0008, t + d);
      s.connect(f); f.connect(g); g.connect(dst); s.start(t); s.stop(t + d + .05);
    }
    const bell = (dst, t, f, d = 1.3, v = .12) => { tone(dst, t, f, d, { v, type: 'sine' }); tone(dst, t, f * 2, d * .55, { v: v * .4, type: 'triangle' }); tone(dst, t, f * 3.01, d * .3, { v: v * .16 }); };
    const brass = (dst, t, f, d, v = .07) => { for (const det of [-9, 0, 8]) tone(dst, t, f, d, { type: 'sawtooth', v, det, a: .05, lp: 500, lpTo: 2600, q: 1.1 }); };
    const N = n => 440 * Math.pow(2, (n - 69) / 12); // midi -> Hz
    return {
      stats: st, init, fade, get charging() { return !!charge; },
      tick(i = 0) { const now = performance.now(); if (now - lastTick < 42) return; lastTick = now; run('tick', (t, s) => { tone(s, t, 1700 + Math.min(12, i) * 70, .045, { type: 'triangle', v: .07, a: .002 }); }); },
      row(i = 0) { run('row', (t, s) => { tone(s, t, N(79 + (i % 5) * 2), .16, { type: 'triangle', v: .06 }); tone(s, t, N(91 + (i % 5) * 2), .09, { v: .025 }); }); },
      chargeStart() {
        if (charge || !vol()) return; try { if (!init()) return; const s = scene(); if (!s) return;
          const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain(), lfo = ctx.createOscillator(), lg = ctx.createGain();
          o1.type = 'sawtooth'; o2.type = 'sine'; o2.detune.value = 7; f.type = 'lowpass'; f.Q.value = 6; f.frequency.value = 600; g.gain.value = 0;
          lfo.frequency.value = 9; lg.gain.value = .012; lfo.connect(lg); lg.connect(g.gain);
          o1.connect(f); o2.connect(f); f.connect(g); g.connect(s); const t = ctx.currentTime; g.gain.linearRampToValueAtTime(.045, t + .12);
          o1.start(); o2.start(); lfo.start(); charge = { o1, o2, f, g, lfo, s }; st.played++; st.last = 'charge'; this.chargeSet(0);
        } catch (e) { st.errors++; } },
      chargeSet(frac) { if (!charge) return; try { const t = ctx.currentTime, fr = 150 * Math.pow(2, clamp(frac, 0, 1.6) * 1.75); charge.o1.frequency.setTargetAtTime(fr, t, .03); charge.o2.frequency.setTargetAtTime(fr * 2, t, .03); charge.f.frequency.setTargetAtTime(500 + 3200 * clamp(frac, 0, 1.2), t, .04); } catch (e) { st.errors++; } },
      chargeStop() { if (!charge) return; const c = charge; charge = null; try { const t = ctx.currentTime; c.g.gain.cancelScheduledValues(t); c.g.gain.setTargetAtTime(0, t, .04); for (const o of [c.o1, c.o2, c.lfo]) o.stop(t + .3); setTimeout(() => { try { c.s.disconnect(); } catch (e) {} }, 600); } catch (e) { st.errors++; } },
      // small level crossing inside the XP panel
      cross(L = 1) { return run('cross', (t, s) => { nz(s, t, .32, { f: 600, to: 5000, v: .12, a: .2 }); tone(s, t, 110, .25, { to: 48, v: .35 }); const r = 72 + (L % 4); [0, 4, 7, 12].forEach((n, i) => { tone(s, t + .05 + i * .045, N(r + n), .9, { v: .07 }); if (i & 1) tone(s, t + .05 + i * .045, N(r + n) * 2, .5, { v: .025, type: 'triangle' }); }); }); },
      // level up popup: punchy whoosh + major chord
      level() { return run('level', (t, s) => {
        nz(s, t, .55, { f: 300, to: 6000, v: .16, a: .45 });
        tone(s, t + .5, 150, .32, { to: 42, v: .5 }); nz(s, t + .5, .12, { type: 'highpass', f: 3000, v: .08, a: .002 });
        [72, 76, 79, 84, 88].forEach((n, i) => bell(s, t + .52 + i * .055, N(n), 1.5, .085));
        for (let k = 0; k < 6; k++) tone(s, t + .7 + k * .06, 3000 + Math.random() * 2500, .12, { v: .02 });
      }); },
      // rank up: rising swell, sub boom, brass fanfare IV-V-I, stamp, sparkle
      rank(prestige = false) { return run(prestige ? 'prestige' : 'rank', (t, s) => {
        nz(s, t, 1.4, { f: 200, to: 4000, v: .14, a: 1.3, q: .8 });
        tone(s, t, 55, 1.4, { to: 110, v: .12, a: 1.2, type: 'triangle' });
        const h = t + 1.42; tone(s, h, 90, .9, { to: 32, v: .6 }); nz(s, h, .5, { type: 'lowpass', f: 900, to: 120, v: .3, a: .004 });
        const root = prestige ? 62 : 60;
        brass(s, h, N(root + 5), .34); brass(s, h, N(root + 9), .34); brass(s, h + .3, N(root + 7), .34); brass(s, h + .3, N(root + 11), .34);
        [0, 4, 7, 12].forEach(n => brass(s, h + .62, N(root + n), 1.6, .06));
        [12, 16, 19, 24, 28, 31].forEach((n, i) => bell(s, h + .62 + i * .07, N(root + 12 + n), 1.8, .06));
        if (prestige) [0, 7, 12, 19].forEach(n => tone(s, h + .6, N(root + n), 2.6, { type: 'sine', v: .05, a: .5 }));
      }); },
      stamp() { return run('stamp', (t, s) => { tone(s, t, 70, .4, { to: 38, v: .55 }); nz(s, t, .25, { type: 'lowpass', f: 1200, to: 200, v: .35, a: .003 }); }); },
      card(i = 0) { return run('card', (t, s) => { nz(s, t, .22, { f: 1200, to: 4200, v: .05, a: .12 }); tone(s, t + .1, N(84 + (i % 4) * 3), .25, { type: 'triangle', v: .05 }); }); },
      done() { return run('done', (t, s) => { [67, 71, 74].forEach((n, i) => bell(s, t + i * .03, N(n), .8, .05)); }); },
      ui() { return run('ui', (t, s) => tone(s, t, 1300, .05, { type: 'triangle', v: .05, a: .002 })); }
    };
  })();

  // creating an AudioContext can block the main thread for a moment: do it on the first click/key in idle time, never mid-animation
  const warm = () => { removeEventListener('pointerdown', warm, true); removeEventListener('keydown', warm, true); (window.requestIdleCallback || setTimeout)(() => { try { SFX.init(); } catch (e) {} }); };
  addEventListener('pointerdown', warm, true); addEventListener('keydown', warm, true);

  const partsHTML = (n, spread, cls = '') => Array.from({ length: n }, (_, k) => { const a = (k / n) * Math.PI * 2 + Math.random() * .4, d = spread * (.55 + Math.random() * .6), ln = k % 3 === 0;
    return `<i class="${ln ? 'ln' : ''}" style="--x:${(Math.cos(a) * d).toFixed(0)}px;--y:${(Math.sin(a) * d).toFixed(0)}px;--r:${ln ? (a * 180 / Math.PI + 90).toFixed(0) : (Math.random() * 360).toFixed(0)}deg;--dl:${(Math.random() * .12).toFixed(2)}s;--t:${(.8 + Math.random() * .6).toFixed(2)}s;${k % 4 === 1 ? '--c:#fff3dc;' : k % 5 === 2 ? '--c:#7fe7ff;' : ''}"></i>`; }).join('') + cls;
  const ICON = { badge: '', skin: '<svg viewBox="0 0 24 24" fill="none" stroke="#ffcf8a" stroke-width="1.6"><path d="M8 3l4 2 4-2 4 4-3 3v11H7V10L4 7z"/></svg>', gun: '<svg viewBox="0 0 24 24" fill="none" stroke="#ffcf8a" stroke-width="1.6"><path d="M2 9h15l2-2h3v4h-4l-1 2h-4l-1 5H8l1-5H2z"/></svg>', star: '<svg viewBox="0 0 24 24" fill="#ffd76a"><path d="M12 2l3 7 7 .6-5.3 4.6L18.4 22 12 18l-6.4 4 1.7-7.8L2 9.6 9 9z"/></svg>', other: '<svg viewBox="0 0 24 24" fill="none" stroke="#ffcf8a" stroke-width="1.6"><rect x="4" y="7" width="16" height="13" rx="1"/><path d="M4 11h16M12 7v13M12 7c-2-4-6-3-5 0M12 7c2-4 6-3 5 0"/></svg>' };
  const rewardIcon = (r, rn) => /badge|emblem/i.test(r.kind) ? `<img src="${badgeSrc(rn)}" alt="" onerror="this.onerror=null;this.src=S9Profile._emblem(${rn})">` : /prestige|star/i.test(r.kind) ? ICON.star : /gun|weapon/i.test(r.kind) ? ICON.gun : /skin|char|look|outfit/i.test(r.kind) ? ICON.skin : ICON.other;

  /* ---------------- level-up popup (level / rank-up cinematic / prestige) ---------------- */
  let FRAMES = null; // optional art: assets/ui/badges/levelup_<n>.png image sequence plays over the badge
  function probeFrames() {
    if (FRAMES) return FRAMES;
    try { const B = window.S9Badges; let lf = B && B.levelUpFrames; if (typeof lf === 'function') lf = lf(); if (lf && (Array.isArray(lf) || typeof lf.then === 'function')) return (FRAMES = Promise.resolve(lf).then(a => (Array.isArray(a) ? a.filter(x => typeof x === 'string') : [])).catch(() => [])); } catch (e) {}
    FRAMES = new Promise(res => { const out = []; const next = k => { if (k >= 90) return res(out); const im = new Image(); im.onload = () => { out.push(im.src); next(k + 1); }; im.onerror = () => res(out); im.src = `assets/ui/badges/levelup_${k}.png`; }; next(0); });
    return FRAMES;
  }
  let luResolve = null, luTimers = [], luFrameT = 0, luScene = null, luState = '';
  function levelUp(oldLevel, newLevel, rewards, opts) {
    ensureDom(); opts = opts || {};
    const o = clamp(Math.round(num(oldLevel)) || 1, 1, MAX_LV), n = clamp(Math.round(num(newLevel)) || o, 1, MAX_LV);
    const pNew = opts.prestige != null ? int(opts.prestige) : PROFILE ? PROFILE.prestige : 0;
    const pOld = opts.fromPrestige != null ? int(opts.fromPrestige) : n < o ? Math.max(0, pNew - 1) : pNew;
    const kind = pNew > pOld || n < o ? 'prestige' : rankOf(n) > rankOf(o) ? 'rank' : 'level';
    const ro = rankOf(o), rn = rankOf(n);
    const levels = opts.levels != null ? int(opts.levels) : kind === 'prestige' ? (MAX_LV - o) + n : n - o;
    if (rewards == null && kind !== 'prestige') rewards = rewardsBetween(o, n).slice(0, 6);
    const list = (Array.isArray(rewards) ? rewards : rewards ? [rewards] : []).map(r => typeof r === 'string' ? { kind: 'Unlock', name: r } : { kind: String((r && (r.kind || r.type)) || 'Unlock'), name: String((r && r.name) || '') }).filter(r => r.name).slice(0, 8);
    if (kind === 'rank') list.unshift({ kind: 'Badge', name: `${RANKS[rn]} emblem` });
    if (kind === 'prestige') list.unshift({ kind: 'Prestige star', name: `Prestige ${pNew}` });
    if (!luPop) {
      luPop = document.createElement('div'); luPop.className = 's9p-pop'; luPop.id = 's9pLevelUp'; luPop.setAttribute('role', 'dialog'); luPop.setAttribute('aria-label', 'Level up'); luPop.hidden = true; document.body.appendChild(luPop);
      luPop.addEventListener('click', e => { if (e.target.closest('[data-lu-close]')) return closeLevelUp(); advanceLevelUp(); });
    }
    luTimers.forEach(clearTimeout); luTimers = []; cancelAnimationFrame(luFrameT); SFX.fade(luScene); luScene = null; SFX.init();
    const big = kind !== 'level', T = big ? 1.45 : .62; // T = moment of the burst
    const title = kind === 'prestige' ? `Prestige ${pNew}` : `${RANKS[rn]} ${STEPS[stepOf(n) - 1]}`;
    const dl = (s) => `--d:${s.toFixed(2)}s`;
    luPop.className = 's9p-pop k-' + kind;
    luPop.innerHTML = `<div class="vig"></div><div class="s9p-lu" data-kind="${kind}">
      <div class="fx"><div class="s9p-rays"></div><div class="s9p-burst"></div><div class="s9p-flash"></div><div class="s9p-ring"></div><div class="s9p-parts">${partsHTML(big ? 40 : 26, big ? 330 : 240)}</div></div>
      <div class="s9p-flip"><div class="spin">${badgeHTML(ro, stepOf(o))}</div><img class="s9p-frames" alt="" hidden></div>
      <div class="k in" style="${dl(T + .25)}">${kind === 'prestige' ? `${esc(RANKS[9])} complete · prestige` : kind === 'rank' ? 'Rank up · promoted' : 'Level up'}</div>
      <h2 class="in" style="${dl(T + .32)}"><span>Level</span><span class="s9p-roll" id="s9pLuRoll"><span>${o}</span><span>${n}</span></span></h2>
      ${levels > 1 ? `<div class="multi in" style="${dl(T + .4)}">+${levels} levels this match</div>` : ''}
      ${kind === 'prestige' ? `<div class="in" style="${dl(T + .45)}">${starsHTML(pNew)}</div>` : ''}
      <div class="rk in" id="s9pLuRank" style="${dl(T + (big ? .55 : .42))}">${esc(title)}</div>
      ${list.length ? `<div class="s9p-cards">${list.map((r, i) => `<div class="s9p-rc" style="${dl(T + (big ? 1.05 : .62) + i * .13)}">${rewardIcon(r, rn)}<em>${esc(r.kind)}</em><b>${esc(r.name)}</b></div>`).join('')}</div>` : ''}
      <button class="s9p-cta in" data-lu-close style="${dl(T + (big ? 1.2 : .7) + list.length * .13)}">Continue</button>
      <div class="hint in" style="${dl(T + .9)}">Click or Space to skip</div></div>`;
    luPop.hidden = false; luState = 'anim'; void luPop.offsetWidth; luPop.classList.add('on', 'run');
    const spin = luPop.querySelector('.s9p-flip>.spin');
    const swapBadge = () => { if (!spin || spin.classList.contains('b')) return; const bd = spin.querySelector('.s9p-badge'), img = bd.querySelector('img'); bd.dataset.rank = rn; bd.className = bd.className.replace(/td/, 't' + rn); img.onerror = () => S9Profile._fb(img); img.src = badgeSrc(rn); img.alt = RANKS[rn] + ' badge'; spin.classList.add('b'); };
    if (spin) spin.addEventListener('animationend', e => { if (e.animationName === 's9pHalfA' || e.animationName === 's9pRevA') swapBadge(); });
    luPop._swap = swapBadge;
    // sound + timed beats (the CSS does the motion; these keep the sound and number roll in sync with it)
    luScene = kind === 'level' ? SFX.level() : SFX.rank(kind === 'prestige');
    const at = (s, f) => luTimers.push(setTimeout(f, s * 1000));
    const settle = () => { const r = luPop.querySelector('#s9pLuRoll'); if (r) { r.classList.remove('go'); r.innerHTML = '<span>' + n + '</span>'; } };
    at(T + .55, () => { const r = luPop.querySelector('#s9pLuRoll'); if (r) r.classList.add('go'); }); at(T + 1.05, settle);
    if (big) at(T + .55 + .36, () => { SFX.stamp(); const l = luPop.querySelector('.s9p-lu'); if (l) { l.classList.remove('shake'); void l.offsetWidth; l.classList.add('shake'); } });
    list.forEach((r, i) => at(T + (big ? 1.05 : .62) + i * .13 + .05, () => SFX.card(i)));
    const endT = T + (big ? 1.3 : .8) + list.length * .13 + .5;
    at(endT, () => { luState = 'done'; const b = luPop.querySelector('[data-lu-close]'); if (b) try { b.focus({ preventScroll: true }); } catch (e) {} });
    if (opts.autoClose !== false) at(endT + (big ? 6 : 4.5), closeLevelUp);
    probeFrames().then(fr => { if (!fr.length || luPop.hidden) return; const img = luPop.querySelector('.s9p-frames'); if (!img) return; img.hidden = false; const t0 = performance.now() + T * 1000 - 300; const step = t => { const k = Math.floor((t - t0) / 33); if (k >= fr.length || luPop.hidden) { img.hidden = true; return; } if (k >= 0) img.src = fr[k]; luFrameT = requestAnimationFrame(step); }; luFrameT = requestAnimationFrame(step); });
    return new Promise(r => { if (luResolve) luResolve(); luResolve = r; });
  }
  // first click / Space: jump to the final frame; second: close
  function advanceLevelUp() {
    if (!luPop || luPop.hidden) return;
    if (luState === 'anim') {
      luState = 'done'; const keep = luTimers.slice(-1); luTimers.slice(0, -1).forEach(clearTimeout); luTimers = keep; // keep auto-close
      luPop.classList.add('skip'); if (luPop._swap) luPop._swap(); try { luPop.getAnimations({ subtree: true }).forEach(a => a.finish()); } catch (e) {} const r = luPop.querySelector('#s9pLuRoll'); if (r) { r.classList.remove('go'); r.innerHTML = '<span>' + r.lastElementChild.textContent + '</span>'; }
      SFX.fade(luScene, .15); luScene = null; SFX.done();
      const b = luPop.querySelector('[data-lu-close]'); if (b) try { b.focus({ preventScroll: true }); } catch (e) {}
    } else closeLevelUp();
  }
  function closeLevelUp() {
    if (!luPop || luPop.hidden) return; luTimers.forEach(clearTimeout); luTimers = []; cancelAnimationFrame(luFrameT); SFX.fade(luScene); luScene = null; luState = '';
    luPop.classList.remove('on'); setTimeout(() => { if (!luPop.classList.contains('on')) { luPop.hidden = true; luPop.classList.remove('run', 'skip'); } }, 260);
    const r = luResolve; luResolve = null; if (r) r();
  }

  /* ---------------- end-of-match XP panel ----------------
     Timeline: each XP line counts up in turn (ticks) -> the bar fills with a glow and a rising "charging" tone ->
     each level crossed flashes, rolls the level number, flips the badge with a burst -> then the level-up / rank-up popup.
     The whole panel is a pure function of time (draw(t)), so a skip just draws t = end. */
  function lvState(v) {
    if (v == null) return { level: 1, xpIn: 0, need: NEED[1], prestige: 0 };
    if (typeof v === 'number') return Object.assign(levelFromTotal(v), { prestige: 0 });
    const L = clamp(Math.round(num(v.level)) || 1, 1, MAX_LV); const need = num(v.xpForNext) > 0 ? num(v.xpForNext) : NEED[L];
    const pr = int(v.prestige);
    if (v.xpInLevel == null && v.xp != null) { const t = levelFromTotal(v.xp); if (t.level === L) return Object.assign(t, { prestige: pr }); }
    return { level: L, xpIn: clamp(num(v.xpInLevel), 0, need), need, prestige: pr };
  }
  let mxResolve = null, mxRaf = 0, mxTimers = [], mxCtl = null;
  function matchXp(o) {
    ensureDom(); o = o || {};
    const rows = (Array.isArray(o.xpBreakdown) ? o.xpBreakdown : []).map(r => ({ label: String((r && r.label) || ''), xp: Math.round(num(r && r.xp)) })).filter(r => r.label).slice(0, 14);
    const sum = rows.reduce((a, r) => a + r.xp, 0);
    const A = lvState(o.before);
    let B = o.after != null ? lvState(o.after) : A.level >= MAX_LV ? { ...A } : (() => { const t = levelFromTotal(CUM[A.level] + A.xpIn + Math.max(0, sum)); return Object.assign(t, { prestige: A.prestige }); })();
    const abs = s => s.prestige * MAX_LV + s.level;
    if (abs(B) < abs(A) || (abs(B) === abs(A) && B.xpIn < A.xpIn)) B = { ...A };
    if (!mxPop) {
      mxPop = document.createElement('div'); mxPop.className = 's9p-pop'; mxPop.id = 's9pMatchXp'; mxPop.setAttribute('role', 'dialog'); mxPop.setAttribute('aria-label', 'Match XP'); mxPop.hidden = true; document.body.appendChild(mxPop);
      mxPop.addEventListener('click', e => { if (e.target.closest('[data-mx-close]')) return closeMatchXp(); if (e.target.closest('[data-mx-profile]')) { closeMatchXp(); return open('overview'); } if (mxCtl && !mxCtl.done) mxCtl.skip(); });
    }
    mxTimers.forEach(clearTimeout); mxTimers = []; cancelAnimationFrame(mxRaf); SFX.chargeStop(); SFX.init();
    mxPop.className = 's9p-pop';
    mxPop.innerHTML = `<div class="s9p-mx"><div class="mflash"></div><div class="hd"><div class="hb">${badgeHTML(rankOf(A.level), stepOf(A.level), "sm")}<div class="fx"><div class="s9p-ring"></div><div class="s9p-parts">${partsHTML(18, 90)}</div></div></div>
        <div><div class="s9p-lab">Match complete</div><h3>XP earned</h3></div><div class="up" id="s9pMxUp" style="margin-left:auto">Level up!</div></div>
      <div class="rows">${rows.map(r => `<div class="xrow"><span>${esc(r.label)}</span><b>+0</b></div>`).join('')}<div class="xrow tot"><span>Total</span><b id="s9pMxTot">+0</b></div></div>
      <div class="lvl"><span>Level<strong class="s9p-roll" id="s9pMxLv"><span>${A.level}</span></strong></span><span id="s9pMxNum">${fmtN(A.xpIn)} / ${fmtN(A.need)} XP</span></div>
      <div class="s9p-xpw"><div class="gl"></div><div class="s9p-xpbar"><i id="s9pMxFill" style="transform:scaleX(${(A.xpIn / (A.need || 1)).toFixed(4)})"></i><b></b></div><div class="head" id="s9pMxHead"></div></div>
      <div class="ft"><span class="hint">Click or Space to skip</span><div>${PROFILE ? '<button class="s9p-ghost" data-mx-profile>View profile</button>' : ''}<button class="s9p-cta" data-mx-close>Continue</button></div></div></div>`;
    mxPop.hidden = false; void mxPop.offsetWidth; mxPop.classList.add('on');
    const $m = s => mxPop.querySelector(s);
    const panel = $m('.s9p-mx'), fill = $m('#s9pMxFill'), head = $m('#s9pMxHead'), wrap = $m('.s9p-xpw'), bar = $m('.s9p-xpbar'), lvEl = $m('#s9pMxLv'), numEl = $m('#s9pMxNum'), totEl = $m('#s9pMxTot'), up = $m('#s9pMxUp'), hb = $m('.hb'), flashEl = $m('.mflash');
    const rowEls = [...mxPop.querySelectorAll('.xrow:not(.tot)')];
    const fast = reduced() || o.fast;
    // ---- schedule (ms)
    const rowDur = fast ? 60 : clamp(2000 / Math.max(1, rows.length), 170, 380), rowGap = fast ? 10 : 70;
    const rowT = rows.map((_, i) => 250 + i * (rowDur + rowGap));
    const barT0 = (rows.length ? rowT[rows.length - 1] + rowDur : 250) + (fast ? 50 : 260);
    const segs = []; for (let a = abs(A); a <= abs(B); a++) { const L = ((a - 1) % MAX_LV) + 1, first = a === abs(A), last = a === abs(B); const need = first ? A.need : last ? B.need : NEED[L]; segs.push({ L, pr: Math.floor((a - 1) / MAX_LV), need, from: first ? A.xpIn : 0, to: last ? B.xpIn : need }); }
    const gained = segs.reduce((x, s) => x + (s.to - s.from), 0);
    const fillTotal = fast ? 300 : clamp(1100 + 650 * (segs.length - 1), 1100, 4200), PAUSE = fast ? 60 : 430;
    let tt = barT0; segs.forEach((s, i) => { s.t0 = tt; s.dur = gained > 0 ? Math.max(fast ? 60 : 420, fillTotal * (s.to - s.from) / gained) : 0; tt += s.dur + (i < segs.length - 1 ? PAUSE : 0); });
    const tEnd = tt + 50;
    let barW = bar.getBoundingClientRect().width || 500;
    const ease = k => 1 - Math.pow(1 - k, 3);
    let lastSeg = 0, lastRowCount = -1, charging = false, done = false, skipping = false;
    // level crossing effects use the Web Animations API: no forced reflows, compositor-only (transform/opacity)
    const partEls = [...hb.querySelectorAll('.fx .s9p-parts i')], ring = hb.querySelector('.fx .s9p-ring');
    const anim = (el, kf, o) => { try { return el.animate(kf, o); } catch (e) { return null; } };
    const setLevel = (s, fx) => {
      const old = lvEl.lastElementChild ? lvEl.lastElementChild.textContent : lvEl.textContent;
      if (fx && old !== String(s.L)) {
        lvEl.innerHTML = `<span>${old}</span><span>${s.L}</span>`;
        for (const sp of lvEl.children) anim(sp, [{ transform: 'translateY(0)' }, { transform: 'translateY(-100%)' }], { duration: 420, easing: 'cubic-bezier(.3,1.5,.5,1)', fill: 'forwards' });
        mxTimers.push(setTimeout(() => { lvEl.innerHTML = `<span>${s.L}</span>`; }, 460));
      } else lvEl.innerHTML = `<span>${s.L}</span>`;
      const bd = hb.querySelector('.s9p-badge'), nr = rankOf(s.L), swap = () => { const img = bd.querySelector('img'); if (+bd.dataset.rank !== nr) { bd.dataset.rank = nr; img.src = badgeSrc(nr, true); } const pp = bd.querySelector('.s9p-pips'); if (pp) pp.outerHTML = pipsHTML(stepOf(s.L)); };
      if (fx) {
        anim(bd, [{ transform: 'perspective(600px) rotateY(0) scale(1)' }, { transform: 'perspective(600px) rotateY(90deg) scale(1.2)', offset: .5 }, { transform: 'perspective(600px) rotateY(0) scale(1)' }], { duration: 620, easing: 'cubic-bezier(.4,0,.2,1)' });
        mxTimers.push(setTimeout(swap, 310));
        anim(flashEl, [{ opacity: 0 }, { opacity: 1, offset: .18 }, { opacity: 0 }], { duration: 600, easing: 'ease-out' });
        if (ring) anim(ring, [{ opacity: 1, transform: 'scale(.4)' }, { opacity: 0, transform: 'scale(2.4)' }], { duration: 700, easing: 'ease-out' });
        for (const p of partEls) { const st = p.style, r = st.getPropertyValue('--r'); anim(p, [{ opacity: 1, transform: `translate(0,0) rotate(${r}) scale(1)` }, { opacity: 1, offset: .7 }, { opacity: 0, transform: `translate(${st.getPropertyValue('--x')},${st.getPropertyValue('--y')}) rotate(${r}) scale(.25)` }], { duration: parseFloat(st.getPropertyValue('--t')) * 1000 || 900, delay: parseFloat(st.getPropertyValue('--dl')) * 1000 || 0, easing: 'cubic-bezier(.15,.7,.3,1)' }); }
      } else swap();
      up.textContent = s.pr > A.prestige ? 'Prestige!' : rankOf(s.L) > rankOf(A.level) ? 'Rank up!' : segs.indexOf(s) > 1 ? `+${segs.indexOf(s)} levels!` : 'Level up!'; up.classList.add('on');
    };
    // only touch the DOM when something visibly changed (every text write costs a layout)
    const tx = (el, v) => { if (el.__t !== v) { el.__t = v; el.textContent = v; } }, sty = (el, v) => { if (el.__s !== v) { el.__s = v; el.style.transform = v; } }, cls = (el, c, on) => { if (el.classList.contains(c) !== on) el.classList.toggle(c, on); };
    function draw(t) {
      // rows
      let total = 0, count = 0;
      rows.forEach((r, i) => { const k = clamp((t - rowT[i]) / rowDur, 0, 1), v = Math.round(r.xp * ease(k)); total += v; const el = rowEls[i]; if (k > 0) { if (!el.classList.contains('in')) { el.classList.add('in'); if (!skipping) SFX.row(i); } count = i + 1; } tx(el.lastChild, (v >= 0 ? '+' : '') + fmtN(v)); cls(el, 'cnt', k > 0 && k < 1); if (k > 0 && k < 1 && !skipping) SFX.tick(i); });
      tx(totEl, (total >= 0 ? '+' : '') + fmtN(total));
      // bar
      let si = 0; while (si < segs.length - 1 && t >= segs[si + 1].t0) si++;
      const s = segs[si], k = s.dur ? clamp((t - s.t0) / s.dur, 0, 1) : 1, x = s.from + (s.to - s.from) * ease(k), frac = clamp(x / (s.need || 1), 0, 1);
      if (si !== lastSeg) { for (let j = lastSeg + 1; j <= si; j++) { if (!skipping) { SFX.chargeStop(); charging = false; SFX.cross(segs[j].L); } setLevel(segs[j], !skipping); } lastSeg = si; }
      sty(fill, `scaleX(${frac.toFixed(3)})`); sty(head, `translateX(${Math.round(frac * barW)}px)`);
      tx(numEl, `${fmtN(x)} / ${fmtN(s.need)} XP`);
      const filling = t >= s.t0 && k < 1 && s.dur > 0;
      cls(wrap, 'charging', filling);
      if (filling && !skipping) { if (!charging) { SFX.chargeStart(); charging = true; } SFX.chargeSet(frac + si * .12); } else if (charging && !filling) { SFX.chargeStop(); charging = false; }
      return count;
    }
    const finish = () => {
      if (done) return; done = true; cancelAnimationFrame(mxRaf); SFX.chargeStop(); charging = false; panel.classList.add('done'); wrap.classList.remove('charging');
      const crossed = segs.length > 1;
      if (crossed && o.popup !== false) mxTimers.push(setTimeout(() => levelUp(A.level, B.level, o.rewards, { prestige: B.prestige, fromPrestige: A.prestige, levels: segs.length - 1, autoClose: o.autoClose }), skipping || fast ? 60 : 480));
      else if (!skipping) SFX.done();
      if (typeof o.onDone === 'function') try { o.onDone({ before: A, after: B, levels: segs.length - 1 }); } catch (e) { console.warn(e); }
    };
    const t0 = performance.now() + 0;
    const cost = []; const loop = now => { const t = now - t0, c0 = performance.now(); draw(t); cost.push(performance.now() - c0); if (t >= tEnd) return finish(); mxRaf = requestAnimationFrame(loop); };
    mxCtl = { cost, get done() { return done; }, skip() { if (done) return; skipping = true; mxTimers.forEach(clearTimeout); mxTimers = []; SFX.chargeStop(); draw(tEnd + 1); lvEl.innerHTML = `<span>${B.level}</span>`; finish(); }, tEnd };
    mxRaf = requestAnimationFrame(loop);
    const ro = () => { barW = bar.getBoundingClientRect().width || barW; }; addEventListener('resize', ro, { passive: true });
    mxCtl.cleanup = () => removeEventListener('resize', ro);
    return new Promise(r => { if (mxResolve) mxResolve(); mxResolve = r; });
  }
  function closeMatchXp() {
    if (!mxPop || mxPop.hidden) return; mxTimers.forEach(clearTimeout); mxTimers = []; cancelAnimationFrame(mxRaf); SFX.chargeStop(); if (mxCtl && mxCtl.cleanup) mxCtl.cleanup(); mxCtl = null;
    mxPop.classList.remove('on'); setTimeout(() => { if (!mxPop.classList.contains('on')) mxPop.hidden = true; }, 260);
    const r = mxResolve; mxResolve = null; if (r) r();
  }

  /* ---------------- keyboard: Esc closes the top-most layer only; Space skips / continues popups ---------------- */
  addEventListener('keydown', e => {
    const esc = e.key === 'Escape' || e.code === 'Escape', space = e.code === 'Space' || e.key === ' ';
    const luOn = luPop && !luPop.hidden && luPop.classList.contains('on'), mxOn = mxPop && !mxPop.hidden && mxPop.classList.contains('on');
    if (space && (luOn || mxOn)) {
      if (luOn) advanceLevelUp(); else if (mxCtl && !mxCtl.done) mxCtl.skip(); else closeMatchXp();
      e.preventDefault(); e.stopImmediatePropagation(); return;
    }
    if (!esc) return;
    if (luOn) closeLevelUp();
    else if (mxOn) closeMatchXp();
    else if (isOpen()) close();
    else return;
    e.preventDefault(); e.stopImmediatePropagation();
  }, true);

  /* ---------------- menu + pause buttons ---------------- */
  function updateButtons() {
    document.querySelectorAll('button.s9p-open').forEach(b => { b.textContent = 'Profile'; if (PROFILE) { const s = document.createElement('b'); s.textContent = 'Lv ' + PROFILE.level; b.appendChild(s); } });
  }
  function injectButtons() {
    const add = (afterId, id) => { const ref = document.getElementById(afterId); if (!ref || document.getElementById(id)) return; const b = document.createElement('button'); b.className = 'ghost s9p-open'; b.id = id; b.type = 'button'; b.addEventListener('click', () => open('overview')); ref.insertAdjacentElement('afterend', b); };
    add('btnArsenal', 'btnProfile'); add('btnArsenal2', 'btnProfile2'); updateButtons();
  }
  // the profile never stays on top of live gameplay: wrap the game's setState (a global function declaration)
  function hookState() {
    try {
      if (typeof window.setState === 'function' && !window.setState.__s9p) {
        const _ss = window.setState;
        const w = function (s) { if (s === 'play' || s === 'dead') { close(); } return _ss.apply(this, arguments); };
        w.__s9p = true; window.setState = w;
      }
    } catch (e) {}
  }
  addEventListener('s9:profile', e => setProfile(e.detail));
  addEventListener('s9:logout', () => setProfile(null));

  const api = { open, close, setProfile, levelUp, matchXp, isOpen, closeLevelUp, closeMatchXp,
    get profile() { return PROFILE; }, _fb(img) { if (/_128.png/.test(img.src)) { img.src = img.src.replace('_128.png', '.png'); return; } const i = +((img.closest('[data-rank]') || {}).dataset || {}).rank || 0; BADGE_OK[i] = false; img.onerror = null; img.src = emblem(i); },
    _emblem: emblem, _sfx: SFX, get _mx() { return mxCtl; }, _levels: { NEED, get CUM() { return CUM; }, RANKS: () => RANKS.slice(), levelFromTotal }, _esc: esc };
  window.S9Profile = api;
  const boot = () => { injectButtons(); hookState(); pullAccount(); updateButtons(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
