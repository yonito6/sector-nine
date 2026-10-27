/* Sector Nine room flow: team balance screen in the room lobby (backlog item 44) + room-after-match polish (item 11).
   Add-on, loaded after modes.js + session.js. Uses only server messages that already exist:
   host meta {balance:'auto'|'manual', teamLock}, host {k:'setTeam',id,team}, player {k:'team',team}; meta.players[].team.
   Auto: the server balances at start (preview shown). Manual: host moves players (click arrow or drag) to any split. Lock: players cannot self-switch. */
(function () {
  if (window.__roomflow) return; window.__roomflow = true;
  const $ = id => document.getElementById(id);
  const T = { atk: { name: 'Strike Force', css: '#ff8a3d' }, def: { name: 'Sentinels', css: '#3dc8ff' } };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const room = () => (typeof NET !== 'undefined' && NET.room) || null;
  const isHost = () => !!(room() && room().isHost);
  const teamMode = m => m && (m.mode === 'tdm' || m.mode === 'demo');
  const sent = new Set();   // setTeam already sent for this id (avoid repeats while meta is in flight)
  const wrap = $('oPlayers'); if (!wrap) return;
  const st = document.createElement('style'); st.textContent = `
#oPlayers[hidden]{display:none!important}
#rfTeams{margin:8px 0;display:flex;flex-direction:column;gap:8px}#rfTeams[hidden]{display:none}
#rfCtl{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:13px}#rfCtl .rfSeg{display:inline-flex;border:1px solid rgba(255,255,255,.25);border-radius:8px;overflow:hidden}
#rfCtl button{background:transparent;color:inherit;border:0;padding:7px 12px;font:inherit;cursor:pointer;min-height:36px}#rfCtl button.on{background:rgba(255,255,255,.22);font-weight:700}
#rfCtl .rfLock{border:1px solid rgba(255,255,255,.25);border-radius:8px}#rfCtl .rfNote{opacity:.7;flex:1 1 180px}
#rfCols{display:grid;grid-template-columns:1fr 1fr;gap:8px}.rfCol{border:2px solid var(--tc);border-radius:10px;padding:8px;min-height:84px;background:rgba(0,0,0,.25)}
.rfCol.over{background:rgba(255,255,255,.12)}.rfCol h4{margin:0 0 6px;font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:var(--tc);display:flex;justify-content:space-between}
.rfP{display:flex;align-items:center;gap:6px;padding:6px 8px;margin:4px 0;border-radius:8px;background:rgba(255,255,255,.08);font-size:14px;min-height:34px}.rfP i{width:10px;height:10px;border-radius:50%;flex:none}
.rfP b{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rfP em{font-size:11px;opacity:.7;font-style:normal}.rfP.mv{cursor:grab}
.rfP button{background:rgba(255,255,255,.15);color:inherit;border:0;border-radius:6px;min-width:34px;min-height:30px;cursor:pointer;font:inherit}
@media(max-width:520px){#rfCols{grid-template-columns:1fr}}`;
  document.head.appendChild(st);
  const box = document.createElement('div'); box.id = 'rfTeams'; box.hidden = true;
  box.innerHTML = '<div id="rfCtl"></div><div id="rfCols"></div>'; wrap.insertAdjacentElement('afterend', box);

  // who is on which side right now: manual = the server's teams; auto = a balanced preview (the server does the real balance at start)
  function split(m) {
    const out = new Map(), pl = m.players || [], cnt = { atk: 0, def: 0 };
    if (m.balance === 'manual') {
      for (const p of pl) if (p.team === 'atk' || p.team === 'def') { out.set(p.id, p.team); cnt[p.team]++; }
      for (const p of pl) if (!out.has(p.id)) { const t = cnt.atk <= cnt.def ? 'atk' : 'def'; out.set(p.id, t); cnt[t]++; }
    } else pl.forEach((p, i) => out.set(p.id, i % 2 ? 'def' : 'atk'));
    return out;
  }
  const rcolor = c => { try { const k = NET_COLORS[(c | 0) % NET_COLORS.length].map(x => Math.round(Math.min(1, x) * 255)); return `rgb(${k})`; } catch (e) { return '#aaa'; } };
  function moveTo(id, team) {
    const r = room(), m = r && r.meta; if (!r || !m || m.started) return;
    if (r.isHost) { if (m.balance !== 'manual') return; r.send({ k: 'setTeam', id, team }); }
    else if (id === r.myId && m.balance === 'manual' && !m.teamLock) r.send({ k: 'team', team });
  }
  function render(m) {
    const show = teamMode(m); box.hidden = !show; wrap.hidden = show;
    if (!show) return;
    const host = isHost(), r = room(), me = r && r.myId, sp = split(m), man = m.balance === 'manual';
    $('rfCtl').innerHTML = host && !m.started
      ? `<span>Teams:</span><span class="rfSeg"><button data-bal="auto" class="${man ? '' : 'on'}">Auto</button><button data-bal="manual" class="${man ? 'on' : ''}">Manual</button></span>`
        + (man ? `<button class="rfLock" data-lock="1">${m.teamLock ? '&#128274; Teams locked' : '&#128275; Lock teams'}</button>` : '')
        + `<span class="rfNote">${man ? 'Click the arrow or drag a player to the other side. Any split works.' : 'Teams are balanced automatically when the match starts.'}</span>`
      : `<span>Teams: <b>${man ? 'chosen by the host' : 'automatic'}</b>${man && m.teamLock ? ' &#128274; locked' : ''}</span>`
        + `<span class="rfNote">${man ? (m.teamLock ? 'The host locked the teams.' : 'You can switch your own side until the host locks teams.') : 'Balanced automatically when the match starts.'}</span>`;
    let html = '';
    for (const t of ['atk', 'def']) {
      const list = (m.players || []).filter(p => sp.get(p.id) === t);
      html += `<div class="rfCol" data-team="${t}" style="--tc:${T[t].css}"><h4><span>${T[t].name}</span><span data-count="${t}">${list.length}</span></h4>`
        + list.map(p => { const can = man && !m.started && (host || (p.id === me && !m.teamLock)); const to = t === 'atk' ? 'def' : 'atk';
          return `<div class="rfP${can && host ? ' mv' : ''}" data-pid="${esc(p.id)}" data-team="${t}"${can && host ? ' draggable="true"' : ''}><i style="background:${rcolor(p.c)}"></i><b>${esc(p.n)}</b>${p.host ? '<em>Host</em>' : ''}${p.id === me ? '<em>you</em>' : ''}${can ? `<button data-mv="${to}" title="Move to ${T[to].name}" aria-label="Move ${esc(p.n)} to ${T[to].name}">${t === 'atk' ? '&#8594;' : '&#8592;'}</button>` : ''}</div>`; }).join('') + '</div>';
    }
    $('rfCols').innerHTML = html;
    const vals = [...sp.values()]; $('rfCols').dataset.split = `${vals.filter(x => x === 'atk').length}v${vals.filter(x => x === 'def').length}`;
    // the host seeds players who have no side yet (new joiners) in manual mode, onto the smaller team
    if (host && man && !m.started) for (const p of m.players || []) if (!p.team && !sent.has(p.id)) { sent.add(p.id); r.send({ k: 'setTeam', id: p.id, team: sp.get(p.id) }); }
    if (!man) sent.clear();
  }
  box.addEventListener('click', e => {
    const r = room(), m = r && r.meta; if (!m) return;
    const bal = e.target.closest('[data-bal]');
    if (bal && r.isHost) {
      if (bal.dataset.bal === 'manual' && m.balance !== 'manual') { const sp = split(m); sent.clear(); for (const p of m.players) { if (sp.get(p.id) !== p.team) r.send({ k: 'setTeam', id: p.id, team: sp.get(p.id) }); sent.add(p.id); } }
      r.setMeta({ balance: bal.dataset.bal }); return;
    }
    if (e.target.closest('[data-lock]') && r.isHost) { r.setMeta({ teamLock: !m.teamLock }); return; }
    const mv = e.target.closest('[data-mv]'); if (mv) moveTo(mv.closest('.rfP').dataset.pid, mv.dataset.mv);
  });
  let dragId = null;
  box.addEventListener('dragstart', e => { const p = e.target.closest && e.target.closest('.rfP[draggable]'); if (!p) return; dragId = p.dataset.pid; try { e.dataTransfer.setData('text/plain', dragId); e.dataTransfer.effectAllowed = 'move'; } catch (x) {} });
  box.addEventListener('dragover', e => { const c = e.target.closest && e.target.closest('.rfCol'); if (c && dragId) { e.preventDefault(); c.classList.add('over'); } });
  box.addEventListener('dragleave', e => { const c = e.target.closest && e.target.closest('.rfCol'); if (c) c.classList.remove('over'); });
  box.addEventListener('drop', e => { const c = e.target.closest && e.target.closest('.rfCol'); for (const x of box.querySelectorAll('.over')) x.classList.remove('over'); if (!c || !dragId) return; e.preventDefault(); moveTo(dragId, c.dataset.team); dragId = null; });
  window.ROOMFLOW = { split: () => { const r = room(); return r && r.meta ? Object.fromEntries(split(r.meta)) : null; }, moveTo };

  if (typeof renderRoom === 'function') {
    const _rr = renderRoom;
    renderRoom = function (m) {
      const out = _rr.apply(this, arguments);
      try {
        render(m);
        // item 11: after a match the room stays: say so, and keep Start honest (map + mode are editable in the same panel)
        if (m && !m.started && room()) {
          const n = m.mode === 'demo' && m.balance !== 'manual' ? 4 : (m.mode === 'ffa' ? 2 : 2);
          const w = $('oWait'); if (w && !isHost()) w.textContent = 'Back in the room. Waiting for the host to pick the map and start the next match...';
          if (isHost()) { $('btnStart').disabled = m.count < n; $('btnStart').textContent = m.count < n ? `Waiting for players (${m.count}/${n})` : 'Start match'; }
        }
      } catch (e) { console.warn('roomflow', e); }
      return out;
    };
  }
})();
