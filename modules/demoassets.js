/* Sector Nine - DEMOLITION mode art (charge, defuse kit, bomb sites, HUD icons).
   Models: assets/models/demo/demo.js (GLB as base64, built by render/demo/demo.py; same data as demo.gltf.json).
   Usage (see demoassets.INTEGRATE.md):
     await S9Demo.load();
     const c = S9Demo.makeCharge('planted'); scene.add(c); c.setTime(40); c.setBlink(1);
     S9Demo.attachCarried(bot)  /  S9Demo.attachKit(bot)  /  S9Demo.makeSite('A')
   Everything is unlit-cheap: no lights are added, materials are shared between copies (only the LED and the
   screen are per charge, so every charge can blink / count down on its own). */
(function () {
  'use strict';
  const T = window.THREE;
  const ICON_DIR = 'assets/ui/demo/';
  const ICON_NAMES = ['bomb_carried', 'bomb_dropped', 'bomb_planted', 'defuse_kit', 'site_a', 'site_b', 'team_strike', 'team_sentinels'];
  const camel = s => s.replace(/_(\w)/g, (m, c) => c.toUpperCase());
  const icons = {}, iconsSmall = {}, emblems = {};
  for (const n of ICON_NAMES) { icons[camel(n)] = ICON_DIR + n + '.png'; iconsSmall[camel(n)] = ICON_DIR + n + '_48.png'; }
  emblems.strike = ICON_DIR + 'team_strike_256.png'; emblems.sentinels = ICON_DIR + 'team_sentinels_256.png';

  // where each prop sits on the soldier (bot root space, bind pose; measured by render/demo/probe_spine.js):
  // the charge rests on the back armour plate, the kit clips onto the back of the belt, right of the spine.
  const MOUNT = {
    // the back plate leans back ~8.5 deg (deeper at the shoulders), so the charge is tilted to sit flush on it
    carried: { bone: 'mixamorigSpine2', pos: [0, 1.35, -0.205], rx: -0.15 },
    kit: { bone: 'mixamorigHips', pos: [-0.1, 1.07, -0.15], rx: 0 }
  };
  // fallback when the soldier rig can't be read: bone frames in bind pose (world quaternion = identity, scale 0.01)
  const BONE_BIND = { mixamorigSpine2: [0.0003, 1.3935, -0.0372], mixamorigHips: [0.002, 1.061, 0.011] };

  const S = { ready: false, tpl: {}, meta: {}, mats: null, local: {} };
  let loading = null;

  function b64(str) { const bin = atob(str), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; }
  function script(src, key) {
    return new Promise(res => {
      if (window.S9A && window.S9A[key]) return res(window.S9A[key]);
      const s = document.createElement('script'); s.src = src;
      s.onload = () => res((window.S9A || {})[key] || null); s.onerror = () => res(null); document.head.appendChild(s);
    });
  }

  function makeMats() {
    const std = (rough, metal, env) => new T.MeshStandardMaterial({ vertexColors: true, roughness: rough, metalness: metal, envMapIntensity: env });
    const M = {
      d_paint: std(.5, .05, .45),          // painted shells keep their colour (little reflection) in dark maps
      d_metal: std(.34, .75, 1.2),
      d_rubber: std(.82, 0, .5),
      d_keys: std(.5, .1, .8),
      // glow: vertex colour pushed past 1 so the game's bloom picks it up (no real lights)
      d_glow: new T.MeshBasicMaterial({ vertexColors: true, color: new T.Color(2.2, 2.2, 2.2), toneMapped: false }),
      d_decal: new T.MeshBasicMaterial({ vertexColors: true, color: new T.Color(1.15, 1.15, 1.15), transparent: true, opacity: .82, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, toneMapped: false }),
      d_holo: new T.MeshBasicMaterial({ vertexColors: true, color: new T.Color(1.6, 1.6, 1.6), transparent: true, opacity: .55, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false })
    };
    // soft contact shadow under props that stand on the floor (one shared texture, no lights)
    const cv = document.createElement('canvas'); cv.width = cv.height = 64; const x = cv.getContext('2d'), gr = x.createRadialGradient(32, 32, 2, 32, 32, 31);
    gr.addColorStop(0, 'rgba(0,0,0,0.75)'); gr.addColorStop(.55, 'rgba(0,0,0,0.4)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
    M.d_blob = new T.MeshBasicMaterial({ map: new T.CanvasTexture(cv), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    for (const k in M) { M[k].name = k; M[k].userData.keep = true; }
    S.blobGeo = new T.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    return M;
  }

  // merge each piece's meshes per material (one draw call per material per piece)
  function ingest(gltf) {
    gltf.scene.updateMatrixWorld(true);
    for (const root of gltf.scene.children) {
      if (!root.name.startsWith('d_')) continue;
      const name = root.name.slice(2), inv = root.matrixWorld.clone().invert(), parts = [];
      root.traverse(o => {
        if (!o.isMesh) return;
        const g = o.geometry.clone().applyMatrix4(new T.Matrix4().multiplyMatrices(inv, o.matrixWorld));
        for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) g.deleteAttribute(k);
        const a = g.attributes.color;
        if (a) { const f = new Float32Array(a.count * 3); for (let i = 0; i < a.count; i++) { f[i * 3] = a.getX(i); f[i * 3 + 1] = a.getY(i); f[i * 3 + 2] = a.getZ(i); } g.setAttribute('color', new T.BufferAttribute(f, 3)); }
        g.computeBoundingSphere(); g.computeBoundingBox();
        parts.push({ m: (o.material && o.material.name || '').replace(/\.\d+$/, ''), geo: g });
      });
      S.tpl[name] = parts;
    }
  }

  // bone-local transform for a mount: computed from the soldier rig in bind pose when it is available
  function computeLocal() {
    const out = {};
    let model = null;
    try {
      // the game's loaded soldier (index.html top-level const ASSET), else the soldier GLB the page already holds
      // eslint-disable-next-line no-undef
      const A = typeof ASSET !== 'undefined' ? ASSET : window.ASSET;
      const src = (A && A.soldier && A.soldier.scene) || (S.soldierGltf && S.soldierGltf.scene) || null;
      if (src && T.SkeletonUtils) model = T.SkeletonUtils.clone(src);
    } catch (e) { model = null; }
    const root = new T.Group();
    if (model) { model.rotation.y = Math.PI; root.add(model); model.traverse(o => { if (o.isSkinnedMesh) o.skeleton.pose(); }); root.updateMatrixWorld(true); }
    for (const [k, m] of Object.entries(MOUNT)) {
      const want = new T.Matrix4().makeRotationX(m.rx || 0).setPosition(m.pos[0], m.pos[1], m.pos[2]);
      const bone = model && model.getObjectByName(m.bone);
      let bw;
      if (bone) bw = bone.matrixWorld.clone();
      else { const p = BONE_BIND[m.bone]; bw = new T.Matrix4().compose(new T.Vector3(p[0], p[1], p[2]), new T.Quaternion(), new T.Vector3(.01, .01, .01)); }
      const L = bw.clone().invert().multiply(want), pos = new T.Vector3(), q = new T.Quaternion(), sc = new T.Vector3();
      L.decompose(pos, q, sc); out[k] = { bone: m.bone, pos, q, sc, measured: !!bone };
    }
    return out;
  }

  function load() {
    if (loading) return loading;
    loading = (async () => {
      if (!T || !T.GLTFLoader) throw new Error('S9Demo: THREE / GLTFLoader missing');
      const str = await script((S9Demo.base || '') + 'assets/models/demo/demo.js', 'demo');
      if (!str) throw new Error('S9Demo: assets/models/demo/demo.js failed to load');
      const gltf = await new Promise((res, rej) => new T.GLTFLoader().parse(b64(str), '', res, rej));
      window.S9A.demo = null;                       // free the base64 copy
      S.mats = makeMats(); ingest(gltf);
      // eslint-disable-next-line no-undef
      const A = typeof ASSET !== 'undefined' ? ASSET : window.ASSET;
      if (!(A && A.soldier) && window.S9A && window.S9A.soldier)
        S.soldierGltf = await new Promise(res => new T.GLTFLoader().parse(b64(window.S9A.soldier), '', res, () => res(null)));
      S.local = computeLocal(); S.soldierGltf = null;
      // bots are freed with freeBotGpu(), which disposes every geometry/material under the bot. Take our props off first
      // so the shared prop geometry and materials survive (wraps the game's global removeRobot once).
      if (typeof window.removeRobot === 'function' && !window.removeRobot.__s9demo) {
        const orig = window.removeRobot;
        window.removeRobot = function (r) { try { if (r && r.model) { const mine = []; r.model.traverse(o => { if (o.userData && o.userData.demo && o !== r.model) mine.push(o); }); mine.forEach(detach); } } catch (e) { /* never block the game */ } return orig.apply(this, arguments); };
        window.removeRobot.__s9demo = true;
      }
      // icons: start downloading so the HUD can show them instantly
      S.iconImg = {};
      for (const n of ICON_NAMES) { const im = new Image(); im.src = (S9Demo.base || '') + ICON_DIR + n + '.png'; S.iconImg[camel(n)] = im; }
      S.ready = true;
      return S9Demo;
    })();
    return loading;
  }

  function need() { if (!S.ready) throw new Error('S9Demo: call await S9Demo.load() first'); }

  function build(name) {
    need();
    const parts = S.tpl[name]; if (!parts) throw new Error('S9Demo: no piece ' + name);
    const g = new T.Group(); g.name = 'demo_' + name;
    for (const { m, geo } of parts) {
      const mesh = new T.Mesh(geo, S.mats[m] || S.mats.d_paint);
      mesh.name = name + ':' + m.replace(/^d_/, '');
      mesh.castShadow = false; mesh.receiveShadow = false;
      if (m === 'd_decal' || m === 'd_holo') mesh.renderOrder = 2;
      g.add(mesh);
    }
    // contact shadow for floor props
    const blob = { charge_planted: [.62, .5], kit: [.42, .28] }[name];
    if (blob) { const b = new T.Mesh(S.blobGeo, S.mats.d_blob); b.name = name + ':shadow'; b.scale.set(blob[0], 1, blob[1]); b.position.y = .004; b.renderOrder = 1; g.add(b); }
    g.userData.demo = name;
    return g;
  }

  // ---------------------------------------------------------------- the charge: LED blink + countdown screen
  const SCR_W = 256, SCR_H = 114;
  function drawScreen(st) {
    const c = st.ctx, W = SCR_W, H = SCR_H;
    const hot = st.defuse == null && st.time <= 10, blue = st.defuse != null;
    const idle = st.idle && !blue;
    const fg = blue ? '#7fd4ff' : hot && !idle ? '#ff4030' : '#ff9a2a', bg = blue ? '#02101e' : hot && !idle ? '#1e0302' : '#170502';
    c.fillStyle = bg; c.fillRect(0, 0, W, H);
    c.fillStyle = 'rgba(255,255,255,0.05)'; for (let y = 0; y < H; y += 4) c.fillRect(0, y, W, 1);       // scanlines
    // little face: grins while armed, angry in the last 10 s, worried while being defused
    const cx = 44, cy = 48, r = 30; c.strokeStyle = fg; c.fillStyle = fg; c.lineWidth = 4;
    c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.stroke();
    if (blue) {
      for (const e of [-1, 1]) { c.beginPath(); c.arc(cx + e * 11, cy - 6, 5, 0, Math.PI * 2); c.fill(); }
      c.beginPath(); c.arc(cx, cy + 14, 6, 0, Math.PI * 2); c.fill();
    } else {
      for (const e of [-1, 1]) { c.beginPath(); c.moveTo(cx + e * 18, cy - (hot ? 16 : 13)); c.lineTo(cx + e * 5, cy - 6); c.lineTo(cx + e * 18, cy - 2); c.fill(); }
      c.beginPath();
      if (hot) { c.moveTo(cx - 16, cy + 16); c.lineTo(cx, cy + 8); c.lineTo(cx + 16, cy + 16); c.stroke(); }
      else { c.moveTo(cx - 17, cy + 4); c.lineTo(cx + 17, cy + 4); c.quadraticCurveTo(cx, cy + 26, cx - 17, cy + 4); c.fill(); }
    }
    // time
    const t = Math.max(0, st.time), m = Math.floor(t / 60), s = Math.floor(t % 60), tenth = Math.floor((t * 10) % 10);
    const txt = idle ? '--:--' : t < 10 ? s + '.' + tenth : m + ':' + String(s).padStart(2, '0');
    c.fillStyle = fg; c.font = 'bold 62px Bahnschrift, "Arial Narrow", Arial, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(txt, 168, 50);
    // bar: time left (or defuse progress, blue)
    const frac = blue ? st.defuse : idle ? 1 : (st.total > 0 ? t / st.total : 1);
    c.strokeStyle = fg; c.lineWidth = 3; c.strokeRect(8, H - 22, W - 16, 14);
    c.fillStyle = fg; c.fillRect(11, H - 19, Math.max(0, (W - 22) * Math.min(1, frac)), 8);
    st.tex.needsUpdate = true;
  }

  function makeCharge(kind = 'planted') {
    if (kind === 'dropped') {
      // dropped = the carried charge lying on its mount plate (pads on the floor), with a contact shadow
      const w = new T.Group(), c = makeCharge('carried'); w.name = 'demo_charge_dropped';
      c.rotation.x = Math.PI / 2; c.position.y = .013; w.add(c);
      const b = new T.Mesh(S.blobGeo, S.mats.d_blob); b.name = 'charge_dropped:shadow'; b.scale.set(.6, 1, .42); b.position.y = .004; b.renderOrder = 1; w.add(b);
      for (const k of ['setTime', 'setBlink', 'setDefuse']) w[k] = (...a) => { c[k](...a); return w; };
      w.dispose = () => { c.dispose(); if (w.parent) w.parent.remove(w); };
      w.userData = Object.assign({}, c.userData, { demo: 'charge_dropped' });
      return w;
    }
    const name = kind === 'carried' ? 'charge_carried' : 'charge_planted';
    const g = build(name);
    const canvas = document.createElement('canvas'); canvas.width = SCR_W; canvas.height = SCR_H;
    const tex = new T.CanvasTexture(canvas); tex.encoding = T.sRGBEncoding; tex.anisotropy = 4;
    // idle: no countdown yet (a carried charge just grins and shows S9); the first setTime() starts showing time
    const st = { ctx: canvas.getContext('2d'), tex, time: 40, total: 40, shown: '', defuse: null, idle: true, blink: kind === 'planted' ? 1 : 0, t0: performance.now() };
    const screenMat = new T.MeshBasicMaterial({ map: tex, toneMapped: false, color: new T.Color(1.5, 1.5, 1.5) });
    const ledMat = new T.MeshBasicMaterial({ color: new T.Color(3, .35, .1), toneMapped: false });
    const ledOn = new T.Color(3, .35, .1), ledOff = new T.Color(.25, .03, .01), ledBlue = new T.Color(.3, 1.4, 3);
    let led = null, screen = null, keypad = null;
    for (const m of g.children) {
      if (m.name.endsWith(':screen')) { m.material = screenMat; screen = m; }
      else if (m.name.endsWith(':led')) { m.material = ledMat; led = m; }
      else if (m.name.endsWith(':keys')) keypad = m;
    }
    // blink runs on its own while the LED is drawn (no per-frame call needed from the game)
    if (led) led.onBeforeRender = () => {
      const now = performance.now();
      let on = true;
      if (st.blink > 0) on = ((now - st.t0) / 1000 * st.blink) % 1 < .5;
      ledMat.color.copy(on ? (st.defuse != null ? ledBlue : ledOn) : ledOff);
    };
    const redraw = () => {
      const t = Math.max(0, st.time), key = (st.idle ? 'idle' : (t < 10 ? Math.floor(t * 10) : Math.floor(t))) + '|' + (st.defuse == null ? '' : Math.round(st.defuse * 100)) + '|' + st.total;
      if (key !== st.shown) { st.shown = key; drawScreen(st); }
    };
    redraw();
    g.userData.led = led; g.userData.screen = screen; g.userData.keypad = keypad; g.userData.state = st;
    g.userData.ownMats = [screenMat, ledMat]; g.userData.ownTex = [tex];
    /** seconds left on the countdown; the first call (or total) sets the full length for the bar; null = idle face */
    g.setTime = (sec, total) => { st.idle = sec == null; if (sec == null) { redraw(); return g; } if (total != null) st.total = total; else if (st.total < sec) st.total = sec; st.time = sec; redraw(); return g; };
    /** LED blinks per second (0 = steady on). Typical: 1 when planted, 2 under 20 s, 5 under 5 s */
    g.setBlink = rate => { st.blink = Math.max(0, +rate || 0); return g; };
    /** defuse progress 0..1 turns the screen + LED blue; null = back to the countdown */
    g.setDefuse = frac => { st.defuse = frac == null ? null : Math.max(0, Math.min(1, frac)); redraw(); return g; };
    g.dispose = () => { screenMat.dispose(); ledMat.dispose(); tex.dispose(); if (g.parent) g.parent.remove(g); };
    return g;
  }

  function makeKit(kind = 'ground') { return build(kind === 'belt' ? 'kit_belt' : 'kit'); }

  function makeSite(id) {
    const L = String(id).toUpperCase() === 'B' || id === 1 ? 'b' : 'a';
    const g = build('site_' + L);
    // the holo panel shimmers a little (cheap: just the shared material's opacity, once per frame)
    // beacon: a thin additive light column rising from the sign so the site can be found across the map (no light)
    if (!S.beacon) {
      const cv = document.createElement('canvas'); cv.width = 4; cv.height = 128; const x = cv.getContext('2d'), gr = x.createLinearGradient(0, 128, 0, 0);
      gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(.25, 'rgba(255,255,255,0.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = gr; x.fillRect(0, 0, 4, 128);
      const tex = new T.CanvasTexture(cv), geo = new T.CylinderGeometry(.2, .38, 9, 10, 1, true).translate(0, 4.5, 0);
      const mk = c => { const m = new T.MeshBasicMaterial({ map: tex, color: c, transparent: true, opacity: .8, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false }); m.userData.keep = true; m.name = 'd_beacon'; return m; };
      S.beacon = { geo, a: mk(new T.Color(1.6, .85, .15)), b: mk(new T.Color(.85, .4, 1.6)) };
    }
    const bc = new T.Mesh(S.beacon.geo, S.beacon[L]); bc.name = 'site_' + L + ':beacon'; bc.position.set(3.15, 3.58, 0); bc.renderOrder = 3; g.add(bc);
    const holo = g.children.find(m => m.name.endsWith(':holo'));
    if (holo) holo.onBeforeRender = () => { S.mats.d_holo.opacity = .45 + .12 * Math.sin(performance.now() / 260) + .05 * Math.sin(performance.now() / 37); };
    return g;
  }

  function attach(bot, which, obj) {
    const m = S.local[which], bone = bot && bot.model && bot.model.getObjectByName(m.bone);
    if (!bone) return null;
    // the worn charge is 10 % smaller so the cells clear the arms when the soldier aims (scaled about the pad face,
    // so the mount still sits on the armour)
    obj.position.copy(m.pos); obj.quaternion.copy(m.q); obj.scale.copy(m.sc).multiplyScalar(which === 'carried' ? .9 : 1);
    obj.traverse(o => { o.frustumCulled = false; });     // skinned parents move the mesh outside its static bounds
    bone.add(obj); return obj;
  }
  /** put a carried charge on a bot / remote player built by buildBot (rides on the Spine2 bone) */
  function attachCarried(bot) { need(); const c = makeCharge('carried'); c.setBlink(0); return attach(bot, 'carried', c); }
  /** clip a defuse kit onto the back of a bot's belt (Hips bone) */
  function attachKit(bot) { need(); return attach(bot, 'kit', makeKit('belt')); }
  function detach(obj) { if (obj && obj.parent) obj.parent.remove(obj); if (obj && obj.dispose) obj.dispose(); }

  /** compile every material once so the first plant / pickup doesn't hitch */
  function warmup(renderer, scene, camera) {
    need();
    const g = new T.Group(); g.add(makeCharge('planted'), makeCharge('carried'), makeKit(), makeKit('belt'), makeSite('A'), makeSite('B'));
    g.position.set(0, -500, 0); scene.add(g);
    try { renderer.compile(scene, camera); } finally { scene.remove(g); g.children.forEach(c => c.dispose && c.dispose()); }
  }

  function tris(obj) {
    let n = 0, calls = 0;
    obj.traverse(o => { if (o.isMesh) { calls++; const gg = o.geometry; n += (gg.index ? gg.index.count : gg.attributes.position.count) / 3; } });
    return { tris: n, calls };
  }

  // rank badges belong to the badges module; keep the old entry points working by delegating to it
  const badges = {
    rank: i => (window.S9Badges && window.S9Badges.rank) ? window.S9Badges.rank(i) : 'assets/ui/badges/rank_' + i + '.png',
    small: i => (window.S9Badges && window.S9Badges.small) ? window.S9Badges.small(i) : 'assets/ui/badges/rank_' + i + '_64.png'
  };

  const S9Demo = window.S9Demo = {
    base: '', load, get ready() { return S.ready; },
    makeCharge, makeKit, makeSite, attachCarried, attachKit, detach, warmup, tris,
    icons, iconsSmall, emblems, badges,
    iconImage: name => S.iconImg && S.iconImg[name],
    get mounts() { return S.local; }, get pieces() { return Object.keys(S.tpl); }
  };
})();
