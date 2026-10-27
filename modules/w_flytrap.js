/* Sector Nine add-on: FLYTRAP, an alien Venus-flytrap creature weapon (modules/w_flytrap.js)
   Left click  = BITE: the trap head launches on its stem (visible vine), chomps the first body it reaches (up to 14 m),
                 rips a chunk out of them and reels back. Head bites hit harder. A miss snaps shut on air and retracts.
   Right click = SPIT: an arcing poison glob (gravity), small splash, poison damage over time (stacks to 2), sizzling puddle.
   No reload (a saliva pool regenerates), no aim-down-sights, no aim assist. Always "alive": breathes, twitches, sniffs.
   Loads after index.html's main script (any order with the other add-ons); registers itself into the game's globals by
   wrapping them (every wrapper calls the original): fire, rifleTP, buildGunVM, poseBoomVM, updateBoom, netSend,
   netReceive, hurtPlayer, startDeathFx, updateDeathFx, clearDynamic, updateHud, arsenalHTML, composer.render.
   Numbers: data/w_flytrap.json (the same values are built in below as a fallback).
   Model: assets/models/weapons/flytrap/flytrap.js (glTF made in Blender by render/weapons/flytrap/flytrap.py). */
(function () {
  'use strict';
  if (window.FLYTRAP) return;
  const FT = window.FLYTRAP = { ver: 1, ready: false, model: false, dataSource: 'builtin', errors: 0, log: [], stats: { bites: 0, biteHits: 0, heads: 0, kills: 0, spits: 0, spitHits: 0, ticks: 0, netOut: 0, netIn: 0 }, perf: { n: 0, total: 0, max: 0 } };
  const warn = e => { FT.errors++; if (FT.errors < 6) console.warn('[flytrap]', e); };
  const V = () => new THREE.Vector3();

  /* ================= numbers (data/w_flytrap.json overrides these) ================= */
  const C = {
    weapon: { name: 'Flytrap', cls: 'Bio-weapon', desc: 'Alive and hungry. Left click: the head shoots out up to 14 m and rips a chunk out of whoever it bites. Right click: spits poison that keeps eating them.', stats: [90, 26, 32, 80], move: 1.03, glow: [1.35, 3.0, .45] },
    bite: { range: 14, speed: 110, retractSpeed: 34, cooldown: 1.1, body: 72, headMult: 1.36, jawRadius: .2, latchTime: .15, missSnapTime: .1, noiseRadius: 30 },
    spit: { pool: 100, cost: 25, regenPerSec: 14, regenDelay: .7, cooldown: .42, speed: 30, upBoost: 2.2, gravity: 13, directDamage: 16, splashDamage: 10, splashRadius: 2, puddleTime: 4, maxFlight: 3 },
    poison: { dps: 8, duration: 4, maxStacks: 2, tick: .5 },
    viewmodel: { scale: .64, hip: [.25, -.15, -.47], rot: [.08, .36, -.09], open: .3 },
    thirdPerson: { scale: 1.1, back: .24 },   // back = how far the model is pulled back through the hand (the hand holds the body, not the very rear end)
  };
  FT.C = C;
  function applyData(j) {
    for (const k of Object.keys(C)) if (j && j[k] && typeof j[k] === 'object') Object.assign(C[k], j[k]);
    defineWeapon();
  }
  try { fetch('data/w_flytrap.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : null).then(j => { if (j) { applyData(j); FT.dataSource = 'json'; } }).catch(() => {}); } catch (e) {}

  /* ================= weapon registration ================= */
  function defineWeapon() {
    const w = WEAPONS.flytrap || (WEAPONS.flytrap = {});
    Object.assign(w, { name: C.weapon.name, cls: C.weapon.cls, mode: 'flytrap', infinite: true, mag: Math.round(C.spit.pool / C.spit.cost), reserve: 0, maxReserve: 0,
      rpm: 60 / C.bite.cooldown, auto: true, dmg: C.bite.body, head: C.bite.headMult, hip: 0, ads: 0, adsFov: 78, adsSpeed: 10, reload: 1, reloadEmpty: 1, kick: 1.2,
      move: C.weapon.move, glow: C.weapon.glow, sound: 'ftWhip', tracer: [1.2, 3, .4], stats: C.weapon.stats, desc: C.weapon.desc, range: C.bite.range, noAds: true });
    w.label = w.name + ' · ' + w.cls.toLowerCase();
  }
  defineWeapon();
  if (!GUN_IDS.includes('flytrap')) GUN_IDS.push('flytrap');
  for (const id of ['flytrap', 'ftspit', 'ftpoison']) if (!NET_W.includes(id)) NET_W.push(id);   // same order on every client
  Object.assign(ICON, {
    flytrap: '<svg viewBox="0 0 40 16" width="34" height="13"><path d="M2 9c4-6 13-8 21-5l3-3 1 4c5 1 9 3 11 5-6 0-9 1-12 3l1 3-4-2c-8 3-16 1-21-5z" fill="currentColor"/><path d="M14 6l1 3 1-3 1 3 1-3 1 3 1-3 1 3" stroke="#000" stroke-width=".9" fill="none"/></svg>',
    ftspit: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M8 1c3 5 5 7 5 9a5 5 0 01-10 0c0-2 2-4 5-9z" fill="currentColor"/><circle cx="6" cy="10" r="1.3" fill="#000"/></svg>',
    ftpoison: '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="6" cy="7" r="1.5" fill="currentColor"/><circle cx="10.5" cy="9.5" r="1.1" fill="currentColor"/></svg>',
  });
  Object.assign(DEATH_OF, { flytrap: 'rip', ftspit: 'melt', ftpoison: 'melt' });
  Object.assign(KB_TITLE, { rip: 'Devoured', melt: 'Dissolved' });
  // a saved loadout with the Flytrap in it was rejected before this module registered the gun: restore it
  try { const l = JSON.parse(localStorage.getItem('sector9-loadout') || 'null');
    if (Array.isArray(l) && l.length === 2 && l.includes('flytrap') && l.every(x => GUN_IDS.includes(x)) && l[0] !== l[1]) { LOADOUT[0] = l[0]; LOADOUT[1] = l[1]; } } catch (e) {}

  /* ================= small helpers ================= */
  const R3 = x => Math.round(x * 1000) / 1000;
  const ez = x => x * x * (3 - 2 * x);
  const inScene = o => { let p = o; while (p.parent) p = p.parent; return p === scene; };
  const GLOWC = () => new THREE.Color(...C.weapon.glow);
  const _a = V(), _b = V(), _c = V(), _d = V(), _e = V(), _q = V(), _m4 = new THREE.Matrix4();

  /* ================= materials ================= */
  let FLESH_N = null;
  function fleshNormal() {   // procedural wet-skin normal map: soft cells + pores (made once, 256 px, tiling)
    if (FLESH_N) return FLESH_N;
    const N = 256, h = new Float32Array(N * N), pts = [];
    for (let i = 0; i < 46; i++) pts.push([Math.random() * N, Math.random() * N]);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      let d1 = 1e9, d2 = 1e9; for (const [px, py] of pts) { let dx = Math.abs(x - px), dy = Math.abs(y - py); dx = Math.min(dx, N - dx); dy = Math.min(dy, N - dy); const d = dx * dx + dy * dy; if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d; }
      const cell = Math.sqrt(d2) - Math.sqrt(d1);
      h[y * N + x] = Math.min(1, cell / 9) * .8 + .2 * Math.sin(x * .9 + Math.sin(y * .31) * 3) * Math.sin(y * .7 + Math.sin(x * .23) * 2) * .5;
    }
    const cv = document.createElement('canvas'); cv.width = cv.height = N; const cx = cv.getContext('2d'), im = cx.createImageData(N, N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const hx = h[y * N + (x + 1) % N] - h[y * N + (x + N - 1) % N], hy = h[((y + 1) % N) * N + x] - h[((y + N - 1) % N) * N + x];
      let nx = -hx * 2.2, ny = -hy * 2.2, nz = 1; const L = Math.hypot(nx, ny, nz); nx /= L; ny /= L; nz /= L;
      const i = (y * N + x) * 4; im.data[i] = (nx * .5 + .5) * 255; im.data[i + 1] = (ny * .5 + .5) * 255; im.data[i + 2] = (nz * .5 + .5) * 255; im.data[i + 3] = 255;
    }
    cx.putImageData(im, 0, 0);
    FLESH_N = new THREE.CanvasTexture(cv); FLESH_N.wrapS = FLESH_N.wrapT = THREE.RepeatWrapping; FLESH_N.repeat.set(6, 6);
    return FLESH_N;
  }
  const U = { time: { value: 0 }, pulse: { value: 1 }, flare: { value: 0 } };   // shared shader uniforms (cilia sway, vein pulse)
  function ciliaMat(phys) {   // dark root -> glowing tip (uv.y), tips sway like feelers
    const tipK = phys ? 1 : .35;
    const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(.06, .014, .012), roughness: .35, metalness: 0, emissive: new THREE.Color(0, 0, 0) });
    m.onBeforeCompile = sh => {
      sh.uniforms.uTime = U.time; sh.uniforms.uPulse = U.pulse; sh.uniforms.uFlare = U.flare; sh.uniforms.uGlow = { value: GLOWC() };
      sh.vertexShader = 'uniform float uTime; uniform float uFlare; varying float vTip;\n' + sh.vertexShader.replace('#include <begin_vertex>',
        '#include <begin_vertex>\n vTip = uv.y; float w = uv.y * uv.y; transformed += normalize(vec3(position.x, 0.0001, position.z)) * w * (0.004 * sin(uTime * 5.3 + position.x * 90.0 + position.z * 60.0) + uFlare * 0.012) + vec3(0.0, w * 0.003 * sin(uTime * 3.7 + position.z * 120.0), 0.0);');
      sh.fragmentShader = 'uniform vec3 uGlow; uniform float uPulse; varying float vTip;\n' + sh.fragmentShader.replace('#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n totalEmissiveRadiance += uGlow * smoothstep(0.55, 1.0, vTip) * (0.9 + 0.6 * uPulse) * ' + tipK.toFixed(2) + ';');
    };
    m.customProgramCacheKey = () => 'ftCilia' + tipK;
    return m;
  }
  function veinMat(k = 1) { return new THREE.MeshBasicMaterial({ color: GLOWC().multiplyScalar(.85 * k), toneMapped: true }); }
  function buildMats(fp) {
    const S = THREE.MeshStandardMaterial, n = fleshNormal(), env = fp ? .6 : .7;   // (no clearcoat: the viewmodel covers a lot of screen; standard shading keeps frames cheap)
    const flesh = new S(Object.assign({ vertexColors: true, roughness: .4, metalness: 0, normalMap: n, normalScale: new THREE.Vector2(.55, .55), envMapIntensity: env }));
    const inner = new S(Object.assign({ vertexColors: true, color: new THREE.Color(.62, .55, .58), roughness: .26, metalness: 0, normalMap: n, normalScale: new THREE.Vector2(.8, .8), emissive: new THREE.Color(.05, 0, .015), envMapIntensity: env }));
    const leaf = new S(Object.assign({ vertexColors: true, roughness: .45, metalness: 0, side: THREE.DoubleSide, normalMap: n, normalScale: new THREE.Vector2(.4, .4), envMapIntensity: env }));
    // world / third person: the scene's lights are far dimmer than the first-person gun lights, so the dark skin is lifted
    // (colour x3, a faint living glow) and the mouth glows pink; no fine normal map (it shimmers at range)
    if (!fp) { flesh.color.setScalar(3.2); flesh.emissive = new THREE.Color(.05, .13, .05); leaf.color.setScalar(3); leaf.emissive = new THREE.Color(.03, .08, .03);
      inner.color.setRGB(2.4, 2.1, 2.2); inner.emissive = new THREE.Color(.35, .02, .12); flesh.normalMap = null; inner.normalMap = null; leaf.normalMap = null; flesh.roughness = .45; }
    return {
      ft_flesh: flesh, ft_inner: inner, ft_leaf: leaf,
      ft_vein: veinMat(), ft_cilia: ciliaMat(fp),
      ft_tooth: new THREE.MeshStandardMaterial({ color: new THREE.Color(.5, .43, .3), roughness: .38, metalness: 0, envMapIntensity: env }),
      ft_eye: new THREE.MeshStandardMaterial({ color: new THREE.Color(.5, .2, .01), roughness: .08, emissive: new THREE.Color(1.6, .7, .06), envMapIntensity: 1 }),
      ft_metal: kitMat('s9_dark', !fp), ft_steel: kitMat('s9_steel', !fp), ft_rubber: kitMat('s9_rubber', !fp), ft_glass: kitMat('s9_glass', !fp),
      ft_fluid: new THREE.MeshBasicMaterial({ color: GLOWC().multiplyScalar(.7) }), ft_glow: new THREE.MeshBasicMaterial({ color: GLOWC() }), ft_meter: new THREE.MeshBasicMaterial({ color: GLOWC().multiplyScalar(1.3) }),
    };
  }
  let MAT_FP = null, MAT_TP = null;

  /* ================= live tube (stem / vine) ================= */
  // one mesh whose vertices are rewritten each frame along a curve: rings x (segments + 1) with a seam column for uvs
  class Tube {
    constructor(nr, ns, mat) {
      this.nr = nr; this.ns = ns; const nv = nr * (ns + 1);
      this.pos = new Float32Array(nv * 3); this.nor = new Float32Array(nv * 3); this.uv = new Float32Array(nv * 2); const idx = [];
      for (let i = 0; i < nr - 1; i++) for (let k = 0; k < ns; k++) { const a = i * (ns + 1) + k, b = a + 1, d = a + ns + 1, c = d + 1; idx.push(a, b, d, b, c, d); }
      const g = new THREE.BufferGeometry(); g.setIndex(idx);
      const A = (n, arr, s) => { const at = new THREE.BufferAttribute(arr, s); at.setUsage(THREE.DynamicDrawUsage); g.setAttribute(n, at); return at; };
      this.aP = A('position', this.pos, 3); this.aN = A('normal', this.nor, 3); this.aU = A('uv', this.uv, 2);
      g.boundingSphere = new THREE.Sphere(V(), 1e4);
      this.mesh = new THREE.Mesh(g, mat); this.mesh.frustumCulled = false; this.mesh.castShadow = false;
      this.pts = Array.from({ length: nr }, V); this._t = V(); this._n = V(); this._bn = V(); this._p = V();
    }
    // curve(t, out) -> point, rad(t) -> radius
    update(curve, rad, ref) {
      const { nr, ns, pts, pos, nor, uv } = this, t = this._t, n = this._n, bn = this._bn;
      for (let i = 0; i < nr; i++) curve(i / (nr - 1), pts[i]);
      let len = 0;
      n.copy(ref || UPV);
      for (let i = 0; i < nr; i++) {
        const p = pts[i], p0 = pts[Math.max(0, i - 1)], p1 = pts[Math.min(nr - 1, i + 1)];
        t.subVectors(p1, p0); if (t.lengthSq() < 1e-12) t.set(0, 0, -1); t.normalize();
        if (i > 0) len += p.distanceTo(p0);
        n.addScaledVector(t, -n.dot(t)); if (n.lengthSq() < 1e-8) n.set(1, 0, 0).addScaledVector(t, -t.x); n.normalize(); bn.crossVectors(t, n);
        const r = rad(i / (nr - 1));
        for (let k = 0; k <= ns; k++) {
          const a = k / ns * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a), j = (i * (ns + 1) + k);
          const nx = n.x * ca + bn.x * sa, ny = n.y * ca + bn.y * sa, nz = n.z * ca + bn.z * sa;
          pos[j * 3] = p.x + nx * r; pos[j * 3 + 1] = p.y + ny * r; pos[j * 3 + 2] = p.z + nz * r;
          nor[j * 3] = nx; nor[j * 3 + 1] = ny; nor[j * 3 + 2] = nz; uv[j * 2] = k / ns; uv[j * 2 + 1] = len;
        }
      }
      this.aP.needsUpdate = this.aN.needsUpdate = this.aU.needsUpdate = true; this.len = len;
    }
  }
  let TUBE_N = null;
  function vineMat() {   // the stretched vine: solid, smooth fleshy skin (no fine bumps that sparkle at range) with a glowing vein band
    const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(.04, .12, .05), roughness: .35, metalness: 0, emissive: new THREE.Color(.015, .045, .012), envMapIntensity: .7 });
    m.onBeforeCompile = sh => {
      sh.uniforms.uGlow = { value: GLOWC() }; sh.uniforms.uTime = U.time; sh.uniforms.uPulse = U.pulse;
      sh.vertexShader = 'varying vec2 vUvV;\n' + sh.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\n vUvV = uv;');
      sh.fragmentShader = 'uniform vec3 uGlow; uniform float uTime; uniform float uPulse; varying vec2 vUvV;\n' + sh.fragmentShader.replace('#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         float sp = fract(vUvV.y * 2.2 - vUvV.x - uTime * 1.4);
         float band = smoothstep(0.0, 0.08, sp) * (1.0 - smoothstep(0.16, 0.3, sp));
         float mott = 0.5 + 0.5 * sin(vUvV.y * 17.0 + vUvV.x * 12.6);
         diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.09, 0.015, 0.08), mott * 0.5);
         totalEmissiveRadiance += uGlow * band * (0.5 + 0.4 * uPulse);`);
    };
    m.customProgramCacheKey = () => 'ftVine'; return m;
  }
  function stemMat(fp) {   // fleshy stem with a glowing spiral vein that travels along it (uv.y is metres along the stem)
    if (!TUBE_N) { TUBE_N = fleshNormal().clone(); TUBE_N.needsUpdate = true; TUBE_N.repeat.set(1, 3); }
    const m = new THREE.MeshStandardMaterial(Object.assign({ color: new THREE.Color(.03, .1, .045), roughness: .38, metalness: 0, normalMap: TUBE_N, normalScale: new THREE.Vector2(.35, .35), envMapIntensity: .6 }));
    m.onBeforeCompile = sh => {
      sh.uniforms.uGlow = { value: GLOWC() }; sh.uniforms.uTime = U.time; sh.uniforms.uPulse = U.pulse;
      sh.fragmentShader = 'uniform vec3 uGlow; uniform float uTime; uniform float uPulse;\n' + sh.fragmentShader.replace('#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         float sp = fract(vUv.y * 9.0 - vUv.x * 2.0 - uTime * 0.6);
         float band = smoothstep(0.0, 0.06, sp) * (1.0 - smoothstep(0.08, 0.16, sp));
         float mott = 0.5 + 0.5 * sin(vUv.y * 61.0 + vUv.x * 19.0) * sin(vUv.y * 23.0 - vUv.x * 7.0);
         diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.07, 0.01, 0.065), mott * 0.55);
         totalEmissiveRadiance += uGlow * band * (0.45 + 0.35 * uPulse);`);
    };
    m.customProgramCacheKey = () => 'ftStem' + (fp ? 1 : 0);
    return m;
  }

  /* ================= model ================= */
  let MODEL = null;       // { full: gltf scene, lod: gltf scene, meta }
  const VMS = [];          // first-person rigs waiting for the model
  const TPS = new Set();   // third-person rigs (other players, drops, killcam ghosts)
  function loadModel() {
    const done = (A) => {
      const L = new THREE.GLTFLoader();
      Promise.all([A.full, A.lod].map(j => new Promise((res, rej) => L.parse(JSON.stringify(j), '', g => res(g), rej))))
        .then(([f, l]) => { MODEL = { full: f.scene, lod: l.scene, meta: A.meta }; FT.model = true; for (const v of VMS.splice(0)) fillVM(v); for (const t of TPS) if (!t.filled) fillTP(t); window.S9A && (window.S9A.flytrap = null); warm(); })
        .catch(warn);
    };
    if (window.S9A && window.S9A.flytrap) return done(window.S9A.flytrap);
    const s = document.createElement('script'); s.src = 'assets/models/weapons/flytrap/flytrap.js';
    s.onload = () => { if (window.S9A && window.S9A.flytrap) done(window.S9A.flytrap); else warn('model script had no data'); };
    s.onerror = () => warn('model failed to load'); document.head.appendChild(s);
  }
  function skin(root, M) {   // swap the exported materials for the game's, by name
    root.traverse(o => { if (!o.isMesh) return; const n = o.material && o.material.name; if (M[n]) o.material = M[n]; o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; });
  }
  function rig(root) {
    const by = n => root.getObjectByName(n);
    const R = { root, head: by('ft_head'), jawU: by('ft_jawU'), jawL: by('ft_jawL'), bulb: by('ft_bulb'), leafL: by('ft_leafL'), leafR: by('ft_leafR'), stem: by('ft_stem'), fluid: by('ft_fluid'), meter: by('ft_meter'), knot: by('ft_knot') };
    R.head0 = R.head.position.clone(); R.hinge = R.head.position.clone();
    return R;
  }
  const META = () => MODEL.meta;

  /* ----- first person ----- */
  function buildVM() {
    const g = new THREE.Group(); g.visible = false; gunScene.add(g);
    const S = C.viewmodel.scale; g.scale.setScalar(S);
    const inner = new THREE.Group(); g.add(inner);
    const glove = FT.glove || (FT.glove = new THREE.MeshStandardMaterial({ color: new THREE.Color(.075, .058, .036), roughness: .6, metalness: .05, normalMap: tex(T.armor.normal, false, 6, 6), normalScale: new THREE.Vector2(.5, .5), envMapIntensity: .5 })), sleeve = sleeveMat();
    const limb = (from, to, r, m, parent) => { const d = to.clone().sub(from), L = d.length(); const c = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(.001, L - r * 2), 4, 12), m); c.position.copy(from).addScaledVector(d, .5); c.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()); parent.add(c); return c; };
    const Vv = (x, y, z) => new THREE.Vector3(x, y, z);
    // right hand round the pistol grip (grip leans back 16 deg): palm on the right side, fingers round the front, thumb over the top
    const rh = new THREE.Group(); rh.position.set(0, -.078, .052); rh.rotation.x = THREE.MathUtils.degToRad(-16); inner.add(rh);   // hands live in the model space (with its pose) so they really hold it
    { const pm = new THREE.Mesh(rbox(.024, .078, .066, .012), glove); pm.position.set(.025, .004, .004); rh.add(pm);
      for (let k = 0; k < 4; k++) { const y = .026 - k * .02; limb(Vv(.026, y, -.026), Vv(-.016, y - .002, -.028), .0108, glove, rh); }
      { const pad = new THREE.Mesh(rbox(.016, .086, .036, .007), glove); pad.position.set(-.021, -.004, -.016); rh.add(pad); }   // fingertips round the grip: one gloved shape, not a row of beads
      limb(Vv(.02, .042, .02), Vv(-.012, .052, -.012), .0105, glove, rh);   // thumb
      limb(Vv(.03, -.03, .03), Vv(.065, -.1, .14), .036, glove, rh); limb(Vv(.06, -.09, .12), Vv(.13, -.31, .5), .039, sleeve, rh); limb(Vv(.08, -.19, .33), Vv(.21, -.48, .88), .052, sleeve, rh); }
    // left hand wraps the body from below on the rubber sleeve behind the collar: palm under it, four fingers curling up
    // the left flank (the side the player sees), thumb over the top-right
    const lh = new THREE.Group(); lh.position.set(0, 0, -.135); inner.add(lh);
    { const shell = new THREE.Mesh(new THREE.CylinderGeometry(.045, .045, .07, 22, 1, true, 3.98, 2.75).rotateX(Math.PI / 2), glove); shell.scale.set(.92, 1, 1); lh.add(shell);   // palm + fingers round the bottom and up the left flank
      for (let k = 0; k < 4; k++) { const z = -.026 + k * .0173, a = -2.3, x = Math.sin(a) * .045 * .92, y = -Math.cos(a) * .045; limb(Vv(x, y, z), Vv(x + .01, y + .006, z - .002), .0088, glove, lh); }   // fingertips curled over the top edge
      // finger separations: thin creases following the curl, so the shell reads as four fingers
      for (const zc of [-.0175, 0, .0175]) { let prev = null; for (let i = 0; i <= 5; i++) { const th = 3.98 + i / 5 * 2.6, p = Vv(Math.sin(th) * .0455 * .92, -Math.cos(th) * .0455, zc); if (prev) limb(prev, p, .0016, sleeve, lh); prev = p; } }
      { const ridge = new THREE.Mesh(new THREE.CylinderGeometry(.0055, .0055, .07, 8), glove); ridge.rotation.x = Math.PI / 2; ridge.position.set(-.0435, -.006, 0); lh.add(ridge); }   // knuckles
      limb(Vv(.02, -.04, .022), Vv(.034, -.012, -.004), .011, glove, lh); limb(Vv(.034, -.012, -.004), Vv(.028, .016, -.022), .0098, glove, lh);   // thumb
      limb(Vv(-.004, -.052, .03), Vv(-.05, -.12, .12), .035, glove, lh); limb(Vv(-.045, -.11, .1), Vv(-.2, -.34, .4), .038, sleeve, lh); limb(Vv(-.12, -.21, .25), Vv(-.4, -.6, .72), .05, sleeve, lh); }
    const hip = new THREE.Vector3(...C.viewmodel.hip);
    const vm = { group: g, inner, mag: new THREE.Group(), magPos: new THREE.Vector3(), leftArm: new THREE.Group(), rear: new THREE.Group(), flash: new THREE.Group(), reticle: new THREE.Group(),
      hip, adsPos: hip.clone(), hw: { fx: [], muzzle: null }, ft: true, glow: null };
    vm.flash.visible = false; g.add(vm.flash, vm.reticle); vm.reticle.visible = false;
    if (MODEL) fillVM(vm); else VMS.push(vm);
    return vm;
  }
  function fillVM(vm) {
    if (!MAT_FP) MAT_FP = buildMats(true);
    const root = MODEL.full.clone(true); skin(root, MAT_FP); vm.inner.add(root);
    vm.R = rig(root); vm.R.stem.visible = false;
    vm.stem = new Tube(22, 12, stemMat(true)); vm.inner.add(vm.stem.mesh);
    { const m = MODEL.meta, A0 = new THREE.Vector3(...m.stemA), B0 = vm.R.head0.clone().add(new THREE.Vector3(0, 0, .022)), C1 = A0.clone().add(new THREE.Vector3(0, .055, -.012)), C2 = B0.clone().add(new THREE.Vector3(0, .045, .055));
      vm.stem.update((u, o) => bez(o, A0, C1, C2, B0, u), u => .02 - .005 * u, new THREE.Vector3(1, 0, 0)); }   // rest pose right away (before the first frame it's held)
    vm.glow = MAT_FP.ft_vein;
    vm.filled = true;
  }

  /* ----- third person ----- */
  function buildTP() {
    const g = new THREE.Group(), s = C.thirdPerson.scale, inner = new THREE.Group();
    inner.rotation.y = Math.PI; inner.scale.setScalar(s); const bk = C.thirdPerson.back || 0; inner.position.set(0, .078 * s, (.052 - bk) * s); g.add(inner);   // hand on the grip at the origin, muzzle toward +z
    g.userData.muzzle = new THREE.Vector3(0, (.072 + .078) * s, (.65 + .052 - bk) * s);
    const t = { g, inner, filled: false, idle: Math.random() * 10, off: 0 }; g.userData.ft = t; TPS.add(t);
    if (MODEL) fillTP(t);
    return g;
  }
  function fillTP(t) {
    if (!MAT_TP) MAT_TP = buildMats(false);
    const root = MODEL.lod.clone(true); skin(root, MAT_TP); t.inner.add(root); t.R = rig(root); t.filled = true; t.g.userData.body = t.inner;
  }

  /* ----- a world-space head (what flies out on a bite) ----- */
  const HEADS = [];
  function worldHead() {
    let h = HEADS.find(x => !x.busy); if (h) { h.busy = true; return h; }
    if (!MODEL) return null;
    if (!MAT_TP) MAT_TP = buildMats(false);
    const src = MODEL.full.getObjectByName('ft_head'), g = new THREE.Group(), c = src.clone(true); c.position.set(0, 0, 0); skin(c, MAT_TP); g.add(c);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex(T.glow), color: GLOWC().multiplyScalar(.35), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: .45 })); halo.scale.setScalar(.32); halo.position.z = -.1; g.add(halo);
    const chunk = makeChunk(); chunk.visible = false; chunk.position.set(0, 0, -.11); g.add(chunk);
    h = { g, jawU: c.getObjectByName('ft_jawU'), jawL: c.getObjectByName('ft_jawL'), halo, chunk, busy: true, tube: new Tube(40, 10, vineMat()) };
    g.userData.noProbe = true; h.tube.mesh.userData.noProbe = true;   // not map geometry (bug report map check, other world probes)
    HEADS.push(h); return h;
  }
  function freeHead(h) { if (!h) return; h.busy = false; h.g.visible = false; h.tube.mesh.visible = false; h.chunk.visible = false; if (h.g.parent) h.g.parent.remove(h.g); if (h.tube.mesh.parent) h.tube.mesh.parent.remove(h.tube.mesh); }

  // the piece it rips out: a lump of raw, glistening meat with a torn plate of the victim's armour on it
  let CHUNK_GEO = null, PLATE_GEO = null;
  function makeChunk() {
    if (!CHUNK_GEO) {
      const geo = new THREE.IcosahedronGeometry(.075, 1), p = geo.attributes.position, col = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i), z = p.getZ(i), k = 1 + .45 * Math.sin(x * 61 + z * 37) * Math.sin(y * 43 - x * 17); p.setXYZ(i, x * k * 1.25, y * k * .8, z * k);
        const r = .35 + .3 * Math.random(); col.set([r, .02 + .03 * Math.random(), .05 + .04 * Math.random()], i * 3); }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3)); geo.computeVertexNormals(); CHUNK_GEO = geo;
      PLATE_GEO = new THREE.CylinderGeometry(.075, .065, .022, 7, 1); PLATE_GEO.rotateZ(.2);
    }
    const g = new THREE.Group();
    const meat = new THREE.Mesh(CHUNK_GEO, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .18, metalness: 0, emissive: new THREE.Color(.12, 0, .03) }));
    const plate = new THREE.Mesh(PLATE_GEO, new THREE.MeshStandardMaterial({ color: 0x777777, roughness: .45, metalness: .55 })); plate.position.set(.01, .05, .01); plate.rotation.set(.3, .4, .2);
    g.add(meat, plate); g.userData.plate = plate; return g;
  }

  /* ================= sounds (pre-rendered by the game's own synth, voice budget respected) ================= */
  Object.assign(GUN_VOICE, {
    // launch: a wet stem whip with a hungry snarl
    ftWhip: { dur: .45, verb: .25, echo: 0, vol: 1, fn: L => { L.noise(0, 'bp', 380, 2800, .07, 1.6, .16, .9, .004); L.tone(0, 140, 60, .04, .07, .8, 'sin', 2); L.noise(.012, 'lp', 900, 300, .05, 1.2, .1, .5); L.tone(.01, 320, 210, .05, .09, .25, 'saw', 2.2); L.crackle(.02, 600, .08, .25, .12); } },
    // the bite: hard jaw clack + wet crunch + thud
    ftChomp: { dur: .5, verb: .3, echo: .1, vol: 1.15, fn: L => { L.noise(0, 'hp', 5200, 2600, .006, .8, .008, 1); L.tone(0, 1900, 900, .01, .012, .5, 'sq'); L.crackle(.004, 5200, .06, .9, .14); L.noise(.003, 'bp', 900, 260, .05, 1.1, .09, .9); L.tone(.002, 120, 42, .04, .1, 1.1, 'sin', 2.5); L.noise(.05, 'lp', 700, 200, .1, 1, .14, .45); } },
    // rip: tearing flesh/armour, falling squelch
    ftRip: { dur: .6, verb: .3, echo: .1, vol: 1, fn: L => { L.noise(0, 'bp', 2400, 500, .2, 2.2, .22, .8, .01); L.crackle(0, 2600, .2, .7, .3); L.noise(.08, 'lp', 800, 160, .2, 1.4, .2, .55); L.tone(.05, 260, 90, .2, .15, .35, 'fm'); } },
    // a miss: jaws snap shut on air
    ftSnap: { dur: .35, verb: .3, echo: .05, vol: .9, fn: L => { L.noise(0, 'hp', 4800, 3000, .004, .9, .006, .9); L.tone(0, 2400, 1400, .006, .01, .45, 'tri'); L.noise(.06, 'hp', 4600, 2800, .004, .9, .005, .6); L.tone(.06, 2100, 1300, .006, .008, .3, 'tri'); L.noise(0, 'bp', 700, 1600, .1, 1, .08, .25); } },
    // reeling back in
    ftRetract: { dur: .4, verb: .15, echo: 0, vol: .7, fn: L => { L.noise(0, 'bp', 2200, 500, .18, 2, .22, .55, .02); L.tone(0, 420, 180, .15, .14, .18, 'fm'); } },
    // swallowing the chunk
    ftGulp: { dur: .55, verb: .2, echo: 0, vol: .95, fn: L => { L.tone(0, 230, 85, .09, .16, .9, 'fm', 1.5); L.noise(0, 'lp', 500, 150, .1, 2, .12, .5); for (let k = 0; k < 5; k++) L.tone(.12 + k * .055, 300 + k * 70, 520 + k * 60, .02, .03, .18, 'sin'); } },
    // spit: throaty hock then a "ptoo"
    ftSpit: { dur: .55, verb: .25, echo: .05, vol: 1, fn: L => { L.noise(0, 'bp', 300, 900, .08, 2.2, .1, .55, .02); L.tone(0, 110, 160, .08, .09, .35, 'saw', 1.8); L.noise(.1, 'bp', 1700, 800, .04, 1.4, .06, 1); L.tone(.1, 520, 180, .03, .05, .5, 'sin', 2); L.crackle(.1, 3000, .05, .45, .1); } },
    // the glob landing: wet splat + start of a sizzle
    ftSplat: { dur: .9, verb: .35, echo: .1, vol: 1, fn: L => { L.noise(0, 'lp', 1300, 200, .06, 1, .08, 1); L.tone(0, 160, 55, .04, .08, .8, 'sin', 2); L.crackle(.005, 3600, .12, .7, .25); L.noise(.04, 'hp', 6000, 7000, .3, .7, .45, .35, .05); L.crackle(.06, 1800, .4, .3, .8); } },
    ftSizzle: { dur: .8, verb: .1, echo: 0, vol: .5, fn: L => { L.noise(0, 'hp', 5500, 7500, .5, .7, .5, .5, .1); L.crackle(0, 1400, .5, .45, .8); } },
    // kill: a happy alien trill
    ftChirp: { dur: .55, verb: .4, echo: .15, vol: .8, fn: L => { for (let k = 0; k < 4; k++) L.tone(k * .07, 1300 + k * 240, 2300 + k * 280, .035, .05, .45 - k * .05, 'fm'); L.tone(.3, 2800, 1900, .06, .1, .3, 'sin'); } },
    // idle: gurgle and sniff (quiet, rare)
    ftGurgle: { dur: .8, verb: .15, echo: 0, vol: .35, fn: L => { for (let k = 0; k < 6; k++) L.tone(k * .09 + Math.random() * .03, 140 + Math.random() * 90, 220 + Math.random() * 140, .03, .06, .5, 'sin'); L.noise(0, 'lp', 400, 200, .3, 2, .35, .25, .05); } },
    ftSniff: { dur: .45, verb: .1, echo: 0, vol: .35, fn: L => { L.noise(0, 'bp', 2400, 1600, .05, 3, .05, .7, .02); L.noise(.14, 'bp', 2600, 1800, .05, 3, .06, .8, .02); } },
    // poison tick on someone (fizz)
    ftTick: { dur: .3, verb: .05, echo: 0, vol: .45, fn: L => { L.noise(0, 'hp', 6500, 5000, .1, .7, .1, .6, .005); L.crackle(0, 2200, .1, .4, .15); } },
  });
  const VOICE_COST = { ftGurgle: 1, ftSniff: 1, ftTick: 1, ftSizzle: 1 };
  // own budget on top of the game's: background sounds (ticks, sizzles, reel-in, idle) give way when the weapon is busy
  const LOW = { ftTick: 1, ftSizzle: 1, ftRetract: 1, ftGurgle: 1, ftSniff: 1 }, recent = [];
  function snd(name, pos, vol = 1) {
    try { if (!AU.ctx) return false;
      const now = performance.now(); while (recent.length && now - recent[0] > 1000) recent.shift();
      if (recent.length >= (LOW[name] ? 5 : 10)) return false; recent.push(now); if (pos && !voice('misc', pos)) return false; if (!pos && VOICE_COST[name] && !voice('misc', null)) return false; return gunVoice(name, pos || null, vol); } catch (e) { warn(e); return false; }
  }
  function warm() { try { if (typeof warmGunVoices === 'function' && AU.ctx) warmGunVoices(); } catch (e) {} warmShaders(); }
  function warmShaders() {   // compile the Flytrap materials up front (first use on Windows can stall)
    try { if (!MODEL || !renderer) return; const vm = WM.flytrap, vis = vm && vm.group.visible; if (vm) vm.group.visible = true;
      const prev = renderer.getRenderTarget(); renderer.setRenderTarget(rt); renderer.compile(gunScene, gunCam);
      const h = worldHead(); if (h) { h.g.position.set(0, -200, 0); scene.add(h.g); scene.add(h.tube.mesh); h.tube.update((t, o) => o.set(t, -200, 0), () => .02); renderer.compile(scene, camera); freeHead(h); }
      const gb = makeGlob(); gb.m.position.set(0, -200, 0); scene.add(gb.m); renderer.compile(scene, camera); scene.remove(gb.m); GLOBS_FREE.push(gb);
      // every other material the weapon can put in the world mid-match: third-person rig, ripped chunk + plate, wound, puddle, halo
      const tmp = [], put = o => { o.position.set(0, -200, 0); o.frustumCulled = false; scene.add(o); tmp.push(o); return o; };
      put(buildTP());
      const ch = makeChunk(); put(ch);
      if (!PUD_GEO) PUD_GEO = new THREE.CircleGeometry(.85, 32); if (!WOUND_GEO) WOUND_GEO = new THREE.SphereGeometry(.11, 14, 10);
      put(new THREE.Mesh(PUD_GEO, new THREE.MeshBasicMaterial({ map: tex(T.glow), color: new THREE.Color(.55, 1.4, .15), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 })));
      put(new THREE.Mesh(PUD_GEO, new THREE.MeshBasicMaterial({ map: tex(T.glow), color: GLOWC().multiplyScalar(.45), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -5 })));
      put(new THREE.Mesh(WOUND_GEO, new THREE.MeshStandardMaterial({ color: new THREE.Color(.12, .005, .02), roughness: .15, emissive: new THREE.Color(.05, 0, .01) })));
      put(new THREE.Mesh(new THREE.TorusGeometry(.1, .016, 6, 18), new THREE.MeshBasicMaterial({ color: GLOWC().multiplyScalar(.7) })));
      put(new THREE.Sprite(new THREE.SpriteMaterial({ map: tex(T.glow), color: GLOWC().multiplyScalar(.35), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: .45 })));
      renderer.compile(scene, camera);
      for (const o of tmp) { scene.remove(o); if (o.userData && o.userData.ft) TPS.delete(o.userData.ft); }
      renderer.setRenderTarget(prev); if (vm) vm.group.visible = vis; FT.warmed = true;
    } catch (e) { warn(e); }
  }

  /* ================= state ================= */
  const S = FT.S = { saliva: C.spit.pool, regenT: 0, spitCd: 0, spitHeld: false, prey: false, preyT: 0, preyD: 99, bite: null, kills: 0,
    vm: { breath: 0, twitchT: 2, twitch: 0, twitchDur: .2, twitchAmp: 0, lookT: 6, look: 0, lookDur: 1, lookYaw: 0, lookPitch: 0, eager: 0, shiver: 0, spitT: 0, recoil: 0, chew: 0, gurgleT: 5 } };
  const BITES = [];   // every bite in the world: yours (live), other players' (visual), killcam replays
  const GLOBS = [], GLOBS_FREE = [];
  const POISON = new Map();   // entity -> { stacks: [{ t, by }], tickT, fxT, vis }
  const PUDDLES = [];
  let seqBase = Date.now(), seqN = 0; const NETQ = []; FT.netQ = NETQ;
  function netEvent(arr) { if (!NET.on) return; NETQ.push([seqBase + (++seqN)].concat(arr)); NETQ._t = NETQ._t || []; NETQ._t.push(G.time); while (NETQ.length > 8) { NETQ.shift(); NETQ._t.shift(); } FT.stats.netOut++; }

  /* ================= the bite ================= */
  // swap point: where the first-person head sits on screen, pushed out to a world depth where it looks the same size
  const SWAP_D = 1.45, TETHER_D = .95;
  function vmScreen(local, out) {   // first-person model point -> normalised screen coords (via the gun camera)
    const vm = WM.flytrap; vm.group.updateMatrixWorld(true); gunCam.updateMatrixWorld();
    out.copy(local); vm.inner.localToWorld(out); out.applyMatrix4(gunCam.matrixWorldInverse); const d = -out.z; out.applyMatrix4(gunCam.projectionMatrix); out.z = d; return out;
  }
  function screenToWorld(ndc, depth, out) {   // a point on the main camera's view ray through ndc, depth metres in front
    const th = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    out.set(ndc.x * th * camera.aspect * depth, ndc.y * th * depth, -depth); return out.applyMatrix4(camera.matrixWorld);
  }
  function screenToGun(ndc, depth, out) {   // ... and the gun camera's, into the first-person model's space
    const th = Math.tan(THREE.MathUtils.degToRad(gunCam.fov) / 2);
    out.set(ndc.x * th * gunCam.aspect * depth, ndc.y * th * depth, -depth).applyMatrix4(gunCam.matrixWorld); return WM.flytrap.inner.worldToLocal(out);
  }
  function apparentScale(depthGun, depthWorld) {   // world scale that matches a first-person object's on-screen size
    return C.viewmodel.scale * (depthWorld / Math.max(.05, depthGun)) * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / Math.tan(THREE.MathUtils.degToRad(gunCam.fov) / 2);
  }
  const FLY_SCALE = 3.3;   // the head grows a little in flight so it reads at range (the bite's hit radius matches the jaws: data jawRadius)

  // pick the first body along the bite path between two distances (head sphere first, then the torso capsule)
  function sweep(o, dir, d0, d1, owner) {
    const jr = C.bite.jawRadius, n = Math.max(1, Math.ceil((d1 - d0) / .1));
    for (let s = 1; s <= n; s++) {
      const d = d0 + (d1 - d0) * s / n; _q.copy(o).addScaledVector(dir, d);
      let best = null, head = false;
      for (const e of entities()) {
        if (e === owner || !entAlive(e)) continue;
        const eye = entEye(e, _a); if (_q.distanceTo(eye) < .26 + jr) { best = e; head = true; break; }
        const ch = entChest(e, _b), base = entPos(e).y; if (Math.hypot(_q.x - ch.x, _q.z - ch.z) < .42 + jr && _q.y > base + .1 && _q.y < eye.y + .12) {
          // the jaws reach the torso first, but if the bite line runs through the head, it's a head bite (you aimed there)
          const t = _c.subVectors(eye, o).dot(dir); head = t > 0 && _d.copy(o).addScaledVector(dir, t).distanceTo(eye) < .2; best = e; break; }
      }
      if (best) return { e: best, head, d, p: _q.clone() };
    }
    return null;
  }
  function wallDist(o, dir, far) {
    ray.set(o, dir); ray.far = far; const h = shotHits(world.meshes, false)[0]; ray.far = Infinity;
    return h ? { d: h.distance, n: h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : dir.clone().negate(), p: h.point.clone() } : null;
  }

  class Bite {
    constructor(kind, o, dir, opt = {}) {
      this.kind = kind;            // 'me' (live, yours) | 'tp' (another player, visual) | 'kc' (killcam replay, first person, visual)
      this.o = o.clone(); this.dir = dir.clone().normalize(); this.owner = opt.owner || null; this.r = opt.r || null;
      this.stop = opt.stop != null ? opt.stop : C.bite.range; this.wall = opt.wall || null;
      this.D = 0; this.phase = 'out'; this.t = 0; this.age = 0; this.result = opt.result || null; this.kill = false; this.latchE = null; this.latchOff = V(); this.pos = V(); this.scale = 1;
      this.head = worldHead(); if (!this.head) { this.phase = 'done'; return; }
      this.head.g.visible = true; scene.add(this.head.g); scene.add(this.head.tube.mesh); this.head.tube.mesh.visible = true; this.head.chunk.visible = false;
      this.jawU = .2; this.jawL = -.17; this.shake = 0; this.start = V(); this.backFrom = V();
      if (kind === 'tp' && this.r) { const tp = tpOf(this.r); this.tp = tp; if (tp && tp.R) { tp.R.head.visible = false; tp.R.head.getWorldPosition(this.start); } else entEye(this.r, this.start); this.scale = .7; }
      this.pos.copy(kind === 'tp' ? this.start : this.o);
      BITES.push(this);
    }
    front(out) { return out.copy(this.o).addScaledVector(this.dir, this.D); }
    latch(e, p, head, kill) {
      this.phase = 'latch'; this.t = 0; this.latchE = e; this.kill = !!kill; this.crit = head; this.pos.copy(p);
      if (e) { this.latchOff.subVectors(p, entChest(e, _a)); const dh = _b.set(this.dir.x, 0, this.dir.z).normalize(), along = -this.latchOff.dot(dh); if (along < .62) this.latchOff.addScaledVector(dh, -(.62 - along)); }
      else if (this.kind !== 'tp') { const dh = _b.set(this.dir.x, 0, this.dir.z).normalize(); p = p.clone().addScaledVector(dh, -.35); }
      this.pos.copy(e ? entChest(e, _a).add(this.latchOff) : p); this.shake = 1;
      chompFx(p, this.dir, true, kill, head, e);
      // every body bite tears a piece off (a bigger one on the kill): meat + a plate in the victim's colour
      const ch = this.head.chunk; ch.visible = true; ch.scale.setScalar(kill ? 1.25 : .8); const col = e && e.color ? e.color : null; ch.userData.plate.material.color.copy(col ? new THREE.Color(col.r * .6 + .05, col.g * .6 + .05, col.b * .6 + .05) : new THREE.Color(.3, .3, .32));
    }
    snap(p, wall) { this.phase = 'snap'; this.t = 0; this.pos.copy(p); snd('ftSnap', p.clone()); if (wall) { decal(wall.p.clone(), wall.n, .9, 'scorch', [.5, 2.2, .25]); gooBurst(wall.p, wall.n, 10, false); snd('ftChomp', wall.p.clone(), .5); } }
    retract() { this.phase = 'back'; this.t = 0; this.backFrom.copy(this.pos); this.T = clamp(this.pos.distanceTo(this.anchor(_e)) / C.bite.retractSpeed, .266, .5); snd('ftRetract', this.kind === 'me' || this.kind === 'kc' ? null : this.pos.clone(), .8); }
    anchor(out) {   // where the head goes home to
      if (this.kind === 'tp') { const tp = this.tp; if (tp && tp.R && inScene(tp.g)) return tp.R.head.getWorldPosition(out); return entEye(this.r, out); }
      return out.copy(this.swap || this.o);
    }
    update(dt) {
      this.age += dt; this.t += dt; const B = C.bite;
      if (this.phase === 'out') {
        const d0 = this.D; this.D = Math.min(this.stop, this.D + B.speed * dt);
        if (this.kind === 'me') {
          const hit = sweep(this.o, this.dir, Math.max(.3, d0), Math.max(.3, this.D), PLAYER_ENT);
          if (hit) { this.D = hit.d; biteHit(this, hit); }
          else if (this.D >= this.stop) { this.snap(this.front(_c), this.wall); biteResult(this, null); }
        } else if (this.result) {
          const rd = this.result.p.distanceTo(this.o);
          if (this.D >= rd || this.age > 1.2) { this.D = Math.min(this.D, rd); if (this.result.kind >= 2) this.latch(this.result.e || null, this.result.p, this.result.kind === 3, this.result.kill); else this.snap(this.result.p, this.result.kind === 1 ? { p: this.result.p, n: this.dir.clone().negate() } : null); }
        } else if (this.D >= this.stop || this.age > 1.2) this.snap(this.front(_c), null);
        // the head leaves the gun on the swap point and converges onto the true bite line within a few metres
        const k = ez(clamp((this.D - .2) / 3, 0, 1)); this.front(_c);
        if (this.phase === 'out') this.pos.copy(this.kind === 'tp' ? _d.copy(this.start).lerp(_c, k) : _d.copy(this.anchor(_e)).lerp(_c, k));
        this.jawU = lerp(this.jawU, .95, 1 - Math.exp(-dt * 30)); this.jawL = lerp(this.jawL, -.8, 1 - Math.exp(-dt * 30));
      } else if (this.phase === 'latch') {   // jaws clamp, shake to tear, then yank back
        if (this.latchE && entAlive(this.latchE) || (this.latchE && !this.kill)) { entChest(this.latchE, _a); this.pos.copy(_a).add(this.latchOff); }
        const c = this.t / B.latchTime; this.jawU = c < .3 ? lerp(.9, -.05, ez(c / .3)) : -.04 + Math.sin(this.t * 60) * .03; this.jawL = -this.jawU * .9;
        this.shake = 1 - c;
        if (this.kind === 'me' && this.latchE && !this.latchE.isPlayer && !this.latchE.remote && !this.latchE.dead && c > .35) { const p = this.latchE.root.position, k = dt * 2.2; p.x -= this.dir.x * k; p.z -= this.dir.z * k; }
        if (this.t >= B.latchTime) { ripFx(this.pos, this.dir, this.kill, this.latchE); this.retract(); }
      } else if (this.phase === 'snap') {
        const c = this.t / B.missSnapTime; this.jawU = lerp(.95, -.03, ez(clamp(c * 1.6, 0, 1))); this.jawL = -this.jawU * .9;
        if (this.t >= B.missSnapTime) this.retract();
      } else if (this.phase === 'back') {
        const k = clamp(this.t / this.T, 0, 1), e = k * k * (3 - 2 * k), a = this.anchor(_e);
        this.pos.copy(this.backFrom).lerp(a, e); this.pos.y += Math.sin(Math.PI * k) * Math.min(.6, this.backFrom.distanceTo(a) * .05);
        this.jawU = lerp(this.jawU, this.kill ? .06 : .12, 1 - Math.exp(-dt * 10)); this.jawL = -this.jawU * .9;
        if (k >= 1) this.finish();
      }
    }
    finish() {
      this.phase = 'done'; freeHead(this.head);
      if (this.tp && this.tp.R) this.tp.R.head.visible = true;
      if (this.kind === 'me') { S.vm.recoil = 1; if (this.kill) { S.vm.chew = 1; S.vm.shiver = 1; setTimeout(() => { snd('ftGulp'); setTimeout(() => snd('ftChirp'), 260); }, 120); } }
      if (this.kind === 'kc') KCV.recoil = 1;
    }
    // final placement right before the frame is drawn (the camera is final here: live view or the killcam's)
    pose() {
      const h = this.head; if (!h || this.phase === 'done') return;
      const fp = this.kind !== 'tp';
      if (fp) {   // anchor = swap point under the first-person head
        const vm = WM.flytrap; if (vm && vm.R) { vmScreen(vm.R.hinge, _a); this.swap = this.swap || V(); screenToWorld(_a, SWAP_D, this.swap); this.swapScale = apparentScale(_a.z, SWAP_D); }
        else { this.swap = this.swap || V(); this.swap.copy(camera.position).add(_b.set(.25, -.2, -1.2).applyQuaternion(camera.quaternion)); this.swapScale = 1; }
        if (this.phase === 'out' && this.age < .03) { const k2 = ez(clamp((this.D - .2) / 3, 0, 1)); this.pos.copy(this.swap).lerp(this.front(_c), k2); }
      }
      // size: from first-person size at the swap point to full size in flight
      const far = fp ? this.pos.distanceTo(this.swap) : this.pos.distanceTo(this.start), gk = ez(clamp(far / 2.2, 0, 1));
      const sc = fp ? lerp(this.swapScale || 1, FLY_SCALE, gk) : lerp(this.scale, FLY_SCALE * .85, gk);
      const bw = this.phase === 'latch' ? Math.min(1, this.t / .04) : this.phase === 'back' ? Math.max(0, 1 - this.t / .18) : 0;
      h.g.position.copy(this.pos); h.g.scale.setScalar(sc * (1 + .4 * bw));
      // orientation: mouth along the bite; shaking while it tears
      _b.copy(this.pos).sub(this.dir); h.g.lookAt(_b);   // +z (the back of the head) toward us: the mouth leads
      h.g.rotateY(fp ? lerp(.62, 1.2, bw) : .35); h.g.rotateZ(fp ? -.18 : 0);   // three-quarter on the whole time: you see the jaws, teeth and the torn chunk, not just its back
      if (this.shake > 0) { h.g.rotateZ(Math.sin(this.age * 55) * .35 * this.shake); h.g.rotateY(Math.sin(this.age * 41) * .2 * this.shake); }
      h.jawU.rotation.x = this.jawU; h.jawL.rotation.x = this.jawL; h.halo.material.opacity = this.phase === 'out' ? .45 : .25;
      // the vine: from the gun (or the other player's plant) to the back of the head
      const a = fp ? this.tetherFrom(_d) : (this.tp && this.tp.R && inScene(this.tp.g) ? this.tp.R.bulb.getWorldPosition(_d) : entChest(this.r, _d));
      const back = _e.set(0, .0, .07).applyQuaternion(h.g.quaternion).multiplyScalar(sc).add(this.pos);
      const L = a.distanceTo(back), slack = this.phase === 'back' ? Math.min(.8, L * .08) : this.phase === 'out' ? Math.min(.35, L * .03) : 0;
      const pa = a.clone(), pb = back.clone(), wob = this.age * 24;
      const r0 = fp ? this.tetherR || .012 : .02, r1 = .046 * sc / FLY_SCALE + .01;
      h.tube.update((t, out) => { out.copy(pa).lerp(pb, t); out.y -= Math.sin(Math.PI * t) * slack; const w = Math.sin(Math.PI * t) * Math.min(.06, L * .006); out.x += Math.sin(wob + t * 9) * w; out.z += Math.cos(wob * .8 + t * 7) * w; return out; },
        t => (t < .12 ? lerp(r0, .028, t / .12) : lerp(.028, r1, (t - .12) / .88)) * (1 + .14 * Math.sin(t * L * 3 - this.age * 30)), _c.set(0, 1, 0));
      if (fp) this.junction = true;
    }
    tetherFrom(out) {   // world point where the first-person stem hands over to the world vine
      const vm = WM.flytrap; if (!vm || !vm.R) return out.copy(camera.position).add(_b.set(.2, -.22, -.9).applyQuaternion(camera.quaternion));
      const m = META(); _a.set(m.stemA[0], m.stemA[1] + .06, m.stemA[2] - .07); vmScreen(_a, _b); this.jNdc = this.jNdc || V(); this.jNdc.copy(_b);
      this.tetherR = .012 * apparentScale(_b.z, TETHER_D) / C.viewmodel.scale;
      return screenToWorld(_b, TETHER_D, out);
    }
  }
  FT.BITES = BITES;

  function tpOf(r) { const g = r && r.gunInner; return g && g.userData && g.userData.ft || null; }

  function startBite() {   // left click: launch
    const B = C.bite;
    if (P.reload > 0 || P.switchT > 0 || S.bite) return;
    P.fireCd = B.cooldown; P.shield = 0; G.fired++; FT.stats.bites++;
    noise(camera.position, B.noiseRadius, PLAYER_ENT);
    camera.getWorldDirection(_a); const o = camera.position.clone(), dir = _a.clone();
    const w = wallDist(o, dir, B.range);
    const b = new Bite('me', o, dir, { stop: w ? Math.max(.4, w.d - .05) : B.range, wall: w, owner: PLAYER_ENT });
    if (b.phase === 'done') return; S.bite = b; b.pose();
    springs.kickZ.v -= 1.6; springs.kickRot.v += 1.2; P.trauma = Math.min(1, P.trauma + .05);
    snd('ftWhip'); recEvent(PLAYER_ENT, { type: 1, o, dir, stop: b.stop });
    netEvent([1, R3(o.x), R3(o.y), R3(o.z), R3(dir.x), R3(dir.y), R3(dir.z), R3(b.stop)]);
    updateHud();
  }
  function biteHit(b, hit) {
    const B = C.bite, e = hit.e, dmg = B.body * (hit.head ? B.headMult : 1) * (P.odT > 0 ? 1.25 : 1);
    const shield = e.isPlayer ? P.shield > 0 : e.shield > 0, kill = !shield && (e.hp - dmg) <= 0;
    b.latch(e, hit.p, hit.head, kill);
    FT.stats.biteHits++; if (hit.head) FT.stats.heads++; if (kill) FT.stats.kills++;
    G.hits++; hitstop = Math.max(hitstop, kill ? .06 : .035); P.trauma = Math.min(1, P.trauma + .1);
    damageEntity(e, dmg, hit.head, hit.p.clone(), b.dir.clone(), hit.head ? 'head' : 'body', PLAYER_ENT, 'flytrap');
    if (!shield) biteConfirm(dmg, hit.head, kill);
    biteResult(b, { p: hit.p, kind: hit.head ? 3 : 2, kill, e });
  }
  function biteResult(b, r) {
    const p = r ? r.p : b.front(_c), kind = r ? r.kind : b.wall && b.D >= b.stop - .01 ? 1 : 0;
    recEvent(PLAYER_ENT, { type: 2, p: p.clone(), kind, kill: r ? r.kill : false });
    netEvent([2, R3(p.x), R3(p.y), R3(p.z), kind, r && r.kill ? 1 : 0, r && r.e && r.e.netId ? String(r.e.netId).slice(0, 24) : 0]);
  }

  /* ----- impact FX ----- */
  function gooBurst(p, n, k, dark) {
    for (let i = 0; i < k; i++) SMOKE.spawn(p, n.x * rand(1, 3) + rand(-2, 2), n.y * rand(1, 3) + rand(.5, 3), n.z * rand(1, 3) + rand(-2, 2), dark ? .26 : .18, dark ? .02 : .42, dark ? .06 : .05, rand(.03, .07), rand(.4, .8), 9, 1, .02, .9);
    for (let i = 0; i < k * .6; i++) FX.spawn(p, rand(-2.5, 2.5), rand(0, 3), rand(-2.5, 2.5), ...C.weapon.glow, rand(.02, .045), rand(.25, .5), 7, 1);
  }
  function chompFx(p, dir, body, kill, head, e) {
    snd('ftChomp', p.clone(), body ? 1.1 : .8);
    for (let i = 0; i < 4; i++) FX.spawn(p, 0, 0, 0, 5, 6, 3, kill ? 1.1 : .85, .14, 0, 0, 1.2);   // the jaws slam: a bright snap flash
    for (let i = 0; i < 16; i++) { const a = i / 16 * 6.283; FX.spawn(p, Math.cos(a) * 5, Math.sin(a) * 3 + 1, Math.sin(a) * 5, ...C.weapon.glow, .07, .22, 4, 3); }   // ring of saliva sparks
    _a.copy(dir).negate();
    gooBurst(p, _a, body ? (kill ? 26 : 14) : 6, body);
    if (body) lightFlash(p, 0x9cff4a, kill ? 5 : 3, 6);
  }
  function ripFx(p, dir, kill, e) {
    snd('ftRip', p.clone(), kill ? 1.1 : .8);
    _a.copy(dir).negate(); gooBurst(p, _a, kill ? 30 : 12, true);
    // torn armour shards fly off (the game's debris: gravity, bounce, sink)
    const col = e && e.color ? e.color : new THREE.Color(.4, .4, .45);
    for (let i = 0; i < (kill ? 4 : 2); i++) {
      if (!PLATE_GEO) makeChunk(); const m = new THREE.Mesh(PLATE_GEO, new THREE.MeshStandardMaterial({ color: new THREE.Color(col.r * .5 + .05, col.g * .5 + .05, col.b * .5 + .05), roughness: .45, metalness: .5 }));
      m.scale.setScalar(rand(.25, .45)); m.position.copy(p); scene.add(m);
      debris.push({ m, v: new THREE.Vector3(-dir.x * rand(2, 4) + rand(-2, 2), rand(2, 4.5), -dir.z * rand(2, 4) + rand(-2, 2)), av: new THREE.Vector3(rand(-9, 9), rand(-9, 9), rand(-9, 9)), life: rand(4, 6), smoke: 0 });
    }
    // goo on the floor under them
    if (e) { const ep = entPos(e); _b.set(ep.x + rand(-.3, .3), groundAt(ep.x, ep.z, ep.y + .5, .3) + .01, ep.z + rand(-.3, .3)); decal(_b.clone(), UPV, kill ? 1.3 : .8, 'scorch', [.55, 1.8, .25]); }
  }

  /* ================= the spit ================= */
  let GLOB_GEO = null;
  function makeGlob() {
    if (!GLOB_GEO) GLOB_GEO = new THREE.IcosahedronGeometry(.1, 2);
    const m = new THREE.Mesh(GLOB_GEO, new THREE.MeshStandardMaterial({ color: new THREE.Color(.25, .6, .04), emissive: GLOWC().multiplyScalar(.35), roughness: .08, metalness: 0, transparent: true, opacity: .62, depthWrite: false }));
    const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex(T.glow), color: GLOWC().multiplyScalar(.8), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: .8 })); core.scale.setScalar(.34); m.add(core); m.userData.core = core;
    m.add(new THREE.Mesh(GLOB_GEO, new THREE.MeshBasicMaterial({ color: GLOWC().multiplyScalar(1.5) })).translateZ(0)); m.children[m.children.length - 1].scale.setScalar(.55);
    m.frustumCulled = false; return { m };
  }
  class Glob {
    constructor(live, owner, p, v) {
      const gb = GLOBS_FREE.pop() || makeGlob(); this.gb = gb; this.m = gb.m; this.live = live; this.owner = owner; this.p = p.clone(); this.v = v.clone(); this.t = 0; this.done = false;
      this.m.position.copy(p); this.m.visible = true; scene.add(this.m); GLOBS.push(this);
    }
    update(dt) {
      const Sp = C.spit; this.t += dt; const prev = _a.copy(this.p);
      this.v.y -= Sp.gravity * dt; this.p.addScaledVector(this.v, dt);
      // wobble + dripping trail
      const s = 1 + Math.sin(this.t * 40) * .12; this.m.scale.set(s, 2 - s, s); this.m.position.copy(this.p); this.m.lookAt(_b.copy(this.p).add(this.v));
      for (let k = 0; k < 2; k++) SMOKE.spawn(this.p, rand(-.3, .3) + this.v.x * .1, rand(-1, 0), rand(-.3, .3) + this.v.z * .1, .22, .5, .05, rand(.035, .06), rand(.35, .6), 9, .5, -.02, .9);
      for (let k = 0; k < 2; k++) FX.spawn(_b.copy(this.p).addScaledVector(this.v, -dt * k * .5), rand(-.3, .3), rand(-.2, .3), rand(-.3, .3), ...C.weapon.glow, rand(.05, .08), rand(.18, .3), 0, 2, -.05, .9);
      // what it touches this frame: bodies first, then the world
      const seg = prev.distanceTo(this.p), n = Math.max(1, Math.ceil(seg / .15)); let hitE = null, hp = null, head = false;
      for (let st = 1; st <= n && !hitE; st++) {
        const q = _c.copy(prev).lerp(this.p, st / n);
        for (const e of entities()) { if (e === this.owner || !entAlive(e)) continue;
          const eye = entEye(e, _d); if (q.distanceTo(eye) < .3) { hitE = e; head = true; hp = q.clone(); break; }
          const ch = entChest(e, _e), base = entPos(e).y; if (Math.hypot(q.x - ch.x, q.z - ch.z) < .45 && q.y > base + .05 && q.y < eye.y + .1) { hitE = e; hp = q.clone(); break; } }
      }
      if (hitE) return this.burst(hp, _d.copy(this.v).normalize().negate(), hitE, head);
      ray.set(prev, _d.subVectors(this.p, prev).normalize()); ray.far = seg + .08; const h = shotHits(world.meshes, false)[0]; ray.far = Infinity;
      if (h) { const nrm = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : UPV.clone(); return this.burst(h.point.clone(), nrm, null, false); }
      const g = groundAt(this.p.x, this.p.z, this.p.y + .2, .05); if (this.p.y <= g + .03) return this.burst(_d.set(this.p.x, g, this.p.z).clone(), UPV.clone(), null, false);
      if (this.t > C.spit.maxFlight || Math.abs(this.p.x) > HALF + 3 || Math.abs(this.p.z) > HALF + 3) this.kill();
    }
    burst(p, n, direct, head) {
      const Sp = C.spit; (FT.bursts || (FT.bursts = [])).push({ p: [p.x, p.y, p.z].map(R3), direct: direct ? direct.name : null, live: this.live, t: R3(this.t) }); if (FT.bursts.length > 20) FT.bursts.shift(); snd('ftSplat', p.clone()); gooBurst(p, n, 18, false); lightFlash(p, 0x9cff4a, 2.5, 5);
      decal(p.clone(), n, 1.25, 'scorch', [.5, 2.4, .25]);
      if (direct || n.y < .7) { const gy = groundAt(p.x, p.z, p.y + .1, .1); if (p.y - gy < 2.2 && (direct || n.y < .7)) puddle(new THREE.Vector3(p.x, gy + .01, p.z), UPV.clone(), this.live ? this.owner : null); if (!direct) puddle(p, n, null); }
      else puddle(p, n, this.live ? this.owner : null);
      if (this.live) {
        const hitSet = new Set();
        if (direct) { hitSet.add(direct); if (this.owner === PLAYER_ENT) biteConfirm(Sp.directDamage, head, false, true); damageEntity(direct, Sp.directDamage * (head ? 1.25 : 1) * (P.odT > 0 ? 1.25 : 1), false, p.clone(), this.v.clone().normalize(), head ? 'head' : 'body', this.owner, 'ftspit'); poison(direct, this.owner); FT.stats.spitHits++; G.hits++; }
        for (const e of entities()) { if (e === this.owner || hitSet.has(e) || !entAlive(e)) continue; const c = entChest(e, _a), d = Math.min(c.distanceTo(p), entPos(e).distanceTo(p));
          if (d > Sp.splashRadius || !lineOfSight(_b.copy(p).addScaledVector(n, .2), c)) continue;
          damageEntity(e, Sp.splashDamage * (1 - d / Sp.splashRadius * .6), false, c.clone(), _b.subVectors(c, p).normalize(), 'body', this.owner, 'ftspit'); poison(e, this.owner); if (!direct) { FT.stats.spitHits++; G.hits++; } }
      } else {   // someone else's spit: just show who it's eating
        for (const e of entities()) { if (e === this.owner || !entAlive(e) || e === PLAYER_ENT) continue; const c = entChest(e, _a); if (c.distanceTo(p) <= Sp.splashRadius) poisonVisual(e); }
      }
      this.kill();
    }
    kill() { this.done = true; this.m.visible = false; scene.remove(this.m); GLOBS_FREE.push(this.gb); }
  }
  function startSpit() {
    const Sp = C.spit;
    if (S.saliva < Sp.cost || S.spitCd > 0 || P.switchT > 0 || P.sprint || S.bite) return false;
    S.saliva -= Sp.cost; S.regenT = Sp.regenDelay; S.spitCd = Sp.cooldown; P.shield = 0; G.fired++; FT.stats.spits++;
    noise(camera.position, 18, PLAYER_ENT);
    camera.getWorldDirection(_a); const dir = _a.clone();
    // leaves the trap's mouth: the first-person mouth's screen position, a little way into the world
    let from = camera.position.clone().addScaledVector(dir, .7);
    const vm = WM.flytrap; if (vm && vm.R) { const m = META(); _b.set(0, m.hinge[1] + .02, m.hinge[2] - .2); vmScreen(_b, _c); _c.x *= .5; _c.y = _c.y * .5 + .02; screenToWorld(_c, .9, _d); from = _d.clone(); }
    // an arc that comes down on whatever is under the crosshair (like a grenade's range finder: no target picking, no homing)
    // a lob: it comes down on the floor under your crosshair (on whoever stands there, or at their feet), or on the wall you aim at
    const tr = traceShot(camera.position, dir, PLAYER_ENT, 40), D = clamp(tr && tr.dist ? tr.dist : 25, 2.5, 30);
    const tgt = camera.position.clone().addScaledVector(dir, D);
    if (!tr || tr.ent || !tr.obj) tgt.y = groundAt(tgt.x, tgt.z, tgt.y + .2, .1) + .25;
    const ft = Math.max(.08, from.distanceTo(tgt) / Sp.speed);
    const v = new THREE.Vector3((tgt.x - from.x) / ft, (tgt.y - from.y) / ft + .5 * Sp.gravity * ft, (tgt.z - from.z) / ft);
    new Glob(true, PLAYER_ENT, from, v);
    S.vm.spitT = .001; springs.kickZ.v += 1.2; springs.kickRot.v -= 1; P.trauma = Math.min(1, P.trauma + .03);
    snd('ftSpit'); recEvent(PLAYER_ENT, { type: 3, p: from, v }); netEvent([3, R3(from.x), R3(from.y), R3(from.z), R3(v.x), R3(v.y), R3(v.z)]);
    updateHud(); return true;
  }

  /* ----- puddles: a glowing, bubbling pool that fades ----- */
  let PUD_GEO = null;
  function puddle(p, n, owner) {
    if (!PUD_GEO) PUD_GEO = new THREE.CircleGeometry(.85, 32);
    let pd = PUDDLES.find(x => x.t <= 0);
    if (!pd) { if (PUDDLES.length >= 8) pd = PUDDLES.reduce((a, b) => a.t < b.t ? a : b);
      else { const m = new THREE.Mesh(PUD_GEO, new THREE.MeshBasicMaterial({ map: tex(T.glow), color: new THREE.Color(.55, 1.4, .15), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
        const glow = new THREE.Mesh(PUD_GEO, new THREE.MeshBasicMaterial({ map: tex(T.glow), color: GLOWC().multiplyScalar(.45), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -5 })); glow.scale.setScalar(1.35); glow.position.z = .005; m.add(glow);
        m.frustumCulled = false; pd = { m, t: 0 }; PUDDLES.push(pd); } }
    pd.t = C.spit.puddleTime; pd.T = pd.t; pd.owner = owner || null; pd.touched = new Map(); pd.floor = n.y > .7; pd.m.position.copy(p).addScaledVector(n, .02); pd.m.lookAt(_a.copy(pd.m.position).add(n)); pd.m.scale.setScalar(rand(1.15, 1.35)); pd.m.visible = true; pd.n = n.clone(); pd.p = p.clone(); pd.sz = 0;
    if (pd.m.parent !== scene) scene.add(pd.m);
  }
  function updatePuddles(dt) {
    for (const pd of PUDDLES) { if (pd.t <= 0) continue; pd.t -= dt; const k = pd.t / pd.T;
      pd.m.material.opacity = clamp(k * 1.6, 0, 1) * (.75 + .25 * Math.sin(G.time * 9 + pd.T)); pd.m.scale.setScalar((pd.m.scale.x * .98 + (.7 + .3 * k) * .02));
      if (Math.random() < .5 * k) { _a.copy(pd.p).add(_b.set(rand(-.35, .35), 0, rand(-.35, .35))); FX.spawn(_a, 0, rand(.4, 1), 0, ...C.weapon.glow, rand(.02, .04), rand(.2, .45), -.5, 1, .02, .8); }
      if (Math.random() < .5 * k) SMOKE.spawn(_a.copy(pd.p).add(_b.set(rand(-.5, .5), .05, rand(-.5, .5))), rand(-.15, .15), rand(.4, .8), rand(-.15, .15), .3, .55, .12, rand(.12, .2), rand(.7, 1.1), -.3, 1, .35, .4);   // rising poison gas
      pd.sz -= dt; if (pd.sz <= 0 && k > .5) { pd.sz = 1.6; snd('ftSizzle', pd.p.clone(), .55 * k); }
      // your own puddle on the floor bites whoever steps in it: a poison stack, at most once a second each
      // (it catches whoever dodged the glob: only someone not already poisoned, and only while it's fresh)
      if (pd.owner && pd.floor && state === 'play' && pd.T - pd.t < 3) for (const e of entities()) { if (e === pd.owner || !entAlive(e)) continue; const f = entPos(e), ps = POISON.get(e);
        if (ps && ps.stacks.length) continue;
        if (Math.hypot(f.x - pd.p.x, f.z - pd.p.z) < .95 * pd.m.scale.x && Math.abs(f.y - pd.p.y) < .6 && G.time - (pd.touched.get(e) || -9) > 1) { pd.touched.set(e, G.time); poison(e, pd.owner); FT.stats.puddleHits = (FT.stats.puddleHits || 0) + 1; } }
      if (pd.t <= 0) { pd.m.visible = false; } }
  }

  /* ================= poison: damage over time, stacks, expires ================= */
  function poison(e, by) {
    if (!e || !entAlive(e)) return; const Pn = C.poison;
    let st = POISON.get(e); if (!st) { st = { stacks: [], tickT: Pn.tick, fxT: 0 }; POISON.set(e, st); }
    if (st.stacks.length >= Pn.maxStacks) st.stacks.sort((a, b) => a.t - b.t).shift();   // refresh the oldest
    st.stacks.push({ t: Pn.duration, by }); st.vis = Pn.duration;
  }
  function poisonVisual(e) { let st = POISON.get(e); if (!st) { st = { stacks: [], tickT: 1, fxT: 0 }; POISON.set(e, st); } st.vis = C.poison.duration; }
  FT.poisonOf = e => { const st = POISON.get(e); return st ? { stacks: st.stacks.length, left: st.stacks.reduce((a, s) => Math.max(a, s.t), 0) } : { stacks: 0, left: 0 }; };
  let quietHits = false;
  function updatePoison(dt) {
    const Pn = C.poison;
    for (const [e, st] of POISON) {
      const alive = entAlive(e) && (e.isPlayer || robots.includes(e));
      if (!alive) { POISON.delete(e); continue; }
      for (const s of st.stacks) s.t -= dt; st.stacks = st.stacks.filter(s => s.t > 0); st.vis = (st.vis || 0) - dt;
      if (st.stacks.length) {
        st.tickT -= dt;
        if (st.tickT <= 0) { st.tickT += Pn.tick; const dmg = Pn.dps * Pn.tick * st.stacks.length, by = st.stacks[st.stacks.length - 1].by;
          FT.stats.ticks++; quietHits = true; try { damageEntity(e, dmg, false, entChest(e, _a).clone(), _b.set(0, 1, 0).clone(), 'body', by || null, 'ftpoison'); } finally { quietHits = false; }
          st.n = (st.n || 0) + 1; if (!e.isPlayer && st.n % 2) snd('ftTick', entChest(e, _a).clone(), .7); }
      } else st.tickT = Pn.tick;
      // bubbling green on whoever is poisoned
      if (st.stacks.length || st.vis > 0) { st.fxT -= dt; if (st.fxT <= 0) { st.fxT = .05; const c = entChest(e, _a), n = Math.max(1, st.stacks.length);
        if (!e.isPlayer) for (let k = 0; k < n; k++) { FX.spawn(_b.set(c.x + rand(-.3, .3), c.y + rand(-.6, .5), c.z + rand(-.3, .3)), rand(-.2, .2), rand(.4, 1.2), rand(-.2, .2), ...C.weapon.glow, rand(.025, .05), rand(.3, .6), -1, 1, .02, .9); if (Math.random() < .3) SMOKE.spawn(_b, 0, rand(.3, .8), 0, .2, .3, .1, rand(.08, .14), rand(.6, 1), -.2, 1, .3, .35); } } }
      if (!e.isPlayer && e.body && !e.dead && !(e.hitT > .25) && (st.stacks.length || st.vis > 0)) { const pz = .55 + .45 * Math.sin(G.time * 9); e.body.emissive.setRGB(.1 * pz, .38 * pz, .04 * pz); }
      if (!st.stacks.length && !(st.vis > 0)) POISON.delete(e);
    }
  }

  /* ================= other players' Flytraps (what you see of them) ================= */
  function remoteEvent(r, ev) {
    const type = ev[1] | 0; FT.stats.netIn++;
    if (type === 1) {
      const o = new THREE.Vector3(+ev[2], +ev[3], +ev[4]), dir = new THREE.Vector3(+ev[5], +ev[6], +ev[7]); if (!isFinite(o.x) || dir.lengthSq() < .5) return;
      const old = BITES.find(b => b.kind === 'tp' && b.r === r && b.phase !== 'done'); if (old) old.finish();
      const b = new Bite('tp', o, dir, { r, owner: r, stop: clamp(+ev[8] || C.bite.range, .3, C.bite.range) }); b.netSeq = ev[0];
      snd('ftWhip', o.clone(), .9); recEvent(r, { type: 1, o, dir, stop: b.stop });
    } else if (type === 2) {
      const p = new THREE.Vector3(+ev[2], +ev[3], +ev[4]); if (!isFinite(p.x)) return;
      const kind = ev[5] | 0, kill = !!ev[6], vid = ev[7];
      const e = vid ? (vid === (NET.room && NET.room.myId) ? PLAYER_ENT : remoteById(vid)) : null;
      const b = BITES.slice().reverse().find(x => x.kind === 'tp' && x.r === r && x.phase === 'out');
      if (b) b.result = { p, kind, kill, e };
      recEvent(r, { type: 2, p, kind, kill });
    } else if (type === 3) {
      const p = new THREE.Vector3(+ev[2], +ev[3], +ev[4]), v = new THREE.Vector3(+ev[5], +ev[6], +ev[7]); if (!isFinite(p.x) || !isFinite(v.x)) return;
      new Glob(false, r, p, v); snd('ftSpit', p.clone(), .9); const tp = tpOf(r); if (tp) tp.spitT = .001; recEvent(r, { type: 3, p, v });
    }
  }

  /* ================= killcam: record, then replay from the killer's eyes ================= */
  const REC_FT = []; FT.rec = REC_FT;
  function recEvent(ent, ev) { ev.t = G.time; ev.ent = ent; REC_FT.push(ev); while (REC_FT.length && G.time - REC_FT[0].t > 9) REC_FT.shift(); }
  const KCV = { on: false, lastRt: -1e9, bites: [], recoil: 0 };
  function killcamTick() {
    const K = window.S9KC, live = !!(K && K.inReplay && K.clip && state === 'dead');
    if (!live) { if (KCV.on) { KCV.on = false; for (const b of KCV.bites) if (b.phase !== 'done') b.finish(); KCV.bites.length = 0; } return false; }
    const c = K.clip, rt = K.rt; if (!KCV.on || rt < KCV.lastRt - .05 || KCV.clip !== c) { KCV.on = true; KCV.clip = c; KCV.lastRt = rt - 1e-4; for (const b of KCV.bites) if (b.phase !== 'done') b.finish(); KCV.bites.length = 0; }
    const kw = WEAPONS[c.killer && (c.killer === PLAYER_ENT ? P.weapon : c.killer.kcW || c.killer.netW || c.killer.weapon)];
    for (const ev of REC_FT) {
      if (ev.ent !== c.killer || ev.t <= KCV.lastRt || ev.t > rt) continue;
      if (ev.type === 1) { const b = new Bite('kc', ev.o, ev.dir, { stop: ev.stop }); if (b.phase !== 'done') { const r2 = REC_FT.find(x => x.ent === ev.ent && x.type === 2 && x.t >= ev.t && x.t < ev.t + 1.3); if (r2) b.result = { p: r2.p, kind: r2.kind, kill: r2.kill, e: null }; KCV.bites.push(b); } }
      if (ev.type === 3) new Glob(false, c.killer, ev.p, ev.v);
    }
    const dt = Math.max(0, rt - KCV.lastRt); KCV.lastRt = rt;
    for (const b of KCV.bites) if (b.phase !== 'done') b.update(Math.min(dt, .1));
    return !!kw && kw.mode === 'flytrap';
  }

  /* ================= first-person: alive ================= */
  const vmS = S.vm;
  function animVM(dt) {
    const vm = WM.flytrap; if (!vm || !vm.R || !vm.group.visible) return;
    const R = vm.R, m = META(), t = G.time, kc = state === 'dead';
    // breathing + slow glow heartbeat
    vmS.breath += dt; const br = Math.sin(vmS.breath * 1.5), hb = Math.max(0, Math.sin(t * 2.4)) ** 6 + .6 * Math.max(0, Math.sin(t * 2.4 - .5)) ** 6;
    U.pulse.value = hb; U.time.value = t;
    R.bulb.scale.set(1 + br * .03, 1 + br * .035, 1 + br * .02);
    R.leafL.rotation.set(Math.sin(t * 1.1) * .06, 0, Math.sin(t * 1.7) * .08 + .02); R.leafR.rotation.set(Math.sin(t * 1.2 + 1) * .06, 0, -Math.sin(t * 1.6 + .5) * .08 - .02);
    // random twitches, sniff / look-around, eagerness when prey is near, a happy shiver after a kill
    vmS.twitchT -= dt; if (vmS.twitchT <= 0) { vmS.twitchT = rand(1.4, 4); vmS.twitch = 1; vmS.twitchDur = rand(.12, .25); vmS.twitchAmp = rand(.08, .22); }
    vmS.twitch = Math.max(0, vmS.twitch - dt / vmS.twitchDur);
    vmS.lookT -= dt; if (vmS.lookT <= 0 && !kc) { vmS.lookT = rand(5, 9); vmS.look = 1; vmS.lookDur = rand(1.1, 1.6); vmS.lookYaw = rand(-.45, .45); vmS.lookPitch = rand(-.1, .2); if (state === 'play') snd('ftSniff', null, .9); }
    vmS.look = Math.max(0, vmS.look - dt / vmS.lookDur);
    vmS.gurgleT -= dt; if (vmS.gurgleT <= 0) { vmS.gurgleT = rand(6, 11); if (state === 'play') snd('ftGurgle', null, .8); }
    const eagerWant = (S.prey || S.spitHeld) && !kc ? 1 : 0; vmS.eager = damp(vmS.eager, eagerWant, 6, dt);
    vmS.shiver = Math.max(0, vmS.shiver - dt / .7); vmS.chew = Math.max(0, vmS.chew - dt / .55); vmS.recoil = Math.max(0, vmS.recoil - dt / .35); KCV.recoil = Math.max(0, KCV.recoil - dt / .35);
    if (vmS.spitT > 0) { vmS.spitT += dt; if (vmS.spitT > .38) vmS.spitT = 0; }
    const lk = Math.sin(Math.PI * vmS.look), sh = vmS.shiver, sp = vmS.spitT > 0 ? vmS.spitT / .38 : 0, rec = Math.max(vmS.recoil, KCV.recoil);
    const rear = sp > 0 ? (sp < .3 ? ez(sp / .3) * .4 : 0) : 0, lunge = sp > 0 ? (sp >= .3 ? Math.sin(Math.PI * (sp - .3) / .7) : 0) : 0;
    // head pose (relative to its rest at the hinge)
    const H = R.head; H.position.copy(R.head0);
    H.position.y += Math.sin(vmS.breath * 1.5 + .6) * .004 + vmS.eager * .012 + rear * .02 - rec * .01;
    H.position.z += -vmS.eager * .03 + rear * .025 - lunge * .014 + rec * .04; H.position.x += lunge * .03; H.position.y -= lunge * .016;
    H.rotation.set(Math.sin(vmS.breath * 1.1) * .03 - vmS.eager * .08 + lk * vmS.lookPitch + rear * .15 - lunge * .12 + rec * .25,
      lk * vmS.lookYaw - lunge * .3 + Math.sin(t * 38) * .12 * sh, Math.sin(t * 31) * .1 * sh + Math.sin(t * .7) * .03);
    // jaws: resting slightly open, panting, twitching; wide when eager or spitting; chewing after a kill
    const pant = Math.sin(t * 3.1) * .03, tw = Math.sin(Math.PI * (1 - vmS.twitch)) * vmS.twitchAmp * (vmS.twitch > 0 ? 1 : 0);
    let ju = (C.viewmodel.open || m.restOpen[0]) + pant + tw + vmS.eager * .22 + lunge * .3 - rear * .1 + Math.abs(Math.sin(t * 26)) * .25 * sh;
    if (vmS.chew > 0) ju = .05 + Math.abs(Math.sin(vmS.chew * 18)) * .28 * vmS.chew;
    if (rec > 0) ju = lerp(ju, .02, rec);
    R.jawU.rotation.x = ju; R.jawL.rotation.x = -(ju * .85 + .02 + vmS.eager * .05);
    U.flare.value = vmS.eager * .6 + lunge;
    // glow: the meter shows saliva, veins pulse with the heartbeat (brighter when hungry)
    const sal = S.saliva / C.spit.pool; R.meter.scale.set(1, 1, Math.max(.02, sal));
    const VMc = C.viewmodel; vm.group.scale.setScalar(VMc.scale); vm.hip.set(...VMc.hip); vm.adsPos.copy(vm.hip); if (VMc.rot) vm.inner.rotation.set(...VMc.rot);
    MAT_FP.ft_meter.color.copy(GLOWC()).multiplyScalar(sal >= C.spit.cost / C.spit.pool ? 1.3 : .35);
    MAT_FP.ft_vein.color.copy(GLOWC()).multiplyScalar(.55 + .45 * hb + vmS.eager * .4 + sh * 1.2);
    MAT_FP.ft_fluid.color.copy(GLOWC()).multiplyScalar(.45 + .25 * Math.sin(t * 2) + sal * .3);
    // the head leaves while a bite is out
    const b = kc ? KCV.bites.find(x => x.phase !== 'done') : S.bite, out = !!(b && b.phase !== 'done');
    H.visible = !out;
    // stem: rest curve, or stretched out to where the world vine takes over
    const A = _a.set(...m.stemA);
    if (!out) { const Bk = _b.copy(H.position).add(_c.set(0, 0, .022).applyEuler(H.rotation)), hs = .045 + vmS.eager * .01;
      const c1 = _c.copy(A).add(_d.set(0, .055, -.012)), c2 = _d.copy(Bk).add(_e.set(0, hs, .055).applyEuler(H.rotation));
      const A0 = A.clone(), B0 = Bk.clone(), C1 = c1.clone(), C2 = c2.clone();
      const gp = vmS.chew > 0 ? vmS.chew : -9;   // swallowing: a lump slides from the head down to the bulb
      vm.stem.update((u, o) => bez(o, A0, C1, C2, B0, u), u => (.02 - .005 * u) * (1 + .06 * Math.sin(u * 14 - t * 4)) * (1 + br * .03 * (1 - u)) + .011 * Math.exp(-(((u - gp) / .09) ** 2)), _e.set(1, 0, 0));
    } else if (b.jNdc) {
      const J = screenToGun(b.jNdc, .9, _b.set(0, 0, 0)); const A0 = A.clone(), J0 = J.clone(), C1 = A0.clone().add(_c.set(0, .05, -.04)), C2 = J0.clone().add(_d.subVectors(A0, J0).multiplyScalar(.35)).add(_e.set(0, .02, 0));
      vm.stem.update((u, o) => bez(o, A0, C1, C2, J0, u), u => lerp(.02, .012 * (b.tetherR ? 1 : 1), u), _e.set(1, 0, 0));
    }
  }
  function bez(o, a, b, c, d, t) { const u = 1 - t; return o.set(0, 0, 0).addScaledVector(a, u * u * u).addScaledVector(b, 3 * u * u * t).addScaledVector(c, 3 * u * t * t).addScaledVector(d, t * t * t); }
  function poseGunGroup(dt) {   // whole-gun motion on top of the game's sway/bob (called from poseBoomVM)
    if (P.weapon !== 'flytrap' || !gun) return;
    const rec = vmS.recoil, sp = vmS.spitT > 0 ? vmS.spitT / .38 : 0, b = S.bite, launch = b && b.phase === 'out' ? Math.min(1, b.age / .12) : 0;
    gun.position.z -= vmS.eager * .02 + launch * .05 - rec * .03; gun.position.y += vmS.eager * .008 - rec * .012 + Math.sin(Math.PI * sp) * .01;
    gun.rotation.x += -launch * .06 + rec * .08 + Math.sin(Math.PI * sp) * .05; gun.rotation.z += Math.sin(G.time * 34) * .01 * vmS.shiver;
    if (b && b.phase === 'latch') { gun.position.x += Math.sin(G.time * 70) * .004; gun.position.y += Math.sin(G.time * 63) * .004; }
  }

  /* ----- third person rigs: idle life + spit / bite poses ----- */
  function animTP(dt) {
    const t = G.time;
    for (const tp of TPS) {
      if (!tp.filled) continue;
      if (!inScene(tp.g)) { tp.off++; if (tp.off > 600) TPS.delete(tp); continue; } tp.off = 0;
      if (!tp.g.visible) continue;
      tp.g.getWorldPosition(_a); if (_a.distanceToSquared(camera.position) > 900) continue;
      const R = tp.R, ph = tp.idle; tp.spitT = tp.spitT > 0 ? tp.spitT + dt : 0; if (tp.spitT > .38) tp.spitT = 0; const sp = tp.spitT / .38;
      R.jawU.rotation.x = .18 + Math.sin(t * 3 + ph) * .04 + (sp > .3 ? Math.sin(Math.PI * (sp - .3) / .7) * .7 : 0); R.jawL.rotation.x = -R.jawU.rotation.x * .85;
      R.head.rotation.set(Math.sin(t * 1.1 + ph) * .05 - (sp > 0 && sp < .3 ? .3 : 0), Math.sin(t * .5 + ph) * .15, 0); R.bulb.scale.setScalar(1 + Math.sin(t * 1.5 + ph) * .03);
    }
  }

  /* ================= HUD: bite ring (lime = prey in reach), saliva, bitten / poisoned overlays ================= */
  let HUD = null;
  function hud() {
    if (HUD) return HUD;
    const st = document.createElement('style'); st.id = 'ftStyle';
    st.textContent = `#ftRing{position:fixed;left:50%;top:50%;width:46px;height:46px;margin:-23px 0 0 -23px;pointer-events:none;z-index:6;opacity:0;transition:opacity .15s}
#ftRing circle{fill:none;stroke-width:2.2}#ftRing .bg{stroke:rgba(255,255,255,.18)}#ftRing .cd{stroke:#b8ff5a;stroke-linecap:round;transform:rotate(-90deg);transform-origin:23px 23px;filter:drop-shadow(0 0 3px rgba(150,255,60,.7))}
#ftRing.far .cd{stroke:rgba(235,245,225,.75);filter:none}#ftRing .dot{fill:#b8ff5a;opacity:0}#ftRing.prey .dot{opacity:1}
#ftRing b{position:absolute;left:50%;top:50px;transform:translateX(-50%);font:600 9px/1 var(--mono,ui-monospace,monospace);letter-spacing:.12em;color:#b8ff5a;white-space:nowrap;opacity:0;transition:opacity .15s;text-shadow:0 1px 2px #000}
#ftRing.prey b{opacity:.9}#ftRing.busy{opacity:.35!important}#ftRing.busy .cd{stroke:rgba(235,245,225,.6);filter:none}
#ftBit{position:fixed;inset:0;pointer-events:none;z-index:7;opacity:0}#ftBit svg{position:absolute;left:0;width:100%;height:32%}#ftBit .u{top:0;transform:translateY(-100%)}#ftBit .l{bottom:0;transform:translateY(100%)}
#ftBit.on .u{animation:ftU .42s ease-out}#ftBit.on .l{animation:ftL .42s ease-out}#ftBit.on{animation:ftO .55s ease-out}
@keyframes ftU{0%{transform:translateY(-100%)}35%{transform:translateY(-8%)}100%{transform:translateY(-100%)}}@keyframes ftL{0%{transform:translateY(100%)}35%{transform:translateY(8%)}100%{transform:translateY(100%)}}@keyframes ftO{0%,60%{opacity:1}100%{opacity:0}}
#ftHit{position:fixed;left:50%;top:50%;width:190px;height:190px;margin:-95px 0 0 -95px;pointer-events:none;z-index:8;opacity:0}
#ftHit svg{position:absolute;left:0;width:190px;height:60px;filter:drop-shadow(0 0 3px rgba(150,255,60,.9))}#ftHit .ju{top:0}#ftHit .jl{bottom:0}
#ftHit b{position:absolute;left:142px;top:22px;font:700 18px/1 var(--display,Impact,sans-serif);color:#c8ff6a;letter-spacing:.06em;text-shadow:0 2px 4px #000;white-space:nowrap}
#ftHit.crit b{color:#ffd27a}#ftHit.kill b{color:#ff6a4a}
#ftPois{position:fixed;inset:0;pointer-events:none;z-index:5;opacity:0;background:radial-gradient(ellipse at center,rgba(0,0,0,0) 45%,rgba(90,190,20,.28) 78%,rgba(40,90,0,.55) 100%);transition:opacity .25s}`;
    document.head.appendChild(st);
    const ring = document.createElement('div'); ring.id = 'ftRing';
    ring.innerHTML = '<svg viewBox="0 0 46 46" width="46" height="46"><circle class="bg" cx="23" cy="23" r="19"/><circle class="cd" cx="23" cy="23" r="19" stroke-dasharray="119.4" stroke-dashoffset="0"/><circle class="dot" cx="23" cy="4" r="2.4"/></svg><b>IN REACH</b>';
    const bit = document.createElement('div'); bit.id = 'ftBit';
    const teeth = up => `<svg class="${up ? 'u' : 'l'}" viewBox="0 0 100 30" preserveAspectRatio="none"><path d="${up ? 'M0 0H100V12' : 'M0 30H100V18'}${Array.from({ length: 11 }, (_, i) => { const x = 100 - i * 10; return up ? ` L${x - 5} ${24 + (i % 2) * 4} L${x - 10} 12` : ` L${x - 5} ${6 - (i % 2) * 4} L${x - 10} 18`; }).join('')}Z" fill="#160a10" stroke="#7aff3a" stroke-width=".5"/></svg>`;
    bit.innerHTML = teeth(true) + teeth(false);
    const pois = document.createElement('div'); pois.id = 'ftPois';
    const hit = document.createElement('div'); hit.id = 'ftHit';
    const jaw = up => `<svg class="${up ? 'ju' : 'jl'}" viewBox="-35 0 190 60" preserveAspectRatio="none"><path d="${up ? 'M14 44 Q60 -6 106 44' : 'M14 16 Q60 66 106 16'}" fill="none" stroke="#b8ff5a" stroke-width="3" stroke-linecap="round"/>${[30, 45, 60, 75, 90].map((x, i) => up ? `<path d="M${x - 5} ${30 - Math.abs(x - 60) * .45 + 6} l5 ${12 - (i % 2) * 4} l5 -${12 - (i % 2) * 4}" fill="#e9ffd0"/>` : `<path d="M${x - 5} ${30 + Math.abs(x - 60) * .45 - 6} l5 -${12 - (i % 2) * 4} l5 ${12 - (i % 2) * 4}" fill="#e9ffd0"/>`).join('')}</svg>`;
    hit.innerHTML = jaw(true) + jaw(false) + '<b></b>';
    document.body.append(ring, bit, pois, hit);
    HUD = { ring, cd: ring.querySelector('.cd'), bit, pois, hit, hju: hit.querySelector('.ju'), hjl: hit.querySelector('.jl'), hb: hit.querySelector('b'), lastK: -1, lastC: '' };
    return HUD;
  }
  function updateFtHud(dt) {
    const h = hud(), on = state === 'play' && P.weapon === 'flytrap' && !P.dead;
    setStyle(h.ring, 'opacity', on ? '1' : '0');
    if (on) {
      const k = clamp(1 - P.fireCd / C.bite.cooldown, 0, 1), busy = !!S.bite || GLOBS.some(g => !g.done && g.live);
      const kk = Math.round((busy ? 0 : k) * 100) / 100; if (kk !== h.lastK) { h.lastK = kk; h.cd.setAttribute('stroke-dashoffset', (119.4 * (1 - kk)).toFixed(1)); }
      const cls = busy ? 'busy' : S.prey ? 'prey' : 'far'; if (cls !== h.lastC) { h.lastC = cls; h.ring.className = cls; }
      // saliva in the ammo counter: spits ready / pool
      const n = Math.floor(S.saliva / C.spit.cost); P.ammo = n; P.mag = Math.round(C.spit.pool / C.spit.cost); P.reserve = 0;
      setHTML('hAmmo', `${n}<small> spit · ${Math.round(S.saliva)}%</small>`);
    }
    // bite confirm: the jaws close on the crosshair in 0.08 s, hold, fade (timed on the weapon's clock)
    if (FT.hitT > 0) { FT.hitT -= dt; const age = FT.hitDur - FT.hitT, close = Math.min(1, age / .07), fade = clamp(FT.hitT / .22, 0, 1);
      setStyle(h.hit, 'opacity', fade.toFixed(2)); h.hju.style.transform = `translateY(${(-26 * (1 - close)).toFixed(1)}px)`; h.hjl.style.transform = `translateY(${(26 * (1 - close)).toFixed(1)}px)`; }
    else setStyle(h.hit, 'opacity', '0');
    const pv = FT.myPoison > 0 ? clamp(FT.myPoison / 1.2, 0, 1) * (.75 + .25 * Math.sin(G.time * 6)) : 0; FT.myPoison = Math.max(0, (FT.myPoison || 0) - dt);
    setStyle(h.pois, 'opacity', pv.toFixed(2));
  }
  function biteConfirm(dmg, crit, kill, small) {
    const h = hud(); FT.hitT = FT.hitDur = small ? .3 : .42; h.hit.className = kill ? 'kill' : crit ? 'crit' : ''; h.hb.textContent = (kill ? 'DEVOURED ' : crit ? 'HEAD ' : '') + '-' + Math.round(dmg);
    h.hit.style.transform = `scale(${small ? .6 : kill ? 1.2 : 1})`; }
  function bitten() { const h = hud(); h.bit.classList.remove('on'); void h.bit.offsetWidth; h.bit.classList.add('on'); }

  /* ================= prey sense: is someone biteable under the crosshair? ================= */
  function senseprey() {
    S.prey = false; S.preyD = 99; if (state !== 'play' || P.weapon !== 'flytrap') return;
    camera.getWorldDirection(_a); let best = 99;
    for (const e of entities()) { if (e === PLAYER_ENT || !entAlive(e)) continue; for (const f of [entChest, entEye]) { const p = f(e, _b), v = _c.subVectors(p, camera.position), d = v.length(); if (d > C.bite.range + .4) continue;
      const off = v.normalize().dot(_a); if (off < .985) continue; const lat = Math.sqrt(Math.max(0, 1 - off * off)) * d; if (lat < .55 && d < best && lineOfSight(camera.position, p)) best = d; } }
    if (best < 99) { S.prey = true; S.preyD = best; }
  }

  /* ================= per-frame ================= */
  let lastPre = performance.now();
  function update(dt) {
    const t0 = performance.now(); dt *= FT.timeK != null ? FT.timeK : 1;   // timeK < 1: slow motion for frame captures (tests only)
    try {
      const mine = P.weapon === 'flytrap', alive = state === 'play' && !P.dead;
      // saliva: regenerates after a short pause
      S.spitCd = Math.max(0, S.spitCd - dt); S.regenT -= dt; if (S.regenT <= 0) S.saliva = Math.min(C.spit.pool, S.saliva + C.spit.regenPerSec * dt);
      if (mine && alive && (S.spitHeld || S.spitQ > 0)) { if (startSpit()) S.spitQ = 0; } S.spitQ = Math.max(0, (S.spitQ || 0) - dt);
      if (!mine) S.spitHeld = false;
      S.preyT -= dt; if (S.preyT <= 0) { S.preyT = .08; senseprey(); }
      { const a0 = performance.now(); for (const b of BITES) if (b.phase !== 'done' && b.kind !== 'kc') b.update(dt); const q = (FT.perf.parts || (FT.perf.parts = {})).bites || (FT.perf.parts.bites = { total: 0, max: 0 }); const d = performance.now() - a0; q.total += d; q.max = Math.max(q.max, d); }
      if (S.bite && (S.bite.phase === 'done' || P.dead)) { if (S.bite.phase !== 'done') S.bite.finish(); S.bite = null; updateHud(); }
      for (let i = BITES.length - 1; i >= 0; i--) if (BITES[i].phase === 'done') BITES.splice(i, 1);
      { const a0 = performance.now(); for (const g of GLOBS) if (!g.done) g.update(dt); const q = FT.perf.parts.globs || (FT.perf.parts.globs = { total: 0, max: 0 }); const d = performance.now() - a0; q.total += d; q.max = Math.max(q.max, d); }
      for (let i = GLOBS.length - 1; i >= 0; i--) if (GLOBS[i].done) GLOBS.splice(i, 1);
      const pt = FT.perf.parts || (FT.perf.parts = {}), tm = (k, f) => { const a = performance.now(); f(); const d = performance.now() - a; const q = pt[k] || (pt[k] = { total: 0, max: 0 }); q.total += d; if (d > q.max) q.max = d; };
      tm('poison', () => updatePoison(dt)); tm('puddles', () => updatePuddles(dt)); tm('tp', () => animTP(dt)); tm('hud', () => updateFtHud(dt));
      while (NETQ.length && G.time - NETQ._t[0] > 1.5) { NETQ.shift(); NETQ._t.shift(); }
    } catch (e) { warn(e); }
    const ms = performance.now() - t0; FT.perf.n++; FT.perf.total += ms; FT.perf.max = Math.max(FT.perf.max, ms);
  }
  function preRender() {
    const now = performance.now(), rdt = Math.min(.05, (now - lastPre) / 1000) * (FT.timeK != null ? FT.timeK : 1); lastPre = now;
    try {
      const kcOn = killcamTick();
      const dt = state === 'paused' ? 0 : rdt;
      for (const b of BITES) { const show = KCV.on ? b.kind === 'kc' : b.kind !== 'kc'; if (b.head) { b.head.g.visible = show && b.phase !== 'done'; b.head.tube.mesh.visible = b.head.g.visible; } if (show) b.pose(); }
      for (const pd of PUDDLES) if (pd.t > 0) pd.m.visible = !KCV.on;
      if (state === 'menu') for (const b of BITES) if (b.head) { b.head.g.visible = false; b.head.tube.mesh.visible = false; }
      if (WM.flytrap && WM.flytrap.group.visible) animVM(dt);
      FT.kcShowing = kcOn;
    } catch (e) { warn(e); }
  }

  /* ================= hooks into the game ================= */
  // (function declarations are global bindings: assigning the name replaces what the game calls)
  const _fire = fire; fire = function () { if (W().mode === 'flytrap') { if (state === 'play' && !P.dead && !S.bite) startBite(); return; } return _fire.apply(this, arguments); };
  const _rifleTP = rifleTP; rifleTP = function (kind) { if (kind === 'flytrap') return buildTP(); return _rifleTP.apply(this, arguments); };
  const _buildGunVM = buildGunVM; buildGunVM = function (id) { if (id === 'flytrap') return buildVM(); return _buildGunVM.apply(this, arguments); };
  const _poseBoomVM = poseBoomVM; poseBoomVM = function (dt) { const r = _poseBoomVM.apply(this, arguments); try { poseGunGroup(dt); } catch (e) { warn(e); } return r; };
  const _updateBoom = updateBoom; updateBoom = function (dt) { const r = _updateBoom.apply(this, arguments); update(dt); return r; };
  const _netSend = netSend; netSend = function () {
    const room = NET.room; if (!room || !NETQ.length || typeof room.presence !== 'function') return _netSend.apply(this, arguments);
    const pres = room.presence; room.presence = function (st) { try { if (st && typeof st === 'object') st.ft = NETQ.slice(); } catch (e) {} return pres.apply(this, arguments); };
    try { return _netSend.apply(this, arguments); } finally { room.presence = pres; }
  };
  const _netReceive = netReceive; netReceive = function (E, pr) {
    const r = _netReceive.apply(this, arguments);
    try { if (pr && Array.isArray(pr.ft) && E && E.r) for (const ev of pr.ft) { if (!Array.isArray(ev) || !(+ev[0] > (E.ftSeq || 0))) continue; E.ftSeq = +ev[0]; remoteEvent(E.r, ev); } } catch (e) { warn(e); }
    return r;
  };
  const _hurtPlayer = hurtPlayer; hurtPlayer = function (dmg, from, attacker, crit, weapon) {
    const hp0 = P.hp, r = _hurtPlayer.apply(this, arguments);
    try { if (P.hp < hp0 || P.dead) { if (weapon === 'flytrap') { bitten(); P.trauma = Math.min(1, P.trauma + .35); } if (weapon === 'ftspit' || weapon === 'ftpoison') FT.myPoison = Math.max(FT.myPoison || 0, weapon === 'ftspit' ? 1.6 : 1.2); } } catch (e) { warn(e); }
    return r;
  };
  // quiet poison ticks: no hit-confirm sound / big hitmarker on every tick (the damage numbers still show)
  const _hitmarker = hitmarker; hitmarker = function () { if (quietHits) return; return _hitmarker.apply(this, arguments); };
  { const oh = sfx.hit; sfx.hit = function () { if (quietHits) return; return oh.apply(this, arguments); }; }
  // deaths: "rip" (yanked toward the trap, a hole torn in the chest, goo) and "melt" (poison dissolves them)
  const _startDeathFx = startDeathFx; startDeathFx = function (r, dir, crit, weapon) {
    const res = _startDeathFx.apply(this, arguments);
    try { if (r.deathKind === 'rip') { r.deathVel.copy(dir).setY(0).normalize().multiplyScalar(-2.4); r.act.death.timeScale = 1.15; r.ftWound = woundOn(r); } if (r.deathKind === 'melt') { r.deathVel.multiplyScalar(.25); r.act.death.timeScale = .6; } } catch (e) { warn(e); }
    return res;
  };
  const _updateDeathFx = updateDeathFx; updateDeathFx = function (r, dt) {
    const k = r.deathKind;
    if (k === 'rip') { try { const t = r.deadT, p = r.root.position;
      if (t < 1.2 && Math.random() < 1 - t / 1.2) { const c = _a.set(p.x, p.y + lerp(1.2, .4, clamp(t / 1, 0, 1)), p.z); SMOKE.spawn(c, rand(-1.5, 1.5), rand(.5, 2.5), rand(-1.5, 1.5), .26, .02, .06, rand(.04, .07), rand(.4, .8), 9, 1, .02, .9); if (Math.random() < .4) FX.spawn(c, rand(-1, 1), rand(.5, 2), rand(-1, 1), ...C.weapon.glow, .03, .35, 6, 1); }
      if (t < .25 && r.B && r.B.spine1) rotateBoneWorld(r.B.spine1, UPV, Math.sin(t * 40) * .12); } catch (e) { warn(e); } return _updateDeathFx.apply(this, arguments); }
    if (k === 'melt') { try { const t = r.deadT, p = r.root.position, c = clamp(t / 1.3, 0, 1);
      if (!r.bodyCol) r.bodyCol = r.body.color.clone(); r.body.color.copy(r.bodyCol).lerp(_q.set(.12, .3, .03), c); r.body.emissive.setRGB(.15 * c, .5 * c, .05 * c);
      if (Math.random() < .8) FX.spawn(_a.set(p.x + rand(-.35, .35), p.y + rand(.1, 1.4) * (1 - c * .6), p.z + rand(-.35, .35)), rand(-.2, .2), rand(.5, 1.6), rand(-.2, .2), ...C.weapon.glow, rand(.03, .06), rand(.4, .8), -1, 1, .02, .9);
      if (Math.random() < .5) SMOKE.spawn(_a.set(p.x, p.y + .3, p.z), rand(-.4, .4), rand(.4, 1), rand(-.4, .4), .2, .32, .08, rand(.2, .35), rand(.8, 1.4), -.3, 1.2, .6, .45);
      if (t > 1.5) { const k2 = clamp((t - 1.5) / .9, 0, 1); for (const m of [r.body, r.visor]) { if (!m.transparent) { m.transparent = true; m.depthWrite = false; m.needsUpdate = true; } m.opacity = 1 - k2; } if (k2 >= 1) r.root.visible = false; }
      } catch (e) { warn(e); } return true; }
    return _updateDeathFx.apply(this, arguments);
  };
  const _resetDeathFx = resetDeathFx; resetDeathFx = function (r) { try { if (r.ftWound) { r.ftWound.parent && r.ftWound.parent.remove(r.ftWound); r.ftWound = null; } } catch (e) {} return _resetDeathFx.apply(this, arguments); };
  let WOUND_GEO = null;
  function woundOn(r) {   // the torn-out hole: a dark, glistening crater on the chest, edged with glowing saliva
    const bone = r.B && (r.B.spine2 || r.B.spine1); if (!bone) return null;
    if (!WOUND_GEO) WOUND_GEO = new THREE.SphereGeometry(.11, 14, 10);
    const g = new THREE.Group(), w = new THREE.Mesh(WOUND_GEO, new THREE.MeshStandardMaterial({ color: new THREE.Color(.12, .005, .02), roughness: .15, emissive: new THREE.Color(.05, 0, .01) }));
    w.scale.set(1, .85, .45); g.add(w);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(.1, .016, 6, 18), new THREE.MeshBasicMaterial({ color: GLOWC().multiplyScalar(.7) })); rim.scale.set(1, .85, 1); g.add(rim);
    // on the side facing the trap (deathVel points at the shooter): placed in world space, then carried by the bone
    bone.updateMatrixWorld(true); bone.getWorldPosition(_a); const tw = _b.set(r.deathVel.x, 0, r.deathVel.z); if (tw.lengthSq() < 1e-6) tw.set(0, 0, 1); tw.normalize();
    scene.add(g); g.position.copy(_a).addScaledVector(tw, .13); g.lookAt(_c.copy(g.position).add(tw)); g.updateMatrixWorld(true); bone.attach(g); return g;
  }
  const _clearDynamic = clearDynamic; clearDynamic = function () {
    const r = _clearDynamic.apply(this, arguments);
    try { for (const b of BITES) if (b.phase !== 'done') b.finish(); BITES.length = 0; S.bite = null; for (const g of GLOBS) if (!g.done) g.kill(); GLOBS.length = 0; POISON.clear(); for (const pd of PUDDLES) { pd.t = 0; pd.m.visible = false; } S.saliva = C.spit.pool; } catch (e) { warn(e); }
    return r;
  };
  const _updateHud = updateHud; updateHud = function () { const r = _updateHud.apply(this, arguments); try { if (P.weapon === 'flytrap' && state !== 'menu') { const n = Math.floor(S.saliva / C.spit.cost); setHTML('hAmmo', `${n}<small> spit · ${Math.round(S.saliva)}%</small>`); } } catch (e) {} return r; };
  const _arsenalHTML = arsenalHTML; arsenalHTML = function () { return _arsenalHTML.apply(this, arguments).replace('assets/ui/w_flytrap.png', 'assets/models/weapons/flytrap/card.png'); };
  { const cr = composer.render; composer.render = function () { preRender(); return cr.apply(this, arguments); }; }
  // right click = spit (instead of aiming down sights): caught before the game's own handler
  addEventListener('mousedown', e => {
    if (e.button !== 2 || state !== 'play' || P.weapon !== 'flytrap') return;
    e.stopPropagation(); S.spitHeld = true; S.spitQ = .25;   // a quick click still spits (queued a moment if on cooldown) if (!document.pointerLockElement) try { lock(); } catch (er) {}
  }, true);
  addEventListener('mouseup', e => { if (e.button === 2) S.spitHeld = false; }, true);
  addEventListener('blur', () => { S.spitHeld = false; });

  /* ================= build what the game already made before this module loaded ================= */
  loadModel();
  try { if (typeof gunScene !== 'undefined' && !WM.flytrap && (WM.carbine || WM.knife)) WM.flytrap = buildVM(); } catch (e) { warn(e); }
  FT.ready = true;
  // test / debug handles
  Object.assign(FT, { startBite, startSpit, poison, Bite, Glob, sweep, remoteEvent, S, GLOBS, PUDDLES, POISON, TPS, HEADS, KCV, buildTP, buildVM, animVM, update, preRender });
})();
