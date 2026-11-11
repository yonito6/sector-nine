/* Sector Nine - lighting & atmosphere pack (modules/gfxplus.js)
   Loads after graphics.js (see gfxplus.INTEGRATE.md). graphics.js already owns: FXAA/MSAA, ACES tone map + colour grade + vignette,
   bloom strength per tier, baked AO volume, height fog, map reflections, HD textures. This module does NOT redo any of that; it adds
   the "air" and the "light": everything below is scene geometry (no extra render passes, no render targets, no new lights):
   - neon halos: soft light spill around every glowing sign/strip (found by reading the map's own emissive meshes), with flicker
     and broken-sign dropouts (the sign material itself flickers, so bloom flickers with it)
   - wet-floor reflections: stretched glow streaks on the floor under each neon source, placed with the real mirror-geometry rule
     (length = distance * h / (eye height + h)), patchy puddles, stronger at grazing angles - one draw call, no second scene render
   - light shafts: sun beams found by testing the map's colliders (lit ground that touches shadow), cylindrical billboards, drifting wisps
   - floating dust (back-lit when you look toward the sun), rising sparks/embers from hot sources, vent steam from hazards/walls
   - sun glare quad (occluded by terrain), slow sky ships with blinking nav lights
   - impact sparks on every bullet hole (colour from the weapon), muzzle glow in the first-person gun, world muzzle/explosion flashes
   - grade pass: a faint chromatic fringe toward the screen edge on High/Ultra (one uniform in the existing shader)
   Tiers (read from graphics.js; Performance=low, Balanced=medium, High, Ultra):
     low: nothing is drawn (module idle, zero cost)   medium: halos+flicker, dust, embers, impact sparks, muzzle glow, 1 sky ship, sun glare
     high: + shafts, wet streaks, steam, more sky ships, chromatic edge   ultra: same, denser/bigger
   Rules kept: no new lights, <= ~12 draw calls, all GPU animation is stateless (time uniform), every shader is built at map load / warm-up. */
(function () {
  'use strict';
  if (window.S9GFXP) return;
  if (typeof scene === 'undefined' || typeof camera === 'undefined' || typeof renderer === 'undefined' || typeof grade === 'undefined' || typeof MAPROOT === 'undefined' || typeof world === 'undefined' || typeof loadMap !== 'function' || typeof frame !== 'function') { console.warn('[gfxplus] game globals not found, module idle'); return; }
  const T = THREE, S = { ready: false, version: 1 }, W = window;
  const V3 = (x, y, z) => new T.Vector3(x, y, z);
  const reduceMo = typeof reduceMotion !== 'undefined' && reduceMotion;
  const gl = renderer.getContext();
  const maxPt = Math.min(256, (gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) || [1, 64])[1] || 64);

  /* ---------- levels: counts are the ultra build; lower levels just draw less of the same buffers ---------- */
  const LEVELS = [
    { name: 'low', on: false },
    { name: 'medium', on: true, glow: .5, flick: 1, dust: .4, ember: .4, impact: 1, muzzle: 1, glare: .7, shaft: 0, wet: 0, steam: 0, ships: 1, ca: 0, K: .8, rays: 0 },
    { name: 'high', on: true, glow: .85, flick: 1, dust: .75, ember: .75, impact: 1, muzzle: 1, glare: 1, shaft: .6, wet: 1, steam: .7, ships: 2, ca: .0022, K: 1, rays: .4 },
    { name: 'ultra', on: true, glow: 1, flick: 1, dust: 1, ember: 1, impact: 1, muzzle: 1, glare: 1, shaft: 1, wet: 1, steam: 1, ships: 3, ca: .0028, K: 1.1, rays: .5 },
  ];
  const TIER_IDX = { performance: 0, balanced: 1, high: 2, ultra: 3 };
  const tierName = () => (W.S9GFX && S9GFX.tier) || (typeof CFG !== 'undefined' && CFG.q) || 'balanced';
  const lvl = () => S.off ? LEVELS[0] : LEVELS[TIER_IDX[tierName()] ?? 1];

  /* ---------- per-map personality (all multipliers; 0 = off) ---------- */
  const MAPCFG = {
    yard: { rays: 0.8, shaft: .7, dust: 1, wet: 0, steam: .4, ships: 1, flick: 0, ember: 0, glare: 1, glow: .4 },
    glacier: { rays: 0.7, shaft: .5, dust: .35, wet: .25, steam: 0, ships: 1, flick: 0, ember: 0, glare: 1.1, glow: .8 },
    foundry: { rays: 0.6, shaft: .3, dust: .8, wet: 0, steam: 1, ships: 2, flick: .4, ember: 1.5, glare: .8, glow: 1.3 },
    neon: { rays: 0, shaft: .3, dust: .5, wet: 1, steam: 1, ships: 3, flick: 1, ember: .9, glare: .5, glow: 1.15 },
    dunes: { rays: 1, shaft: 1, dust: 1.2, wet: 0, steam: 0, ships: 0, flick: 0, ember: 0, glare: 1.3, glow: .4 },
    orbital: { rays: 0.3, shaft: 0, dust: .4, wet: .55, steam: .6, ships: 2, flick: .5, ember: .3, glare: .8, glow: 1 },
    biolab: { rays: 0.3, shaft: .6, dust: 1, wet: .5, steam: 1, ships: 0, flick: .7, ember: .2, glare: .5, glow: 1 },
    caverns: { rays: 0, shaft: .45, dust: 1, wet: .65, steam: .6, ships: 0, flick: .1, ember: .3, glare: 0, glow: 1.2 },
    shrine: { rays: 1, shaft: 1, dust: 1, wet: .35, steam: 0, ships: 0, flick: .1, ember: .1, glare: 1.1, glow: .9 },
    docks: { rays: 0.2, shaft: .4, dust: .5, wet: .9, steam: .5, ships: 2, flick: .6, ember: .1, glare: .4, glow: 1 },
    grid: { rays: 0, shaft: 0, dust: .3, wet: .85, steam: 0, ships: 2, flick: .8, ember: .6, glare: 0, glow: 1.2 },
  };
  const BASE_CFG = { rays: .5, shaft: .5, dust: .6, wet: .3, steam: 0, ships: 1, flick: .2, ember: .2, glare: .8, glow: 1 };

  /* ---------- shared uniforms ---------- */
  const U = {
    uT: { value: 0 }, uCam: { value: V3(0, 0, 0) }, uPx: { value: 800 }, uMaxPt: { value: maxPt }, uFogD: { value: .012 },
    uFl: { value: new Float32Array(32).fill(1) }, uK: { value: 1 }, uSunDot: { value: 0 },
  };
  const PX = `uniform float uT, uPx, uMaxPt, uFogD, uK, uSunDot; uniform vec3 uCam; uniform float uFl[32];
float h11(float p){ return fract(sin(p*127.1)*43758.5453); }
float fogF(float d){ return exp(-uFogD*uFogD*d*d*1.0); }`;
  const mkU = extra => Object.assign({}, { uT: U.uT, uCam: U.uCam, uPx: U.uPx, uMaxPt: U.uMaxPt, uFogD: U.uFogD, uFl: U.uFl, uK: U.uK, uSunDot: U.uSunDot }, extra || {});

  // soft halo: points sized in world metres, flicker by material index (aMat >= 0) or ship-light blink modes (aMat < 0)
  const HALO = new T.ShaderMaterial({
    transparent: true, depthWrite: false, blending: T.AdditiveBlending, uniforms: mkU({ uSizeK: { value: 1 } }),
    vertexShader: PX + `uniform float uSizeK; attribute vec3 aCol; attribute vec3 aP; varying vec4 vC;
void main(){ vec4 mv = modelViewMatrix*vec4(position,1.); float d = -mv.z; gl_Position = projectionMatrix*mv;
  { vec4 m2 = mv; m2.z += min(1.6, d*.4); vec4 c2 = projectionMatrix*m2; gl_Position.z = c2.z/c2.w*gl_Position.w; }
  float fl = 1.; float m = aP.y;
  if (m >= 0.) fl = uFl[int(m+.5)];
  else if (m < -2.5) fl = .55+.45*sin(uT*1.6+aP.z*6.28);
  else if (m < -1.5) fl = step(fract(uT*.8+aP.z), .07);
  float sz = aP.x*uSizeK*uPx/max(d,.1); float cl = min(sz, uMaxPt); gl_PointSize = cl;
  float a = fl*smoothstep(1.2, 4.5, d)*fogF(d)*(cl/max(sz,.001))*(cl/max(sz,.001)); vC = vec4(aCol*uK, a); }`,
    fragmentShader: `varying vec4 vC; void main(){ vec2 q = gl_PointCoord-.5; float r = dot(q,q)*4.; float gg = pow(max(1.-sqrt(r),0.), 2.6); gl_FragColor = vec4(vC.rgb, vC.a*gg); }`,
  });

  // floor streaks (wet reflection of glow sources)
  const STREAK = new T.ShaderMaterial({
    transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, uniforms: mkU({ uWet: { value: 1 } }),
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    vertexShader: PX + `attribute vec2 aC; attribute vec3 aCol; attribute vec4 aS; varying vec3 vCol; varying vec3 vW; varying vec2 vQ; varying float vA;
void main(){ vec3 f = position; vec2 tc = uCam.xz - f.xz; float d = length(tc); vec2 hd = tc/max(d,.001);
  float cy = max(uCam.y - f.y, .45); float h = aS.y; float L = min(d*h/(cy+h), 16.);
  float graze = clamp(d/(cy*5.), 0., 1.);
  float w = aS.x*(1. + aC.y*1.1);
  vec3 wp = vec3(f.x, f.y+.02, f.z) + vec3(hd.x,0.,hd.y)*aC.y*L + vec3(-hd.y,0.,hd.x)*aC.x*w;
  vW = wp; vQ = vec2(aC.x, aC.y); vCol = aCol;
  float fl = uFl[int(aS.z+.5)];
  vA = fl*graze*smoothstep(.8,3.5,d)*fogF(d)*clamp(L/1.2,0.,1.);
  gl_Position = projectionMatrix*viewMatrix*vec4(wp,1.); }`,
    fragmentShader: `uniform float uWet, uK, uT; varying vec3 vCol; varying vec3 vW; varying vec2 vQ; varying float vA;
float hh(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
float nz(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f); return mix(mix(hh(i),hh(i+vec2(1,0)),f.x),mix(hh(i+vec2(0,1)),hh(i+vec2(1,1)),f.x),f.y); }
void main(){ float x = abs(vQ.x), y = vQ.y;
  float across = exp(-x*x*3.2);
  float along = (1.-smoothstep(0.,1.,y))*smoothstep(0.,.06,y);
  float pud = smoothstep(.38,.62, nz(vW.xz*.31) * .65 + nz(vW.xz*1.3)*.35);
  float rip = .72 + .28*nz(vec2(vW.x*7.+uT*.7, vW.z*7.-uT*.5)) ;
  float a = across*along*mix(.16, 1., pud)*rip*vA*uWet*.8;
  gl_FragColor = vec4(vCol*uK*2.2, a); }`,
  });

  // sun shafts: cylindrical billboards around the sun axis
  const SHAFT = new T.ShaderMaterial({
    transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, uniforms: mkU({ uShaftCol: { value: new T.Color(1, .9, .7) }, uShaftK: { value: 1 } }),
    vertexShader: PX + `attribute vec2 aC; attribute vec3 aAxis; attribute vec3 aP; varying vec2 vQ; varying float vA; varying float vSeed;
void main(){ vec3 mid = position + aAxis*.5; vec3 view = uCam - mid; vec3 side = normalize(cross(aAxis, view));
  vec3 wp = position + aAxis*aC.y + side*aC.x*aP.x*(.55+.9*aC.y); vQ = aC; vSeed = aP.z; float d = length(view);
  vA = aP.y*smoothstep(1.5, 7., d)*fogF(d*.6); gl_Position = projectionMatrix*viewMatrix*vec4(wp,1.); }`,
    fragmentShader: `uniform vec3 uShaftCol; uniform float uT, uShaftK; varying vec2 vQ; varying float vA; varying float vSeed;
void main(){ float x = abs(vQ.x), y = vQ.y; float edge = pow(max(1.-x,0.), 3.);
  float along = smoothstep(0.,.18,y)*(1.-smoothstep(.45,1.,y));
  float wisp = .62 + .38*sin(y*7.+uT*.45+vSeed*30.)*sin(vQ.x*3.+uT*.31+vSeed*11.);
  gl_FragColor = vec4(uShaftCol*1.2, edge*along*wisp*vA*uShaftK*.7); }`,
  });

  // dust motes around the camera (stateless)
  const DUST = new T.ShaderMaterial({
    transparent: true, depthWrite: false, blending: T.AdditiveBlending, uniforms: mkU({ uCol: { value: new T.Color(1, .92, .8) }, uBox: { value: 24 }, uH: { value: 12 }, uWind: { value: new T.Vector2(.2, .05) } }),
    vertexShader: PX + `uniform vec3 uCol; uniform float uBox, uH; uniform vec2 uWind; attribute vec4 aD; varying float vA;
void main(){ vec3 b = position; vec3 p; float ph = aD.w;
  p.xz = uCam.xz + (fract(b.xz + uWind*uT/(uBox*2.) + vec2(sin(uT*.2+ph*40.), cos(uT*.17+ph*30.))*.01) - .5)*2.*uBox;
  p.y = uCam.y - 3. + fract(b.y + uT*(.004+ .01*ph))*uH + sin(uT*.6+ph*50.)*.15;
  vec4 mv = viewMatrix*vec4(p,1.); float d = -mv.z; gl_Position = projectionMatrix*mv;
  float tw = .55+.45*sin(uT*(1.5+ph*3.)+ph*60.);
  gl_PointSize = clamp(aD.z*uPx/max(d,.1), 1.2, 6.);
  vA = tw*smoothstep(1.5,5.,d)*(1.-smoothstep(uBox*.55,uBox,d))*(.25+.75*uSunDot)*fogF(d*.5); }`,
    fragmentShader: `uniform vec3 uCol; uniform float uK; varying float vA; void main(){ float r = length(gl_PointCoord-.5)*2.; float a = smoothstep(1.,0.,r); gl_FragColor = vec4(uCol*uK, a*a*vA*.55); }`,
  });

  // embers / sparks rising from hot sources (stateless)
  const EMBER = new T.ShaderMaterial({
    transparent: true, depthWrite: false, blending: T.AdditiveBlending, uniforms: mkU(),
    vertexShader: PX + `attribute vec3 aCol; attribute vec4 aE; varying vec4 vC;
void main(){ float ph = aE.x, sp = aE.y, an = aE.z; float age = fract(uT*sp*.33 + ph);
  vec3 p = position + vec3(cos(an)*age*1.6 + sin(uT*2.+ph*50.)*.15*age, age*2.8 - age*age*.8, sin(an)*age*1.6 + cos(uT*1.7+ph*40.)*.15*age);
  vec4 mv = viewMatrix*vec4(p,1.); float d = -mv.z; gl_Position = projectionMatrix*mv;
  gl_PointSize = clamp(aE.w*uPx/max(d,.1)*(1.-age*.6), 1.2, 7.);
  float tw = .6+.4*sin(uT*20.+ph*90.);
  vC = vec4(aCol*(1.1-age*.8)*uK*.55, tw*pow(1.-age,1.4)*smoothstep(2.5,7.,d)*(1.-smoothstep(40.,70.,d))*fogF(d)); }`,
    fragmentShader: `varying vec4 vC; void main(){ float r = length(gl_PointCoord-.5)*2.; float a = smoothstep(1.,0.,r); gl_FragColor = vec4(vC.rgb, a*a*vC.a); }`,
  });

  // steam puffs from vents (stateless)
  const STEAM = new T.ShaderMaterial({
    transparent: true, depthWrite: false, blending: T.NormalBlending, uniforms: mkU({ uSteamCol: { value: new T.Color(.8, .85, .9) }, uWind3: { value: V3(.25, 0, .1) } }),
    vertexShader: PX + `uniform vec3 uSteamCol, uWind3; attribute vec4 aP; attribute vec3 aTint; varying vec4 vC; varying float vSeed;
void main(){ float age = fract(uT*aP.y*.28 + aP.x);
  vec3 p = position + vec3(0.,age*2.2,0.) + uWind3*age*age*2.2 + vec3(cos(aP.z), 0., sin(aP.z))*age*.55;
  vec4 mv = viewMatrix*vec4(p,1.); float d = -mv.z; gl_Position = projectionMatrix*mv;
  float sz = (.9+age*2.6)*aP.w; gl_PointSize = clamp(sz*uPx/max(d,.1), 1., uMaxPt);
  vSeed = aP.z; vC = vec4(mix(uSteamCol, aTint, .6)*uK, smoothstep(0.,.12,age)*pow(1.-age,1.8)*.2*smoothstep(1.5,4.,d)*(1.-smoothstep(45.,80.,d))*fogF(d*.4)); }`,
    fragmentShader: `varying vec4 vC; varying float vSeed;
float hh(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
float nz(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f); return mix(mix(hh(i),hh(i+vec2(1,0)),f.x),mix(hh(i+vec2(0,1)),hh(i+vec2(1,1)),f.x),f.y); }
void main(){ vec2 q = gl_PointCoord-.5; float r = length(q)*2.; float n = .7+.5*nz(q*5.+vSeed*9.); float a = smoothstep(1.,.15,r)*n; gl_FragColor = vec4(vC.rgb, a*vC.a); }`,
  });

  // bursts: impact sparks + short flashes, ring buffer written on events
  const NB = 640;
  const BURST = new T.ShaderMaterial({
    transparent: true, depthWrite: false, blending: T.AdditiveBlending, uniforms: mkU(),
    vertexShader: PX + `attribute vec3 aVel; attribute vec4 aM; attribute vec3 aCol; varying vec4 vC;
void main(){ float age = uT - aM.x; if (age < 0. || age > aM.y) { gl_Position = vec4(2.,2.,2.,1.); gl_PointSize = 0.; vC = vec4(0.); return; }
  float k = age/aM.y; vec3 p = position + aVel*age; float typ = aM.w;
  if (typ < 1.5) { p.y -= 6.*age*age; if (typ > .5) p.y = max(p.y, position.y); }
  vec4 mv = viewMatrix*vec4(p,1.); float d = -mv.z; gl_Position = projectionMatrix*mv;
  float s = typ > 1.5 ? aM.z*(1.-k*.5) : aM.z*(1.-k*.7);
  gl_PointSize = clamp(s*uPx/max(d,.1), typ > 1.5 ? 2. : 1.5, uMaxPt);
  float f = typ > 1.5 ? (1.-k)*(1.-k) : (1.-k); vC = vec4(aCol*(typ > 1.5 ? 1. : (1.6-k)), f*smoothstep(.15,.6,d)); }`,
    fragmentShader: `varying vec4 vC; void main(){ float r = length(gl_PointCoord-.5)*2.; float a = smoothstep(1.,0.,r); gl_FragColor = vec4(vC.rgb, a*a*vC.a); }`,
  });

  /* ---------- state ---------- */
  const GP = new T.Group(); GP.name = 'gfxplus'; GP.frustumCulled = false; scene.add(GP);
  const st = { map: null, built: false, parts: {}, cfg: BASE_CFG, mats: [], glowN: 0, shaftN: 0, streakN: 0, steamN: 0, emberN: 0, ships: [], sunDir: V3(.3, .6, -.7), sunCol: new T.Color(1, .9, .7), hasSun: false, buildMs: 0, buildSeq: 0, flickMats: [] };
  const rngOf = id => { let h = 2166136261; for (const c of String(id)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return () => { h = (h + 0x6D2B79F5) | 0; let t = Math.imul(h ^ (h >>> 15), 1 | h); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
  const dispose = o => { if (o.geometry) o.geometry.dispose(); };
  const bAttr = (arr, n, dyn) => { const a = new T.BufferAttribute(arr, n); if (dyn) a.setUsage(T.DynamicDrawUsage); return a; };
  const mkMat = (base, name) => base;   // shared singletons: one program each, built once

  /* ---------- collect glow sources from the map's own emissive meshes ---------- */
  function collectGlow(rng, cfg) {
    const cells = new Map(), mats = new Map(), tmp = V3(0, 0, 0), a = V3(0, 0, 0), b = V3(0, 0, 0), c = V3(0, 0, 0);
    MAPROOT.updateMatrixWorld(true);
    MAPROOT.traverse(o => {
      if (!o.isMesh || !o.geometry || !o.visible) return;
      const m = [].concat(o.material)[0]; if (!m || m.wireframe || m.userData.__gpSkip) return;
      let src = null, mx = 0;   // glowing = unlit (basic) colour that is bright, or a standard material with strong emissive
      if (m.isMeshBasicMaterial && m.color) { src = m.color; mx = Math.max(m.color.r, m.color.g, m.color.b); if (mx < .85 || m.fog === false) return; }
      else if (m.emissive && m.emissive.isColor) { src = m.emissive; mx = Math.max(m.emissive.r, m.emissive.g, m.emissive.b) * (m.emissiveIntensity || 1); if (mx < .9) return; }
      else return;
      if (m.map && m.blending === T.AdditiveBlending && o.geometry.attributes.position.count < 20) return;
      let mi = mats.get(m.uuid); if (!mi) { mi = { idx: mats.size, m, base: src.clone(), ei: src === m.emissive ? (m.emissiveIntensity || 1) : 1, src, mx, mode: 0, ph: rng() }; mats.set(m.uuid, mi); }
      const pos = o.geometry.attributes.position, idx = o.geometry.index, n = idx ? idx.count : pos.count, ident = o.matrixWorld.elements[0] === 1 && o.matrixWorld.elements[5] === 1 && o.matrixWorld.elements[10] === 1 && o.matrixWorld.elements[12] === 0 && o.matrixWorld.elements[13] === 0 && o.matrixWorld.elements[14] === 0;
      const step = Math.max(3, Math.floor(n / 3 / 4000) * 3);   // never read more than ~4000 triangles per mesh
      for (let i = 0; i + 2 < n; i += step) {
        const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
        a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
        if (!ident) { a.applyMatrix4(o.matrixWorld); b.applyMatrix4(o.matrixWorld); c.applyMatrix4(o.matrixWorld); }
        tmp.copy(a).add(b).add(c).multiplyScalar(1 / 3);
        const area = b.clone().sub(a).cross(c.clone().sub(a)).length() * .5 * step / 3;
        if (!(area > 0) || tmp.y < .1 || tmp.y > 40) continue;
        const key = mi.idx + '|' + Math.floor(tmp.x / 1.8) + '|' + Math.floor(tmp.y / 1.8) + '|' + Math.floor(tmp.z / 1.8);
        let cl = cells.get(key); if (!cl) { cl = { x: 0, y: 0, z: 0, w: 0, mi }; cells.set(key, cl); }
        const w = Math.min(area, 3); cl.x += tmp.x * w; cl.y += tmp.y * w; cl.z += tmp.z * w; cl.w += w;
      }
    });
    let list = [...cells.values()].filter(cl => cl.w > .1).map(cl => ({ x: cl.x / cl.w, y: cl.y / cl.w, z: cl.z / cl.w, w: cl.w, mi: cl.mi }));
    list.sort((p, q) => q.w - p.w);
    const keep = [];
    for (const cl of list) { if (keep.length >= 240) break; if (keep.some(k => (k.x - cl.x) ** 2 + (k.y - cl.y) ** 2 + (k.z - cl.z) ** 2 < 2.9)) continue; keep.push(cl); }
    // flicker mode per material: 1 = buzz, 2 = broken sign
    const fl = cfg.flick * (reduceMo ? 0 : 1);
    for (const mi of mats.values()) { const r = rng(); mi.mode = r < fl * .16 ? 2 : r < fl * .5 ? 1 : 0; }
    return { clusters: keep, mats: [...mats.values()].slice(0, 32) };
  }

  /* ---------- shaft placement: lit ground that touches shadow, from the map's collider boxes ---------- */
  function rayHitsBoxes(o, d, maxT, boxes, skip) {
    for (let i = 0; i < boxes.length; i++) {
      const bx = boxes[i]; if (bx === skip) continue;
      let t0 = 0, t1 = maxT;
      for (let ax = 0; ax < 3; ax++) {
        const oo = ax === 0 ? o.x : ax === 1 ? o.y : o.z, dd = ax === 0 ? d.x : ax === 1 ? d.y : d.z, mn = ax === 0 ? bx.min.x : ax === 1 ? bx.min.y : bx.min.z, mx = ax === 0 ? bx.max.x : ax === 1 ? bx.max.y : bx.max.z;
        if (Math.abs(dd) < 1e-6) { if (oo < mn || oo > mx) { t0 = 2; break; } continue; }
        let ta = (mn - oo) / dd, tb = (mx - oo) / dd; if (ta > tb) { const q = ta; ta = tb; tb = q; }
        if (ta > t0) t0 = ta; if (tb < t1) t1 = tb; if (t0 > t1) break;
      }
      if (t0 <= t1 && t0 <= maxT) return true;
    }
    return false;
  }
  const groundY = (x, z, y) => { let gy = 0; for (const b of world.colliders) if (x > b.min.x && x < b.max.x && z > b.min.z && z < b.max.z && b.max.y <= y + .6) gy = Math.max(gy, b.max.y); return gy; };
  function placeShafts(rng, half, sunDir) {
    const boxes = world.colliders.filter(b => b.max.y - b.min.y > .6 || b.max.y > 1.2), out = [], cand = [];
    const lat = V3(-sunDir.z, 0, sunDir.x).normalize();
    const lit = (x, y, z) => !rayHitsBoxes(V3(x, y + .35, z), sunDir, 90, boxes);
    for (let x = -half * .9; x <= half * .9; x += 2.6) for (let z = -half * .9; z <= half * .9; z += 2.6) {
      const jx = x + (rng() - .5) * 1.8, jz = z + (rng() - .5) * 1.8, y = groundY(jx, jz, 3.2);
      if (y > 3.5) continue;
      if (boxes.some(b => jx > b.min.x - .2 && jx < b.max.x + .2 && jz > b.min.z - .2 && jz < b.max.z + .2 && b.max.y > y + .5 && b.min.y < y + .6)) continue;   // inside a wall
      if (!lit(jx, y, jz)) continue;
      // shadow edge within 2.8 m sideways?
      let edge = 0;
      for (const s of [-1, 1]) for (const k of [1.4, 2.8]) { const sx = jx + lat.x * s * k, sz = jz + lat.z * s * k; if (!lit(sx, groundY(sx, sz, 3.2), sz)) edge += k === 1.4 ? 2 : 1; }
      // tall occluder nearby sun-ward gives a believable beam
      if (edge > 0) cand.push({ x: jx, y, z: jz, sc: edge + rng() * .8 });
    }
    cand.sort((p, q) => q.sc - p.sc);
    for (const c of cand) { if (out.length >= 26) break; if (out.some(o => (o.x - c.x) ** 2 + (o.z - c.z) ** 2 < 30)) continue; out.push(c); }
    return out;
  }

  /* ---------- steam vents ---------- */
  function placeVents(rng, half, cfg) {
    const vents = [], boxes = world.colliders;
    const hz = (typeof MAPFX !== 'undefined' && MAPFX && MAPFX.hazards) || [];
    for (const h of hz) { const c = h.kind === 'lava' ? [1, .62, .38] : h.kind === 'acid' ? [.55, 1, .45] : [.8, .9, 1]; for (let i = 0; i < 3; i++) vents.push({ x: h.x0 + (h.x1 - h.x0) * (.15 + .7 * rng()), z: h.z0 + (h.z1 - h.z0) * (.15 + .7 * rng()), y: .15, tint: c, big: 1.3 }); }
    let tries = 0, want = 8 + vents.length;
    const solid = (x, z) => boxes.some(b => x > b.min.x && x < b.max.x && z > b.min.z && z < b.max.z && b.max.y > 1.2);
    while (vents.length < want && tries++ < 500) {
      const x = (rng() * 2 - 1) * half * .85, z = (rng() * 2 - 1) * half * .85;
      if (solid(x, z)) continue; if (Math.hypot(x, z) < 5) continue;
      if (!(solid(x + 1.7, z) || solid(x - 1.7, z) || solid(x, z + 1.7) || solid(x, z - 1.7))) continue;
      const y = groundY(x, z, 2); if (y > 1.2) continue;
      if (vents.some(v => (v.x - x) ** 2 + (v.z - z) ** 2 < 49)) continue;
      vents.push({ x, z, y: y + .05, tint: [1, 1, 1], big: 1 });
    }
    return vents;
  }

  /* ---------- sky ships ---------- */
  const shipGeo = (() => {   // arrow-shaped hull: 10 triangles, nose along +x
    const v = [[6, 0, 0], [-4, 0, 0], [-3, 0, 4.2], [-3, 0, -4.2], [-3.4, 1.1, 0], [-3.4, -.7, 0], [-5.5, .5, 1.1], [-5.5, .5, -1.1]];
    const f = [[0, 4, 2], [0, 3, 4], [0, 2, 5], [0, 5, 3], [1, 2, 4], [1, 4, 3], [1, 5, 2], [1, 3, 5], [4, 6, 7], [5, 7, 6]];
    const pos = []; for (const t of f) for (const i of t) pos.push(...v[i]);
    const geo = new T.BufferGeometry(); geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); geo.computeVertexNormals(); return geo;
  })();
  const shipMat = new T.MeshBasicMaterial({ color: 0x0a0c12, fog: false });
  function makeShip(rng, scale, color) {
    const grp = new T.Group(); const hull = new T.Mesh(shipGeo, shipMat); hull.scale.setScalar(scale); hull.frustumCulled = false; grp.add(hull);
    const pg = new T.BufferGeometry(); const P = [], C = [], A = [];
    const add = (x, y, z, col, size, mode) => { P.push(x * scale, y * scale, z * scale); C.push(...col); A.push(size, mode, rng()); };
    add(-.4, .1, 4.2, [3, .2, .15], 5, -3); add(-.4, .1, -4.2, [.2, 2.6, .5], 5, -3); add(-5.2, .4, 0, [2.6, 2.6, 3], 7, -2);
    add(-6, 0, .5, [1, 1.6, 3.2], 16 + rng() * 6, -1); add(-6, 0, -.5, [1, 1.6, 3.2], 16 + rng() * 6, -1);
    pg.setAttribute('position', new T.Float32BufferAttribute(P, 3)); pg.setAttribute('aCol', new T.Float32BufferAttribute(C, 3)); pg.setAttribute('aP', new T.Float32BufferAttribute(A, 3));
    const pts = new T.Points(pg, HALO); pts.frustumCulled = false; grp.add(pts);
    grp.frustumCulled = false; return grp;
  }
  function buildShips(rng, cfg, fogCol) {
    const n = Math.min(3, Math.round(cfg.ships)), out = [];
    shipMat.color.copy(fogCol).multiplyScalar(.28).add(new T.Color(.02, .025, .035));
    for (let i = 0; i < n; i++) {
      const scale = 1.6 + rng() * 1.4, grp = makeShip(rng, scale), ang = rng() * Math.PI * 2, R = 300 + rng() * 80;
      const dir = V3(Math.cos(ang + Math.PI / 2), 0, Math.sin(ang + Math.PI / 2)), start = V3(Math.cos(ang) * R, 70 + rng() * 90, Math.sin(ang) * R);
      grp.rotation.y = Math.atan2(-dir.z, dir.x); GP.add(grp);
      out.push({ grp, start, dir, speed: 7 + rng() * 6, t: rng() * 2 * 220 / 10, len: R * 2 * .9, i });
    }
    return out;
  }

  /* ---------- the sun glare ---------- */
  const glareMat = new T.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: true, blending: T.AdditiveBlending, premultipliedAlpha: true, fog: false, uniforms: { uCol: { value: new T.Color(1, .85, .6) }, uI: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: `uniform vec3 uCol; uniform float uI; varying vec2 vUv;
void main(){ vec2 q = vUv-.5; float r = length(q)*2.; float core = exp(-r*r*26.); float halo = exp(-r*4.2)*.26; float streak = exp(-abs(q.y)*70.)*exp(-abs(q.x)*3.4)*.4; float ring = exp(-pow((r-.55)*7.,2.))*.05;
  float g = (core*1.4 + halo + streak + ring)*uI; gl_FragColor = vec4(uCol*g, g); }`,
  });
  const glare = new T.Mesh(new T.PlaneGeometry(1, 1), glareMat); glare.frustumCulled = false; glare.renderOrder = 50; glare.visible = false; scene.add(glare);


  /* ---------- screen-space sun rays (one cheap pass, only while the sun is on screen, High/Ultra) ---------- */
  const GR = new T.ShaderPass({
    uniforms: { tDiffuse: { value: null }, uSun: { value: new T.Vector2(.5, .5) }, uI: { value: 0 }, uCol: { value: new T.Color(1, .9, .7) }, uExp: { value: .9 }, uN: { value: 20 }, uThr: { value: .72 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform sampler2D tDiffuse; uniform vec2 uSun; uniform float uI, uExp, uN, uThr; uniform vec3 uCol; varying vec2 vUv;
vec3 aces(vec3 x){ return clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),0.,1.); }
void main(){ vec3 c = texture2D(tDiffuse, vUv).rgb; vec2 dl = uSun - vUv; float dist = length(dl); vec2 st = dl*(.9/uN);
  vec2 uv = vUv + st*fract(sin(dot(gl_FragCoord.xy, vec2(12.9898,78.233)))*43758.5453); float acc = 0., wgt = 1.;
  for (int i = 0; i < 40; i++) { if (float(i) >= uN) break; vec3 s = clamp(texture2D(tDiffuse, uv).rgb, 0., 16.); float l = dot(aces(s*uExp), vec3(.3,.59,.11)); acc += smoothstep(uThr, uThr+.18, l)*wgt; wgt *= .96; uv += st; }
  acc /= uN; float fall = 1./(1.+dist*dist*4.5);
  gl_FragColor = vec4(c + uCol*acc*uI*fall, 1.); }`,
  });
  GR.enabled = false; GR.needsSwap = true;
  { const bi = typeof bloom !== 'undefined' ? composer.passes.indexOf(bloom) : -1; if (bi >= 0) composer.insertPass(GR, bi); else composer.insertPass(GR, Math.max(0, composer.passes.length - 1)); }
  const _sunP = V3(0, 0, 0);
  function updateRays(L, cfg) {
    let on = false;
    if (L.on && L.rays && cfg.rays > 0 && st.hasSun && typeof state !== 'undefined' && state !== 'loading') {
      _sunP.copy(camera.position).addScaledVector(st.sunDir, 1000).project(camera);
      const behind = (_v.copy(st.sunDir).dot(camera.getWorldDirection(_p))) < .05;
      if (!behind && Math.abs(_sunP.x) < 1.6 && Math.abs(_sunP.y) < 1.6 && !(typeof P !== 'undefined' && P.ads > .5)) {
        on = true; GR.uniforms.uSun.value.set(_sunP.x * .5 + .5, _sunP.y * .5 + .5);
        GR.uniforms.uI.value = L.rays * cfg.rays; GR.uniforms.uN.value = L.name === 'ultra' ? 32 : 20; GR.uniforms.uExp.value = grade.uniforms.uExposure.value;
        GR.uniforms.uCol.value.copy(st.sunCol).lerp(new T.Color(1, .92, .8), .4);
      }
    }
    GR.enabled = on;
  }

  /* ---------- burst ring buffer (impact sparks, world flashes) ---------- */
  const burst = (() => {
    const geo = new T.BufferGeometry(), pos = new Float32Array(NB * 3), vel = new Float32Array(NB * 3), m = new Float32Array(NB * 4), col = new Float32Array(NB * 3);
    for (let i = 0; i < NB; i++) m[i * 4] = -1e4;
    const aP = bAttr(pos, 3, true), aV = bAttr(vel, 3, true), aM = bAttr(m, 4, true), aC = bAttr(col, 3, true);
    geo.setAttribute('position', aP); geo.setAttribute('aVel', aV); geo.setAttribute('aM', aM); geo.setAttribute('aCol', aC);
    const pts = new T.Points(geo, BURST); pts.frustumCulled = false; pts.renderOrder = 6;
    return { geo, pts, pos, vel, m, col, aP, aV, aM, aC, idx: 0, dirty: false };
  })();
  GP.add(burst.pts);
  function put(p, v, born, life, size, typ, flag, c) {
    const i = burst.idx; burst.idx = (burst.idx + 1) % NB;
    burst.pos[i * 3] = p.x; burst.pos[i * 3 + 1] = p.y; burst.pos[i * 3 + 2] = p.z; burst.vel[i * 3] = v.x; burst.vel[i * 3 + 1] = v.y; burst.vel[i * 3 + 2] = v.z;
    burst.m[i * 4] = born; burst.m[i * 4 + 1] = life; burst.m[i * 4 + 2] = size; burst.m[i * 4 + 3] = typ + (typ === 0 && flag ? 1 : 0);
    burst.col[i * 3] = c[0]; burst.col[i * 3 + 1] = c[1]; burst.col[i * 3 + 2] = c[2]; burst.dirty = true;
  }
  const _n = V3(0, 1, 0), _v = V3(0, 0, 0), _p = V3(0, 0, 0);
  const SPARK = { hole: [[3.2, 2.2, .9], 8, .38, 6.5], scorch: [[3, 1.1, .3], 6, .6, 3.5], frost: [[1.1, 2.1, 3.2], 6, .5, 4], slash: [[2.6, 2.4, 3.2], 6, .45, 5] };
  function impact(p, n, kind, heat, s) {
    const L = lvl(); if (!L.on || !L.impact) return;
    if (p.distanceToSquared(camera.position) > 4900) return;
    const def = SPARK[kind] || SPARK.hole; let c = def[0];
    if (heat && kind === 'hole') { const mx = Math.max(heat[0], heat[1], heat[2], .01); c = [heat[0] / mx * 2.2 + 1, heat[1] / mx * 2.2 + .9, heat[2] / mx * 2.2 + .7]; }
    const tNow = U.uT.value, floor = n.y > .7 ? 1 : 0, cnt = Math.round(def[1] * (L.name === 'medium' ? .6 : 1));
    for (let i = 0; i < cnt; i++) {
      _v.set(Math.random() - .5, Math.random() - .5, Math.random() - .5).normalize().multiplyScalar(1.6 + Math.random() * 2.4).addScaledVector(n, def[3] * (.5 + Math.random() * .8));
      put(_p.copy(p).addScaledVector(n, .04), _v, tNow, def[2] * (.6 + Math.random() * .7), .045 + Math.random() * .03, 0, floor, c);
    }
    put(_p.copy(p).addScaledVector(n, .08), _v.set(0, 0, 0), tNow, .07, .3 * (s || 1), 2, 0, [c[0] * .8, c[1] * .8, c[2] * .8]);
  }
  function flash(p, color, intensity) {
    const L = lvl(); if (!L.on || !L.muzzle) return;
    const d2 = p.distanceToSquared(camera.position); if (d2 < 2.2 || d2 > 6400) return;
    _v.set(0, 0, 0); const col = new T.Color(color); const big = Math.min(1.8, .3 + (intensity || 4) * .05);
    put(p, _v, U.uT.value, .07 + big * .02, big, 2, 0, [col.r * 2.4 + .5, col.g * 2.4 + .4, col.b * 2.4 + .3]);
  }

  /* ---------- first-person muzzle glow ---------- */
  const glowTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d'); const gr = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(.18, 'rgba(255,255,255,.7)'); gr.addColorStop(.5, 'rgba(255,255,255,.18)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = gr; x.fillRect(0, 0, 128, 128); const t = new T.CanvasTexture(c); return t; })();
  const mzMat = new T.MeshBasicMaterial({ map: glowTex, color: new T.Color(2.6, 1.4, .55), blending: T.AdditiveBlending, transparent: true, depthWrite: false, depthTest: false, side: T.DoubleSide, fog: false });
  const mzGeo = new T.PlaneGeometry(1, 1);
  let mzScan = 0; const mzList = [];   // first-person muzzle glow quads (hidden on Low: the module adds nothing to the scene there)
  function attachMuzzle() {
    if (typeof WM === 'undefined') return;
    const add = fl => { if (!fl || fl.userData.__gp) return; fl.userData.__gp = 1; const m = new T.Mesh(mzGeo, mzMat); m.scale.setScalar(.34); m.position.z = .02; m.renderOrder = 20; m.userData.gpGlow = 1; m.visible = lvl().on && !!lvl().muzzle; mzList.push(m); fl.add(m); };
    for (const k in WM) if (WM[k] && WM[k].flash) add(WM[k].flash);
    if (typeof muzzleFlash !== 'undefined') add(muzzleFlash);
  }

  /* ---------- build per map ---------- */
  function clearParts() {
    for (const k in st.parts) { const o = st.parts[k]; GP.remove(o); dispose(o); }
    st.parts = {}; for (const s of st.ships) { GP.remove(s.grp); s.grp.traverse(dispose); } st.ships = [];
    for (const f of st.flickMats) { try { f.m.color.copy(f.base); } catch (e) {} } st.flickMats = [];
  }
  function quadGeo(n, attrs) {   // n quads with per-quad attribute lists; returns geometry + helpers
    const geo = new T.BufferGeometry(), idx = new Uint32Array(n * 6), cor = new Float32Array(n * 8);
    for (let i = 0; i < n; i++) { const b = i * 4; idx.set([b, b + 1, b + 2, b + 2, b + 1, b + 3], i * 6); cor.set([-1, 0, 1, 0, -1, 1, 1, 1], i * 8); }
    geo.setIndex(new T.BufferAttribute(idx, 1)); geo.setAttribute('aC', new T.BufferAttribute(cor, 2));
    for (const [name, size] of attrs) geo.setAttribute(name, new T.BufferAttribute(new Float32Array(n * 4 * size), size));
    return geo;
  }
  function fillQuad(geo, name, i, vals) { const a = geo.attributes[name], s = a.itemSize; for (let k = 0; k < 4; k++) for (let j = 0; j < s; j++) a.array[(i * 4 + k) * s + j] = vals[j]; }

  function build(id) {
    const t0 = performance.now(); clearParts();
    const cfg = Object.assign({}, BASE_CFG, MAPCFG[id] || {}), rng = rngOf(id), seq = ++st.buildSeq;
    st.cfg = cfg; st.map = id; const half = (typeof HALF !== 'undefined' && HALF) || 40;
    // sun
    if (typeof sun !== 'undefined' && sun) { st.sunDir.copy(sun.position).normalize(); st.sunCol.copy(sun.color); st.hasSun = true; } else st.hasSun = false;
    const fogCol = scene.fog ? scene.fog.color.clone() : new T.Color(.3, .3, .35); U.uFogD.value = scene.fog ? scene.fog.density : .01;

    // glow sources
    const { clusters, mats } = collectGlow(rng, cfg); st.mats = mats;
    st.flickMats = mats.filter(m => m.mode > 0).map(m => ({ m: { color: m.src }, base: m.base, mode: m.mode, ph: m.ph, v: 1, idx: m.idx }));
    const hl = clusters.filter(cl => cl.mi.mode > 0 && cl.w >= 6);   // only big lit faces (small bits of a sign read as floating eyes/orbs)   // halos only where a sign flickers (a steady neon already blooms; flat halos on it just look like orbs)
    st.glowN = hl.length;
    if (clusters.length) {
      if (hl.length) {
        const n = hl.length, geo = new T.BufferGeometry(), P = new Float32Array(n * 3), C = new Float32Array(n * 3), A = new Float32Array(n * 3);
        hl.forEach((cl, i) => { const m = cl.mi; const mx = m.mx; P.set([cl.x, cl.y, cl.z], i * 3); const k = Math.min(1.25, .5 + mx * .12) / mx; C.set([m.base.r * m.ei * k, m.base.g * m.ei * k, m.base.b * m.ei * k], i * 3);
          A.set([Math.min(1.6, .7 + Math.sqrt(cl.w) * .2) * cfg.glow, Math.min(31, m.idx), rng()], i * 3); });
        geo.setAttribute('position', new T.BufferAttribute(P, 3)); geo.setAttribute('aCol', new T.BufferAttribute(C, 3)); geo.setAttribute('aP', new T.BufferAttribute(A, 3));
        const pts = new T.Points(geo, HALO); pts.frustumCulled = false; pts.renderOrder = 4; GP.add(pts); st.parts.halo = pts;
      }
      // floor streaks
      const ws = [];
      clusters.forEach(cl => { const gy = groundY(cl.x, cl.z, cl.y), h = cl.y - gy; if (h > .25 && h < 10 && gy < 3) ws.push({ cl, gy, h }); });
      ws.sort((p, q) => q.cl.w - p.cl.w); const wn = Math.min(ws.length, 140);
      if (wn) {
        const sg = quadGeo(wn, [['position', 3], ['aCol', 3], ['aS', 4]]);
        for (let i = 0; i < wn; i++) { const { cl, gy, h } = ws[i], m = cl.mi, mx = m.mx, k = Math.min(1.1, .45 + mx * .1) / mx;
          fillQuad(sg, 'position', i, [cl.x, gy, cl.z]); fillQuad(sg, 'aCol', i, [m.base.r * m.ei * k, m.base.g * m.ei * k, m.base.b * m.ei * k]); fillQuad(sg, 'aS', i, [.28 + Math.min(1.4, Math.sqrt(cl.w) * .28), h, Math.min(31, m.idx), 0]); }
        const sm = new T.Mesh(sg, STREAK); sm.frustumCulled = false; sm.renderOrder = 3; GP.add(sm); st.parts.streak = sm; st.streakN = wn;
      } else st.streakN = 0;
      // embers from the glow sources
      const en = Math.min(clusters.length * 3, 260);
      if (cfg.ember > 0 && en) {
        const eg = new T.BufferGeometry(), EP = new Float32Array(en * 3), EC = new Float32Array(en * 3), EE = new Float32Array(en * 4);
        for (let i = 0; i < en; i++) { const cl = clusters[Math.floor(rng() * Math.min(clusters.length, 60))], m = cl.mi, k = 1.3 / m.mx; EP.set([cl.x + (rng() - .5) * 1.2, cl.y - .2 + rng() * .4, cl.z + (rng() - .5) * 1.2], i * 3);
          EC.set([m.base.r * m.ei * k, m.base.g * m.ei * k, m.base.b * m.ei * k], i * 3); EE.set([rng(), .6 + rng() * 1.1, rng() * 6.28, .03 + rng() * .035], i * 4); }
        eg.setAttribute('position', new T.BufferAttribute(EP, 3)); eg.setAttribute('aCol', new T.BufferAttribute(EC, 3)); eg.setAttribute('aE', new T.BufferAttribute(EE, 4));
        const ep = new T.Points(eg, EMBER); ep.frustumCulled = false; ep.renderOrder = 5; GP.add(ep); st.parts.ember = ep; st.emberN = en;
      } else st.emberN = 0;
    } else { st.streakN = 0; st.emberN = 0; }

    // dust (always; the amount scales)
    { const n = 1100, geo = new T.BufferGeometry(), P = new Float32Array(n * 3), D = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) { P.set([rng(), rng(), rng()], i * 3); D.set([0, 0, .035 + rng() * .035, rng()], i * 4); }
      geo.setAttribute('position', new T.BufferAttribute(P, 3)); geo.setAttribute('aD', new T.BufferAttribute(D, 4));
      const dp = new T.Points(geo, DUST); dp.frustumCulled = false; dp.renderOrder = 5; GP.add(dp); st.parts.dust = dp; }
    DUST.uniforms.uCol.value.copy(st.sunCol).lerp(new T.Color(1, 1, 1), .45).multiplyScalar(1.1);

    // shafts
    st.shaftN = 0;
    if (cfg.shaft > 0 && st.hasSun && st.sunDir.y > .12) {
      const spots = placeShafts(rng, half, st.sunDir), n = spots.length;
      if (n) {
        const sg = quadGeo(n, [['position', 3], ['aAxis', 3], ['aP', 3]]);
        spots.forEach((s, i) => { const len = 7 + rng() * 6, axis = st.sunDir.clone().multiplyScalar(len); fillQuad(sg, 'position', i, [s.x, s.y + .1, s.z]); fillQuad(sg, 'aAxis', i, [axis.x, axis.y, axis.z]); fillQuad(sg, 'aP', i, [1.3 + rng() * 1.6, .7 + rng() * .5, rng()]); });
        const sm = new T.Mesh(sg, SHAFT); sm.frustumCulled = false; sm.renderOrder = 4; GP.add(sm); st.parts.shaft = sm; st.shaftN = n;
        SHAFT.uniforms.uShaftCol.value.copy(st.sunCol).lerp(new T.Color(1, .95, .85), .3);
      }
    }
    // steam
    st.steamN = 0;
    if (cfg.steam > 0) {
      const vents = placeVents(rng, half, cfg), per = 22, n = vents.length * per;
      if (n) {
        const geo = new T.BufferGeometry(), P = new Float32Array(n * 3), A = new Float32Array(n * 4), TT = new Float32Array(n * 3);
        vents.forEach((v, i) => { for (let j = 0; j < per; j++) { const k = i * per + j; P.set([v.x + (rng() - .5) * .3, v.y, v.z + (rng() - .5) * .3], k * 3); A.set([j / per + rng() * .03, .7 + rng() * .5, rng() * 6.28, (.7 + rng() * .5) * v.big], k * 4); TT.set(v.tint, k * 3); } });
        geo.setAttribute('position', new T.BufferAttribute(P, 3)); geo.setAttribute('aP', new T.BufferAttribute(A, 4)); geo.setAttribute('aTint', new T.BufferAttribute(TT, 3));
        const sp = new T.Points(geo, STEAM); sp.frustumCulled = false; sp.renderOrder = 7; GP.add(sp); st.parts.steam = sp; st.steamN = n; st.vents = vents.length;
        STEAM.uniforms.uSteamCol.value.copy(fogCol).lerp(new T.Color(1, 1, 1), .55).multiplyScalar(Math.max(.35, Math.min(1.1, (typeof sun !== 'undefined' && sun ? sun.intensity : 1) * .45 + .3)));
      }
    }
    // sky ships
    if (cfg.ships > 0 && !(reduceMo)) st.ships = buildShips(rng, cfg, fogCol);
    // glare tint
    glareMat.uniforms.uCol.value.copy(st.sunCol).lerp(new T.Color(1, .9, .75), .35);
    st.buildMs = +(performance.now() - t0).toFixed(1); st.built = true; st.seq = seq;
    applyLevel();
  }

  /* ---------- tier application: draw ranges + uniforms only (no shader work) ---------- */
  function applyLevel() {
    const L = lvl(), cfg = st.cfg;
    GP.visible = true;   // the part visibility stays true so every program exists; counts go to 0 when off
    U.uK.value = L.on ? L.K : 0;
    const setPts = (o, n) => { if (o) { o.geometry.setDrawRange(0, Math.max(0, Math.floor(n))); o.visible = n >= 1; } };   // zero-count parts are hidden (three r147 still counts a draw for an empty range)
    const on = L.on;
    burst.geo.setDrawRange(0, on ? NB : 0); burst.pts.visible = on;
    setPts(st.parts.halo, on ? st.glowN * L.glow * (L.name === 'medium' ? 1 : 1) : 0);
    setPts(st.parts.dust, on ? 1100 * L.dust * Math.min(1.4, cfg.dust) : 0);
    setPts(st.parts.ember, on ? st.emberN * L.ember * Math.min(1.5, cfg.ember) : 0);
    setPts(st.parts.steam, on ? st.steamN * L.steam : 0);
    if (st.parts.streak) { const n = on ? Math.floor(st.streakN * (L.wet && cfg.wet > 0 ? 1 : 0)) * 6 : 0; st.parts.streak.geometry.setDrawRange(0, n); st.parts.streak.visible = n > 0; }
    STREAK.uniforms.uWet.value = Math.min(1.3, cfg.wet) * (on ? 1 : 0);
    if (st.parts.shaft) { const n = on ? Math.floor(st.shaftN * L.shaft * Math.min(1, cfg.shaft + .2)) * 6 : 0; st.parts.shaft.geometry.setDrawRange(0, n); st.parts.shaft.visible = n > 0; }
    SHAFT.uniforms.uShaftK.value = cfg.shaft * (on ? 1 : 0) * (L.name === 'ultra' ? 1.15 : 1);
    HALO.uniforms.uSizeK.value = L.name === 'ultra' ? 1.1 : 1;
    st.ships.forEach((s, i) => { s.grp.visible = on && i < L.ships; });
    for (const m of mzList) m.visible = on && !!L.muzzle;
    // chromatic fringe in the grade pass
    if (grade.uniforms.uCAe) grade.uniforms.uCAe.value = on ? L.ca : 0;
    // restore flicker colours when off
    if (!on) for (const f of st.flickMats) f.m.color.copy(f.base);
    S.level = L.name;
  }

  /* ---------- per frame ---------- */
  let lastT = 0, fcount = 0;
  const fl = (f, t) => {   // flicker value for one material
    if (f.mode === 1) return .9 + .1 * Math.sin(t * 47 + f.ph * 9) * Math.sin(t * 2.3 + f.ph * 5);
    const slot = Math.floor(t * 6 + f.ph * 50), h = Math.abs(Math.sin(slot * 12.9898 + f.ph * 78.233) * 43758.5453) % 1;
    return h > .95 ? .1 : h > .89 ? .5 : .96 + .04 * Math.sin(t * 60);
  };
  function perFrame(nowMs) {
    // safety net: a map that finished loading before this module's loadMap wrapper was in place (module arrived mid-boot)
    if (typeof CUR_MAP !== 'undefined' && CUR_MAP && CUR_MAP !== st.map && MAPROOT.children.length && !(document.getElementById('mapload') || {}).hidden === false && !inMatch()) { build(CUR_MAP); prewarm(); }
    const L = lvl(); const t = nowMs / 1000; const dt = Math.min(.1, lastT ? t - lastT : .016); lastT = t;
    if (!L.on) { glare.visible = false; GR.enabled = false; return; }
    U.uT.value = t; U.uCam.value.copy(camera.position);
    const th = 1 / camera.projectionMatrix.elements[5]; /* the projection actually drawn (player FOV setting) */ const rtH = (typeof composer !== 'undefined' && composer.renderTarget1) ? composer.renderTarget1.height : renderer.domElement.height;
    U.uPx.value = rtH / (2 * th);
    camera.getWorldDirection(_v); const sd = st.hasSun ? Math.max(0, _v.dot(st.sunDir)) : 0; U.uSunDot.value = sd * sd * sd;
    // flicker
    for (const f of st.flickMats) { const target = L.flick ? fl(f, t) : 1; f.v += (target - f.v) * Math.min(1, dt * 40); f.m.color.copy(f.base).multiplyScalar(f.v); U.uFl.value[f.idx] = f.v; }
    for (const m of st.mats) if (m.mode === 0) U.uFl.value[m.idx] = 1;
    const cfg = st.cfg; updateRays(L, cfg);
    // glare
    if (st.hasSun && L.glare && cfg.glare > 0 && sd > .35 && (typeof state === 'undefined' || state !== 'loading')) {
      glare.visible = true; const amt = Math.min(1, (sd - .35) / .55); glareMat.uniforms.uI.value = amt * amt * .24 * cfg.glare * L.glare;
      glare.position.copy(camera.position).addScaledVector(st.sunDir, 520); glare.quaternion.copy(camera.quaternion); glare.scale.setScalar(900 * (camera.fov > 60 ? 1 : .7));
    } else glare.visible = false;
    // sky ships
    for (const s of st.ships) { if (!s.grp.visible) continue; s.t += dt * (typeof timeScale !== 'undefined' ? 1 : 1); const d = s.t * s.speed - s.len / 2; if (d > s.len / 2) s.t = 0;
      s.grp.position.copy(s.start).addScaledVector(s.dir, d); s.grp.position.y = s.start.y + Math.sin(s.t * .13 + s.i) * 4; }
    // bursts upload
    if (burst.dirty) { burst.aP.needsUpdate = burst.aV.needsUpdate = burst.aM.needsUpdate = burst.aC.needsUpdate = true; burst.dirty = false; }
    if ((++fcount & 31) === 0) attachMuzzle();
    // muzzle glow follows the game's own flash timing (it is a child of the flash group)
  }

  /* ---------- hooks ---------- */
  const inMatch = () => typeof state !== 'undefined' && (state === 'play' || state === 'paused' || state === 'dead');
  const prewarm = () => {
    try {
      const wasVis = GP.visible; GP.visible = true;
      // programs are built with every part drawn once, whatever the tier
      const was = []; GP.traverse(o => { if (o.isMesh || o.isPoints) { was.push([o, o.visible]); o.visible = true; } }); for (const sh of st.ships) sh.grp.visible = true;
      renderer.compile(scene, camera);
      for (const [o, v] of was) o.visible = v;
      const tmp = new T.Mesh(mzGeo, mzMat); if (typeof gunScene !== 'undefined') { gunScene.add(tmp); try { renderer.compile(gunScene, typeof gunCam !== 'undefined' ? gunCam : camera); } catch (e) {} gunScene.remove(tmp); }
      if (!glare.parent) scene.add(glare); const gv = glare.visible; glare.visible = true; try { renderer.compile(scene, camera); } catch (e) {} glare.visible = gv;
      if (glowTex) renderer.initTexture(glowTex);
      { const ge = GR.enabled; GR.enabled = true; try { composer.render(0); } catch (e) {} GR.enabled = ge; }
      GP.visible = wasVis; applyLevel();
    } catch (e) { console.warn('[gfxplus] prewarm', e); }
  };
  const _lm = loadMap;
  loadMap = async function (id) {
    const r = await _lm.apply(this, arguments);
    try { const cur = (typeof CUR_MAP !== 'undefined' && CUR_MAP) || id; if (cur !== st.map || !st.built) { build(cur); prewarm(); } } catch (e) { console.warn('[gfxplus] build failed', e); }
    return r;
  };
  if (typeof warmShaders === 'function') { const _ws = warmShaders; warmShaders = function () { const r = _ws.apply(this, arguments); prewarm(); return r; }; }
  if (typeof applyQuality === 'function') { const _aq = applyQuality; applyQuality = function () { const r = _aq.apply(this, arguments); try { applyLevel(); } catch (e) {} return r; }; }
  { const _fr = frame; frame = function (now) { _fr(now); try { perFrame(now); } catch (e) { if (!S.err) { S.err = String(e); console.warn('[gfxplus] frame', e); } } }; }
  if (typeof decal === 'function') { const _d = decal; decal = function (p, n, s, kind, heat) { const r = _d.apply(this, arguments); try { impact(p, n, kind || 'hole', heat, s); } catch (e) {} return r; }; }
  if (typeof lightFlash === 'function') { const _lf = lightFlash; lightFlash = function (p, color, intensity, dist) { const r = _lf.apply(this, arguments); try { flash(p, color, intensity); } catch (e) {} return r; }; }

  /* ---------- grade pass: faint chromatic fringe toward the edges (one uniform in the shader graphics.js installed) ---------- */
  function patchGrade() {
    const fs = grade.material.fragmentShader;
    if (!grade.uniforms.uCAe) grade.uniforms.uCAe = { value: 0 };
    if (fs.includes('uCAe')) return true;
    const anchor = 'float ca = uHit*.005 + uDying*.01;';
    if (!fs.includes(anchor) || !fs.includes('uniform float uAA')) { return false; }   // graphics.js not installed: leave the base shader alone
    grade.material.fragmentShader = fs.replace('uniform float uAA,', 'uniform float uCAe; uniform float uAA,').replace(anchor, 'float ca = uHit*.005 + uDying*.01 + uCAe*r;');
    grade.material.needsUpdate = true; return true;
  }
  S.gradePatched = patchGrade();

  /* ---------- public ---------- */
  S.status = () => ({ level: S.level, tier: tierName(), map: st.map, glow: st.glowN, streak: st.streakN, shaft: st.shaftN, steam: st.steamN, embers: st.emberN, ships: st.ships.length, flick: st.flickMats.length, buildMs: st.buildMs, gradePatched: S.gradePatched, ca: grade.uniforms.uCAe ? grade.uniforms.uCAe.value : 0, draws: GP.children.length, err: S.err || null, sunVisible: glare.visible });
  S.GR = GR; S.impact = impact; S.flash = flash; S.rebuild = () => { build(st.map || (typeof CUR_MAP !== 'undefined' ? CUR_MAP : 'yard')); prewarm(); };
  S.setEnabled = on => { S.off = !on; applyLevel(); };
  Object.defineProperty(S, 'parts', { get: () => st.parts }); S.U = U; S.LEVELS = LEVELS; S.MAPCFG = MAPCFG; S.applyLevel = applyLevel;
  W.S9GFXP = S;

  // late arrival: if the map is already loaded, build now (menu), behind the existing screen
  try { if (typeof CUR_MAP !== 'undefined' && CUR_MAP && MAPROOT.children.length) { build(CUR_MAP); prewarm(); } } catch (e) { console.warn('[gfxplus] init build', e); }
  attachMuzzle(); S.ready = true;
})();
