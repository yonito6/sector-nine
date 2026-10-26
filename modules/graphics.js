/* Sector Nine - graphics upgrade (modules/graphics.js)
   Loads right after the main game script (see graphics.INTEGRATE.md) and hooks into its globals.
   What it adds, per quality tier (Performance / Balanced / High / Ultra, default picked from the graphics card):
   - Edge smoothing (FXAA) + detail sharpening + a richer colour grade, folded into the game's existing final pass
     (no extra full-screen pass); Ultra uses 4x MSAA instead.
   - Baked ambient-occlusion VOLUME per map (Blender, render/gfx/bake_ao.py): soft contact shadows at wall bases,
     corners, under stairs and around players, for one texture read per pixel.
   - Height fog with sun glow (depth and atmosphere), per-map look presets (colour, bloom, haze).
   - 2K textures (Poly Haven CC0) + 16x anisotropic filtering on High/Ultra, sharper sun shadows on Ultra.
   - Smarter auto-quality: only lowers graphics when the GRAPHICS CARD is the bottleneck (measured with GPU timers),
     never just because the CPU is busy; never switches shaders mid-match.
   Rules kept: no new lights, no new draw calls, every shader prepared at load (tier switches are uniform changes). */
(function () {
  'use strict';
  if (window.S9GFX) return;
  // which of the game's globals exist (looked up once; typeof is safe for names that were never declared)
  const H = {
    composer: typeof composer !== 'undefined', renderer: typeof renderer !== 'undefined', QUALITY: typeof QUALITY !== 'undefined', CFG: typeof CFG !== 'undefined',
    applyQuality: typeof applyQuality === 'function', saveCfg: typeof saveCfg === 'function', MAPROOT: typeof MAPROOT !== 'undefined', robots: typeof robots !== 'undefined',
    ASSET: typeof ASSET !== 'undefined', MAPS: typeof MAPS !== 'undefined', sun: typeof sun !== 'undefined', scene: typeof scene !== 'undefined', bloom: typeof bloom !== 'undefined',
    grade: typeof grade !== 'undefined', state: typeof state !== 'undefined', CUR_MAP: typeof CUR_MAP !== 'undefined', mergeStatic: typeof mergeStatic === 'function',
    newRoster: typeof newRoster === 'function', loadMap: typeof loadMap === 'function', warmShaders: typeof warmShaders === 'function', frame: typeof frame === 'function',
    prTimer: typeof prTimer !== 'undefined', PR: typeof PR !== 'undefined', resize: typeof resize === 'function', feed: typeof feed === 'function', gunScene: typeof gunScene !== 'undefined',
    camera: typeof camera !== 'undefined', HALF: typeof HALF !== 'undefined', startMatch: typeof startMatch === 'function', syncSettings: typeof syncSettings === 'function',
  };
  const has = n => !!H[n];
  if (!has('composer') || !has('renderer') || !has('QUALITY') || !has('CFG') || !has('applyQuality') || !has('grade') || !has('bloom')) { console.warn('[gfx] game globals not found, graphics module idle'); return; }
  const T = THREE, gl = renderer.getContext(), WEBGL2 = renderer.capabilities.isWebGL2;
  const LS = 'sector9-gfx', ORDER = ['performance', 'balanced', 'high', 'ultra'];

  /* ---------- tiers ---------- */
  // maxPR/shadow/bloom/msaa are read by the game's own applyQuality(); the rest is ours.
  const TIERS = {
    performance: { label: 'Performance', maxPR: .7, shadow: 0, bloom: false, msaa: 0, aa: 1, sharp: .35, ao: 0, fog: 0, probe: 0, aniso: 4, hd: false, grain: .02, bloomK: .8 },
    balanced: { label: 'Balanced', maxPR: .85, shadow: 2048, bloom: true, msaa: 0, aa: 1, sharp: .4, ao: 1, fog: 1, probe: .75, aniso: 8, hd: true, grain: .016, bloomK: 1 },
    high: { label: 'High', maxPR: 1, shadow: 2048, bloom: true, msaa: 0, aa: 1, sharp: .3, ao: 1, fog: 1, probe: 1, aniso: 16, hd: true, grain: .012, bloomK: 1 },
    ultra: { label: 'Ultra', maxPR: 1.5, shadow: 4096, bloom: true, msaa: 4, aa: 0, sharp: .25, ao: 1, fog: 1, probe: 1, aniso: 16, hd: true, grain: .01, bloomK: 1.05 },
  };
  for (const k of ORDER) QUALITY[k] = Object.assign(QUALITY[k] || {}, { maxPR: TIERS[k].maxPR, shadow: TIERS[k].shadow, bloom: TIERS[k].bloom, msaa: TIERS[k].msaa });
  const maxAnisoHW = renderer.capabilities.getMaxAnisotropy();

  /* ---------- per-map look (futuristic + fun: clean contrast, vivid accents, readable shadows) ---------- */
  // sat = saturation, con = S-curve contrast, sh/hi = shadow/highlight tint, vig = vignette, bloom = strength x,
  // fogH = height-fog amount (0..1), fall = how fast haze thins with height (per m), boost = extra haze at ground,
  // scat = sun glow in the haze, ao = occlusion strength
  const LOOK_BASE = { sat: 1.12, con: .26, sh: [.92, 1, 1.08], hi: [1.06, 1, .92], vig: .42, bloom: 1, fogH: .8, fall: .09, boost: 1.45, scat: .5, ao: 1, aoDirect: .4, probe: 1 };
  const LOOK = {
    dunes: { sat: 1.1, con: .2, sh: [.9, .98, 1.1], hi: [1.07, 1.01, .9], fall: .07, boost: 1.6, scat: .9, aoDirect: .4 },
    neon: { sat: 1.24, con: .28, sh: [.95, .92, 1.14], hi: [1.06, .98, 1.02], bloom: 1.25, fall: .12, boost: 1.7, scat: .35, ao: 1.1 },
    foundry: { sat: 1.16, con: .2, sh: [.9, .96, 1.1], hi: [1.1, .99, .86], bloom: 1.15, fall: .1, boost: 1.5, scat: .6 },
    glacier: { sat: 1.06, con: .14, sh: [.92, 1, 1.1], hi: [1.02, 1.01, 1], fall: .06, boost: 1.4, scat: .7 },
    docks: { sat: 1.08, con: .16, fall: .1, boost: 1.6, scat: .3 },
    orbital: { sat: 1.12, con: .2, fogH: .4, scat: .4, bloom: 1.1 },
    biolab: { sat: 1.16, con: .18, sh: [.92, 1.04, 1.02], hi: [1.04, 1.02, .94], boost: 1.6 },
    caverns: { sat: 1.2, con: .18, bloom: 1.2, boost: 1.5, ao: 1.15 },
    shrine: { sat: 1.12, con: .16, hi: [1.08, 1, .9], scat: .9 },
    grid: { sat: 1.2, con: .2, bloom: 1.2, fogH: .5 },
    yard: { sat: 1.12, con: .18 },
  };
  const lookOf = id => Object.assign({}, LOOK_BASE, LOOK[id] || {});

  /* ---------- state ---------- */
  const read = () => { try { return JSON.parse(localStorage.getItem(LS) || 'null'); } catch (e) { return null; } };
  const write = o => { try { localStorage.setItem(LS, JSON.stringify(o)); } catch (e) {} };
  const gpuName = (() => { try { const x = gl.getExtension('WEBGL_debug_renderer_info'); return String(x ? gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)); } catch (e) { return '?'; } })();
  function detectTier() {
    const n = gpuName, mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) || (matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600);
    if (!WEBGL2 || /swiftshader|llvmpipe|software|basic render/i.test(n)) return 'performance';
    if (mobile) return 'performance';
    if (/intel|uhd|iris|hd graphics|mali|adreno|powervr|videocore/i.test(n)) return /iris\(r\) xe|iris xe|arc\(tm\) a|arc a/i.test(n) ? 'balanced' : 'performance';
    // dedicated cards start on Balanced: same render resolution as the old default (so frame pacing can't get worse),
    // with every new effect on; High (full resolution) and Ultra (MSAA, 4K shadows) are one click away
    if (/rtx|gtx|nvidia|geforce|radeon|amd|apple m\d|apple gpu/i.test(n)) return 'balanced';
    return 'balanced';
  }
  const detected = detectTier();
  const saved = read();
  const startTier = saved && saved.user && TIERS[saved.tier] ? saved.tier : detected;
  CFG.q = startTier; try { saveCfg(); } catch (e) {}
  const S = {
    ready: false, tier: startTier, detected, gpu: gpuName, user: !!(saved && saved.user), map: null, look: lookOf(null),
    aoMaps: {}, aoLoaded: {}, hdLoaded: {}, gpuMs: 0, cpuMs: 0, adapt: { lowered: 0, gpuBound: 0, own: false }, warmMs: 0, applied: { hd: null, aniso: 0 },
  };

  /* ---------- shared uniforms (one object in every patched shader: switching tiers never recompiles) ---------- */
  const blank3D = (() => { if (!WEBGL2) return null; const t = new T.Data3DTexture(new Uint8Array([255]), 1, 1, 1); t.format = T.RedFormat; t.type = T.UnsignedByteType; t.minFilter = t.magFilter = T.LinearFilter; t.unpackAlignment = 1; t.needsUpdate = true; return t; })();
  const U = {
    s9AOVol: { value: blank3D }, s9AOMin: { value: new T.Vector3(-1, -1, -1) }, s9AOSize: { value: new T.Vector3(2, 2, 2) },
    s9AOStr: { value: 0 }, s9AODir: { value: .3 }, s9AOOff: { value: .3 },
    s9FogH: { value: 0 }, s9FogBase: { value: 0 }, s9FogFall: { value: .09 }, s9FogBoost: { value: 1.45 },
    s9SunDir: { value: new T.Vector3(0, 1, 0) }, s9SunCol: { value: new T.Color(1, 1, 1) }, s9SunScat: { value: 0 },
    s9Probe: { value: null }, s9ProbeK: { value: 0 }, s9ProbePos: { value: new T.Vector3() }, s9BoxMin: { value: new T.Vector3(-50, -1, -50) }, s9BoxMax: { value: new T.Vector3(50, 40, 50) },
  };
  const blank2D = new T.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); blank2D.needsUpdate = true; U.s9Probe.value = blank2D;
  const FRAG_PARS = `
varying vec3 vS9W;
uniform highp sampler3D s9AOVol; uniform vec3 s9AOMin, s9AOSize; uniform float s9AOStr, s9AODir, s9AOOff;
uniform float s9FogH, s9FogBase, s9FogFall, s9FogBoost, s9SunScat; uniform vec3 s9SunDir, s9SunCol;
uniform sampler2D s9Probe; uniform float s9ProbeK; uniform vec3 s9ProbePos, s9BoxMin, s9BoxMax;`;
  // baked occlusion: sample the map's AO volume a little in front of the surface; darkens ambient + reflections,
  // and a bit of direct light so contact shadows read even in full sun
  const AO_CODE = `
if (s9AOStr > 0.001) {
  vec3 s9n = (vec4(normal, 0.0) * viewMatrix).xyz;
  vec3 s9u = (vS9W + s9n * s9AOOff - s9AOMin) / s9AOSize;
  float s9o = texture(s9AOVol, s9u.xzy).r;
  // squared: rooms (moderately enclosed) keep most of their light, tight corners and contact points darken most
  float s9oc = 1.0 - s9o;
  s9o = clamp(1.0 - s9oc * s9oc * 1.6 * s9AOStr, 0.45, 1.0);
  reflectedLight.indirectDiffuse *= s9o;
  reflectedLight.directDiffuse *= mix(1.0, s9o, s9AODir);
  #if defined( USE_ENVMAP ) && defined( STANDARD )
    reflectedLight.indirectSpecular *= computeSpecularOcclusion(saturate(dot(geometry.normal, geometry.viewDir)), s9o, material.roughness);
  #endif
}`;
  // map reflections: a light probe photographed inside the map at load time (same format as the sky reflections),
  // box-projected onto the map's bounds so a wet floor reflects the actual walls/signs where they really are
  const PROBE_CODE = `
#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular ) && defined( ENVMAP_TYPE_CUBE_UV )
if (s9ProbeK > 0.001) {
  vec3 s9rv = reflect(-geometry.viewDir, geometry.normal);
  s9rv = normalize(mix(s9rv, geometry.normal, material.roughness * material.roughness));
  s9rv = inverseTransformDirection(s9rv, viewMatrix);
  vec3 s9t1 = (s9BoxMax - vS9W) / s9rv, s9t2 = (s9BoxMin - vS9W) / s9rv, s9tf = max(s9t1, s9t2);
  float s9t = min(min(s9tf.x, s9tf.y), s9tf.z);
  vec3 s9d = normalize(mix(s9rv, vS9W + s9rv * s9t - s9ProbePos, 1.0 - material.roughness));
  vec3 s9pr = textureCubeUV(s9Probe, s9d, material.roughness).rgb * envMapIntensity;
  radiance = mix(radiance, s9pr, s9ProbeK);
}
#endif`;
  // height fog: same exp2 falloff with distance as before, but thicker near the ground and thinner up high
  // (integrated along the view ray), with a warm glow toward the sun
  const FOG_CODE = `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float s9fd = fogDensity * vFogDepth; float s9ff = s9fd * s9fd;
    vec3 s9fc = fogColor;
    if (s9FogH > 0.001) {
      float s9h0 = max(cameraPosition.y - s9FogBase, 0.0), s9h1 = max(vS9W.y - s9FogBase, 0.0);
      float s9hf = abs(s9h1 - s9h0) > 0.05 ? (exp(-s9FogFall * s9h0) - exp(-s9FogFall * s9h1)) / (s9FogFall * (s9h1 - s9h0)) : exp(-s9FogFall * s9h0);
      s9ff *= mix(1.0, s9hf * s9FogBoost, s9FogH);
      vec3 s9vd = normalize(vS9W - cameraPosition);
      s9fc += s9SunCol * pow(max(dot(s9vd, s9SunDir), 0.0), 6.0) * s9SunScat;
    }
    float fogFactor = 1.0 - exp(-s9ff);
  #else
    vec3 s9fc = fogColor; float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
  #endif
  gl_FragColor.rgb = mix(gl_FragColor.rgb, s9fc, fogFactor);
#endif`;
  const VERT_CODE = `
{ vec4 s9p = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  s9p = instanceMatrix * s9p;
#endif
  vS9W = (modelMatrix * s9p).xyz; }`;
  function obcLit(sh) {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vS9W;').replace('#include <fog_vertex>', '#include <fog_vertex>' + VERT_CODE);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>' + FRAG_PARS).replace('#include <lights_fragment_maps>', '#include <lights_fragment_maps>' + PROBE_CODE).replace('#include <aomap_fragment>', '#include <aomap_fragment>' + AO_CODE).replace('#include <fog_fragment>', FOG_CODE);
  }
  function obcBasic(sh) {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vS9W;').replace('#include <fog_vertex>', '#include <fog_vertex>' + VERT_CODE);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>' + FRAG_PARS).replace('#include <fog_fragment>', FOG_CODE);
  }
  const keyLit = () => 's9gfx-lit-3', keyBasic = () => 's9gfx-basic-1';
  // Every lit/flat material in the game is upgraded at the class level (so bodies, drops, clones made mid-match share
  // the shaders prepared at load). The world effects are only switched on while the main world scene is drawn
  // (scene.onBeforeRender); the first-person gun scene and other preview scenes render with them at zero.
  let patchedCount = 0;
  const ACT = { ao: 0, probe: 0, fogH: 0, scat: 0 };
  if (WEBGL2) {
    T.MeshStandardMaterial.prototype.onBeforeCompile = obcLit; T.MeshStandardMaterial.prototype.customProgramCacheKey = keyLit;
    T.MeshBasicMaterial.prototype.onBeforeCompile = obcBasic; T.MeshBasicMaterial.prototype.customProgramCacheKey = keyBasic;
    if (has('scene')) {
      scene.onBeforeRender = () => { U.s9AOStr.value = ACT.ao; U.s9ProbeK.value = ACT.probe; U.s9FogH.value = ACT.fogH; U.s9SunScat.value = ACT.scat; };
      scene.onAfterRender = () => { U.s9AOStr.value = 0; U.s9ProbeK.value = 0; U.s9FogH.value = 0; U.s9SunScat.value = 0; };
    }
  }
  const upgraded = m => m.onBeforeCompile === obcLit || m.onBeforeCompile === obcBasic;
  function patchMat(m, recompile) {
    if (!WEBGL2 || !m || m.userData.s9g) return;
    m.userData.s9g = 1;
    if (upgraded(m)) { patchedCount++; if (recompile) m.needsUpdate = true; }
  }
  const patchTree = (root, recompile) => root && root.traverse(o => { if ((o.isMesh || o.isInstancedMesh || o.isSkinnedMesh) && o.material) [].concat(o.material).forEach(m => patchMat(m, recompile)); });
  const patchWorld = recompile => { if (has('scene')) patchTree(scene, recompile); if (has('gunScene')) patchTree(gunScene, recompile); };

  /* ---------- final pass: FXAA + sharpen + grade (replaces the game's grade shader, same uniforms) ---------- */
  const GRADE_FRAG = `
uniform sampler2D tDiffuse; uniform float uTime,uHurt,uHit,uAds,uDying,uExposure; uniform vec2 uRes; varying vec2 vUv;
uniform float uAA, uSharp, uGrain, uSat, uCon, uVig; uniform vec3 uShT, uHiT;
vec3 aces(vec3 x){ return clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),0.,1.); }
vec3 tm(vec2 uv){ vec3 c = clamp(texture2D(tDiffuse, uv).rgb, 0., 64.); if (c.r != c.r || c.g != c.g || c.b != c.b) c = vec3(0.); return aces(c*uExposure); }
float lu(vec3 c){ return dot(c, vec3(.299,.587,.114)); }
void main(){
  vec2 px = 1./uRes;
  vec3 cM = tm(vUv), cNW = tm(vUv + vec2(-.5,-.5)*px), cNE = tm(vUv + vec2(.5,-.5)*px), cSW = tm(vUv + vec2(-.5,.5)*px), cSE = tm(vUv + vec2(.5,.5)*px);
  float lM = lu(cM), lNW = lu(cNW), lNE = lu(cNE), lSW = lu(cSW), lSE = lu(cSE);
  float lMin = min(lM, min(min(lNW,lNE), min(lSW,lSE))), lMax = max(lM, max(max(lNW,lNE), max(lSW,lSE)));
  vec3 col = cM;
  if (uAA > .5 && lMax - lMin > max(.04, lMax*.14)) {
    vec2 dir = vec2(-((lNW+lNE)-(lSW+lSE)), (lNW+lSW)-(lNE+lSE));
    float red = max((lNW+lNE+lSW+lSE)*.03125, 1./128.);
    dir = clamp(dir * (1./(min(abs(dir.x),abs(dir.y))+red)), -8., 8.) * px;
    vec3 a = .5*(tm(vUv + dir*(1./3.-.5)) + tm(vUv + dir*(2./3.-.5)));
    vec3 b = a*.5 + .25*(tm(vUv - dir*.5) + tm(vUv + dir*.5));
    float lb = lu(b); col = (lb < lMin || lb > lMax) ? a : b;
  } else if (uSharp > 0.) {
    vec3 blur = (cNW+cNE+cSW+cSE)*.25, mn = min(min(cNW,cNE),min(cSW,cSE)), mx = max(max(cNW,cNE),max(cSW,cSE));
    col = clamp(cM + (cM - blur)*uSharp*2.2, min(mn,cM), max(mx,cM));
  }
  vec2 cc = vUv - .5; float r = dot(cc,cc);
  float ca = uHit*.005 + uDying*.01;
  if (ca > .0005) { col.r = tm(vUv - cc*ca).r; col.b = tm(vUv + cc*ca).b; }
  float l = dot(col, vec3(.2126,.7152,.0722));
  col = mix(col, col*uShT, (1.-l)*.45);
  col = mix(col, col*uHiT, l*.4);
  col = max(mix(vec3(l), col, uSat), 0.);
  col = mix(vec3(l), col, 1. - uHurt*.55 - uDying*.85);
  col = mix(col, vec3(.55,.03,.02), uHit*.55*smoothstep(.25,.9,r*2.6));
  col *= 1. - smoothstep(.2, 1.1, r*2.3)*(uVig + uAds*.35 + uHurt*.3);
  col = pow(clamp(col, 0., 1.), vec3(1./2.2));
  col = mix(col, col*col*(3.-2.*col), uCon);
  float n = fract(sin(dot(floor(vUv*uRes) + fract(uTime*7.13)*97.0, vec2(12.9898,78.233)))*43758.5453);
  col += (n-.5)*uGrain;
  gl_FragColor = vec4(col,1.);
}`;
  const GU = grade.uniforms;
  Object.assign(GU, { uAA: { value: 1 }, uSharp: { value: .3 }, uGrain: { value: .015 }, uSat: { value: 1.1 }, uCon: { value: .15 }, uVig: { value: .45 }, uShT: { value: new T.Vector3(.92, 1, 1.08) }, uHiT: { value: new T.Vector3(1.06, 1, .92) } });
  grade.material.uniforms = GU; grade.material.fragmentShader = GRADE_FRAG; grade.material.needsUpdate = true;

  /* ---------- AO volume per map ---------- */
  function loadAO(id) {
    if (!WEBGL2) return Promise.resolve(null);
    if (S.aoMaps[id] !== undefined) return Promise.resolve(S.aoMaps[id]);
    if (S.aoLoaded[id]) return S.aoLoaded[id];
    return (S.aoLoaded[id] = (async () => {
      try {
        const r = await fetch('assets/tex/hd/ao_' + id + '.json'); if (!r.ok) throw 0; const L = await r.json();
        const img = new Image(); img.src = 'assets/tex/hd/ao_' + id + '.png'; await img.decode();
        const bm = await createImageBitmap(img, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
        const [nx, ny, nz] = L.dims, cv = document.createElement('canvas'); cv.width = bm.width; cv.height = bm.height;
        const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(bm, 0, 0); const px = g.getImageData(0, 0, bm.width, bm.height).data;
        const data = new Uint8Array(nx * ny * nz);   // texture: width = x, height = z, depth = y
        for (let j = 0; j < ny; j++) { const tx = (j % L.cols) * nx, ty = Math.floor(j / L.cols) * nz;
          for (let k = 0; k < nz; k++) { const row = ((ty + k) * bm.width + tx) * 4, o = (j * nz + k) * nx; for (let i = 0; i < nx; i++) data[o + i] = px[row + i * 4]; } }
        const t = new T.Data3DTexture(data, nx, nz, ny); t.format = T.RedFormat; t.type = T.UnsignedByteType; t.minFilter = t.magFilter = T.LinearFilter;
        t.wrapS = t.wrapT = t.wrapR = T.ClampToEdgeWrapping; t.unpackAlignment = 1; t.needsUpdate = true;
        return (S.aoMaps[id] = { tex: t, min: new T.Vector3(...L.min), size: new T.Vector3(...L.size), data, dims: L.dims });
      } catch (e) { return (S.aoMaps[id] = null); }
    })());
  }
  // CPU lookup of the same volume (first-person gun picks up the shade of where you stand)
  function aoAt(p) {
    const A = S.aoMaps[S.map]; if (!A) return 1; const [nx, ny, nz] = A.dims;
    const fx = (p.x - A.min.x) / A.size.x * nx - .5, fy = (p.y - A.min.y) / A.size.y * ny - .5, fz = (p.z - A.min.z) / A.size.z * nz - .5;
    const i = Math.max(0, Math.min(nx - 1, Math.round(fx))), j = Math.max(0, Math.min(ny - 1, Math.round(fy))), k = Math.max(0, Math.min(nz - 1, Math.round(fz)));
    return A.data[(j * nz + k) * nx + i] / 255;
  }

  /* ---------- HD textures (2K, Poly Haven CC0) ---------- */
  const HD = ['sand_02', 'sandstone_blocks_08', 'large_sandstone_blocks', 'worn_asphalt', 'precast_concrete_wall', 'volcanic_rock_tiles', 'dark_brick_wall', 'metal_grate_rusty', 'metal_plate',
    'snow_floor', 'rock_wall_08', 'red_brick', 'rusty_corrugated_iron', 'wood_floor_deck', 'japanese_stone_wall', 'forest_ground_06', 'green_metal_rust'];
  const LOW = {};   // the original 1K sets, kept so a lower tier can swap back
  function loadHD(names) {
    const TL = new T.TextureLoader();
    const img = (f, srgb) => new Promise(res => TL.load('assets/tex/hd/' + f, t => { t.encoding = srgb ? T.sRGBEncoding : T.LinearEncoding; t.wrapS = t.wrapT = T.RepeatWrapping; res(t); }, undefined, () => res(null)));
    return Promise.all(names.filter(n => HD.includes(n) && !S.hdLoaded[n]).map(n => (S.hdLoaded[n] = Promise.all([img(n + '_diff.jpg', true), img(n + '_nor_gl.jpg', false)]).then(([d, nm]) => (S.hdLoaded[n] = d && nm ? { d, n: nm } : null)))));
  }
  // swap texture objects on the current map's materials (same shader, so no recompiles) + set anisotropy
  function applyTextures() {
    if (!has('ASSET') || !ASSET.world) return;
    const want = TIERS[S.tier].hd, an = Math.min(TIERS[S.tier].aniso, maxAnisoHW), swap = new Map(), touched = new Set();
    for (const n of Object.keys(ASSET.world)) {
      const set = ASSET.world[n]; if (!set) continue; if (!LOW[n]) LOW[n] = { d: set.d, n: set.n };
      const hd = S.hdLoaded[n] && S.hdLoaded[n].d ? S.hdLoaded[n] : null;
      const to = want && hd ? hd : LOW[n], from = to === hd ? LOW[n] : hd;
      if (from) { swap.set(from.d, to.d); swap.set(from.n, to.n); }
      set.d = to.d; set.n = to.n;
    }
    const fix = t => { if (!t || touched.has(t)) return; touched.add(t); if (t.anisotropy !== an && t.image) { t.anisotropy = an; t.needsUpdate = true; } };
    if (has('MAPROOT')) MAPROOT.traverse(o => { if (!o.material) return; [].concat(o.material).forEach(m => {
      for (const k of ['map', 'normalMap']) { const s = m[k] && swap.get(m[k]); if (s && s !== m[k]) { // keep the material's own tiling on a swapped texture
          s.repeat.copy(m[k].repeat); s.offset.copy(m[k].offset); m[k] = s; } }
      for (const k of ['map', 'normalMap', 'roughnessMap', 'aoMap', 'emissiveMap']) fix(m[k]); }); });
    for (const t of touched) { try { renderer.initTexture(t); } catch (e) {} }   // upload now (behind loading), not on first sight
    S.applied = { hd: want, aniso: an };
  }

  /* ---------- map reflection probe (captured once per map load; never during play) ---------- */
  let probeCube = null, probeRT = null;
  function captureProbe() {
    S.probe = false; U.s9Probe.value = blank2D; ACT.probe = 0; S.capturing = true;
    if (!WEBGL2 || !has('scene') || !has('MAPROOT')) return;
    try {
      const t0 = performance.now(), Hf = has('HALF') ? HALF : 32, A = S.aoMaps[S.map];
      // stand the probe in the most open spot near the middle at head height (not inside the centre statue)
      let best = [0, 2, 0], bs = -1;
      for (let r = 0; r <= Hf * .5; r += 2) for (let a = 0; a < 6.283; a += r ? 1.2 / Math.max(1, r * .25) : 7) {
        const x = Math.cos(a) * r, z = Math.sin(a) * r, o = A ? aoAt({ x, y: 1.9, z }) : 1, sc = o - r / Hf * .15;
        if (sc > bs + .02) { bs = sc; best = [x, 1.9, z]; } }
      if (!probeCube) probeCube = new T.WebGLCubeRenderTarget(256, { type: T.HalfFloatType, generateMipmaps: false });
      const cam = new T.CubeCamera(.1, 600, probeCube); cam.position.set(...best); cam.updateMatrixWorld(true);
      const hide = []; for (const r of (has('robots') ? robots : [])) if (r.root && r.root.visible) { hide.push(r.root); r.root.visible = false; }
      const ac = renderer.autoClear, prev = renderer.getRenderTarget(); renderer.autoClear = true;
      cam.update(renderer, scene);
      renderer.autoClear = ac; renderer.setRenderTarget(prev); for (const o of hide) o.visible = true;
      const pm = new T.PMREMGenerator(renderer); if (probeRT) probeRT.dispose(); probeRT = pm.fromCubemap(probeCube.texture); pm.dispose();
      U.s9Probe.value = probeRT.texture; U.s9ProbePos.value.set(...best);
      const top = A ? A.min.y + A.size.y : 24; U.s9BoxMin.value.set(-Hf - 1, -0.5, -Hf - 1); U.s9BoxMax.value.set(Hf + 1, Math.max(top, 8), Hf + 1);
      S.probe = true; S.probeAt = best; S.probeMs = Math.round(performance.now() - t0);
    } catch (e) { console.warn('[gfx] probe', e); }
    S.capturing = false;
  }

  /* ---------- per-map + per-tier settings (uniform writes only) ---------- */
  function applyLook() {
    const L = S.look = lookOf(S.map), Tt = TIERS[S.tier];
    GU.uAA.value = Tt.aa; GU.uSharp.value = Tt.sharp; GU.uGrain.value = Tt.grain;
    GU.uSat.value = L.sat; GU.uCon.value = L.con; GU.uVig.value = L.vig; GU.uShT.value.set(...L.sh); GU.uHiT.value.set(...L.hi);
    const A = S.aoMaps[S.map];
    if (A) { U.s9AOVol.value = A.tex; U.s9AOMin.value.copy(A.min); U.s9AOSize.value.copy(A.size); }
    else U.s9AOVol.value = blank3D;
    ACT.ao = A && Tt.ao ? L.ao : 0; U.s9AODir.value = L.aoDirect;
    ACT.fogH = Tt.fog ? L.fogH : 0; U.s9FogFall.value = L.fall; U.s9FogBoost.value = L.boost; U.s9FogBase.value = 0;
    ACT.scat = Tt.fog ? L.scat : 0;
    ACT.probe = S.probe && !S.capturing ? Tt.probe * L.probe : 0;
    if (has('sun') && sun) { U.s9SunDir.value.copy(sun.position).normalize(); U.s9SunCol.value.copy(sun.color).multiplyScalar(Math.min(1.2, sun.intensity) * .12); }
    if (has('scene') && scene.fog) U.s9SunCol.value.lerp(scene.fog.color, .35);
    if (bloom) { if (S.bloom0 === undefined) S.bloom0 = { s: bloom.strength, r: bloom.radius, t: bloom.threshold }; bloom.strength = S.bloom0.s * L.bloom * Tt.bloomK; bloom.radius = S.bloom0.r; bloom.threshold = S.bloom0.t; }
  }

  /* ---------- hooks into the game ---------- */
  const inMatch = () => has('state') && (state === 'play' || state === 'paused' || state === 'dead');
  // bloom/AO/grade programs must exist before a match: compile everything once while loading
  function warmExtra() {
    const t0 = performance.now();
    try { if (bloom && !bloom.enabled) { bloom.enabled = true; composer.render(0); bloom.enabled = false; } else composer.render(0); } catch (e) {}
    S.warmMs = Math.round(performance.now() - t0);
  }
  const _applyQuality = applyQuality;
  applyQuality = function (keepShadows) {
    if (!TIERS[CFG.q]) CFG.q = S.tier;
    // the game's auto-lowering steps high -> balanced -> performance; from ultra step to high, not straight to performance
    if (keepShadows === true && S.tier === 'ultra' && CFG.q === 'performance') CFG.q = 'high';
    const prev = S.tier; S.tier = CFG.q;
    // never flip shadows (= rebuild every shader) during a match; startMatch applies it behind the warm-up
    _applyQuality.call(this, inMatch() ? true : keepShadows);
    applyLook();
    if (!inMatch() && (S.applied.hd !== TIERS[S.tier].hd || S.applied.aniso !== Math.min(TIERS[S.tier].aniso, maxAnisoHW))) {
      (TIERS[S.tier].hd && has('MAPS') ? loadHD(((MAPS.find(m => m.id === S.map) || {}).tex) || []) : Promise.resolve()).then(() => { if (!inMatch()) applyTextures(); });
    }
    if (prev !== S.tier) syncOptions();
  };
  if (has('mergeStatic')) { const _ms = mergeStatic; mergeStatic = function () { const r = _ms.apply(this, arguments); patchWorld(false); return r; }; }
  if (has('newRoster')) { const _nr = newRoster; newRoster = function () { const r = _nr.apply(this, arguments); for (const b of robots) patchTree(b.root, false); return r; }; }
  if (has('loadMap')) {
    const _lm = loadMap;
    loadMap = async function (id) {
      const def = (has('MAPS') && MAPS.find(m => m.id === id)) || null, mid = def ? def.id : id;
      const pre = Promise.all([loadAO(mid), TIERS[S.tier].hd && def ? loadHD(def.tex || []) : null]);
      const r = await _lm.apply(this, arguments);
      await pre;
      S.map = has('CUR_MAP') ? CUR_MAP : mid;
      const A = S.aoMaps[S.map]; if (A) { try { renderer.initTexture(A.tex); } catch (e) {} }
      patchWorld(false); applyTextures(); applyLook(); captureProbe(); applyLook();
      return r;
    };
  }
  if (has('warmShaders')) { const _ws = warmShaders; warmShaders = function () { patchWorld(false); const r = _ws.apply(this, arguments); warmExtra(); return r; }; }

  /* ---------- GPU timing + smarter auto-quality ---------- */
  const tq = WEBGL2 ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
  const pend = [], gpuWin = [], cpuWin = []; let qN = 0;
  const _render = composer.render.bind(composer);
  composer.render = function (d) {
    const q = tq && (++qN % 3 === 0) && pend.length < 6 && !gl.getQuery(tq.TIME_ELAPSED_EXT, gl.CURRENT_QUERY) ? gl.createQuery() : null;   // every 3rd frame is plenty
    if (q) gl.beginQuery(tq.TIME_ELAPSED_EXT, q);
    const c0 = performance.now(); _render(d); const c1 = performance.now();
    if (q) { gl.endQuery(tq.TIME_ELAPSED_EXT); pend.push(q); }
    cpuWin.push(c1 - c0); if (S.onCpu) S.onCpu(c1 - c0);
    while (pend.length && gl.getQueryParameter(pend[0], gl.QUERY_RESULT_AVAILABLE)) { const x = pend.shift(), ns = gl.getQueryParameter(x, gl.QUERY_RESULT); if (!gl.getParameter(tq.GPU_DISJOINT_EXT)) { gpuWin.push(ns / 1e6); if (S.onGpu) S.onGpu(ns / 1e6); } gl.deleteQuery(x); }
  };
  const med = a => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
  let winT = 0, frameWin = [], lastNow = 0, gunLights = null, gunAO = 1;
  // Auto-quality: the game's own auto-lowering stays in charge (measured: on this laptop the slow frames are mostly CPU, and
  // dropping glow/resolution does shorten them), but what it lowers is no longer saved forever - next session starts again
  // from the detected/chosen tier. adapt() only records GPU/CPU timings for status() and the tests.
  S.adapt.own = false;
  function adapt(now) {
    const dt = lastNow ? now - lastNow : 16; lastNow = now; frameWin.push(dt); winT += dt;
    if (winT < 500) return;
    const g = med(gpuWin), c = med(cpuWin), f = med(frameWin); S.gpuMs = +g.toFixed(2); S.cpuMs = +c.toFixed(2); S.frameMs = +f.toFixed(2);
    gpuWin.length = 0; cpuWin.length = 0; frameWin = []; winT = 0;
    if (!S.adapt.own || state !== 'play') { S.adapt.gpuBound = 0; return; }
    // the graphics card is the bottleneck only if its own work per frame is near the frame budget
    if (g > 12.5 && f > 17.5) S.adapt.gpuBound++; else S.adapt.gpuBound = 0;
    if (S.adapt.gpuBound >= 3) {
      S.adapt.gpuBound = 0;
      if (PR > .62) { PR = Math.max(.6, PR - .1); resize(); S.adapt.lowered++; }
      else { const i = ORDER.indexOf(S.tier); if (i > 0) { S.pendingTier = ORDER[i - 1]; } }   // takes effect at the next match start
      try { feed('Graphics lowered for smoother play'); } catch (e) {}
    }
  }
  function gunShade() {
    // first-person gun: darker in tunnels and under roofs, like the world around it (light intensities only)
    if (!has('gunScene')) return;
    if (!gunLights) { gunLights = []; gunScene.traverse(o => { if (o.isLight) gunLights.push([o, o.intensity]); }); }
    const want = ACT.ao > 0 && (state === 'play' || state === 'dead') ? .35 + .65 * aoAt(camera.position) : 1;
    gunAO += (want - gunAO) * .08;
    for (const [l, base] of gunLights) l.intensity = base * (l.isHemisphereLight ? gunAO : .6 + .4 * gunAO);
  }
  if (has('frame')) {
    const _frame = frame;
    frame = function (now) {
      if (S.adapt.own) prTimer = 0;      // the game's own CPU-blind auto-lowering stays off; adapt() decides with GPU timings
      _frame(now);
      try { adapt(now); gunShade(); } catch (e) {}
    };
  }
  // a tier lowered by adapt() applies at the next match start (behind the warm-up), never mid-fight
  if (has('startMatch')) { const _sm = startMatch; startMatch = function () { if (S.pendingTier) { CFG.q = S.pendingTier; S.pendingTier = null; applyQuality(); } return _sm.apply(this, arguments); }; }

  /* ---------- settings menu: add Ultra, remember a player's own choice ---------- */
  function syncOptions() {
    for (const p of ['m', 'p']) {
      const sel = document.getElementById(p + 'q'); if (!sel) continue;
      for (const k of ORDER.slice().reverse()) { let o = sel.querySelector(`option[value="${k}"]`); if (!o) { o = document.createElement('option'); o.value = k; sel.appendChild(o); } o.textContent = TIERS[k].label + (k === S.detected ? ' (recommended)' : ''); sel.appendChild(o); }
      sel.value = CFG.q;
    }
  }
  // only a real click by the player counts as "their choice" (other modules may set the select from code)
  document.addEventListener('change', e => { const id = e.target && e.target.id; if ((id === 'mq' || id === 'pq') && e.isTrusted) { S.user = true; write({ tier: e.target.value, user: true, detected: S.detected }); } }, true);
  if (has('syncSettings')) { const _ss = syncSettings; syncSettings = function () { syncOptions(); return _ss.apply(this, arguments); }; }

  /* ---------- public ---------- */
  S.TIERS = TIERS; S.LOOK = LOOK;
  S.setTier = (t, user) => { if (!TIERS[t]) return false; CFG.q = t; if (user) { S.user = true; write({ tier: t, user: true, detected: S.detected }); } try { saveCfg(); } catch (e) {} applyQuality(); try { syncSettings(); } catch (e) {} return true; };
  S.status = () => ({ tier: S.tier, detected: S.detected, gpu: S.gpu, user: S.user, map: S.map, ao: !!S.aoMaps[S.map], aoStr: ACT.ao, fogH: ACT.fogH, probeK: ACT.probe, hd: S.applied.hd, aniso: S.applied.aniso, pr: has('PR') ? PR : null, msaa: composer.renderTarget1.samples, bloom: bloom.enabled, shadows: renderer.shadowMap.enabled, shadowSize: sun && sun.shadow ? sun.shadow.mapSize.x : 0, patched: patchedCount, probe: S.probe ? S.probeAt : null, probeMs: S.probeMs, gpuMs: S.gpuMs, cpuMs: S.cpuMs, frameMs: S.frameMs, adaptive: S.adapt.own, lowered: S.adapt.lowered, warmMs: S.warmMs });
  S.aoAt = aoAt; S.uniforms = U; S.grade = GU;
  window.S9GFX = S;

  /* ---------- start ---------- */
  syncOptions();
  // The module may arrive at any point of the game's boot (it is loaded from modules/manifest.json). Whatever already
  // exists when the menu is up gets brought in line once, in the menu: patch materials, load this map's AO volume and
  // 2K textures, apply the tier, prepare every shader. From then on all map loads go through the hooks above.
  let syncing = false;
  async function ensure() {
    if (syncing) return; syncing = true;
    const id = has('CUR_MAP') ? CUR_MAP : null, def = has('MAPS') ? MAPS.find(m => m.id === id) : null;
    await Promise.all([id ? loadAO(id) : null, TIERS[S.tier].hd && def ? loadHD(def.tex || []) : null]);
    S.map = id;
    patchWorld(true); applyQuality(); applyTextures(); applyLook(); captureProbe(); applyLook();
    const A = S.aoMaps[S.map]; if (A) { try { renderer.initTexture(A.tex); } catch (e) {} }
    try { warmShaders(); } catch (e) {}
    S.ready = true; syncing = false;
    window.dispatchEvent(new Event('s9gfx'));
  }
  const iv = setInterval(() => { if (has('state') && state === 'menu' && has('CUR_MAP') && CUR_MAP) { clearInterval(iv); ensure(); } }, 50);
})();
