/* Sector Nine - "What's New" (modules/news.js)
   A "What's new" button on the main menu (with a small NEW dot while there are entries this player has not seen yet)
   opens a panel of dated update cards, newest first; big updates are highlighted (and show an image when the entry has one).
   Data: data/news.json  { entries:[{id, date:'YYYY-MM-DD', version, title, items:[...], big:true|false, image?}] }
   (written by the release manager when a feature goes live; portable JSON).
   Seen state: localStorage 'sector9-news-seen' = array of entry ids already shown to this player.
   Esc / the X button / a click outside the panel closes it. All text from the JSON is inserted as text (never as HTML).
   Public: window.S9News = { ready, open(), close(), isOpen(), entries(), unseen(), markSeen(), reload() } */
(function () {
  'use strict';
  if (window.S9News) return;
  const SEEN_KEY = 'sector9-news-seen';
  const here = (document.currentScript && document.currentScript.src) || '';
  const DATA_URL = (here ? new URL('../data/news.json', here.split('?')[0]).href : 'data/news.json');
  let ENTRIES = [], panel = null, btn = null, lastFocus = null, watch = 0;

  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeImg = s => (typeof s === 'string' && /^(assets|data)\/[A-Za-z0-9_\-/.]+\.(png|jpe?g|webp|svg)$/i.test(s) && s.indexOf('..') < 0) ? s : null;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtDate = d => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || '')); return m ? `${+m[3]} ${MONTHS[+m[2] - 1] || ''} ${m[1]}` : String(d || ''); };
  const idOf = e => String(e.id || `${e.date || ''}|${e.version || ''}|${e.title || ''}`);

  function clean(raw) {
    const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.entries) ? raw.entries : []);
    return list.filter(e => e && typeof e === 'object' && (e.title || (Array.isArray(e.items) && e.items.length)))
      .map(e => ({ id: idOf(e), date: String(e.date || ''), version: e.version == null ? '' : String(e.version), title: String(e.title || 'Update'),
        items: (Array.isArray(e.items) ? e.items : []).filter(x => x != null && x !== '').map(String).slice(0, 30), big: e.big === true, image: safeImg(e.image) }))
      .sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : (b.version > a.version ? 1 : b.version < a.version ? -1 : 0)));
  }
  const readSeen = () => { try { const a = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'); return Array.isArray(a) ? a.map(String) : []; } catch (e) { return []; } };
  const unseen = () => { const s = new Set(readSeen()); return ENTRIES.filter(e => !s.has(e.id)); };
  function markSeen() { try { const s = new Set(readSeen()); ENTRIES.forEach(e => s.add(e.id)); localStorage.setItem(SEEN_KEY, JSON.stringify([...s].slice(-300))); } catch (e) {} updateDot(); }

  const CSS = `
#btnNews{position:relative}
#btnNews .s9n-dot{display:none;position:absolute;top:-8px;right:-8px;font:600 9px/1 var(--mono,monospace);letter-spacing:.12em;color:#14100b;background:var(--sodium,#ff9a3c);padding:3px 5px 2px;border-radius:2px;box-shadow:0 0 0 2px var(--bg,#0b0d10),0 0 12px rgba(255,154,60,.55);pointer-events:none}
#btnNews.s9n-has .s9n-dot{display:block;animation:s9nPulse 1.8s ease-in-out infinite}
@keyframes s9nPulse{50%{box-shadow:0 0 0 2px var(--bg,#0b0d10),0 0 2px rgba(255,154,60,.2)}}
#s9news{position:fixed;inset:0;z-index:70;display:grid;place-items:center;padding:24px 16px;background:rgba(5,6,8,.78);backdrop-filter:blur(3px)}
#s9news[hidden]{display:none!important}
#s9news .s9n-box{width:min(760px,100%);max-height:min(860px,calc(100vh - 48px));display:flex;flex-direction:column;background:#0e1115;border:1px solid var(--line,rgba(236,230,216,.18));box-shadow:0 30px 80px rgba(0,0,0,.6);color:var(--ink,#ece6d8)}
#s9news .s9n-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;padding:22px 24px 16px;border-bottom:1px solid var(--line,rgba(236,230,216,.18))}
#s9news .s9n-kick{font:600 11px/1 var(--mono,monospace);letter-spacing:.3em;text-transform:uppercase;color:var(--sodium,#ff9a3c);margin-bottom:8px}
#s9news h2{font-family:var(--display,Impact,sans-serif);font-weight:900;font-size:clamp(34px,6vw,54px);line-height:.85;margin:0;letter-spacing:.01em}
#s9news .s9n-x{flex:none;width:40px;height:40px;display:grid;place-items:center;background:transparent;border:1px solid var(--line,rgba(236,230,216,.18));color:var(--ink,#ece6d8);font:400 22px/1 var(--mono,monospace);cursor:pointer}
#s9news .s9n-x:hover,#s9news .s9n-x:focus-visible{border-color:var(--sodium,#ff9a3c);color:var(--sodium,#ff9a3c);outline:none}
#s9news .s9n-list{overflow-y:auto;overscroll-behavior:contain;padding:18px 24px 26px;display:grid;gap:14px}
#s9news .s9n-card{position:relative;border:1px solid var(--line,rgba(236,230,216,.18));background:rgba(236,230,216,.025);padding:16px 18px 16px 20px}
#s9news .s9n-card.s9n-big{border-color:rgba(255,154,60,.55);background:linear-gradient(135deg,rgba(255,154,60,.11),rgba(255,154,60,.02) 60%);padding:0}
#s9news .s9n-card.s9n-big::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--sodium,#ff9a3c)}
#s9news .s9n-big .s9n-body{padding:16px 18px 18px 22px}
#s9news .s9n-img{display:block;width:100%;height:clamp(110px,22vw,190px);object-fit:cover;border-bottom:1px solid rgba(255,154,60,.35)}
#s9news .s9n-meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;font:400 11px/1.2 var(--mono,monospace);letter-spacing:.14em;text-transform:uppercase;color:var(--dim,#8b9097)}
#s9news .s9n-ver{text-transform:none;letter-spacing:.08em}
#s9news .s9n-tag{color:#14100b;background:var(--sodium,#ff9a3c);padding:3px 6px 2px;font-weight:600;letter-spacing:.16em}
#s9news .s9n-new{color:var(--cyan,#7fe7ff);border:1px solid rgba(127,231,255,.5);padding:2px 5px 1px}
#s9news h3{font-family:var(--display,Impact,sans-serif);font-weight:900;font-size:clamp(22px,3.4vw,30px);line-height:1;margin:10px 0 10px;letter-spacing:.02em;overflow-wrap:anywhere}
#s9news .s9n-big h3{font-size:clamp(26px,4.2vw,36px)}
#s9news ul{margin:0;padding:0;list-style:none;display:grid;gap:7px}
#s9news li{position:relative;padding-left:18px;font:400 13px/1.5 var(--mono,monospace);color:var(--ink,#ece6d8);overflow-wrap:anywhere}
#s9news li::before{content:"";position:absolute;left:2px;top:.62em;width:7px;height:2px;background:var(--sodium,#ff9a3c)}
#s9news .s9n-empty{font:400 13px/1.5 var(--mono,monospace);color:var(--dim,#8b9097);padding:20px 0}
@media (max-width:560px){#s9news{padding:0}#s9news .s9n-box{max-height:100vh;height:100%;border:0}#s9news .s9n-head{padding:18px 16px 14px}#s9news .s9n-list{padding:14px 16px 22px}#s9news .s9n-card{padding:14px 14px 14px 16px}#s9news .s9n-big .s9n-body{padding:14px 14px 16px 18px}#s9news li{font-size:12.5px}}
`;

  function cardHTML(e, fresh) {
    const meta = `<div class="s9n-meta">${e.big ? '<span class="s9n-tag">Big update</span>' : ''}${fresh ? '<span class="s9n-new">New</span>' : ''}<span>${esc(fmtDate(e.date))}</span>${e.version ? `<span class="s9n-ver">v${esc(e.version)}</span>` : ''}</div>`;
    const body = `${meta}<h3>${esc(e.title)}</h3>${e.items.length ? `<ul>${e.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}`;
    if (!e.big) return `<article class="s9n-card">${body}</article>`;
    return `<article class="s9n-card s9n-big">${e.image ? `<img class="s9n-img" alt="" loading="lazy" src="${esc(e.image)}">` : ''}<div class="s9n-body">${body}</div></article>`;
  }
  function render() {
    if (!panel) return;
    const fresh = new Set(unseen().map(e => e.id));
    panel.querySelector('.s9n-list').innerHTML = ENTRIES.length ? ENTRIES.map(e => cardHTML(e, fresh.has(e.id))).join('') : '<div class="s9n-empty">No updates yet.</div>';
    panel.querySelectorAll('.s9n-img').forEach(im => im.addEventListener('error', () => im.remove(), { once: true }));
  }
  function build() {
    if (!document.getElementById('s9newsStyle')) { const st = document.createElement('style'); st.id = 's9newsStyle'; st.textContent = CSS; document.head.appendChild(st); }
    if (!panel) {
      panel = document.createElement('div'); panel.id = 's9news'; panel.hidden = true;
      panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-labelledby', 's9nTitle');
      panel.innerHTML = '<div class="s9n-box"><div class="s9n-head"><div><div class="s9n-kick">Patch notes</div><h2 id="s9nTitle">What\'s new</h2></div><button type="button" class="s9n-x" aria-label="Close">&times;</button></div><div class="s9n-list"></div></div>';
      panel.addEventListener('mousedown', ev => { if (ev.target === panel) close(); });
      panel.querySelector('.s9n-x').addEventListener('click', close);
      document.body.appendChild(panel);
    }
  }
  function addButton() {
    if (document.getElementById('btnNews')) { btn = document.getElementById('btnNews'); return true; }
    const ref = document.getElementById('btnOnline') || document.getElementById('btnArsenal'); if (!ref) return false;
    btn = document.createElement('button'); btn.type = 'button'; btn.className = 'ghost'; btn.id = 'btnNews';
    btn.innerHTML = 'What\'s new<span class="s9n-dot" aria-hidden="true">NEW</span>';
    btn.addEventListener('click', () => open());
    ref.insertAdjacentElement('afterend', btn); updateDot(); return true;
  }
  function updateDot() { if (!btn) return; const n = unseen().length; btn.classList.toggle('s9n-has', n > 0); btn.setAttribute('aria-label', n > 0 ? `What's new (${n} new)` : "What's new"); }

  function open() {
    build(); render(); lastFocus = document.activeElement; panel.hidden = false;
    try { panel.querySelector('.s9n-list').scrollTop = 0; panel.querySelector('.s9n-x').focus({ preventScroll: true }); } catch (e) {}
    markSeen();
    clearInterval(watch); watch = setInterval(() => { const s = window.__s9; if (s && s.state && s.state !== 'menu') close(); }, 250);   // match started / joined from a link
  }
  function close() {
    if (!panel || panel.hidden) return; panel.hidden = true; clearInterval(watch);
    try { if (lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true }); } catch (e) {}
  }
  const isOpen = () => !!panel && !panel.hidden;
  window.addEventListener('keydown', ev => { if (isOpen() && (ev.key === 'Escape' || ev.code === 'Escape')) { ev.preventDefault(); ev.stopImmediatePropagation(); close(); } }, true);

  function load() {
    return fetch(DATA_URL + (DATA_URL.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now(), { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : { entries: [] })).catch(() => ({ entries: [] }))
      .then(j => { ENTRIES = clean(j); updateDot(); if (isOpen()) render(); api.ready = true; return ENTRIES; });
  }
  const api = window.S9News = { ready: false, open, close, isOpen, entries: () => ENTRIES.slice(), unseen: () => unseen().slice(), markSeen, reload: load, _clean: clean };
  (function wait() { if (!document.body || !addButton()) return setTimeout(wait, 150); build(); })();
  load();
})();
