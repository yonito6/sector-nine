/* Sector Nine player cards: click a player in the room lobby (or call S9PlayerCard.open) to see their card.
   Card = nick, rank badge + level, stats (K/D, wins, matches, favourite weapon ...), and buttons: Add friend (sends a
   friend request through /api/friends, shows Pending / Friends), Report player. Guests get a nick-only card.
   Stats follow the owner's privacy setting ("Who can see my stats": Everyone / Friends / Only me, default Friends); the
   SERVER decides (GET /api/friends/card?room=CODE&pid=ID), this file only shows what it is given.
   Public: window.S9PlayerCard = { open({pid, nick}), close(), isOpen(), wire() }
   Security: every nickname / number goes in through textContent. No secrets in here. Loaded after the main script. */
(function () {
  'use strict';
  if (window.S9PlayerCard) return;

  const ACC = () => window.S9Account || null;
  const token = () => { const a = ACC(); return a && a.token ? a.token() : null; };
  const api = (path, opts) => { const a = ACC(); if (!a || !a.api) return Promise.reject(new Error("Can't reach the server.")); return a.api(path, opts); };
  const G = () => window.__s9 || {};
  const net = () => (typeof NET !== 'undefined' ? NET : null);
  const room = () => { const n = net(); return n && n.room && n.room.meta ? n.room : null; };
  const $ = id => document.getElementById(id);

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k]; if (v == null || v === false) continue;
      if (k === 'text') e.textContent = v; else if (k === 'class') e.className = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
    return e;
  }
  const fmt = n => Math.round(+n || 0).toLocaleString('en-US');
  const weaponName = id => { try { const s = window.__s9, W = (s && s.WEAPONS) || (typeof WEAPONS !== 'undefined' ? WEAPONS : null); if (W && W[id] && W[id].name) return String(W[id].name); } catch (e) {} return String(id || '').replace(/[_-]/g, ' ').replace(/^\w/, c => c.toUpperCase()); };
  const RANKS = ['Recruit', 'Private', 'Corporal', 'Sergeant', 'Lieutenant', 'Captain', 'Major', 'Colonel', 'General', 'Sector Legend'], STEPS = ['I', 'II', 'III', 'IV', 'V'];
  const hue = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };
  const SEEN = { everyone: 'Everyone', friends: 'Friends', me: 'Only me' };

  /* ---------------------------------------------------------------- style (matches the futuristic menu look) */
  const CSS = `
#s9pc{--o:#ff9a3c;--o2:#ffb066;--c:#7fe7ff;--ink:#ece6d8;--dim:#9aa0a8;--ln:rgba(236,230,216,.16);--ln2:rgba(236,230,216,.3);
  position:fixed;inset:0;z-index:90;display:grid;place-items:center;padding:16px;background:rgba(4,5,7,.62);backdrop-filter:blur(3px);color:var(--ink);font-family:"IBM Plex Mono",ui-monospace,Consolas,monospace;opacity:0;transition:opacity .18s}
#s9pc.on{opacity:1}
#s9pc *{box-sizing:border-box}
.s9pc-card{position:relative;width:min(460px,100%);max-height:calc(100vh - 32px);max-height:calc(100dvh - 32px);overflow:auto;background:linear-gradient(160deg,rgba(24,28,36,.97),rgba(11,13,17,.98));border:1px solid var(--ln2);
  clip-path:polygon(0 0,calc(100% - 22px) 0,100% 22px,100% 100%,22px 100%,0 calc(100% - 22px));padding:22px 22px 20px;transform:translateY(10px) scale(.98);transition:transform .22s cubic-bezier(.2,.8,.2,1)}
#s9pc.on .s9pc-card{transform:none}
.s9pc-card::before{content:"";position:absolute;left:0;top:0;right:0;height:3px;background:linear-gradient(90deg,var(--o),var(--c))}
.s9pc-x{position:absolute;top:10px;right:26px;width:34px;height:34px;display:grid;place-items:center;background:transparent;border:1px solid var(--ln);color:var(--ink);font-size:18px;cursor:pointer;line-height:1}
.s9pc-x:hover{border-color:var(--o)}
.s9pc-top{display:flex;align-items:center;gap:16px;min-width:0;padding-right:44px}
.s9pc-bd{flex:none;width:84px;height:84px;display:grid;place-items:center}
.s9pc-av{width:84px;height:84px;display:grid;place-items:center;font-family:"Big Shoulders Stencil Display",Impact,"Arial Narrow",sans-serif;font-weight:900;font-size:40px;color:#14100b;clip-path:polygon(50% 0,100% 50%,50% 100%,0 50%)}
.s9pc-who{min-width:0;display:grid;gap:5px}
.s9pc-nick{margin:0;font-family:"Big Shoulders Stencil Display",Impact,"Arial Narrow",sans-serif;font-weight:900;font-size:clamp(26px,6vw,36px);line-height:.95;letter-spacing:.02em;text-transform:uppercase;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.s9pc-sub{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--c)}
.s9pc-tags{display:flex;gap:6px;flex-wrap:wrap}
.s9pc-tag{font-size:10px;letter-spacing:.14em;text-transform:uppercase;padding:2px 7px;border:1px solid var(--ln2);color:var(--dim)}
.s9pc-tag.me{background:var(--o);border-color:var(--o);color:#14100b;font-weight:700}
.s9pc-tag.fr{border-color:#5cff9d;color:#5cff9d}
.s9pc-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:18px}
.s9pc-st{padding:10px 10px 9px;background:rgba(236,230,216,.045);border:1px solid var(--ln);min-width:0}
.s9pc-st b{display:block;font-family:"Big Shoulders Stencil Display",Impact,"Arial Narrow",sans-serif;font-weight:900;font-size:26px;line-height:1;letter-spacing:.02em;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.s9pc-st span{display:block;margin-top:4px;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
.s9pc-st.hl b{color:var(--o2)}
.s9pc-fav{display:flex;justify-content:space-between;gap:10px;margin-top:8px;padding:10px 12px;background:rgba(127,231,255,.06);border:1px solid rgba(127,231,255,.28);font-size:12px;letter-spacing:.06em}
.s9pc-fav b{color:var(--c);font-weight:700;text-transform:uppercase;letter-spacing:.1em;text-align:right;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.s9pc-lock{margin-top:18px;display:flex;gap:12px;align-items:center;padding:14px;border:1px dashed var(--ln2);color:var(--dim);font-size:13px;line-height:1.45}
.s9pc-lock svg{flex:none;width:26px;height:26px;stroke:var(--o);fill:none;stroke-width:1.8}
.s9pc-msg{margin-top:14px;font-size:12px;line-height:1.5;color:var(--dim);min-height:1px}
.s9pc-msg.err{color:#ff7a7a}.s9pc-msg.ok{color:#5cff9d}
.s9pc-btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}
.s9pc-btn{flex:1 1 140px;min-height:44px;padding:0 14px;display:inline-flex;align-items:center;justify-content:center;gap:8px;background:rgba(236,230,216,.05);border:1px solid var(--ln2);color:var(--ink);font-family:inherit;font-size:12px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;cursor:pointer;transition:background .15s,border-color .15s}
.s9pc-btn:hover:not(:disabled){border-color:var(--o);background:rgba(255,154,60,.12)}
.s9pc-btn.pri{background:var(--o);border-color:var(--o);color:#14100b}.s9pc-btn.pri:hover:not(:disabled){background:var(--o2);border-color:var(--o2)}
.s9pc-btn.bad:hover:not(:disabled){border-color:#ff5a5a;background:rgba(255,90,90,.12)}
.s9pc-btn:disabled{opacity:.6;cursor:default}
.s9pc-btn:focus-visible,.s9pc-x:focus-visible,.s9pc-sel:focus-visible,.s9pc-ta:focus-visible{outline:2px solid var(--o);outline-offset:2px}
.s9pc-rep[hidden]{display:none}
.s9pc-rep{margin-top:14px;display:grid;gap:8px;padding:12px;border:1px solid var(--ln);background:rgba(0,0,0,.25)}
.s9pc-rep label{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
.s9pc-sel,.s9pc-ta{width:100%;background:#0b0d10;border:1px solid var(--ln2);color:var(--ink);font-family:inherit;font-size:13px;padding:9px 10px}
.s9pc-ta{min-height:64px;resize:vertical}
.s9pc-priv{margin-top:16px;display:grid;gap:6px}
.s9pc-priv small{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
.s9pc-seg{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--ln2)}
.s9pc-seg button{min-height:40px;background:transparent;border:0;border-right:1px solid var(--ln);color:var(--dim);font-family:inherit;font-size:11px;letter-spacing:.1em;text-transform:uppercase;cursor:pointer}
.s9pc-seg button:last-child{border-right:0}
.s9pc-seg button[aria-pressed=true]{background:rgba(255,154,60,.18);color:var(--o2);font-weight:700}
.s9pc-load{padding:34px 0 20px;text-align:center;font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:var(--dim)}
.s9pc-load::after{content:"";display:block;margin:14px auto 0;width:120px;height:2px;background:linear-gradient(90deg,transparent,var(--o),transparent);animation:s9pcScan 1.1s linear infinite;background-size:200% 100%}
@keyframes s9pcScan{from{background-position:200% 0}to{background-position:-200% 0}}
.oplayer[data-pid]:not(.empty){cursor:pointer;transition:border-color .15s,background .15s}
.oplayer[data-pid]:not(.empty):hover{border-color:var(--o,#ff9a3c)!important;background:rgba(255,154,60,.08)!important}
.oplayer[data-pid]:not(.empty):focus-visible{outline:2px solid #ff9a3c;outline-offset:2px}
@media (max-width:520px){.s9pc-fav{flex-wrap:wrap}.s9pc-fav b{white-space:normal;text-align:left}#s9pc{padding:10px;align-items:end}.s9pc-card{padding:18px 16px 16px}.s9pc-bd,.s9pc-av{width:68px;height:68px}.s9pc-st b{font-size:22px}.s9pc-btn{flex-basis:100%}}
@media (prefers-reduced-motion:reduce){#s9pc,.s9pc-card{transition:none}.s9pc-load::after{animation:none}}`;
  function injectCss() { if ($('s9pcCss')) return; const s = el('style', { id: 's9pcCss' }); s.textContent = CSS; document.head.appendChild(s); }

  /* ---------------------------------------------------------------- the card */
  let root = null, opener = null, seq = 0, cur = null;
  const isOpen = () => !!root;
  function close() {
    seq++; document.removeEventListener('keydown', onKey, true);
    if (!root) return; const r = root; root = null; r.classList.remove('on'); setTimeout(() => r.remove(), 180);
    try { if (opener && document.contains(opener)) opener.focus({ preventScroll: true }); } catch (e) {} opener = null;
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'Tab' && root) {   // keep focus inside the card
      const f = [...root.querySelectorAll('button:not(:disabled),select,textarea')].filter(x => x.offsetParent !== null); if (!f.length) return;
      const a = f[0], b = f[f.length - 1];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); b.focus(); } else if (!e.shiftKey && document.activeElement === b) { e.preventDefault(); a.focus(); }
    }
  }
  function shell(nickGuess) {
    injectCss();
    const old = $('s9pc'); if (old) old.remove();
    const card = el('div', { class: 's9pc-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Player card' });
    root = el('div', { id: 's9pc' }, card);
    root.addEventListener('mousedown', e => { if (e.target === root) close(); });
    document.body.appendChild(root); document.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => root && root.classList.add('on'));
    card.append(el('button', { type: 'button', class: 's9pc-x', 'aria-label': 'Close player card', text: '×', onclick: close }), el('div', { class: 's9pc-load', text: 'Loading ' + (nickGuess || 'player') }));
    return card;
  }
  const lockSvg = () => { const d = document.createElement('div'); d.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="1"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>'; return d.firstChild; };

  function header(d) {
    const top = el('div', { class: 's9pc-top' });
    const bd = el('div', { class: 's9pc-bd' });
    if (d.guest) bd.append(el('div', { class: 's9pc-av', style: `background:hsl(${hue(d.nick)} 18% 52%)`, text: '?' }));
    else if (window.S9Badges && window.S9Badges.el && d.rank) { try { bd.append(window.S9Badges.el({ rank: d.rank.i, step: d.rank.step, prestige: d.prestige, size: 84 })); } catch (e) { bd.append(el('div', { class: 's9pc-av', style: `background:hsl(${hue(d.nick)} 70% 55%)`, text: d.nick.charAt(0).toUpperCase() })); } }
    else bd.append(el('div', { class: 's9pc-av', style: `background:hsl(${hue(d.nick)} 70% 55%)`, text: d.nick.charAt(0).toUpperCase() }));
    const tags = el('div', { class: 's9pc-tags' });
    if (d.self) tags.append(el('span', { class: 's9pc-tag me', text: 'You' }));
    if (d.guest) tags.append(el('span', { class: 's9pc-tag', text: 'Guest' }));
    if (d.rel === 'friend') tags.append(el('span', { class: 's9pc-tag fr', text: 'Friend' }));
    const sub = d.guest ? 'Guest · not signed in' : d.unknown ? 'Sign in to see level and stats' : `Level ${d.level} · ${(d.rank && RANKS[d.rank.i]) || ''} ${(d.rank && STEPS[d.rank.step - 1]) || ''}` + (d.prestige ? ` · Prestige ${d.prestige}` : '');
    top.append(bd, el('div', { class: 's9pc-who' }, el('h2', { class: 's9pc-nick', text: d.nick, title: d.nick }), el('div', { class: 's9pc-sub', text: sub }), tags));
    return top;
  }
  function statsBlock(d) {
    if (d.guest) return el('div', { class: 's9pc-lock' }, lockSvg(), el('div', { text: 'Guests have no stats. Players who sign in get a level, rank and a full stat card.' }));
    if (!d.statsVisible) {
      const why = d.unknown ? 'Sign in to see player stats and add friends.' : d.statsVis === 'me' ? `${d.nick} keeps their stats private.` : d.statsVis === 'everyone' ? `${d.nick}'s stats are not available right now.` : `${d.nick} shares stats with friends only.` + (d.rel === 'none' && d.canAdd ? ' Add them as a friend to see them.' : d.rel === 'out' ? ' Your friend request is pending.' : d.rel === 'in' ? ' Accept their request to see them.' : '');
      return el('div', { class: 's9pc-lock' }, lockSvg(), el('div', { text: why }));
    }
    const s = d.stats || {}, kd = s.deaths ? s.kills / s.deaths : s.kills, wr = s.matches ? Math.round(100 * s.wins / s.matches) : 0, hs = s.kills ? Math.round(100 * s.headshots / s.kills) : 0;
    const tile = (v, l, hl) => el('div', { class: 's9pc-st' + (hl ? ' hl' : '') }, el('b', { text: v }), el('span', { text: l }));
    const g = el('div', { class: 's9pc-grid' }, tile(kd.toFixed(2), 'K/D', true), tile(fmt(s.wins) + (s.matches ? ` · ${wr}%` : ''), 'Wins'), tile(fmt(s.matches), 'Matches'), tile(fmt(s.kills), 'Kills'), tile(s.kills ? hs + '%' : '0%', 'Headshots'), tile(fmt(s.bestStreak), 'Best streak'));
    const hrs = s.playSeconds >= 3600 ? (s.playSeconds / 3600).toFixed(1) + ' h' : Math.round(s.playSeconds / 60) + ' min';
    const fav = el('div', { class: 's9pc-fav' }, el('span', { text: 'Favourite weapon' }), el('b', { text: s.favWeapon ? `${weaponName(s.favWeapon)} · ${fmt(s.favWeaponKills)} kills` : 'No kills yet' }));
    const tp = el('div', { class: 's9pc-fav' }, el('span', { text: 'Time played' }), el('b', { text: hrs }));
    return el('div', null, g, fav, tp);
  }

  function render(card, d, ctx) {
    card.textContent = ''; const x = el('button', { type: 'button', class: 's9pc-x', 'aria-label': 'Close player card', text: '×', onclick: close }); card.append(x);
    card.append(header(d), statsBlock(d));
    const msg = el('div', { class: 's9pc-msg', role: 'status', 'aria-live': 'polite' }); card.append(msg);
    const say = (t, kind) => { msg.textContent = t || ''; msg.className = 's9pc-msg' + (kind ? ' ' + kind : ''); };
    const btns = el('div', { class: 's9pc-btns' }); let first = null;
    if (d.self) {
      const cur = d.statsVis || 'friends';
      const seg = el('div', { class: 's9pc-seg', role: 'group', 'aria-label': 'Who can see my stats' });
      for (const v of ['everyone', 'friends', 'me']) seg.append(el('button', { type: 'button', text: SEEN[v], 'aria-pressed': String(cur === v), onclick: async () => {
        try { await api('/api/friends/privacy', { method: 'PUT', body: { stats: v } }); d.statsVis = v; for (const b of seg.children) b.setAttribute('aria-pressed', String(b.textContent === SEEN[v])); say('Saved. Your stats are visible to: ' + SEEN[v] + '.', 'ok'); try { window.S9Friends && window.S9Friends.refresh && window.S9Friends.refresh(); } catch (e) {} }
        catch (e) { say(e.message, 'err'); } } }));
      card.append(el('div', { class: 's9pc-priv' }, el('small', { text: 'Who can see my stats' }), seg));
    } else if (!d.guest && token()) {
      let add;
      if (d.rel === 'friend') add = el('button', { type: 'button', class: 's9pc-btn', disabled: true, text: 'Friends' });
      else if (d.rel === 'out') add = el('button', { type: 'button', class: 's9pc-btn', disabled: true, text: 'Request pending' });
      else if (d.rel === 'in') add = el('button', { type: 'button', class: 's9pc-btn pri', text: 'Accept request', onclick: async () => { add.disabled = true; try { await api('/api/friends/accept', { method: 'POST', body: { id: d.id } }); say('You and ' + d.nick + ' are friends now.', 'ok'); refreshCard(card, ctx, 'You and ' + d.nick + ' are friends now.'); } catch (e) { add.disabled = false; say(e.message, 'err'); } } });
      else if (d.rel === 'blocked') add = el('button', { type: 'button', class: 's9pc-btn', disabled: true, text: 'Blocked' });
      else add = el('button', { type: 'button', class: 's9pc-btn pri', text: 'Add friend', onclick: async () => {
        add.disabled = true;
        try { const r = await api('/api/friends/request', { method: 'POST', body: { id: d.id } }); say(r.state === 'friends' ? 'You and ' + d.nick + ' are friends now.' : 'Friend request sent to ' + d.nick + '.', 'ok'); refreshCard(card, ctx, r.state === 'friends' ? 'You and ' + d.nick + ' are friends now.' : 'Friend request sent to ' + d.nick + '.'); try { window.S9Friends && window.S9Friends.refresh && window.S9Friends.refresh(); } catch (e) {} }
        catch (e) { add.disabled = false; say(e.message, 'err'); } } });
      if (d.rel === 'none' && d.canAdd === false) { add.disabled = true; add.textContent = 'Add friend'; }
      btns.append(add); first = add.disabled ? null : add;
    } else if (!d.guest && !token()) {
      btns.append(el('button', { type: 'button', class: 's9pc-btn pri', text: 'Sign in to add friends', onclick: () => { close(); try { ACC() && ACC().open && ACC().open('signin'); } catch (e) {} } }));
    }
    if (!d.self) {
      const rep = el('div', { class: 's9pc-rep', hidden: true });
      const sel = el('select', { class: 's9pc-sel', id: 's9pcWhy', 'aria-label': 'Reason' }, ...[['cheating', 'Cheating or hacks'], ['abuse', 'Abusive name or chat'], ['grief', 'Griefing or team-killing'], ['other', 'Something else']].map(([v, t]) => el('option', { value: v, text: t })));
      const note = el('textarea', { class: 's9pc-ta', maxlength: '400', placeholder: 'What happened? (optional)', 'aria-label': 'Details' });
      const send = el('button', { type: 'button', class: 's9pc-btn bad', text: 'Send report', onclick: async () => {
        send.disabled = true;
        const r = room(), reason = sel.options[sel.selectedIndex].text;
        const body = { category: 'cheating', frequency: 'once', title: ('Player report: ' + d.nick + ' (' + reason + ')').slice(0, 80),
          description: [`Reported player: ${d.nick}`, d.id ? `Account id: ${d.id}` : 'Guest (no account)', `Reason: ${reason}`, `Room: ${r ? r.code : '-'}`, note.value.trim() ? 'Details: ' + note.value.trim() : ''].filter(Boolean).join('\n'),
          context: { map: r && r.meta ? String(r.meta.map || '') : '', mode: 'online', version: '' } };
        try { await api('/api/bugs', { method: 'POST', body }); rep.hidden = true; repBtn.disabled = true; repBtn.textContent = 'Reported'; say('Thanks. Your report was sent to the team.', 'ok'); }
        catch (e) { send.disabled = false; say(e.status === 429 ? 'You sent a few reports already. Try again in a few minutes.' : e.message, 'err'); } } });
      rep.append(el('label', { for: 's9pcWhy', text: 'Why are you reporting ' + d.nick + '?' }), sel, note, send);
      const repBtn = el('button', { type: 'button', class: 's9pc-btn bad', text: 'Report player', 'aria-expanded': 'false', onclick: () => { rep.hidden = !rep.hidden; repBtn.setAttribute('aria-expanded', String(!rep.hidden)); if (!rep.hidden) sel.focus(); } });
      btns.append(repBtn); card.append(btns, rep);
    } else card.append(btns);
    if (!btns.parentNode) card.append(btns);
    try { (first || x).focus({ preventScroll: true }); } catch (e) {}
  }
  function refreshCard(card, ctx, note) {   // re-read the card after a friend change (keeps the message)
    load(card, ctx, note);
  }
  async function load(card, ctx, note) {
    const my = ++seq;
    if (!token()) { render(card, { guest: false, unknown: true, nick: ctx.nick, level: 0, rank: null, rel: 'none', canAdd: false, statsVisible: false, statsVis: 'friends' }, ctx); return; }
    try {
      const d = await api('/api/friends/card?room=' + encodeURIComponent(ctx.code) + '&pid=' + encodeURIComponent(ctx.pid));
      if (my !== seq || !root) return;
      d.nick = String(d.nick || ctx.nick || 'Player'); render(card, d, ctx);
      if (note) { const m = card.querySelector('.s9pc-msg'); if (m) { m.textContent = note; m.className = 's9pc-msg ok'; } }
    } catch (e) {
      if (my !== seq || !root) return;
      card.textContent = ''; card.append(el('button', { type: 'button', class: 's9pc-x', 'aria-label': 'Close player card', text: '×', onclick: close }),
        el('div', { class: 's9pc-top' }, el('div', { class: 's9pc-who' }, el('h2', { class: 's9pc-nick', text: ctx.nick || 'Player' }))),
        el('div', { class: 's9pc-lock' }, lockSvg(), el('div', { text: e.status === 404 || e.status === 403 ? 'This player already left the room.' : e.message || 'Could not load the card.' })));
      try { card.querySelector('.s9pc-x').focus(); } catch (x) {}
    }
  }
  /* open({pid, nick}) : pid = the player's id in the room (meta.players[].id) */
  function open(t) {
    t = t || {}; const r = room(); if (!r || !t.pid) return false;
    const p = (r.meta.players || []).find(x => x.id === t.pid);
    const ctx = { pid: String(t.pid), nick: String(t.nick || (p && p.n) || 'Player'), code: r.code };
    opener = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    const card = shell(ctx.nick); cur = ctx; load(card, ctx);
    return true;
  }

  /* ---------------------------------------------------------------- wiring: the room lobby player list */
  // The free-for-all list is drawn by the game without ids, the team lists by menu.js with data-pid. Tag the plain ones by name.
  function tagList() {
    const box = $('oPlayers'), r = room(); if (!box || !r) return;
    const pl = (r.meta.players || []).slice(), used = new Set();
    for (const c of box.querySelectorAll('.oplayer[data-pid]')) used.add(c.getAttribute('data-pid'));
    for (const c of box.querySelectorAll('.oplayer:not(.empty)')) {
      if (!c.hasAttribute('data-pid')) { const nm = (c.querySelector('b') || {}).textContent || ''; const p = pl.find(x => x.n === nm && !used.has(x.id)); if (p) { c.setAttribute('data-pid', p.id); used.add(p.id); } }
      if (c.hasAttribute('data-pid')) { if (!c.hasAttribute('tabindex')) c.setAttribute('tabindex', '0'); c.setAttribute('role', 'button'); c.setAttribute('aria-label', 'Open player card: ' + ((c.querySelector('b') || {}).textContent || '')); }
    }
  }
  let wired = false;
  function wire() {
    if (wired) return; const box = $('oPlayers'); if (!box) return; wired = true;
    new MutationObserver(tagList).observe(box, { childList: true, subtree: true });
    tagList();
    const go = e => {
      const c = e.target.closest && e.target.closest('.oplayer[data-pid]'); if (!c || !box.contains(c) || c.classList.contains('empty')) return;
      if (e.target.closest('button,[data-move],[data-team]')) return;   // move / join-team buttons keep their own job
      e.preventDefault(); open({ pid: c.getAttribute('data-pid'), nick: (c.querySelector('b') || {}).textContent });
    };
    box.addEventListener('click', go);
    box.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('oplayer')) go(e); });
  }
  function boot() { injectCss(); wire(); if (!wired) { const t = setInterval(() => { wire(); if (wired) clearInterval(t); }, 500); setTimeout(() => clearInterval(t), 60000); } }
  window.S9PlayerCard = { open, close, isOpen, wire, tagList };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
