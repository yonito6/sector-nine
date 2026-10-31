/* Sector Nine add-on: "Gas Giant", the alien critter shotgun  (modules/w_poopgun.js)
   A chubby purple space critter strapped into a gun harness. You hold it by its harness grips with its face toward you:
   it blinks, looks around, burps and gurgles. Pull the trigger and it scrunches its face and blasts a fixed spread of nine
   glowing goo blobs out of its rear vent (real projectiles with travel time and a little drop), then sighs with relief.
   Reload = feed it a glowing space bean from your belt pouch (each bean = 2 shells); firing interrupts the feeding.
   Out of ammo it looks up at you and whines. Goo splats stick to walls and fade, hits shove the target a little and
   splash the victim's screen with goo for a moment.
   Everything hooks in by wrapping the game's globals (see w_poopgun.INTEGRATE.md); no edits to index.html are needed.
   Data: data/w_poopgun.json (the defaults below mirror it; the file wins once it has loaded). */
(function () {
  'use strict';
  const ID = 'poopgun';
  if (typeof WEAPONS === 'undefined' || typeof THREE === 'undefined' || window.S9_POOPGUN) return;
  const PG = window.S9_POOPGUN = { id: ID, ready: false, dataLoaded: false, loadError: null, disabled: false,
    stats: { shots: 0, pellets: 0, pelletHits: 0, victims: 0, splash: 0, foods: 0, shells: 0, remoteShots: 0, remotePellets: 0, botShots: 0, slimed: 0, burps: 0, gurgles: 0, whines: 0, blinks: 0, interrupts: 0, decals: 0 },
    shotLog: [], perf: { n: 0, total: 0, max: 0 }, dbg: { slow: 1, freeze: null }, errors: [] };
  const warn = e => { if (PG.errors.length < 20) PG.errors.push(String(e && e.stack || e)); try { console.warn('[poopgun]', e); } catch (x) {} };

  /* ================= data (mirror of data/w_poopgun.json) ================= */
  let D = {
    weapon: { name: 'Gas Giant', cls: 'Critter shotgun', mode: 'poop', mag: 6, reserve: 30, maxReserve: 48, rpm: 72, auto: false, dmg: 15, pellets: 9, spreadP: .072, head: 1.5, limb: .75,
      hip: 0, ads: 0, adsFov: 64, adsSpeed: 15, reload: .8, reloadEmpty: .8, falloff: [7, 22, .35], kick: 2.4, move: 1.02, heat: 0, glow: [.9, 3, .6], tracer: [1.2, 4, .8], sound: 'poopFire',
      stats: [92, 18, 22, 76], desc: 'A hungry space critter. Feed it beans, point its rear end, squeeze: nine gooey blobs. Two-shots anyone up to 10 m, splashes on walls.' },
    pattern: { inner: 3, innerR: .03, outer: 5, outerR: .072, jitter: .006, adsTighten: .15, crouchTighten: .1, airJitter: .018 },
    projectile: { speed: 120, gravity: 6, life: 1.1, radius: .085, converge: .16 },
    splash: { dmg: 6, r: 1.0 },
    knockback: { perPellet: .45, max: 4, botPerPellet: .5 },
    reloadCycle: { perFood: 2, cycle: .8, bite: .56, startDelay: .05 },
    bot: { dmg: 7, head: 1.5, limb: .8, gap: .95, burst: [1, 1], pause: [.85, 1.2], mag: 6, reload: 2.6, pellets: 9 },
    slime: { duration: 1.5, maxOpacity: .78 },
    ui: { card: 'assets/models/weapons/poopgun/card.png' },
  };
  PG.D = () => D;
  function applyData(d) {
    if (!d || !d.weapon) return;
    D = Object.assign({}, D, d);
    const w = WEAPONS[ID]; Object.assign(w, D.weapon); w.label = w.name + ' · ' + w.cls.toLowerCase();
    Object.assign(BOTW[ID], D.bot);
    if (typeof P !== 'undefined' && P.weapon === ID) { P.mag = w.mag; try { $('hWeapon').textContent = w.label; } catch (e) {} }
  }

  /* ================= registration ================= */
  WEAPONS[ID] = Object.assign({}, D.weapon); WEAPONS[ID].label = WEAPONS[ID].name + ' · ' + WEAPONS[ID].cls.toLowerCase();
  if (!GUN_IDS.includes(ID)) GUN_IDS.push(ID);
  if (!NET_W.includes(ID)) NET_W.push(ID);
  BOTW[ID] = Object.assign({}, D.bot);
  if (typeof ICON !== 'undefined') ICON[ID] = '<svg viewBox="0 0 42 14" width="34" height="12"><path d="M3 7.2C3 4 5.6 2 9.4 2h15.8c5.6 0 9.6 2.2 9.6 5.2s-4 5.2-9.6 5.2H9.4C5.6 12.4 3 10.4 3 7.2z" fill="currentColor"/><circle cx="7.6" cy="5.4" r="2.3" fill="#000"/><circle cx="7.9" cy="5.1" r=".8" fill="currentColor"/><circle cx="38.2" cy="6.4" r="1.7" fill="currentColor"/><circle cx="40.6" cy="3.6" r="1.1" fill="currentColor"/><circle cx="40.4" cy="9.6" r=".9" fill="currentColor"/><path d="M15 12.2l-.8 1.8M21 12.4v1.6M27 12.2l.8 1.8" stroke="currentColor" stroke-width="1.3"/></svg>';
  if (typeof DEATH_OF !== 'undefined') DEATH_OF[ID] = 'blast';
  // a saved loadout that holds this gun was rejected when the game parsed it (the gun didn't exist yet): restore it
  try { const l = JSON.parse(localStorage.getItem('sector9-loadout') || 'null');
    if (Array.isArray(l) && l.length === 2 && l.includes(ID) && l.every(x => GUN_IDS.includes(x)) && l[0] !== l[1] && LOADOUT.join() !== l.join()) { LOADOUT[0] = l[0]; LOADOUT[1] = l[1]; } } catch (e) {}
  fetch('data/w_poopgun.json', { cache: 'no-store' }).then(r => r.json()).then(j => { applyData(j); PG.dataLoaded = true; }).catch(e => { PG.loadError = String(e); });

  /* ================= tiny helpers ================= */
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const ez = x => x * x * (3 - 2 * x), ez01 = x => ez(clamp(x, 0, 1));
  const seg = (t, a, b) => clamp((t - a) / (b - a), 0, 1);
  function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const postBoot = () => !!window.__s9;   // the game's boot dims every viewmodel's reflections once (x.55); later builds do it themselves

  /* ================= materials (shared) ================= */
  let MATS = null;
  function mats() {
    if (MATS) return MATS;
    const env = 1;
    const S = (o) => { const m = new THREE.MeshStandardMaterial(Object.assign({ roughness: .5, metalness: 0, envMapIntensity: .8 }, o)); m.userData.pgEnv = m.envMapIntensity; return m; };
    MATS = {
      skin: S({ vertexColors: true, roughness: .38, envMapIntensity: .75 * env }),
      skinTP: S({ vertexColors: true, roughness: .45, envMapIntensity: .7 }),
      lid: S({ color: new THREE.Color(.13, .055, .2), roughness: .4 }),
      cheek: S({ color: new THREE.Color(.42, .1, .22), roughness: .45, emissive: new THREE.Color(.05, .0, .02) }),
      eye: S({ color: new THREE.Color(.62, .64, .6), roughness: .12, envMapIntensity: 1.3 * env }),
      iris: new THREE.MeshBasicMaterial({ color: new THREE.Color(.35, 1.6, .25) }),
      pupil: S({ color: new THREE.Color(.004, .004, .006), roughness: .08, envMapIntensity: 1.6 * env }),
      shine: new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 2.4, 2.4) }),
      mouth: S({ color: new THREE.Color(.09, .006, .02), roughness: .6, side: THREE.DoubleSide }),
      tongue: S({ color: new THREE.Color(.55, .1, .2), roughness: .35 }),
      tooth: S({ color: new THREE.Color(.75, .72, .62), roughness: .3 }),
      lip: S({ color: new THREE.Color(.2, .07, .26), roughness: .35 }),
      spot: new THREE.MeshBasicMaterial({ color: new THREE.Color(.22, 1.15, 1.35) }),
      metal: S({ color: new THREE.Color(.075, .08, .09), metalness: .85, roughness: .32, envMapIntensity: 1.1 * env }),
      steel: S({ color: new THREE.Color(.38, .4, .43), metalness: 1, roughness: .22, envMapIntensity: 1.4 * env }),
      rubber: S({ color: new THREE.Color(.025, .025, .03), roughness: .85 }),
      glow: new THREE.MeshBasicMaterial({ color: new THREE.Color(.5, 2.6, .45) }),
      amber: new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 1.3, .3) }),
      vent: S({ color: new THREE.Color(.02, .05, .02), roughness: .5 }),
      core: new THREE.MeshBasicMaterial({ color: new THREE.Color(.6, 3, .5) }),
      bean: S({ color: new THREE.Color(1, .55, .12), roughness: .25, emissive: new THREE.Color(1.3, .55, .08), envMapIntensity: 1.2 * env }),
      glass: S({ color: new THREE.Color(.5, .7, .75), roughness: .05, metalness: .1, transparent: true, opacity: .45, envMapIntensity: 1.8, depthWrite: false }),
      glove: S({ color: new THREE.Color(.085, .088, .1), roughness: .55, envMapIntensity: .45 }),
      sleeve: S({ color: new THREE.Color(.03, .035, .045), roughness: .95, envMapIntensity: .15 }),
      cuff: S({ color: new THREE.Color(.03, .032, .04), roughness: .5, metalness: .6 }),
      cuffGlow: new THREE.MeshBasicMaterial({ color: new THREE.Color(.5, 2.2, .45) }),
      beanSpeck: new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 2.2, .6) }),
      foot: S({ color: new THREE.Color(.1, .04, .15), roughness: .45 }),
    };
    return MATS;
  }
  // body colour: deep purple back, lighter lilac belly (vertex colours, so the body stays one draw call)
  const TOP = new THREE.Color(.055, .022, .095), BELLY = new THREE.Color(.17, .115, .2), SIDE = new THREE.Color(.09, .035, .13);
  function paint(geo, cy) {
    const p = geo.attributes.position, n = geo.attributes.normal, c = new Float32Array(p.count * 3), col = new THREE.Color();
    for (let i = 0; i < p.count; i++) { const ny = n.getY(i), k = clamp((-ny + .15) / .9, 0, 1), s = clamp(1 - Math.abs(ny) * 1.6, 0, 1);
      col.copy(TOP).lerp(BELLY, ez(k)); col.lerp(SIDE, s * .35 * (1 - k)); c[i * 3] = col.r; c[i * 3 + 1] = col.g; c[i * 3 + 2] = col.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3)); return geo;
  }

  /* ================= geometry (built once per detail level) ================= */
  // gun space: forward = -z, up = +y; the critter lies along z, face at +z (toward you), rear vent at -z
  const Y0 = -.044, BEAD_Y = .235;                                    // body centre height (low enough that the sight line clears its back)
  const BODY = [[-.075, .06], [-.06, .086], [-.02, .1], [.04, .109], [.12, .119], [.2, .127], [.28, .13], [.36, .125], [.44, .112], [.5, .094], [.54, .074], [.565, .052], [.58, .03], [.588, .01], [.59, 0]];
  function bodyR(z) {   // radius of the body profile at gun-space z (z = -h)
    const h = -z; for (let i = 1; i < BODY.length; i++) if (h <= BODY[i][0]) { const a = BODY[i - 1], b = BODY[i], k = (h - a[0]) / (b[0] - a[0]); return lerp(a[1], b[1], k) * FAT; } return 0;
  }
  const SX = 1.1, SY = .93, FAT = 1.12;   // body cross-section: a little wider than tall
  const GEO = {};
  // a lathe repeats its first column of vertices as the last one: give both the same (averaged) normal, so no seam line shows
  function fixSeam(g, n) { const N = g.attributes.normal, cols = N.count / n - 1, v = new THREE.Vector3();
    for (let j = 0; j < n; j++) { const a = j, b = cols * n + j; v.set(N.getX(a) + N.getX(b), N.getY(a) + N.getY(b), N.getZ(a) + N.getZ(b)).normalize(); N.setXYZ(a, v.x, v.y, v.z); N.setXYZ(b, v.x, v.y, v.z); } N.needsUpdate = true; }
  function geos(lod) {
    if (GEO[lod]) return GEO[lod];
    const hi = lod === 'fp', q = hi ? 1 : .5, sg = n => Math.max(6, Math.round(n * q));
    const G = {};
    // body: lathe through a smooth profile, turned to lie along -z, belly sagging a little
    { const curve = new THREE.SplineCurve(BODY.map(([h, r]) => new THREE.Vector2(r * FAT, h))); const pts = curve.getPoints(sg(46)); pts[0].x = Math.max(pts[0].x, .001); pts[pts.length - 1].x = 0;
      const g = new THREE.LatheGeometry(pts, sg(40)); g.rotateX(-Math.PI / 2);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) { let x = p.getX(i) * SX, y = p.getY(i) * SY; const z = p.getZ(i), sag = Math.exp(-Math.pow((z + .28) / .2, 2)); if (y < 0) y *= 1 + .14 * sag; p.setXYZ(i, x, y, z); }
      g.computeVertexNormals(); fixSeam(g, pts.length); G.body = paint(g); }
    // head: a big round head, slightly squashed
    { const g = new THREE.SphereGeometry(.108, sg(36), sg(26)); g.scale(1.06, .94, 1); G.head = paint(g); }
    G.eye = new THREE.SphereGeometry(.041, sg(28), sg(20));
    G.lid = new THREE.SphereGeometry(.0445, sg(28), sg(10), 0, Math.PI * 2, 0, Math.PI / 2);
    G.iris = new THREE.CircleGeometry(.021, sg(28)); G.pupil = new THREE.SphereGeometry(.0125, sg(16), sg(10)); G.shine = new THREE.SphereGeometry(.0048, 8, 6);
    G.cheek = new THREE.SphereGeometry(.033, sg(22), sg(16));
    G.cavity = new THREE.SphereGeometry(.05, sg(24), sg(14), 0, Math.PI * 2, 0, Math.PI / 2); G.cavity.rotateX(-Math.PI / 2);   // a bowl opening toward +z
    G.lipU = new THREE.TorusGeometry(.05, .011, sg(10), sg(28), Math.PI); G.lipL = G.lipU;
    G.tongue = new THREE.SphereGeometry(.028, sg(18), sg(10));
    G.tooth = rbox(.0105, .011, .007, .003);
    G.frill = new THREE.ConeGeometry(.034, .085, sg(14), 1, false); G.frill.scale(1, 1, .35);
    G.frillTip = new THREE.SphereGeometry(.009, 10, 8);
    G.spot = new THREE.SphereGeometry(.013, 12, 8); G.spot.scale(1, 1, .3);
    G.thigh = new THREE.SphereGeometry(.026, sg(16), sg(12)); G.thigh.scale(1, 1.25, 1.1); G.thigh.translate(0, -.018, 0); G.shin = new THREE.CapsuleGeometry(.014, .03, 4, sg(10)); G.shin.translate(0, -.045, 0);
    G.foot = new THREE.SphereGeometry(.022, sg(18), sg(12)); G.foot.scale(1.2, .5, 1.1);
    G.toe = new THREE.CapsuleGeometry(.0075, .018, 3, 8); G.toe.rotateX(Math.PI / 2); G.claw = new THREE.ConeGeometry(.005, .012, 6); G.claw.rotateX(Math.PI / 2);
    // harness
    G.band = new THREE.TorusGeometry(.124, .011, sg(10), sg(44)); G.bandGlow = new THREE.TorusGeometry(.124, .0035, 6, sg(44));
    G.buckle = rbox(.04, .028, .03, .006);
    G.rail = rbox(.034, .016, .34, .005);
    G.stalk = new THREE.CylinderGeometry(.006, .011, .1, 10); G.stalkRing = new THREE.TorusGeometry(.014, .004, 6, 16); G.sEye = new THREE.SphereGeometry(.0135, 16, 12); G.sIris = new THREE.CircleGeometry(.0075, 16); G.sLid = new THREE.SphereGeometry(.0145, 16, 6, 0, Math.PI * 2, 0, Math.PI / 2); G.bead = new THREE.SphereGeometry(.0055, 12, 8); G.hood = new THREE.TorusGeometry(.016, .0028, 6, 18, Math.PI);
    G.notch = rbox(.007, .018, .01, .002);
    G.grip = extrude([[-.024, 0], [.03, 0], [.064, -.128], [.056, -.142], [.012, -.142], [-.012, -.03]], .036, .008); G.guard = new THREE.TorusGeometry(.03, .0045, 6, 18, Math.PI * 1.2); G.trigger = rbox(.007, .028, .008, .003);
    G.fore = rbox(.054, .038, .15, .014); G.foreSlat = rbox(.056, .005, .13, .002); G.jar = new THREE.CapsuleGeometry(.033, .075, 6, sg(18)); G.jar.rotateX(Math.PI / 2); G.jarCap = new THREE.CylinderGeometry(.036, .036, .016, sg(18)); G.jarCap.rotateX(Math.PI / 2); G.foreRing = new THREE.TorusGeometry(.023, .004, 6, sg(18)); G.foreCap = new THREE.SphereGeometry(.024, sg(14), 8, 0, Math.PI * 2, 0, Math.PI / 2);
    G.mount = rbox(.03, .022, .05, .006);
    G.collar = new THREE.TorusGeometry(.062, .012, sg(10), sg(32));
    G.strut = new THREE.CylinderGeometry(.009, .009, 1, 10);
    G.nozzle = new THREE.CylinderGeometry(.052, .044, .05, sg(28), 1, true); G.nozzle.rotateX(Math.PI / 2);
    G.nozzleIn = new THREE.CircleGeometry(.046, sg(28)); G.coreDisk = new THREE.CircleGeometry(.024, sg(24));
    G.petal = rbox(.022, .006, .03, .002);
    // food: a kidney-shaped glowing space bean
    { const a = new THREE.SphereGeometry(.024, 16, 12); a.scale(1.45, 1, 1); const pa = a.attributes.position;
      for (let i = 0; i < pa.count; i++) { const x = pa.getX(i); pa.setY(i, pa.getY(i) - .012 * Math.cos(x / .035 * Math.PI * .5) + .006); } a.computeVertexNormals(); G.bean = a; }
    G.speck = new THREE.SphereGeometry(.0035, 6, 4);
    // hands
    G.palm = rbox(.05, .07, .085, .018); G.palmL = rbox(.032, .075, .056, .014);
    return (GEO[lod] = G);
  }
  // a glove cuff: a short armoured band round the wrist, so the hand reads as a glove and not as the end of a pipe
  function cuffAt(a, b, r, parent) { const M = mats(), d = b.clone().sub(a).normalize(), c = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.05, .026, 16), M.cuff); c.position.copy(a); c.quaternion.setFromUnitVectors(V(0, 1, 0), d); parent.add(c);
    const s2 = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.07, r * 1.07, .006, 16), M.cuffGlow); s2.position.copy(a).addScaledVector(d, .006); s2.quaternion.copy(c.quaternion); parent.add(s2); return c; }
  // fewer draw calls: everything rigid under 'root' is merged into one mesh per material (animated parts listed in 'keep')
  const _mi = new THREE.Matrix4(), _mm = new THREE.Matrix4();
  function mergeStatic(root, keep = new Set()) {
    root.updateMatrixWorld(true); _mi.copy(root.matrixWorld).invert(); const by = new Map(), rm = [];
    root.traverse(o => { if (!o.isMesh || o === root) return; for (let q = o; q && q !== root; q = q.parent) if (keep.has(q)) return;
      let g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone(); for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && !(k === 'color' && o.material.vertexColors)) g.deleteAttribute(k);
      g.applyMatrix4(_mm.multiplyMatrices(_mi, o.matrixWorld)); if (!by.has(o.material)) by.set(o.material, []); by.get(o.material).push(g); rm.push(o); });
    for (const o of rm) o.parent.remove(o);
    for (const [m, list] of by) { const mg = THREE.BufferGeometryUtils.mergeBufferGeometries(list); if (!mg) continue; const mesh = new THREE.Mesh(mg, m); if (m.transparent) mesh.renderOrder = 2; root.add(mesh); }
    return root;
  }
  PG.mergeStatic = mergeStatic;
  function capsuleBetween(a, b, r, m, parent) { const d = b.clone().sub(a), L = d.length(); const c = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(.001, L - r * 2), 4, 12), m); c.position.copy(a).addScaledVector(d, .5); c.quaternion.setFromUnitVectors(V(0, 1, 0), d.normalize()); parent.add(c); return c; }

  /* ================= the critter (shared by first person, third person, drops, renders) ================= */
  function buildCritter(lod) {
    const G = geos(lod), M = mats(), fp = lod === 'fp';
    const root = new THREE.Group(); root.name = 'poopgun';
    const mk = (geo, mat, parent, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); (parent || root).add(m); return m; };
    // creature: everything that squashes/stretches hangs under 'body'
    const body = new THREE.Group(); body.position.set(0, Y0, -.26); root.add(body);   // pivot at the belly middle
    const B = new THREE.Group(); B.position.set(0, 0, .26); body.add(B);              // back to gun space
    mk(G.body, fp ? M.skin : M.skinTP, B);
    const head = new THREE.Group(); head.position.set(0, .006, .072); head.scale.setScalar(1.15); B.add(head);
    mk(G.head, fp ? M.skin : M.skinTP, head);
    // eyes: big googly eyes on the upper face, looking back at you; lids blink; pupils look around
    const eyes = [];
    for (const s of [-1, 1]) {
      const e = new THREE.Group(); e.position.set(s * .049, .046, .078); e.rotation.set(-.18, s * .2, 0); head.add(e);
      mk(G.eye, M.eye, e);
      const look = new THREE.Group(); e.add(look);
      const iris = mk(G.iris, M.iris, look, 0, 0, .0405); const pupil = mk(G.pupil, M.pupil, look, 0, 0, .037); pupil.scale.set(1, 1, .6);
      const shine = mk(G.shine, M.shine, look, .008 * -s, .009, .0425);
      const lid = mk(G.lid, M.lid, e); lid.rotation.x = -.3;
      eyes.push({ g: e, look, iris, pupil, shine, lid, s });
    }
    // mouth: a wide grin under the eyes; the jaw drops to eat, chew, burp and whine
    const mouth = new THREE.Group(); mouth.position.set(0, -.036, .1); head.add(mouth);
    const cavity = mk(G.cavity, M.mouth, mouth); cavity.scale.set(1.15, .3, .55);
    const lipU = mk(G.lipU, M.lip, mouth, 0, -.006, .006); lipU.scale.set(1.12, .3, .7);
    const jaw = new THREE.Group(); mouth.add(jaw);
    const lipL = mk(G.lipL, M.lip, jaw, 0, .004, .006); lipL.rotation.z = Math.PI; lipL.scale.set(1.12, .6, .7);
    const tongue = mk(G.tongue, M.tongue, jaw, 0, -.002, -.008); tongue.scale.set(1.25, .45, .9);
    for (const s of [-1, 1]) { const t = mk(G.tooth, M.tooth, mouth, s * .0085, -.0085, .016); t.rotation.x = -.15; }
    const cheeks = [-1, 1].map(s => { const c = mk(G.cheek, M.cheek, head, s * .074, -.03, .068); c.scale.set(1, .82, .8); return c; });
    // ear frills on the sides of the head, glowing tips
    const frills = new THREE.Group(); head.add(frills);
    for (const s of [-1, 1]) { const f = mk(G.frill, M.lid, frills, s * .108, .03, -.005); f.rotation.set(.35, 0, -s * 1.25); mk(G.frillTip, M.glow, f, 0, .044, 0); }
    // glowing spots along the back and flanks (sit on the skin surface)
    const spots = new THREE.Group(); B.add(spots);
    { const SP = [[-.06, .55], [-.12, -.75], [-.17, .2], [-.22, 1.05], [-.27, -.4], [-.32, .7], [-.36, -1.0], [-.4, .15], [-.45, -.55], [-.49, .85]];
      for (const [z, a] of SP) { const r = bodyR(z), x = Math.sin(a) * r * SX, y = Math.cos(a) * r * SY; const m = mk(G.spot, M.spot, spots, x, y, z);
        const dz = (bodyR(z - .01) - bodyR(z + .01)) / .02;   // the profile's slope tilts the normal along the body
        m.quaternion.setFromUnitVectors(V(0, 0, 1), V(Math.sin(a) / SX, Math.cos(a) / SY, -dz * .0).normalize()); } }
    // legs: four stubby legs dangling from the belly, swinging with the gun
    const legs = [];
    for (const [x, z] of [[-.056, -.19], [.056, -.19], [-.06, -.33], [.06, -.33]]) {
      const yb = -bodyR(z) * SY * (1 + .14 * Math.exp(-Math.pow((z + .28) / .2, 2))) + .012;
      const hip = new THREE.Group(); hip.position.set(x, yb, z); B.add(hip);
      mk(G.thigh, M.foot, hip); mk(G.shin, M.foot, hip);
      const foot = mk(G.foot, M.foot, hip, 0, -.072, .006);
      for (let k = -1; k <= 1; k++) { const t = mk(G.toe, M.foot, foot, k * .013, -.002, .022); t.rotation.y = k * .45; mk(G.claw, M.lip, t, 0, 0, .017); }
      legs.push({ g: hip, x, z, ph: Math.random() * 6 });
    }
    // ---- harness (rigid: not under 'body', so the sight never wobbles) ----
    const H = new THREE.Group(); root.add(H);
    const bands = [];
    for (const z of [-.1, -.42]) { const r = bodyR(z), sx = r * SX / .124 + .045, sy = r * SY * 1.06 / .124 + .045;
      const b = mk(G.band, M.metal, H, 0, Y0, z); b.scale.set(sx, sy, 1); const gl = mk(G.bandGlow, M.glow, H, 0, Y0, z + .0118); gl.scale.set(sx, sy, 1); bands.push({ z, top: Y0 + .124 * sy + .011, bot: Y0 - .124 * sy - .011, side: .124 * sx + .011 }); }
    const topY = Math.max(bands[0].top, bands[1].top);
    for (const b of bands) { mk(G.buckle, M.steel, H, 0, b.top - .004, b.z); mk(G.buckle, M.steel, H, 0, b.bot + .004, b.z); }
    // sights: rear notch (two little posts) and a front post with a glowing bead, under a hood
    // the front sight is the critter's own third eye on a stalk: you aim with its pupil
    const SZ = -.43, base = Y0 + bodyR(SZ) * SY - .006;
    { const st = mk(G.stalk, M.lid, H, 0, (base + BEAD_Y - .012) / 2, SZ); st.scale.y = (BEAD_Y - .012 - base) / .1; mk(G.stalkRing, M.glow, H, 0, base + .012, SZ).rotation.x = Math.PI / 2; }
    const bead = new THREE.Group(); bead.position.set(0, BEAD_Y, SZ); H.add(bead);
    mk(G.sEye, M.eye, bead); mk(G.sIris, M.iris, bead, 0, 0, .0128); const sp = mk(G.pupil, M.pupil, bead, 0, 0, .011); sp.scale.set(.45, .45, .3); mk(G.shine, M.shine, bead, .004, .004, .014).scale.setScalar(.6);
    const sLid = mk(G.sLid, M.lid, bead); sLid.rotation.x = -.5;
    // pistol grip under the front band, trigger + guard, and a vertical fore-grip under the rear band
    const grip = mk(G.grip, M.rubber, H, 0, bands[0].bot + .004, -.09);
    mk(G.mount, M.metal, H, 0, bands[0].bot - .006, -.088);
    const guard = mk(G.guard, M.steel, H, 0, -.163, -.13); guard.rotation.set(0, Math.PI / 2, Math.PI * .9);
    const trig = mk(G.trigger, M.amber, H, 0, -.165, -.124); trig.rotation.x = .25;
    mk(G.mount, M.metal, H, 0, bands[1].bot - .006, -.42);
    // a carry handle on its left flank, bolted to the front band: your left hand holds it (you can see it), right next to the bean jar
    const hx = -(bands[0].side + .036), hz = -.15, foreY = Y0 - .005, fore = mk(G.fore, M.rubber, H, hx, foreY, hz); fore.rotation.set(Math.PI / 2, 0, 0); fore.scale.set(.62, .7, .78);
    for (const dy of [-.055, .045]) { const arm = mk(G.mount, M.metal, H, (hx - bands[0].side) / 2 + .002, foreY + dy, hz + .03); arm.rotation.y = Math.PI / 2; arm.scale.set(1.2, .7, 1.4); }
    // bean jar strapped to its left flank: the feeding hand takes the beans from here
    const jx = -(bodyR(-.27) * SX + .047), jar = new THREE.Group(); jar.position.set(jx, Y0 - .01, -.27); H.add(jar);
    mk(G.jar, M.glass, jar).renderOrder = 2; for (const dz of [-.055, .055]) mk(G.jarCap, M.metal, jar, 0, 0, dz);
    { const br = mk(G.mount, M.metal, jar, .028, 0, 0); br.rotation.z = Math.PI / 2; br.scale.set(1, .9, 1.2); }
    for (let k = 0; k < 4; k++) { const b = mk(G.bean, M.bean, jar, ((k % 2) - .5) * .02, (k % 2) * .014 - .01, (k - 1.5) * .024); b.scale.setScalar(.62); b.rotation.set(k, k * 2, 0); }
    { const lb = mk(G.foreRing, M.glow, jar); lb.scale.set(1.5, 1.5, 1.5); }
    // rear vent: a steel collar strapped round its backside on three struts, with an iris nozzle and a glowing core
    const vz = -.565;
    mk(G.collar, M.metal, H, 0, Y0, vz);
    for (const a of [Math.PI / 2, Math.PI * 7 / 6, Math.PI * 11 / 6]) {
      const p0 = V(Math.cos(a) * bands[1].side * .98, Y0 + Math.sin(a) * (bands[1].top - Y0) * .98, -.42), p1 = V(Math.cos(a) * .072, Y0 + Math.sin(a) * .072, vz);
      const st = mk(G.strut, M.steel, H); st.position.copy(p0).lerp(p1, .5); st.scale.y = p0.distanceTo(p1); st.quaternion.setFromUnitVectors(V(0, 1, 0), p1.clone().sub(p0).normalize()); }
    mk(G.nozzle, M.metal, H, 0, Y0, vz - .028);
    const inner = mk(G.nozzleIn, M.vent, H, 0, Y0, vz - .012); inner.rotation.y = Math.PI;
    const core = mk(G.coreDisk, M.core, H, 0, Y0, vz - .016); core.rotation.y = Math.PI;
    for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI * 2, pt = mk(G.petal, M.steel, H, Math.cos(a) * .046, Y0 + Math.sin(a) * .046, vz - .05); pt.rotation.z = a + Math.PI / 2; pt.rotation.x = .5 * Math.sin(a + Math.PI / 2) * 0; }
    const muzzle = V(0, Y0, vz - .06);
    mergeStatic(frills); mergeStatic(spots); for (const L of legs) mergeStatic(L.g); mergeStatic(H, new Set([core, bead]));
    root.userData.critter = true;
    return { root, body, B, head, eyes, mouth, cavity, jaw, tongue, cheeks, legs, H, bead, core, muzzle, grip, fore, topY, jar, foreY, handle: V(hx, foreY, hz), gripTop: bands[0].bot + .004,
      st: { t: Math.random() * 10, blinkT: 1.5, blink: 0, look: V(0, .1, 0), lookTo: V(0, .1, 0), lookT: 0, open: 0, puff: 0, squash: V(1, 1, 1), sq: { x: 0, v: 0 }, legA: [0, 0, 0, 0], legV: [0, 0, 0, 0],
        burpT: rand(8, 13), gurgT: rand(6, 10), whineT: 1.5, burp: 0, gurg: 0, fireT: 9, sighed: true, lidOpen: .15, happy: 0, hungry: 0, chew: 0, pup: 1, prevFlash: false, prevQ: null } };
  }

  PG.buildCritter = buildCritter;
  /* ================= first-person viewmodel ================= */
  function buildPoopVM() {
    const g = new THREE.Group(); g.visible = false; gunScene.add(g);
    const C = buildCritter('fp'); g.add(C.root);
    const M0 = mats(), glove = M0.glove, sleeve = M0.sleeve, G = geos('fp');
    // right hand wrapped round the pistol grip: palm on its back, four fingers across its front, thumb down the left side
    const rear = new THREE.Group(); g.add(rear);
    { const gTop = C.gripTop, zf = y => -.114 + (gTop - y) / .142 * .036;
      const pm = new THREE.Mesh(rbox(.05, .085, .032, .012), glove); pm.position.set(.006, gTop - .068, zf(gTop - .068) + .07); pm.rotation.x = -.25; rear.add(pm);
      // knuckles and finger roots on the back of the hand: what you actually see of a hand on a pistol grip
      for (let k = 0; k < 4; k++) { const kn = new THREE.Mesh(new THREE.SphereGeometry(.0115, 10, 8), glove); kn.position.set(.03, gTop - .03 - k * .023, zf(gTop - .03 - k * .023) + .046); rear.add(kn); }
      { const kp = new THREE.Mesh(rbox(.012, .07, .03, .005), mats().cuff); kp.position.set(.034, gTop - .065, zf(gTop - .065) + .06); kp.rotation.x = -.25; rear.add(kp); }
      for (let k = 0; k < 4; k++) { const y = gTop - .03 - k * .023, f = zf(y);
        capsuleBetween(V(.03, y, f + .05), V(.03, y, f + .004), .0122, glove, rear); capsuleBetween(V(.028, y - .001, f - .003), V(-.022, y - .003, f + .008), .0118, glove, rear); }
      capsuleBetween(V(-.022, gTop - .1, zf(gTop - .1) + .06), V(-.026, gTop - .03, zf(gTop - .03) + .02), .011, glove, rear);
      const w0 = V(.01, gTop - .11, zf(gTop - .11) + .07), w1 = V(.05, gTop - .2, .16); capsuleBetween(w0, w0.clone().lerp(w1, .3), .033, glove, rear); cuffAt(w0.clone().lerp(w1, .3), w1, .039, rear); capsuleBetween(w0.clone().lerp(w1, .25), V(.2, gTop - .5, .8), .046, sleeve, rear); }
    // left hand cupping the fore-end; this whole arm moves when it feeds the critter
    const armRoot = new THREE.Group(); g.add(armRoot);
    const hand = new THREE.Group(); armRoot.add(hand);
    const HAND_REST = C.handle.clone();
    hand.position.copy(HAND_REST);
    { const pm = new THREE.Mesh(rbox(.03, .08, .056, .012), glove); pm.position.set(-.03, 0, .006); hand.add(pm);
      for (let k = 0; k < 4; k++) { const y = .03 - k * .021; capsuleBetween(V(-.03, y, -.022), V(-.008, y, -.034), .0108, glove, hand); capsuleBetween(V(-.006, y, -.034), V(.02, y, -.018), .0102, glove, hand); }
      for (let k = 0; k < 4; k++) { const kn = new THREE.Mesh(new THREE.SphereGeometry(.0112, 10, 8), glove); kn.position.set(-.043, .03 - k * .021, -.014); hand.add(kn); }
      capsuleBetween(V(-.028, .042, .026), V(.006, .05, .006), .011, glove, hand);
      const w0 = V(-.04, -.035, .03), w1 = V(-.13, -.2, .22); capsuleBetween(w0, w0.clone().lerp(w1, .35), .032, glove, hand); cuffAt(w0.clone().lerp(w1, .35), w1, .038, hand); capsuleBetween(w0.clone().lerp(w1, .3), V(-.38, -.58, .75), .047, sleeve, hand); }
    const bean = new THREE.Group(); bean.position.set(-.004, .045, -.03); bean.scale.setScalar(1.35); hand.add(bean); bean.visible = false;
    { const M = mats(); bean.add(new THREE.Mesh(G.bean, M.bean)); for (let k = 0; k < 5; k++) { const s = new THREE.Mesh(G.speck, M.beanSpeck); const a = k * 1.3; s.position.set(Math.cos(a) * .028, .012 + Math.sin(a * 1.7) * .006, Math.sin(a) * .016); bean.add(s); }
      const gl = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex(T.glow), color: new THREE.Color(1.2, .35, .8), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: .8 })); gl.scale.setScalar(.12); bean.add(gl); }
    // the reticle: a soft green dot on the bead (shows when aiming down sights)
    const reticle = new THREE.Group(); reticle.position.copy(C.bead.position); g.add(reticle);
    { const d = new THREE.Mesh(new THREE.CircleGeometry(.0024, 16), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.2, 5, 1), depthTest: false, transparent: true })); d.renderOrder = 5; reticle.add(d); }
    // vent blast: green goo burst sprites at the rear vent
    const fm = new THREE.MeshBasicMaterial({ map: tex(T.star), color: new THREE.Color(1, 3.4, .7), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const flash = new THREE.Group(); flash.position.copy(C.muzzle); g.add(flash);
    flash.add(new THREE.Mesh(new THREE.PlaneGeometry(.62, .62), fm)); const f2 = new THREE.Mesh(new THREE.PlaneGeometry(.26, .8), fm); f2.rotation.y = Math.PI / 2; f2.position.z = -.12; flash.add(f2); const f3 = f2.clone(); f3.rotation.set(0, Math.PI / 2, Math.PI / 2); flash.add(f3);
    flash.visible = false;
    // vent puff: a brown-green cloud bursting from its rear on every shot
    const ventPuff = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex(T.glow), color: new THREE.Color(1.1, .9, .25), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
    ventPuff.position.copy(C.muzzle); ventPuff.position.y += .02; g.add(ventPuff);
    // burp puff (a little green cloud from its mouth)
    const puff = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex(T.glow), color: new THREE.Color(.4, 1.6, .3), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
    puff.position.set(0, Y0 + .02, .22); puff.scale.setScalar(.05); g.add(puff);
    // empty: a little thought bubble with a bean in it ("feed me")
    const bubble = new THREE.Sprite(new THREE.SpriteMaterial({ map: (() => { const c = canvasOf(256), x = c.getContext('2d');
        x.fillStyle = '#c8f5b0'; x.strokeStyle = '#1f4a14'; x.lineWidth = 7;
        x.beginPath(); x.ellipse(140, 96, 104, 80, 0, 0, 6.29); x.fill(); x.stroke(); for (const [cx, cy, r] of [[52, 196, 20], [24, 236, 11]]) { x.beginPath(); x.arc(cx, cy, r, 0, 6.29); x.fill(); x.stroke(); }
        // a kidney bean (green, like the critter's goo) with a dark outline
        const gr = x.createRadialGradient(128, 56, 6, 140, 70, 52); gr.addColorStop(0, '#b6ff6a'); gr.addColorStop(.6, '#4fae22'); gr.addColorStop(1, '#2a6a10'); x.fillStyle = gr; x.strokeStyle = '#173a0a'; x.lineWidth = 5;
        x.beginPath(); x.moveTo(98, 70); x.bezierCurveTo(94, 30, 180, 22, 190, 62); x.bezierCurveTo(196, 96, 166, 108, 148, 92); x.bezierCurveTo(138, 84, 122, 104, 108, 98); x.bezierCurveTo(98, 93, 98, 82, 98, 70); x.fill(); x.stroke();
        x.font = 'bold 38px sans-serif'; x.textAlign = 'center'; x.lineWidth = 6; x.strokeStyle = '#ffffff'; x.strokeText('FEED ME!', 140, 150); x.fillStyle = '#123008'; x.fillText('FEED ME!', 140, 150); return tex(c, true); })(), transparent: true, opacity: 0, depthTest: false, color: new THREE.Color(.82, .82, .82) }));
    bubble.renderOrder = 6; bubble.position.set(-.12, Y0 + .2, .1); bubble.scale.setScalar(.24); g.add(bubble);
    const VS = GUN_SCALE * .88; g.scale.setScalar(VS);
    const adsPos = V(0, -BEAD_Y * VS, -.6 + .07 * VS);
    const vm = { group: g, mag: new THREE.Group(), magPos: V(0, 0, 0), leftArm: new THREE.Group(), rear, flash, reticle, hip: V(.2, -.085, -.64), adsPos, hw: { fx: [], muzzle: null },
      critter: C, arm: { root: armRoot, hand, bean, rest: HAND_REST.clone(), restRot: hand.rotation.clone() }, puff, bubble, ventPuff };
    mergeStatic(rear); mergeStatic(hand, new Set([bean]));
    return vm;
  }
  PG.buildVM = buildPoopVM;

  /* ================= third person (bots, other players, drops, the warm-up) ================= */
  function buildPoopTP() {
    const C = buildCritter('tp'), g = new THREE.Group(), inner = new THREE.Group(); inner.add(C.root);
    const S = .6; inner.rotation.y = Math.PI; inner.scale.setScalar(S);
    const gp = V(0, -.2, -.07).applyAxisAngle(V(0, 1, 0), Math.PI).multiplyScalar(S); inner.position.copy(gp).negate();   // hand on the grip at the origin
    g.add(inner); g.userData.body = inner; g.userData.critter = C;
    g.userData.muzzle = C.muzzle.clone().applyAxisAngle(V(0, 1, 0), Math.PI).multiplyScalar(S).add(inner.position);
    mergeStatic(C.root);   // nothing moves in third person: one mesh per material
    C.root.traverse(o => { if (o.isMesh) o.castShadow = false; });
    return g;
  }
  PG.buildTP = buildPoopTP;

  /* ================= sounds (pre-rendered with the game's own offline synth, played on its buses) ================= */
  const VOICES = {
    // the shot: a cartoon "PFRRRT" (a fluttering low buzz) on a punchy bass thump, a wet splat and a squeaky little tail
    poopFire: { dur: .75, verb: .32, echo: .12, vol: 1.15, fn: L => {
      L.tone(0, 110, 34, .05, .17, 1.25, 'sin', 2.8);
      L.noise(0, 'lp', 900, 160, .07, .9, .1, .9);
      for (let k = 0; k < 16; k++) { const t = .004 + k * .0165 * (1 + k * .035), f = 150 - k * 4.2; L.tone(t, f, f * .82, .02, .016 + k * .0009, .62 * (1 - k / 19), 'sq', 2.4); L.noise(t, 'bp', 520 - k * 14, 300, .02, 1.6, .012, .22 * (1 - k / 18)); }
      L.noise(.01, 'bp', 1800, 700, .08, 1.1, .05, .35);
      L.noise(0, 'hp', 4200, 2400, .06, .7, .025, .3);
      L.tone(.36, 300, 640, .06, .055, .14, 'sq', 1.4); L.tone(.43, 640, 520, .02, .05, .09, 'tri'); } },
    // goo hitting a wall/floor: a wet slap
    poopSplat: { dur: .32, verb: .15, echo: 0, vol: .7, fn: L => { L.noise(0, 'lp', 1300, 260, .05, .9, .045, .9); L.tone(0, 190, 70, .03, .045, .55, 'sin', 2); L.noise(.004, 'bp', 2600, 900, .04, 2.2, .03, .3); L.crackle(.01, 1800, .03, .25, .07); } },
    // goo hitting a body: thicker splat
    poopHitBody: { dur: .35, verb: .12, echo: 0, vol: .8, fn: L => { L.noise(0, 'lp', 900, 200, .06, 1, .06, 1); L.tone(0, 140, 55, .03, .07, .7, 'sin', 2.2); L.noise(.006, 'bp', 1600, 600, .05, 2, .04, .35); } },
    // munching: three crunchy chomps with a happy hum
    poopMunch: { dur: 1.0, verb: .08, echo: 0, vol: .75, fn: L => { for (let k = 0; k < 3; k++) { const t = k * .19; L.noise(t, 'bp', 2400 - k * 200, 900, .03, 2.4, .035, .7); L.noise(t + .01, 'lp', 500, 150, .04, 1, .05, .55); L.tone(t, 160, 110, .02, .04, .3, 'sin', 2); L.crackle(t, 2500, .025, .2, .05); }
      L.tone(.55, 330, 392, .05, .12, .12, 'tri'); L.tone(.68, 392, 494, .05, .14, .1, 'tri'); } },
    // idle burp: "brrup"
    poopBurp: { dur: .55, verb: .2, echo: 0, vol: .55, fn: L => { for (let k = 0; k < 9; k++) { const t = k * .028, f = 105 + Math.sin(k * .9) * 14; L.tone(t, f, f * .9, .02, .026, .55 * (1 - k / 11), 'saw', 2); } L.noise(0, 'bp', 600, 350, .1, 2, .14, .3); L.tone(.22, 140, 230, .05, .06, .15, 'tri'); } },
    // belly gurgle: bubbly blips
    poopGurgle: { dur: .7, verb: .15, echo: 0, vol: .45, fn: L => { for (let k = 0; k < 7; k++) { const t = k * .075 + (k % 2) * .02, f = 180 + (k * 53) % 160; L.tone(t, f, f * 1.9, .03, .035, .35, 'sin'); } L.noise(0, 'lp', 400, 200, .2, 1, .3, .25); } },
    // empty: a hungry little whine "eee-uuu"
    poopWhine: { dur: .8, verb: .25, echo: 0, vol: .5, fn: L => { L.tone(0, 720, 980, .08, .2, .22, 'fm'); L.tone(.2, 980, 610, .12, .3, .2, 'fm'); L.tone(.04, 1440, 1960, .08, .14, .05, 'sin'); L.noise(.15, 'bp', 1200, 900, .2, 3, .2, .06); } },
    // after a shot: a relieved sigh "haaah"
    poopSigh: { dur: .6, verb: .2, echo: 0, vol: .4, fn: L => { L.noise(0, 'bp', 1400, 700, .25, 1.4, .22, .35, .06); L.tone(.02, 330, 240, .2, .2, .12, 'fm'); } },
    // gulp at the bite
    poopGulp: { dur: .3, verb: .1, echo: 0, vol: .6, fn: L => { L.tone(0, 260, 120, .04, .05, .5, 'sin', 1.6); L.noise(0, 'lp', 700, 300, .05, 1.2, .04, .4); L.tone(.07, 180, 420, .05, .05, .2, 'tri'); } },
  };
  Object.assign(GUN_VOICE, VOICES);
  for (const k in VOICES) sfx[k] = function (pos, vol) { return gunVoice(k, pos || null, vol || 1); };
  try { if (AU.ctx) warmGunVoices(); } catch (e) {}
  // every sound obeys the game's voice budget (except your own gunshot, like every other gun)
  function snd(name, pos, vol, kind) { if (PG.disabled) return false; if (state !== 'play' && state !== 'dead') return false; if (!AU.ctx) return false; if (kind && !voice(kind, pos || camera.position)) return false; return gunVoice(name, pos || null, vol || 1); }
  PG.snd = snd;
  // other players' / bots' poop-gun shots
  { const ob = sfx.botShot; sfx.botShot = function (pos, kind) { if (kind === ID) { if (!AU.ctx || !voice('bot', pos)) return; gunVoice('poopFire', pos, .85); return; } return ob.apply(this, arguments); }; }

  /* ================= goo: pellets, splats, decals ================= */
  let PGEO = null;
  function pelletRes() {
    if (PGEO) return PGEO;
    let g = new THREE.IcosahedronGeometry(1, 2); g.deleteAttribute('normal'); g.deleteAttribute('uv'); g = THREE.BufferGeometryUtils.mergeVertices(g); const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i), z = p.getZ(i), n = 1 + .12 * Math.sin(x * 5.1 + y * 3.3) * Math.cos(z * 4.2 - y * 2.1); p.setXYZ(i, x * n, y * n, z * n); }
    g.computeVertexNormals();
    { const n = g.attributes.normal, c = new Float32Array(n.count * 3); for (let i = 0; i < n.count; i++) { const k = .55 + .45 * clamp(n.getY(i) * .7 + n.getZ(i) * .3, -1, 1), hi = Math.pow(clamp(n.getY(i) * .6 + n.getX(i) * .5, 0, 1), 6) * .8; c[i * 3] = k + hi; c[i * 3 + 1] = k + hi; c[i * 3 + 2] = k + hi; } g.setAttribute('color', new THREE.BufferAttribute(c, 3)); }
    PGEO = { g,
      green: new THREE.MeshBasicMaterial({ color: new THREE.Color(.45, 1.7, .25), vertexColors: true }),
      brown: new THREE.MeshBasicMaterial({ color: new THREE.Color(.75, .42, .1), vertexColors: true }),
      glow: new THREE.SpriteMaterial({ map: tex(T.glow), color: new THREE.Color(.45, 1.6, .3), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: .7 }),
      glowB: new THREE.SpriteMaterial({ map: tex(T.glow), color: new THREE.Color(.9, 1.0, .2), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: .55 }) };
    return PGEO;
  }
  function pelletMesh(brown) {
    const R = pelletRes(), m = new THREE.Mesh(R.g, brown ? R.brown : R.green); m.scale.setScalar(D.projectile.radius); m.frustumCulled = false;
    const s = new THREE.Sprite(brown ? R.glowB : R.glow); s.scale.setScalar(brown ? 3.2 : 3.6); m.add(s);
    return m;
  }
  // goo splat decals: one instanced mesh, each splat fades out over its last seconds (alpha per instance)
  const SPLATS = 72, SPLAT_LIFE = 9, SPLAT_FADE = 3.5; let SPL = null;
  function splatTex() {
    const c = canvasOf(128), g = c.getContext('2d'), R = (a, b) => a + Math.random() * (b - a); g.translate(64, 64);
    const blob = (x, y, r, a) => { const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, `rgba(120,90,30,${a})`); gr.addColorStop(.45, `rgba(110,150,30,${a * .97})`); gr.addColorStop(.8, `rgba(120,230,60,${a * .85})`); gr.addColorStop(1, 'rgba(30,80,10,0)'); g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 6.29); g.fill(); };
    blob(0, 0, 30, 1); for (let i = 0; i < 11; i++) { const a = i / 11 * 6.28 + R(-.2, .2), d = R(22, 46); blob(Math.cos(a) * d, Math.sin(a) * d, R(5, 12), R(.75, 1)); }
    for (let i = 0; i < 6; i++) { const a = R(0, 6.28); g.strokeStyle = 'rgba(90,200,50,.85)'; g.lineWidth = R(3, 6); g.lineCap = 'round'; g.beginPath(); g.moveTo(Math.cos(a) * 20, Math.sin(a) * 20); g.lineTo(Math.cos(a) * R(40, 58), Math.sin(a) * R(40, 58)); g.stroke(); }
    g.fillStyle = 'rgba(240,255,220,.55)'; for (let i = 0; i < 5; i++) { g.beginPath(); g.arc(R(-16, 12), R(-16, 6), R(2, 4.5), 0, 6.29); g.fill(); }   // wet highlights
    return c;
  }
  function splats() {
    if (SPL) { if (SPL.im.parent !== scene) scene.add(SPL.im); return SPL; }
    const geo = new THREE.PlaneGeometry(1, 1), fade = new THREE.InstancedBufferAttribute(new Float32Array(SPLATS), 1); geo.setAttribute('aFade', fade);
    const map = tex(splatTex(), true);
    const mat = new THREE.MeshStandardMaterial({ map, emissiveMap: map, emissive: new THREE.Color(.22, .7, .12), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -5, roughness: .15, metalness: 0, envMapIntensity: .9 });
    mat.onBeforeCompile = s => { s.vertexShader = 'attribute float aFade;\nvarying float vFade;\n' + s.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vFade = aFade;');
      s.fragmentShader = 'varying float vFade;\n' + s.fragmentShader.replace('#include <dithering_fragment>', '#include <dithering_fragment>\n gl_FragColor.a *= vFade;'); };
    mat.customProgramCacheKey = () => 'pg-splat';
    const im = new THREE.InstancedMesh(geo, mat, SPLATS); im.frustumCulled = false; im.renderOrder = 1;
    const d = new THREE.Object3D(); d.position.set(0, -60, 0); d.scale.setScalar(0); d.updateMatrix(); for (let i = 0; i < SPLATS; i++) im.setMatrixAt(i, d.matrix);
    scene.add(im);
    SPL = { im, fade, born: new Float64Array(SPLATS).fill(-99), idx: 0, dummy: d, live: 0 };
    return SPL;
  }
  function addSplat(p, n, size) {
    const S = splats(), d = S.dummy, i = S.idx; S.idx = (S.idx + 1) % SPLATS;
    d.position.copy(p).addScaledVector(n, .014 + Math.random() * .004); d.lookAt(p.x + n.x, p.y + n.y, p.z + n.z); d.rotateZ(rand(0, 6.28)); d.scale.set(size * rand(.85, 1.2), size * rand(.85, 1.2), 1); d.updateMatrix();
    S.im.setMatrixAt(i, d.matrix); S.im.instanceMatrix.needsUpdate = true; S.born[i] = G.time; S.fade.array[i] = 1; S.fade.needsUpdate = true; PG.stats.decals++;
  }
  function updateSplats() {
    if (!SPL) return; let dirty = false, live = 0;
    for (let i = 0; i < SPLATS; i++) { const b = SPL.born[i]; if (b < -98) continue; const age = G.time - b;
      if (age < -1 || age > SPLAT_LIFE) {   /* -1: a new match restarted the clock */ SPL.born[i] = -99; SPL.dummy.position.set(0, -60, 0); SPL.dummy.scale.setScalar(0); SPL.dummy.updateMatrix(); SPL.im.setMatrixAt(i, SPL.dummy.matrix); SPL.im.instanceMatrix.needsUpdate = true; SPL.fade.array[i] = 0; dirty = true; continue; }
      live++; const f = clamp((SPLAT_LIFE - age) / SPLAT_FADE, 0, 1), v = ez(f); if (Math.abs(SPL.fade.array[i] - v) > .004) { SPL.fade.array[i] = v; dirty = true; } }
    if (dirty) SPL.fade.needsUpdate = true; SPL.live = live;
  }
  function clearSplats() { if (!SPL) return; for (let i = 0; i < SPLATS; i++) { SPL.born[i] = -99; SPL.fade.array[i] = 0; SPL.dummy.position.set(0, -60, 0); SPL.dummy.scale.setScalar(0); SPL.dummy.updateMatrix(); SPL.im.setMatrixAt(i, SPL.dummy.matrix); } SPL.im.instanceMatrix.needsUpdate = true; SPL.fade.needsUpdate = true; }
  PG.splats = () => SPL;

  // the spread: 1 centre + an inner ring + an outer ring, the whole pattern turned randomly each shot (shared by every machine via the seed)
  function pattern(seed, tight) {
    const r = mulberry(seed >>> 0), P2 = D.pattern, rot = r() * 6.283, out = [[0, 0]];
    for (let k = 0; k < P2.inner; k++) { const a = rot + k / P2.inner * 6.283; out.push([Math.cos(a) * P2.innerR, Math.sin(a) * P2.innerR]); }
    for (let k = 0; k < P2.outer; k++) { const a = rot + .6 + k / P2.outer * 6.283; out.push([Math.cos(a) * P2.outerR, Math.sin(a) * P2.outerR]); }
    for (const q of out) { const a = r() * 6.283, m = Math.sqrt(r()) * P2.jitter; q[0] = (q[0] + Math.cos(a) * m) * tight; q[1] = (q[1] + Math.sin(a) * m) * tight; }
    return out.slice(0, WEAPONS[ID].pellets || 9);
  }
  const _bx = V(0, 0, 0), _by = V(0, 0, 0), _up = V(0, 1, 0);
  function basis(d) { const up = Math.abs(d.y) > .97 ? V(1, 0, 0) : _up; _bx.crossVectors(d, up).normalize(); _by.crossVectors(_bx, d).normalize(); }
  // spawn one shot's pellets; owner = entity, visual = true when another machine decides its hits
  function spawnShot(owner, eye, dir, seed, tight, visFrom, visual, extra) {
    const d = dir.clone().normalize(); basis(d); const pts = pattern(seed, tight), sp = D.projectile.speed, list = [];
    const shot = { id: ++PG.stats.shots, owner, seed, t: G.time, n: pts.length, hits: new Set(), pellHits: 0, victims: new Map(), visual: !!visual };
    pts.forEach(([ax, ay], i) => {
      const pd = d.clone().addScaledVector(_bx, ax).addScaledVector(_by, ay).normalize();
      const m = pelletMesh(i % 2 === 0); const pos = eye.clone(); m.position.copy(visFrom || eye); scene.add(m);
      const pr = { kind: 'poop', m, v: pd.multiplyScalar(sp * rand(.97, 1.03)), owner, visual: !!visual, life: 1e9, ttl: D.projectile.life, stuck: 1e9, hit: new Set(), w: WEAPONS[ID], pos, off: visFrom ? visFrom.clone().sub(eye).normalize().sub(pd.clone().normalize()) : V(0, 0, 0), eye: eye.clone(), age: 0, shot, spin: V(rand(-9, 9), rand(-9, 9), rand(-9, 9)), wob: rand(0, 6) };
      PROJ.push(pr); list.push(pr);
    });
    if (extra) Object.assign(shot, extra);
    PG.shotLog.push(shot); if (PG.shotLog.length > 40) PG.shotLog.shift();
    return shot;
  }
  PG.spawnShot = spawnShot;
  const _p0 = V(0, 0, 0), _p1 = V(0, 0, 0), _dv = V(0, 0, 0), _q = V(0, 0, 0), _n = V(0, 0, 0);
  const pending = new Map();   // damage collected this frame, per victim (one hit/net message per victim per frame, not per pellet)
  function queueDamage(e, owner, dmg, crit, zone, point, dir, pellets) {
    let b = pending.get(e); if (!b) { b = { owner, dmg: 0, crit: false, zone, point: point.clone(), dir: dir.clone(), pellets: 0 }; pending.set(e, b); }
    b.dmg += dmg; b.crit = b.crit || crit; if (zone === 'head' || (zone === 'body' && b.zone === 'limb')) b.zone = zone; b.pellets += pellets;
  }
  function flushDamage() {
    for (const [e, b] of pending) {
      try {
        if (!entAlive(e)) continue;
        const byMe = b.owner === PLAYER_ENT, od = byMe && P.odT > 0 ? 1.25 : 1;
        damageEntity(e, b.dmg * od, b.crit, b.point, b.dir, b.zone, b.owner, ID);
        // a shove in the direction the goo was flying
        const kb = D.knockback;
        if (e.isPlayer) { const k = Math.min(kb.max, kb.perPellet * b.pellets); P.vel.x += b.dir.x * k; P.vel.z += b.dir.z * k; P.vel.y += Math.min(1.2, .12 * b.pellets); }
        else if (!e.remote && e.vel) { const k = Math.min(kb.max, kb.botPerPellet * b.pellets); e.vel.x += b.dir.x * k; e.vel.z += b.dir.z * k; }
      } catch (er) { warn(er); }
    }
    pending.clear();
  }
  function gooBurst(p, n, big) {
    const k = big ? 1.4 : 1;
    for (let i = 0; i < 9 * k; i++) FX.spawn(p, n.x * rand(1, 3) + rand(-2.2, 2.2), n.y * rand(1, 3) + rand(.5, 3.2), n.z * rand(1, 3) + rand(-2.2, 2.2), 1.4, 2.4, .3, rand(.03, .06), rand(.3, .55), 9, 1);
    for (let i = 0; i < 3 * k; i++) FX.spawn(p, rand(-1, 1), rand(.5, 2), rand(-1, 1), .9, 1.4, .2, rand(.05, .09), rand(.25, .45), 6, .8);
  }
  let splatSndShot = 0, splatSndN = 0;
  function pelletImpact(pr, point, n, ent, zone) {
    const sh = pr.shot, p = point;
    if (ent) {
      gooBurst(p, _n.copy(pr.v).normalize().negate(), true);
      if (!pr.visual) { const w = pr.w, k = falloffK(w, pr.dist || 0), mult = zone === 'head' ? w.head : zone === 'limb' ? (w.limb || .75) : 1;
        const dmg = (pr.owner === PLAYER_ENT ? w.dmg : (BOTW[ID].dmg || w.dmg)) * k * mult; queueDamage(ent, pr.owner, dmg, zone === 'head', zone, p, _dv.copy(pr.v).normalize(), 1);
        if (pr.owner === PLAYER_ENT && !sh.hits.has(ent)) G.hits++; sh.pellHits++; sh.hits.add(ent); sh.victims.set(ent, (sh.victims.get(ent) || 0) + 1); PG.stats.pelletHits++; }
      if (sh.id !== splatSndShot) { splatSndShot = sh.id; splatSndN = 0; } if (splatSndN++ < 1) snd('poopHitBody', p.clone(), 1, 'impact');
    } else {
      gooBurst(p, n, false);
      if (Math.random() < .7 || pr.visual) addSplat(p, n, rand(.32, .5));
      if (sh.id !== splatSndShot) { splatSndShot = sh.id; splatSndN = 0; } if (splatSndN++ < 2) snd('poopSplat', p.clone(), 1, 'impact');
      // splash: a little damage to anyone standing right next to where it landed (never the shooter)
      if (!pr.visual) { const S = D.splash;
        for (const e of entities()) { if (e === pr.owner || !entAlive(e) || pr.hit.has(e)) continue; const c = entChest(e, _q); const pe = entPos(e); const dd = Math.min(c.distanceTo(p), Math.hypot(pe.x - p.x, Math.max(0, pe.y - p.y), pe.z - p.z)); if (dd > S.r) continue;
          const dmg = S.dmg * (1 - dd / S.r); queueDamage(e, pr.owner, dmg, false, 'body', c, _dv.copy(c).sub(p).normalize(), .3); PG.stats.splash++; sh.splash = (sh.splash || 0) + dmg; } }
    }
  }
  // one pellet's flight this frame: bodies by their hit boxes (plus the blob's own radius), the world by its collision boxes
  // (gameplay never tests the detailed render meshes), the floor by the ground height
  const RC = new THREE.Raycaster(), RAY = new THREE.Ray(), _sb = new THREE.Box3(), _c1 = V(0, 0, 0), _c2 = V(0, 0, 0), _s1 = V(0, 0, 0), BOXES = [];
  function sweep(pr, a, dir, L) {
    let best = null;
    const b = _p1.copy(a).addScaledVector(dir, L), rad = D.projectile.radius;
    // bodies
    for (const r of robots) {
      if (r === pr.owner || r.dead || pr.hit.has(r) || !r.meshes) continue;
      const rp = r.root.position; { const tt = clamp((rp.x - a.x) * dir.x + (rp.z - a.z) * dir.z, 0, L), qx = a.x + dir.x * tt - rp.x, qz = a.z + dir.z * tt - rp.z; if (qx * qx + qz * qz > 1.44) continue; }
      RC.set(a, dir); RC.far = L; const hs = RC.intersectObjects(r.meshes, false);
      if (hs.length) { const h = hs[0]; if (!best || h.distance < best.dist) best = { ent: r, dist: h.distance, point: h.point.clone(), zone: h.object.userData.zone || 'body' }; continue; }
      // the blob is ~13 cm wide: a near miss that brushes the torso or head still lands
      const eye = entEye(r, _c1), chest = entChest(r, _c2);
      for (const [c, R0, zone] of [[eye, .2 + rad, 'head'], [chest, .25 + rad, 'body']]) {
        const t = clamp(_s1.subVectors(c, a).dot(dir), 0, L), q = _s1.copy(a).addScaledVector(dir, t);
        const dx = q.x - c.x, dz = q.z - c.z, dy = q.y - c.y, near = zone === 'head' ? Math.hypot(dx, dy, dz) < R0 : Math.hypot(dx, dz) < R0 && q.y > rp.y + .15 && q.y < c.y + .25;
        if (near && (!best || t < best.dist)) { best = { ent: r, dist: t, point: q.clone(), zone }; break; } }
    }
    // you (when it isn't your own goo)
    if (pr.owner !== PLAYER_ENT && state === 'play' && !P.dead) { const t = rayCapsule(a, dir, P.pos, P.camY, .36 + rad); if (t !== null && t < L && (!best || t < best.dist)) { const pt = a.clone().addScaledVector(dir, t); best = { ent: PLAYER_ENT, dist: t, point: pt, zone: pt.y > P.pos.y + P.camY - .22 ? 'head' : 'body' }; } }
    // walls, crates, floors of upper levels: exact ray-vs-box entry against the boxes this segment can touch
    _sb.makeEmpty().expandByPoint(a).expandByPoint(b); RAY.origin.copy(a); RAY.direction.copy(dir);
    const cols = world.colliders;
    for (let ci = 0; ci < cols.length; ci++) { const c = cols[ci]; if (!c.intersectsBox(_sb)) continue;
      const hit = c.containsPoint(a) ? null : RAY.intersectBox(c, _s1); if (!hit) continue; const t = hit.distanceTo(a); if (t > L || (best && t >= best.dist)) continue;
      const e = 1e-3, nn = V(0, 0, 0); if (Math.abs(hit.x - c.min.x) < e) nn.x = -1; else if (Math.abs(hit.x - c.max.x) < e) nn.x = 1; else if (Math.abs(hit.y - c.min.y) < e) nn.y = -1; else if (Math.abs(hit.y - c.max.y) < e) nn.y = 1; else if (Math.abs(hit.z - c.min.z) < e) nn.z = -1; else nn.z = 1;
      best = { ent: null, dist: t, point: hit.clone(), n: nn }; }
    // the ground
    const gy = 0;   // the base floor (raised floors are collision boxes, handled above)
    if (b.y < gy && (!best || best.ent === null || best.dist > L * .999)) { const t = a.y > gy ? clamp((a.y - gy) / Math.max(1e-4, a.y - b.y), 0, 1) * L : 0;
      if (!best || t < best.dist) best = { ent: null, dist: t, point: a.clone().addScaledVector(dir, t).setY(gy), n: V(0, 1, 0) }; }
    return best;
  }
  PG.sweep = sweep;
  function updatePellets(dt) {
    if (!PROJ.length) return;
    const t0 = performance.now();
    if (targetsDirty) rebuildTargets();
    for (let i = PROJ.length - 1; i >= 0; i--) {
      const pr = PROJ[i]; if (pr.kind !== 'poop') continue;
      if (PG.dbg.until != null && pr.age >= PG.dbg.until) continue;   // render/test only: hold the goo mid-flight
      pr.age += dt; pr.ttl -= dt;
      const prev = _p0.copy(pr.pos); pr.v.y -= D.projectile.gravity * dt; pr.pos.addScaledVector(pr.v, dt);
      const L = prev.distanceTo(pr.pos); let end = false;
      if (L > 1e-5) {
        _dv.subVectors(pr.pos, prev).divideScalar(L);
        const res = sweep(pr, prev, _dv, L);
        pr.dist = (pr.dist || 0) + (res ? res.dist : L);
        if (res && res.ent) { pr.hit.add(res.ent); pelletImpact(pr, res.point, null, res.ent, res.zone || 'body'); end = true; }
        else if (res) { pelletImpact(pr, res.point, res.n.clone(), null); end = true; }
        if (!end && pr.pos.y < -2) end = true;
        if (!end && (Math.abs(pr.pos.x) > HALF + 3 || Math.abs(pr.pos.z) > HALF + 3)) end = true;
      }
      if (pr.ttl <= 0) end = true;
      if (end) { scene.remove(pr.m); PROJ.splice(i, 1); continue; }
      // draw: starts at the vent, slides onto its true path in the first ~0.1 s; wobbles like goo, stretched along its flight
      const k = Math.max(0, 1 - pr.age / D.projectile.converge), kk = Math.pow(k, 1.6);
      pr.m.position.copy(pr.pos).addScaledVector(pr.off, kk * Math.max(.6, pr.pos.distanceTo(pr.eye)));   // drawn leaving the vent: the offset is an angle, so it holds on screen as the goo flies away
      const sp = pr.v.length(), wob = Math.sin(pr.age * 38 + pr.wob) * .14, base = D.projectile.radius;
      pr.m.quaternion.setFromUnitVectors(_up, _q.copy(pr.v).divideScalar(sp || 1));
      const st = pr.age < .1 ? 1.7 - pr.age * 4 : 1.3; pr.m.scale.set(base * (1 - wob * .5), base * (st + wob), base * (1 - wob * .5));
      if (pr.m.children[0]) pr.m.children[0].visible = pr.age > .025;   // no big glow right in front of the lens (overdraw)
      if (Math.random() < .45) FX.spawn(pr.m.position, rand(-.25, .25) - pr.v.x * .04, rand(-.4, .1) - pr.v.y * .04, rand(-.25, .25) - pr.v.z * .04, .55, 1.3, .2, rand(.025, .04), rand(.12, .22), 2, .6);
    }
    flushDamage();
    const ms = performance.now() - t0; PG.perf.n++; PG.perf.total += ms; PG.perf.max = Math.max(PG.perf.max, ms);
  }
  PG.updatePellets = updatePellets;

  /* ================= firing ================= */
  const R = { active: false, cyc: 0, need: 0, food: 0, bitten: false, total: 0, munchT: 0, chew: 0 };
  PG.reloadState = R;
  const RL_BIG = 1e5;
  function aimEye() { return camera.position.clone(); }
  function firePoop() {
    const w = WEAPONS[ID];
    P.shield = 0;
    if (P.switchT > 0) return;
    if (R.active) { if (P.ammo > 0) { cancelReload(true); PG.stats.interrupts++; } else return; }   // feeding is interrupted by pulling the trigger
    if (P.reload > 0) return;
    if (P.ammo <= 0) { if (P.fireCd <= 0) { snd('poopWhine', null, .9); PG.stats.whines++; const C = vmC(); if (C) { C.st.whineT = 2.4; C.st.whinePose = 1; } P.fireCd = .35; } if (P.reserve > 0) startReload(); return; }
    P.ammo--; G.fired++; P.fireCd = 60 / w.rpm / (P.odT > 0 ? 1.35 : 1); noise(camera.position, 45, PLAYER_ENT);
    if (G.time - P.lastShot > .25) P.shotIdx = 0; P.shotIdx++; P.lastShot = G.time;
    camera.updateMatrixWorld(); camera.getWorldDirection(shotDir); camRight.set(1, 0, 0).applyQuaternion(camera.quaternion); camUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
    const ads = P.ads, Pt = D.pattern;
    let tight = (1 - ads * Pt.adsTighten) * (1 - P.crouch * Pt.crouchTighten);
    const dir = shotDir.clone();
    if (!P.onGround) { const a = rand(0, 6.28), m = Math.sqrt(Math.random()) * Pt.airJitter; dir.addScaledVector(camRight, Math.cos(a) * m).addScaledVector(camUp, Math.sin(a) * m).normalize(); }
    // the goo leaves the critter's rear vent on screen (at the hip: lower right; aimed: just under the sights)
    const vent = ventWorld(ads);
    const seed = (Math.random() * 4294967296) >>> 0, eye = aimEye();
    const shot = spawnShot(PLAYER_ENT, eye, dir, seed, tight, vent, false, { ads, tight });
    PG.lastShot = shot;
    netPoop(eye, dir, seed, tight);
    // feel: a big soft shove, the critter wiggles
    const kick = lerp(1, .6, ads) * (1 - P.crouch * .25) * w.kick, climb = (.0085 + rand(0, .002)) * kick;
    P.pitch += climb; P.yaw += rand(-.003, .003) * kick; P.recoilAcc += climb;
    springs.kickZ.v += lerp(1.7, 1, ads) * Math.min(kick, 2.5); springs.kickRot.v += lerp(3.2, 1.3, ads) * rand(.8, 1.2) * Math.min(kick, 2.5); springs.camKick.v += .55 * kick;
    P.trauma = Math.min(1, P.trauma + .05 * w.kick);
    sfx.poopFire();
    muzzleFlash.visible = true; muzzleFlash.rotation.z = rand(0, 6.28); muzzleFlash.scale.setScalar(rand(.85, 1.2)); P.flashT = .06;
    lightFlash(vent, new THREE.Color(.25, 1.1, .2), 8, 10);
    for (let i = 0; i < 10; i++) FX.spawn(vent, shotDir.x * rand(3, 8) + rand(-1.4, 1.4), shotDir.y * rand(3, 8) + rand(-.6, 1.6), shotDir.z * rand(3, 8) + rand(-1.4, 1.4), .5, 2.3, .3, rand(.03, .06), rand(.2, .4), 6, 1);
    for (let k = 0; k < 1; k++) SMOKE.spawn(vent, shotDir.x * rand(1, 2.5) + rand(-.4, .4), rand(.1, .5), shotDir.z * rand(1, 2.5) + rand(-.4, .4), .32, .4, .14, rand(.12, .2), rand(.6, 1), -.2, 2, .9, .55);
    const C = vmC(); if (C) { C.st.fireT = 0; C.st.sighed = false; C.st.burpT = Math.max(C.st.burpT, 4); }
    updateHud();
    if (P.ammo === 0 && P.reserve > 0) setTimeout(() => { if (state === 'play' && P.weapon === ID && P.ammo === 0 && !R.active) startReload(); }, 420);
  }
  PG.fire = firePoop;
  const vmC = () => WM[ID] && WM[ID].critter;
  // where the critter's rear vent is on screen, as a point in the world ~0.8 m in front of you (the viewmodel has its own camera)
  const _vw = V(0, 0, 0);
  function ventWorld(ads) {
    const vm = WM[ID];
    try { if (vm && gunVisible) { vm.group.updateMatrixWorld(true); gunCam.updateMatrixWorld(); vm.flash.getWorldPosition(_vw); _vw.project(gunCam);
        if (Math.abs(_vw.x) < 1.2 && Math.abs(_vw.y) < 1.2) { _vw.x *= .72; _vw.y *= .72; _vw.z = .5;   // just past the vent on screen (the critter itself is drawn over its own vent)
          _vw.unproject(camera); const d = _vw.sub(camera.position).normalize(); return camera.position.clone().addScaledVector(d, .8); } } } catch (e) {}
    return V(.13 * (1 - ads), -.12 * (1 - ads) - .055 * ads, -.62).applyMatrix4(camera.matrixWorld);
  }

  /* ================= reload: one space bean at a time ================= */
  function beginReload() {
    if (R.active || P.switchT > 0 || P.ammo >= P.mag || P.reserve <= 0 || P.dead) return;
    const RC = D.reloadCycle;
    R.active = true; R.cyc = -RC.startDelay / RC.cycle; R.food = 0; R.bitten = false; R.need = Math.ceil(Math.min(P.mag - P.ammo, P.reserve) / RC.perFood); R.total = R.need;
    P.reloadEmpty = P.ammo === 0; P.reloadStage = 3; P.boltT = 0; P.reloadDur = RL_BIG; P.reload = RL_BIG * .999;
  }
  function cancelReload(byFire) { R.active = false; R.bitten = false; if (P.reload > 0) P.reload = 0; const vm = WM[ID]; if (vm) vm.arm.bean.visible = false; if (byFire) R.interruptT = G.time; }
  PG.cancelReload = cancelReload;
  function tickReload(dt) {
    if (!R.active) return;
    if (P.weapon !== ID || P.reload <= 0 || P.dead || state !== 'play') { cancelReload(false); return; }
    const RC = D.reloadCycle; R.cyc += dt / RC.cycle;
    if (!R.bitten && R.cyc >= RC.bite) {
      R.bitten = true; const add = Math.min(RC.perFood, P.mag - P.ammo, P.reserve);
      if (add > 0) { P.ammo += add; P.reserve -= add; PG.stats.foods++; PG.stats.shells += add; updateHud(); }
      snd('poopGulp', null, .9); setTimeout(() => { if (P.weapon === ID && state === 'play') snd('poopMunch', null, .85); }, 60);
    }
    if (R.cyc >= 1) { R.food++; R.cyc = 0; R.bitten = false;
      if (P.ammo >= P.mag || P.reserve <= 0) { R.active = false; P.reload = 0; updateHud(); return; }
      R.need = Math.ceil(Math.min(P.mag - P.ammo, P.reserve) / RC.perFood); R.total = R.food + R.need; }
    const prog = clamp((R.food + Math.max(0, R.cyc)) / Math.max(1, R.total), 0, .999);
    P.reload = RL_BIG * (1 - prog); if (P.reload < 1) P.reload = 1;
  }
  PG.tickReload = tickReload;

  /* ================= online: our shots go to the other players as one compact projectile message ================= */
  const NETK = 4;   // index after the game's own ['bolt','disc','missile','boom']
  function netPoop(eye, dir, seed, tight) {
    if (!NET.on) return; NET.seq.proj = (NET.seq.proj || 0) + 1; const R2 = x => Math.round(x * 100) / 100, R4 = x => Math.round(x * 1e4) / 1e4;
    NET.proj = [NET.seq.proj, NETK, R2(eye.x), R2(eye.y), R2(eye.z), R4(dir.x), R4(dir.y), R4(dir.z), seed, R2(tight)];
  }
  let suppress = 0;
  { const _sp = spawnProj; spawnProj = function () { if (suppress) return; return _sp.apply(this, arguments); }; }
  { const _nr = netReceive; netReceive = function (E, pr) {
      let mine = false;
      try { const L = E && E.last; if (pr && Array.isArray(pr.pj) && (pr.pj[1] | 0) === NETK && pr.pj[0] > ((L && L.proj) || 0) && !PG.disabled) mine = true; } catch (e) { warn(e); }
      if (!mine) return _nr.apply(this, arguments);
      // the game would read an unknown kind as a crossbow bolt: keep its bookkeeping (and the killcam's), skip its bolt + twang
      const ob = sfx.crossbow; suppress++; sfx.crossbow = () => {};
      let out; try { out = _nr.apply(this, arguments); } finally { suppress--; sfx.crossbow = ob; }
      try { const r = E.r, q = pr.pj, eye = V(+q[2], +q[3], +q[4]), dir = V(+q[5], +q[6], +q[7]); if (r && isFinite(eye.x) && dir.lengthSq() > .5) {
          let from = null; try { r.muzzle.getWorldPosition(_q); from = _q.clone(); if (from.distanceTo(eye) > 3) from = null; } catch (e) {}
          spawnShot(r, eye, dir, (+q[8]) >>> 0, +q[9] || 1, from, true); PG.stats.remoteShots++; PG.stats.remotePellets += WEAPONS[ID].pellets;
          r.flashT = .06; r.shotKick = 1; r.firedT = 1.4; sfx.botShot(eye.clone(), ID); } } catch (e) { warn(e); }
      return out; }; }

  /* ================= bots can carry it too (a bot profile with weapon "poopgun") ================= */
  { const _bs = botShoot; botShoot = function (r, aimPoint) {
      if (r.weapon !== ID || PG.disabled) return _bs.apply(this, arguments);
      try {
        r.ammo--; r.firedT = 1.4; r.shotKick = 1; recFire(r); r.flashT = .06; r.shots = (r.shots || 0) + 1; PG.stats.botShots++;
        const eye = entEye(r, V(0, 0, 0)), d = aimPoint.clone().sub(eye).normalize();
        const t = r.target, tv = t ? (t.isPlayer ? Math.hypot(P.vel.x, P.vel.z) : Math.hypot(t.vel.x, t.vel.z)) : 0, moving = Math.hypot(r.vel.x, r.vel.z) > 1 ? 1 : 0;
        const err = r.aimErr0 * Math.exp(-r.trackT * 1.6 * r.skill) + .016 / r.skill * (1 + tv * .14) + moving * .012;
        basis(d); const a = rand(0, 6.283), m = Math.sqrt(Math.random()) * err; d.addScaledVector(_bx, Math.cos(a) * m).addScaledVector(_by, Math.sin(a) * m).normalize();
        r.muzzle.getWorldPosition(_q); const from = _q.clone();
        spawnShot(r, eye, d, (Math.random() * 4294967296) >>> 0, 1, from, false);
        const audible = state === 'play' || state === 'dead';
        if (audible && camera.position.distanceTo(from) < 70) sfx.botShot(from.clone(), ID);
        if (camera.position.distanceTo(from) < 16) lightFlash(from, 0x66ff55, 2.5, 7);
        noise(from, 42, r);
      } catch (e) { warn(e); }
    }; }

  /* ================= the critter comes alive (first person; also in the killcam replay) ================= */
  const _e1 = new THREE.Euler();
  function animCritter(vm, dt, o) {
    const C = vm.critter, S = C.st; if (!C) return;
    dt *= PG.dbg.slow; S.t += dt; const t = S.t;
    const reloading = o.reload >= 0, hungry = o.ammo === 0 && !reloading;
    // --- firing timeline: scrunch (0-.07), blast stretch + leg kick (.07-.3), relieved sigh (.3-.85)
    S.fireT += dt; if (PG.dbg.until != null) S.fireT = Math.min(S.fireT, PG.dbg.until); const f = S.fireT;
    const scrunch = f < .07 ? ez01(f / .03) : f < .24 ? 1 - ez01((f - .07) / .17) : 0;
    const relief = f > .26 && f < 1.05 ? Math.sin(Math.PI * seg(f, .26, 1.05)) : 0;
    if (!S.sighed && f > .34) { S.sighed = true; if (o.live && Math.random() < .55) snd('poopSigh', null, .7); }
    // squash & stretch spring: a shot kicks it
    if (f < dt * 1.5) S.sq.v -= 14;
    { const a = -260 * S.sq.x - 15 * S.sq.v; S.sq.v += a * dt; S.sq.x += S.sq.v * dt; }
    const breathe = Math.sin(t * 2.3) * .016, sq = clamp(S.sq.x, -.25, .25);
    // --- belly gurgle and burps (rare, only when calm)
    const calm = f > 2.5 && !reloading && !hungry && o.live;
    S.gurgT -= dt; if (S.gurgT <= 0) { S.gurgT = rand(7, 12); if (calm) { S.gurg = 1; snd('poopGurgle', null, .8); PG.stats.gurgles++; } }
    S.gurg = Math.max(0, S.gurg - dt * 1.4);
    S.burpT -= dt; if (S.burpT <= 0) { S.burpT = rand(9, 15); if (calm) { S.burp = 1; setTimeout(() => { if (P.weapon === ID && state === 'play') snd('poopBurp', null, .8); }, 160); PG.stats.burps++; } }
    const bp = S.burp > 0 ? 1 - S.burp : 0; S.burp = Math.max(0, S.burp - dt * 1.25);
    const burpPuff = S.burp > 0 ? (bp < .2 ? ez01(bp / .2) : bp < .32 ? 1 : 1 - ez01((bp - .32) / .25)) : 0;   // cheeks fill up...
    const burpOpen = S.burp > 0 && bp > .3 && bp < .7 ? Math.sin(Math.PI * seg(bp, .3, .7)) : 0;              // ...then "brrup"
    if (vm.ventPuff) { const k = f < .45 ? f / .45 : 1; vm.ventPuff.material.opacity = f < .45 ? (1 - k) * (1 - k) * .9 : 0; vm.ventPuff.scale.setScalar(.12 + ez(k) * .55); vm.ventPuff.position.z = C.muzzle.z - k * .12; }
    if (vm.puff) { const sg2 = f > .34 && f < .9 ? seg(f, .34, .9) : 0, pk = S.burp > 0 && bp > .32 ? seg(bp, .32, 1) : sg2; vm.puff.material.opacity = pk > 0 ? Math.sin(Math.PI * pk) * .55 : 0; vm.puff.scale.setScalar(.03 + pk * .1); vm.puff.position.y = Y0 + .02 + pk * .05; }
    // --- hungry: looks up at you and whines now and then
    S.hungry = damp(S.hungry, hungry ? 1 : 0, 6, dt);
    if (hungry && o.live) { S.whineT -= dt; if (S.whineT <= 0) { S.whineT = rand(2.6, 3.6); S.whinePose = 1; snd('poopWhine', null, .55); PG.stats.whines++; } }
    S.whinePose = Math.max(0, (S.whinePose || 0) - dt * 1.4);
    if (vm.bubble) { const k = clamp((S.hungry - .5) * 2, 0, 1) * (o.ads > .5 ? 0 : 1); vm.bubble.material.opacity = k; vm.bubble.visible = k > .01; vm.bubble.position.y = Y0 + .21 + Math.sin(t * 2.4) * .006; vm.bubble.scale.setScalar(.24 * (.85 + .15 * k)); }
    // --- feeding: hand to the pouch, bean to the mouth, chomp, chew
    const RC = D.reloadCycle, cy = reloading ? clamp(o.reload, 0, 1) : -1;
    let mouthOpen = 0, chew = 0, happy = 0, eat = 0;
    if (cy >= 0) {
      eat = 1;
      mouthOpen = cy > .36 && cy < RC.bite ? ez01((cy - .36) / .12) : 0;
      if (cy >= RC.bite) { const c = (cy - RC.bite) / (1 - RC.bite); chew = Math.abs(Math.sin(c * Math.PI * 3)) * (1 - c * .3); happy = Math.sin(Math.PI * clamp(c * 1.2, 0, 1)); }
    }
    S.chew = damp(S.chew, chew, 25, dt); S.happy = damp(S.happy, Math.max(happy, relief * .8), 10, dt);
    // --- eyes: blink, look around, look at your hand, look at you when hungry or eating
    S.blinkT -= dt; if (S.blinkT <= 0) { S.blinkT = rand(1.8, 4.6); S.blink = 1; PG.stats.blinks++; }
    const bl = S.blink > 0 ? Math.sin(Math.PI * (1 - S.blink)) : 0; S.blink = Math.max(0, S.blink - dt / .16);
    S.lookT -= dt; if (S.lookT <= 0) { S.lookT = rand(.5, 1.9); const r = Math.random();
      if (r < .3) S.lookTo.set(0, .18, 0); else if (r < .5) S.lookTo.set(.4, -.38, 0); else if (r < .65) S.lookTo.set(-.45, -.25, 0); else S.lookTo.set(rand(-.55, .55), rand(-.2, .3), 0); }
    const want = _q.copy(S.lookTo);
    if (hungry || S.whinePose > 0) want.set(0, .42, 0); if (eat) want.set(cy < .36 ? -.5 : 0, cy < .36 ? -.4 : -.15, 0); if (f < .3) want.set(rand(-.06, .06), rand(-.06, .06), 0);
    S.look.x = damp(S.look.x, want.x, 22, dt); S.look.y = damp(S.look.y, want.y, 22, dt);
    let lid = -.3 + bl * 1.9 - S.hungry * .6 + scrunch * 2.0 + S.happy * 1.15 + S.chew * .25;
    lid = clamp(lid, -.4, 1.6);
    const pup = 1 + S.hungry * .75 - scrunch * .3;
    for (const e of C.eyes) { e.lid.rotation.x = lid; e.look.rotation.set(-S.look.y * .6, S.look.x * .6 * 1, 0); e.pupil.scale.set(pup, pup, .6); e.iris.scale.setScalar(1 + S.hungry * .12); e.shine.scale.setScalar(1 + S.hungry * 1.1); e.look.position.y = S.hungry * Math.sin(t * 17) * .0012; e.g.scale.set(1 + S.hungry * .08 + scrunch * .05, 1 + S.hungry * .08 - scrunch * .3, 1 + S.hungry * .08 - scrunch * .1); }
    // --- mouth & cheeks
    const whineOpen = S.whinePose > 0 ? Math.sin(Math.PI * clamp(1 - S.whinePose, 0, 1)) * .6 : 0;
    const open = clamp(Math.max(mouthOpen, burpOpen * .8, whineOpen, relief * .6, S.chew * .5, S.hungry * .18) - scrunch * .5, 0, 1);
    S.open = damp(S.open, open, 28, dt);
    C.cavity.scale.set(1.15 - scrunch * .3 + S.open * .12, .3 + S.open * 1.5, .55 + S.open * .35);
    C.jaw.position.y = -S.open * .045; C.jaw.rotation.x = S.open * .35;
    const puffK = Math.max(burpPuff, scrunch * .8, S.chew * .5) + S.gurg * .1;
    for (const c of C.cheeks) c.scale.set(1 + puffK * .4, .82 + puffK * .35, .8 + puffK * .35);
    // --- body: breathing, squash on the shot, stretch toward the rear, gurgle ripples, chewing bob
    const gx = S.gurg > 0 ? Math.sin(t * 34) * .03 * S.gurg : 0;
    C.body.scale.set(1 + breathe * .6 - sq * .45 + gx + scrunch * .04, 1 + breathe - sq * .3 - gx, 1 + sq * 1.1 - scrunch * .05);
    C.head.rotation.set(-S.chew * .06 + S.hungry * -.1 + (eat && cy < .36 ? .05 : 0), Math.sin(t * .9) * .03, Math.sin(t * 1.3) * .02);
    C.head.position.y = .004 + S.chew * .004 + S.hungry * .008;
    C.core.scale.setScalar(1 + (f < .2 ? (1 - f / .2) * .8 : 0) + Math.sin(t * 4) * .06);
    // --- legs: pendulums driven by the gun's motion, a happy kick after eating, a big flail on each shot
    const gm = o.motion || 0;
    C.legs.forEach((L, i) => { const drive = gm * (i % 2 ? 1 : -1) * .6 + (f < .25 ? Math.sin(f * 40 + i) * (1 - f / .25) * 1.1 : 0) + Math.sin(t * 2.2 + L.ph) * .08 + S.happy * Math.sin(t * 14 + i * 1.7) * .35 + S.hungry * Math.sin(t * 6 + i) * .2;
      const a = -40 * (S.legA[i] - drive) - 6 * S.legV[i]; S.legV[i] += a * dt; S.legA[i] += S.legV[i] * dt;
      L.g.rotation.set(clamp(S.legA[i], -.9, .9) + .1, 0, (L.x > 0 ? -1 : 1) * (.15 + Math.abs(S.legA[i]) * .2)); });
    // --- the feeding arm (first person only)
    if (vm.arm) {
      const A = vm.arm, h = A.hand;
      if (cy >= 0) {
        const pouch = _p1.copy(vm.critter.jar.position).add(_q.set(-.05, .0, .015)), mouthAt = V(.01, Y0 - .06, .27);
        let p, rx = 0, ry = 0, rz = 0;
        if (cy < .24) { const k = ez01(cy / .24); p = A.rest.clone().lerp(pouch, k); rz = k * .6; }
        else if (cy < .32) { p = pouch.clone(); p.y += Math.sin((cy - .24) / .08 * Math.PI) * .02; rz = .6; }
        else if (cy < RC.bite) { const k = ez01((cy - .32) / (RC.bite - .32)); p = pouch.clone().lerp(mouthAt, k); p.y += Math.sin(k * Math.PI) * .05; rz = lerp(.6, -.15, k); rx = lerp(0, .3, k); ry = lerp(0, -.35, k); }
        else { const k = ez01((cy - RC.bite) / (1 - RC.bite) * 1.35); p = mouthAt.clone().lerp(A.rest, k); rz = lerp(-.15, 0, k); rx = lerp(.3, 0, k); ry = lerp(-.35, 0, k); }
        h.position.copy(p); h.rotation.set(rx, ry, rz);
        A.bean.visible = cy > .27 && cy < RC.bite + .02;
        if (A.bean.visible) { const into = seg(cy, RC.bite - .06, RC.bite + .02); A.bean.scale.setScalar(1.35 * (1 - into * .6)); A.bean.rotation.y = t * 3; }
      } else {
        // after an interrupted feed the hand slides back to the grip
        h.position.lerp(A.rest, 1 - Math.exp(-dt * 18)); _e1.set(damp(h.rotation.x, 0, 18, dt), damp(h.rotation.y, 0, 18, dt), damp(h.rotation.z, 0, 18, dt)); h.rotation.copy(_e1); A.bean.visible = false;
      }
    }
  }
  PG.anim = animCritter;

  /* ================= hooks into the game ================= */
  { const _bgv = buildGunVM; buildGunVM = function (id) { if (id === ID) return buildPoopVM(); return _bgv.apply(this, arguments); }; }
  { const _tp = rifleTP; rifleTP = function (kind) { if (kind === ID) return buildPoopTP(); return _tp.apply(this, arguments); }; }
  { const _fs = fireShot; fireShot = function () { if (P.weapon === ID && !PG.disabled) { try { return firePoop(); } catch (e) { warn(e); return; } } return _fs.apply(this, arguments); }; }
  { const _sr = startReload; startReload = function () { if (P.weapon === ID && !PG.disabled) return beginReload(); return _sr.apply(this, arguments); }; }
  { const _up = updatePlayer; updatePlayer = function (dt, rdt) { const r = _up.apply(this, arguments); try { if (!PG.disabled) tickReload(dt); } catch (e) { warn(e); } return r; }; }
  { const _uv = updateViewmodel; updateViewmodel = function (dt) {
      const r = _uv.apply(this, arguments);
      try { if (P.weapon === ID && WM[ID] && !PG.disabled) {
          const vm = WM[ID];
          // the game tilts every gun over a whole reload; our feeding is one bean at a time, so undo that and tilt per bean
          if (P.reload > 0 && P.reloadDur) { const t = 1 - P.reload / P.reloadDur, rl = Math.sin(Math.PI * clamp(t * 1.05, 0, 1)); gun.rotation.x -= rl * .35; gun.rotation.z -= rl * .55; gun.position.y += rl * .05; }
          gun.rotation.y -= (1 - P.ads) * .07; gun.rotation.x -= (1 - P.ads) * .05;   // at the hip it points straight ahead, so its vent sits low-right and the goo visibly crosses the screen
          let cy = R.active ? Math.max(0, R.cyc) : -1;
          if (PG.dbg.reloadPose != null) cy = PG.dbg.reloadPose;          // render/test only: hold a feeding pose
          if (PG.dbg.fireT != null) vm.critter.st.fireT = PG.dbg.fireT;   // render/test only: hold a firing pose
          if (cy >= 0 || R.lift > 0) {   // feeding: the critter is lifted and turned toward you so you see the bean go in
            const want = cy >= 0 ? ez01(cy / .25) * (1 - ez01((cy - .8) / .2) * (R.active && R.need > 1 ? 0 : 1)) : 0; R.lift = damp(R.lift || 0, want, 12, dt); const k = R.lift;
            const reach = cy >= 0 ? (cy < .4 ? ez01(cy / .14) : 1 - ez01((cy - .4) / .2)) : 0; gun.rotation.x -= k * .26; gun.rotation.z += k * .1 - reach * .38; gun.rotation.y += k * .12 + reach * .12; gun.position.y += k * .03; gun.position.x -= k * .03; gun.position.z += k * .03; }
          if (P.switchT > 0) vm.critter.st.lookTo.set(0, .2, 0);
          const mot = clamp((springs.swayX.x * 18) + springs.kickRot.x * .4 + Math.hypot(P.vel.x, P.vel.z) * Math.sin(P.bob * 2) * .05, -1.5, 1.5);
          animCritter(vm, dt, { reload: cy, ammo: P.ammo, live: true, motion: mot, ads: P.ads });
        } } catch (e) { warn(e); }
      return r; }; }
  { const _upj = updateProj; updateProj = function (dt) { const r = _upj.apply(this, arguments); try { updatePellets(dt); } catch (e) { warn(e); } try { updateSplats(); } catch (e) { warn(e); } return r; }; }
  { const _cd = clearDecals; clearDecals = function () { const r = _cd.apply(this, arguments); try { clearSplats(); } catch (e) {} return r; }; }
  // the killcam: their critter keeps blinking, and reacts to each shot in the replay
  { const _ar = applyReplay; let lastT = 0; applyReplay = function () {
      const r = _ar.apply(this, arguments);
      try { const vm = WM[ID]; if (r && vm && vm.group.visible) { const now = performance.now(), dt = clamp((now - (lastT || now)) / 1000, 0, .05); lastT = now; const fl = !!(vm.flash && vm.flash.visible); if (fl && !vm.critter.st.prevFlash) vm.critter.st.fireT = 0; vm.critter.st.prevFlash = fl;
          if (vm.arm) vm.arm.bean.visible = false; animCritter(vm, dt, { reload: -1, ammo: 3, live: false, motion: 0 }); PG.kcFrames = (PG.kcFrames || 0) + 1; } } catch (e) { warn(e); }
      return r; }; }
  // same for the killcam module (it does not call applyReplay): it hands us the viewmodel it is showing
  { let lastK = 0, hooked = null; const hook = (vm, kw) => { if (kw !== ID || !vm || vm !== WM[ID] || !vm.critter) return;
      const now = performance.now(), dt = clamp((now - (lastK || now)) / 1000, 0, .05); lastK = now; const fl = !!(vm.flash && vm.flash.visible);
      if (fl && !vm.critter.st.prevFlash) vm.critter.st.fireT = 0; vm.critter.st.prevFlash = fl;
      if (vm.arm) vm.arm.bean.visible = false; animCritter(vm, dt, { reload: -1, ammo: 3, live: false, motion: 0 }); PG.kcFrames = (PG.kcFrames || 0) + 1; };
    const reg = () => { const K = window.S9KC; if (K && !K.onVm) { K.onVm = hook; return true; } return !!(K && K.onVm === hook); };
    if (!reg()) { let n = 0; const iv = setInterval(() => { if (reg() || ++n > 120) clearInterval(iv); }, 500); } }
  // the victim's screen gets a quick splash of goo (edges only, gone in ~1.5 s), and a little shove
  let slimeEl = null, slimeT = 0, slimeRAF = 0;
  function slimeSvg() {
    const B = (cx, cy, r, d) => `<g transform="translate(${cx} ${cy})"><circle r="${r}" fill="url(#pgG)"/>${d ? `<rect x="${-r * .22}" y="0" width="${r * .44}" height="${r * d}" rx="${r * .22}" fill="url(#pgG)"/><circle cy="${r * d}" r="${r * .3}" fill="url(#pgG)"/>` : ''}<circle cx="${-r * .3}" cy="${-r * .35}" r="${r * .18}" fill="rgba(235,255,215,.55)"/></g>`;
    return `<svg viewBox="0 0 1000 600" preserveAspectRatio="none" width="100%" height="100%" aria-hidden="true"><defs><radialGradient id="pgG" cx=".45" cy=".4" r=".6"><stop offset="0" stop-color="#b6ff7a" stop-opacity=".95"/><stop offset=".6" stop-color="#4fbf22" stop-opacity=".88"/><stop offset="1" stop-color="#2a7a10" stop-opacity=".5"/></radialGradient></defs>
      ${B(40, 30, 95, 1.2)}${B(170, -10, 70, 1.6)}${B(-10, 210, 80, 0)}${B(960, 40, 110, 1.1)}${B(830, -20, 70, 1.9)}${B(1010, 260, 75, 0)}${B(70, 600, 90, 0)}${B(930, 610, 100, 0)}${B(300, 640, 60, 0)}${B(720, -15, 45, 2.3)}</svg>`;
  }
  function slime(power) {
    if (PG.disabled) return;
    if (!slimeEl) { slimeEl = document.createElement('div'); slimeEl.id = 'pgSlime'; slimeEl.setAttribute('aria-hidden', 'true');
      slimeEl.style.cssText = 'position:absolute;inset:0;pointer-events:none;opacity:0;transform-origin:50% 0;will-change:opacity,transform;z-index:3';
      slimeEl.innerHTML = slimeSvg(); const vig = document.getElementById('vig'); (vig && vig.parentNode ? vig.parentNode : document.body).insertBefore(slimeEl, vig ? vig.nextSibling : null); }
    slimeT = Math.max(slimeT, D.slime.duration * clamp(.55 + power * .1, .55, 1)); PG.stats.slimed++; PG.slimePeak = 0;
    if (!slimeRAF) { let last = performance.now(); const step = now => { const dt = Math.min(.1, (now - last) / 1000); last = now; if (state !== 'paused') slimeT = Math.max(0, slimeT - dt);
        const k = clamp(slimeT / (D.slime.duration * .6), 0, 1), op = (state === 'play' ? 1 : state === 'dead' ? .6 : 0) * D.slime.maxOpacity * ez(k);
        slimeEl.style.opacity = op.toFixed(3); slimeEl.style.transform = `translateY(${((1 - k) * 4).toFixed(2)}%) scaleY(${(1 + (1 - k) * .06).toFixed(3)})`; PG.slimePeak = Math.max(PG.slimePeak || 0, op);
        if (slimeT > 0) slimeRAF = requestAnimationFrame(step); else { slimeRAF = 0; slimeEl.style.opacity = '0'; } }; slimeRAF = requestAnimationFrame(step); }
  }
  PG.slime = slime; PG.slimeEl = () => slimeEl;
  { const _hp = hurtPlayer; hurtPlayer = function (dmg, from, attacker, crit, weapon) {
      const alive = state === 'play' && !P.dead && !window.__god && !(P.shield > 0), hp0 = P.hp;
      const r = _hp.apply(this, arguments);
      try { if (weapon === ID && alive && P.hp < hp0) { slime(dmg / 15); if (attacker && attacker.remote && from) { const d = V(P.pos.x - from.x, 0, P.pos.z - from.z).normalize(), k = Math.min(D.knockback.max, dmg / 15 * D.knockback.perPellet); P.vel.x += d.x * k; P.vel.z += d.z * k; } } } catch (e) { warn(e); }
      return r; }; }
  // kill badge says SLIMED for a goo kill
  // (victim.deathW is already cleared by startDeathFx when the badge shows, so the killing weapon is captured from playerKillFx, which calls the badge synchronously;
  //  every wrapper here chains to whatever was installed before, so it coexists with other weapon modules such as w_flytrap)
  { const _pk = playerKillFx; playerKillFx = function (r, crit, weapon) { const prev = PG.killW; PG.killW = weapon; try { return _pk.apply(this, arguments); } finally { PG.killW = prev; } }; }
  { const _kb = showKillBadge; showKillBadge = function (victim) { const r = _kb.apply(this, arguments); try { if (victim && (PG.killW === ID || (PG.killW === undefined && victim.deathW === ID))) { const b = document.querySelector('#killbadge .kb-text b'); if (b && !/HEADSHOT|WALLBANG/.test(b.textContent)) b.textContent = 'SLIMED'; } } catch (e) {} return r; }; }
  // arsenal card picture lives with the model files
  { const _ah = arsenalHTML; arsenalHTML = function () { return _ah.apply(this, arguments).replace(`assets/ui/w_${ID}.png`, D.ui.card); }; }

  /* ================= build now if the game already booted; warm the shaders ================= */
  function ensureVM() { if (typeof WM !== 'undefined' && Object.keys(WM).length && !WM[ID] && typeof T !== 'undefined' && T.glow) { WM[ID] = buildPoopVM(); } }
  function warm() {
    try {
      ensureVM();
      const prev = renderer.getRenderTarget(); renderer.setRenderTarget(rt);
      const g = new THREE.Group(); g.position.set(0, -200, 0); const a = pelletMesh(false), b = pelletMesh(true); g.add(a, b, buildPoopTP()); scene.add(g); splats();
      renderer.compile(scene, camera); scene.remove(g);
      if (WM[ID]) { const vm = WM[ID], keep = [vm.group, vm.arm.bean, vm.flash, vm.reticle, vm.rear, vm.bubble].filter(Boolean).map(o => [o, o.visible]);
        for (const [o] of keep) o.visible = true; renderer.compile(gunScene, gunCam); for (const [o, v] of keep) o.visible = v; }
      PG.warmCount = (PG.warmCount || 0) + 1;
      renderer.setRenderTarget(prev);
    } catch (e) { warn(e); try { renderer.setRenderTarget(null); } catch (x) {} }
  }
  PG.warm = warm;
  // a new map (fog, lights) or a new graphics tier builds different shader variants: compile ours again right then, not at the first shot
  const warmSoon = () => setTimeout(() => { if (typeof state !== 'undefined' && state !== 'loading') warm(); }, 0);
  { const _lm = loadMap; loadMap = async function () { const r = await _lm.apply(this, arguments); warmSoon(); return r; }; }
  { const _aq = applyQuality; applyQuality = function () { const r = _aq.apply(this, arguments); warmSoon(); return r; }; }
  function whenBooted() { if (window.__s9 && typeof state !== 'undefined' && state !== 'loading') { if (MATS) for (const k in MATS) { const m = MATS[k]; if (m.userData && m.userData.pgEnv !== undefined) m.envMapIntensity = m.userData.pgEnv; } ensureVM(); warm(); if (P.weapon === ID && WM[ID] && gun !== WM[ID].group && (state === 'play' || state === 'paused')) setModel(ID); PG.ready = true; return; } setTimeout(whenBooted, 250); }
  whenBooted();
})();
