/* Sector Nine add-on: proper first-person gloved hands for every weapon (modules/hands.js)
   - assets/models/hands/glove.gltf.json   one rigged tactical glove + forearm sleeve (Blender: render/hands/glove.py)
   - assets/models/hands/hands_poses.json  grip poses (bone rotations) per weapon family + where each hand sits per weapon
   How it works: the rig is posed once per grip pose and baked into ONE static mesh per hand (left = mirror of right),
   all hands share one material (zone colours in the shader), so every hand is one draw call and costs no skinning.
   The old primitive hands stay in the viewmodel (other code still finds them) but move to a layer the gun camera never
   draws. New hands are added to the SAME groups the old ones lived in (reload / feeding / boomerang animations still
   move them) at fixed, data-driven transforms: they look identical on every equip. Guns, sights, ADS are untouched.
   Hooks (no index.html edits): wraps setModel, so any (re)built viewmodel (gunpolish rebuilds, flytrap / poopgun add-ons)
   gets hands before it is shown; a cheap per-frame check on the gun scene catches anything else.
   API: window.S9Hands = { ready, error, report(), enable(), disable(), reload(poses?), applyAll(), geo(pose, side) } */
(function () {
  'use strict';
  if (window.S9Hands && window.S9Hands.loaded) return;
  const T = THREE, D2R = Math.PI / 180, HIDE = 31;   // layer for the old primitive hands (gunCam renders layer 0 only)
  const ROOT = (() => { try { const s = document.currentScript && document.currentScript.src; if (s && /modules\//.test(s)) return s.split('modules/')[0]; } catch (e) {} return new URL('.', location.href).href; })();
  const ZONES = ['hand_glove', 'hand_plate', 'hand_pad', 'hand_cuff', 'hand_glow', 'hand_sleeve'];
  const H = window.S9Hands = { loaded: true, ready: false, error: null, on: true, gen: 1, stats: { applied: 0, bakes: 0, bakeMs: 0 } };
  const warn = e => { try { console.warn('[hands]', e); } catch (_) {} };
  const gv = n => { try { return (0, eval)(n); } catch (e) { return undefined; } };

  /* ------------------------------------------------------------------ load + bake */
  let RIG = null, POSES = null, MAT = null;
  const GEO = new Map();   // pose key + side -> BufferGeometry
  function parseRig(gltf) {
    const meshes = []; let skel = null;
    gltf.scene.traverse(o => { if (o.isSkinnedMesh) { meshes.push(o); skel = o.skeleton; } });
    if (!meshes.length) throw new Error('glove: no skinned mesh');
    const bones = skel.bones, by = {}; bones.forEach((b, i) => { by[b.name] = b; });
    gltf.scene.updateMatrixWorld(true);
    return { scene: gltf.scene, meshes, skel, bones, by, rest: bones.map(b => b.quaternion.clone()), handRest: by.hand.matrixWorld.clone() };
  }
  function setPose(bonesP) {
    const R = RIG, q = new T.Quaternion(), e = new T.Euler();
    R.bones.forEach((b, i) => b.quaternion.copy(R.rest[i]));
    for (const n in bonesP || {}) { const b = R.by[n], v = bonesP[n]; if (!b || !v) continue; e.set(v[0] * D2R, v[1] * D2R, v[2] * D2R, 'XYZ'); b.quaternion.multiply(q.setFromEuler(e)); }
    R.scene.updateMatrixWorld(true);
  }
  // pose name (+ per-weapon finger overrides) -> one merged static geometry in PALM space (wrist joint at the origin, palm
  // down, fingers toward -z, as in the rest pose); side 'L' mirrors it.
  function poseBones(name, extra) {
    const P = POSES.poses[name]; if (!P) throw new Error('hands: unknown pose ' + name);
    const out = Object.assign({}, P.from ? poseBones(P.from) : {}, P.bones || {});
    if (extra) for (const k in extra) out[k] = extra[k];
    return out;
  }
  const comp = (a, i, k) => k === 0 ? a.getX(i) : k === 1 ? a.getY(i) : k === 2 ? a.getZ(i) : a.getW(i);
  function geo(name, side, extra) {
    const key = name + '|' + side + '|' + (extra ? JSON.stringify(extra) : '');
    let g = GEO.get(key); if (g) return g;
    const t0 = performance.now(), R = RIG; setPose(poseBones(name, extra));
    const palm = new T.Matrix4().multiplyMatrices(R.handRest, new T.Matrix4().copy(R.by.hand.matrixWorld).invert());
    const pal3 = new T.Matrix3().setFromMatrix4(palm);
    const skinM = R.bones.map((b, i) => new T.Matrix4().multiplyMatrices(b.matrixWorld, R.skel.boneInverses[i]));
    let nv = 0, ni = 0; for (const m of R.meshes) { nv += m.geometry.attributes.position.count; ni += m.geometry.index.count; }
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), zone = new Float32Array(nv), idx = new Uint16Array(ni);
    const v = new T.Vector3(), n = new T.Vector3(), acc = new T.Matrix4(), tmp = new T.Matrix4(), n3 = new T.Matrix3();
    let ov = 0, oi = 0; const mir = side === 'L';
    for (const m of R.meshes) {
      const G = m.geometry, P = G.attributes.position, N = G.attributes.normal, U = G.attributes.uv, SI = G.attributes.skinIndex, SW = G.attributes.skinWeight, I = G.index.array;
      const z = Math.max(0, ZONES.indexOf((m.material && m.material.name) || '')), bind = m.bindMatrix;
      for (let i = 0; i < P.count; i++) {
        acc.elements.fill(0);
        for (let k = 0; k < 4; k++) { const w = comp(SW, i, k); if (!w) continue; tmp.multiplyMatrices(skinM[comp(SI, i, k)], bind); for (let e = 0; e < 16; e++) acc.elements[e] += tmp.elements[e] * w; }
        v.fromBufferAttribute(P, i).applyMatrix4(acc).applyMatrix4(palm);
        n.fromBufferAttribute(N, i).applyMatrix3(n3.setFromMatrix4(acc)).applyMatrix3(pal3).normalize();
        const o = (ov + i) * 3; pos[o] = mir ? -v.x : v.x; pos[o + 1] = v.y; pos[o + 2] = v.z; nor[o] = mir ? -n.x : n.x; nor[o + 1] = n.y; nor[o + 2] = n.z;
        if (U) { uv[(ov + i) * 2] = U.getX(i); uv[(ov + i) * 2 + 1] = U.getY(i); }
        zone[ov + i] = z;
      }
      for (let k = 0; k < I.length; k += 3) { idx[oi + k] = I[k] + ov; idx[oi + k + 1] = I[mir ? k + 2 : k + 1] + ov; idx[oi + k + 2] = I[mir ? k + 1 : k + 2] + ov; }
      ov += P.count; oi += I.length;
    }
    g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setAttribute('normal', new T.BufferAttribute(nor, 3));
    g.setAttribute('uv', new T.BufferAttribute(uv, 2)); g.setAttribute('zone', new T.BufferAttribute(zone, 1)); g.setIndex(new T.BufferAttribute(idx, 1));
    g.computeBoundingSphere(); g.computeBoundingBox(); g.userData.s9hand = key;
    setPose(null);
    GEO.set(key, g); H.stats.bakes++; H.stats.bakeMs += performance.now() - t0;
    return g;
  }

  /* ------------------------------------------------------------------ the one shared material */
  // zone colours (linear) + roughness/metalness; the glove fabric and sleeve follow the worn soldier skin (skins.js recolours
  // GLOVE_M / SLEEVE_M; we mirror that tint), plates / pads / cuff / light strip stay team-neutral.
  const ZC = [[.040, .042, .047], [.140, .145, .156], [.070, .060, .049], [.085, .088, .096], [.3, .8, 1.0], [.030, .034, .032]];
  const ZRM = [[.66, .02], [.36, .55], [.86, 0], [.42, .45], [.3, 0], [.92, 0]];
  const GLOW = [.12, .62, .85];
  // fine synthetic-fabric weave (tiling normal map, made once): reads as glove cloth up close, calm at a distance
  function weave() {
    const N = 64, c = document.createElement('canvas'); c.width = c.height = N; const x = c.getContext('2d'), im = x.createImageData(N, N), h = new Float32Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const u = i / N * Math.PI * 16, v = j / N * Math.PI * 16, over = (Math.floor(i / 4) + Math.floor(j / 4)) % 2;
      h[j * N + i] = over ? Math.abs(Math.sin(u)) * .8 + .2 * Math.sin(v * .5) : Math.abs(Math.sin(v)) * .8 + .2 * Math.sin(u * .5); }
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const dx = h[j * N + (i + 1) % N] - h[j * N + (i + N - 1) % N], dy = h[((j + 1) % N) * N + i] - h[((j + N - 1) % N) * N + i];
      let nx = -dx * 1.2, ny = -dy * 1.2, nz = 1; const L = Math.hypot(nx, ny, nz); const o = (j * N + i) * 4; im.data[o] = (nx / L * .5 + .5) * 255; im.data[o + 1] = (ny / L * .5 + .5) * 255; im.data[o + 2] = (nz / L * .5 + .5) * 255; im.data[o + 3] = 255; }
    x.putImageData(im, 0, 0); const t = new T.CanvasTexture(c); t.wrapS = t.wrapT = T.RepeatWrapping; t.repeat.set(9, 9); t.anisotropy = 4; return t;
  }
  // full = PBR glove (fabric weave normal map); lite = weak tier (Performance): Lambert, no normal map, same zone colours.
  // Both share ONE uniform set (a skin change updates both) and both programs are compiled at load (warm()).
  let U = null, FLAT = null;
  function makeMat(lite) {
    const m = lite ? new T.MeshLambertMaterial({ color: 0xffffff }) : new T.MeshStandardMaterial({ color: 0xffffff, roughness: .6, metalness: 0, envMapIntensity: .3, normalMap: weave(), normalScale: new T.Vector2(.5, .5) });
    m.name = lite ? 's9_hands_lite' : 's9_hands';
    if (!U) { FLAT = new T.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1); FLAT.needsUpdate = true;
      U = { uZC: { value: ZC.map(c => new T.Vector3(...c)) }, uZRM: { value: ZRM.map(c => new T.Vector2(...c)) }, uGlow: { value: new T.Vector3(...GLOW) },
        uPat: { value: FLAT }, uPatK: { value: new T.Vector4(0, 0, 0, 1 / 34) }, uPatCol: { value: new T.Vector3() }, uPatZ: { value: new T.Vector2() } }; }
    m.userData.u = U;
    m.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, U);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float zone;\nvarying float vZone;\nvarying vec3 vHP;\nvarying vec3 vHN;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvZone = zone; vHP = position; vHN = normal;');
      // the skin's surface pattern (camo / pixels / scales / veins...): tri-planar in hand space at the body's scale (cm), mixed
      // exactly like the soldier body shader does (r = pattern colour, g = darken, b = glow), on the zones the skin's own hands use it
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vZone;\nvarying vec3 vHP;\nvarying vec3 vHN;\nuniform vec3 uZC[6];\nuniform vec2 uZRM[6];\nuniform vec3 uGlow;\nuniform sampler2D uPat;\nuniform vec4 uPatK;\nuniform vec3 uPatCol;\nuniform vec2 uPatZ;')
        .replace('#include <color_fragment>', '#include <color_fragment>\nint zi = int(vZone + .5);\ndiffuseColor.rgb *= uZC[zi];\nfloat s9pg = 0.;\nfloat pz = (zi == 0 || zi == 2) ? uPatZ.x : (zi == 5 ? uPatZ.y : 0.);\nif (pz > .5 && uPatK.x + uPatK.y + uPatK.z > 0.) { vec3 bp = vHP * 100. * uPatK.w; vec3 an = abs(normalize(vHN)); an /= (an.x + an.y + an.z + 1e-4);\n vec4 pt = texture2D(uPat, bp.yz) * an.x + texture2D(uPat, bp.xz + vec2(.37, .11)) * an.y + texture2D(uPat, bp.xy + vec2(.71, .53)) * an.z;\n diffuseColor.rgb = mix(diffuseColor.rgb, uPatCol, pt.r * uPatK.x) * (1. - pt.g * uPatK.y); s9pg = pt.b * uPatK.z; }')
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = uZRM[zi].x;')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = uZRM[zi].y;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\nif (zi == 4) totalEmissiveRadiance += uGlow;\ntotalEmissiveRadiance += uGlow * s9pg;');
    };
    m.customProgramCacheKey = () => lite ? 's9_hands_lite_v2' : 's9_hands_v2';
    return m;
  }
  let MAT_LITE = null;
  const weak = () => { const G = window.S9GFX; return ((G && G.tier) || (gv('CFG') || {}).q || 'high') === 'performance'; };
  const curMat = () => (weak() && MAT_LITE) || MAT;
  // weak tier switch: swap every hand mesh to the matching (already compiled) material
  let matNow = null;
  function syncTier() { const m = curMat(); if (m === matNow) return; matNow = m; for (const o of ours) o.material = m; }
  /* soldier skin -> hands: S9Skins.handLook(look) gives the colours the third-person soldier uses (its glove slot, dark-
     tactical grade). Glove fabric + knuckle pads + sleeve follow the skin, plates take the skin's metal slot, the light strip
     its visor colour. Whose look: yours, or the killer's while the killcam replays their view (no skins.js: the rig's own colours). */
  const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  function setZones(h) {
    const Z = U.uZC.value, R = U.uZRM.value;
    if (!h) { ZC.forEach((c, i) => Z[i].set(...c)); ZRM.forEach((c, i) => R[i].set(...c)); U.uGlow.value.set(...GLOW); U.uPat.value = FLAT; U.uPatK.value.set(0, 0, 0, 1 / 34); U.uPatZ.value.set(0, 0); H.look = 'std'; return; }
    Z[0].set(...h.glove); Z[2].set(...h.glove).multiplyScalar(.55).addScalar(.012); Z[5].set(...h.sleeve);
    Z[1].set(...lerp3(ZC[1], h.plate, .6)); Z[3].set(...lerp3(ZC[3], h.plate, .35));
    R[0].set(...h.gloveRM); R[5].set(...h.sleeveRM);
    const g = h.glow, L = Math.max(.05, g[0] * .2126 + g[1] * .7152 + g[2] * .0722); U.uGlow.value.set(g[0], g[1], g[2]).multiplyScalar(Math.min(1.2, .5 / L));
    const pt = h.pat; if (pt && pt.tex) { U.uPat.value = pt.tex; U.uPatK.value.set(pt.amt, pt.dark, pt.glow, pt.scale); U.uPatCol.value.set(...pt.col); U.uPatZ.value.set(pt.on[0], pt.on[1]); }
    else { U.uPat.value = FLAT; U.uPatK.value.set(0, 0, 0, 1 / 34); U.uPatZ.value.set(0, 0); }
    H.look = h.skin;
  }
  function whoseLook() {
    const KC = window.S9KC, c = KC && KC.live && KC.clip, k = c && c.killer;
    if (k && k !== gv('PLAYER_ENT')) return { key: 'k:' + (k.s9key || 'std'), look: k.s9look || 'std', killer: true };
    const SK = window.S9Skins; return { key: 'me:' + (SK ? SK.handsGen : 0), look: null, killer: false };
  }
  let lookKey = '';
  function syncLook() {
    const SK = window.S9Skins; if (!MAT || !U) return;
    if (!SK || typeof SK.handLook !== 'function') return syncTint();   // older skins.js: follow GLOVE_M / SLEEVE_M
    const w = whoseLook(); if (w.key === lookKey) return; lookKey = w.key;
    try { const h = SK.handLook(w.look); setZones(h); H.killerHands = w.killer; if (h && h.pending) lookKey = ''; } catch (e) { warn(e); }
  }
  // skins.js tints the shared glove / sleeve materials: copy that tint onto our fabric + sleeve zones (std skin = neutral)
  let tintKey = '';
  function syncTint() {
    const gm = gv('GLOVE_M'), sm = gv('SLEEVE_M'); if (!MAT) return;
    const gc = gm && gm.color, sc = sm && sm.color;
    const k = (gc ? gc.getHex() : 0) + ',' + (sc ? sc.getHex() : 0); if (k === tintKey) return; tintKey = k;
    const U = MAT.userData.u.uZC.value;
    const custom = c => c && c.getHex() !== 0x040405 && c.getHex() !== 0x0a0c0f && (c.r + c.g + c.b) > .02;
    if (custom(gc)) { U[0].set(gc.r, gc.g, gc.b).multiplyScalar(.85); U[2].set(gc.r, gc.g, gc.b).multiplyScalar(.55).addScalar(.02); } else { U[0].set(...ZC[0]); U[2].set(...ZC[2]); }
    if (custom(sc)) U[5].set(sc.r, sc.g, sc.b).multiplyScalar(.8); else U[5].set(...ZC[5]);
  }

  /* ------------------------------------------------------------------ find the old hands in a viewmodel */
  const isGlove = m => m && (m === gv('GLOVE_M') || (window.FLYTRAP && m === window.FLYTRAP.glove));
  const under = (o, root) => { while (o) { if (o === root) return true; o = o.parent; } return false; };
  function findHands(id, vm) {
    const out = {};
    if (vm.critter && vm.arm) { out.R = vm.rear; out.L = vm.arm.hand; return out; }       // poopgun (merged meshes, own materials)
    if (vm.boom) { out.R = vm.boom.hand; return out; }
    const groups = []; vm.group.traverse(o => { if (o.isMesh && isGlove(o.material) && !o.userData.s9hand && groups.indexOf(o.parent) < 0) groups.push(o.parent); });
    if (vm.ft) { if (groups[0]) out.R = groups[0]; if (groups[1]) out.L = groups[1]; return out; }   // flytrap: right hand built first
    for (const g of groups) { const s = vm.leftArm && under(g, vm.leftArm) ? 'L' : 'R'; if (!out[s]) out[s] = g; }
    return out;
  }
  const famOf = (id, vm) => vm.critter ? 'poopgun' : vm.ft ? 'flytrap' : vm.boom ? 'boomerang' : vm.knife ? 'knife' : null;

  /* ------------------------------------------------------------------ apply / remove */
  const ours = new Set();
  function cfgFor(id, vm) {
    const C = POSES.weapons || {}, F = POSES.families || {};
    let w = C[id]; if (typeof w === 'string') w = { family: w };
    w = w || {}; const fam = w.family || famOf(id, vm) || ((gv('WEAPONS') || {})[id] && (gv('WEAPONS')[id].handgun || id === 'pistol') ? 'handgun' : 'rifle');
    const base = F[fam] || {}, out = { family: fam };
    for (const s of ['R', 'L']) { const b = base[s], o = w[s]; if (!b && !o) continue; out[s] = Object.assign({}, b || {}, o || {}); if (b && o && b.bones && o.bones) out[s].bones = Object.assign({}, b.bones, o.bones); }
    return out;
  }
  // rot = palm frame (Euler XYZ deg); 'at' = where the palm centre lands (palm-space point ref), else 'pos' = wrist position
  const REF = [0, -.017, -.05];
  function place(mesh, c) {
    const r = c.rot || [0, 0, 0], s = c.s || 1;
    mesh.rotation.set(r[0] * D2R, r[1] * D2R, r[2] * D2R, 'XYZ'); mesh.scale.setScalar(s);
    if (c.at) { const ref = new T.Vector3(...(c.ref || REF)).multiplyScalar(s).applyEuler(mesh.rotation); mesh.position.set(c.at[0], c.at[1], c.at[2]).sub(ref); }
    else { const p = c.pos || [0, 0, 0]; mesh.position.set(p[0], p[1], p[2]); }
  }
  function removeFrom(vm) {
    const g = vm.group; const rm = [];
    g.traverse(o => { if (o.userData && o.userData.s9hand) rm.push(o); if (o.userData && o.userData.s9old) { o.layers.set(0); delete o.userData.s9old; } });
    for (const o of rm) { o.parent && o.parent.remove(o); ours.delete(o); }
    delete g.userData.s9h; delete vm.s9hands;
  }
  function applyVM(id, vm) {
    if (!H.ready || !H.on || !vm || !vm.group) return false;
    if (vm.group.userData.s9h === H.gen) return true;
    if (vm.group.userData.s9hFail === H.gen) return false;
    removeFrom(vm);
    const hands = findHands(id, vm), cfg = cfgFor(id, vm), made = {};
    try {
    for (const s of ['R', 'L']) {
      const grp = hands[s], c = cfg[s]; if (!grp || !c || !c.pose) continue;
      for (const o of grp.children) if (o.isMesh && !o.userData.s9hand) { o.userData.s9old = 1; o.layers.set(HIDE); }
      const m = new T.Mesh(geo(c.pose, s, c.bones), curMat()); m.userData.s9hand = s; m.userData.cfg = c; m.castShadow = m.receiveShadow = false; m.name = 's9hand_' + s;
      place(m, c); grp.add(m); ours.add(m); made[s] = m;
      if (c.alt) { m.userData.alt = {}; for (const k in c.alt) m.userData.alt[k] = geo(c.alt[k].pose || c.pose, s, c.alt[k].bones); m.userData.base = m.geometry; }
    }
    } catch (e) { warn(e); removeFrom(vm); vm.group.userData.s9hFail = H.gen; return false; }
    vm.s9hands = made; vm.group.userData.s9h = H.gen; H.stats.applied++;
    return true;
  }
  function applyAll() { const WM = gv('WM'); if (!WM) return 0; let n = 0; for (const id in WM) if (applyVM(id, WM[id])) n++; return n; }
  function removeAll() { const WM = gv('WM'); if (!WM) return; for (const id in WM) removeFrom(WM[id]); }

  /* ------------------------------------------------------------------ live pose switches (boomerang release, poopgun feeding) */
  function liveSwitch() {
    const WM = gv('WM'), P = gv('P'); if (!WM || !P) return; const vm = WM[P.weapon]; if (!vm || !vm.s9hands) return;
    for (const s in vm.s9hands) { const m = vm.s9hands[s], A = m.userData.alt; if (!A) continue; let want = m.userData.base;
      if (A.open && vm.boom && vm.boom.fingers && vm.boom.fingers[0] && Math.abs(vm.boom.fingers[0].rotation.y) > .2) want = A.open;
      if (A.feed && vm.arm && vm.arm.bean && vm.arm.bean.visible) want = A.feed;
      if (m.geometry !== want) m.geometry = want; }
  }

  /* the core hides the whole right-hand group while aiming (gunRear.visible = ads < .6: the old capsule hand covered the sights);
     the gloved hand sits on the grip under the line of sight, so it stays in the hands while aiming like in every modern shooter
     (owner 2026-11-10: the hand popped away on every ADS). The gun group itself still hides for a scope view. Every group that
     holds one of our hands on the drawn viewmodels is shown (the old primitive hands in it stay on the hidden layer). */
  function keepTrigger() {
    const WM = gv('WM'); if (!WM) return;
    for (const id in WM) { const vm = WM[id], m = vm && vm.s9hands && vm.s9hands.R; if (!m || !vm.group.visible || m.parent !== vm.rear || m.parent.visible) continue; m.parent.visible = true; }
  }
  /* ------------------------------------------------------------------ hooks */
  let hooked = false;
  function hook() {
    if (hooked) return; hooked = true;
    // indirect-eval assignment keeps the global binding the game calls
    const assign = (name, fn) => { window.__s9hTmp = fn; try { (0, eval)(name + ' = window.__s9hTmp'); } finally { delete window.__s9hTmp; } };
    const sm = gv('setModel');
    if (typeof sm === 'function' && !sm.__s9h) { const f = function (name) { try { const WM = gv('WM'); if (WM && WM[name]) applyVM(name, WM[name]); } catch (e) { warn(e); } return sm.apply(this, arguments); }; f.__s9h = true; f.__orig = sm; assign('setModel', f); }
    const gs = gv('gunScene');
    if (gs) { const prev = gs.onBeforeRender; gs.onBeforeRender = function () { try { if (H.on && H.ready) { const WM = gv('WM'), P = gv('P'); if (WM && P && WM[P.weapon] && WM[P.weapon].group.userData.s9h !== H.gen) applyVM(P.weapon, WM[P.weapon]); syncLook(); syncTier(); liveSwitch(); keepTrigger(); } } catch (e) { warn(e); } if (prev) return prev.apply(this, arguments); }; }
  }
  // shader warm-up: compile our one program now, not on the first equip
  function warm() {
    // against the composer's render target (the program key depends on the target), like the game's own warmShaders
    try { const R = gv('renderer'), gs = gv('gunScene'), gc = gv('gunCam'), rt = gv('rt'); if (!R || !gs || !gc) return;
      const ms = [MAT, MAT_LITE].filter(Boolean).map((mt, i) => { const m = new T.Mesh(geo('rifle_trigger', 'R'), mt); m.position.set(i * .1, 0, -.5); m.frustumCulled = false; gs.add(m); return m; });
      const prev = R.getRenderTarget(); if (rt) { R.setRenderTarget(rt); R.compile(gs, gc); } R.setRenderTarget(null); R.compile(gs, gc); R.setRenderTarget(prev);
      for (const m of ms) gs.remove(m); H.warmed = true; } catch (e) { warn(e); }
  }

  function prebake() {   // every pose the config uses, both sides, so no equip ever bakes (or stalls)
    const F = POSES.families || {};
    for (const f in F) for (const s of ['R', 'L']) { const c = F[f][s]; if (!c) continue; try { geo(c.pose, s, c.bones); for (const k in c.alt || {}) geo(c.alt[k].pose || c.pose, s, c.alt[k].bones); } catch (e) { warn(e); } }
  }
  /* ------------------------------------------------------------------ boot */
  async function loadJSON(url) { const r = await fetch(url, { cache: 'no-store' }); if (!r.ok) throw new Error(url + ' ' + r.status); return r.text(); }
  async function init() {
    try {
      const [gl, ps] = await Promise.all([loadJSON(ROOT + 'assets/models/hands/glove.gltf.json'), loadJSON(ROOT + 'assets/models/hands/hands_poses.json')]);
      POSES = JSON.parse(ps);
      const gltf = await new Promise((res, rej) => new T.GLTFLoader().parse(gl, '', res, rej));
      RIG = parseRig(gltf);
      // wait for the game (viewmodels exist after boot)
      for (let i = 0; i < 1200; i++) { const st = gv('state'); if (window.__s9 && st && st !== 'loading' && gv('WM') && Object.keys(gv('WM')).length) break; await new Promise(r => setTimeout(r, 100)); }
      MAT = makeMat(false); MAT_LITE = makeMat(true); syncLook();
      // bake every pose the config uses up front (a few ms each), so equipping never stalls
      const t0 = performance.now();
      H.ready = true; prebake(); hook(); applyAll(); warm();
      H.stats.initMs = +(performance.now() - t0).toFixed(1);
      // add-on weapons (flytrap / poopgun) build their viewmodels later: catch them for a while
      let n = 0; const iv = setInterval(() => { try { applyAll(); } catch (e) { warn(e); } if (++n > 60) clearInterval(iv); }, 500);
    } catch (e) { H.error = String(e && e.message || e); warn(e); }
  }

  /* ------------------------------------------------------------------ API */
  H.geo = (p, s, b) => geo(p, s || 'R', b);
  H.applyAll = applyAll;
  H.apply = (id) => { const WM = gv('WM'); return WM && WM[id] ? applyVM(id, WM[id]) : false; };
  H.enable = () => { H.on = true; H.gen++; applyAll(); return true; };
  H.disable = () => { H.on = false; removeAll(); return true; };
  H.reload = async (json) => { POSES = json || JSON.parse(await loadJSON(ROOT + 'assets/models/hands/hands_poses.json?t=' + Date.now())); for (const g of GEO.values()) g.dispose(); GEO.clear(); H.gen++; if (H.on) applyAll(); return true; };
  H.cfg = (id) => { const WM = gv('WM'); return WM && WM[id] ? cfgFor(id, WM[id]) : null; };
  H.report = () => { const WM = gv('WM') || {}, out = { ready: H.ready, error: H.error, on: H.on, stats: H.stats, weapons: {} };
    for (const id in WM) { const vm = WM[id], h = vm.s9hands || {}; let old = 0; vm.group.traverse(o => { if (o.userData && o.userData.s9old) old++; });
      out.weapons[id] = { applied: vm.group.userData.s9h === H.gen, R: h.R ? h.R.userData.cfg.pose : null, L: h.L ? h.L.userData.cfg.pose : null, hidden: old }; }
    return out; };
  H.mat = () => MAT;
  H.matLite = () => MAT_LITE;
  H.curMat = () => curMat();
  H.zones = () => ({ pat: U.uPatK.value.toArray().map(v => +v.toFixed(3)), patOn: U.uPatZ.value.toArray(), look: H.look, killer: !!H.killerHands, glove: U.uZC.value[0].toArray(), sleeve: U.uZC.value[5].toArray(), plate: U.uZC.value[1].toArray(), glow: U.uGlow.value.toArray(), gloveRM: U.uZRM.value[0].toArray(), sleeveRM: U.uZRM.value[5].toArray() });
  H.syncLook = () => { lookKey = ''; syncLook(); syncTier(); return H.zones(); };
  // tooling (render/hands/fit.js): pose the rig and read joint positions in palm space
  H._joints = (bonesP, side) => { setPose(bonesP); const R = RIG, palm = new T.Matrix4().multiplyMatrices(R.handRest, new T.Matrix4().copy(R.by.hand.matrixWorld).invert()), out = {};
    for (const b of R.bones) { const p = new T.Vector3().setFromMatrixPosition(b.matrixWorld).applyMatrix4(palm); if (side === 'L') p.x = -p.x; out[b.name] = p; }
    setPose(null); return out; };
  H._poseBones = (n, x) => poseBones(n, x);
  H._place = place;
  init();
})();
