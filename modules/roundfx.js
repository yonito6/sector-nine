/* Sector Nine: round-flow presentation (animations, sounds, FX) for Demolition, Team deathmatch and Free for all.
   Pure add-on: it only WATCHES the match events that modes.js receives from the server and draws its own overlay.
   It never decides anything about the match, never blocks input (everything is pointer-events:none), and animates
   only transform/opacity so it stays at 60 fps. Sounds are synthesized with WebAudio (no files), go through the game's
   master volume (AU.master) and the Settings "effects" volume (window.S9Settings), and fall silent when paused.
   Hook: wraps NET.room.onMatch (re-attached every frame if a new room/handler appears) and splits each server message
   into single events so modes.js's plain banner()/callout()/tone() for the moments we draw can be muted.
   Load AFTER modes.js. Test/preview API: window.S9RoundFX (see bottom). */
(() => {
  'use strict';
  if (window.S9RoundFX) return;

  const TEAM = { atk: { name: 'Strike Force', css: '#ff8a3d', side: 'Attack' }, def: { name: 'Sentinels', css: '#3dc8ff', side: 'Defend' } };
  const REASON = {
    eliminated: { t: 'Enemy team eliminated', i: 'elim' }, defused: { t: 'Charge defused', i: 'defuse' },
    exploded: { t: 'Charge detonated', i: 'blast' }, time: { t: 'Time ran out', i: 'clock' }
  };
  const MODE_NAME = { ffa: 'Free for all', tdm: 'Team deathmatch', demo: 'Demolition' };
  const ST = {
    stats: { osc: 0, buf: 0, moments: {}, skips: 0, errors: 0, events: 0 },
    round: 0, kills: new Map(), lastSec: -1, goRound: -1, busyUntil: 0, clutch: null, planted: false, lastEdge: '',
    score: { atk: 0, def: 0 }, frame: 0, tdmMp: {}, barQ: -1, lastErr: ''
  };
  const now = () => performance.now();
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const NETg = () => (typeof NET !== 'undefined' ? NET : null);
  const MX = () => (window.MODE && window.MODE.MX) || null;
  const myId = () => { const n = NETg(); return n && n.room ? n.room.myId : null; };
  const myTeam = () => { try { return window.MODE ? window.MODE.myTeam() : null; } catch (e) { return null; } };
  const sNow = () => Date.now() - ((MX() && MX().off) || 0);
  const gameState = () => { try { return typeof state !== 'undefined' ? state : 'play'; } catch (e) { return 'play'; } };
  const nameOf = id => {
    if (id == null) return '';
    if (id === myId()) { const n = NETg(); return (n && n.nick) || 'You'; }
    try { const r = (typeof robots !== 'undefined' ? robots : []).find(q => q.netId === id); if (r && r.name) return r.name; } catch (e) {}
    try { const m = NETg().room.meta; const p = m && m.players && m.players.find(q => q.id === id); if (p) return p.n; } catch (e) {}
    return 'Player';
  };
  const safe = fn => function () { try { return fn.apply(this, arguments); } catch (e) { ST.stats.errors++; ST.lastErr = String(e && e.stack || e); } };

  /* ======================= sound (synthesized) ======================= */
  let OUT = null, OUTctx = null, OUTdest = null, OVR = null, volCache = { t: -1e9, v: 1 };
  function fxVol() {
    if (now() - volCache.t < 400) return volCache.v;
    let v = 1; const S = window.S9Settings;
    try { const a = S && typeof S.get === 'function' ? (S.get() || {}).audio : null; if (a && Number.isFinite(+a.effects)) v = Math.max(0, Math.min(1, +a.effects)); } catch (e) {}
    volCache = { t: now(), v }; return v;
  }
  function ctx() {
    if (OVR) return OVR;   // offline render (peak tests)
    const A = typeof AU !== 'undefined' ? AU : null; if (!A || !A.ctx) return null;
    if (A.ctx.state !== 'running') return null;   // never queue cues on a frozen clock (they would all burst on resume)
    // target: the Settings "effects" bus when it is wired (effects volume + mute-when-unfocused live there), else the game
    // master. Both feed the game's own compressor + the pause silence, so no limiter of our own (it would add makeup gain).
    const SA = window.S9Settings && S9Settings._audio, fxBus = SA && SA.wired && SA.fx && SA.fx.context === A.ctx ? SA.fx : null;
    const dest = fxBus || A.master || A.ctx.destination;
    if (OUTctx !== A.ctx || OUTdest !== dest) { OUTctx = A.ctx; if (OUT) try { OUT.disconnect(); } catch (e) {} OUT = A.ctx.createGain(); OUT.connect(dest); OUTdest = dest; }
    OUT.gain.value = (fxBus ? 1 : fxVol()) * .55; return A.ctx;
  }
  let NOISE = null;
  function noiseBuf(c) { if (typeof AU !== 'undefined' && AU.noise) return AU.noise; if (!NOISE || NOISE.sampleRate !== c.sampleRate) { NOISE = c.createBuffer(1, c.sampleRate, c.sampleRate); const d = NOISE.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; } return NOISE; }
  // tone: oscillator with a pitch glide and an exponential decay; optional low-pass sweep for "synth stab" colour
  function tn(t, dur, type, f0, f1, vol, o = {}) {
    const c = OUTctx; ST.stats.osc++;
    const os = c.createOscillator(); os.type = type; os.frequency.setValueAtTime(f0, t); if (f1 !== f0) os.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    if (o.det) os.detune.value = o.det;
    const gn = c.createGain(), a = o.atk || .004; gn.gain.setValueAtTime(0, t); gn.gain.linearRampToValueAtTime(vol, t + a);
    if (o.hold) gn.gain.setValueAtTime(vol, t + a + o.hold); gn.gain.exponentialRampToValueAtTime(.0006, t + dur);
    let node = os;
    if (o.lp) { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = o.q || 1.2; f.frequency.setValueAtTime(o.lp, t); if (o.lpEnd) f.frequency.exponentialRampToValueAtTime(o.lpEnd, t + dur); node.connect(f); node = f; }
    node.connect(gn); gn.connect(o.dest || OUT); os.start(t); os.stop(t + dur + .05);
  }
  function nz(t, dur, type, f, q, vol, o = {}) {
    const c = OUTctx; ST.stats.buf++;
    const s = c.createBufferSource(); s.buffer = noiseBuf(c); s.loop = true;
    const fl = c.createBiquadFilter(); fl.type = type; fl.frequency.setValueAtTime(f, t); if (o.fEnd) fl.frequency.exponentialRampToValueAtTime(o.fEnd, t + dur); fl.Q.value = q;
    const gn = c.createGain(), a = o.atk || .002; gn.gain.setValueAtTime(0, t); gn.gain.linearRampToValueAtTime(vol, t + a); gn.gain.exponentialRampToValueAtTime(.0006, t + dur);
    let last = gn; s.connect(fl); fl.connect(gn);
    if (o.pan != null && c.createStereoPanner) { const p = c.createStereoPanner(); p.pan.setValueAtTime(o.pan, t); if (o.panEnd != null) p.pan.linearRampToValueAtTime(o.panEnd, t + dur); gn.connect(p); last = p; }
    last.connect(OUT); s.start(t, Math.random() * .5); s.stop(t + dur + .05);
  }
  const kick = (t, v = .5, f = 150) => tn(t, .32, 'sine', f, 45, v * .7, { atk: .002 });
  const stab = (t, freqs, dur, vol, lp = 5200, lpEnd = 700, type = 'sawtooth') => { const v = vol * Math.min(1, 3 / freqs.length) * .75; freqs.forEach((f, i) => { tn(t, dur, type, f, f, v, { lp, lpEnd, det: (i % 2 ? 7 : -7) }); tn(t, dur, type, f, f, v * .6, { lp, lpEnd, det: (i % 2 ? -12 : 12) }); }); };
  const bell = (t, f, dur, vol) => { tn(t, dur, 'sine', f, f, vol); tn(t, dur * .6, 'sine', f * 2.01, f * 2.01, vol * .35); tn(t, dur * .3, 'triangle', f * 3, f * 3, vol * .12); };
  const SND = {
    tick(n) { // countdown 5..1: crisp digital tick, each number a step higher; "1" gets an extra bright partial
      const c = ctx(); if (!c) return; const t = c.currentTime + .005, f = [1568, 1319, 1175, 1109, 988, 880][Math.max(0, Math.min(5, n))];
      tn(t, .12, 'sine', f, f, .2); tn(t, .05, 'triangle', f * 2, f * 2, .06); nz(t, .025, 'highpass', 6500, .7, .12); tn(t, .1, 'sine', 160, 70, .22);
      if (n === 1) bell(t + .005, f * 2, .25, .05);
    },
    go() { // punchy "GO": sub kick + bright major stab sweeping shut + air whoosh
      const c = ctx(); if (!c) return; const t = c.currentTime + .005;
      kick(t, .6, 170); nz(t, .35, 'bandpass', 900, .8, .28, { fEnd: 4200 }); stab(t, [440, 554, 659, 880], .5, .045, 7000, 900); bell(t + .02, 1760, .35, .06);
    },
    intro() { // round intro: short riser into a bass hit
      const c = ctx(); if (!c) return; const t = c.currentTime + .005;
      nz(t, .45, 'bandpass', 500, 1.4, .16, { atk: .3, fEnd: 3800 }); tn(t + .38, .5, 'sine', 95, 42, .45); stab(t + .38, [220, 330], .4, .04, 2400, 500);
      bell(t + .42, 1319, .4, .05);
    },
    planted() { // alarm: heavy impact, then a three-cycle two-tone siren through a band-pass
      const c = ctx(); if (!c) return; const t = c.currentTime + .005;
      tn(t, .55, 'sine', 120, 45, .4); nz(t, .3, 'lowpass', 900, 1, .3); nz(t, .05, 'bandpass', 3200, 3, .25);
      for (let i = 0; i < 6; i++) { const f = i % 2 ? 988 : 740; tn(t + .08 + i * .19, .2, 'square', f, f * 1.01, .07, { lp: 2600, lpEnd: 1800, hold: .12 }); }
    },
    defused() { // satisfying: mechanical click, latch thunk, pressure release hiss, rising sparkle
      const c = ctx(); if (!c) return; const t = c.currentTime + .005;
      nz(t, .03, 'bandpass', 3600, 6, .55); tn(t, .035, 'square', 1900, 900, .1); tn(t + .045, .12, 'sine', 220, 90, .4);
      nz(t + .06, .55, 'bandpass', 6000, .8, .22, { fEnd: 700 });
      [659, 831, 988, 1319].forEach((f, i) => bell(t + .16 + i * .07, f * 2, .45, .07));
    },
    blast() { // shock-wave tail under the game's own explosion: deep sub rumble + low noise roll
      const c = ctx(); if (!c) return; const t = c.currentTime + .02;
      tn(t, 1.4, 'sine', 62, 34, .26, { atk: .02 }); nz(t, 1.2, 'lowpass', 320, .8, .3, { atk: .03, fEnd: 90 }); nz(t, .5, 'bandpass', 140, .9, .2, { atk: .01 });
    },
    win() { // round win stinger: I - V - I(8va) major stabs with a sparkle tail (~1 s)
      const c = ctx(); if (!c) return; const t = c.currentTime + .005;
      kick(t, .45); stab(t, [523, 659, 784], .2, .04); stab(t + .15, [587, 784, 988], .2, .04);
      kick(t + .32, .5); stab(t + .32, [659, 784, 1047, 1319], .75, .045, 7600, 1100);
      [2093, 2637, 3136].forEach((f, i) => bell(t + .4 + i * .06, f, .5, .035));
    },
    lose() { // round loss stinger: minor fall, darker and closed filter
      const c = ctx(); if (!c) return; const t = c.currentTime + .005;
      stab(t, [440, 523, 659], .3, .035, 2200, 500); stab(t + .22, [349, 440, 523], .3, .035, 1800, 420); stab(t + .44, [330, 392, 494], .7, .04, 1500, 300);
      tn(t + .44, .7, 'sine', 82, 55, .4);
    },
    clutchWin() { this.win(); const c = ctx(); if (!c) return; const t = c.currentTime + .7; [1319, 1568, 2093, 2637].forEach((f, i) => bell(t + i * .05, f, .6, .05)); },
    score() { const c = ctx(); if (!c) return; const t = c.currentTime + .005; tn(t, .07, 'triangle', 1319, 1319, .12); tn(t + .02, .06, 'sine', 2637, 2637, .05); nz(t, .02, 'highpass', 5000, .7, .06); },
    mvp() { const c = ctx(); if (!c) return; const t = c.currentTime + .005; bell(t, 1568, .7, .08); bell(t + .08, 2093, .8, .07); nz(t, .4, 'highpass', 7000, .5, .05, { atk: .05 }); },
    heart(last, soft) { const c = ctx(); if (!c) return; const t = c.currentTime + .005, v = (last ? .42 : .32) * (soft ? .6 : 1); for (const [d, k] of [[0, 1], [.17, .7]]) { tn(t + d, .13, 'sine', 74, 46, v * k); tn(t + d, .09, 'sine', 148, 92, v * k * .35); nz(t + d, .06, 'lowpass', 190, 1, v * k * .5); } },
    clutch() { const c = ctx(); if (!c) return; const t = c.currentTime + .005; tn(t, 1, 'sawtooth', 55, 52, .09, { lp: 500, lpEnd: 180 }); tn(t, .8, 'sine', 110, 100, .25); bell(t + .05, 1760, .5, .05); bell(t + .05, 1865, .5, .03); },
    matchPoint() { const c = ctx(); if (!c) return; const t = c.currentTime + .005; kick(t, .55, 130); stab(t, [98, 147], .3, .07, 1800, 300); kick(t + .32, .6, 130); stab(t + .32, [98, 147, 196], .5, .07, 2600, 300); nz(t + .3, .6, 'bandpass', 600, 1.2, .14, { atk: .4, fEnd: 3000 }); },
    halftime() { // whoosh flying left to right (the sides swapping) then two calm chords
      const c = ctx(); if (!c) return; const t = c.currentTime + .005;
      nz(t, 1, 'bandpass', 500, 1.1, .45, { atk: .35, fEnd: 2600, pan: -1, panEnd: 1 }); nz(t + .1, .9, 'bandpass', 2600, 1.1, .28, { atk: .3, fEnd: 500, pan: 1, panEnd: -1 });
      stab(t + .55, [392, 494, 587], .45, .06, 4000, 800, 'triangle'); stab(t + .9, [523, 659, 784], .7, .06, 4800, 900, 'triangle'); kick(t + .9, .35, 110);
    },
    victory() { // ~2 s fanfare: arpeggio up into a held major chord with sparkle
      const c = ctx(); if (!c) return; const t = c.currentTime + .005;
      [523, 659, 784, 1047, 1319].forEach((f, i) => { tn(t + i * .1, .3, 'triangle', f, f, .1); tn(t + i * .1, .25, 'sawtooth', f, f, .025, { lp: 4000, lpEnd: 800 }); });
      kick(t + .5, .6); stab(t + .5, [523, 659, 784, 1047], 1.5, .04, 8000, 1200); tn(t + .5, 1.4, 'sine', 131, 130, .3);
      [2093, 2637, 3136, 4186].forEach((f, i) => bell(t + .62 + i * .08, f, .8, .035));
    },
    defeat() { // slow, low descending minor pad
      const c = ctx(); if (!c) return; const t = c.currentTime + .005;
      stab(t, [220, 262, 330], .8, .04, 1400, 400, 'sawtooth'); stab(t + .55, [175, 208, 262], 1.3, .04, 1100, 260, 'sawtooth'); tn(t + .55, 1.3, 'sine', 65, 49, .4);
    },
    pick() { const c = ctx(); if (!c) return; const t = c.currentTime + .005; tn(t, .08, 'triangle', 660, 990, .14); tn(t + .07, .14, 'triangle', 990, 1480, .12); nz(t, .05, 'bandpass', 2500, 4, .15); },
    drop() { const c = ctx(); if (!c) return; const t = c.currentTime + .005; tn(t, .2, 'triangle', 700, 300, .12); tn(t, .14, 'sine', 160, 70, .3); },
    barTick(q) { const c = ctx(); if (!c) return; const t = c.currentTime + .003, f = 1600 + q * 300; tn(t, .04, 'sine', f, f, .07); nz(t, .015, 'highpass', 6000, .7, .05); },
    // ---- end-of-match celebration ----
    celIntro() { const c = ctx(); if (!c) return; const t = c.currentTime + .005; nz(t, .7, 'bandpass', 300, 1, .22, { atk: .25, fEnd: 2400 }); tn(t + .5, .6, 'sine', 80, 38, .5); nz(t + .5, .25, 'lowpass', 600, 1, .3); },
    podium(n) { // each podium step lands with a thump and a note that climbs: 3rd low, 2nd mid, 1st high
      const c = ctx(); if (!c) return; const t = c.currentTime + .005, f = { 3: 392, 2: 523, 1: 659 }[n] || 392;
      kick(t, .5, 120 + (4 - n) * 15); nz(t, .12, 'lowpass', 900, 1, .3); stab(t, [f, f * 1.5], .45, .04, 5200, 900, 'triangle'); bell(t + .02, f * 2, .5, .05);
    },
    medal(place) { // medal clink: inharmonic metal partials, two quick hits, then a shimmer (gold brightest)
      const c = ctx(); if (!c) return; const t = c.currentTime + .005, f = { 1: 2093, 2: 1865, 3: 1661 }[place] || 1661;
      for (const [d, v] of [[0, 1], [.11, .7]]) { [1, 2.76, 5.4, 8.93].forEach((k, i) => tn(t + d, .9 / (i + 1) + .15, 'sine', f * k, f * k, .07 * v / (i * .6 + 1))); nz(t + d, .03, 'highpass', 7000, .7, .12 * v); }
      if (place === 1) [3136, 3951, 4699, 5274].forEach((q, i) => bell(t + .28 + i * .05, q, .6, .03));
    },
    plate() { const c = ctx(); if (!c) return; const t = c.currentTime + .005; tn(t, .15, 'triangle', 660, 660, .1); tn(t + .12, .3, 'triangle', 880, 880, .09); nz(t, .05, 'bandpass', 2400, 3, .12); },
    card(i) { const c = ctx(); if (!c) return; const t = c.currentTime + .005, f = 880 * Math.pow(2, (i % 6) * 2 / 12); nz(t, .14, 'bandpass', 1800, 1.5, .14, { fEnd: 4200 }); tn(t + .03, .12, 'triangle', f, f, .07); },
    board() { const c = ctx(); if (!c) return; const t = c.currentTime + .005; nz(t, .45, 'bandpass', 700, .9, .16, { atk: .15, fEnd: 2600 }); tn(t + .32, .1, 'sine', 1319, 1319, .06); },
    cheer(dur = 3) { // synth crowd: three band-passed noise layers swelling with a slow wobble, scattered claps and two whistles
      const c = ctx(); if (!c) return; const t = c.currentTime + .01;
      for (const [f, q, v] of [[520, .7, .2], [1150, .9, .16], [2500, 1.2, .1]]) {
        ST.stats.buf++; const s = c.createBufferSource(); s.buffer = noiseBuf(c); s.loop = true;
        const fl = c.createBiquadFilter(); fl.type = 'bandpass'; fl.frequency.value = f; fl.Q.value = q;
        const g = c.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + .45); g.gain.setValueAtTime(v, t + dur * .55); g.gain.exponentialRampToValueAtTime(.0006, t + dur);
        // crowd wobble on its own unity VCA, so the envelope above multiplies it and the tail fades to true silence
        const trem = c.createGain(); trem.gain.value = 1; ST.stats.osc++; const lfo = c.createOscillator(); lfo.frequency.value = 2.5 + Math.random() * 3; const lg = c.createGain(); lg.gain.value = .3; lfo.connect(lg); lg.connect(trem.gain);
        s.connect(fl); fl.connect(trem); trem.connect(g); g.connect(OUT); s.start(t, Math.random()); s.stop(t + dur + .05); lfo.start(t); lfo.stop(t + dur + .05);
      }
      for (let i = 0; i < Math.round(dur * 14); i++) { const d = Math.random() * dur * .8; nz(t + d, .03, 'bandpass', 1300 + Math.random() * 1400, 2, .05 + Math.random() * .05); }
      for (const d of [.25, .9]) tn(t + d, .45, 'sine', 1900 + Math.random() * 300, 2700 + Math.random() * 300, .035, { atk: .05 });
    }
  };

  /* ======================= overlay DOM + styles ======================= */
  const ICON = {
    elim: '<svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="15" fill="none" stroke="currentColor" stroke-width="3"/><path d="M24 3v10M24 35v10M3 24h10M35 24h10" stroke="currentColor" stroke-width="3"/><path d="M18 18l12 12M30 18L18 30" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"/></svg>',
    defuse: '<svg viewBox="0 0 48 48"><path d="M24 4l17 6v12c0 11-7.5 18.5-17 22C14.5 40.5 7 33 7 22V10z" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/><path d="M16 24l6 6 11-12" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    blast: '<svg viewBox="0 0 48 48"><path d="M24 3l4 11 10-6-4 11 11 3-10 5 7 9-11-2-1 11-6-9-6 9-1-11-11 2 7-9-10-5 11-3-4-11 10 6z" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"/><circle cx="24" cy="25" r="5" fill="currentColor"/></svg>',
    clock: '<svg viewBox="0 0 48 48"><circle cx="24" cy="26" r="17" fill="none" stroke="currentColor" stroke-width="3"/><path d="M24 15v11l7 5M19 4h10M24 4v5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>',
    charge: '<svg viewBox="0 0 48 48"><rect x="6" y="16" width="36" height="22" rx="3" fill="none" stroke="currentColor" stroke-width="3"/><rect x="11" y="21" width="16" height="9" rx="1.5" fill="currentColor" opacity=".55"/><circle cx="35" cy="25" r="3" fill="currentColor"/><path d="M14 16v-5h20v5" fill="none" stroke="currentColor" stroke-width="3"/></svg>',
    kit: '<svg viewBox="0 0 48 48"><path d="M12 36l14-14M30 8a8 8 0 0 0-6 11l-14 14 5 5 14-14a8 8 0 0 0 11-6l-5 3-5-1-1-5z" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/></svg>',
    hand: '<svg viewBox="0 0 48 48"><path d="M16 26V12a3 3 0 0 1 6 0v10V8a3 3 0 0 1 6 0v14V11a3 3 0 0 1 6 0v17c0 9-5 14-12 14-5 0-8-3-11-8l-5-8a3 3 0 0 1 5-3z" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/></svg>',
    crown: '<svg viewBox="0 0 48 48"><path d="M6 36l-2-22 11 9 9-15 9 15 11-9-2 22z" fill="currentColor"/><rect x="6" y="38" width="36" height="5" rx="1" fill="currentColor"/></svg>',
    swap: '<svg viewBox="0 0 48 48"><path d="M8 17h28l-7-7M40 31H12l7 7" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };
  const css = document.createElement('style'); css.id = 'rfxCss';
  css.textContent = `
#rfx{position:fixed;inset:0;pointer-events:none;z-index:32;overflow:hidden;font-family:var(--display,Impact,sans-serif);color:#fff;contain:strict;transition:opacity .2s}
#rfx.off{opacity:0} #rfx *{pointer-events:none;box-sizing:border-box}
#rfx .L{position:absolute;left:0;right:0;display:flex;flex-direction:column;align-items:center;text-align:center;will-change:transform,opacity}
#mxFreeze{opacity:0!important}
/* round intro */
.rfx-intro{top:9vh}
.rfx-intro .lbl{font:600 clamp(11px,1.4vw,15px)/1 var(--mono,monospace);letter-spacing:.5em;opacity:.85;animation:rfxFade .4s .05s both}
.rfx-intro .num{position:relative;font-weight:900;font-size:clamp(76px,min(13vw,19vh),160px);line-height:.86;letter-spacing:.02em;text-shadow:0 0 30px var(--tc),0 4px 18px rgba(0,0,0,.7);animation:rfxSlam .55s cubic-bezier(.2,1.6,.4,1) both}
.rfx-intro .num::before,.rfx-intro .num::after{content:attr(data-n);position:absolute;inset:0;color:var(--tc);opacity:0;mix-blend-mode:screen}
.rfx-intro .num::before{animation:rfxGlitchA .28s .06s steps(3) 1 both}.rfx-intro .num::after{color:#fff;animation:rfxGlitchB .28s .1s steps(3) 1 both}
.rfx-rule{height:2px;width:min(520px,80vw);margin:10px 0 12px;background:linear-gradient(90deg,transparent,var(--tc),transparent);transform-origin:center;animation:rfxWipe .5s .15s cubic-bezier(.2,.9,.3,1) both}
.rfx-chip{display:inline-flex;align-items:center;gap:10px;padding:7px 16px 6px;font-weight:900;font-size:clamp(17px,2.2vw,26px);letter-spacing:.14em;color:#0b0d10;background:var(--tc);clip-path:polygon(10px 0,100% 0,calc(100% - 10px) 100%,0 100%);animation:rfxRise .45s .22s cubic-bezier(.2,1.3,.4,1) both}
.rfx-chip small{font:700 .55em var(--mono,monospace);letter-spacing:.16em;opacity:.75}
.rfx-obj{margin-top:10px;padding:5px 12px;background:rgba(10,12,16,.55);max-width:min(820px,92vw);font:600 clamp(12px,1.5vw,16px)/1.35 var(--mono,monospace);letter-spacing:.04em;color:#ece6d8;text-shadow:0 1px 4px #000;animation:rfxRise .45s .34s both}
.rfx-mp{margin-top:12px;padding:5px 14px;font-weight:900;font-size:clamp(15px,2vw,22px);letter-spacing:.24em;border:2px solid var(--mc);color:var(--mc);background:rgba(10,12,16,.6);animation:rfxRise .4s .45s both,rfxBlink .7s .9s 4 alternate}
/* countdown */
.rfx-count{top:calc(50% + 40px)}
.rfx-cd{position:relative;width:clamp(96px,10vw,128px);height:clamp(96px,10vw,128px);display:grid;place-items:center}
.rfx-cd svg{position:absolute;inset:0;width:100%;height:100%;transform:rotate(-90deg)}
.rfx-cd circle{fill:rgba(10,12,16,.45);stroke:rgba(255,255,255,.14);stroke-width:4}
.rfx-cd .arc{stroke-dashoffset:var(--a);fill:none;stroke:var(--tc);stroke-width:5;stroke-linecap:round;stroke-dasharray:283;}
.rfx-cd b{font-weight:900;font-size:clamp(54px,6vw,76px);line-height:1;text-shadow:0 0 18px var(--tc);animation:rfxTick .9s cubic-bezier(.2,1.5,.4,1) both}
.rfx-cd b.hot{color:#fff3e0}
.rfx-cdl{margin-top:6px;font:600 11px var(--mono,monospace);letter-spacing:.4em;opacity:.75}
.rfx-go{top:calc(50% - 70px)}
.rfx-go b{font-weight:900;font-size:clamp(90px,16vw,190px);line-height:.9;letter-spacing:.06em;color:#fff;text-shadow:0 0 34px var(--tc),0 0 4px var(--tc);animation:rfxGo .9s linear both}
.rfx-go i{position:absolute;top:50%;left:50%;width:min(900px,96vw);height:3px;margin:-1.5px 0 0 calc(min(900px,96vw) / -2);background:linear-gradient(90deg,transparent,var(--tc),#fff,var(--tc),transparent);animation:rfxStreak .6s ease-out both}
.rfx-go i+i{margin-top:24px;animation-delay:.06s;opacity:.6}
/* charge planted / defused */
.rfx-edge{position:absolute;inset:0;opacity:0;background:radial-gradient(ellipse at center,transparent 55%,rgba(255,40,30,.0) 60%,rgba(255,40,30,.55) 100%);will-change:opacity}
.rfx-edge.on{animation:rfxPulse 1s ease-in-out infinite alternate}
.rfx-edge.on.fast{animation-duration:.45s}.rfx-edge.on.hit{animation:rfxEdgeHit .4s ease-out 3 alternate}
.rfx-alert{top:24vh}
.rfx-alert .row{display:flex;align-items:center;gap:clamp(10px,1.6vw,18px);padding:10px clamp(14px,2.4vw,28px);background:linear-gradient(90deg,rgba(120,10,8,.0),rgba(150,14,10,.82) 18%,rgba(150,14,10,.82) 82%,rgba(120,10,8,0));animation:rfxSlamX .5s cubic-bezier(.2,1.5,.4,1) both,rfxShake .36s .45s 1}
.rfx-alert.green .row{background:linear-gradient(90deg,rgba(8,90,40,0),rgba(10,120,60,.82) 18%,rgba(10,120,60,.82) 82%,rgba(8,90,40,0))}
.rfx-alert .ic{width:clamp(34px,4vw,48px);height:clamp(34px,4vw,48px);flex:none}
.rfx-alert .ic svg{width:100%;height:100%}
.rfx-alert b{font-weight:900;font-size:clamp(26px,4.6vw,56px);letter-spacing:.08em;white-space:nowrap;text-shadow:0 2px 10px rgba(0,0,0,.6)}
.rfx-alert .site{display:grid;place-items:center;width:clamp(44px,5vw,64px);height:clamp(44px,5vw,64px);flex:none;font-weight:900;font-size:clamp(30px,3.6vw,46px);color:#1a0402;background:#ffd2c4;clip-path:polygon(25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%)}
.rfx-alert small{display:block;margin-top:8px;font:600 clamp(11px,1.4vw,14px) var(--mono,monospace);letter-spacing:.24em;text-shadow:0 1px 4px #000;animation:rfxRise .4s .3s both}
.rfx-flash{position:absolute;inset:0;opacity:0;will-change:opacity}
.rfx-flash.green{background:radial-gradient(circle at 50% 50%,rgba(80,255,150,.5),rgba(40,200,110,.22) 60%,rgba(20,120,60,.1));animation:rfxFlash .7s ease-out both}
.rfx-flash.white{background:#fff;animation:rfxWhite 1.1s cubic-bezier(.1,.6,.3,1) both}
.rfx-ring{position:absolute;width:200px;height:200px;margin:-100px 0 0 -100px;border-radius:50%;border:6px solid rgba(255,236,200,.9);box-shadow:0 0 30px rgba(255,170,80,.8),inset 0 0 30px rgba(255,170,80,.6);opacity:0;will-change:transform,opacity;animation:rfxRing 1s cubic-bezier(.1,.7,.3,1) both}
.rfx-ring.g{border-color:rgba(140,255,190,.9);box-shadow:0 0 24px rgba(60,255,140,.7)}
/* round end band */
.rfx-end{top:17vh}
.rfx-band{position:relative;width:100%;display:flex;flex-direction:column;align-items:center;padding:14px 16px 16px;background:linear-gradient(90deg,transparent,var(--bg1) 14%,var(--bg1) 86%,transparent);animation:rfxBand .5s cubic-bezier(.2,1.1,.3,1) both}
.rfx-band::before,.rfx-band::after{content:"";position:absolute;left:8%;right:8%;height:2px;background:linear-gradient(90deg,transparent,var(--tc),transparent)}
.rfx-band::before{top:0}.rfx-band::after{bottom:0}
.rfx-band .top{display:flex;align-items:center;gap:clamp(10px,1.6vw,18px)}
.rfx-band .ic{width:clamp(38px,4.4vw,56px);height:clamp(38px,4.4vw,56px);color:var(--tc);animation:rfxSpinIn .6s .1s cubic-bezier(.2,1.5,.4,1) both}
.rfx-band .ic svg{width:100%;height:100%;filter:drop-shadow(0 0 8px var(--tc))}
.rfx-band h3{margin:0;font-weight:900;font-size:clamp(38px,7vw,92px);line-height:.9;letter-spacing:.05em;text-shadow:0 0 26px var(--tc),0 3px 12px rgba(0,0,0,.6);white-space:nowrap;animation:rfxSlamX .5s .05s cubic-bezier(.2,1.5,.4,1) both}
.rfx-band .why{margin-top:6px;font:600 clamp(11px,1.4vw,15px) var(--mono,monospace);letter-spacing:.14em;color:#ece6d8;animation:rfxRise .4s .25s both}
.rfx-score{display:flex;align-items:center;gap:14px;margin-top:10px;animation:rfxRise .4s .3s both}
.rfx-score .s{position:relative;width:clamp(48px,5vw,64px);height:clamp(48px,5vw,64px);overflow:hidden;display:block;font-weight:900;font-size:clamp(34px,4vw,48px);line-height:clamp(48px,5vw,64px);text-align:center;color:#0b0d10;background:var(--c)}
.rfx-score .s span{position:absolute;left:0;right:0;top:0}
.rfx-score .s.up span.o{animation:rfxOut .35s .7s cubic-bezier(.5,0,.8,.4) both}.rfx-score .s.up span.n{animation:rfxIn .45s .78s cubic-bezier(.2,1.6,.4,1) both}
.rfx-score .s.up{animation:rfxBump .4s .78s both}
.rfx-score em{font-style:normal;font-weight:900;font-size:clamp(24px,3vw,34px);opacity:.7}
.rfx-mvp{display:flex;align-items:center;gap:12px;margin-top:14px;padding:8px 18px 8px 10px;background:rgba(10,12,16,.78);border-left:4px solid var(--c);clip-path:polygon(0 0,100% 0,calc(100% - 12px) 100%,0 100%);animation:rfxCard .5s 1s cubic-bezier(.2,1.3,.4,1) both}
.rfx-mvp .cr{width:30px;height:30px;color:#ffd27a;filter:drop-shadow(0 0 6px rgba(255,210,122,.7))}.rfx-mvp .cr svg{width:100%;height:100%}
.rfx-mvp .k{font:700 10px var(--mono,monospace);letter-spacing:.3em;color:#ffd27a;text-align:left}
.rfx-mvp .n{font-weight:900;font-size:clamp(20px,2.4vw,28px);letter-spacing:.06em;color:var(--c);text-align:left;max-width:52vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rfx-mvp .x{margin-left:6px;font-weight:900;font-size:clamp(20px,2.4vw,28px);white-space:nowrap}.rfx-mvp .x small{font:600 10px var(--mono,monospace);letter-spacing:.2em;opacity:.7;margin-left:4px}
/* clutch */
.rfx-clutch{top:max(74px,9vh)}
.rfx-clutch .p{display:flex;align-items:center;gap:10px;padding:6px 16px 5px;background:rgba(10,12,16,.72);border:1px solid rgba(255,90,70,.6);box-shadow:0 0 18px rgba(255,60,40,.35);clip-path:polygon(8px 0,calc(100% - 8px) 0,100% 50%,calc(100% - 8px) 100%,8px 100%,0 50%);animation:rfxRise .4s cubic-bezier(.2,1.5,.4,1) both}
.rfx-clutch .h{width:18px;height:18px;color:#ff5a46;animation:rfxBeat .85s infinite}
.rfx-clutch .h svg{width:100%;height:100%}
.rfx-clutch b{font-weight:900;font-size:clamp(22px,2.6vw,30px);letter-spacing:.08em}.rfx-clutch b em{font-style:normal;color:#ff6a52}
.rfx-clutch small{font:700 10px var(--mono,monospace);letter-spacing:.3em;color:#ffb2a6}
.rfx-clutch b.pop{animation:rfxBump .35s both}
/* toasts */
.rfx-toast{top:calc(62% + 58px)}
.rfx-toast .t{display:flex;align-items:center;gap:10px;padding:7px 14px;background:rgba(10,12,16,.72);border:1px solid var(--c);font:700 clamp(12px,1.4vw,14px) var(--mono,monospace);letter-spacing:.16em;color:#fff;animation:rfxToast 2.2s ease-out both}
.rfx-toast .t i{width:22px;height:22px;color:var(--c)}.rfx-toast .t i svg{width:100%;height:100%}
/* halftime */
.rfx-half{top:20vh}
.rfx-half .lbl{font:600 clamp(11px,1.4vw,15px) var(--mono,monospace);letter-spacing:.5em;opacity:.85;animation:rfxFade .3s both}
.rfx-half h3{margin:4px 0 14px;font-weight:900;font-size:clamp(40px,8vw,104px);line-height:.88;letter-spacing:.05em;text-shadow:0 0 30px rgba(255,255,255,.35),0 3px 12px rgba(0,0,0,.6);animation:rfxSlamX .5s .05s cubic-bezier(.2,1.5,.4,1) both;white-space:nowrap}
.rfx-swap{position:relative;display:flex;align-items:center;justify-content:center;gap:clamp(56px,10vw,140px);height:52px;width:min(620px,94vw)}
.rfx-swap .tm{flex:none;padding:8px 16px 7px;font-weight:900;font-size:clamp(15px,2vw,24px);letter-spacing:.12em;color:#0b0d10;white-space:nowrap;clip-path:polygon(10px 0,100% 0,calc(100% - 10px) 100%,0 100%)}
.rfx-swap .tm.a{animation:rfxSwapL 1s .45s cubic-bezier(.6,0,.3,1) both}.rfx-swap .tm.b{animation:rfxSwapR 1s .45s cubic-bezier(.6,0,.3,1) both}
.rfx-swap .ar{position:absolute;left:50%;top:50%;width:40px;height:40px;margin:-20px 0 0 -20px;color:#fff;animation:rfxSpin 1s .45s cubic-bezier(.6,0,.3,1) both}.rfx-swap .ar svg{width:100%;height:100%}
.rfx-half .you{margin-top:16px;font:600 clamp(12px,1.5vw,16px) var(--mono,monospace);letter-spacing:.12em;animation:rfxRise .4s 1.4s both}.rfx-half .you b{font-family:var(--display,Impact);font-size:1.5em;letter-spacing:.1em;color:var(--tc)}
.rfx-skip{margin-top:10px;font:600 10px var(--mono,monospace);letter-spacing:.3em;color:#ece6d8;text-shadow:0 1px 3px #000;opacity:.55;animation:rfxFade .4s 1.2s both;white-space:nowrap}
.rfx-final .rfx-skip{position:absolute;left:50%;bottom:max(18px,3vh);transform:translateX(-50%);margin:0}
/* final screen */
.rfx-final{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:clamp(8px,1.6vh,16px);padding:16px;background:radial-gradient(ellipse at 50% 38%,var(--glow),rgba(6,7,10,.86) 62%);animation:rfxFade .5s both}
.rfx-final h2{margin:0;display:flex;font-weight:900;font-size:clamp(64px,15vw,200px);line-height:.85;letter-spacing:.06em;color:var(--tc);text-shadow:0 0 40px var(--tc),0 4px 20px rgba(0,0,0,.7)}
.rfx-final h2 span{display:inline-block;animation:rfxLetter .6s cubic-bezier(.2,1.6,.4,1) both}
.rfx-final.lose h2 span{animation-name:rfxLetterDrop}
.rfx-final .sub{font:600 clamp(12px,1.5vw,16px) var(--mono,monospace);letter-spacing:.24em;color:#ece6d8;animation:rfxRise .4s .6s both;text-align:center}
.rfx-final .fs{display:flex;align-items:center;gap:16px;animation:rfxRise .45s .7s both}
.rfx-final .fs b{min-width:1.3em;padding:2px 10px;font-weight:900;font-size:clamp(34px,5vw,60px);text-align:center;color:#0b0d10;background:var(--c)}
.rfx-final .fs em{font-style:normal;font-weight:900;font-size:clamp(24px,3vw,40px);opacity:.7}
.rfx-tbl{display:flex;gap:clamp(8px,2vw,24px);width:min(900px,100%);justify-content:center;animation:rfxRise .5s .9s both}
.rfx-col{flex:1 1 0;min-width:0;max-width:430px;background:rgba(10,12,16,.7);border-top:3px solid var(--c)}
.rfx-col .hd{display:flex;justify-content:space-between;padding:7px 10px;font-weight:900;font-size:clamp(14px,1.7vw,20px);letter-spacing:.12em;color:var(--c)}
.rfx-col .hd small{font:600 10px var(--mono,monospace);letter-spacing:.2em;color:#8b9097;align-self:center}
.rfx-row{display:grid;grid-template-columns:18px minmax(0,1fr) 30px 30px 34px;gap:6px;align-items:center;padding:5px 10px;font:600 clamp(11px,1.2vw,13px) var(--mono,monospace);color:#ece6d8;border-top:1px solid rgba(255,255,255,.06)}
.rfx-row.me{background:rgba(255,255,255,.1);color:#fff}
.rfx-row .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}.rfx-row span{text-align:right}
.rfx-row i{width:16px;height:16px;color:#ffd27a}.rfx-row i svg{width:100%;height:100%}
.rfx-row.h{font-size:9px;letter-spacing:.2em;color:#8b9097;padding-top:3px;padding-bottom:3px}
.rfx-conf{position:absolute;inset:0;width:100%;height:100%}
/* end-of-match celebration */
.rfx-final.cel{justify-content:center;gap:clamp(6px,1.2vh,12px);background:none;overflow:hidden}
.cel .cel-bg{position:absolute;inset:0;background:radial-gradient(ellipse 70% 60% at 50% 42%,var(--glow),rgba(6,7,10,.9) 70%);animation:rfxFade .5s both}
.cel .cel-bg::before{content:"";position:absolute;left:50%;top:-10%;width:min(70vw,900px);height:120%;margin-left:min(-35vw,-450px);background:conic-gradient(from 180deg at 50% 0,transparent 160deg,rgba(255,255,255,.07) 172deg,rgba(255,255,255,.12) 180deg,rgba(255,255,255,.07) 188deg,transparent 200deg);animation:rfxFade 1s .3s both}
.cel.lose .cel-bg::before,.cel.soft .cel-bg::before{opacity:.5}
.cel>*:not(.cel-bg):not(.rfx-conf){position:relative}
.cel .rfx-conf{z-index:5}
.cel-k{font:600 clamp(10px,1.2vw,13px) var(--mono,monospace);letter-spacing:.42em;color:#c9ccd1;animation:rfxFade .4s .1s both;text-align:center}
.cel h2{font-size:clamp(46px,min(10vw,13vh),136px)}
.cel.lose h2{text-shadow:0 0 22px rgba(255,70,50,.5),0 4px 20px rgba(0,0,0,.7)}
.cel-head{display:flex;align-items:center;gap:clamp(14px,2.4vw,30px)}
.cel-tt{display:flex;flex-direction:column;align-items:flex-start;gap:6px}
.cel-tt .sub{text-align:left}
.cel-medal{position:relative;flex:none;width:clamp(92px,9vw,128px);height:clamp(120px,12vw,168px);animation:celMedal .9s 2.1s cubic-bezier(.2,1.4,.4,1) both;transform-origin:50% 30%}
.cel-medal .rb{position:absolute;top:44%;width:30%;height:56%;background:linear-gradient(90deg,var(--r1),var(--r2));clip-path:polygon(0 0,100% 0,100% 100%,50% 82%,0 100%)}
.cel-medal .rb.l{left:18%;transform:rotate(14deg)}.cel-medal .rb.r{right:18%;transform:rotate(-14deg)}
.cel-medal .disc{position:absolute;left:0;right:0;top:0;aspect-ratio:1;border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;background:radial-gradient(circle at 35% 30%,var(--a),var(--b) 45%,var(--c) 100%);box-shadow:0 0 0 4px rgba(0,0,0,.25),inset 0 0 0 5px rgba(255,255,255,.35),inset 0 -8px 16px rgba(0,0,0,.35),0 0 34px var(--b);overflow:hidden}
.cel-medal .disc::after{content:"";position:absolute;top:-20%;bottom:-20%;left:0;width:34%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.75),transparent);transform:translateX(-200%) skewX(-18deg);animation:celShine 1.6s 2.9s ease-in-out infinite}
.cel-medal b{font-weight:900;font-size:clamp(30px,3vw,44px);line-height:.9;color:var(--c);text-shadow:0 1px 0 rgba(255,255,255,.6)}
.cel-medal small{font:700 clamp(8px,.8vw,10px) var(--mono,monospace);letter-spacing:.3em;color:var(--c)}
.cel-plate{flex:none;display:flex;flex-direction:column;align-items:center;justify-content:center;width:clamp(84px,8vw,110px);height:clamp(84px,8vw,110px);background:rgba(20,24,30,.85);border:2px solid rgba(255,255,255,.25);clip-path:polygon(25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%);animation:rfxSlam .6s 2.1s cubic-bezier(.2,1.4,.4,1) both}
.cel-plate b{font-weight:900;font-size:clamp(30px,3vw,42px);line-height:1}.cel-plate small{font:600 9px var(--mono,monospace);letter-spacing:.2em;opacity:.7}
.cel-pod{display:flex;align-items:flex-end;justify-content:center;gap:clamp(8px,1.6vw,22px);width:min(760px,100%)}
.pod{flex:1 1 0;min-width:0;max-width:220px;display:flex;flex-direction:column;align-items:center;animation:celRise .7s cubic-bezier(.2,1.2,.4,1) both}
.pod.p3{animation-delay:.45s}.pod.p2{animation-delay:.85s}.pod.p1{animation-delay:1.3s}
.pod .cel-av{width:100%;height:clamp(110px,22vh,210px);display:grid;place-items:end center}
.pod.p2 .cel-av,.pod.p3 .cel-av{height:clamp(96px,18vh,180px)}
.cel-av canvas,.cel-av .sil{max-width:100%;max-height:100%;width:auto!important;height:100%!important;filter:drop-shadow(0 6px 10px rgba(0,0,0,.6))}
.pod .wn{display:flex;align-items:center;gap:6px;margin:4px 0 2px;padding:3px 12px 2px;font-weight:900;font-size:clamp(14px,1.6vw,20px);letter-spacing:.2em;color:#2a1800;background:linear-gradient(180deg,#fff2b0,#f2b52b);clip-path:polygon(8px 0,calc(100% - 8px) 0,100% 50%,calc(100% - 8px) 100%,8px 100%,0 50%);animation:rfxSlam .5s 1.55s cubic-bezier(.2,1.6,.4,1) both}
.pod .wn i{width:16px;height:16px}.pod .wn i svg{width:100%;height:100%}
.pod .nm{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:900;font-size:clamp(15px,1.7vw,22px);letter-spacing:.06em}
.pod .nm em,.cel .card .nm em{font-style:normal;font:700 .55em var(--mono,monospace);letter-spacing:.2em;padding:1px 5px;margin-left:4px;color:#0b0d10;background:#ffd27a;vertical-align:middle}
.pod .st{font:600 clamp(9px,1vw,12px) var(--mono,monospace);letter-spacing:.12em;color:#c9ccd1;margin:2px 0 6px;white-space:nowrap}
.pod .blk{position:relative;width:100%;display:grid;place-items:center;background:linear-gradient(180deg,rgba(255,255,255,.14),rgba(20,24,30,.92) 30%);border-top:4px solid var(--b);box-shadow:0 -6px 24px -8px var(--b)}
.pod .blk b{font-weight:900;font-size:clamp(34px,4vw,58px);background:linear-gradient(180deg,var(--a),var(--b) 55%,var(--c));-webkit-background-clip:text;background-clip:text;color:transparent}
.pod.p1 .blk{height:clamp(70px,13vh,120px)}.pod.p2 .blk{height:clamp(50px,9vh,86px)}.pod.p3 .blk{height:clamp(36px,6.5vh,62px)}
.pod.me .blk{box-shadow:0 -6px 30px -4px var(--b),inset 0 0 0 2px rgba(255,210,122,.6)}
.cel-rest{animation:rfxRise .5s 2.7s both;width:min(520px,100%)}
.cel-band{width:min(760px,100%);padding:6px 16px 4px;text-align:center;background:linear-gradient(90deg,transparent,var(--wc) 15%,var(--wc) 85%,transparent);animation:rfxWipe .55s .25s cubic-bezier(.2,.9,.3,1) both}
.cel-band b{font-weight:900;font-size:clamp(22px,3vw,40px);letter-spacing:.14em;color:#0b0d10;white-space:nowrap}
.cel.lose .cel-band{opacity:.75}
.cel-line{display:flex;align-items:flex-end;justify-content:center;gap:clamp(6px,1.2vw,16px);width:min(900px,100%)}
.cel .card{flex:1 1 0;min-width:0;max-width:150px;display:flex;flex-direction:column;align-items:center;padding:0 0 6px;background:linear-gradient(180deg,transparent 30%,rgba(10,12,16,.75));border-bottom:3px solid var(--wc);animation:celRise .6s cubic-bezier(.2,1.2,.4,1) both}
.cel .card .cel-av{width:100%;height:clamp(84px,15vh,150px);display:grid;place-items:end center}
.cel .card.mvp{max-width:190px}.cel .card.mvp .cel-av{height:clamp(104px,19vh,190px)}
.cel .card .mv{display:flex;align-items:center;gap:5px;padding:2px 10px 1px;margin-top:3px;font-weight:900;font-size:13px;letter-spacing:.2em;color:#2a1800;background:linear-gradient(180deg,#fff2b0,#f2b52b)}
.cel .card .mv i{width:14px;height:14px}.cel .card .mv i svg{width:100%;height:100%}
.cel .card .nm{max-width:100%;padding:0 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:900;font-size:clamp(13px,1.4vw,18px);letter-spacing:.05em;margin-top:3px}
.cel .card .st{font:600 clamp(9px,.9vw,11px) var(--mono,monospace);letter-spacing:.12em;color:#c9ccd1;white-space:nowrap}
.cel.lose .card{opacity:.9}
.cel-you{font:600 clamp(10px,1.1vw,13px) var(--mono,monospace);letter-spacing:.16em;color:#ece6d8;padding:4px 12px;background:rgba(10,12,16,.6);animation:rfxRise .4s 1.9s both;text-align:center}
.cel-board{animation:celBoard .6s 2.5s cubic-bezier(.2,1.1,.3,1) both}
@keyframes celRise{from{transform:translateY(60px);opacity:0}}
@keyframes celBoard{from{transform:translateY(80px);opacity:0}}
@keyframes celMedal{0%{transform:scale(.2) rotateY(540deg);opacity:0}65%{transform:scale(1.15) rotateY(0);opacity:1}100%{transform:scale(1)}}
@keyframes celShine{0%{transform:translateX(-200%) skewX(-18deg)}60%,100%{transform:translateX(400%) skewX(-18deg)}}
@media (max-width:560px){.cel .card .cel-av{height:min(84px,10vh)}.cel .card.mvp .cel-av{height:min(100px,12vh)}.pod .cel-av{height:min(118px,14vh)!important}.pod.p1 .cel-av{height:min(140px,16vh)!important}.cel-medal{width:84px;height:110px}.cel-plate{width:76px;height:76px}.cel h2{font-size:clamp(40px,12vw,60px)}.rfx-final.cel .rfx-skip{bottom:6px}.cel-head{flex-direction:column;gap:8px}.cel-tt{align-items:center}.cel-tt .sub{text-align:center}.rfx-final.cel{justify-content:center;padding-top:16px}
.cel .card{max-width:96px}.cel .card.mvp{max-width:112px}.cel-line{flex-wrap:wrap}.cel-band b{font-size:20px}.cel-pod{gap:6px}.pod .st{font-size:9px;letter-spacing:.04em}.cel .rfx-tbl{max-height:40vh;overflow:hidden}}
@media (max-height:700px){.cel .cel-board .rfx-row:not(.h):nth-child(n+6){display:none}}
@media (max-width:560px){.rfx-intro{top:128px}.rfx-end{top:max(17vh,120px)}.rfx-half{top:max(20vh,120px)}.rfx-alert{top:max(24vh,130px)}.rfx-tbl{flex-direction:column;align-items:stretch}.rfx-col{max-width:none}.rfx-final{justify-content:flex-start;padding-top:12vh}.rfx-row{grid-template-columns:16px minmax(0,1fr) 26px 26px 30px}}
/* plant / defuse progress bar polish (modes.js owns the bar; we only restyle and add an icon) */
#mxBar.rfxB{top:calc(62% - 6px);width:min(360px,78vw)}
#mxBar.rfxB .rfxBh{display:flex;align-items:center;justify-content:center;gap:8px;font:700 13px var(--mono,monospace);letter-spacing:.2em}
#mxBar.rfxB .rfxBi{width:22px;height:22px;color:var(--bc,#ffb347);filter:drop-shadow(0 0 6px var(--bc,#ffb347))}#mxBar.rfxB .rfxBi svg{width:100%;height:100%}
#mxBar.rfxB .rfxBp{min-width:3.2em;text-align:right;color:var(--bc,#ffb347)}
#mxBar.rfxB .tr{position:relative;height:10px;border-radius:0;background:rgba(10,12,16,.72);border:1px solid rgba(255,255,255,.18);clip-path:polygon(6px 0,100% 0,calc(100% - 6px) 100%,0 100%);overflow:hidden}
#mxBar.rfxB .tr::before{content:"";position:absolute;inset:0;background:repeating-linear-gradient(90deg,transparent 0 calc(25% - 1px),rgba(255,255,255,.25) calc(25% - 1px) 25%);z-index:2}
#mxBar.rfxB .fl{position:absolute;left:0;top:0;bottom:0;height:auto;background:linear-gradient(90deg,var(--bc2,#ff6a2a),var(--bc,#ffb347));box-shadow:0 0 12px var(--bc,#ffb347);overflow:hidden}
#mxBar.rfxB .fl::after{content:"";position:absolute;top:0;bottom:0;left:0;width:60px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.75),transparent);animation:rfxShimmer 1s linear infinite;will-change:transform}
#mxBar.rfxB.def{--bc:#7fe7ff;--bc2:#1f9ad6}#mxBar.rfxB.kit{--bc:#8dffc8;--bc2:#1fbf7a}
/* kill feed polish: entries slide in with a glint; plant/defuse lines get an icon and colour */
#kfeed div{position:relative;overflow:hidden;animation:rfxFeed .32s cubic-bezier(.2,1.4,.4,1) both}
#kfeed div::after{content:"";position:absolute;top:0;bottom:0;left:0;width:40px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.28),transparent);transform:translateX(-60px);animation:rfxGlint .7s .12s ease-out both}
#kfeed div.rfxK{border-left:3px solid var(--c)}#kfeed div.rfxK .sys{color:var(--c)}#kfeed div.rfxK svg{width:14px;height:14px;color:var(--c)}
@keyframes rfxFeed{from{transform:translateX(40px);opacity:0}}
@keyframes rfxGlint{to{transform:translateX(400px)}}
@keyframes rfxShimmer{from{transform:translateX(-60px)}to{transform:translateX(380px)}}
@keyframes rfxFade{from{opacity:0}}
@keyframes rfxOutFade{to{opacity:0;transform:translateY(-14px) scale(.97)}}
@keyframes rfxSlam{0%{transform:scale(2.4);opacity:0}60%{opacity:1}100%{transform:scale(1)}}
@keyframes rfxSlamX{0%{transform:scale(1.9,1.4);opacity:0}100%{transform:none;opacity:1}}
@keyframes rfxGlitchA{0%{opacity:.8;transform:translate(-6px,2px)}100%{opacity:0;transform:translate(4px,-1px)}}
@keyframes rfxGlitchB{0%{opacity:.5;transform:translate(5px,-2px)}100%{opacity:0;transform:translate(-3px,1px)}}
@keyframes rfxWipe{from{transform:scaleX(0)}}
@keyframes rfxRise{from{opacity:0;transform:translateY(14px)}}
@keyframes rfxBlink{to{opacity:.72}}
@keyframes rfxTick{0%{transform:scale(1.9);opacity:0}25%{opacity:1}100%{transform:scale(1)}}
@keyframes rfxGo{0%{transform:scale(.3);opacity:0;animation-timing-function:cubic-bezier(.2,1.6,.4,1)}30%{transform:scale(1.1);opacity:1;animation-timing-function:ease-out}60%{transform:scale(1);opacity:1;animation-timing-function:ease-in}100%{transform:scale(1.45);opacity:0}}
@keyframes rfxStreak{0%{transform:scaleX(0);opacity:1}100%{transform:scaleX(1);opacity:0}}
@keyframes rfxPulse{from{opacity:.25}to{opacity:.7}}
@keyframes rfxEdgeHit{from{opacity:.2}to{opacity:1}}
@keyframes rfxShake{0%,100%{transform:none}20%{transform:translateX(-8px)}40%{transform:translateX(7px)}60%{transform:translateX(-5px)}80%{transform:translateX(3px)}}
@keyframes rfxFlash{0%{opacity:1}100%{opacity:0}}
@keyframes rfxWhite{0%{opacity:.9}100%{opacity:0}}
@keyframes rfxRing{0%{transform:scale(.1);opacity:1}100%{transform:scale(9);opacity:0}}
@keyframes rfxBand{from{transform:scaleY(.05);opacity:0}}
@keyframes rfxSpinIn{from{transform:rotate(-120deg) scale(.2);opacity:0}}
@keyframes rfxOut{to{transform:translateY(-100%);opacity:0}}
@keyframes rfxIn{from{transform:translateY(100%);opacity:0}}
@keyframes rfxBump{50%{transform:scale(1.22)}}
@keyframes rfxCard{from{transform:translateX(60px);opacity:0}}
@keyframes rfxBeat{0%,40%,100%{transform:scale(1)}15%{transform:scale(1.35)}28%{transform:scale(1.15)}}
@keyframes rfxToast{0%{transform:translateY(16px) scale(.9);opacity:0}12%{transform:none;opacity:1}82%{opacity:1}100%{opacity:0;transform:translateY(-8px)}}
@keyframes rfxSwapL{0%{transform:none}50%{transform:translate(calc(50% + 40px),-26px) scale(1.08)}100%{transform:translateX(var(--d))}}
@keyframes rfxSwapR{0%{transform:none}50%{transform:translate(calc(-50% - 40px),26px) scale(.94)}100%{transform:translateX(calc(var(--d) * -1))}}
@keyframes rfxSpin{to{transform:rotate(180deg)}}
@keyframes rfxLetter{0%{transform:translateY(-60px) scale(1.6);opacity:0}100%{transform:none;opacity:1}}
@keyframes rfxLetterDrop{0%{transform:translateY(-30px);opacity:0}70%{transform:translateY(6px);opacity:1}100%{transform:none}}
/* v2 review fixes: keep clear of the game HUD, scrims behind big words, podium people stand on their blocks */
.rfx-intro{top:max(118px,15vh)}
.rfx-intro .num{font-size:clamp(64px,min(11vw,14vh),130px)}
.rfx-count{top:calc(50% + 64px)}
.rfx-intro::before,.rfx-go::before,.rfx-half::before,.rfx-alert::before{content:"";position:absolute;left:50%;top:50%;width:min(980px,130vw);height:150%;transform:translate(-50%,-50%);background:radial-gradient(ellipse at center,rgba(6,8,12,.6),rgba(6,8,12,.3) 45%,transparent 70%);z-index:-1}
.rfx-mp{font-size:clamp(18px,2.4vw,28px);padding:7px 18px 6px;border-width:3px;box-shadow:0 0 22px -4px var(--mc)}
.rfx-end{top:max(130px,18vh)}
.rfx-band{width:min(920px,100%)}
.rfx-clutch{top:max(100px,13vh)}
.rfx-clutch .p{padding:8px 20px 7px;gap:12px}.rfx-clutch .h{width:24px;height:24px}
.rfx-clutch b{font-size:clamp(28px,3.2vw,40px)}.rfx-clutch small{font-size:11px}
.rfx-half{top:max(110px,14vh)}
.rfx-alert.boom .row{background:linear-gradient(90deg,rgba(150,50,0,0),rgba(200,70,10,.86) 18%,rgba(200,70,10,.86) 82%,rgba(150,50,0,0))}
.rfx-flash.orange{background:radial-gradient(circle at 50% 50%,rgba(255,170,80,.55),rgba(255,90,30,.3) 60%,rgba(120,30,0,.2));animation:rfxFlash 1.4s ease-out both}
#mxBar.rfxB{top:56%}
#mxBar.rfxB .tr{height:13px}
html.rfx-cel #hud,html.rfx-cel #mxHud,html.rfx-cel #mxTip,html.rfx-cel #mxBar,html.rfx-cel #mxSpec{opacity:0!important;transition:opacity .3s}
.rfx-final.cel{justify-content:safe center;padding-top:20px;padding-bottom:40px}
.cel .rfx-conf{z-index:0}
.cel>*:not(.cel-bg):not(.rfx-conf){z-index:1}
.pod .cel-av{height:clamp(100px,19vh,200px)}
.pod.p2 .cel-av,.pod.p3 .cel-av{height:clamp(88px,16vh,170px)}
.pod .blk{display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding:8px 6px 6px;gap:1px}
.pod .blk b{font-size:clamp(28px,3.2vw,46px);line-height:1}
.pod.p1 .blk{height:clamp(122px,17vh,150px)}.pod.p2 .blk{height:clamp(104px,14vh,126px)}.pod.p3 .blk{height:clamp(90px,12vh,108px)}
.pod .blk .wn{position:absolute;top:-15px;left:50%;transform:translateX(-50%);margin:0;white-space:nowrap}
.pod .blk .nm{font-size:clamp(14px,1.5vw,20px)}
.pod .blk .st{margin:0}
@keyframes rfxSlamC{0%{transform:translateX(-50%) scale(1.9,1.4);opacity:0}100%{transform:translateX(-50%);opacity:1}}
.pod .blk .wn{animation-name:rfxSlamC}
/* round 2 review */
.pod .blk{height:auto!important;padding-top:12px}.pod.p1 .blk{padding-bottom:30px}.pod.p2 .blk{padding-bottom:16px}.pod.p3 .blk{padding-bottom:4px}
.pod .blk b{font-size:clamp(24px,2.6vw,40px)}
.pod .blk .nm{line-height:1.15}.pod .blk .st{line-height:1.3}
.pod .blk .wn{top:-30px}
.cel .rfx-col{background:rgba(10,12,16,.93)}
.rfx-band .why,.rfx-band h3,.cel .sub,.rfx-obj,.rfx-half .you{text-wrap:balance}
.rfx-half .rfx-skip{display:none}
@media (max-width:560px){.rfx-end{top:max(150px,18vh)}.rfx-clutch{top:max(112px,13vh)}.rfx-intro{top:136px}.pod.p1 .blk{height:118px}.pod.p2 .blk{height:102px}.pod.p3 .blk{height:90px}.pod .blk .st{font-size:8px}.rfx-final.cel{background:rgba(6,7,10,.35)}}
@media (prefers-reduced-motion:reduce){#rfx *{animation-duration:.01ms!important;animation-iteration-count:1!important}}`;
  document.head.appendChild(css);
  const root = document.createElement('div'); root.id = 'rfx'; root.setAttribute('aria-live', 'polite');
  root.innerHTML = '<div class="rfx-edge" id="rfxEdge"></div>';
  document.body.appendChild(root);
  const edge = root.firstChild;

  // live elements by slot: a new moment in the same slot replaces the old one
  const SLOT = {};
  function put(slot, cls, html, life, vars) {
    clear(slot);
    const el = document.createElement('div'); el.className = 'L ' + cls; el.innerHTML = html;
    if (vars) for (const k in vars) el.style.setProperty(k, vars[k]);
    root.appendChild(el); const rec = { el, t: 0, out: 0 }; SLOT[slot] = rec;
    if (life) { rec.out = setTimeout(() => fadeOut(slot), life); }
    ST.stats.moments[cls.split(' ')[0]] = (ST.stats.moments[cls.split(' ')[0]] || 0) + 1;
    return el;
  }
  function fadeOut(slot, ms = 320) {
    const r = SLOT[slot]; if (!r) return; clearTimeout(r.out);
    r.el.style.animation = `rfxOutFade ${ms}ms ease-in forwards`; r.el.style.transformOrigin = '50% 0';
    setTimeout(() => { if (SLOT[slot] === r) clear(slot); }, ms + 20);
  }
  function clear(slot) { const r = SLOT[slot]; if (!r) return; clearTimeout(r.out); r.el.remove(); delete SLOT[slot]; if (skipRec === r) { skipSlot = skipRec = null; } if (slot === 'final') { stopConfetti(); endCel(); } }
  function fx(cls, life, style) { const el = document.createElement('div'); el.className = cls; if (style) el.setAttribute('style', style); root.appendChild(el); setTimeout(() => el.remove(), life); return el; }
  // skippable long moments (halftime, round end, final screen): Space / Enter / Esc / tap. Never prevents the key's normal use.
  let skipSlot = null, skipRec = null, skipFrom = 0;
  function skippable(slot) { skipSlot = slot; skipRec = SLOT[slot] || null; skipFrom = now() + 500; }
  function trySkip(key) {
    if (!skipSlot || now() < skipFrom || !SLOT[skipSlot] || SLOT[skipSlot] !== skipRec) return false;
    if (key && skipSlot === 'stage' && key !== 'Enter') return false;   // Space = jump, Esc = pause while the round is on
    const s = skipSlot; skipSlot = skipRec = null; ST.stats.skips++; fadeOut(s, 200); if (s === 'stage') { ST.busyUntil = now(); later(210, flushQueue); } return true;
  }
  addEventListener('keydown', e => { if (e.code === 'Space' || e.code === 'Enter' || e.code === 'Escape') trySkip(e.code); }, { capture: true, passive: true });
  addEventListener('pointerdown', () => { if (skipSlot === 'final' || skipSlot === 'stage' && SLOT.stage && SLOT.stage.el.classList.contains('rfx-half')) trySkip(); }, { capture: true, passive: true });
  // every delayed moment goes through later(), so clearAll()/toLobby can cancel all of them
  const PEND = new Set();
  function later(ms, fn) { const id = setTimeout(() => { PEND.delete(id); safe(fn)(); }, ms); PEND.add(id); return id; }
  function cancelPending() { for (const id of PEND) clearTimeout(id); PEND.clear(); QUE.length = 0; }
  // queue for the big centre moments so they never stack on top of each other
  const QUE = [];
  function queue(ms, fn) {
    const t = now(), start = Math.max(t, ST.busyUntil); ST.busyUntil = start + ms; if (start <= t + 5) return fn();
    const q = { fn, ms, id: 0 }; q.id = later(start - t, () => { const i = QUE.indexOf(q); if (i >= 0) QUE.splice(i, 1); fn(); }); QUE.push(q);
  }
  function flushQueue() {   // a skip pulls the next queued moment forward instead of leaving a gap
    const q = QUE.shift(); if (!q) return; clearTimeout(q.id); PEND.delete(q.id); ST.busyUntil = now(); for (const r of QUE) { clearTimeout(r.id); PEND.delete(r.id); } const rest = QUE.splice(0); safe(q.fn)(); for (const r of rest) queue(r.ms, r.fn);
  }
  const touch = () => matchMedia && matchMedia('(pointer:coarse)').matches;
  const skipHint = (stage) => (stage && touch() ? '' : `<div class="rfx-skip">${touch() ? 'TAP' : stage ? 'ENTER' : 'SPACE'} · SKIP</div>`);

  /* ======================= the moments ======================= */
  const teamVars = t => ({ '--tc': (TEAM[t] || {}).css || '#ffd27a' });
  function roundIntro(o) { // o: {round, team, objective, matchPoint:{team}|'final'|null}
    const t = o.team, T = TEAM[t];
    let mp = '';
    if (o.matchPoint === 'final') mp = `<div class="rfx-mp" style="--mc:#ffd27a">FINAL ROUND</div>`;
    else if (o.matchPoint) mp = `<div class="rfx-mp" style="--mc:${TEAM[o.matchPoint].css}">MATCH POINT · ${TEAM[o.matchPoint].name.toUpperCase()}</div>`;
    const n = String(Math.max(0, o.round | 0)).padStart(2, '0');
    put('stage', 'rfx-intro', `<div class="lbl">${esc(o.label || 'ROUND')}</div><div class="num" data-n="${n}">${n}</div><div class="rfx-rule"></div>`
      + (T ? `<div class="rfx-chip">${T.name.toUpperCase()} <small>${T.side.toUpperCase()}</small></div>` : '')
      + `<div class="rfx-obj">${esc(o.objective || '')}</div>${mp}`, o.life || 0, teamVars(t));
    SND.intro(); if (o.matchPoint) later(450, () => SND.matchPoint());
  }
  function countdown(sec, team) {
    const p = Math.max(0, Math.min(1, sec / 5));
    put('count', 'rfx-count', `<div class="rfx-cd"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="45"/><circle class="arc" cx="50" cy="50" r="45" style="--a:${(283 * (1 - p)).toFixed(1)};--b:${(283 * (1 - Math.max(0, p - .2))).toFixed(1)}"/></svg><b class="${sec <= 3 ? 'hot' : ''}">${sec}</b></div><div class="rfx-cdl">GET READY</div>`, 0, teamVars(team));
    if (sec <= 5) SND.tick(sec);
  }
  function go(team, life) {
    clear('count');
    put('go', 'rfx-go', '<i></i><i></i><b>GO</b>', life || 950, teamVars(team));
    if (SLOT.stage && SLOT.stage.el.classList.contains('rfx-intro')) fadeOut('stage', 300);
    SND.go();
  }
  function planted(site, team) {
    edge.className = 'rfx-edge on hit'; ST.planted = true; ST.lastEdge = 'hit';
    later(2400, () => { if (ST.planted) { edge.className = 'rfx-edge on'; ST.lastEdge = 'on'; } });
    const sub = team === 'def' ? 'FIND IT · HOLD E TO DEFUSE' : team === 'atk' ? 'DEFEND THE CHARGE' : '40 SECONDS TO DETONATION';
    put('alert', 'rfx-alert', `<div class="row"><span class="ic">${ICON.charge}</span><b>CHARGE PLANTED</b><span class="site">${esc(site || 'A')}</span></div><small>${sub}</small>`, 2300);
    SND.planted();
  }
  function stopEdge() { ST.planted = false; edge.className = 'rfx-edge'; ST.lastEdge = ''; }
  function defused() {
    stopEdge(); fx('rfx-flash green', 800);
    fx('rfx-ring g', 1100, 'left:50%;top:50%');
    put('alert', 'rfx-alert green', `<div class="row"><span class="ic">${ICON.defuse}</span><b>CHARGE DEFUSED</b></div>`, 1800);
    SND.defused();
  }
  function exploded(pos) {
    stopEdge(); clear('alert'); fx('rfx-flash white', 1150);
    let x = 50, y = 50;   // the ring starts where the charge is on screen (centre if it's behind you)
    try { if (pos && typeof camera !== 'undefined' && window.THREE) { const v = new THREE.Vector3(pos[0], pos[1] + .4, pos[2]).project(camera); if (v.z < 1 && Math.abs(v.x) < 1.3 && Math.abs(v.y) < 1.3) { x = (v.x + 1) * 50; y = (1 - v.y) * 50; } } } catch (e) {}
    fx('rfx-flash orange', 1450); fx('rfx-ring', 1050, `left:${x}%;top:${y}%`); fx('rfx-ring', 1250, `left:${x}%;top:${y}%;animation-delay:.14s;border-width:3px`); fx('rfx-ring', 1400, `left:${x}%;top:${y}%;animation-delay:.3s;border-width:2px;opacity:.6`);
    put('alert', 'rfx-alert boom', `<div class="row"><span class="ic">${ICON.blast}</span><b>CHARGE DETONATED</b></div>`, 1500);
    SND.blast();
  }
  function roundEnd(o) { // o: {winner, mine (true/false/null), reason, score, prev, left, right, mvp:{name,kills,team,me,note}, clutch}
    const W = TEAM[o.winner] || TEAM.atk, R = REASON[o.reason] || REASON.eliminated;
    const title = o.clutch ? 'CLUTCH!' : o.mine === true ? 'ROUND WON' : o.mine === false ? 'ROUND LOST' : `${W.name.toUpperCase()} WIN`;
    const bg = o.mine === false ? 'rgba(70,14,12,.82)' : 'rgba(10,12,16,.8)';
    const L = o.left || 'atk', Rt = o.right || 'def';
    const cell = t => { const a = o.prev[t] | 0, b = o.score[t] | 0, up = t === o.winner && a !== b; return `<b class="s${up ? ' up' : ''}" style="--c:${TEAM[t].css}">${up ? `<span class="o">${a}</span><span class="n">${b}</span>` : `<span>${b}</span>`}</b>`; };
    const m = o.mvp;
    const mvp = m ? `<div class="rfx-mvp" style="--c:${(TEAM[m.team] || W).css}"><span class="cr">${ICON.crown}</span><div><div class="k">${m.me ? 'ROUND MVP · YOU' : 'ROUND MVP'}</div><div class="n">${esc(m.name)}</div></div><div class="x">${m.kills ? `${m.kills}<small>${m.kills === 1 ? 'KILL' : 'KILLS'}</small>` : `<small>${esc(m.note || '')}</small>`}</div></div>` : '';
    put('stage', 'rfx-end', `<div class="rfx-band" style="--bg1:${bg}"><div class="top"><span class="ic">${ICON[R.i]}</span><h3>${title}</h3></div>`
      + `<div class="why">${esc(R.t.toUpperCase())} · ${esc(W.name.toUpperCase())} TAKE ROUND ${esc(o.round || '')}</div>`
      + `<div class="rfx-score">${cell(L)}<em>:</em>${cell(Rt)}</div>${mvp}</div>${skipHint(true)}`, o.life || 4600, { '--tc': W.css });
    skippable('stage');
    if (o.clutch) SND.clutchWin(); else if (o.mine === false) SND.lose(); else SND.win();
    later(800, () => { if (SLOT.stage && SLOT.stage.el.querySelector('.up')) SND.score(); });
    if (m) later(1050, () => { if (SLOT.stage && SLOT.stage.el.querySelector('.rfx-mvp')) SND.mvp(); });
  }
  function clutchShow(o) { // o: {n, me, name} ; null hides
    if (!o) { if (ST.clutch) { fadeOut('clutch', 250); ST.clutch = null; } return; }
    const was = ST.clutch;
    if (!was || was.me !== o.me || was.name !== o.name) {
      put('clutch', 'rfx-clutch', `<div class="p"><span class="h">${heartSvg}</span><div><small>${o.me ? 'CLUTCH' : esc(String(o.name).toUpperCase()) + ' · CLUTCH'}</small><br><b>1 <em>vs</em> <span class="nn">${o.n}</span></b></div></div>`);
      if (o.me) SND.clutch();
    } else if (was.n !== o.n) { const b = SLOT.clutch && SLOT.clutch.el.querySelector('b'); if (b) { b.querySelector('.nn').textContent = o.n; b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); } }
    ST.clutch = Object.assign({ beatT: (was && was.beatT) || 0, beats: (was && was.beats) || 0 }, o); if (o.me) ST.clutchRound = { me: true, n: Math.max(o.n, (ST.clutchRound && ST.clutchRound.n) || 0) };
  }
  const heartSvg = '<svg viewBox="0 0 24 24"><path d="M12 21s-8-5-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 6-8 11-8 11z" fill="currentColor"/></svg>';
  function halftime(o) { // o: {myTeam (after the swap), score}
    const now_ = o.myTeam || 'def';
    put('stage', 'rfx-half', `<div class="lbl">HALFTIME</div><h3>SWITCHING SIDES</h3>`
      + `<div class="rfx-swap" style="--d:calc(100% + clamp(56px,10vw,140px))"><span class="tm a" style="background:${TEAM.atk.css}">${TEAM.atk.name.toUpperCase()}</span><span class="ar">${ICON.swap}</span><span class="tm b" style="background:${TEAM.def.css}">${TEAM.def.name.toUpperCase()}</span></div>`
      + (o.myTeam ? `<div class="you">YOU NOW PLAY <b>${TEAM[now_].name.toUpperCase()}</b> · ${TEAM[now_].side.toUpperCase()}</div>` : '') + (touch() ? '<div class="rfx-skip">TAP · SKIP</div>' : skipHint(true)), o.life || 2600, teamVars(now_));
    // the two chips trade places: measure the real distance so it lands exactly at any screen width
    const sw = SLOT.stage.el.querySelector('.rfx-swap'), a = sw.querySelector('.a'), b = sw.querySelector('.b');
    const d = b.getBoundingClientRect().right - a.getBoundingClientRect().right; a.style.setProperty('--d', d + 'px'); b.style.setProperty('--d', (b.getBoundingClientRect().left - a.getBoundingClientRect().left) + 'px');
    skippable('stage'); SND.halftime();
  }
  function toast(text, icon, color, ms = 2300) { put('toast', 'rfx-toast', `<div class="t" style="--c:${color}"><i>${ICON[icon] || ''}</i>${esc(text)}</div>`, ms); }
  /* ---------- end-of-match celebration (all modes): podium (FFA) / winning-team line-up (TDM, Demolition) ----------
     Appears before the XP / coins summaries and hands over to them: S9Profile.matchXp, S9Shop.matchCoins and
     S9Shop.showLastMatch wait for it (see hookSummaries), so the order is always celebration -> XP -> coins. */
  const MEDAL = { 1: { t: '1ST', a: '#fff6c8', b: '#f2b52b', c: '#7d5000', r1: '#d8392b', r2: '#9e1f16' }, 2: { t: '2ND', a: '#ffffff', b: '#bcc6d1', c: '#4f5964', r1: '#2f6fd8', r2: '#1b4592' }, 3: { t: '3RD', a: '#ffe0bf', b: '#c97c3c', c: '#55290c', r1: '#2a9d5b', r2: '#17653a' } };
  const ord = n => n + ((n % 100 >= 11 && n % 100 <= 13) ? 'TH' : (['TH', 'ST', 'ND', 'RD'][n % 10] || 'TH'));
  const SIL = c => `<svg class="sil" viewBox="0 0 60 120"><circle cx="30" cy="16" r="11" fill="${c}"/><path d="M12 34q18-8 36 0l4 38-8 2-2 44H34l-4-34-4 34H18l-2-44-8-2z" fill="${c}"/></svg>`;
  let CEL = null;
  const whenDone = () => (CEL ? CEL.promise : ST.pendCel ? ST.pendCel.promise : Promise.resolve());
  const myAcc = () => { try { return typeof G !== 'undefined' && G && G.fired ? Math.round(G.hits / G.fired * 100) : null; } catch (e) { return null; } };
  function lookFor(p) {   // the player's real soldier look when we can find it (me = saved look; bots/remotes = their applied skin)
    if (p.me) return undefined;
    try { const r = (typeof robots !== 'undefined' ? robots : []).find(q => (p.id != null && q.netId === p.id) || q.name === p.n); if (r && r.s9key && window.S9Skins && S9Skins.parseLook) return S9Skins.parseLook(r.s9key) || 'std'; } catch (e) {}
    return 'std';
  }
  // soldier portraits: the winner turns slowly in a bouncy pose (a short "victory pose"), others are drawn once
  function avatars(el, list) {
    const SK = window.S9Skins, avs = [...el.querySelectorAll('.cel-av')];
    if (!SK || typeof SK.preview !== 'function') { avs.forEach(a => { const p = list[+a.dataset.i] || {}; a.innerHTML = SIL((TEAM[p.team] || {}).css || (p.me ? '#ffd27a' : '#c9ccd1')); }); return () => {}; }
    let alive = true, tm = 0; const t0 = now();
    const draw = (a, hero, t) => { const p = list[+a.dataset.i] || {}; try { const r = SK.preview(a, lookFor(p), hero ? { clip: 'Jump_Loop', t: .35 + (t % 1.2) * .25, yaw: -.5 + Math.sin(t * 1.4) * .55, dist: 4.4 } : { clip: 'Idle_Loop', t: .3, yaw: -.35 }); if (r && r.catch) r.catch(() => {}); } catch (e) { a.innerHTML = SIL('#c9ccd1'); } };
    avs.forEach(a => draw(a, false, 0));
    const heroes = avs.filter(a => a.classList.contains('hero'));
    const loop = () => { if (!alive) return; const t = (now() - t0) / 1000; heroes.forEach(a => draw(a, true, t)); ST.stats.poses = (ST.stats.poses || 0) + 1; if (t < 9) tm = setTimeout(loop, 80); };
    if (heroes.length) tm = setTimeout(loop, 60);
    return () => { alive = false; clearTimeout(tm); };
  }
  function final(o) { try { return finalInner(o); } catch (e) { ST.stats.errors++; ST.lastErr = String(e && e.stack || e); if (CEL) clear('final'); dropPending(); return Promise.resolve({ error: true }); } }
  function finalInner(o) { // o: {result, winner, score, table:[{id,n,team,kills,deaths,score,acc}], mode, me, myTeam, life}
    if (CEL) endCel();
    stopEdge(); clutchShow(null); clear('count'); clear('alert'); clear('stage'); clear('go'); clear('toast');
    const ffa = o.mode === 'ffa', modeName = (MODE_NAME[o.mode] || 'Match').toUpperCase();
    const list = (Array.isArray(o.table) ? o.table : []).slice(0, 16).map(p => ({ id: p.id, n: String(p.n || 'Player').slice(0, 24), team: p.team === 'atk' || p.team === 'def' ? p.team : null, kills: p.kills | 0, deaths: p.deaths | 0, score: p.score | 0, acc: Number.isFinite(+p.acc) && p.acc !== null ? Math.round(+p.acc) : null, me: p.id === o.me }));
    for (const p of list) if (p.me && p.acc == null) p.acc = myAcc();
    const T = []; const at = (ms, fn) => T.push(setTimeout(safe(fn), ms));
    let html = '', cls = 'rfx-final cel', win = o.result === 'win', vars, place = 0;
    const draw = o.result === 'draw';
    const stat = p => `${p.kills} ${p.kills === 1 ? 'KILL' : 'KILLS'}${p.acc != null ? ` · ${p.acc}% ACC` : ` · ${p.deaths} D`}`;
    const letters = w => [...w].map((ch, i) => `<span style="animation-delay:${(i * .055).toFixed(2)}s">${ch === ' ' ? '&nbsp;' : ch}</span>`).join('');
    const row = (p, k) => `<div class="rfx-row${p.me ? ' me' : ''}"><i>${k}</i><span class="nm">${esc(p.n)}${p.me ? ' (you)' : ''}</span><span>${p.kills}</span><span>${p.deaths}</span><span>${p.score}</span></div>`;
    const head = '<div class="rfx-row h"><i></i><span class="nm">PLAYER</span><span>K</span><span>D</span><span>PTS</span></div>';
    if (ffa) {
      list.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || b.score - a.score);
      const wi = list.findIndex(p => p.id === o.winner); if (wi > 0) list.unshift(list.splice(wi, 1)[0]);
      place = list.findIndex(p => p.me) + 1; win = place === 1;
      const M = MEDAL[place], winner = list[0] || { n: '', kills: 0 };
      const hero = M ? `<div class="cel-medal" style="--a:${M.a};--b:${M.b};--c:${M.c};--r1:${M.r1};--r2:${M.r2}"><i class="rb l"></i><i class="rb r"></i><div class="disc"><b>${M.t}</b><small>PLACE</small></div></div>`
        : place ? `<div class="cel-plate"><b>#${place}</b><small>OF ${list.length}</small></div>` : '';
      const title = win ? 'VICTORY' : place ? `${ord(place)} PLACE` : 'MATCH OVER';
      const sub = win ? `YOU WON THE MATCH · ${winner.kills} KILLS` : `${esc(String(winner.n).toUpperCase())} WINS THE MATCH`;
      const pod = [2, 1, 3].filter(n => list[n - 1]).map(n => { const p = list[n - 1], M2 = MEDAL[n];
        return `<div class="pod p${n}${p.me ? ' me' : ''}"><div class="cel-av${n === 1 ? ' hero' : ''}" data-i="${n - 1}"></div><div class="blk" style="--a:${M2.a};--b:${M2.b};--c:${M2.c}">${n === 1 ? `<div class="wn"><i>${ICON.crown}</i>WINNER</div>` : ''}<b>${n}</b><div class="nm">${esc(p.n)}${p.me ? ' <em>YOU</em>' : ''}</div><div class="st">${stat(p)}</div></div></div>`; }).join('');
      const rest = list.slice(3, 8);
      const strip = rest.length ? `<div class="rfx-tbl cel-rest"><div class="rfx-col" style="--c:#ffd27a"><div class="hd">STANDINGS<small>${list.length} PLAYERS</small></div>${head}${rest.map((p, i) => row(p, i + 4)).join('')}</div></div>` : '';
      cls += win ? ' win' : place && place <= 3 ? ' podium' : ' lose soft';
      vars = { '--tc': win ? '#ffd27a' : M ? M.b : '#ece6d8', '--glow': win ? 'rgba(255,196,90,.30)' : 'rgba(150,170,200,.16)' };
      html = `<div class="cel-k">MATCH COMPLETE · ${modeName}</div><div class="cel-head">${hero}<div class="cel-tt"><h2>${letters(title)}</h2><div class="sub">${sub}</div></div></div><div class="cel-pod">${pod}</div>${strip}`;
      // timeline: podium rises 3rd -> 2nd -> 1st, winner fanfare + crowd + confetti, then my medal
      SND.celIntro();
      at(450, () => SND.podium(3)); at(850, () => SND.podium(2));
      at(1300, () => { SND.podium(1); SND.victory(); });
      at(1750, () => { SND.cheer(win ? 3.2 : 2); startConfetti(CEL && CEL.el.querySelector('.rfx-conf'), null, win ? 1 : .55); });
      at(2150, () => { if (M) SND.medal(place); else if (place) SND.plate(); });
    } else {
      const wt = TEAM[o.winner], mine = o.myTeam || (list.find(p => p.me) || {}).team;
      if (!draw) win = o.winner === mine;
      const team = list.filter(p => p.team === o.winner).sort((a, b) => b.kills - a.kills || a.deaths - b.deaths).slice(0, 6);
      const mvp = team[0];
      const cards = team.map((p, i) => `<div class="card${p === mvp ? ' mvp' : ''}${p.me ? ' me' : ''}" style="animation-delay:${(.65 + i * .14).toFixed(2)}s"><div class="cel-av${p === mvp ? ' hero' : ''}" data-i="${list.indexOf(p)}"></div>${p === mvp ? `<div class="mv"><i>${ICON.crown}</i>MVP</div>` : ''}<div class="nm">${esc(p.n)}${p.me ? ' <em>YOU</em>' : ''}</div><div class="st">${p.kills} K · ${p.deaths} D</div></div>`).join('');
      const order = mine === 'def' ? ['def', 'atk'] : ['atk', 'def'];
      const sc = o.score ? `<div class="fs"><b style="--c:${TEAM[order[0]].css}">${o.score[order[0]] | 0}</b><em>:</em><b style="--c:${TEAM[order[1]].css}">${o.score[order[1]] | 0}</b></div>` : '';
      const cols = order.map(t => { const ps = list.filter(p => p.team === t).sort((a, b) => b.kills - a.kills); return `<div class="rfx-col" style="--c:${TEAM[t].css}"><div class="hd">${TEAM[t].name.toUpperCase()}<small>${t === o.winner ? 'WINNERS' : ''}</small></div>${head}${ps.slice(0, 6).map(p => row(p, p === mvp ? ICON.crown : '')).join('')}</div>`; }).join('');
      const me = list.find(p => p.me);
      const you = me ? `<div class="cel-you">${win ? 'YOUR MATCH' : 'GOOD FIGHT'} · ${me.kills} KILLS · ${me.deaths} DEATHS${me.acc != null ? ` · ${me.acc}% ACC` : ''}</div>` : '';
      const word = draw ? 'DRAW' : win ? 'VICTORY' : 'DEFEAT';
      cls += draw ? ' soft' : win ? ' win' : ' lose';
      vars = { '--tc': draw ? '#ece6d8' : win ? (wt || {}).css || '#ffd27a' : '#ff5a4a', '--glow': win ? 'rgba(255,190,90,.26)' : draw ? 'rgba(200,200,200,.12)' : 'rgba(150,25,20,.26)', '--wc': (wt || {}).css || '#ffd27a' };
      html = `<div class="cel-k">MATCH COMPLETE · ${modeName}</div><h2>${letters(word)}</h2>${wt && !draw ? `<div class="cel-band"><b>${wt.name.toUpperCase()} WIN</b></div>` : ''}${sc}${cards ? `<div class="cel-line">${cards}</div>` : ''}${you}<div class="rfx-tbl cel-board">${cols}</div>`;
      SND.celIntro();
      if (win) { at(380, () => SND.victory()); at(520, () => { SND.cheer(3.2); startConfetti(CEL && CEL.el.querySelector('.rfx-conf'), o.winner, 1); }); }
      else if (draw) at(380, () => SND.win()); else at(320, () => SND.defeat());
      team.forEach((p, i) => at(650 + i * 140, () => SND.card(i)));
      if (team.length) at(650 + team.length * 140 + 120, () => SND.medal(1));
      at(2500, () => SND.board());
    }
    cancelPending();
    const el = put('final', cls, `<div class="cel-bg"></div><canvas class="rfx-conf"></canvas>${html}${skipHint()}`, 0, vars);
    let resolve; const promise = new Promise(r => { resolve = r; });
    CEL = { el, T, resolve, promise, stopAv: () => {}, place, result: ffa ? (win ? 'win' : 'place') : o.result, mode: o.mode, t0: now() };
    if (ST.pendCel) { const pc = ST.pendCel; ST.pendCel = null; clearTimeout(pc.dog); promise.then(pc.resolve); if (pc.sen) pc.sen.remove(); }
    at(o.life || 9000, () => fadeOut('final', 350)); skippable('final');
    CEL.hard = setTimeout(() => { if (CEL && CEL.el === el) clear('final'); }, (o.life || 9000) + 6000);   // never hold the XP/coins screens hostage
    CEL.stopAv = avatars(el, list);
    document.documentElement.classList.add('rfx-cel');
    const mend = document.getElementById('mend'); if (mend) { CEL.mend = mend; CEL.mendVis = mend.style.visibility; mend.style.visibility = 'hidden'; }
    const sen = document.createElement('div'); sen.className = 's9p-pop on rfx-sentinel'; sen.style.display = 'none'; sen.setAttribute('aria-hidden', 'true'); document.body.appendChild(sen); CEL.sen = sen;
    ST.stats.celebrations = (ST.stats.celebrations || 0) + 1;
    return promise;
  }
  function pendingCel() {   // from matchEnd until the celebration starts: XP/coins already wait, and the shop sees a popup
    if (ST.pendCel) return; let resolve; const promise = new Promise(r => { resolve = r; });
    const sen = document.createElement('div'); sen.className = 's9p-pop on rfx-sentinel'; sen.style.display = 'none'; sen.setAttribute('aria-hidden', 'true'); document.body.appendChild(sen);
    ST.pendCel = { promise, resolve, sen, dog: setTimeout(dropPending, 15000) };
  }
  function dropPending() { const pc = ST.pendCel; if (!pc) return; ST.pendCel = null; clearTimeout(pc.dog); if (pc.sen) pc.sen.remove(); pc.resolve({ cancelled: true }); }
  function endCel() {   // called when the final slot goes away (time, skip, toLobby): hand over to the XP / coins screens
    const C = CEL; if (!C) return; CEL = null;
    C.T.forEach(clearTimeout); clearTimeout(C.hard); try { C.stopAv(); } catch (e) {} stopConfetti();
    if (C.mend) C.mend.style.visibility = C.mendVis || '';
    document.documentElement.classList.remove('rfx-cel');
    if (C.sen) C.sen.remove();
    C.resolve({ skipped: now() - C.t0 < 8000 });
  }
  // the XP panel (S9Profile) and coins (S9Shop) wait for the celebration, so they come right after it
  function hookSummaries() {
    const wrap = (obj, k) => { if (!obj || typeof obj[k] !== 'function' || obj[k].__rfx) return; const f = obj[k]; const w = function () { if (!CEL && !ST.pendCel) return f.apply(this, arguments); const a = arguments; return whenDone().then(() => f.apply(this, a)); }; w.__rfx = true; obj[k] = w; };
    wrap(window.S9Profile, 'matchXp'); wrap(window.S9Shop, 'matchCoins'); wrap(window.S9Shop, 'showLastMatch');
  }
  // offline (vs bots) free for all ends in index.html's endMatch(): celebrate it too (online matches use the server's matchEnd)
  if (typeof endMatch === 'function') {
    const _end = endMatch;
    endMatch = function (winner) {
      const was = typeof G !== 'undefined' && G.ended; const r = _end.apply(this, arguments);
      try {
        const n = NETg(); if (was || !window.S9RoundFX || !S9RoundFX.enabled || (n && n.on) || (CEL && now() - CEL.t0 < 15000)) return r;
        const st = typeof standings === 'function' ? standings() : [];
        const table = st.map((e, i) => ({ id: e.isPlayer ? 'me' : 'bot' + i, n: e.isPlayer ? ((n && n.nick) || 'You') : e.name, kills: e.kills | 0, deaths: e.deaths | 0, score: e.score | 0 }));
        final({ result: 'win', mode: 'ffa', table, me: 'me', winner: winner && !winner.isPlayer ? 'bot' + st.indexOf(winner) : winner ? 'me' : null });
      } catch (e) { ST.stats.errors++; ST.lastErr = String(e && e.stack || e); }
      return r;
    };
  }
  // lightweight confetti: one 2D canvas, 120 flakes, 4 s, capped DPR, stops itself
  let conf = null;
  function startConfetti(cv, team, amt = 1) {
    stopConfetti(); if (!cv) return;
    // drawn at reduced resolution (S) and scaled up by CSS: flakes are small, so it looks the same and costs a fraction
    const W = innerWidth, H = innerHeight, S = Math.min(1, 900 / Math.max(W, H)) * Math.min(1.5, devicePixelRatio || 1); cv.width = Math.round(W * S); cv.height = Math.round(H * S);
    const c = cv.getContext('2d');
    const cols = team && TEAM[team] ? ['#ffd27a', '#ffffff', TEAM[team].css, TEAM[team].css, '#ff9a3c'] : ['#ffd27a', '#ffffff', '#ff9a3c', '#3dc8ff', '#f2b52b'];
    const P = Array.from({ length: Math.round((W < 600 ? 60 : 100) * amt) }, (_, i) => ({ x: W / 2 + (Math.random() - .5) * W * .3, y: H * .35, vx: (Math.random() - .5) * 14, vy: -6 - Math.random() * 9, r: Math.random() * 6.28, vr: (Math.random() - .5) * .4, w: 5 + Math.random() * 6, h: 3 + Math.random() * 4, c: cols[i % cols.length], d: Math.random() * 400 }));
    const t0 = now(); let last = t0;
    const step = () => {
      if (!conf) return; const t = now(), dt = Math.min(.05, (t - last) / 1000) * 60; last = t;
      c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, cv.width, cv.height); const age = t - t0; c.globalAlpha = Math.max(0, Math.min(1, (4200 - age) / 900));
      for (const p of P) { if (age < p.d) continue; p.vy += .22 * dt; p.vx *= Math.pow(.985, dt); p.vy = Math.min(p.vy, 4.5); p.x += p.vx * dt; p.y += p.vy * dt; p.r += p.vr * dt;
        if (p.y > H + 20) continue; const co = Math.cos(p.r) * S, si = Math.sin(p.r) * S, sy = Math.cos(p.r * 1.7);
        c.setTransform(co, si, -si * sy, co * sy, p.x * S, p.y * S); c.fillStyle = p.c; c.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); }
      if (age > 4200) { stopConfetti(); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, cv.width, cv.height); return; }
      conf = requestAnimationFrame(step);
    };
    conf = requestAnimationFrame(step); ST.stats.confetti = (ST.stats.confetti || 0) + 1;
  }
  function stopConfetti() { if (conf) cancelAnimationFrame(conf); conf = null; }

  /* ======================= server events -> moments ======================= */
  const isMine = w => { const t = myTeam(); return w === t || (w && w === myId()); };
  const roundsToWin = () => { const v = MX() && MX().v; return (v && (v.toWin || v.roundsToWin)) || 7; };
  function onEvent(e) {
    ST.stats.events++;
    const M = MX(), v = M && M.v, t = myTeam();
    switch (e.k) {
      case 'start': { // TDM / FFA match start (no freeze time)
        if (v && v.mode === 'demo') break; const mode = (v && v.mode) || (e.mode) || 'ffa', lim = v && v.limit;
        queue(1800, () => { roundIntro({ round: 1, label: (MODE_NAME[mode] || 'Match').toUpperCase(), team: mode === 'tdm' ? t : null, objective: mode === 'tdm' ? `First team to ${lim || 'the kill limit'} kills wins` : `First to ${lim || 'the kill limit'} kills wins · everyone is an enemy`, life: 1400 }); later(1100, () => go(mode === 'tdm' ? t : null)); });
        ST.tdmMp = {}; break;
      }
      case 'round': {
        ST.round = e.round; ST.kills = new Map(); ST.clutchRound = null; ST.lastSec = -1; clutchShow(null); stopEdge(); clear('alert');
        ST.score = v && v.score ? { ...v.score } : ST.score;
        const goal = t === 'atk' ? (e.carrier === myId() ? 'You carry the charge · plant it at site A or B (hold E)' : 'Escort the charge to site A or B') : t === 'def' ? 'Defend sites A and B · stop the plant or defuse it' : 'Plant or defuse the charge';
        const sc = (v && v.score) || ST.score, need = roundsToWin() - 1;
        const mp = sc.atk === need && sc.def === need ? 'final' : sc.atk === need ? 'atk' : sc.def === need ? 'def' : null;
        queue(800, () => roundIntro({ round: e.round, team: t, objective: goal, matchPoint: mp, life: 7000 }));
        break;
      }
      case 'live': if (ST.goRound !== ST.round) { ST.goRound = ST.round; go(t); } break;
      case 'death': if (e.killer && !e.teamKill) ST.kills.set(e.killer, (ST.kills.get(e.killer) || 0) + 1); break;
      case 'planted': ST.planter = e.id; planted(e.site, t); break;
      case 'defused': ST.defuser = e.id; defused(); break;
      case 'exploded': exploded(e.pos); break;
      case 'bombPick': if (e.id === myId()) toast('YOU HAVE THE CHARGE', 'charge', TEAM.atk.css); else if (t === 'atk') toast(`${nameOf(e.id).toUpperCase()} HAS THE CHARGE`, 'charge', TEAM.atk.css, 1800); SND.pick(); break;
      case 'bombDrop': if (t === 'atk') { toast('CHARGE DROPPED · PICK IT UP', 'charge', '#ff4a3d'); SND.drop(); } break;
      case 'roundEnd': {
        const sc = e.score || { atk: 0, def: 0 }, prev = { ...sc }; prev[e.winner] = Math.max(0, (sc[e.winner] | 0) - 1);
        let best = null; for (const [id, k] of ST.kills) if (!best || k > best.k) best = { id, k };
        let mvp = null;
        if (best) mvp = { name: nameOf(best.id), kills: best.k, team: (window.MODE && MODE.teamOf(best.id)) || e.winner, me: best.id === myId() };
        else if (e.reason === 'defused' && ST.defuser) mvp = { name: nameOf(ST.defuser), kills: 0, note: 'DEFUSED IT', team: 'def', me: ST.defuser === myId() };
        else if (e.reason === 'exploded' && ST.planter) mvp = { name: nameOf(ST.planter), kills: 0, note: 'PLANTED IT', team: 'atk', me: ST.planter === myId() };
        const clutch = !!(ST.clutchRound && ST.clutchRound.me && isMine(e.winner));
        const L = t === 'def' ? 'def' : 'atk', R = L === 'atk' ? 'def' : 'atk';
        clutchShow(null); stopEdge(); ST.planter = ST.defuser = null;
        const delay = e.reason === 'exploded' || e.reason === 'defused' ? 900 : 250;
        ST.busyUntil = Math.max(ST.busyUntil, now() + delay);
        queue(4600, () => roundEnd({ winner: e.winner, mine: t ? isMine(e.winner) : null, reason: e.reason, score: sc, prev, left: L, right: R, mvp, clutch, round: ST.round }));
        ST.score = { ...sc }; break;
      }
      case 'halftime': ST.busyUntil = Math.max(ST.busyUntil, now()); queue(2500, () => halftime({ myTeam: t, score: v && v.score })); break;
      case 'matchEnd': {
        const w = e.winner, res = w === 'draw' ? 'draw' : isMine(w) ? 'win' : 'lose';
        const mode = (v && v.mode) || 'demo';
        if (ST.pendCel || now() - (ST.lastMatchEndT || -1e9) < 30000) break; ST.lastMatchEndT = now();   // a duplicate matchEnd must not restart (and hand over early)
        const delay = mode === 'demo' ? 2600 : 300;   // let the last round banner play first
        pendingCel();
        later(delay, () => { clear('stage'); ST.busyUntil = 0; try { final({ result: res, winner: w, score: e.score, table: e.table, mode, me: myId(), myTeam: t }); } finally { if (!CEL) dropPending(); } });
        break;
      }
      case 'toLobby': clearAll(true); break;
    }
  }
  function clearAll(keepEnd) { if (!keepEnd) ST.lastMatchEndT = 0; cancelPending(); for (const k of Object.keys(SLOT)) clear(k); stopEdge(); ST.clutch = null; ST.busyUntil = 0; skipSlot = skipRec = null; dropPending(); }

  /* ---- per-frame: countdown, clutch, charge pulse speed, progress bar, TDM match point, attach to new rooms ---- */
  function frame() {
    ST.frame++;
    const n = NETg(), M = MX(), v = M && M.v, st = gameState();
    root.classList.toggle('off', !(st === 'play' || st === 'dead' || st === 'matchend' || ST.preview));
    if (n && n.room && !n.room.__rfxH) attach(n.room);
    if (ST.frame % 60 === 1) hookSummaries();
    if (!M || ST.preview) return;
    const online = n && n.on && n.inMatch && v;
    if (!online) { if (ST.clutch) clutchShow(null); if (ST.planted) stopEdge(); return; }
    if (v.mode === 'demo') {
      // freeze countdown (server clock)
      const left = (M.freezeEnd - sNow()) / 1000;
      if (left > 0 && v.phase !== 'live') { const sec = Math.ceil(left); const half = SLOT.stage && SLOT.stage.el.classList.contains('rfx-half'); if (sec !== ST.lastSec && sec <= 9 && (!half || sec <= 3)) { ST.lastSec = sec; countdown(sec, myTeam()); } }
      else if (SLOT.count && ST.goRound !== ST.round && v.phase === 'live') { ST.goRound = ST.round; go(myTeam()); }
      else if (SLOT.count && left <= 0) clear('count');
      // charge planted: the edge pulse speeds up in the last 10 seconds
      const B = M.bomb;
      if (B && B.s === 'planted' && B.ex) { if (!ST.planted) { edge.className = 'rfx-edge on'; ST.planted = true; } const fast = (B.ex - sNow()) / 1000 < 10; if (fast !== edge.classList.contains('fast') && ST.lastEdge !== 'hit') edge.classList.toggle('fast', fast); }
      else if (ST.planted && (!B || B.s !== 'planted')) stopEdge();
      // clutch: I'm (or a teammate is) the last one alive against N
      if (ST.frame % 8 === 0) {
        const t = myTeam(), pl = v.pl || [];
        if (t && v.phase === 'live') {
          const mine = pl.filter(p => p[1] === t), alive = mine.filter(p => p[4]), foes = pl.filter(p => p[1] && p[1] !== t && p[4]).length;
          if (mine.length >= 2 && alive.length === 1 && foes >= 1) clutchShow({ n: foes, me: alive[0][0] === myId(), name: nameOf(alive[0][0]) });
          else if (ST.clutch) clutchShow(null);
        } else if (ST.clutch && v.phase !== 'live') clutchShow(null);
      }
      if (ST.clutch && ST.clutch.me && st === 'play') { const c = ST.clutch; if (now() >= (c.beatT || 0)) { c.beatT = now() + (c.n >= 3 ? 700 : 850); c.beats = (c.beats || 0) + 1; SND.heart(c.n >= 3, c.beats > 6); } }
    } else if (v.mode === 'tdm' && v.tk && v.limit > 1 && ST.frame % 15 === 0) {
      for (const t of ['atk', 'def']) if ((v.tk[t] | 0) === v.limit - 1 && !ST.tdmMp[t]) { ST.tdmMp[t] = 1; toast(`MATCH POINT · ${TEAM[t].name.toUpperCase()} NEED 1 KILL`, 'elim', TEAM[t].css, 2600); SND.matchPoint(); }
    }
    bar();
  }
  // progress bar polish: icon, % and colour per action; a soft tick every quarter
  function bar() {
    const B = document.getElementById('mxBar'); if (!B) return;
    if (!B.classList.contains('rfxB')) { B.classList.add('rfxB'); const T = document.getElementById('mxBarT'); if (T && !B.querySelector('.rfxBh')) { const h = document.createElement('div'); h.className = 'rfxBh'; h.innerHTML = '<i class="rfxBi"></i>'; T.parentNode.insertBefore(h, T); h.appendChild(T); const p = document.createElement('span'); p.className = 'rfxBp'; h.appendChild(p); } }
    if (B.hidden) { ST.barQ = -1; return; }
    const a = (MX() && MX().myAct) || ST.previewAct; const kind = a ? a.kind : 'plant', kit = !!(a && a.kit);
    const k = kind === 'plant' ? 'rfxB' : kit ? 'rfxB def kit' : 'rfxB def'; if (B.className !== k) B.className = k;
    const ic = B.querySelector('.rfxBi'), want = kind === 'plant' ? 'charge' : kit ? 'kit' : 'hand'; if (ic && ic.dataset.k !== want) { ic.dataset.k = want; ic.innerHTML = ICON[want]; }
    const F = document.getElementById('mxBarF'), pc = F ? parseFloat(F.style.width) || 0 : 0, P = B.querySelector('.rfxBp'), pt = Math.round(pc) + '%'; if (P && P.textContent !== pt) P.textContent = pt;
    const q = Math.floor(pc / 25); if (ST.barQ >= 0 && q > ST.barQ && q < 4) SND.barTick(q); ST.barQ = q;
  }
  // kill feed: colour + icon on the plant/defuse/drop lines that modes.js writes
  function feedPolish() {
    const f = document.getElementById('kfeed'); if (!f || f.__rfx) return; f.__rfx = true;
    new MutationObserver(ms => { for (const m of ms) for (const d of m.addedNodes) { if (d.nodeType !== 1) continue; const s = d.querySelector && d.querySelector('.sys'); if (!s) continue; const t = s.textContent;
      const k = /planted/i.test(t) ? ['#ff5a46', 'charge'] : /defused/i.test(t) ? ['#5dffa8', 'defuse'] : /dropped/i.test(t) ? ['#ffb347', 'charge'] : null;
      if (k) { d.classList.add('rfxK'); d.style.setProperty('--c', k[0]); s.insertAdjacentHTML('afterbegin', ICON[k[1]]); } } }).observe(f, { childList: true });
  }

  /* ---- hooking: observe the room's match messages, mute modes.js's plain versions of the moments we present ---- */
  const MUTE = { round: ['banner', 'wave'], live: ['callout', 'osc'], roundEnd: ['banner', 'osc'], halftime: ['banner'], matchEnd: ['banner', 'osc'], planted: ['callout', 'osc'], defused: ['callout', 'osc'], bombPick: ['callout'] };
  const NOOP = function () {};
  function muted(list, fn) {
    if (!list) return fn();
    const saved = {};
    try {
      for (const k of list) {
        if (k === 'wave') { if (typeof sfx !== 'undefined' && sfx && sfx.wave) { saved.wave = sfx.wave; sfx.wave = NOOP; } }
        else if (typeof window[k] === 'function') { saved[k] = window[k]; window[k] = NOOP; }
      }
      return fn();
    } finally { for (const k in saved) { if (k === 'wave') sfx.wave = saved.wave; else window[k] = saved[k]; } }
  }
  function attach(r) {
    if (r.__rfxH) return;
    let orig = typeof r.onMatch === 'function' && !r.onMatch.__rfx ? r.onMatch : null; const early = [];
    const h = function (d) {
      if (!orig) { early.push(d); return; }   // modes.js not attached yet: hold it, and replay through this handler once it is
      if (!d || !Array.isArray(d.e) || !d.e.length) return orig.call(this, d);
      const on = !!(window.S9RoundFX && S9RoundFX.enabled);
      if (orig && d.v) { try { orig.call(this, { v: d.v, e: [] }); } catch (err) { ST.stats.modesErrors = (ST.stats.modesErrors || 0) + 1; ST.lastErr = String(err && err.stack || err); } }
      for (const e of d.e) {
        // modes.js handles each event with its plain banner/callout/tone muted for the moments we present; if it throws,
        // the mute is still restored (finally) and we carry on with this and the following events
        if (orig) { try { muted(on ? MUTE[e && e.k] : null, () => orig.call(this, { e: [e] })); } catch (err) { ST.stats.modesErrors = (ST.stats.modesErrors || 0) + 1; ST.lastErr = String(err && err.stack || err); } }
        if (on) safe(onEvent)(e);
      }
    };
    h.__rfx = true;
    // modes.js puts its own handler back whenever r.onMatch !== its handler: keep ours in front for good by making
    // onMatch a property whose setter just records the newest inner handler
    try {
      Object.defineProperty(r, 'onMatch', { configurable: true, enumerable: true, get: () => h, set: f => { if (typeof f === 'function' && !f.__rfx) { orig = f; if (early.length) { const q = early.splice(0); for (const d of q) h.call(r, d); } } else if (!f) orig = null; } });
      r.__rfxH = h;
    } catch (e) { h.__orig = orig; r.onMatch = h; }
    Object.defineProperty(h, '__orig', { configurable: true, get: () => orig });
    ST.attached = (ST.attached || 0) + 1;
  }
  if (typeof openRoom === 'function') {
    const _open = openRoom;
    openRoom = async function () { const ok = await _open.apply(this, arguments); try { const n = NETg(); if (ok && n && n.room) attach(n.room); } catch (e) {} return ok; };
  }

  // our own frame loop (cheap: a few comparisons per frame, DOM work only when something changes)
  const loop = () => { const a0 = now(); try { frame(); } catch (e) { ST.stats.errors++; ST.lastErr = String(e && e.stack || e); } ST.stats.fms = (ST.stats.fms || 0) + now() - a0; ST.stats.fn = (ST.stats.fn || 0) + 1; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  feedPolish(); setTimeout(feedPolish, 2000);

  /* ======================= preview / test API ======================= */
  // S9RoundFX.preview(name) shows any moment with sample data (used by screenshots and tests, works offline)
  const SAMPLE_TABLE = [
    { id: 'me', n: 'Ava', team: 'atk', kills: 21, deaths: 9, score: 27 }, { id: 'b', n: 'Ben', team: 'atk', kills: 14, deaths: 12, score: 17 },
    { id: 'c', n: 'Cy', team: 'def', kills: 17, deaths: 13, score: 21 }, { id: 'd', n: 'Dee', team: 'def', kills: 8, deaths: 16, score: 10 },
    { id: 'e', n: 'NightOwl_77', team: 'atk', kills: 11, deaths: 10, score: 13 }, { id: 'f', n: 'Vortex', team: 'def', kills: 10, deaths: 15, score: 12 }
  ];
  const SAMPLE_FFA = [
    { id: 'p1', n: 'Vortex', kills: 30 }, { id: 'me', n: 'Ava', kills: 26 }, { id: 'p3', n: 'NightOwl_77', kills: 22 }, { id: 'p4', n: 'Cy', kills: 19 },
    { id: 'p5', n: 'Ben', kills: 15 }, { id: 'p6', n: 'Kestrel', kills: 12 }, { id: 'p7', n: 'Dee', kills: 9 }, { id: 'p8', n: 'Lynx_', kills: 6 }
  ];
  function preview(name, o = {}) {
    ST.preview = true; clearAll(); const tm = o.team || 'atk';
    switch (name) {
      case 'roundStart': roundIntro({ round: o.round || 4, team: tm, objective: tm === 'atk' ? 'You carry the charge · plant it at site A or B (hold E)' : 'Defend sites A and B · stop the plant or defuse it' }); countdown(o.sec || 5, tm); break;
      case 'countdown': countdown(o.sec || 3, tm); break;
      case 'go': go(tm, 60000); break;
      case 'matchPoint': roundIntro({ round: 12, team: tm, objective: tm === 'atk' ? 'Escort the charge to site A or B' : 'Defend sites A and B · stop the plant or defuse it', matchPoint: o.mp || 'atk' }); countdown(4, tm); break;
      case 'planted': planted(o.site || 'A', tm === 'atk' ? 'def' : tm); break;
      case 'defused': defused(); break;
      case 'exploded': exploded(null); break;
      case 'roundWin': roundEnd({ winner: tm, mine: true, reason: o.reason || 'defused', score: { atk: 5, def: 3 }, prev: { atk: tm === 'atk' ? 4 : 5, def: tm === 'def' ? 2 : 3 }, left: tm, right: tm === 'atk' ? 'def' : 'atk', mvp: { name: 'Ava', kills: 3, team: tm, me: true }, round: 8, life: 60000 }); break;
      case 'roundLoss': roundEnd({ winner: tm === 'atk' ? 'def' : 'atk', mine: false, reason: o.reason || 'exploded', score: { atk: 3, def: 5 }, prev: { atk: 3, def: 4 }, left: tm, right: tm === 'atk' ? 'def' : 'atk', mvp: { name: 'Vortex', kills: 2, team: tm === 'atk' ? 'def' : 'atk' }, round: 8, life: 60000 }); break;
      case 'clutchWin': roundEnd({ winner: tm, mine: true, reason: 'eliminated', score: { atk: 6, def: 4 }, prev: { atk: 5, def: 4 }, left: tm, right: tm === 'atk' ? 'def' : 'atk', mvp: { name: 'Ava', kills: 3, team: tm, me: true }, clutch: true, round: 10, life: 60000 }); break;
      case 'clutch': clutchShow({ n: o.n || 3, me: o.me !== false, name: o.name || 'Ava' }); ST.clutch.beatT = 0; SND.heart(); break;
      case 'halftime': halftime({ myTeam: o.myTeam || 'def', life: 60000 }); break;
      case 'victory': final({ result: 'win', winner: 'atk', score: { atk: 7, def: 4 }, table: SAMPLE_TABLE, mode: o.mode || 'demo', me: 'me', myTeam: 'atk', life: 60000 }); break;
      case 'podium': { // FFA podium with me at place o.place (1..8)
        const t = SAMPLE_FFA.map(p => ({ ...p })), k = Math.max(1, Math.min(t.length, o.place || 1)) - 1, mi = t.findIndex(p => p.id === 'me');
        const ks = t.map(p => p.kills).sort((a, b) => b - a); const [me] = t.splice(mi, 1); t.splice(k, 0, me); t.forEach((p, i) => { p.kills = ks[i]; p.deaths = 4 + i * 2; p.score = ks[i] + 3; });
        me.acc = 41; final({ result: 'win', mode: 'ffa', table: t, me: 'me', winner: t[0].id, life: 60000 }); break;
      }
      case 'defeat': final({ result: 'lose', winner: 'def', score: { atk: 4, def: 7 }, table: SAMPLE_TABLE, mode: o.mode || 'demo', me: 'me', myTeam: 'atk', life: 60000 }); break;
      case 'teamWin': final({ result: 'win', winner: 'atk', score: o.mode === 'tdm' ? { atk: 30, def: 24 } : { atk: 7, def: 4 }, table: SAMPLE_TABLE.map(p => p.id === 'me' ? { ...p, acc: 38 } : p), mode: o.mode || 'demo', me: 'me', myTeam: 'atk', life: 60000 }); break;
      case 'teamLoss': final({ result: 'lose', winner: 'def', score: o.mode === 'tdm' ? { atk: 24, def: 30 } : { atk: 4, def: 7 }, table: SAMPLE_TABLE.map(p => p.id === 'me' ? { ...p, kills: 9, score: 11, acc: 31 } : p), mode: o.mode || 'demo', me: 'me', myTeam: 'atk', life: 60000 }); break;
      case 'toast': toast('YOU HAVE THE CHARGE', 'charge', TEAM.atk.css, 60000); break;
      case 'bar': {
        const B = document.getElementById('mxBar'); if (!B) break; ST.previewAct = { kind: o.kind || 'plant', kit: !!o.kit }; B.hidden = false;
        const T = document.getElementById('mxBarT'); if (T) T.textContent = o.kind === 'defuse' ? (o.kit ? 'DEFUSING WITH KIT…' : 'DEFUSING…') : 'PLANTING…';
        const F = document.getElementById('mxBarF'); if (F) F.style.width = (o.p || 62) + '%'; bar(); break;
      }
      case 'feed': if (typeof kfeedText === 'function') { kfeedText('Charge planted at site A'); kfeedText('Charge defused'); } break;
    }
  }
  function endPreview() { ST.preview = false; ST.previewAct = null; clearAll(); const B = document.getElementById('mxBar'); if (B && MX() && !MX().myAct) B.hidden = true; }

  async function measureMany(list, secs = 5) {   // [[name, args, delaySec], ...] mixed into one render (e.g. the FFA podium timeline)
    const C = window.OfflineAudioContext; if (!C) return null;
    const off = new C(2, Math.round(44100 * secs), 44100); const keep = [OUTctx, OUT, OUTdest];
    OVR = off; OUTctx = off; OUT = off.createGain(); OUT.gain.value = .55; OUT.connect(off.destination); OUTdest = off.destination;
    try { for (const [n, a, d] of list) { const ct = off.currentTime; Object.defineProperty(off, 'currentTime', { configurable: true, get: () => ct + (d || 0) }); SND[n].apply(SND, a || []); delete off.currentTime; } } finally { OVR = null; [OUTctx, OUT, OUTdest] = keep; }
    const buf = await off.startRendering(); let pk = 0; for (let ch = 0; ch < 2; ch++) for (const v of buf.getChannelData(ch)) { const a = Math.abs(v); if (a > pk) pk = a; }
    return { peak: pk };
  }
  async function measure(name, args = [], secs = 4) {
    const C = window.OfflineAudioContext; if (!C) return null;
    const off = new C(2, Math.round(44100 * secs), 44100); const keep = [OUTctx, OUT, OUTdest];
    OVR = off; OUTctx = off; OUT = off.createGain(); OUT.gain.value = .55; OUT.connect(off.destination); OUTdest = off.destination;
    try { SND[name].apply(SND, args); } finally { OVR = null; [OUTctx, OUT, OUTdest] = keep; }
    const buf = await off.startRendering(); let pk = 0, tail = 0; const tl = Math.round(44100 * .05);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > pk) pk = a; if (i >= d.length - tl && a > tail) tail = a; } }
    return { peak: pk, tail };
  }
  window.S9RoundFX = {
    measure, measureMany,
    enabled: true, ST, SND, preview, endPreview, skip: trySkip, clearAll, attach, onEvent: safe(onEvent),
    moments: ['roundStart', 'countdown', 'go', 'matchPoint', 'planted', 'defused', 'exploded', 'roundWin', 'roundLoss', 'clutchWin', 'clutch', 'halftime', 'victory', 'defeat', 'podium', 'teamWin', 'teamLoss', 'toast', 'bar', 'feed'],
    celebrate: o => final(o), whenDone, celebrating: () => !!CEL,
    active: () => Object.keys(SLOT), root, gain: () => (ctx(), OUT ? OUT.gain.value : null)
  };
})();
