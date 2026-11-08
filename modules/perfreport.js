/* Sector Nine - anonymous per-match FPS report (add-on module, no index.html edits).
   Purpose: tell the owner how the game runs on real players' PCs. ONE small summary per match goes to POST {server}/api/perf:
     { avg, low1, tier, scale, gpu, soft, igpu, phone, ping, ver, hz, p99, h50, gms, cms }
   avg = average FPS of the match, low1 = "1% low" FPS (average of the slowest 1% of frames), tier = graphics tier, scale = render scale (pixel ratio),
   gpu = GPU renderer string, soft/igpu/phone = software renderer / integrated GPU / phone flags, ping = ms (online only, else omitted), ver = game version.
   NO names, no account or room ids, no cookies, no user agent. The server keeps only these numbers and shows aggregates (GET /api/perf/summary).
   Public API: window.S9Perf { ready, enabled, stats() (live numbers of the running match), payload() (what would be sent now or null), finish() (send now), sent (count), last (last payload) }.
   Opt-out: localStorage 'sector9-noperf' = '1' or the URL parameter ?noperf=1. Hooks: none (it watches window.__s9.state each frame: play / paused / menu / matchend).
   A match counts only with >= 20 s of unpaused play and >= 300 frames; paused time, hidden-tab time and frames > 1 s are never counted. Fire and forget: errors are ignored,
   it never blocks gameplay (one 4-number accumulation per frame, nothing else). Data files: none. Server: bugs/perf.js in sector-nine-server. */
(() => {
'use strict';
if (window.S9Perf) return;

const DEFAULT_SRV = 'https://sector-nine-server-production.up.railway.app';
const MIN_SECS = 20, MIN_FRAMES = 300, MAX_FRAMES = 120000, MAX_FRAME_MS = 1000, MIN_GAP_MS = 60000;
const g = (f, d) => { try { const v = f(); return v === undefined ? d : v; } catch (e) { return d; } };
const S9 = () => window.__s9;

const API = { ready: false, enabled: true, sent: 0, last: null, lastErr: null };
window.S9Perf = API;

function optedOut() { return g(() => localStorage.getItem('sector9-noperf') === '1', false) || g(() => new URLSearchParams(location.search).get('noperf') === '1', false); }
function serverBase() {
  let u = g(() => new URLSearchParams(location.search).get('srv'), null);
  if (!u) u = g(() => (typeof SRV !== 'undefined' && SRV.url) || null, null);   // eslint-disable-line no-undef
  if (!u || !/^(wss?|https?):\/\/[^\s/]+/i.test(u)) u = DEFAULT_SRV;
  return u.replace(/^ws(s?):\/\//i, 'http$1://').replace(/\/+$/, '');
}
function gpuName() {
  return g(() => { const gl = S9().renderer.getContext(), x = gl.getExtension('WEBGL_debug_renderer_info'); return String(x ? gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)); }, '') || '';
}
const SOFT_RE = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic|warp/i;
const IGPU_RE = /intel|\buhd\b|\biris\b|hd graphics|mali|adreno|powervr|apple|radeon\(tm\) graphics|radeon graphics|\bvega\b|videocore/i;
const isPhone = () => g(() => matchMedia('(pointer:coarse)').matches && Math.min(screen.width, screen.height) < 700, false) || g(() => /android.+mobile|iphone|ipod/i.test(navigator.userAgent), false);

// ---- one match worth of frame times ----
let M = null;   // { ms: [], secs, last, hidden }
const fresh = () => ({ ms: [], secs: 0, last: 0 });
let prevState = null, lastSendAt = 0, gap = 0;

function summarize(ms, secs) {
  if (!ms.length || secs <= 0) return null;
  const srt = ms.slice().sort((a, b) => b - a), n = Math.max(1, Math.ceil(srt.length * 0.01));
  let worst = 0; for (let i = 0; i < n; i++) worst += srt[i];
  const round1 = v => Math.round(v * 10) / 10;
  const avg = ms.length / secs, low1 = 1000 / (worst / n);
  // beyond vsync (a 60 Hz screen caps avg at 60 and puts every 1% low under 60): the screen's refresh (median frame interval,
  // snapped to a common rate), the 99th percentile frame interval and hitches > 50 ms per minute
  const asc = ms.slice().sort((a, b) => a - b), med = asc[asc.length >> 1], raw = med > 0 ? 1000 / med : 0;
  const hz = [30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 170, 180, 200, 240, 280, 360].reduce((b, r) => Math.abs(r - raw) < Math.abs(b - raw) ? r : b, 60);
  const p99 = asc[Math.min(asc.length - 1, Math.floor(asc.length * 0.99))], h50 = ms.filter(v => v > 50).length / (secs / 60);
  return { avg: round1(avg), low1: round1(Math.min(low1, avg)), frames: ms.length, secs: round1(secs), hz: Math.abs(hz - raw) / hz < 0.06 ? hz : round1(raw), p99: round1(p99), h50: round1(h50) };
}
API.stats = () => M ? summarize(M.ms, M.secs) : null;

API.payload = () => {
  if (!M) return null;
  const s = summarize(M.ms, M.secs); if (!s || s.secs < MIN_SECS || s.frames < MIN_FRAMES) return null;
  const gpu = gpuName(), s9 = S9();
  const tier = String(g(() => window.S9GFX && S9GFX.status().tier, '') || g(() => CFG.q, 'balanced') || 'balanced').toLowerCase();   // eslint-disable-line no-undef
  const scale = g(() => s9.renderer.getPixelRatio(), 0) || g(() => window.devicePixelRatio, 1) || 1;
  const online = g(() => !!(s9.NET && s9.NET.room), false) || g(() => !!(typeof NET !== 'undefined' && NET && NET.room), false);   // eslint-disable-line no-undef
  const rtt = online ? g(() => { const r = (typeof SRV !== 'undefined' && SRV.rtt) || 0; return r ? Math.round(r) : null; }, null) : null;   // eslint-disable-line no-undef
  const p = { avg: s.avg, low1: s.low1, tier: ['performance', 'balanced', 'high', 'ultra'].includes(tier) ? tier : 'balanced', scale: Math.max(0.25, Math.min(4, Math.round(scale * 100) / 100)),
    gpu: gpu.slice(0, 80), soft: SOFT_RE.test(gpu), igpu: IGPU_RE.test(gpu) && !SOFT_RE.test(gpu), phone: isPhone() };
  if (rtt !== null && rtt >= 0 && rtt < 5000) p.ping = rtt;
  p.hz = s.hz; p.p99 = s.p99; p.h50 = s.h50;
  const st = g(() => window.S9GFX && S9GFX.status(), null); if (st && st.gpuMs > 0) p.gms = Math.round(st.gpuMs * 10) / 10; if (st && st.cpuMs > 0) p.cms = Math.round(st.cpuMs * 10) / 10;   // what a frame costs (headroom under a capped screen)
  const ver = g(() => String(window.S9_VERSION || '').slice(0, 32), ''); if (ver) p.ver = ver;
  return p;
};

function send(p) {
  API.last = p;
  try {
    fetch(serverBase() + '/api/perf', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p), keepalive: true, credentials: 'omit', mode: 'cors', cache: 'no-store' })
      .then(r => { if (r.ok) API.sent++; else API.lastErr = 'HTTP ' + r.status; }).catch(e => { API.lastErr = String(e && e.message || e); });
  } catch (e) { API.lastErr = String(e && e.message || e); }
}
// send the finished match (if it counts), then forget it
API.finish = () => {
  if (!M) return false;
  const p = (!optedOut() && API.enabled) ? API.payload() : null;
  M = null;   // the match is over either way
  if (!p || Date.now() - lastSendAt < MIN_GAP_MS) return false;   // at most one report a minute from this browser
  lastSendAt = Date.now(); send(p); return true;
};

// ---- per-frame accounting (cheap: one subtraction and one push) ----
function tick(t) {
  requestAnimationFrame(tick);
  const s9 = S9(); if (!s9) return;
  const st = s9.state;
  if (st !== prevState) {
    if (st === 'play' && prevState !== 'paused') M = fresh();                 // a new match (paused -> play continues the same one)
    if ((st === 'menu' || st === 'matchend') && (prevState === 'play' || prevState === 'paused')) API.finish();   // left the match: report it
    prevState = st; gap = 0;
    if (M) M.last = t;
    return;
  }
  if (st !== 'play' || !M) { if (M) M.last = t; return; }
  const dt = t - M.last; M.last = t;
  if (document.hidden || dt <= 0 || dt > MAX_FRAME_MS) return;           // hidden tab / long pause: not a frame the player saw
  if (M.ms.length < MAX_FRAMES) { M.ms.push(dt); M.secs += dt / 1000; }
}
function start() {
  if (!S9()) { setTimeout(start, 300); return; }
  prevState = S9().state;
  requestAnimationFrame(tick);
  addEventListener('pagehide', () => { try { if (M && prevState === 'play') API.finish(); } catch (e) {} });
  API.ready = true;
}
start();
})();
