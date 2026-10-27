// Sector Nine badges: rank insignia, step pips, prestige laurels, player emblems and the level-up / rank-up sprite animations.
// Art is rendered in Blender (render/badges/*.py) into assets/ui/badges and assets/ui/emblems.
// API: window.S9Badges = { rank(i, size), small(i), pip(step), prestige(n), emblems(), emblem(id), el(opts),
//                          playLevelUp(el, opts), playRankUp(el, i, opts), levelUpFrames(), preload(), RANKS, ANIM }
(function () {
  'use strict';
  if (window.S9Badges && window.S9Badges.__v) return;
  // base path: work out where the game root is from this script's own URL (falls back to the page directory)
  let BASE = '';
  try {
    const cs = document.currentScript && document.currentScript.src;
    if (cs && /modules\/badges\.js(\?.*)?$/.test(cs)) BASE = cs.replace(/modules\/badges\.js(\?.*)?$/, '');
  } catch (e) {}
  const B = BASE + 'assets/ui/badges/', E = BASE + 'assets/ui/emblems/';
  const RANKS = ['Recruit', 'Private', 'Corporal', 'Sergeant', 'Lieutenant', 'Captain', 'Major', 'Colonel', 'General', 'Sector Legend'];
  const STEPS = ['I', 'II', 'III', 'IV', 'V'];
  // sprite sheets: 30 frames of 256 px in a 6 x 5 grid, 30 fps (same numbers in assets/ui/badges/anim.json)
  const ANIM = { frame: 256, cols: 6, rows: 5, frames: 30, fps: 30,
    levelup: 'levelup_sheet.png', fx: 'levelup_fx_sheet.png', rankup: i => `rankup_sheet_${i}.png` };
  const EMBLEMS = [
    { id: 'nine_core', name: 'Sector Nine', unlock: 'Default', rarity: 'common' },
    { id: 'robot_cat', name: 'Robo Cat', unlock: 'Reach level 2', rarity: 'common' },
    { id: 'rocket_taco', name: 'Rocket Taco', unlock: 'Win 3 matches', rarity: 'common' },
    { id: 'alien_shades', name: 'Too Cool Alien', unlock: 'Reach level 5', rarity: 'common' },
    { id: 'skull_antenna', name: 'Signal Skull', unlock: 'Get 100 kills', rarity: 'rare' },
    { id: 'neon_dragon', name: 'Neon Dragon', unlock: 'Reach Sergeant', rarity: 'epic' },
    { id: 'banana_astronaut', name: 'Banana Astronaut', unlock: 'Play 10 matches', rarity: 'common' },
    { id: 'pizza_ufo', name: 'Pizza UFO', unlock: 'Win 10 matches', rarity: 'rare' },
    { id: 'cyber_duck', name: 'Cyber Duck', unlock: 'Get 25 headshots', rarity: 'rare' },
    { id: 'brain_jar', name: 'Big Brain', unlock: 'Win 5 Demolition rounds', rarity: 'rare' },
    { id: 'donut_planet', name: 'Donut Planet', unlock: 'Reach level 10', rarity: 'common' },
    { id: 'ghost_wifi', name: 'Lag Ghost', unlock: 'Play 5 online matches', rarity: 'common' },
    { id: 'laser_shark', name: 'Laser Shark', unlock: 'Get a 5-kill streak', rarity: 'epic' },
    { id: 'octo_hacker', name: 'Octo Hacker', unlock: 'Get 50 assists', rarity: 'rare' },
    { id: 'toaster_jet', name: 'Jet Toaster', unlock: 'Reach Corporal', rarity: 'common' },
    { id: 'eyeball_drone', name: 'Eye Drone', unlock: 'Get 10 long-range kills', rarity: 'rare' },
    { id: 'frog_pilot', name: 'Ace Frog', unlock: 'Reach Lieutenant', rarity: 'rare' },
    { id: 'dino_jetpack', name: 'Jetpack Rex', unlock: 'Get 3 MVPs', rarity: 'epic' },
    { id: 'penguin_ninja', name: 'Ninja Penguin', unlock: 'Get 500 kills', rarity: 'epic' },
    { id: 'mushroom_reactor', name: 'Reactor Shroom', unlock: 'Defuse 10 bombs', rarity: 'rare' },
    { id: 'cool_moon', name: 'Chill Moon', unlock: 'Play 25 matches', rarity: 'common' },
    { id: 'coffee_bot', name: 'Coffee Bot', unlock: 'Play on 7 different days', rarity: 'rare' },
    { id: 'slime_king', name: 'Slime King', unlock: 'Reach Major', rarity: 'epic' },
    { id: 'boom_bomb', name: 'Boom Buddy', unlock: 'Plant 20 bombs', rarity: 'epic' }
  ];
  const BY_ID = {}; EMBLEMS.forEach(e => { BY_ID[e.id] = e; });

  const clampI = (v, a, b) => Math.max(a, Math.min(b, (Number(v) | 0)));
  function rank(i, size) {
    i = clampI(i, 0, 9); size = Number(size) || 512;
    return B + `rank_${i}${size <= 64 ? '_64' : size <= 128 ? '_128' : ''}.png`;
  }
  const small = i => rank(i, 128);
  const pip = (step, size) => B + `pip_${clampI(step, 1, 5)}${Number(size) && size <= 48 ? '_48' : ''}.png`;
  const prestige = (n, size) => { n = clampI(n, 0, 99); return n ? B + `prestige_${Math.min(n, 5)}${Number(size) && size <= 128 ? '_128' : ''}.png` : ''; };
  const emblems = () => EMBLEMS.map(e => Object.assign({ src: E + `emblem_${e.id}.png` }, e));
  const emblem = id => E + `emblem_${BY_ID[id] ? id : 'nine_core'}.png`;

  // a ready-made badge element: rank art + optional prestige laurel + step pip. Pure DOM, no user text inside.
  function el(o) {
    o = o || {}; const size = Number(o.size) || 128, i = clampI(o.rank, 0, 9);
    const d = document.createElement('div'); d.className = 's9b-badge';
    d.style.cssText = `position:relative;width:${size}px;height:${size}px;display:inline-block`;
    const im = new Image(); im.src = rank(i, size); im.alt = RANKS[i] + ' badge'; im.draggable = false;
    im.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain';
    const pr = clampI(o.prestige, 0, 99);
    if (pr) { im.style.cssText += ';inset:13%;width:74%;height:74%'; const p = new Image(); p.src = prestige(pr, size); p.alt = 'Prestige ' + pr; p.style.cssText = 'position:absolute;inset:0;width:100%;height:100%'; d.appendChild(im); d.appendChild(p); }
    else d.appendChild(im);
    if (o.step) { const s = new Image(); s.src = pip(o.step, size / 3); s.alt = 'Step ' + STEPS[clampI(o.step, 1, 5) - 1]; s.style.cssText = `position:absolute;right:-4%;bottom:-4%;width:${Math.round(size * .34)}px;height:${Math.round(size * .34)}px`; d.appendChild(s); }
    return d;
  }

  // ---------------- sprite animations
  const CSS = `.s9b-anim{position:absolute;left:50%;top:50%;pointer-events:none;z-index:5;transform:translate(-50%,-50%);transition:opacity .25s}.s9b-anim.out{opacity:0}
    .s9b-glow{position:absolute;left:50%;top:50%;pointer-events:none;z-index:4;border-radius:50%;transform:translate(-50%,-50%) scale(.3);opacity:0;
    background:radial-gradient(circle,var(--c) 0%,color-mix(in srgb,var(--c) 45%,transparent) 30%,transparent 68%);animation:s9bGlow 1.4s cubic-bezier(.2,.8,.3,1) forwards}
    @keyframes s9bGlow{0%{opacity:0;transform:translate(-50%,-50%) scale(.3)}25%{opacity:.95;transform:translate(-50%,-50%) scale(1.05)}100%{opacity:.35;transform:translate(-50%,-50%) scale(.9)}}
    .s9b-glow.out{transition:opacity .25s;opacity:0!important;animation:none}
    @media (prefers-reduced-motion:reduce){.s9b-glow{animation:none;opacity:.35;transform:translate(-50%,-50%) scale(.9)}}`;
  const GLOW = ['#ff8a2a', '#ff8a2a', '#3cc8ff', '#3cc8ff', '#2affc0', '#3cc8ff', '#ff6a2a', '#ffb43a', '#a46bff', '#ff5ad8'];
  function style() { if (document.getElementById('s9bStyle')) return; const s = document.createElement('style'); s.id = 's9bStyle'; s.textContent = CSS; document.head.appendChild(s); }
  // small LRU so a long session never keeps more than 3 decoded sheets (each ~8 MB of image memory) alive
  const IMG = new Map();
  function load(url) {
    let pr = IMG.get(url);
    if (pr) { IMG.delete(url); IMG.set(url, pr); return pr; }
    pr = new Promise(res => { const im = new Image(); im.decoding = 'async'; im.onload = () => (im.decode ? im.decode().catch(() => {}) : Promise.resolve()).then(() => { try { const c = document.createElement('canvas'); c.width = c.height = 1; c.getContext('2d').drawImage(im, 0, 0, 1, 1); } catch (e) {} res(im); }); /* decode + first draw BEFORE the animation starts (else frame 1 stalls and frames get skipped) */ im.onerror = () => { IMG.delete(url); res(null); }; im.src = url; });
    IMG.set(url, pr);
    while (IMG.size > 3) IMG.delete(IMG.keys().next().value);
    return pr;
  }
  const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } };
  const RUN = new WeakMap();
  // plays a sheet over `host` (centred). Resolves {ok, frames} when done. opts: size (px), hold (ms on the last frame), keep (leave the last frame up)
  function play(host, sheet, opts) {
    opts = opts || {};
    if (!host || !host.appendChild) return Promise.resolve({ ok: false, reason: 'no element' });
    style();
    const prev = RUN.get(host); if (prev) prev.stop();
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    const size = Number(opts.size) || Math.round(Math.max(host.clientWidth, host.clientHeight, 96) * 1.6);
    // one 256 px canvas per playback: each frame is copied out of the sheet (fixed, small GPU memory; no huge scaled background layer)
    const d = document.createElement('canvas'); d.className = 's9b-anim'; d.setAttribute('aria-hidden', 'true'); d.width = d.height = ANIM.frame; const cg = d.getContext('2d');
    d.style.width = d.style.height = size + 'px';
    const url = B + sheet;
    const gl = document.createElement('div'); gl.className = 's9b-glow'; gl.setAttribute('aria-hidden', 'true'); gl.style.width = gl.style.height = Math.round(size * 1.05) + 'px';
    gl.style.setProperty('--c', opts.glow || '#4fd2ff');
    let stopped = false, raf = 0, timer = 0, settle = null;
    const unreg = () => { if (RUN.get(host) === api) RUN.delete(host); };
    // stop() always settles the promise, also mid-animation (a cancelled requestAnimationFrame never calls back)
    const api = { stop() { stopped = true; cancelAnimationFrame(raf); clearTimeout(timer); if (!opts.keep) { d.remove(); gl.remove(); } unreg(); if (settle) settle({ ok: false, reason: 'stopped' }); } };
    RUN.set(host, api);
    let sheetIm = null; const F = ANIM.frame;
    const setF = k => { if (!sheetIm) return; cg.clearRect(0, 0, F, F); cg.drawImage(sheetIm, (k % ANIM.cols) * F, Math.floor(k / ANIM.cols) * F, F, F, 0, 0, F, F); d.dataset.frame = k; };
    return load(url).then(im => new Promise(res0 => {
      let settled = false; const resolve = v => { if (settled) return; settled = true; settle = null; res0(v); }; settle = resolve;
      if (stopped) return resolve({ ok: false, reason: 'stopped' });
      if (!im) { unreg(); return resolve({ ok: false, reason: 'missing ' + sheet }); }
      sheetIm = im; if (opts.glow !== false) host.appendChild(gl); host.appendChild(d);
      const n = ANIM.frames, dt = 1000 / (Number(opts.fps) || ANIM.fps);
      const finish = () => {
        if (stopped) return resolve({ ok: false, reason: 'stopped' });
        timer = setTimeout(() => { if (opts.keep) { unreg(); return resolve({ ok: true, frames: n }); } d.classList.add('out'); gl.classList.add('out'); timer = setTimeout(() => { d.remove(); gl.remove(); unreg(); resolve({ ok: true, frames: n }); }, 260); }, opts.hold == null ? 500 : opts.hold);
      };
      if (reduced()) { setF(n - 1); return finish(); }
      const t0 = performance.now(); let last = -1;
      const step = t => {
        if (stopped) return resolve({ ok: false, reason: 'stopped' });
        const k = Math.min(n - 1, Math.floor((t - t0) / dt));
        if (k !== last) { setF(k); last = k; }
        if (k >= n - 1) return finish();
        raf = requestAnimationFrame(step);
      };
      setF(0); raf = requestAnimationFrame(step);
    }));
  }
  const playLevelUp = (host, opts) => play(host, ANIM.levelup, opts);
  const playRankUp = (host, i, opts) => play(host, ANIM.rankup(clampI(i, 0, 9)), Object.assign({ glow: GLOW[clampI(i, 0, 9)] }, opts));
  const playFx = (host, opts) => play(host, ANIM.fx, opts);

  // frames of the burst-only sheet as data URLs (modules/profile.js plays these over its own badge flip)
  let FR = null;
  function levelUpFrames() {
    if (FR) return FR;
    FR = load(B + ANIM.fx).then(im => {
      if (!im) return [];
      const out = [], c = document.createElement('canvas'); c.width = c.height = ANIM.frame; const g = c.getContext('2d');
      for (let k = 0; k < ANIM.frames; k++) {
        g.clearRect(0, 0, c.width, c.height);
        g.drawImage(im, (k % ANIM.cols) * ANIM.frame, Math.floor(k / ANIM.cols) * ANIM.frame, ANIM.frame, ANIM.frame, 0, 0, ANIM.frame, ANIM.frame);
        try { out.push(c.toDataURL('image/png')); } catch (e) { return []; }
      }
      return out;
    }).catch(() => []);
    return FR;
  }
  const preload = (list) => Promise.all((list || [ANIM.levelup, ANIM.fx]).map(s => load(B + s)));

  window.S9Badges = { __v: 1, RANKS, STEPS, ANIM, rank, small, pip, prestige, emblems, emblem, el, play, playLevelUp, playRankUp, playFx, levelUpFrames, preload, base: () => BASE };
})();
