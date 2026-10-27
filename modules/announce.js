// Sector Nine game add-on: shows the admin's announcement banner ({k:'announce', text, until}) and the reason when the
// server refuses a banned player ({k:'banned', e}). Copy to sector-nine/modules/announce.js and add
//   <script src="modules/announce.js"></script>
// after the main game script (it uses the global SRV from index.html). Text is always inserted as text, never HTML.
(function () {
  'use strict';
  if (typeof SRV === 'undefined' || !SRV.on) return;
  let box = null, timer = null;
  function el() {
    if (box) return box;
    const st = document.createElement('style');
    st.textContent = '#s9Announce{position:fixed;left:0;right:0;top:14px;margin:0 auto;width:fit-content;z-index:9999;max-width:min(680px,calc(100vw - 24px));box-sizing:border-box;display:flex;gap:12px;align-items:center;' +
      'padding:10px 16px;background:rgba(11,13,16,.92);border:1px solid rgba(255,154,60,.55);border-left:4px solid #ff9a3c;border-radius:8px;color:#ece6d8;' +
      'font:600 14px/1.4 "IBM Plex Mono",Consolas,monospace;box-shadow:0 10px 30px rgba(0,0,0,.5);pointer-events:auto}' +
      '#s9Announce b{font:900 15px/1 "Big Shoulders Stencil Display",Impact,sans-serif;letter-spacing:.08em;color:#ff9a3c;text-transform:uppercase;white-space:nowrap}' +
      '#s9Announce span{overflow-wrap:anywhere}#s9Announce button{margin-left:6px;background:none;border:0;color:#8b9097;font-size:18px;cursor:pointer;line-height:1}' +
      '#s9Announce[hidden]{display:none}';
    document.head.appendChild(st);
    box = document.createElement('div'); box.id = 's9Announce'; box.hidden = true; box.setAttribute('role', 'status');
    const b = document.createElement('b'), t = document.createElement('span'), x = document.createElement('button');
    x.type = 'button'; x.setAttribute('aria-label', 'Close'); x.textContent = '×'; x.onclick = () => { box.hidden = true; };
    box.append(b, t, x); document.body.appendChild(box);
    return box;
  }
  function show(label, text, until) {
    const b = el(); clearTimeout(timer);
    if (!text) { b.hidden = true; return; }
    b.children[0].textContent = label; b.children[1].textContent = String(text).slice(0, 300); b.hidden = false;
    const ms = until ? Math.min(until - Date.now(), 86400000) : 15000;
    if (ms <= 0) { b.hidden = true; return; }
    timer = setTimeout(() => { b.hidden = true; }, ms);
  }
  SRV.on.add(d => {
    if (!d || typeof d !== 'object') return;
    if (d.k === 'announce') show('Server', d.text, d.until);
    else if (d.k === 'banned') show('Banned', d.e, Date.now() + 60000);
  });
  window.__s9announce = show;   // for tests
})();
