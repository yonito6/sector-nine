/* Sector Nine: SHOP + NINE SHARDS (coins). Client side only shows and asks; the game server decides every balance.
   window.S9Shop = { open(tab?), close(), isOpen(), refresh(), matchCoins({breakdown, before, after, missions, reason, title}),
                     showLastMatch(), setToken(t), get balance(), get data(), sfx }
   Server API (economy agent): GET /api/shop · POST /api/shop/buy {itemId, key} · PUT /api/me/equip {slot, itemId}
                               GET /api/me/wallet · GET /api/me/missions          (rules + numbers: data/economy.json)
   Every string from the server or a data file is escaped before it reaches innerHTML. Animations: transform/opacity only. */
(function () {
  'use strict';
  if (window.S9Shop) return;

  /* ================================================================ helpers */
  const esc = v => String(v == null ? '' : v).replace(/[&<>"'`]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
  const num = v => { v = +v; return Number.isFinite(v) ? v : 0; };
  const int = v => Math.round(num(v));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const fmt = v => int(v).toLocaleString('en-US');
  const safeId = v => /^[A-Za-z0-9_-]{1,40}$/.test(String(v)) ? String(v) : '';
  const safeCol = (v, d) => /^#[0-9a-fA-F]{3,8}$/.test(String(v)) ? String(v) : d;
  const PATTERNS = ['brushed', 'camo', 'plain', 'worn', 'circuit', 'stripes', 'waves', 'cracks', 'crystal', 'scales', 'swirl', 'engraved'];
  const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } };
  const ICON = 'assets/ui/shop/shard.png', ICON_PNG = ICON;   // 256 px PNG (shard.svg is the source art; some static hosts send .svg with the wrong type)
  const shardImg = (cls = '') => `<img class="s9sh-ico ${cls}" src="${ICON}" alt="" draggable="false">`;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const randKey = () => { const a = new Uint8Array(18); (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach((_, i) => { a[i] = Math.random() * 256; }); return 'k' + Array.from(a, b => (b % 36).toString(36)).join(''); };
  function countdown(ms) {
    ms = Math.max(0, ms); const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    const p = n => String(n).padStart(2, '0');
    return d ? `${d}d ${p(h)}h ${p(m)}m` : `${p(h)}:${p(m)}:${p(x)}`;
  }

  /* ================================================================ config (data/economy.json) + the same rotation maths as the server */
  let ECFG = null;
  const cfgReady = fetch('data/economy.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(j => { if (j && Array.isArray(j.items)) ECFG = j; }).catch(() => {});
  const CUR = () => (SHOP && SHOP.currency) || (ECFG && ECFG.currency) || { name: 'Nine Shards', short: 'Shards' };
  const RAR = () => (SHOP && SHOP.rarities) || (ECFG && ECFG.rarities) || [];
  const rarity = id => RAR().find(r => r.id === id) || { id, name: String(id || ''), color: '#b8c0cc' };
  const rarOrder = id => Math.max(0, RAR().findIndex(r => r.id === id));
  const WEAPON_NAME = { carbine: 'K-7 Carbine', wasp: 'V-9 Wasp', breacher: 'Breacher', helix: 'Helix', sniper: 'R-90 Longbow', nova: 'Nova', pistol: 'M-2 Pulse Pistol', arc: 'Arc Thrower', boomerang: 'Vortex', cryo: 'Cryo Lancer', inferno: 'Inferno', judge: 'Judge', ricochet: 'Ricochet', seeker: 'Seeker', stinger: 'Stinger', titan: 'Titan', triad: 'Triad', void: 'Void Lance' };
  function gunName(g) { if (g === 'all') return 'Every gun'; try { const W = (window.__s9 && window.__s9.WEAPONS) || null; if (W && W[g] && W[g].name) return String(W[g].name); } catch (e) {} return WEAPON_NAME[g] || String(g || ''); }

  // offline fallback: build the shop locally from data/economy.json (identical maths to economy/rules.js)
  function hash32(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
  function rng(seed) { let a = hash32(String(seed)); return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const DAY = 86400000, dayKey = ms => new Date(ms).toISOString().slice(0, 10), weekIdx = ms => Math.floor((Math.floor(ms / DAY) + 3) / 7);
  function localShop(now) {
    const C = ECFG; if (!C) return null;
    const RI = {}; C.rarities.forEach((r, i) => { RI[r.id] = Object.assign({ order: i }, r); });
    const ITEMS = new Map(C.items.map(it => [it.id, it]));
    const r50 = v => Math.max(50, Math.round(v / 50) * 50);
    const base = it => !it || it.default ? 0 : it.type === 'bundle' ? it.contains.reduce((s, id) => s + base(ITEMS.get(id)), 0) : Number.isFinite(it.price) ? it.price : r50(RI[it.rarity].price * (C.typePriceMultiplier[it.type] || 1) * (it.gun === 'all' ? C.collectionPriceMultiplier || 1 : 1));
    const minL = it => !it ? 1 : it.type === 'bundle' ? Math.max(1, ...it.contains.map(id => minL(ITEMS.get(id)))) : Math.max(it.minLevel || 1, (RI[it.rarity] || {}).minLevel || 1);
    const ownable = it => it && !it.default && !it.comingSoon;
    const pick = (pool, n, r, guard) => { pool = pool.slice(); const out = []; while (out.length < n && pool.length) { const w = pool.map(it => C.shop.rotationWeights[it.rarity] || 1); let t = r() * w.reduce((a, b) => a + b, 0), i = 0; while (i < pool.length - 1 && (t -= w[i]) > 0) i++; out.push(pool.splice(i, 1)[0]); } if (guard && !out.some(guard)) { const b = pool.filter(guard); if (b.length) out[out.length - 1] = b[Math.floor(r() * b.length)]; } return out; };
    const singles = C.items.filter(it => ownable(it) && it.type !== 'bundle'), rot = singles.filter(it => !it.permanent);
    const wk = 'W' + weekIdx(now), weekly = (() => { const n = C.shop.weeklySet, ids = rot.map(it => it.id); if (!ids.length) return []; const wi = weekIdx(now), len = Math.max(1, Math.ceil(ids.length / n)), r = rng('s9-cycle-' + Math.floor(wi / len)), perm = ids.slice().sort();
      for (let i = perm.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
      const out = perm.slice((wi % len) * n, (wi % len) * n + n); for (let i = 0; out.length < Math.min(n, perm.length); i++) if (!out.includes(perm[i])) out.push(perm[i]); return out; })();
    const bundles = C.items.filter(it => it.type === 'bundle' && !it.permanent), wb = bundles.length ? [bundles[weekIdx(now) % bundles.length].id] : [];
    const featured = pick(singles.filter(it => !weekly.includes(it.id)), C.shop.dailyFeatured, rng('s9-day-' + dayKey(now)), it => RI[it.rarity].order >= RI.epic.order).map(it => it.id);
    const rotation = { day: dayKey(now), week: wk, featured, weekly, bundles: wb, deal: featured[0] || null, nextDailyAt: (Math.floor(now / DAY) + 1) * DAY, nextWeeklyAt: ((weekIdx(now) + 1) * 7 - 3) * DAY };
    const avail = it => ownable(it) && (it.permanent || (it.type === 'bundle' ? wb.includes(it.id) : featured.includes(it.id) || weekly.includes(it.id)));
    const items = C.items.map(it => { const o = Object.assign({}, it, { price: base(it), minLevel: minL(it), available: it.default ? true : avail(it), owned: !!it.default, equipped: !!it.default });
      o.priceNow = it.type === 'bundle' ? r50(base(it) * (1 - (it.discount || 0))) : rotation.deal === it.id ? r50(base(it) * (1 - C.shop.dealOfTheDay)) : base(it); if (rotation.deal === it.id) o.deal = C.shop.dealOfTheDay; return o; });
    return { now, currency: C.currency, rarities: C.rarities, rotation, items, signedIn: false, offline: true, local: true, wallet: null, level: null, equipped: {}, earn: { shopUnlockMatches: C.earn.shopUnlockMatches, typicalMatch: C.earn.typicalMatch } };
  }

  /* ================================================================ server */
  let TOKEN_OVERRIDE = null;
  function apiBase() {
    if (api.apiBase) return String(api.apiBase).replace(/\/+$/, '');
    try { const q = new URLSearchParams(location.search).get('api'); if (q) return q.replace(/\/+$/, ''); } catch (e) {}
    const A = window.S9Account; if (A && typeof A.base === 'string' && A.base) return A.base.replace(/\/+$/, '');
    let s = null; try { s = new URLSearchParams(location.search).get('srv'); } catch (e) {}
    s = s || 'wss://sector-nine-server-production.up.railway.app';
    try { const u = new URL(s); u.protocol = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol; return u.origin; } catch (e) { return 'https://sector-nine-server-production.up.railway.app'; }
  }
  function token() {
    if (TOKEN_OVERRIDE !== null) return TOKEN_OVERRIDE || null;
    const A = window.S9Account;
    try { if (A) { const t = typeof A.token === 'function' ? A.token() : A.token; if (typeof t === 'string' && t) return t; } } catch (e) {}
    return null;
  }
  async function req(method, path, body) {
    const h = { accept: 'application/json' }, t = token();
    if (t) h.authorization = 'Bearer ' + t;
    if (body !== undefined) h['content-type'] = 'application/json';
    const ctl = typeof AbortController === 'function' ? new AbortController() : null, to = setTimeout(() => ctl && ctl.abort(), 12000);
    try {
      const r = await fetch(apiBase() + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, mode: 'cors', credentials: 'omit', cache: 'no-store', signal: ctl ? ctl.signal : undefined });
      let j = null; try { j = await r.json(); } catch (e) {}
      return { s: r.status, j: j && typeof j === 'object' ? j : {} };
    } catch (e) { return { s: 0, j: { error: "Can't reach the server. Check your connection." } }; }
    finally { clearTimeout(to); }
  }

  /* ================================================================ state */
  let SHOP = null, MISSIONS = null, loading = null, lastErr = null;
  const view = { tab: 'featured', type: 'all', rar: 'all' };
  const signedIn = () => !!(SHOP && SHOP.signedIn && SHOP.wallet);
  const wallet = () => (SHOP && SHOP.wallet) || null;
  const itemById = id => SHOP && SHOP.items.find(i => i.id === id);

  async function load() {
    if (loading) return loading;
    loading = (async () => {
      await cfgReady;
      const r = await req('GET', '/api/shop');
      if (r.s === 200 && r.j && Array.isArray(r.j.items)) { SHOP = r.j; lastErr = null; }
      else { const L = localShop(Date.now()); if (L) SHOP = L; lastErr = r.s === 0 ? 'offline' : (r.j && r.j.error) || 'error'; }
      MISSIONS = null;
      if (signedIn()) { const m = await req('GET', '/api/me/missions'); if (m.s === 200 && Array.isArray(m.j.list)) MISSIONS = m.j; }
      updateButtons();
      return SHOP;
    })();
    try { return await loading; } finally { loading = null; }
  }

  /* ================================================================ styles */
  const CSS = `
.s9sh{position:fixed;inset:0;z-index:60;display:flex;flex-direction:column;background:radial-gradient(1200px 600px at 85% -10%,rgba(127,231,255,.10),transparent 60%),radial-gradient(900px 500px at -10% 110%,rgba(180,92,255,.12),transparent 60%),rgba(8,10,14,.97);color:var(--ink,#ece6d8);font-family:var(--mono,"IBM Plex Mono",Consolas,monospace);opacity:0;transition:opacity .18s}
.s9sh.on{opacity:1}.s9sh[hidden]{display:none}
.s9sh *{box-sizing:border-box}
.s9sh-top{display:flex;align-items:center;gap:18px;padding:16px clamp(16px,3vw,40px) 12px;border-bottom:1px solid rgba(236,230,216,.12);flex-wrap:wrap}
.s9sh-title{font-family:var(--display,Impact,sans-serif);font-weight:900;font-size:clamp(34px,4vw,52px);line-height:.85;letter-spacing:.03em;text-transform:uppercase;margin:0;background:linear-gradient(100deg,#fff 0%,#9ef3ff 45%,#b9a8ff 100%);-webkit-background-clip:text;background-clip:text;color:transparent}
.s9sh-tabs{display:flex;gap:4px;flex:1;min-width:0}
.s9sh-tab{font:600 12px/1 var(--mono,monospace);letter-spacing:.16em;text-transform:uppercase;color:#8b9097;background:none;border:0;border-bottom:2px solid transparent;padding:12px 12px 10px;cursor:pointer;white-space:nowrap}
.s9sh-tab[aria-selected=true]{color:#fff;border-bottom-color:#7fe7ff}
.s9sh-tab:hover{color:#ece6d8}.s9sh-tab:focus-visible,.s9sh button:focus-visible{outline:2px solid #7fe7ff;outline-offset:2px}
.s9sh-tab .dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#ff9a3c;margin-left:6px;vertical-align:1px}
.s9sh-wallet{display:flex;align-items:center;gap:10px;padding:8px 14px 8px 10px;border:1px solid rgba(127,231,255,.35);background:linear-gradient(180deg,rgba(127,231,255,.10),rgba(127,231,255,.02));clip-path:polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px)}
.s9sh-wallet .s9sh-ico{width:30px;height:30px;filter:drop-shadow(0 0 8px rgba(127,231,255,.6))}
.s9sh-wallet b{font:900 26px/1 var(--display,Impact,sans-serif);letter-spacing:.02em;font-variant-numeric:tabular-nums;color:#fff}
.s9sh-wallet small{display:block;font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#8b9097;margin-top:2px}
.s9sh-wallet button{font:600 11px/1 var(--mono,monospace);letter-spacing:.14em;text-transform:uppercase;background:#7fe7ff;color:#071016;border:0;padding:8px 10px;cursor:pointer}
.s9sh-x{width:42px;height:42px;border:1px solid rgba(236,230,216,.2);background:none;color:#ece6d8;font-size:20px;cursor:pointer;flex:none}
.s9sh-x:hover{border-color:#ece6d8}
.s9sh-note{margin:12px clamp(16px,3vw,40px) 0;padding:10px 14px;border-left:3px solid #ff9a3c;background:rgba(255,154,60,.08);font-size:13px;line-height:1.5;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.s9sh-note.info{border-color:#7fe7ff;background:rgba(127,231,255,.07)}
.s9sh-note button{font:600 11px/1 var(--mono,monospace);letter-spacing:.14em;text-transform:uppercase;background:#ff9a3c;color:#140d06;border:0;padding:9px 12px;cursor:pointer}
.s9sh-body{flex:1;overflow-y:auto;overflow-x:hidden;padding:8px clamp(16px,3vw,40px) 40px;scrollbar-width:thin}
.s9sh-sec{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin:22px 0 12px}
.s9sh-sec h3{font:900 clamp(22px,2.4vw,30px)/1 var(--display,Impact,sans-serif);letter-spacing:.04em;text-transform:uppercase;margin:0}
.s9sh-sec .t{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#7fe7ff}
.s9sh-sec .t b{font-variant-numeric:tabular-nums;color:#fff}
.s9sh-sec .h{font-size:12px;color:#8b9097}
.s9sh-grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(176px,1fr))}
.s9sh-grid.wk{grid-template-columns:repeat(auto-fit,minmax(176px,1fr))}
.s9sh-grid.big{grid-template-columns:repeat(4,minmax(0,1fr))}
@media (max-width:900px){.s9sh-grid.big{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:560px){.s9sh-grid,.s9sh-grid.big{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}}
.s9sh-card{--rc:#b8c0cc;position:relative;display:flex;flex-direction:column;text-align:left;color:inherit;font:inherit;padding:0;cursor:pointer;min-width:0;
  background:linear-gradient(180deg,color-mix(in srgb,var(--rc) 16%,#11141b),#0d1015 70%);border:1px solid color-mix(in srgb,var(--rc) 45%,transparent);
  box-shadow:inset 0 0 36px color-mix(in srgb,var(--rc) 12%,transparent);clip-path:polygon(0 0,100% 0,100% calc(100% - 16px),calc(100% - 16px) 100%,0 100%);transition:transform .16s,box-shadow .16s;overflow:hidden}
.s9sh-card:hover{transform:translateY(-3px);box-shadow:inset 0 0 50px color-mix(in srgb,var(--rc) 24%,transparent),0 0 0 1px var(--rc)}
.s9sh-card::before{content:"";position:absolute;left:0;right:0;top:0;height:3px;background:var(--rc);box-shadow:0 0 14px var(--rc);z-index:2}
.s9sh-card.r-legendary::after,.s9sh-card.r-mythic::after{content:"";position:absolute;top:-20%;bottom:-20%;left:0;width:40%;background:linear-gradient(100deg,transparent,rgba(255,255,255,.14),transparent);transform:translateX(-120%) skewX(-12deg);animation:s9shSheen 3.6s ease-in-out infinite;pointer-events:none;z-index:3}
.s9sh-card.r-mythic{background:linear-gradient(160deg,color-mix(in srgb,var(--rc) 22%,#120d18),#0d0b12 60%,color-mix(in srgb,#7fe7ff 10%,#0d0b12))}
@keyframes s9shSheen{0%,55%{transform:translateX(-120%) skewX(-12deg)}100%{transform:translateX(320%) skewX(-12deg)}}
.s9sh-art{position:relative;aspect-ratio:4/3;display:grid;place-items:center;overflow:hidden;background:radial-gradient(closest-side at 50% 60%,color-mix(in srgb,var(--rc) 30%,transparent),transparent)}
.s9sh-grid.big .s9sh-art{aspect-ratio:1/1}
.s9sh-art svg.sol{height:88%;width:auto;filter:drop-shadow(0 6px 10px rgba(0,0,0,.6))}
.s9sh-th{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;opacity:0;transition:opacity .25s;pointer-events:none}
.s9sh-th.on{opacity:1}.s9sh-art:has(.s9sh-th.on) > svg.sol,.s9sh-art:has(.s9sh-th.on) > .s9sh-gun{visibility:hidden}
.s9sh-gun{position:relative;width:88%;aspect-ratio:2/1}
.s9sh-gun img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;filter:drop-shadow(0 6px 8px rgba(0,0,0,.55))}
.s9sh-gun i{position:absolute;inset:0;-webkit-mask:var(--m) center/contain no-repeat;mask:var(--m) center/contain no-repeat}
.s9sh-gun .tint{background:linear-gradient(115deg,var(--c1),var(--c2));mix-blend-mode:color;opacity:.95}
.s9sh-gun .pat{mix-blend-mode:overlay;opacity:.85}
.s9sh-gun .glow{background:radial-gradient(closest-side,var(--gl),transparent);mix-blend-mode:screen;opacity:.35}
.p-brushed{background:repeating-linear-gradient(90deg,rgba(255,255,255,.18) 0 1px,transparent 1px 4px)}
.p-camo{background:radial-gradient(circle at 20% 30%,var(--c2) 0 9%,transparent 10%),radial-gradient(circle at 60% 60%,var(--c2) 0 12%,transparent 13%),radial-gradient(circle at 80% 25%,var(--c1) 0 8%,transparent 9%),radial-gradient(circle at 40% 80%,var(--c1) 0 10%,transparent 11%);background-size:60px 40px}
.p-worn{background:radial-gradient(circle at 30% 40%,rgba(0,0,0,.6) 0 3px,transparent 4px),radial-gradient(circle at 70% 70%,rgba(255,255,255,.25) 0 2px,transparent 3px);background-size:17px 13px}
.p-circuit{background:repeating-linear-gradient(0deg,transparent 0 9px,var(--gl) 9px 10px),repeating-linear-gradient(90deg,transparent 0 23px,var(--gl) 23px 24px)}
.p-stripes{background:repeating-linear-gradient(55deg,var(--c2) 0 7px,transparent 7px 16px)}
.p-waves{background:repeating-radial-gradient(circle at 0 100%,transparent 0 8px,rgba(255,255,255,.35) 8px 10px)}
.p-cracks{background:repeating-linear-gradient(35deg,transparent 0 13px,var(--gl) 13px 14px),repeating-linear-gradient(-50deg,transparent 0 19px,var(--gl) 19px 20px)}
.p-crystal{background:conic-gradient(from 30deg at 40% 50%,rgba(255,255,255,.5),transparent 20%,rgba(255,255,255,.35) 40%,transparent 60%,rgba(255,255,255,.45) 80%,transparent)}
.p-scales{background:radial-gradient(circle at 50% 0,transparent 0 5px,rgba(0,0,0,.55) 5px 6px,transparent 7px);background-size:12px 8px}
.p-swirl{background:conic-gradient(from 0deg at 55% 50%,var(--c2),var(--gl),var(--c1),var(--gl),var(--c2))}
.p-engraved{background:repeating-linear-gradient(60deg,transparent 0 5px,rgba(255,240,180,.45) 5px 6px),repeating-linear-gradient(-60deg,transparent 0 5px,rgba(255,240,180,.3) 5px 6px)}
.s9sh-bundle{position:relative;width:100%;height:100%}
.s9sh-bundle svg.sol{position:absolute;left:4%;bottom:4%;height:88%}
.s9sh-bundle .s9sh-gun{position:absolute;width:62%;right:2%}
.s9sh-bundle .s9sh-gun:nth-of-type(1){top:10%}.s9sh-bundle .s9sh-gun:nth-of-type(2){bottom:8%}
.s9sh-meta{padding:10px 12px 4px;display:flex;flex-direction:column;gap:3px;min-width:0}
.s9sh-rar{font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--rc);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.s9sh-nm{font:900 clamp(19px,1.6vw,23px)/1 var(--display,Impact,sans-serif);letter-spacing:.03em;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.s9sh-sub{font-size:11px;color:#8b9097;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.s9sh-price{display:flex;align-items:center;gap:6px;padding:6px 12px 12px;margin-top:auto;font:900 21px/1 var(--display,Impact,sans-serif);letter-spacing:.02em;font-variant-numeric:tabular-nums;flex-wrap:wrap}
.s9sh-price .s9sh-ico{width:20px;height:20px}
.s9sh-price s{font:400 12px/1 var(--mono,monospace);color:#8b9097}
.s9sh-price .own{font:600 11px/1 var(--mono,monospace);letter-spacing:.16em;text-transform:uppercase;color:#6dffb0}
.s9sh-badges{position:absolute;top:10px;left:10px;right:10px;display:flex;gap:6px;flex-wrap:wrap;z-index:4;pointer-events:none}
.s9sh-b{font:600 10px/1 var(--mono,monospace);letter-spacing:.14em;text-transform:uppercase;padding:5px 7px;background:rgba(8,10,14,.82);border:1px solid rgba(236,230,216,.25)}
.s9sh-b.own{color:#6dffb0;border-color:rgba(109,255,176,.5)}.s9sh-b.eq{color:#071016;background:#6dffb0;border-color:#6dffb0}
.s9sh-b.lock{color:#ffcf8a;border-color:rgba(255,154,60,.6)}.s9sh-b.deal{color:#140d06;background:#ff9a3c;border-color:#ff9a3c;margin-left:auto}
.s9sh-b.na{color:#b9c0c8}.s9sh-b.new{color:#071016;background:#7fe7ff;border-color:#7fe7ff}
.s9sh-card.na .s9sh-art,.s9sh-card.cs .s9sh-art{opacity:.45;filter:saturate(.4)}
.s9sh-card.lk .s9sh-price{opacity:.6}
.s9sh-filters{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0 6px}
.s9sh-chip{font:600 11px/1 var(--mono,monospace);letter-spacing:.14em;text-transform:uppercase;color:#c9c3b6;background:rgba(236,230,216,.04);border:1px solid rgba(236,230,216,.18);padding:9px 12px;cursor:pointer}
.s9sh-chip[aria-pressed=true]{color:#071016;background:var(--cc,#7fe7ff);border-color:var(--cc,#7fe7ff)}
.s9sh-chip .sw{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--cc);margin-right:6px;vertical-align:0}
.s9sh-chip[aria-pressed=true] .sw{background:#071016}
.s9sh-sep{width:1px;background:rgba(236,230,216,.15);margin:0 4px}
.s9sh-empty{padding:40px 0;color:#8b9097;text-align:center}
.s9sh-ms{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr))}
.s9sh-m{padding:14px 16px;border:1px solid rgba(236,230,216,.14);background:rgba(236,230,216,.03);display:flex;flex-direction:column;gap:10px}
.s9sh-m.done{border-color:rgba(109,255,176,.45);background:rgba(109,255,176,.05)}
.s9sh-m .k{font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#7fe7ff}
.s9sh-m .k.hard{color:#ff9a3c}.s9sh-m .k.medium{color:#b9a8ff}
.s9sh-m b{font:900 22px/1.05 var(--display,Impact,sans-serif);letter-spacing:.03em;text-transform:uppercase}
.s9sh-m .row{display:flex;align-items:center;gap:10px;font-size:12px;color:#c9c3b6;font-variant-numeric:tabular-nums}
.s9sh-m .rw{margin-left:auto;display:flex;align-items:center;gap:5px;font:900 18px/1 var(--display,Impact,sans-serif);color:#fff}
.s9sh-m .rw .s9sh-ico{width:16px;height:16px}
.s9sh-bar{position:relative;height:8px;background:rgba(236,230,216,.1);overflow:hidden;flex:1}
.s9sh-bar i{position:absolute;inset:0;transform-origin:0 50%;background:linear-gradient(90deg,#3d9bff,#7fe7ff);box-shadow:0 0 10px rgba(127,231,255,.6)}
.s9sh-m.done .s9sh-bar i{background:linear-gradient(90deg,#2fd27a,#6dffb0)}
.s9sh-earn{display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(min(100%,220px),1fr));font-size:12px}
.s9sh-earn div{display:flex;justify-content:space-between;gap:10px;padding:9px 12px;background:rgba(236,230,216,.03);border-left:2px solid rgba(127,231,255,.4)}
.s9sh-earn b{color:#fff;font-variant-numeric:tabular-nums;white-space:nowrap}
.s9sh-p{font-size:13px;line-height:1.6;color:#c9c3b6;max-width:760px}
/* detail dialog */
.s9sh-dlg{position:fixed;inset:0;z-index:61;display:grid;place-items:center;background:rgba(4,5,8,.72);opacity:0;transition:opacity .16s;padding:16px}
.s9sh-dlg.on{opacity:1}.s9sh-dlg[hidden]{display:none}
.s9sh-dbox{--rc:#b8c0cc;position:relative;width:min(880px,100%);max-height:calc(100vh - 32px);overflow:auto;display:grid;grid-template-columns:1.1fr 1fr;background:#0d1015;border:1px solid color-mix(in srgb,var(--rc) 50%,transparent);box-shadow:0 30px 80px rgba(0,0,0,.6),inset 0 0 80px color-mix(in srgb,var(--rc) 10%,transparent);clip-path:polygon(0 0,100% 0,100% calc(100% - 20px),calc(100% - 20px) 100%,0 100%);transform:translateY(10px) scale(.98);transition:transform .2s}
.s9sh-dlg.on .s9sh-dbox{transform:none}
.s9sh-dbox::before{content:"";position:absolute;left:0;right:0;top:0;height:3px;background:var(--rc);box-shadow:0 0 18px var(--rc)}
.s9sh-dart{position:relative;min-height:320px;display:grid;place-items:center;background:radial-gradient(closest-side at 50% 58%,color-mix(in srgb,var(--rc) 34%,transparent),transparent),linear-gradient(180deg,#141822,#0b0d12)}
.s9sh-dart .s9sh-art{width:100%;height:100%;aspect-ratio:auto;background:none}
.s9sh-dart .live{position:absolute;inset:0}.s9sh-dart .live canvas{width:100%;height:100%;display:block}
.s9sh-dinfo{padding:26px 24px 22px;display:flex;flex-direction:column;gap:12px;min-width:0}
.s9sh-dinfo h2{font:900 clamp(34px,4vw,48px)/.9 var(--display,Impact,sans-serif);letter-spacing:.02em;text-transform:uppercase;margin:0;overflow-wrap:anywhere}
.s9sh-dinfo p{margin:0;font-size:13px;line-height:1.55;color:#c9c3b6}
.s9sh-list{display:flex;flex-direction:column;gap:6px;font-size:12px}
.s9sh-list div{display:flex;justify-content:space-between;gap:10px;padding:7px 10px;background:rgba(236,230,216,.04)}
.s9sh-list .ok{color:#6dffb0}
.s9sh-dprice{display:flex;align-items:center;gap:10px;font:900 34px/1 var(--display,Impact,sans-serif);font-variant-numeric:tabular-nums;margin-top:auto;flex-wrap:wrap}
.s9sh-dprice .s9sh-ico{width:30px;height:30px}
.s9sh-dprice s{font:400 14px/1 var(--mono,monospace);color:#8b9097}
.s9sh-acts{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.s9sh-buy{font:900 22px/1 var(--display,Impact,sans-serif);letter-spacing:.08em;text-transform:uppercase;color:#071016;background:linear-gradient(180deg,#9ef3ff,#5ad8ff);border:0;padding:14px 26px 12px;cursor:pointer;clip-path:polygon(0 0,100% 0,100% 70%,calc(100% - 12px) 100%,0 100%);display:inline-flex;gap:10px;align-items:center}
.s9sh-buy:hover{filter:brightness(1.1)}.s9sh-buy[disabled]{background:#2a2f38;color:#8b9097;cursor:not-allowed;filter:none}
.s9sh-buy .s9sh-ico{width:22px;height:22px}
.s9sh-buy.eq{background:linear-gradient(180deg,#a5ffd0,#45e597)}
.s9sh-buy.conf{background:linear-gradient(180deg,#ffd08a,#ff9a3c);color:#140d06}
.s9sh-pick{display:flex;align-items:center;gap:8px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#8b9097}.s9sh-pick select{background:#0b0d10;color:#ece6d8;border:1px solid rgba(236,230,216,.25);font:12px var(--mono,monospace);padding:10px 8px;letter-spacing:0;text-transform:none}
.s9sh-ghost{font:600 12px/1 var(--mono,monospace);letter-spacing:.14em;text-transform:uppercase;color:#ece6d8;background:none;border:1px solid rgba(236,230,216,.25);padding:13px 16px;cursor:pointer}
.s9sh-msg{font-size:13px;line-height:1.5;color:#c9c3b6;min-height:20px}
.s9sh-msg.err{color:#ff8a7a}.s9sh-msg.ok{color:#6dffb0}.s9sh-msg b{color:#fff}
.s9sh-dx{position:absolute;top:10px;right:10px;z-index:3}
.s9sh-burst{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.s9sh-burst i{position:absolute;left:50%;top:50%;width:10px;height:10px;margin:-5px;background:var(--rc);clip-path:polygon(50% 0,100% 50%,50% 100%,0 50%)}
@media (max-width:720px){.s9sh-dbox{grid-template-columns:1fr;max-height:calc(100vh - 20px)}.s9sh-dart{min-height:220px}.s9sh-dlg{padding:10px}}
@media (max-width:560px){.s9sh-top{gap:10px;padding-top:12px}.s9sh-tabs{order:3;flex-basis:100%;overflow-x:auto}.s9sh-wallet{margin-left:auto}.s9sh-wallet b{font-size:22px}.s9sh-title{font-size:34px}}
button.s9sh-open b{font:900 15px/1 var(--display,Impact,sans-serif);letter-spacing:.04em;margin-left:8px;color:#9ef3ff}
button.s9sh-open img{width:15px;height:15px;vertical-align:-3px;margin-left:8px}
/* ===== end-of-match coins ===== */
.s9c{position:fixed;inset:0;z-index:70;display:grid;place-items:center;padding:16px;background:radial-gradient(800px 500px at 50% 40%,rgba(127,231,255,.10),transparent 70%),rgba(4,5,8,.8);opacity:0;transition:opacity .2s;font-family:var(--mono,"IBM Plex Mono",Consolas,monospace);color:#ece6d8;cursor:pointer;user-select:none}
.s9c.on{opacity:1}
.s9c *{box-sizing:border-box}
.s9c-card{position:relative;width:min(560px,100%);max-height:calc(100vh - 32px);overflow:hidden;display:flex;flex-direction:column;background:radial-gradient(120% 60% at 50% 0,rgba(127,231,255,.07),transparent 70%),linear-gradient(180deg,#121621,#0b0d12);border:1px solid rgba(127,231,255,.35);contain:layout paint;clip-path:polygon(0 0,100% 0,100% calc(100% - 22px),calc(100% - 22px) 100%,0 100%);transform:translateY(16px) scale(.97);transition:transform .32s cubic-bezier(.2,1.4,.4,1)}
.s9c.on .s9c-card{transform:none}
.s9c-card::before{content:"";position:absolute;left:0;right:0;top:0;height:3px;background:linear-gradient(90deg,#3d9bff,#7fe7ff,#b45cff);box-shadow:0 0 18px #7fe7ff}
.s9c-head{display:flex;align-items:flex-start;gap:12px;padding:20px 22px 12px}
.s9c-head .k{font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#7fe7ff}
.s9c-head h2{font:900 clamp(32px,6vw,44px)/.9 var(--display,Impact,sans-serif);letter-spacing:.03em;text-transform:uppercase;margin:4px 0 0}
.s9c-wal{margin-left:auto;display:flex;align-items:center;gap:8px;padding:8px 12px 8px 8px;border:1px solid rgba(127,231,255,.35);background:rgba(127,231,255,.06);will-change:transform}
.s9c-wal img{width:26px;height:26px;filter:drop-shadow(0 0 8px rgba(127,231,255,.7))}
.s9c-wal b{font:900 22px/1 var(--display,Impact,sans-serif);font-variant-numeric:tabular-nums;min-width:3ch;text-align:right;will-change:transform}
.s9c-lines{padding:4px 22px 6px;display:flex;flex-direction:column;gap:4px;overflow:hidden}
.s9c-ln{display:flex;align-items:center;gap:10px;padding:7px 10px;background:rgba(236,230,216,.035);opacity:0;transform:translateX(-14px);transition:opacity .18s,transform .22s cubic-bezier(.2,1.3,.4,1);font-size:13px;contain:layout paint}
.s9c-ln.on{opacity:1;transform:none}
.s9c-ln .lb{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.s9c-ln .am{font:900 20px/1 var(--display,Impact,sans-serif);font-variant-numeric:tabular-nums;color:#9ef3ff;white-space:nowrap;will-change:transform}
.s9c-ln.bonus{background:linear-gradient(90deg,rgba(255,176,46,.16),rgba(255,176,46,.03));border-left:2px solid #ffb02e}
.s9c-ln.bonus .am{color:#ffd27a}.s9c-ln.bonus .tag{font-size:9px;letter-spacing:.18em;color:#140d06;background:#ffb02e;padding:3px 5px}
.s9c-ln.lucky{background:linear-gradient(90deg,rgba(255,61,110,.2),rgba(180,92,255,.08));border-left:2px solid #ff3d6e}.s9c-ln.lucky .am{color:#ff9ab6}.s9c-ln.lucky .tag{background:#ff3d6e;color:#fff}
.s9c-ln.neg .am{color:#ff8a7a}.s9c-ln.neg{color:#b9a9a6}
.s9c-ln.none{justify-content:center;color:#8b9097}
.s9c-ln.done .am{animation:s9cPop .26s ease-out}
@keyframes s9cPop{0%{transform:scale(1.35)}100%{transform:scale(1)}}
.s9c-tot{position:relative;display:flex;align-items:center;gap:12px;margin:8px 22px 4px;padding:14px 16px;border-top:1px solid rgba(236,230,216,.14)}
.s9c-tot span{font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#8b9097}
.s9c-tot .v{margin-left:auto;display:flex;align-items:center;gap:10px;will-change:transform;contain:layout paint}
.s9c-tot .v img{width:38px;height:38px;filter:drop-shadow(0 0 12px rgba(127,231,255,.8))}
.s9c-tot .v b{font:900 clamp(40px,8vw,58px)/.9 var(--display,Impact,sans-serif);font-variant-numeric:tabular-nums;background:linear-gradient(180deg,#fff,#9ef3ff 60%,#b9a8ff);-webkit-background-clip:text;background-clip:text;color:transparent;white-space:nowrap}
.s9c-ms{padding:2px 22px 8px;display:flex;flex-direction:column;gap:7px}
.s9c-m{display:grid;grid-template-columns:1fr auto;gap:5px 10px;font-size:11px;align-items:center;opacity:0;transition:opacity .2s}
.s9c-m.on{opacity:1}
.s9c-m .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#c9c3b6}
.s9c-m .n{font-variant-numeric:tabular-nums;color:#8b9097}
.s9c-m .s9sh-bar{grid-column:1/3;height:6px}
.s9c-m .st{grid-column:1/3;justify-self:start;white-space:nowrap;font:900 13px/1 var(--display,Impact,sans-serif);letter-spacing:.12em;color:#071016;background:#6dffb0;padding:4px 7px;transform:scale(0);transition:transform .3s cubic-bezier(.2,1.6,.4,1)}
.s9c-m .st.on{transform:scale(1)}
.s9c-foot{padding:10px 22px 18px;display:flex;align-items:center;gap:12px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#8b9097}
.s9c-foot button{margin-left:auto;font:900 18px/1 var(--display,Impact,sans-serif);letter-spacing:.1em;text-transform:uppercase;background:#ff9a3c;color:#140d06;border:0;padding:12px 22px 10px;cursor:pointer;clip-path:polygon(0 0,100% 0,100% 70%,calc(100% - 10px) 100%,0 100%);opacity:0;transform:translateY(6px);transition:opacity .2s,transform .2s;pointer-events:none}
.s9c-foot button.on{opacity:1;transform:none;pointer-events:auto}
.s9c-fly{position:fixed;left:0;top:0;width:22px;height:22px;z-index:71;pointer-events:none;will-change:transform,opacity}
.s9c-pt{position:fixed;left:0;top:0;width:8px;height:8px;z-index:71;pointer-events:none;will-change:transform,opacity;border-radius:1px}
@media (max-width:420px){.s9c-head{padding:16px 16px 10px}.s9c-lines,.s9c-ms{padding-left:16px;padding-right:16px}.s9c-tot{margin:6px 16px 2px}.s9c-foot{padding:8px 16px 14px}.s9c-ln{font-size:12px}}
@media (max-height:640px){.s9c-ln{padding:5px 10px}.s9c-head h2{font-size:30px}}
`;

  /* ================================================================ art (fallback when the skin modules can't render a preview) */
  let svgN = 0;
  function soldierSVG(pv) {
    const n = 's9sv' + (++svgN), c1 = safeCol(pv && pv.c1, '#59616b'), c2 = safeCol(pv && pv.c2, '#2b3036'), gl = safeCol(pv && pv.glow, '#7fe7ff');
    return `<svg class="sol" viewBox="0 0 120 160" aria-hidden="true"><defs>
<linearGradient id="${n}a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>
<linearGradient id="${n}b" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${c2}"/><stop offset=".5" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>
<radialGradient id="${n}g"><stop offset="0" stop-color="${gl}" stop-opacity=".55"/><stop offset="1" stop-color="${gl}" stop-opacity="0"/></radialGradient></defs>
<ellipse cx="60" cy="152" rx="40" ry="7" fill="url(#${n}g)"/>
<g stroke="#07080b" stroke-width="2.2" stroke-linejoin="round">
<path d="M40 104 L58 104 L57 146 L39 146 Z" fill="url(#${n}a)"/><path d="M62 104 L80 104 L81 146 L63 146 Z" fill="url(#${n}a)"/>
<path d="M37 140 L58 140 L59 152 L34 152 Z" fill="${c2}"/><path d="M62 140 L83 140 L86 152 L61 152 Z" fill="${c2}"/>
<path d="M23 64 L36 64 L35 102 L24 102 Z" fill="url(#${n}a)"/><path d="M84 64 L97 64 L96 102 L85 102 Z" fill="url(#${n}a)"/>
<circle cx="29.5" cy="107" r="6" fill="${c2}"/><circle cx="90.5" cy="107" r="6" fill="${c2}"/>
<path d="M34 48 L86 48 L91 62 L85 98 L60 106 L35 98 L29 62 Z" fill="url(#${n}b)"/>
<path d="M36 96 L84 96 L82 106 L38 106 Z" fill="${c2}"/>
<path d="M20 50 Q30 40 42 48 L40 66 L21 67 Z" fill="url(#${n}a)"/><path d="M100 50 Q90 40 78 48 L80 66 L99 67 Z" fill="url(#${n}a)"/>
<rect x="53" y="38" width="14" height="10" fill="${c2}"/>
<path d="M43 16 Q60 2 77 16 L79 38 Q60 47 41 38 Z" fill="url(#${n}a)"/></g>
<path d="M47 24 L73 24 L71 33 Q60 38 49 33 Z" fill="${gl}" stroke="#07080b" stroke-width="1.6"/>
<path d="M50 26 L62 26 L60 29 L51 29 Z" fill="#fff" opacity=".55"/>
<path d="M52 60 L68 60 L65 78 L55 78 Z" fill="${gl}" opacity=".35"/><path d="M41 70 L52 72 M79 70 L68 72" stroke="${gl}" stroke-width="2" opacity=".8"/>
</svg>`;
  }
  function gunArt(g, pv) {
    g = g !== 'all' && /^[a-z0-9_-]{1,24}$/.test(String(g || '')) ? g : 'carbine';   // 'all' = a collection finish: shown on the carbine
    const pat = PATTERNS.includes(pv && pv.pattern) ? pv.pattern : 'plain', src = `assets/ui/w_${g}.png`;
    return `<div class="s9sh-gun" style="--m:url('${src}');--c1:${safeCol(pv && pv.c1, '#4a4f57')};--c2:${safeCol(pv && pv.c2, '#1c1f23')};--gl:${safeCol(pv && pv.glow, pv && pv.c1 || '#7fe7ff')}"><img src="${src}" alt="" draggable="false" onerror="this.parentNode.style.visibility='hidden'"><i class="tint"></i><i class="pat p-${pat}"></i><i class="glow"></i></div>`;
  }
  function artHTML(it) {
    if (it.type === 'soldier') return soldierSVG(it.preview) + thumbTag(it);
    if (it.type === 'gunskin') return gunArt(it.gun, it.preview) + thumbTag(it);
    if (it.type === 'bundle') {
      const parts = (it.contains || []).map(itemById).filter(Boolean);
      const sol = parts.find(p => p.type === 'soldier'), guns = parts.filter(p => p.type === 'gunskin').slice(0, 2);
      return `<div class="s9sh-bundle">${sol ? soldierSVG(sol.preview) : ''}${guns.map(p => gunArt(p.gun, p.preview)).join('')}</div>`;
    }
    return '';
  }

  /* real 3D thumbnails: drawn once per item by the skin modules (one shared renderer), cached, only for cards on screen */
  const THUMB = new Map();   // key -> dataURL | 'fail'
  // keys only ever hold [A-Za-z0-9_:-] (safeId), so they are safe inside a quoted attribute selector
  const tKey = it => it.type === 'soldier' ? 'sol:' + safeId(it.skinId) : 'gun:' + safeId(it.gun === 'all' ? 'carbine' : it.gun) + ':' + safeId(it.skinId);
  const canThumb = it => it.type === 'soldier' ? !!(window.S9Skins && typeof S9Skins.preview === 'function') : it.type === 'gunskin' ? !!(window.S9GunSkins && typeof S9GunSkins.preview === 'function') : false;
  function thumbTag(it) {
    if (!canThumb(it)) return '';
    const k = tKey(it), u = THUMB.get(k);
    return u && u !== 'fail' ? `<img class="s9sh-th on" src="${u}" alt="">` : u === 'fail' ? '' : `<img class="s9sh-th" data-thumb="${esc(k)}" data-iid="${esc(safeId(it.id))}" alt="">`;
  }
  let tQueue = [], tBusy = false, tObs = null;
  function watchThumbs(scope) {
    if (!('IntersectionObserver' in window)) return;
    if (!tObs) tObs = new IntersectionObserver(es => { for (const e of es) if (e.isIntersecting) { tObs.unobserve(e.target); tQueue.push(e.target); } pumpThumbs(); }, { rootMargin: '200px' });
    scope.querySelectorAll('img.s9sh-th[data-thumb]').forEach(im => tObs.observe(im));
  }
  async function pumpThumbs() {
    if (tBusy) return; tBusy = true;
    try {
      while (tQueue.length) {
        const im = tQueue.shift(); if (!im.isConnected) continue;
        const k = im.dataset.thumb, it = itemById(im.dataset.iid); if (!k || !it) continue;
        if (!THUMB.has(k)) {
          const cv = document.createElement('canvas');
          try {
            const job = it.type === 'soldier' ? S9Skins.preview(cv, { skin: it.skinId }, { w: 300, h: 300, yaw: -.45 })
              : S9GunSkins.preview(cv, it.gun === 'all' ? 'carbine' : it.gun, it.skinId, { w: 400, h: 225, bg: false, view: 'threeQ' });
            const r = await Promise.race([Promise.resolve(job).catch(() => null), sleep(8000).then(() => null)]);
            THUMB.set(k, r && cv.width ? cv.toDataURL('image/png') : 'fail');
          } catch (e) { THUMB.set(k, 'fail'); }
        }
        const u = THUMB.get(k);
        document.querySelectorAll('img.s9sh-th[data-thumb="' + k + '"]').forEach(x => { if (u !== 'fail') { x.src = u; x.classList.add('on'); } x.removeAttribute('data-thumb'); });
        await sleep(0);
      }
    } finally { tBusy = false; }
  }

  /* ================================================================ cards */
  const typeName = it => it.type === 'soldier' ? 'Soldier' : it.type === 'gunskin' ? 'Gun skin' : 'Bundle';
  function itemState(it) {
    const w = wallet(), lvl = SHOP && SHOP.level, st = { owned: !!it.owned, equipped: !!it.equipped, avail: !!it.available, soon: !!it.comingSoon };
    st.levelLocked = lvl != null && it.minLevel > lvl;
    st.price = num(it.priceNow != null ? it.priceNow : it.price);
    st.short = w ? Math.max(0, st.price - w.balance) : 0;
    return st;
  }
  function cardHTML(it, big) {
    const r = rarity(it.rarity), st = itemState(it), lvl = SHOP && SHOP.level;
    const badges = [];
    if (st.equipped && !it.default) badges.push('<span class="s9sh-b eq">Equipped</span>');
    else if (st.owned && !it.default) badges.push('<span class="s9sh-b own">Owned</span>');
    if (it.default) badges.push('<span class="s9sh-b own">Free</span>');
    if (!st.owned && it.minLevel > 1) badges.push(`<span class="s9sh-b ${st.levelLocked ? 'lock' : ''}">${st.levelLocked ? '&#128274; ' : ''}Lv ${int(it.minLevel)}${lvl == null ? '+' : ''}</span>`);
    if (st.soon) badges.push('<span class="s9sh-b na">Coming soon</span>');
    else if (!st.avail && !st.owned) badges.push('<span class="s9sh-b na">In rotation</span>');
    if (it.deal && !st.owned) badges.push(`<span class="s9sh-b deal">-${Math.round(num(it.deal) * 100)}%</span>`);
    else if (it.type === 'bundle' && it.discount && !st.owned) badges.push(`<span class="s9sh-b deal">-${Math.round(num(it.discount) * 100)}%</span>`);
    const sub = it.type === 'gunskin' ? gunName(it.gun) : it.type === 'bundle' ? (it.contains || []).length + ' items' : 'Soldier';
    const priceRow = st.owned ? '<span class="own">' + (it.default ? 'Free' : 'Owned') + '</span>'
      : `${shardImg()}<span>${fmt(st.price)}</span>${it.price > st.price ? `<s>${fmt(it.price)}</s>` : ''}`;
    const cls = ['s9sh-card', 'r-' + safeId(it.rarity), st.owned ? 'own' : '', !st.avail ? 'na' : '', st.soon ? 'cs' : '', st.levelLocked ? 'lk' : ''].join(' ');
    return `<button type="button" class="${cls}" data-item="${esc(safeId(it.id))}" style="--rc:${safeCol(r.color, '#b8c0cc')}" aria-label="${esc(it.name)}, ${esc(r.name)} ${esc(typeName(it))}${st.owned ? ', owned' : ', ' + fmt(st.price) + ' ' + esc(CUR().short)}">
<div class="s9sh-art">${artHTML(it)}</div><div class="s9sh-badges">${badges.join('')}</div>
<div class="s9sh-meta"><span class="s9sh-rar">${esc(r.name)} · ${esc(typeName(it))}</span><b class="s9sh-nm">${esc(it.name)}</b><span class="s9sh-sub">${esc(sub)}</span></div>
<div class="s9sh-price">${priceRow}</div></button>`;
  }

  /* ================================================================ DOM */
  let root = null, body = null, dlg = null, tickT = 0;
  function ensureDom() {
    if (root) return;
    const st = document.createElement('style'); st.id = 's9shopCss'; st.textContent = CSS; document.head.appendChild(st);
    root = document.createElement('div'); root.className = 's9sh'; root.id = 's9shop'; root.hidden = true;
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Shop');
    root.innerHTML = `<div class="s9sh-top"><h2 class="s9sh-title">Shop</h2>
<div class="s9sh-tabs" role="tablist"><button class="s9sh-tab" role="tab" data-tab="featured">Featured</button><button class="s9sh-tab" role="tab" data-tab="catalogue">Catalogue</button><button class="s9sh-tab" role="tab" data-tab="missions">Missions</button></div>
<div class="s9sh-wallet" id="s9shWallet"></div><button class="s9sh-x" type="button" data-close aria-label="Close shop">&#10005;</button></div>
<div id="s9shNote"></div><div class="s9sh-body" id="s9shBody"></div>`;
    document.body.appendChild(root);
    body = root.querySelector('#s9shBody');
    root.addEventListener('click', e => {
      const t = e.target.closest('[data-tab]'); if (t) { sfx.click(); view.tab = t.dataset.tab; render(); return; }
      if (e.target.closest('[data-close]')) { close(); return; }
      if (e.target.closest('[data-signin]')) { signIn(); return; }
      const f = e.target.closest('[data-ftype]'); if (f) { sfx.click(); view.type = f.dataset.ftype; render(); return; }
      const fr = e.target.closest('[data-frar]'); if (fr) { sfx.click(); view.rar = fr.dataset.frar; render(); return; }
      const c = e.target.closest('[data-item]'); if (c) { sfx.click(); openItem(c.dataset.item); }
    });
    dlg = document.createElement('div'); dlg.className = 's9sh-dlg'; dlg.id = 's9shDlg'; dlg.hidden = true; dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-modal', 'true');
    document.body.appendChild(dlg);
    dlg.addEventListener('click', e => { if (e.target === dlg || e.target.closest('[data-dclose]')) closeItem(); else onDlgClick(e); });
  }

  function walletHTML() {
    const w = wallet();
    if (!w) return `${shardImg()}<div><b>&mdash;</b><small>${esc(CUR().name)}</small></div><button type="button" data-signin>Sign in</button>`;
    return `${shardImg()}<div><b id="s9shBal">${fmt(w.balance)}</b><small>${esc(CUR().name)}</small></div>`;
  }
  function noteHTML() {
    if (!SHOP) return '';
    if (lastErr === 'offline' || SHOP.local) return `<div class="s9sh-note">The shop server can't be reached right now, so this is today's shop offline. Buying needs a connection.</div>`;
    if (!signedIn()) return `<div class="s9sh-note info"><span><b>Sign in to earn and spend ${esc(CUR().name)}.</b> Every online match pays Shards: more for a win, more for playing well. You can browse everything now.</span><button type="button" data-signin>Sign in</button></div>`;
    const w = wallet();
    if (!w.shopUnlocked) return `<div class="s9sh-note info">Play <b>&nbsp;${int(w.matchesToUnlock)} more match${w.matchesToUnlock === 1 ? '' : 'es'}&nbsp;</b> to unlock buying. Every finished online match earns ${esc(CUR().short)}.</div>`;
    return '';
  }
  function secHead(title, until, label, hint) {
    return `<div class="s9sh-sec"><h3>${esc(title)}</h3>${until ? `<span class="t">${esc(label)} <b data-until="${int(until)}">${countdown(until - Date.now())}</b></span>` : ''}${hint ? `<span class="h">${esc(hint)}</span>` : ''}</div>`;
  }
  function featuredHTML() {
    const R = SHOP.rotation || {}, get = ids => (ids || []).map(itemById).filter(Boolean);
    const perm = SHOP.items.filter(i => i.type === 'bundle' && i.permanent);
    return secHead('Daily featured', R.nextDailyAt, 'New items in', 'Same shop for every player') + `<div class="s9sh-grid big">${get(R.featured).map(i => cardHTML(i, true)).join('')}</div>`
      + secHead('This week', R.nextWeeklyAt, 'New set in') + `<div class="s9sh-grid wk">${get(R.weekly).concat(get(R.bundles)).map(i => cardHTML(i)).join('')}</div>`
      + (perm.length ? secHead('Always in stock') + `<div class="s9sh-grid">${perm.map(i => cardHTML(i)).join('')}</div>` : '');
  }
  function catalogueHTML() {
    const types = [['all', 'All'], ['soldier', 'Soldiers'], ['gunskin', 'Gun skins'], ['bundle', 'Bundles']];
    let list = SHOP.items.filter(i => !i.default);
    if (view.type !== 'all') list = list.filter(i => i.type === view.type);
    if (view.rar !== 'all') list = list.filter(i => i.rarity === view.rar);
    list.sort((a, b) => (b.available - a.available) || rarOrder(a.rarity) - rarOrder(b.rarity) || num(a.price) - num(b.price) || String(a.name).localeCompare(String(b.name)));
    return `<div class="s9sh-filters" role="group" aria-label="Filter">${types.map(([k, l]) => `<button type="button" class="s9sh-chip" data-ftype="${k}" aria-pressed="${view.type === k}">${l}</button>`).join('')}<span class="s9sh-sep"></span>
<button type="button" class="s9sh-chip" data-frar="all" aria-pressed="${view.rar === 'all'}">Any rarity</button>${RAR().map(r => `<button type="button" class="s9sh-chip" data-frar="${esc(safeId(r.id))}" aria-pressed="${view.rar === r.id}" style="--cc:${safeCol(r.color, '#b8c0cc')}"><span class="sw"></span>${esc(r.name)}</button>`).join('')}</div>
<p class="s9sh-p" style="margin:8px 0 14px">Items marked <b>In rotation</b> come and go with the daily and weekly shop. Nicer items cost more and some need a minimum level.</p>
${list.length ? `<div class="s9sh-grid">${list.map(i => cardHTML(i)).join('')}</div>` : '<div class="s9sh-empty">Nothing here with these filters.</div>'}`;
  }
  function earnRows() {
    const E = ECFG && ECFG.earn; if (!E) return '';
    const P = E.perf, rows = [['Win', E.result.win], ['Loss', E.result.loss], ['Kill', '+' + P.kill], ['Headshot', '+' + P.headshot], ['Assist', '+' + P.assist], ['Plant / defuse', '+' + P.plant + ' / +' + P.defuse], ['Round won', '+' + P.roundWin], ['MVP', '+' + P.mvp],
      ['Kill streak 5 / 10', '+' + P.streak[0][1] + ' / +' + P.streak[1][1]], ['Accuracy 35% / 50%', '+' + P.accuracy.tiers[0][1] + ' / +' + P.accuracy.tiers[1][1]], ['First win of the day', '+' + E.firstWinOfDay], ['Daily streak', '+' + E.dailyStreak.perDay + ' per day, up to +' + E.dailyStreak.perDay * (E.dailyStreak.maxDays - 1)],
      ['Level up / new rank', '+' + E.levelUp.perLevel + ' / +' + E.levelUp.newRank], ['Lucky drop', 'sometimes +' + E.lucky.min + ' to +' + E.lucky.max]];
    return `<div class="s9sh-earn">${rows.map(([a, b]) => `<div><span>${esc(a)}</span><b>${esc(b)}</b></div>`).join('')}</div>
<p class="s9sh-p" style="margin-top:12px">Performance pays up to +${int(P.cap)} a match. After ${fmt(E.softCap.tiers[0][0])} ${esc(CUR().short)} from matches in one day, matches pay half, and after ${fmt(E.softCap.tiers[1][0])} a fifth (resets at midnight UTC). Matches under a minute, matches with fewer than 2 real players, and players who don't move or shoot pay nothing.</p>`;
  }
  function missionsHTML() {
    let html = '';
    if (!signedIn()) html += `<div class="s9sh-empty" style="text-align:left;padding:18px 0">Sign in to get a daily op and three weekly missions. They pay extra ${esc(CUR().short)} on top of your matches.</div>`;
    else if (!MISSIONS) html += '<div class="s9sh-empty">Missions are loading...</div>';
    else {
      const card = m => { const f = clamp(m.progress / Math.max(1, m.target), 0, 1);
        return `<div class="s9sh-m ${m.done ? 'done' : ''}"><span class="k ${esc(safeId(m.tier || ''))}">${m.kind === 'daily' ? 'Daily op' : 'Weekly · ' + esc(m.tier || '')}</span><b>${esc(m.text)}</b>
<div class="row"><div class="s9sh-bar"><i style="transform:scaleX(${f.toFixed(3)})"></i></div><span>${m.done ? 'Done' : fmt(m.progress) + ' / ' + fmt(m.target)}</span><span class="rw">${shardImg()}${fmt(m.reward)}</span></div></div>`; };
      const d = MISSIONS.list.filter(m => m.kind === 'daily'), w = MISSIONS.list.filter(m => m.kind !== 'daily');
      html += secHead('Daily op', MISSIONS.nextDailyAt, 'New op in') + `<div class="s9sh-ms">${d.map(card).join('')}</div>`
        + secHead('Weekly missions', MISSIONS.nextWeeklyAt, 'New missions in') + `<div class="s9sh-ms">${w.map(card).join('')}</div>`;
    }
    return html + secHead('How you earn ' + CUR().short) + earnRows();
  }

  function render() {
    if (!root) return;
    root.querySelectorAll('.s9sh-tab').forEach(b => {
      b.setAttribute('aria-selected', String(b.dataset.tab === view.tab));
      if (b.dataset.tab === 'missions') { const open = MISSIONS && MISSIONS.list.some(m => !m.done); b.innerHTML = 'Missions' + (open ? '<span class="dot"></span>' : ''); }
    });
    root.querySelector('#s9shWallet').innerHTML = walletHTML();
    root.querySelector('#s9shNote').innerHTML = noteHTML();
    if (!SHOP) { body.innerHTML = '<div class="s9sh-empty">Loading the shop...</div>'; return; }
    const top = body.scrollTop;
    body.innerHTML = `<div data-view="${view.tab}">${view.tab === 'catalogue' ? catalogueHTML() : view.tab === 'missions' ? missionsHTML() : featuredHTML()}</div>`;
    body.scrollTop = top;
    watchThumbs(body);
  }

  function tick() {
    if (!isOpen()) return;
    let expired = false;
    document.querySelectorAll('#s9shop [data-until], #s9shDlg [data-until]').forEach(el => { const ms = num(el.dataset.until) - Date.now(); if (ms <= 0) expired = true; el.textContent = countdown(ms); });
    if (expired && !loading) load().then(render);
  }

  /* ================================================================ item dialog: preview, buy (with confirm), equip */
  let dItem = null, dMode = 'view', dKey = null, dBusy = false, pvLoop = 0;
  function openItem(id) {
    const it = itemById(id); if (!it) return;
    dItem = it; dMode = 'view'; dKey = null; dBusy = false;
    renderItem(''); dlg.hidden = false; void dlg.offsetWidth; dlg.classList.add('on');
    setTimeout(() => { const b = dlg.querySelector('.s9sh-buy:not([disabled]), .s9sh-ghost'); if (b) b.focus({ preventScroll: true }); }, 30);
  }
  function closeItem() { if (!dlg || dlg.hidden) return; cancelAnimationFrame(pvLoop); dlg.classList.remove('on'); dlg.hidden = true; dItem = null; }
  function startPreview(it) {
    cancelAnimationFrame(pvLoop);
    const host = dlg.querySelector('.live'); if (!host) return;
    let fn = null;
    if (it.type === 'soldier' && window.S9Skins && typeof S9Skins.preview === 'function') fn = yaw => S9Skins.preview(host, { skin: it.skinId }, { yaw });
    else if (it.type === 'gunskin' && window.S9GunSkins && typeof S9GunSkins.preview === 'function') { const cv = document.createElement('canvas'); cv.style.cssText = 'width:100%;height:100%;display:block'; host.appendChild(cv); fn = yaw => S9GunSkins.preview(cv, it.gun === 'all' ? 'carbine' : it.gun, it.skinId, { w: Math.max(320, host.clientWidth * Math.min(2, devicePixelRatio || 1)) | 0, h: Math.max(200, host.clientHeight * Math.min(2, devicePixelRatio || 1)) | 0, bg: false, yaw: -Math.PI / 2 + .62 + (yaw + .45) }); }
    if (!fn) return;
    const t0 = performance.now(); let last = 0, ok = true, busy = false;
    const step = t => {
      if (!dItem || dItem.id !== it.id || !ok || !host.isConnected) return;
      if (!busy && t - last > 33) {   // one frame at a time: never queue a new render before the last one finished
        last = t; busy = true; let r;
        try { r = fn(-0.45 + Math.sin((t - t0) / 2400) * 0.6); } catch (e) { ok = false; return; }
        Promise.resolve(r).then(v => { busy = false; if (v === false || v == null) { ok = false; return; } const fb = host.previousElementSibling; if (fb) fb.style.visibility = 'hidden'; }).catch(() => { ok = false; });
      }
      if (!reduced()) pvLoop = requestAnimationFrame(step);
    };
    pvLoop = requestAnimationFrame(step);
  }
  function renderItem(msg, msgCls) {
    const it = dItem; if (!it) return;
    const r = rarity(it.rarity), st = itemState(it), w = wallet(), lvl = SHOP && SHOP.level;
    const parts = it.type === 'bundle' ? (it.contains || []).map(itemById).filter(Boolean) : [];
    const sub = it.type === 'gunskin' ? (it.gun === 'all' ? 'Gun skin for every gun' : 'Gun skin for the ' + gunName(it.gun)) : it.type === 'bundle' ? 'Bundle · ' + parts.length + ' items' : 'Soldier';
    let acts = '', hint = '';
    if (st.owned) {
      if (it.slot === 'gun:*') { const on = new Set(it.equippedOn || []), gs = Object.keys(WEAPON_NAME); acts = `<label class="s9sh-pick">On <select id="s9shGun">${gs.map(g => `<option value="${g}">${esc(gunName(g))}${on.has(g) ? ' (wearing)' : ''}</option>`).join('')}</select></label><button class="s9sh-buy eq" data-equip>Equip</button>`; hint = on.size ? 'Wearing it on: ' + [...on].map(g => esc(gunName(g))).join(', ') : 'A collection finish fits every gun. Pick a gun and equip it, as often as you like.'; }
      else if (it.slot) acts = st.equipped ? `<button class="s9sh-buy eq" disabled>Equipped</button>` : `<button class="s9sh-buy eq" data-equip>Equip</button>`;
      else acts = `<button class="s9sh-buy" disabled>Owned</button>`;
    } else if (st.soon) { acts = `<button class="s9sh-buy" disabled>Coming soon</button>`; hint = 'This one is still being made. It will arrive in a future update.'; }
    else if (!st.avail) { acts = `<button class="s9sh-buy" disabled>Not in the shop today</button>`; hint = 'It comes back with the daily or weekly rotation. Check the Featured tab each day.'; }
    else if (!signedIn()) { acts = `<button class="s9sh-buy" data-signin>Sign in to buy</button>`; hint = 'Sign in to earn ' + CUR().name + ' in online matches.'; }
    else if (!w.shopUnlocked) { acts = `<button class="s9sh-buy" disabled>Locked</button>`; hint = `Play ${int(w.matchesToUnlock)} more match${w.matchesToUnlock === 1 ? '' : 'es'} to unlock the shop.`; }
    else if (st.levelLocked) { acts = `<button class="s9sh-buy" disabled>&#128274; Level ${int(it.minLevel)}</button>`; hint = `Reach level ${int(it.minLevel)} to buy this. You are level ${int(lvl)}.`; }
    else if (st.short > 0) { const m = Math.max(1, Math.ceil(st.short / Math.max(20, num(w.avgPerMatch) || 200))); acts = `<button class="s9sh-buy" disabled>Not enough</button>`; hint = `You need <b>${fmt(st.short)}</b> more ${esc(CUR().short)}, about <b>${m}</b> more match${m === 1 ? '' : 'es'}.`; }
    else if (dMode === 'confirm') { acts = `<button class="s9sh-buy conf" data-confirm>${shardImg()}Confirm ${fmt(st.price)}</button><button class="s9sh-ghost" data-cancel>Cancel</button>`; hint = `Buy <b>${esc(it.name)}</b> for <b>${fmt(st.price)}</b> ${esc(CUR().short)}? You will have <b>${fmt(w.balance - st.price)}</b> left.`; }
    else acts = `<button class="s9sh-buy" data-buy>${shardImg()}Buy ${fmt(st.price)}</button>`;
    const price = st.owned ? '' : `<div class="s9sh-dprice">${shardImg()}${fmt(st.price)}${it.price > st.price ? `<s>${fmt(it.price)}</s>` : ''}</div>`;
    const list = parts.length ? `<div class="s9sh-list">${parts.map(p => `<div><span>${esc(p.name)} <small style="color:#8b9097">${esc(typeName(p))}${p.gun ? ' · ' + esc(gunName(p.gun)) : ''}</small></span><span class="${p.owned ? 'ok' : ''}">${p.owned ? 'Owned' : fmt(p.price)}</span></div>`).join('')}</div>${parts.some(p => p.owned) && !st.owned ? '<p>You only pay for the parts you don\'t own yet.</p>' : ''}` : '';
    dlg.innerHTML = `<div class="s9sh-dbox r-${esc(safeId(it.rarity))}" style="--rc:${safeCol(r.color, '#b8c0cc')}" aria-label="${esc(it.name)}">
<div class="s9sh-dart"><div class="s9sh-art">${artHTML(it)}</div><div class="live"></div><div class="s9sh-burst" id="s9shBurst"></div></div>
<div class="s9sh-dinfo"><button class="s9sh-x s9sh-dx" type="button" data-dclose aria-label="Close">&#10005;</button>
<span class="s9sh-rar" style="color:var(--rc)">${esc(r.name)} · ${esc(sub)}</span><h2>${esc(it.name)}</h2>
${it.desc ? `<p>${esc(it.desc)}</p>` : ''}${list}
${it.minLevel > 1 ? `<p>Needs level <b>${int(it.minLevel)}</b>${lvl != null ? ` · you are level ${int(lvl)}` : ''}</p>` : ''}
${!it.permanent && !it.default && st.avail && SHOP.rotation ? `<p>In the shop for <b data-until="${int(it.type === 'bundle' || (SHOP.rotation.weekly || []).includes(it.id) ? SHOP.rotation.nextWeeklyAt : SHOP.rotation.nextDailyAt)}">${countdown((it.type === 'bundle' || (SHOP.rotation.weekly || []).includes(it.id) ? SHOP.rotation.nextWeeklyAt : SHOP.rotation.nextDailyAt) - Date.now())}</b> more</p>` : ''}
${price}<div class="s9sh-acts">${acts}</div><div class="s9sh-msg ${msgCls || ''}" id="s9shMsg" aria-live="polite">${msg || hint}</div></div></div>`;
    if (dItem) startPreview(dItem);
  }
  async function onDlgClick(e) {
    if (e.target.closest('[data-signin]')) { signIn(); return; }
    if (!dItem || dBusy) return;
    if (e.target.closest('[data-buy]')) { sfx.click(); dMode = 'confirm'; dKey = randKey(); renderItem(); const c = dlg.querySelector('[data-confirm]'); if (c) c.focus({ preventScroll: true }); return; }
    if (e.target.closest('[data-cancel]')) { sfx.click(); dMode = 'view'; renderItem(); return; }
    if (e.target.closest('[data-confirm]')) {
      dBusy = true; const it = dItem, key = dKey || (dKey = randKey());
      const b = dlg.querySelector('[data-confirm]'); if (b) { b.disabled = true; b.textContent = 'Buying...'; }
      const r = await req('POST', '/api/shop/buy', { itemId: it.id, key });
      dBusy = false;
      if (r.s === 200 && r.j.ok) {
        const before = wallet() ? wallet().balance : 0;
        await load(); dItem = itemById(it.id) || it; dMode = 'view';
        renderItem(`<b>${esc(it.name)}</b> is yours!`, 'ok'); burst(); sfx.purchase();
        animateBalance(before, wallet() ? wallet().balance : 0); render();
        return;
      }
      sfx.deny();
      if (r.s === 401) { renderItem('Please sign in again.', 'err'); return; }
      if (r.s === 402 && r.j.need) { dMode = 'view'; renderItem(`Not enough ${esc(CUR().short)}: you need <b>${fmt(r.j.need)}</b> more, about <b>${int(r.j.matches)}</b> more match${r.j.matches === 1 ? '' : 'es'}.`, 'err'); return; }
      if (r.s === 0) { renderItem(esc(r.j.error), 'err'); return; }   // keep the same key: a retry can't charge twice
      dMode = 'view'; await load(); dItem = itemById(it.id) || it; renderItem(esc(r.j.error || 'That did not work. Try again.'), 'err'); render();
      return;
    }
    if (e.target.closest('[data-equip]')) {
      dBusy = true; const it = dItem;
      const sel = dlg.querySelector('#s9shGun'), slot = it.slot === 'gun:*' ? 'gun:' + (sel && /^[a-z0-9_-]{1,24}$/.test(sel.value) ? sel.value : 'carbine') : it.slot;
      const r = await req('PUT', '/api/me/equip', { slot, itemId: it.default ? null : it.id });
      dBusy = false;
      if (r.s === 200) {
        sfx.equip();
        try { if (r.j.look) { if (window.S9Skins && typeof S9Skins.setLook === 'function' && it.type === 'soldier') S9Skins.setLook({ skin: it.default ? 'std' : it.skinId }); dispatchEvent(new CustomEvent('s9:look', { detail: r.j.look })); } } catch (x) {}
        await load(); dItem = itemById(it.id) || it; renderItem(`Equipped. You will wear it in your next match.`, 'ok'); render();
      } else renderItem(esc(r.j.error || 'Could not equip that.'), 'err');
    }
  }
  function burst() {
    const host = dlg.querySelector('#s9shBurst'); if (!host || reduced()) return;
    for (let i = 0; i < 22; i++) {
      const p = document.createElement('i'), a = i / 22 * Math.PI * 2 + Math.random() * .3, d = 90 + Math.random() * 120;
      host.appendChild(p);
      p.animate([{ transform: 'translate(0,0) scale(1.2) rotate(0deg)', opacity: 1 }, { transform: `translate(${Math.cos(a) * d}px,${Math.sin(a) * d}px) scale(.2) rotate(${180 + Math.random() * 180}deg)`, opacity: 0 }], { duration: 700 + Math.random() * 300, easing: 'cubic-bezier(.15,.8,.3,1)' }).onfinish = () => p.remove();
    }
  }
  function animateBalance(a, b) {
    const el = root && root.querySelector('#s9shBal'); if (!el) return;
    const t0 = performance.now(), D = 600;
    const step = t => { const k = clamp((t - t0) / D, 0, 1), e = 1 - Math.pow(1 - k, 3); el.textContent = fmt(a + (b - a) * e); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }

  /* ================================================================ open / close / sign in */
  let lastFocus = null;
  const isOpen = () => !!(root && !root.hidden);
  function open(tab) {
    ensureDom(); lastFocus = document.activeElement;
    if (tab && ['featured', 'catalogue', 'missions'].includes(tab)) view.tab = tab;
    root.hidden = false; render(); void root.offsetWidth; root.classList.add('on');
    clearInterval(tickT); tickT = setInterval(tick, 1000);
    load().then(() => { if (isOpen()) render(); });
    const t = root.querySelector('.s9sh-tab[aria-selected=true]'); if (t) t.focus({ preventScroll: true });
    return api;
  }
  function close() {
    if (!isOpen()) return api;
    closeItem(); clearInterval(tickT); root.classList.remove('on'); root.hidden = true;
    if (lastFocus && lastFocus.focus && document.contains(lastFocus)) try { lastFocus.focus({ preventScroll: true }); } catch (e) {}
    return api;
  }
  function signIn() {
    const A = window.S9Account;
    if (A && typeof A.open === 'function') { close(); try { A.open('signin'); } catch (e) { console.warn(e); } return; }
    const b = document.querySelector('#s9shop [data-signin]'); if (b) { b.textContent = 'Accounts are coming soon'; b.disabled = true; }
  }

  /* ================================================================ menu button */
  function updateButtons() {
    document.querySelectorAll('button.s9sh-open').forEach(b => {
      b.textContent = 'Shop';
      const w = wallet(); if (w) { const i = document.createElement('img'); i.src = ICON; i.alt = ''; const s = document.createElement('b'); s.textContent = fmt(w.balance); b.appendChild(i); b.appendChild(s); }
    });
  }
  function injectButtons() {
    const ref = document.getElementById('btnArsenal'); if (!ref || document.getElementById('btnShop')) return;
    // s9s-open: the class the menu module (menu.js) styles the Shop button by
    const b = document.createElement('button'); b.className = 'ghost s9sh-open s9s-open'; b.id = 'btnShop'; b.type = 'button';
    b.addEventListener('click', () => open('featured'));
    ref.insertAdjacentElement('afterend', b); updateButtons();
  }

  /* ================================================================ sound (WebAudio, synthesized, no files)
     Volume = game master volume (ECFG.vol) x effects volume (S9Settings, if present). Goes through its own limiter so it
     also plays on menus and the match-end screen (the game mutes its own bus outside live play). */
  // the game's own settings object (index.html: const CFG = { sens, vol, q }) is a global lexical binding
  const gameCfg = () => (typeof CFG !== 'undefined' ? CFG : null);   // resolves to the game's global: ours is named ECFG
  const sfx = (() => {
    const stats = { played: 0, errors: 0, ticks: 0, last: '' };
    let ctx = null, bus = null, lastTick = 0;
    function vol() {
      let m = 0.8; try { const G = gameCfg(); if (G && Number.isFinite(+G.vol)) m = +G.vol; } catch (e) {}
      let fx = 1; const S = window.S9Settings;
      try { const a = S && typeof S.get === 'function' ? (S.get() || {}).audio : null; if (a && typeof a === 'object') { if (Number.isFinite(+a.master)) m = +a.master; if (Number.isFinite(+a.effects)) fx = +a.effects; } } catch (e) {}
      if (fx > 1) fx /= 100; if (m > 1) m /= 100;
      return clamp(m, 0, 1) * clamp(fx, 0, 1);
    }
    function init() {
      try {
        if (ctx) { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); return ctx; }
        const g = window.__s9 && window.__s9.AU; ctx = (g && g.ctx) || null;
        if (!ctx) { const C = window.AudioContext || window.webkitAudioContext; if (!C) return null; ctx = new C(); }
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        const lim = ctx.createDynamicsCompressor(); lim.threshold.value = -14; lim.knee.value = 6; lim.ratio.value = 10; lim.attack.value = .002; lim.release.value = .2; lim.connect(ctx.destination);
        bus = ctx.createGain(); bus.gain.value = vol() * .8; bus.connect(lim);
        return ctx;
      } catch (e) { stats.errors++; ctx = null; return null; }
    }
    function tone(t, f0, f1, dur, type, peak, dest) {
      const o = ctx.createOscillator(), g = ctx.createGain(); o.type = type; o.frequency.setValueAtTime(f0, t); if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur * .9);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + .004); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(dest || bus); o.start(t); o.stop(t + dur + .02);
    }
    function noise(t, dur, freq, q, peak) {
      const len = Math.max(1, ctx.sampleRate * dur | 0), b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain(); s.buffer = b; f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q; g.gain.value = peak;
      s.connect(f); f.connect(g); g.connect(bus); s.start(t);
    }
    const play = (name, fn) => { try { if (!init() || !bus) return; bus.gain.value = vol() * .8; if (bus.gain.value <= 0.0001) return; fn(ctx.currentTime); stats.played++; stats.last = name; } catch (e) { stats.errors++; } };
    return {
      stats, vol, warm() { init(); },
      // coin tick: pitch climbs with step (a payout counter), rate-capped so a fast counter never turns into a buzz
      tick(step) { const now = performance.now(); if (now - lastTick < 55) return; lastTick = now; stats.ticks++;
        play('tick', t => { const f = Math.min(2900, 900 * Math.pow(2, clamp(step, 0, 40) / 18)); tone(t, f, f * 1.02, .05, 'triangle', .16); tone(t, f * 2, f * 2, .03, 'sine', .05); }); },
      chime() { play('chime', t => { tone(t, 1568, 1568, .32, 'sine', .14); tone(t + .05, 2093, 2093, .4, 'sine', .11); tone(t, 3136, 3136, .12, 'triangle', .03); }); },
      sparkle() { play('sparkle', t => { for (let i = 0; i < 5; i++) tone(t + i * .045, 2200 + i * 380 + Math.random() * 120, 0, .14, 'sine', .07); }); },
      negative() { play('negative', t => { tone(t, 330, 220, .22, 'sine', .1); }); },
      total(big) { play('total', t => {
        tone(t, 150, 55, .3, 'sine', .45);                                         // thump
        noise(t, .09, 5200, 1.2, .35);                                             // crystal "ching"
        [1047, 1319, 1568, 2093].forEach((f, i) => tone(t + .02 + i * .03, f, f, big ? 1.4 : .9, 'sine', .12));
        tone(t + .02, 4186, 4186, .5, 'triangle', .04);
      }); },
      land() { play('land', t => tone(t, 2600 + Math.random() * 300, 0, .04, 'sine', .05)); },
      stamp() { play('stamp', t => { tone(t, 200, 90, .12, 'square', .08); tone(t + .04, 1760, 1760, .3, 'sine', .1); tone(t + .1, 2637, 2637, .35, 'sine', .08); }); },
      click() { play('click', t => tone(t, 1400, 1100, .035, 'triangle', .05)); },
      purchase() { play('purchase', t => { noise(t, .1, 4800, 1.5, .3); [784, 988, 1175, 1568, 1976].forEach((f, i) => tone(t + i * .06, f, f, .5, 'sine', .11)); }); },
      deny() { play('deny', t => { tone(t, 240, 180, .16, 'square', .05); tone(t + .1, 200, 150, .18, 'square', .05); }); },
      equip() { play('equip', t => { tone(t, 600, 1200, .12, 'triangle', .1); tone(t + .08, 1600, 1600, .25, 'sine', .08); }); },
    };
  })();

  /* ================================================================ end-of-match coins screen */
  const PERF = { frames: 0, ms: 0, max: 0, over4: 0 };   // JS time this screen spends per animation frame (checked by the gate test)
  const BONUS = new Set(['firstwin', 'streakday', 'levelup', 'rankup', 'mission', 'lucky']);
  let mc = null;
  function normBreakdown(b) {
    let arr = Array.isArray(b) ? b : b && typeof b === 'object' ? Object.entries(b).map(([k, v]) => (v && typeof v === 'object' ? Object.assign({ k }, v) : { k, label: k, amount: v })) : [];
    return arr.slice(0, 16).map(p => ({ k: safeId(p && p.k) || 'x', label: String((p && (p.label || p.k)) || '').slice(0, 60), amount: int(p && p.amount) })).filter(p => p.amount !== 0);
  }
  function matchCoins(opts) {
    opts = opts || {};
    if (mc) closeCoins();
    ensureDom();
    const lines = normBreakdown(opts.breakdown);
    const total = lines.reduce((s, p) => s + p.amount, 0);
    const before = Number.isFinite(+opts.before) ? int(opts.before) : 0;
    const after = Number.isFinite(+opts.after) ? int(opts.after) : before + total;
    const missions = (Array.isArray(opts.missions) ? opts.missions : []).slice(0, 4).map(m => ({ text: String(m.text || '').slice(0, 60), target: Math.max(1, int(m.target)), from: clamp(int(m.from), 0, 1e9), progress: clamp(int(m.progress), 0, 1e9), reward: int(m.reward), done: !!m.done, justDone: !!m.justDone, kind: m.kind === 'daily' ? 'daily' : 'weekly' }));
    const res = lines.find(p => p.k === 'result');
    const title = opts.title ? String(opts.title) : res ? (/victory/i.test(res.label) ? 'Victory' : /defeat/i.test(res.label) ? 'Defeat' : res.label) : 'Match over';
    const el = document.createElement('div'); el.className = 's9c'; el.id = 's9coins'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Match reward');
    const lineHTML = p => { const bonus = BONUS.has(p.k), neg = p.amount < 0; return `<div class="s9c-ln ${bonus ? 'bonus' : ''} ${p.k === 'lucky' ? 'lucky' : ''} ${neg ? 'neg' : ''}" data-amt="${p.amount}">${bonus ? `<span class="tag">${p.k === 'lucky' ? 'LUCKY' : p.k === 'mission' ? 'MISSION' : 'BONUS'}</span>` : ''}<span class="lb">${esc(p.label)}</span><span class="am">${neg ? '&minus;' : '+'}0</span></div>`; };
    el.innerHTML = `<div class="s9c-card"><div class="s9c-head"><div><div class="k">${esc(CUR().name)} earned</div><h2>${esc(title)}</h2></div>
<div class="s9c-wal" id="s9cWal">${shardImg()}<b id="s9cWalV">${fmt(before)}</b></div></div>
<div class="s9c-lines">${lines.length ? lines.map(lineHTML).join('') : `<div class="s9c-ln none">${esc(opts.reason ? 'No ' + CUR().short + ' this match: ' + opts.reason : 'No ' + CUR().short + ' this match')}</div>`}</div>
<div class="s9c-tot"><span>Total</span><div class="v">${shardImg()}<b id="s9cTot">0</b></div></div>
${missions.length ? `<div class="s9c-ms">${missions.map(m => `<div class="s9c-m" data-f="${clamp(m.from / m.target, 0, 1)}" data-t="${clamp(m.progress / m.target, 0, 1)}" data-done="${m.justDone ? 1 : 0}"><span class="t">${m.kind === 'daily' ? 'Daily · ' : ''}${esc(m.text)}</span><span class="n">${fmt(Math.min(m.progress, m.target))} / ${fmt(m.target)}</span><div class="s9sh-bar"><i style="transform:scaleX(${clamp(m.from / m.target, 0, 1).toFixed(3)})"></i></div>${m.justDone ? `<span class="st">Complete +${fmt(m.reward)}</span>` : ''}</div>`).join('')}</div>` : ''}
<div class="s9c-foot"><span id="s9cHint">Click or press Space to skip</span><button type="button" id="s9cGo">Continue</button></div></div>`;
    document.body.appendChild(el);
    sfx.warm();   // create the audio graph now, not inside the first animation frame
    let resolve; const done = new Promise(r => { resolve = r; });
    const S = { el, skip: false, finished: false, waits: new Set(), anims: new Set(), resolve, walletV: before, after, total, t0: performance.now() };
    mc = S;
    const wait = ms => new Promise(r => { if (S.skip) return r(); const w = { r, t: setTimeout(() => { S.waits.delete(w); r(); }, ms) }; S.waits.add(w); });
    const onKey = e => { if (mc !== S) return; if (e.code === 'Space' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); S.finished ? closeCoins() : skipCoins(); } else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeCoins(); } };
    S.onKey = onKey; addEventListener('keydown', onKey, true);
    el.addEventListener('click', e => { if (e.target.closest('#s9cGo')) { closeCoins(); return; } S.finished ? closeCoins() : skipCoins(); });
    requestAnimationFrame(() => el.classList.add('on'));
    const walB = el.querySelector('#s9cWalV'), wal = el.querySelector('#s9cWal'), totB = el.querySelector('#s9cTot');
    const speed = reduced() ? .35 : 1;
    const anim = (node, kf, o) => { if (!node.animate) return null; const a = node.animate(kf, o); S.anims.add(a); a.finished.then(() => S.anims.delete(a)).catch(() => S.anims.delete(a)); return a; };
    function fly(from, amount, n) {
      if (S.finished) return;
      if (S.skip || reduced() || !from) { S.walletV += amount; walB.textContent = fmt(S.walletV); return; }
      const a = from.getBoundingClientRect(), b = wal.getBoundingClientRect(), share = Math.round(amount / n); let left = amount;
      for (let i = 0; i < n; i++) {
        const c = document.createElement('img'); c.className = 's9c-fly'; c.src = ICON_PNG; c.alt = ''; c.decoding = 'sync'; document.body.appendChild(c);
        const x0 = a.right - 30 + (Math.random() * 20 - 10), y0 = a.top + a.height / 2 - 11, x1 = b.left + 12, y1 = b.top + b.height / 2 - 11, mx = (x0 + x1) / 2 + (Math.random() * 80 - 40), my = Math.min(y0, y1) - 40 - Math.random() * 40;
        const part = i === n - 1 ? left : share; left -= part;
        const f = anim(c, [{ transform: `translate(${x0}px,${y0}px) scale(.4)`, opacity: 0 }, { transform: `translate(${mx}px,${my}px) scale(1.1)`, opacity: 1, offset: .45 }, { transform: `translate(${x1}px,${y1}px) scale(.55)`, opacity: .9 }], { duration: (520 + i * 70) * speed, easing: 'cubic-bezier(.45,0,.6,1)' });
        const lastOne = i === n - 1;
        const land = () => { c.remove(); if (mc !== S || S.finished) return; S.walletV += part; walB.textContent = fmt(S.walletV); sfx.land(); if (lastOne) anim(wal, [{ transform: 'scale(1)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }], { duration: 180 }); };
        if (f) { f.onfinish = land; f.oncancel = () => c.remove(); } else land();
      }
    }
    function countTo(node, from, to, dur, onStep, sign) {
      return new Promise(r => {
        if (S.skip || dur <= 0) { node.textContent = (sign || '') + fmt(Math.abs(to)); return r(); }
        const t0 = performance.now(); let lastShown = null, step = 0;
        const fr = t => {
          const c0 = performance.now(); try { frame(t); } finally { const d = performance.now() - c0; PERF.frames++; PERF.ms += d; if (d > 4) PERF.over4++; if (d > PERF.max) PERF.max = d; }
        };
        const frame = t => {
          if (mc !== S) return r();
          if (S.skip) { node.textContent = (sign || '') + fmt(Math.abs(to)); return r(); }
          const k = clamp((t - t0) / dur, 0, 1), e = 1 - Math.pow(1 - k, 2.2), v = Math.round(from + (to - from) * e);
          if (v !== lastShown) { node.textContent = (sign || '') + fmt(Math.abs(v)); lastShown = v; if (onStep) onStep(step++, k); }
          if (k < 1) requestAnimationFrame(fr); else r();
        };
        requestAnimationFrame(fr);
      });
    }
    (async () => {
      await wait(320 * speed);
      const rows = [...el.querySelectorAll('.s9c-ln')];
      if (!lines.length && rows[0]) { rows[0].classList.add('on'); }
      let ladder = 0;
      for (let i = 0; i < lines.length; i++) {
        const p = lines[i], row = rows[i], am = row.querySelector('.am');
        if (S.finished) return;
        row.classList.add('on'); await wait(120 * speed);
        const neg = p.amount < 0, dur = clamp(260 + Math.log10(Math.abs(p.amount) + 1) * 230, 260, 950) * speed;
        await countTo(am, 0, p.amount, dur, () => { if (!neg) sfx.tick(ladder++); }, neg ? '−' : '+');
        row.classList.add('done');
        if (S.finished) return;
        if (neg) { sfx.negative(); S.walletV += p.amount; walB.textContent = fmt(S.walletV); }
        else { BONUS.has(p.k) ? sfx.sparkle() : sfx.chime(); fly(am, p.amount, clamp(Math.ceil(Math.abs(p.amount) / 40), 1, 4)); }
        await wait(170 * speed);
      }
      if (S.finished) return;
      // total: quick count, then the pop
      await countTo(totB, 0, total, clamp(300 + Math.log10(Math.abs(total) + 1) * 160, 300, 900) * speed, k => { if (k % 2 === 0) sfx.tick(ladder++); });
      if (S.finished) return;
      sfx.total(total >= 300);
      const v = el.querySelector('.s9c-tot .v');
      anim(v, [{ transform: 'scale(1)' }, { transform: 'scale(1.32)' }, { transform: 'scale(.94)' }, { transform: 'scale(1)' }], { duration: 560 * speed, easing: 'ease-out' });
      if (total > 0 && !S.skip && !reduced()) particles(v);
      // missions fill up
      const ms = [...el.querySelectorAll('.s9c-m')];
      for (const m of ms) {
        if (S.finished) return;
        m.classList.add('on'); const bar = m.querySelector('.s9sh-bar i'), f0 = num(m.dataset.f), f1 = num(m.dataset.t);
        if (f1 > f0) anim(bar, [{ transform: `scaleX(${f0})` }, { transform: `scaleX(${f1})` }], { duration: 650 * speed, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'forwards' });
        bar.style.transform = `scaleX(${f1})`;
        await wait(260 * speed);
        if (m.dataset.done === '1') { const st = m.querySelector('.st'); if (st) st.classList.add('on'); sfx.stamp(); await wait(260 * speed); }
      }
      finish();
    })().catch(() => finish());
    function finish() {
      if (S.finished || mc !== S) return; S.finished = true;
      for (const w of S.waits) { clearTimeout(w.t); w.r(); } S.waits.clear();
      el.querySelectorAll('.s9c-ln').forEach((row, i) => { row.classList.add('on', 'done'); const p = lines[i]; if (p) row.querySelector('.am').textContent = (p.amount < 0 ? '−' : '+') + fmt(Math.abs(p.amount)); });
      totB.textContent = fmt(total); walB.textContent = fmt(after); S.walletV = after;
      el.querySelectorAll('.s9c-m').forEach(m => { m.classList.add('on'); m.querySelector('.s9sh-bar i').style.transform = `scaleX(${num(m.dataset.t)})`; const st = m.querySelector('.st'); if (st) st.classList.add('on'); });
      el.querySelector('#s9cGo').classList.add('on'); el.querySelector('#s9cHint').textContent = 'Click or press Space to continue';
      setTimeout(() => { const b = el.querySelector('#s9cGo'); if (b && mc === S) b.focus({ preventScroll: true }); }, 50);
      if (opts.autoClose > 0) setTimeout(() => { if (mc === S) closeCoins(); }, opts.autoClose);
    }
    S.finish = finish;
    return done;
  }
  function particles(anchor) {
    const r = anchor.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2, cols = ['#9ef3ff', '#7fe7ff', '#b9a8ff', '#fff5c2', '#ffffff'];
    for (let i = 0; i < 26; i++) {
      const p = document.createElement('i'); p.className = 's9c-pt'; p.style.background = cols[i % cols.length]; document.body.appendChild(p);
      const a = Math.random() * Math.PI * 2, d = 60 + Math.random() * 130, s = .6 + Math.random() * 1.1;
      const an = p.animate([{ transform: `translate(${cx}px,${cy}px) rotate(45deg) scale(${s})`, opacity: 1 }, { transform: `translate(${cx + Math.cos(a) * d}px,${cy + Math.sin(a) * d}px) rotate(285deg) scale(0)`, opacity: 0 }], { duration: 650 + Math.random() * 350, easing: 'cubic-bezier(.1,.8,.3,1)' });
      if (mc) mc.anims.add(an);
      an.onfinish = an.oncancel = () => p.remove();
    }
  }
  function skipCoins() {
    const S = mc; if (!S || S.finished) return; S.skip = true;
    S.finish && S.finish();                                     // final numbers first (marks finished, so landing coins add nothing)
    for (const a of [...S.anims]) try { a.finish(); } catch (e) {}
    document.querySelectorAll('.s9c-fly').forEach(n => n.remove());
    sfx.chime();
  }
  function closeCoins() {
    const S = mc; if (!S) return; mc = null;
    for (const w of S.waits) { clearTimeout(w.t); w.r(); }
    for (const a of S.anims) try { a.cancel(); } catch (e) {}
    document.querySelectorAll('.s9c-fly, .s9c-pt').forEach(n => n.remove());
    removeEventListener('keydown', S.onKey, true);
    S.el.classList.remove('on'); setTimeout(() => S.el.remove(), 220);
    if (SHOP && SHOP.wallet) { SHOP.wallet.balance = S.after; updateButtons(); }
    S.resolve();
  }

  // after an online match: fetch the server's breakdown of the last paid match and show it once
  const SEEN_KEY = 'sector9-shop-lastmatch';
  async function showLastMatch(o) {
    o = o || {};
    if (!token()) return false;
    const r = await req('GET', '/api/me/wallet');
    if (r.s !== 200 || !r.j || !r.j.lastMatch) return false;
    const L = r.j.lastMatch; let seen = null; try { seen = localStorage.getItem(SEEN_KEY); } catch (e) {}
    if (!o.force && (seen === String(L.matchId) || Date.now() - Date.parse(L.at) > 5 * 60000)) return false;
    try { localStorage.setItem(SEEN_KEY, String(L.matchId)); } catch (e) {}
    while (document.querySelector('.s9p-pop.on')) await sleep(300);   // let the profile's XP / level-up popups finish first
    await matchCoins({ breakdown: L.breakdown, before: L.before, after: L.after, missions: (L.missions || []).filter(m => m.progress > m.from || m.justDone) });
    load();
    return true;
  }

  /* ================================================================ wiring */
  addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (dlg && !dlg.hidden) closeItem(); else if (isOpen()) close(); else return;
    e.preventDefault(); e.stopImmediatePropagation();
  }, true);
  function hookState() {
    try {
      if (typeof window.setState === 'function' && !window.setState.__s9shop) {
        const _ss = window.setState;
        const w = function (s) {
          if (s === 'play' || s === 'dead') close();
          const r = _ss.apply(this, arguments);
          if (s === 'matchend' && api.autoShow) { let n = 0; const poll = () => { if (++n > 6) return; showLastMatch().then(ok => { if (!ok) setTimeout(poll, 2000); }); }; setTimeout(poll, 1500); }
          return r;
        };
        w.__s9shop = true; Object.keys(_ss).forEach(k => { w[k] = _ss[k]; }); window.setState = w;
      }
    } catch (e) {}
  }
  const refreshSoon = () => { load().then(() => { if (isOpen()) render(); }); };
  addEventListener('s9:profile', refreshSoon);
  addEventListener('s9:logout', () => { SHOP = null; MISSIONS = null; refreshSoon(); });
  try { if (window.S9Account && typeof S9Account.onChange === 'function') S9Account.onChange(refreshSoon); } catch (e) {}

  const api = {
    open, close, isOpen, refresh: () => load().then(() => { if (isOpen()) render(); return SHOP; }), matchCoins, showLastMatch, skipCoins, closeCoins,
    setToken(t) { TOKEN_OVERRIDE = typeof t === 'string' ? t : t === null ? '' : null; SHOP = null; MISSIONS = null; return api.refresh(); },
    get balance() { const w = wallet(); return w ? w.balance : null; }, get data() { return SHOP; }, get missions() { return MISSIONS; },
    get coinsOpen() { return !!mc; }, perf: PERF, get coinsFinished() { return !!(mc && mc.finished); },
    sfx, apiBase: null, autoShow: true, _esc: esc, _localShop: now => { return cfgReady.then(() => localShop(now || Date.now())); },
  };
  window.S9Shop = api;
  const boot = () => { injectButtons(); hookState(); load().catch(() => {}); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
