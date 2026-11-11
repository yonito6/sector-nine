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
    prTimer: typeof prTimer !== 'undefined', PR: typeof PR !== 'undefined', VH: typeof VH !== 'undefined', resize: typeof resize === 'function', feed: typeof feed === 'function', gunScene: typeof gunScene !== 'undefined',
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
  // readability (2026-11-08, owner: "too much glow around enemies, neon map glowing too hard"; benchmark Cryzen):
  // bloomT = bloom threshold in ON-SCREEN brightness (divided by the map's exposure, so a sunny low-exposure map does not bloom lit
  // walls/players), bloomR = bloom radius (small = a tight glow on the light itself, no wide haze), glow = scale of every over-bright
  // light material on the map (neon tubes, signs, lava, holograms: colour/emissive > 1), applied once per map load (material values only)
  const LOOK_BASE = { sat: 1.12, con: .26, sh: [.92, 1, 1.08], hi: [1.06, 1, .92], vig: .42, bloom: 1, fogH: .8, fall: .09, boost: 1.45, scat: .5, ao: 1, aoDirect: .4, probe: 1,
    bloomT: 1.05, bloomR: .3, glow: 1, fill: 0, fillW: 0, rim: 1, hemiK: 1, lift: 0, fogK: 1 };
  // fill = enemy body self-light in its team colour (index.html BOT_FILL): kept at 0 on every map. 2026-11-09 owner: "enemies appear
  // with very low details" - a flat colour over the body washed out the suit's texture, normals and specular (r15). Readability on
  // dark maps comes from rim = gfxmat's edge light x (High/Ultra; it only lights the silhouette's edge, the suit keeps its detail), hemiK = the map's sky/ground fill light x (shadows
  // without the old bloom haze), lift = black level in the final picture (no pure-black crush), fogK = distance fog density x
  // 2026-11-08 readability pass (docs/SMOOTHNESS_VS_CRYZEN.md, render/contrast.js shots): yard/caverns softer S-curve (lifted shadows),
  // glacier/dunes/biolab stronger S-curve (flat/washed), biolab less ground haze; exposure + sky fill are in index.html MAPS/MAP_DEFS
  const LOOK = {
    dunes: { glow: .8, hemiK: 1.25, lift: .02, sat: 1.1, con: .28, sh: [.9, .98, 1.1], hi: [1.07, 1.01, .9], fall: .07, boost: 1.6, scat: .9, aoDirect: .4 },
    neon: { rim: 2, glow: .6, hemiK: 1.8, lift: .035, fogK: .8, sat: 1.24, con: .28, sh: [.95, .92, 1.14], hi: [1.06, .98, 1.02], bloom: .8, fall: .12, boost: 1.7, scat: .35, ao: 1.1 },
    foundry: { rim: 1.4, glow: .85, hemiK: 1.4, lift: .03, sat: 1.16, con: .2, sh: [.9, .96, 1.1], hi: [1.1, .99, .86], bloom: .85, fall: .1, boost: 1.5, scat: .6 },
    glacier: { glow: .8, sat: 1.15, con: .26, sh: [.92, 1, 1.1], hi: [1.02, 1.01, 1], fall: .06, boost: 1.4, scat: .7 },
    docks: { rim: 1.5, glow: .7, hemiK: 1.35, lift: .03, fogK: .75, sat: 1.08, con: .16, fall: .1, boost: 1.6, scat: .3 },
    orbital: { rim: 1.4, glow: .75, hemiK: 1.3, lift: .025, sat: 1.12, con: .2, fogH: .4, scat: .4, bloom: .9 },
    biolab: { glow: .8, sat: 1.16, con: .3, sh: [.92, 1.04, 1.02], hi: [1.04, 1.02, .94], boost: 1.2 },
    caverns: { rim: 1.8, lift: .015, sat: 1.2, con: .1, bloom: .85, boost: 1.5, ao: 1.15 },
    shrine: { glow: .8, sat: 1.12, con: .16, hi: [1.08, 1, .9], scat: .9 },
    grid: { rim: 1.8, glow: .6, hemiK: 1.6, lift: .035, fogK: .6, sat: 1.2, con: .2, bloom: .8, fogH: .5 },
    yard: { rim: 1.5, sat: 1.12, con: .1 },
  };
  const lookOf = id => Object.assign({}, LOOK_BASE, LOOK[id] || {});

  /* ---------- state ---------- */
  const read = () => { try { return JSON.parse(localStorage.getItem(LS) || 'null'); } catch (e) { return null; } };
  const write = o => { try { localStorage.setItem(LS, JSON.stringify(o)); } catch (e) {} };
  // __s9FakeGpu: tests only (software / integrated paths)
  const gpuName = window.__s9FakeGpu ? String(window.__s9FakeGpu) : (() => { try { const x = gl.getExtension('WEBGL_debug_renderer_info'); return String(x ? gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)); } catch (e) { return '?'; } })();
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
  // the browser draws with the CPU (graphics acceleration off / GPU blocked): every frame costs the processor, so start on the
  // lightest tier whatever was saved, and say how to fix it. Integrated: a laptop whose browser runs on the built-in chip.
  const mobileUA = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  const software = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i.test(gpuName);
  const integrated = !software && !mobileUA && /intel|uhd|iris|hd graphics|radeon\(tm\) graphics|radeon graphics|vega \d+ graphics/i.test(gpuName) && !/arc\(tm\)|\barc a\d|\bnvidia|geforce|\brtx|\bgtx/i.test(gpuName);
  const startTier = software ? 'performance' : saved && saved.user && TIERS[saved.tier] ? saved.tier : detected;
  CFG.q = startTier; try { saveCfg(); } catch (e) {}
  const S = {
    ready: false, tier: startTier, detected, gpu: gpuName, user: !!(saved && saved.user), map: null, look: lookOf(null),
    software, integrated, aoMaps: {}, aoLoaded: {}, hdLoaded: {}, gpuMs: 0, cpuMs: 0, adapt: { lowered: 0, gpuBound: 0, own: false }, warmMs: 0, applied: { hd: null, aniso: 0 },
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
  }
  /* ---------- render optimizer: same pixels, less work (all tiers) ----------
     1. Single-pass see-through surfaces. three.js draws every transparent double-sided object TWICE (back faces, then front
        faces) and marks its material changed both times (a shader lookup per draw). Where one pass gives the same pixels it
        is drawn once: additive glow with no depth writes (adding is order-free), and flat (one-plane) normal-blended surfaces
        (every pixel is covered by exactly one face). Same blend state (normal blending is restated as the identical custom
        blend); the double-sided shader variant is prepared at load (warmShaders), never mid-match.
     2. Off-screen soldiers are skipped. Their skinned meshes (and gfxmat's rim overlay) are never frustum-culled by three.js
        (bind-pose bounds), so every bot was drawn even behind you. A generous sphere (2.4 m around the body) is tested against the camera of each render.
     3. Performance tier only: far soldiers animate at a lower rate (every 2nd frame beyond 22 m, 3rd beyond 40 m). */
  const RO = S.ro = { sp: true, cull: true, lod: true, restore: [], culled: [], spDraws: 0, culledN: 0, lodSkips: 0, warmed: 0 };
  {
    const DS = T.DoubleSide, planarC = new WeakMap(), _a = new T.Vector3(), _b = new T.Vector3(), _c = new T.Vector3(), _n = new T.Vector3(), _t = new T.Vector3(), _e = new T.Vector3();
    // flat geometry: every vertex on one plane and every triangle wound the same way
    const planar = g => {
      let v = planarC.get(g); if (v !== undefined) return v; v = false;
      try {
        const P = g.attributes.position, I = g.index, n = I ? I.count : (P ? P.count : 0);
        if (P && n >= 3 && !(g.morphAttributes && g.morphAttributes.position)) {
          if (!g.boundingSphere) g.computeBoundingSphere();
          const eps = Math.max(1e-5, (g.boundingSphere ? g.boundingSphere.radius : 1) * 1e-4); let ok = true, have = false, d0 = 0;
          for (let i = 0; i + 2 < n && ok; i += 3) {
            const ia = I ? I.getX(i) : i, ib = I ? I.getX(i + 1) : i + 1, ic = I ? I.getX(i + 2) : i + 2;
            _a.fromBufferAttribute(P, ia); _b.fromBufferAttribute(P, ib); _c.fromBufferAttribute(P, ic);
            _t.subVectors(_c, _b).cross(_e.subVectors(_a, _b)); const L = _t.length(); if (L < 1e-12) continue; _t.divideScalar(L);
            if (!have) { _n.copy(_t); d0 = _n.dot(_a); have = true; }
            if (_t.dot(_n) < .9999) ok = false;
            else for (const q of [_a, _b, _c]) if (Math.abs(_n.dot(q) - d0) > eps) { ok = false; break; }
          }
          if (ok && have) for (let i = 0; i < P.count; i++) { _a.fromBufferAttribute(P, i); if (Math.abs(_n.dot(_a) - d0) > eps) { ok = false; break; } }
          v = ok && have;
        }
      } catch (e) { v = false; }
      planarC.set(g, v); return v;
    };
    // 0 = keep three's two passes, 1 = additive glow (order-free), 2 = flat normal-blended surface
    const spKind = (m, o, g) => {
      if (!o || !o.isMesh || !g) return 0;
      if (m.blending === T.AdditiveBlending && m.depthWrite === false) return 1;
      if (m.blending === T.NormalBlending && !o.isInstancedMesh && !o.isSkinnedMesh && planar(g)) return 2;
      return 0;
    };
    RO.spKind = spKind; RO.planar = planar;
    const toSingle = (m, k) => {
      m.transparent = false;
      if (k === 2) { m.userData.s9spB = [m.blending, m.blendSrc, m.blendDst, m.blendEquation, m.blendSrcAlpha, m.blendDstAlpha, m.blendEquationAlpha];
        m.blending = T.CustomBlending; m.blendEquation = T.AddEquation; m.blendEquationAlpha = T.AddEquation;
        m.blendSrc = m.premultipliedAlpha ? T.OneFactor : T.SrcAlphaFactor; m.blendDst = T.OneMinusSrcAlphaFactor; m.blendSrcAlpha = T.OneFactor; m.blendDstAlpha = T.OneMinusSrcAlphaFactor; }
    };
    const back = (m, k) => { m.transparent = true; if (k === 2 && m.userData.s9spB) { const b = m.userData.s9spB; m.blending = b[0]; m.blendSrc = b[1]; m.blendDst = b[2]; m.blendEquation = b[3]; m.blendSrcAlpha = b[4]; m.blendDstAlpha = b[5]; m.blendEquationAlpha = b[6]; } };
    const restoreSP = () => { const L = RO.restore; while (L.length) { const k = L.pop(), m = L.pop(); back(m, k); } };
    RO.restoreSP = restoreSP;
    T.Material.prototype.onBeforeRender = function (r, sc, cam, g, o) {
      if (!RO.sp || this.transparent !== true || this.side !== DS || !RO.ready.has(this)) return;   // only materials whose one-pass shader is prepared
      const k = spKind(this, o, g); if (!k) return;
      toSingle(this, k); RO.restore.push(this, k); RO.spDraws++; if (RO.dbg) { const wp = o.getWorldPosition(new T.Vector3()); RO.dbg.add(k + ' ' + this.type + ' ' + (this.name || '') + ' ' + g.type + ' dw' + this.depthWrite + ' po' + this.polygonOffset + ' am' + !!this.alphaMap + ' map' + !!this.map + ' op' + this.opacity + ' @' + wp.toArray().map(v => v.toFixed(1)).join(',') + ' par:' + (o.parent && (o.parent.name || o.parent.type))); }
      // the program three last used for this material may be a one-sided one (from its two-pass path): ask for the double-sided one
      if (this.version !== this.userData.s9spV) { this.needsUpdate = true; this.userData.s9spV = this.version; }
    };
    T.Object3D.prototype.onAfterRender = function () { if (RO.restore.length) restoreSP(); };
    // prepare the double-sided variants now (loading / warm-up), so the first single-pass draw never builds a shader
    // (hidden objects too: their branch is shown for the compile only; a material never prepared here keeps the two passes)
    RO.ready = new WeakSet();
    RO.warm = () => {
      if (!RO.sp || !has('scene') || !has('camera')) return 0;
      const kinds = new Map(), shown = new Set();
      scene.traverse(o => { if (!o.isMesh || !o.material) return; let hit = false;
        for (const m of [].concat(o.material)) if (m.transparent === true && m.side === DS) { const k = spKind(m, o, o.geometry); if (k && (!kinds.has(m) || kinds.get(m) === k)) { kinds.set(m, k); hit = true; } }
        if (hit) for (let q = o; q && q !== scene; q = q.parent) if (!q.visible) shown.add(q); });
      for (const q of shown) q.visible = true;
      for (const [m, k] of kinds) { toSingle(m, k); m.needsUpdate = true; }
      // into the kind of target the game really draws into (the post buffer), like the game's own warmShaders
      const prevRT = renderer.getRenderTarget(); try { renderer.setRenderTarget(composer.renderTarget1); renderer.compile(scene, camera); } catch (e) {} renderer.setRenderTarget(prevRT);
      for (const [m, k] of kinds) { back(m, k); m.needsUpdate = true; m.userData.s9spV = undefined; RO.ready.add(m); }
      for (const q of shown) q.visible = false;
      return kinds.size;
    };
    // off-screen soldiers
    const _fr = new T.Frustum(), _pm = new T.Matrix4(), _sp = new T.Sphere();
    RO.before = cam => {
      if (RO.culled.length) RO.after();
      if (!RO.cull || !has('robots') || !cam || !cam.isCamera) return;
      _fr.setFromProjectionMatrix(_pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
      for (const r of robots) {
        const o = r && r.root; if (!o || !o.visible) continue;
        _sp.center.setFromMatrixPosition(o.matrixWorld); _sp.center.y += .9; _sp.radius = 2.4 * Math.max(o.scale.x, o.scale.y, o.scale.z, 1);
        if (!_fr.intersectsSphere(_sp)) {   // the body, its gun (a separate scene object) and gfxmat's rim overlay (also separate, never culled)
          o.visible = false; RO.culled.push(o); RO.culledN++;
          if (r.gun && r.gun.visible && r.gun.parent !== o) { r.gun.visible = false; RO.culled.push(r.gun); }
          const ov = r.gmRim && r.gmRim.ov; if (ov && ov.visible) { ov.visible = false; RO.culled.push(ov); }
        }
      }
    };
    RO.after = () => { const L = RO.culled; for (let i = 0; i < L.length; i++) L[i].visible = true; L.length = 0; restoreSP(); };
    // far soldiers animate less often (Performance tier, in a match); the skipped time is added to the next update
    RO.lodOn = () => RO.lod && S.tier === 'performance' && has('state') && (state === 'play' || state === 'dead');
    RO.lodBot = r => {
      const m = r && r.mixer; if (!m || m.__s9lod) return; m.__s9lod = 1;
      const up = m.update; let acc = 0, k = 0;
      m.update = function (dt) {
        if (!RO.lodOn() || !has('camera') || !r.root) { if (acc) { dt += acc; acc = 0; } return up.call(this, dt); }
        const d = camera.position.distanceTo(r.root.position), every = d > 40 ? 3 : d > 22 ? 2 : 1;
        acc += dt; if (every > 1 && (++k % every)) { RO.lodSkips++; return this; }
        const a = acc; acc = 0; return up.call(this, a);
      };
    };
  }
  if (has('scene')) {
    scene.onBeforeRender = (r, sc, cam) => { if (WEBGL2) { U.s9AOStr.value = ACT.ao; U.s9ProbeK.value = ACT.probe; U.s9FogH.value = ACT.fogH; U.s9SunScat.value = ACT.scat; } try { RO.before(cam); } catch (e) {} };
    scene.onAfterRender = () => { if (WEBGL2) { U.s9AOStr.value = 0; U.s9ProbeK.value = 0; U.s9FogH.value = 0; U.s9SunScat.value = 0; } RO.after(); };
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
uniform float uAA, uSharp, uGrain, uSat, uCon, uVig, uLift; uniform vec3 uShT, uHiT;
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
  col = uLift + col*(1.-uLift);
  col += (n-.5)*uGrain;
  gl_FragColor = vec4(col,1.);
}`;
  const GU = grade.uniforms;
  Object.assign(GU, { uAA: { value: 1 }, uSharp: { value: .3 }, uGrain: { value: .015 }, uSat: { value: 1.1 }, uCon: { value: .15 }, uVig: { value: .45 }, uLift: { value: 0 }, uShT: { value: new T.Vector3(.92, 1, 1.08) }, uHiT: { value: new T.Vector3(1.06, 1, .92) } });
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
  // (a restored WebGL context comes back with an empty probe: capture it again, once, when the core says the context is back)
  addEventListener('s9glrestored', () => { if (S.applied) try { captureProbe(); } catch (e) {} });
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
    GU.uSat.value = L.sat; GU.uCon.value = L.con; GU.uVig.value = L.vig; GU.uLift.value = L.lift; GU.uShT.value.set(...L.sh); GU.uHiT.value.set(...L.hi);
    const A = S.aoMaps[S.map];
    if (A) { U.s9AOVol.value = A.tex; U.s9AOMin.value.copy(A.min); U.s9AOSize.value.copy(A.size); }
    else U.s9AOVol.value = blank3D;
    ACT.ao = A && Tt.ao ? L.ao : 0; U.s9AODir.value = L.aoDirect;
    ACT.fogH = Tt.fog ? L.fogH : 0; U.s9FogFall.value = L.fall; U.s9FogBoost.value = L.boost; U.s9FogBase.value = 0;
    ACT.scat = Tt.fog ? L.scat : 0;
    ACT.probe = S.probe && !S.capturing ? Tt.probe * L.probe : 0;
    if (has('sun') && sun) { U.s9SunDir.value.copy(sun.position).normalize(); U.s9SunCol.value.copy(sun.color).multiplyScalar(Math.min(1.2, sun.intensity) * .12); }
    if (has('scene') && scene.fog) U.s9SunCol.value.lerp(scene.fog.color, .35);
    if (bloom) { if (S.bloom0 === undefined) S.bloom0 = { s: bloom.strength, r: bloom.radius, t: bloom.threshold }; bloom.strength = S.bloom0.s * L.bloom * Tt.bloomK;
      const ex = (has('MAPS') && (MAPS.find(m => m.id === S.map) || {}).exposure) || .9;
      bloom.radius = L.bloomR; bloom.threshold = L.bloomT / ex; }
    applyGlow(L.glow);
    if (typeof BOT_FILL !== 'undefined') { BOT_FILL = L.fill; BOT_FILLW = L.fillW; }
    try { if (window.S9GFXM && S9GFXM.setRimK) S9GFXM.setRimK(L.rim); } catch (e) {}
    // fill light + fog: the map build sets them; the first look applied after a load remembers those values (S.base0 per map)
    if (has('MAPROOT') && (!S.base0 || S.base0.map !== S.map)) {
      const hl = MAPROOT.children.filter(o => o.isHemisphereLight);
      S.base0 = { map: S.map, hemi: hl.map(o => [o, o.intensity]), fog: has('scene') && scene.fog ? scene.fog.density : null };
    }
    if (S.base0) { if (L.hemiK !== 1) for (const [o, i] of S.base0.hemi) o.intensity = i * L.hemiK; if (L.fogK !== 1 && S.base0.fog != null && scene.fog) scene.fog.density = S.base0.fog * L.fogK; }
  }
  // over-bright light materials of the current map x k (original values kept on the material, so re-applying never compounds)
  function applyGlow(k) {
    if (!has('MAPROOT')) return;
    const seen = new Set();
    MAPROOT.traverse(o => { if (!o.material) return; for (const m of [].concat(o.material)) {
      if (!m || seen.has(m)) continue; seen.add(m); const u = m.userData;
      if ((m.isMeshBasicMaterial || m.isSpriteMaterial) && m.color) { if (!u.s9g0) { if (Math.max(m.color.r, m.color.g, m.color.b) <= 1.001) continue; u.s9g0 = m.color.clone(); } m.color.copy(u.s9g0).multiplyScalar(k); }
      else if (m.emissive && m.emissive.isColor) { if (u.s9gE === undefined) { if (Math.max(m.emissive.r, m.emissive.g, m.emissive.b) * (m.emissiveIntensity == null ? 1 : m.emissiveIntensity) <= 1.001) continue; u.s9gE = m.emissiveIntensity == null ? 1 : m.emissiveIntensity; } m.emissiveIntensity = u.s9gE * k; }
      else if (m.isShaderMaterial && m.uniforms && m.uniforms.uCol && m.uniforms.uCol.value && m.uniforms.uCol.value.isColor) { const c = m.uniforms.uCol.value; if (!u.s9g0) { if (Math.max(c.r, c.g, c.b) <= 1.001) continue; u.s9g0 = c.clone(); } c.copy(u.s9g0).multiplyScalar(k); }
    } });
    S.glowK = k;
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
  if (has('newRoster')) { const _nr = newRoster; newRoster = function () { const r = _nr.apply(this, arguments); for (const b of robots) { patchTree(b.root, false); RO.lodBot(b); } return r; }; }
  if (has('loadMap')) {
    const _lm = loadMap;
    loadMap = async function (id) {
      const def = (has('MAPS') && MAPS.find(m => m.id === id)) || null, mid = def ? def.id : id;
      const pre = Promise.all([loadAO(mid), TIERS[S.tier].hd && def ? loadHD(def.tex || []) : null]);
      const r = await _lm.apply(this, arguments);
      await pre;
      S.map = has('CUR_MAP') ? CUR_MAP : mid; S.base0 = null;   // the build just set the map's own fill light + fog
      const A = S.aoMaps[S.map]; if (A) { try { renderer.initTexture(A.tex); } catch (e) {} }
      patchWorld(false); applyTextures(); applyLook(); captureProbe(); applyLook();
      return r;
    };
  }
  if (has('warmShaders')) { const _ws = warmShaders; warmShaders = function () { patchWorld(false); const r = _ws.apply(this, arguments); try { RO.warmed = RO.warm(); } catch (e) {} warmExtra(); return r; }; }

  /* ---------- GPU timing + smarter auto-quality ---------- */
  let tq = WEBGL2 ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
  const pend = [], gpuWin = [], cpuWin = []; let qN = 0;
  // a lost WebGL context takes its query objects and extension objects with it: drop the pending queries at once (polling them
  // on the restored context floods the console with INVALID_OPERATION) and ask for the extension again once the context is back
  addEventListener('s9gllost', () => { pend.length = 0; tq = null; });
  addEventListener('s9glrestored', () => { pend.length = 0; tq = WEBGL2 ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null; });
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
  // Auto-quality = AUTO RESOLUTION (dynamic render scale of the 3D picture only; the HUD/menus are page elements and stay sharp).
  // The game's own one-shot auto-lowering (resolution steps + tier drops, any tier) is switched off: it changed the look on High.
  // Setting video.autoRes (settings.js): 'auto' = active on Performance/Balanced, only while frames stay over budget;
  // 'always' = also on High/Ultra (the player opted in); 'off' = never. High/Ultra on 'auto' are never touched.
  // Budget = the frame-rate limit or 60 fps. With GPU timers, resolution only drops when the GRAPHICS CARD is the bottleneck
  // (a CPU-bound frame does not get faster at a lower resolution). Floor: never below 0.5 or ~430 rendered lines.
  // Each change resizes the render targets once (a few ms), at most one change per second, in steps of 0.05.
  S.adapt.own = false;
  const DR = S.dynres = { holdUntil: 0, mode: 'auto', active: false, scale: 0, max: 0, floor: .5, over: 0, under: 0, lastT: 0, raisedT: -1e9, noRaiseUntil: 0, changes: 0, lastDir: 0, atFloor: 0 };
  try { const v = window.S9Settings && S9Settings.get().video.autoRes; if (v === 'auto' || v === 'always' || v === 'off') DR.mode = v; } catch (e) {}
  const prMax = () => Math.min(devicePixelRatio || 1, TIERS[S.tier] ? TIERS[S.tier].maxPR : 1);
  // integrated / software GPU (a laptop whose browser draws on the built-in chip): Auto also covers High/Ultra. Player reports
  // (/api/perf/summary): High on Intel UHD 630 averaged 19.5 fps with Auto never stepping in; a graphics card's High stays untouched.
  const weakGpu = () => !!(S.integrated || S.software);
  const drWanted = () => DR.mode === 'always' || (DR.mode === 'auto' && (S.tier === 'performance' || S.tier === 'balanced' || weakGpu()));
  const capMs = () => { try { const c = window.S9Settings && S9Settings._cap; return c && c.ms ? c.ms : 0; } catch (e) { return 0; } };
  function setPR(v, now) { v = Math.round(v * 20) / 20; if (v < DR.floor - 1e-6) v = Math.min(DR.max || v, Math.ceil(DR.floor * 20 - 1e-6) / 20); /* a .05 step never lands below the floor */ if (Math.abs(v - PR) < .001) return false; PR = v; resize(); DR.lastT = now; DR.changes++; return true; }
  function dynRes(f, g, now, c) {
    const max = prMax(); DR.max = max; DR.floor = Math.min(max, Math.max(.5, 430 / Math.max(1, (has('VH') ? VH : innerHeight))));
    DR.active = drWanted();
    if (!DR.active) { DR.over = DR.under = 0; if (DR.scale && PR < max - .001) setPR(max, now); DR.scale = 0; return; }
    if (PR > max + .001) { setPR(max, now); }
    DR.scale = PR;
    if (!has('state') || state !== 'play' || !f) { DR.over = DR.under = 0; return; }
    if (now < DR.holdUntil) { DR.over = DR.under = 0; return; }   // the first seconds of a match (uploads, first draws) do not set the resolution
    const B = Math.max(1000 / 60, capMs()), gpuKnown = !!tq && g > 0;
    // a GPU timer also counts the gaps while a slow CPU is still sending the frame: GPU-bound only if the card's time clearly
    // exceeds the CPU time spent submitting the frame (c)
    const gpuBound = !gpuKnown || (g > B * .45 && !(c > 0 && g < c * 1.25));
    if (f > B * 1.15 && gpuBound) { DR.over++; DR.under = 0; } else if (f <= B * 1.05 && (!gpuKnown || g * (max * max) / (PR * PR) < B * .6)) { DR.under++; DR.over = 0; } else { DR.over = 0; DR.under = 0; }
    if (now - DR.lastT < 1000) return;
    if (DR.over >= 2 && PR > DR.floor + .001) {
      if (now - DR.raisedT < 3000) DR.noRaiseUntil = now + 30000;   // the last raise did not fit: stay lower for a while
      // far over budget (e.g. High on a built-in chip): one jump to the estimated scale (GPU cost ~ pixels = scale^2) instead of
      // many .1 steps; each change rebuilds the render targets (~60-90 ms hitch on an Intel UHD 630)
      // only when the GPU timer itself says so (a CPU-starved frame can look GPU-bound: then the old small steps)
      const est = f > B * 2 && gpuKnown && g > B * 1.5 ? PR * Math.sqrt(B * 1.05 / Math.max(f, g)) : PR - (f > B * 1.5 ? .1 : .05);
      setPR(Math.max(DR.floor, Math.min(PR - .05, est)), now); DR.over = 0; DR.lastDir = -1; S.adapt.lowered++;
    } else if (DR.under >= (gpuKnown ? 4 : 8) && PR < max - .001 && now > DR.noRaiseUntil) {
      setPR(Math.min(max, PR + .05), now); DR.under = 0; DR.raisedT = now; DR.lastDir = 1;
    }
    // at the floor and still too slow on Balanced: one tier down at the next match start (never mid-fight, never from High/Ultra)
    if (PR <= DR.floor + .001 && DR.over >= 2) { if (++DR.atFloor >= 12 && DR.mode === 'auto' && S.tier === 'balanced' && !S.pendingTier) { S.pendingTier = 'performance'; try { feed('Graphics lowered for smoother play'); } catch (e) {} } }
    else DR.atFloor = 0;
  }
  S._dynRes = dynRes;   // tests: feed it frame/GPU timings
  S.setAutoRes = mode => { if (!['auto', 'always', 'off'].includes(mode)) return false; DR.mode = mode; DR.over = DR.under = 0; DR.noRaiseUntil = 0; try { dynRes(0, 0, performance.now()); } catch (e) {} return true; };
  function adapt(now) {
    const dt = lastNow ? now - lastNow : 16; lastNow = now; frameWin.push(dt); winT += dt;
    if (winT < 500) return;
    const g = med(gpuWin), c = med(cpuWin), f = med(frameWin); S.gpuMs = +g.toFixed(2); S.cpuMs = +c.toFixed(2); S.frameMs = +f.toFixed(2);
    gpuWin.length = 0; cpuWin.length = 0; frameWin = []; winT = 0;
    dynRes(f, g, now, c);
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
      if (has('prTimer')) prTimer = 0;   // the game's own auto-lowering stays off: auto resolution (dynRes) decides
      _frame(now);
      try { adapt(now); gunShade(); } catch (e) {}
    };
  }
  // a tier lowered by adapt() applies at the next match start (behind the warm-up), never mid-fight
  if (has('startMatch')) { const _sm = startMatch; startMatch = function () { if (S.pendingTier) { CFG.q = S.pendingTier; S.pendingTier = null; applyQuality(); } return Promise.resolve(_sm.apply(this, arguments)).then(r => { DR.holdUntil = performance.now() + 2500; return r; }); }; }
  if (typeof startOnlineMatch === 'function') { const _so = startOnlineMatch; startOnlineMatch = function () { const r = _so.apply(this, arguments); DR.holdUntil = performance.now() + 2500; return r; }; }

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
  S.status = () => ({ tier: S.tier, detected: S.detected, gpu: S.gpu, user: S.user, map: S.map, ao: !!S.aoMaps[S.map], aoStr: ACT.ao, fogH: ACT.fogH, probeK: ACT.probe, hd: S.applied.hd, aniso: S.applied.aniso, pr: has('PR') ? PR : null, msaa: composer.renderTarget1.samples, bloom: bloom.enabled, shadows: renderer.shadowMap.enabled, shadowSize: sun && sun.shadow ? sun.shadow.mapSize.x : 0, patched: patchedCount, probe: S.probe ? S.probeAt : null, probeMs: S.probeMs, software: S.software, integrated: S.integrated, gpuMs: S.gpuMs, cpuMs: S.cpuMs, frameMs: S.frameMs, adaptive: S.adapt.own, lowered: S.adapt.lowered, autoRes: DR.mode, autoResActive: DR.active, autoResFloor: +DR.floor.toFixed(3), autoResChanges: DR.changes, warmMs: S.warmMs });
  S.aoAt = aoAt; S.uniforms = U; S.grade = GU;
  window.S9GFX = S;

  /* ---------- graphics card check: FPS counter label + a one-time fix-it banner ---------- */
  const shortGpu = n => String(n).replace(/^ANGLE \((.*)\)$/, '$1').replace(/^(NVIDIA|AMD|Intel|Google|Microsoft|Apple)( Corporation| Inc\.)?, /i, '').replace(/ Direct3D.*$| \(0x[0-9a-f]+\).*$|, D3D11.*$| vs_\d.*$/i, '').replace(/\(TM\)|\(R\)/g, '').replace(/\s+/g, ' ').trim().slice(0, 48);
  const warnText = software ? 'SOFTWARE RENDERING - graphics card not used' : integrated ? 'integrated GPU' : '';
  function gpuHud() { try { if (typeof HUDFPS !== 'undefined') { HUDFPS.gpu = shortGpu(gpuName); HUDFPS.warn = warnText; HUDFPS.warnShort = software ? 'SOFTWARE GPU' : integrated ? 'iGPU' : ''; HUDFPS.last = ''; } } catch (e) {} }
  gpuHud();
  const GW = 'sector9-gpuwarn';
  function gpuBanner(force) {
    if (!software && !integrated) return false;
    if (!force && (navigator.webdriver && !window.__s9ForceGpuWarn)) return false;   // test browsers: only when a test asks
    let seen = null; try { seen = localStorage.getItem(GW); } catch (e) {}
    if (!force && seen === gpuName) return false;
    if (document.getElementById('s9gpuwarn')) return true;
    const css = document.createElement('style'); css.textContent = `
#s9gpuwarn{position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:60;width:min(560px,calc(100vw - 32px));box-sizing:border-box;
 background:rgba(14,10,12,.96);border:1px solid #ff5a4a;border-left-width:4px;color:#ece6d8;font:13px/1.45 system-ui,sans-serif;padding:12px 40px 12px 14px;box-shadow:0 8px 30px rgba(0,0,0,.5)}
#s9gpuwarn b{color:#ff7a6a;display:block;font-size:14px;margin-bottom:4px}#s9gpuwarn ol{margin:6px 0 0 18px;padding:0}#s9gpuwarn li{margin:2px 0}#s9gpuwarn small{color:#9aa0a6;display:block;margin-top:6px;word-break:break-word}
#s9gpuwarn button{position:absolute;top:6px;right:6px;width:30px;height:30px;border:0;background:transparent;color:#ece6d8;font-size:20px;cursor:pointer}
#s9gpuwarn button.nev{position:static;width:auto;height:auto;margin-top:8px;padding:5px 10px;border:1px solid #6a6f75;font:12px system-ui,sans-serif;color:#cfd3d6}#s9gpuwarn button.nev:hover{border-color:#ece6d8;color:#fff}`;
    document.head.appendChild(css);
    const d = document.createElement('div'); d.id = 's9gpuwarn'; d.setAttribute('role', 'alert');
    const steps = software
      ? '<ol><li>Chrome / Edge: Settings &gt; System &gt; turn on <b style="display:inline;font-size:inherit">Use graphics acceleration when available</b>, then restart the browser.</li><li>Still slow? Windows Settings &gt; System &gt; Display &gt; Graphics &gt; your browser &gt; Options &gt; <b style="display:inline;font-size:inherit">High performance</b>.</li><li>Update your graphics driver (NVIDIA / AMD / Intel website).</li></ol>'
      : '<ol><li>Windows Settings &gt; System &gt; Display &gt; Graphics &gt; your browser &gt; Options &gt; <b style="display:inline;font-size:inherit">High performance</b>, then restart the browser.</li><li>Laptop: plug in the charger (on battery the fast card often stays off).</li></ol>';
    d.innerHTML = `<b>${software ? 'Your browser is not using your graphics card' : 'The game is running on your built-in graphics chip'}</b>` +
      (software ? 'The game is drawn by the processor instead, so it runs slowly and heats the CPU. Graphics were set to Performance.' : 'If your computer also has an NVIDIA or AMD card, tell Windows to use it for your browser:') + steps +
      `<small>Detected: ${String(gpuName).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';')}</small><button type="button" class="nev">Don't show again</button><button type="button" class="x" aria-label="Close">×</button>`;
    const close = () => { d.remove(); try { localStorage.setItem(GW, gpuName); } catch (e) {} };   // once per device (per GPU): closing, "Don't show again" or starting a match all remember it
    d.querySelectorAll('button').forEach(x => x.addEventListener('click', close));
    document.body.appendChild(d);
    // shown in the menu; gone once a match starts (it is remembered as seen)
    const iv = setInterval(() => { if (!d.isConnected) return clearInterval(iv); if (has('state') && state !== 'menu' && state !== 'loading') { clearInterval(iv); close(); } }, 500);
    return true;
  }
  S.gpuBanner = gpuBanner; S.shortGpu = shortGpu;

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
    S.map = id; S.base0 = null;
    patchWorld(true); applyQuality(); applyTextures(); applyLook(); captureProbe(); applyLook();
    const A = S.aoMaps[S.map]; if (A) { try { renderer.initTexture(A.tex); } catch (e) {} }
    try { warmShaders(); } catch (e) {}
    S.ready = true; syncing = false;
    gpuHud(); try { gpuBanner(false); } catch (e) {}
    window.dispatchEvent(new Event('s9gfx'));
  }
  const iv = setInterval(() => { if (has('state') && state === 'menu' && has('CUR_MAP') && CUR_MAP) { clearInterval(iv); ensure(); } }, 50);
})();
