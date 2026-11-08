/* Sector Nine - yard cover pieces (modules/yardcover.js): owner's Option A (2026-11-06). Adds three REAL cover objects to the yard:
   an impounded hover car (west sniper lane), a NEXUS security checkpoint (north middle lane) and an anti-grav forklift (west of the
   fortress). Gameplay geometry, so it is the same on EVERY tier and independent of the look modules:
   - look: one merged lit mesh + one glowing mesh, built from engine-neutral recipes in data/yardcover.json
   - collision: Box3s in world.colliders (players + bots), an invisible box mesh in world.meshes (bullets, sight lines, the boomerang),
     the bots' nav grid rebuilt, MKLOG updated (Unity export). The server's anti-cheat map (sector-nine-server
     anticheat/data/maps/yard.json) must carry the same boxes: tools/ac_export/export_colliders.js with this module loaded.
   API: window.S9Cover = { ready, map, boxes, status() }. Loads BEFORE gfxlook. */
(function () {
  'use strict';
  if (window.S9Cover) return;
  if (typeof loadMap !== 'function' || typeof MAPROOT === 'undefined' || typeof world === 'undefined') { console.warn('[yardcover] game globals not found'); return; }
  const T = THREE, C = window.S9Cover = { ready: false, map: null, boxes: 0, meshes: [], err: null };
  let DATA = null;
  const getData = async () => { if (DATA) return DATA; try { const r = await fetch('data/yardcover.json', { cache: 'no-cache' }); DATA = r.ok ? await r.json() : null; } catch (e) { DATA = null; } return DATA; };
  function build(D) {
    const lit = [], glow = [], proxy = [], Mx = new T.Matrix4(), Q = new T.Matrix4();
    for (const [type, x, z, rq] of D.place) {
      const ty = D.types[type]; if (!ty) continue; const a = (rq || 0) * Math.PI / 2, ca = Math.round(Math.cos(a)), sa = Math.round(Math.sin(a));
      Mx.makeRotationY(a).setPosition(x, 0, z);
      for (const [sh, sx, sy, sz, px, py, pz, pr, col, em] of ty.parts) {
        const g = (sh === 'c' ? new T.CylinderGeometry(sx, sx, sy, sz || 12) : new T.BoxGeometry(sx, sy, sz)).toNonIndexed();
        g.applyMatrix4(Q.makeRotationY(pr || 0).setPosition(px, py, pz)); g.applyMatrix4(Mx); g.deleteAttribute('uv');
        const c = col === 'B' ? D.palette.brand[0] : col === 'A' ? D.palette.accent[0] : col, n = g.attributes.position.count, cc = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) cc.set(c, i * 3); g.setAttribute('color', new T.BufferAttribute(cc, 3)); (em ? glow : lit).push(g);
        if (em) for (let i = 0; i < cc.length; i++) cc[i] *= em;
      }
      for (const b of ty.col) {   // local box -> world (quarter turns keep it axis-aligned)
        const X = [], Z = []; for (const px of [b[0], b[3]]) for (const pz of [b[2], b[5]]) { X.push(px * ca + pz * sa + x); Z.push(-px * sa + pz * ca + z); }
        const B = new T.Box3(new T.Vector3(Math.min(...X), b[1], Math.min(...Z)), new T.Vector3(Math.max(...X), b[4], Math.max(...Z))); B.s9cover = type;
        world.colliders.push(B); proxy.push(B);
      }
      try { if (typeof MKLOG !== 'undefined' && MKLOG.yard) MKLOG.yard.pieces.push({ piece: 'cover_' + type, x, z, quarterTurns: rq || 0, y: 0, collision: ty.col }); } catch (e) {}
    }
    const out = [];
    const mk = (geos, mat, name) => { if (!geos.length) return; const m = new T.Mesh(T.BufferGeometryUtils.mergeBufferGeometries(geos), mat); m.name = name; m.castShadow = name !== 'cover-glow'; m.receiveShadow = true; m.userData.s9nolm = true; m.userData.surface = 'metal'; MAPROOT.add(m); out.push(m); };
    mk(lit, new T.MeshStandardMaterial({ vertexColors: true, roughness: .42, metalness: .55, envMapIntensity: .9 }), 'cover-lit');
    mk(glow, new T.MeshBasicMaterial({ vertexColors: true }), 'cover-glow');
    const v = new T.Vector3(), c = new T.Vector3();
    const pg = T.BufferGeometryUtils.mergeBufferGeometries(proxy.map(b => { b.getSize(v); b.getCenter(c); return new T.BoxGeometry(v.x, v.y, v.z).translate(c.x, c.y, c.z); }));
    const pm = new T.Mesh(pg, new T.MeshBasicMaterial({ visible: false })); pm.visible = false; pm.name = 'cover-proxy'; pm.userData.surface = 'metal'; pm.userData.dyn = true; pm.updateMatrixWorld(); MAPROOT.add(pm); world.meshes.push(pm);
    C.boxes = proxy.length; C.meshes = out;
    try { buildNav(); } catch (e) { C.err = 'nav ' + e.message; }
    // bots must never stand on or path through cover: close every nav cell whose centre lies inside a cover box (buildNav treats boxes <= 1.75 m as walkable steps)
    C.proxy = proxy; closeNav();
    try { targetsDirty = true; renderer.shadowMap.needsUpdate = true; } catch (e) {}
    try { renderer.compile(scene, camera); } catch (e) {}
  }
  // close the nav cells under every cover box; runs after EVERY buildNav on the yard (a later rebuild used to reopen the hovering car: its top counted as a walkable step)
  function closeNav() { const boxes = C.proxy || []; if (!boxes.length || typeof NAV === "undefined" || !NAV.ok) return; try {
    const N = NAV.N, Sz = NAV.S; for (const b of boxes) { const i0 = Math.max(0, Math.floor((b.min.x + HALF) / Sz) - 1), i1 = Math.min(N - 1, Math.ceil((b.max.x + HALF) / Sz) + 1), j0 = Math.max(0, Math.floor((b.min.z + HALF) / Sz) - 1), j1 = Math.min(N - 1, Math.ceil((b.max.z + HALF) / Sz) + 1);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const x = -HALF + (i + .5) * Sz, z = -HALF + (j + .5) * Sz; if (x > b.min.x - .2 && x < b.max.x + .2 && z > b.min.z - .2 && z < b.max.z + .2) NAV.ok[j * N + i] = 0; } }
    } catch (e) { C.err = "navclose " + e.message; } }
  const _bn = buildNav;
  buildNav = function () { const r = _bn.apply(this, arguments); try { if (typeof CUR_MAP !== "undefined" && CUR_MAP === "yard" && C.map === "yard") closeNav(); } catch (e) {} return r; };
  const _lm = loadMap;
  loadMap = async function (id) {
    const before = typeof CUR_MAP !== 'undefined' ? CUR_MAP : null, kids = MAPROOT.children.length;
    const r = await _lm.apply(this, arguments);
    try { const now = typeof CUR_MAP !== 'undefined' ? CUR_MAP : id; if (now === 'yard' && (before !== now || !kids || C.map !== now)) { const D = await getData(); if (D && CUR_MAP === 'yard') build(D); } C.map = now; } catch (e) { C.err = 'loadMap ' + e.message; }
    return r;
  };
  C.status = () => ({ ready: C.ready, map: C.map, boxes: C.boxes, meshes: C.meshes.map(m => m.name), err: C.err });
  // the boot map may already be the yard when this module arrives: add the pieces once, in the menu
  const iv = setInterval(async () => { if (typeof state === 'undefined' || (state !== 'menu' && state !== 'loading') || typeof CUR_MAP === 'undefined' || !CUR_MAP) return; clearInterval(iv);
    try { if (CUR_MAP === 'yard' && C.map !== 'yard') { const D = await getData(); if (D) build(D); } C.map = CUR_MAP; } catch (e) { C.err = 'start ' + e.message; } C.ready = true; window.dispatchEvent(new Event('s9cover')); }, 50);
})();
