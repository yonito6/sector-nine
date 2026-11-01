/* Sector Nine JOIN IN PROGRESS (modules/joinmid.js): what happens to someone who joins a room while its match is running.
   Room option meta.jm (server decides, this file is the UI):
     'now'   Anytime      newcomers drop in at once (default for Free for all + Team deathmatch; TDM: smaller team)
     'round' Next round   Demolition only (default there): newcomers watch until the next round, then spawn on the smaller team
     'match' After match  newcomers watch (queued in the room) until the match ends, then join the next one
   - Create room screen: "Join in progress" cards (options depend on the mode, smart default per mode), sent as meta.jm with the create.
   - Room lobby: the host can change it any time (also mid-match); everyone else sees the current setting.
   - Room list: a tag per room (Join now / Joins next round / Joins after match); the Join button says "Join & watch" when you will wait.
   - A waiting player is a queued spectator (spectate.js shows the match); a pill says when they get in. The server promotes them.
   Hooks only (no index.html edits). Load AFTER menu and spectate. Needs the server option jm (status page: jm:1). */
(function () {
  'use strict';
  if (window.JOINMID) return;
  const $ = id => document.getElementById(id);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const OPT = {
    now: { name: 'Anytime', line: 'Players drop in right away.', tag: 'Join now' },
    round: { name: 'Next round', line: 'Newcomers watch until the next round starts.', tag: 'Joins next round' },
    match: { name: 'After match', line: 'Newcomers watch until the match ends.', tag: 'Joins after match' },
  };
  const validFor = mode => (mode === 'demo' ? ['now', 'round', 'match'] : ['now', 'match']);
  const defFor = mode => (mode === 'demo' ? 'round' : 'now');
  const effective = (mode, jm) => (validFor(mode).includes(jm) ? jm : defFor(mode));   // same rule as the server (round outside Demolition = now)
  const J = window.JOINMID = {
    ver: 1, choice: null, wait: null, OPT, validFor, defFor, effective,
    createValue: () => effective(curMode(), J.choice),
    tagFor: info => { if (!info) return null; const jm = effective(info.mode || 'ffa', info.jm); return info.started ? OPT[jm].tag : OPT.now.tag; },
  };
  const curMode = () => { const s = $('rMode'); return s ? s.value : 'ffa'; };
  const room = () => (typeof NET !== 'undefined' && NET.room) || null;
  const menu = () => window.S9Menu || null;

  /* ---------------- styles ---------------- */
  const css = document.createElement('style');
  css.textContent = `
.s9m-tag.s9jm{border-color:rgba(51,224,161,.5);color:#33e0a1}.s9m-tag.s9jm.w{border-color:rgba(255,178,74,.55);color:#ffb24a}
@media (min-width:701px){#s9jmCards .s9m-card,#s9jmEditCards .s9m-card{grid-template-columns:1fr;align-content:start}}
#s9jmEdit .s9m-sub{display:block;margin-top:8px}
.s9m-room button.go.s9jm-w{line-height:1.05;white-space:normal}
@media (max-width:700px){.s9m-room .s9m-rn .s9m-tags{display:flex}.s9m-room .s9m-rn .s9m-tags>:not(.s9jm){display:none}.s9m-room button.go.s9jm-w{width:84px;min-width:0;font-size:17px;padding:8px 6px 6px}.s9m-room .s9m-rn .s9m-tags{min-width:0;overflow:hidden}.s9m-room .s9m-tag.s9jm{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}
#s9jmEdit{grid-column:1}#s9jmEdit[hidden]{display:none}
#s9jmWait{position:fixed;left:50%;bottom:calc(74px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:36;max-width:min(94vw,520px);padding:7px 16px;border:1px solid rgba(255,178,74,.6);background:rgba(11,13,16,.88);color:#ffb24a;font:600 12px var(--mono,monospace);letter-spacing:.1em;text-transform:uppercase;text-align:center;pointer-events:none}
#s9jmWait[hidden]{display:none!important}
@media (max-width:700px){#s9jmWait{bottom:calc(128px + env(safe-area-inset-bottom,0px))}}
body.s9jmw #s9sJoin,body.s9jmw #s9sLobbyJoin{display:none!important}`;
  document.head.appendChild(css);
  const pill = document.createElement('div'); pill.id = 's9jmWait'; pill.hidden = true; pill.setAttribute('role', 'status'); document.body.appendChild(pill);

  /* ---------------- create screen ---------------- */
  function cardsHTML(mode, cur, attr) {
    return validFor(mode).map(k => `<button type="button" class="s9m-card" role="radio" ${attr}="${k}" aria-checked="${k === cur}"><b>${OPT[k].name}</b><span>${OPT[k].line}</span></button>`).join('');
  }
  function mountCreate() {
    const vis = $('s9mVis'); if (!vis || $('s9jmCreate')) return;
    const f = document.createElement('div'); f.className = 's9m-field'; f.id = 's9jmCreate';
    f.innerHTML = '<span class="s9m-lab">Join in progress</span><div class="s9m-cards" role="radiogroup" aria-label="Join in progress" id="s9jmCards"></div>';
    vis.closest('.s9m-field').insertAdjacentElement('afterend', f);
  }
  let createKey = '';
  function renderCreate() {
    mountCreate(); const box = $('s9jmCards'); if (!box) return;
    const mode = curMode(), cur = J.createValue(), key = mode + '|' + cur;
    if (key === createKey) return; createKey = key;
    box.innerHTML = cardsHTML(mode, cur, 'data-jm');
  }

  /* ---------------- room lobby (host edits, everyone sees) ---------------- */
  function mountEdit() {
    const r = $('oRoom'); if (!r || $('s9jmEdit')) return;
    const p = document.createElement('div'); p.id = 's9jmEdit'; p.className = 's9m-panel'; p.hidden = true;
    p.innerHTML = '<span class="s9m-lab">Join in progress</span><div class="s9m-cards" role="radiogroup" aria-label="Join in progress (host)" id="s9jmEditCards"></div><span class="s9m-sub" id="s9jmEditNote"></span>';
    r.appendChild(p);
  }
  let editKey = '';
  function renderEdit() {
    mountEdit(); const p = $('s9jmEdit'); if (!p) return;
    const r = room(), m = r && r.meta; p.hidden = !(r && m);
    if (!m) { editKey = ''; return; }
    const mode = m.mode || 'ffa', cur = effective(mode, m.jm), host = !!r.isHost, key = [mode, cur, host].join('|');
    if (key === editKey) return; editKey = key;
    const box = $('s9jmEditCards');
    if (host) { box.hidden = false; box.innerHTML = cardsHTML(mode, cur, 'data-ejm'); $('s9jmEditNote').textContent = OPT[cur].line + ' You can change this any time, also during a match.'; }
    else { box.hidden = true; box.innerHTML = ''; $('s9jmEditNote').innerHTML = `<b>${OPT[cur].name}</b>: ${OPT[cur].line}`; }
  }

  /* ---------------- room list ---------------- */
  function infoOf(code) { const M = menu(), rs = (M && M._st && M._st.rooms) || []; return rs.find(r => r && r.code === code) || null; }
  function decorateRooms() {
    for (const b of document.querySelectorAll('#roomList [data-room]')) {
      const card = b.closest('.s9m-room'); if (!card) continue;
      const info = infoOf(b.dataset.room); if (!info) continue;
      const jm = effective(info.mode || 'ffa', info.jm), live = !!info.started, tag = J.tagFor(info);
      const key = jm + '|' + live + '|' + (b.disabled ? 1 : 0); if (card.dataset.s9jm === key) continue; card.dataset.s9jm = key;
      const tags = card.querySelector('.s9m-tags'); let t = card.querySelector('.s9jm');
      if (!t && tags) { t = document.createElement('span'); tags.appendChild(t); }
      if (t) { t.className = 's9m-tag s9jm' + (live && jm !== 'now' ? ' w' : ''); t.textContent = tag; t.dataset.jm = live ? jm : 'now'; }
      // session.js labels a running match you can return to "Rejoin" (your own slot, kills kept): never overwrite that
      if (/^Rejoin/.test(b.textContent)) { b.classList.remove('s9jm-w'); continue; }
      const waits = live && jm !== 'now' && !b.disabled;
      b.classList.toggle('s9jm-w', waits);
      if (waits) { b.textContent = 'Join & watch'; b.title = jm === 'round' ? 'You watch until the next round, then spawn on the smaller team' : 'You watch until the match ends, then join the next one'; b.setAttribute('aria-label', 'Join and watch ' + (info.name || '')); }
      else if (!b.disabled) { b.textContent = 'Join'; b.removeAttribute('title'); b.setAttribute('aria-label', 'Join ' + (info.name || '')); }
    }
  }

  /* ---------------- clicks ---------------- */
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('[data-jm],[data-ejm]'); if (!b) return;
    if (b.dataset.jm) { J.choice = b.dataset.jm; createKey = ''; renderCreate(); }
    else { const r = room(); if (r && r.isHost && r.setMeta) { try { r.setMeta({ jm: b.dataset.ejm }); } catch (er) {} if (r.meta) r.meta.jm = b.dataset.ejm; editKey = ''; renderEdit(); } }
  }, true);

  /* ---------------- game hooks ---------------- */
  function hook() {
    const f = window.serverTransport;
    if (typeof f === 'function' && !f.__s9jm) {
      const w = function (code, create) { if (create && typeof create === 'object' && !create.jm) create.jm = J.createValue(); return f.apply(this, arguments); };
      w.__s9jm = true; window.serverTransport = w;
    }
  }
  function onSrv(d) {
    if (d.k === 'welcome') J.wait = d.spec === 1 && (d.wait === 'round' || d.wait === 'match') ? d.wait : null;
    else if (d.k === 'bye' || d.k === 'kicked') J.wait = null;
  }
  function tick() {
    try {
      hook(); renderCreate(); renderEdit(); decorateRooms();
      const r = room(), spec = window.SPECTATE;
      const on = !!(J.wait && r && spec && spec.on);
      if (!on && J.wait && !r) J.wait = null;
      pill.hidden = !on; document.body.classList.toggle('s9jmw', on);
      if (on) { const t = J.wait === 'round' ? 'Watching: you join at the next round' : 'Watching: you join after this match'; if (pill.textContent !== t) pill.textContent = t; }
    } catch (e) { if (J.err++ < 3) console.warn('[joinmid]', e); }
  }
  J.err = 0;
  function boot() {
    if (typeof SRV === 'undefined' || typeof NET === 'undefined') return setTimeout(boot, 100);
    try { SRV.on.add(onSrv); } catch (e) {}
    hook(); setInterval(tick, 250); tick();
    // the room list is rebuilt from scratch on every list push (the game's renderer + menu.js's, ~3x a second): put the tags back
    // the moment it changes (observer = before the next paint) instead of up to 250 ms later, so they never flicker or go missing
    const rl = $('roomList');
    if (rl) new MutationObserver(() => { try { decorateRooms(); } catch (e) { if (J.err++ < 3) console.warn('[joinmid]', e); } }).observe(rl, { childList: true });
  }
  boot();
})();
