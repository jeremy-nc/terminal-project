import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { wallBox, makeLed, paintLed, paintStandby, makeClaude, LED_SCROLL } from "../worldkit.js";

// The tropical-island theme: a sandy island ringed by turquoise ocean, palms, and
// cliffs, with thatched resort rooms (one per pipeline stage) around a central
// hub, two walk-in cavern-tree portals, and a little walking Claude mascot.

const ROOM = 8;          // room inner size
const WALL_H = 3.2;      // wall height
const WALL_T = 0.18;     // wall thickness
const DOOR_W = 2.4;      // door opening width
const DOOR_H = 2.4;      // door opening height
const D = 10;            // hub-to-room distance — wide enough that the diagonal corner
                         // lanes (√2·|D−8| ≈ 2.8) stay open to walk out to the island

// Room slots around the hub, growing per the mock: W, E, N, S, then stacked.
// door = which local wall holds the door (faces the hub). +X=E, -X=W, -Z=N, +Z=S.
const GAP = 2.5;             // breathing room between adjacent rooms
const STACK = ROOM + GAP;    // center-to-center for stacked rooms (so they don't touch)
const SLOTS = [
  { x: -D, z: 0, door: "E" },
  { x: D, z: 0, door: "W" },
  { x: 0, z: -D, door: "S" },
  { x: 0, z: D, door: "N" },
  { x: -D, z: -STACK, door: "E" },
  { x: D, z: -STACK, door: "W" },
  { x: -D, z: STACK, door: "E" },
  { x: D, z: STACK, door: "W" },
  { x: 0, z: -D - STACK, door: "S" },
  { x: 0, z: D + STACK, door: "N" },
];
function slotFor(i) {
  if (i < SLOTS.length) return SLOTS[i];
  // fallback ring for overflow
  const a = (i * Math.PI * 2) / 12;
  return { x: Math.round(Math.cos(a) * (D + STACK)), z: Math.round(Math.sin(a) * (D + STACK)), door: "S" };
}

// Procedural cloudy sky as an equirectangular background (no external asset):
// a blue gradient with soft white cloud blobs in the upper band.
function makeSkyTexture() {
  const w = 1024, h = 512;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "#1273cf");      // saturated zenith
  grad.addColorStop(0.5, "#3a9fe0");
  grad.addColorStop(0.8, "#9fd2ee");
  grad.addColorStop(1, "#cbe6f6");      // horizon (below bloom threshold)
  g.fillStyle = grad; g.fillRect(0, 0, w, h);
  // Soft, voluminous cumulus built from many feathered blobs: a cool shaded base,
  // a bright billowy body, and lighter sunlit top highlights — fluffy and 3D
  // rather than flat/graphic. Off-white so they read bright without blooming out.
  const blob = (x, y, r, rgb, a) => {
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, `rgba(${rgb},${a})`);
    rg.addColorStop(0.55, `rgba(${rgb},${a * 0.5})`);
    rg.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = rg; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  };
  const softCloud = (cx, cy, scale) => {
    for (let k = 0; k < 8; k++)                    // shaded underside
      blob(cx + (Math.random() - 0.5) * scale * 2.6, cy + scale * (0.3 + Math.random() * 0.25),
        scale * (0.5 + Math.random() * 0.5), "150,168,190", 0.16);
    for (let k = 0; k < 24; k++)                   // billowy body
      blob(cx + (Math.random() - 0.5) * scale * 2.8, cy - Math.random() * scale * 0.9,
        scale * (0.45 + Math.random() * 0.6), "230,236,244", 0.26);
    for (let k = 0; k < 9; k++)                    // sunlit top highlights
      blob(cx + (Math.random() - 0.5) * scale * 1.7, cy - scale * (0.4 + Math.random() * 0.6),
        scale * (0.3 + Math.random() * 0.4), "236,241,248", 0.3);
  };
  for (let i = 0; i < 7; i++) softCloud(Math.random() * w, h * (0.24 + Math.random() * 0.24), 30 + Math.random() * 26);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Procedural grass ground with scattered dirt patches, tiled across the floor.
function makeGroundTexture() {
  const s = 512;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d");
  g.fillStyle = "#3f5a32";          // grass base
  g.fillRect(0, 0, s, s);
  for (let i = 0; i < 6000; i++) {  // grass speckle
    const dark = Math.random() < 0.5;
    g.fillStyle = dark
      ? `rgba(30,50,22,${0.15 + Math.random() * 0.2})`
      : `rgba(92,122,60,${0.1 + Math.random() * 0.22})`;
    g.fillRect(Math.random() * s, Math.random() * s, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
  for (let i = 0; i < 9; i++) {     // dirt patches
    const x = Math.random() * s, y = Math.random() * s, r = 20 + Math.random() * 60;
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, "rgba(112,84,54,0.88)");
    rg.addColorStop(0.6, "rgba(96,72,46,0.5)");
    rg.addColorStop(1, "rgba(96,72,46,0)");
    g.fillStyle = rg;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    for (let j = 0; j < 45; j++) {  // dirt grit
      const a = Math.random() * Math.PI * 2, d = Math.random() * r;
      g.fillStyle = `rgba(70,50,32,${0.3 + Math.random() * 0.3})`;
      g.fillRect(x + Math.cos(a) * d, y + Math.sin(a) * d, 2, 2);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(40, 40);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Procedural wooden floorboards: planks with grain lines, seams, and occasional
// board-end joints. Mapped 1:1 to a room floor (~8 boards across).
function makeWoodTexture() {
  const s = 512;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d");
  const planks = 8, ph = s / planks;
  const tones = ["#6b4a2f", "#74522f", "#5f4128", "#7a5836", "#684626"];
  for (let i = 0; i < planks; i++) {
    g.fillStyle = tones[i % tones.length];
    g.fillRect(0, i * ph, s, ph);
    for (let j = 0; j < 12; j++) {                 // grain lines
      g.strokeStyle = `rgba(40,26,14,${0.06 + Math.random() * 0.1})`;
      g.lineWidth = 1;
      const y = i * ph + 4 + Math.random() * (ph - 8);
      g.beginPath(); g.moveTo(0, y);
      for (let x = 0; x <= s; x += 32) g.lineTo(x, y + Math.sin(x * 0.05 + i) * 1.4 + (Math.random() - 0.5) * 1.4);
      g.stroke();
    }
    g.fillStyle = "rgba(20,12,6,0.6)";             // seam between planks
    g.fillRect(0, i * ph, s, 2);
    if (Math.random() < 0.6) {                     // board-end joint
      g.fillStyle = "rgba(20,12,6,0.4)";
      g.fillRect(Math.random() * s, i * ph, 2, ph);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Turquoise sea: cyan base with lighter ripple streaks and white sparkle. Tiled
// and scrolled each frame for motion.
function makeWaterTexture() {
  const s = 256, c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d");
  g.fillStyle = "#26a9bf"; g.fillRect(0, 0, s, s);
  for (let i = 0; i < 420; i++) {
    g.fillStyle = `rgba(130,228,238,${0.05 + Math.random() * 0.12})`;
    g.fillRect(Math.random() * s, Math.random() * s, 10 + Math.random() * 40, 1 + Math.random() * 2);
  }
  for (let i = 0; i < 170; i++) {
    g.fillStyle = `rgba(255,255,255,${0.3 + Math.random() * 0.55})`;
    g.fillRect(Math.random() * s, Math.random() * s, 1.5, 1.5);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Radial alpha for the shallows: opaque near the shore, fading to clear so the
// pale turquoise blends into the deep ocean a little way out.
function makeShallowAlpha() {
  const s = 256, c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d");
  g.fillStyle = "#000"; g.fillRect(0, 0, s, s);
  const rg = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  rg.addColorStop(0, "#ffffff");
  rg.addColorStop(0.55, "#ffffff");
  rg.addColorStop(0.82, "rgba(255,255,255,0.45)");
  rg.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = rg; g.beginPath(); g.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2); g.fill();
  return new THREE.CanvasTexture(c);
}

// Golden beach sand: warm base with fine speckle and a few shells/pebbles.
function makeSandTexture() {
  const s = 256, c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d");
  g.fillStyle = "#e7d3a1"; g.fillRect(0, 0, s, s);
  for (let i = 0; i < 5000; i++) {
    g.fillStyle = Math.random() < 0.5
      ? `rgba(200,178,128,${0.2 + Math.random() * 0.3})`
      : `rgba(255,244,214,${0.15 + Math.random() * 0.3})`;
    g.fillRect(Math.random() * s, Math.random() * s, 1.5, 1.5);
  }
  for (let i = 0; i < 24; i++) {
    g.fillStyle = `rgba(160,140,110,${0.3 + Math.random() * 0.3})`;
    g.beginPath(); g.arc(Math.random() * s, Math.random() * s, 1 + Math.random() * 2, 0, Math.PI * 2); g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Thatched-straw roof: warm tan with vertical reed streaks.
function makeThatchTexture() {
  const s = 256, c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d");
  g.fillStyle = "#b3914e"; g.fillRect(0, 0, s, s);
  for (let i = 0; i < 260; i++) {
    const x = Math.random() * s, len = 30 + Math.random() * 90;
    g.strokeStyle = Math.random() < 0.5
      ? `rgba(90,66,32,${0.15 + Math.random() * 0.25})`
      : `rgba(214,182,120,${0.15 + Math.random() * 0.3})`;
    g.lineWidth = 1 + Math.random();
    g.beginPath(); g.moveTo(x, Math.random() * s); g.lineTo(x + (Math.random() - 0.5) * 6, Math.random() * s + len); g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 2);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Additive glary sun: a hot white core, warm halo, and bright cross-streaks for
// a 4-point lens-flare glare (blooms hard via the composer).
function makeSunSprite() {
  const s = 512, h = s / 2, c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d");
  const rg = g.createRadialGradient(h, h, 0, h, h, h);
  rg.addColorStop(0, "rgba(255,255,255,1)");
  rg.addColorStop(0.12, "rgba(255,252,235,0.98)");
  rg.addColorStop(0.32, "rgba(255,240,180,0.42)");
  rg.addColorStop(1, "rgba(255,240,180,0)");
  g.fillStyle = rg; g.fillRect(0, 0, s, s);
  // Bright glare streaks (horizontal + vertical), additively blended.
  g.globalCompositeOperation = "lighter";
  const streak = (horizontal) => {
    const lg = horizontal ? g.createLinearGradient(0, h, s, h) : g.createLinearGradient(h, 0, h, s);
    lg.addColorStop(0, "rgba(255,250,225,0)");
    lg.addColorStop(0.5, "rgba(255,250,225,0.85)");
    lg.addColorStop(1, "rgba(255,250,225,0)");
    g.fillStyle = lg;
    if (horizontal) g.fillRect(0, h - 3, s, 6); else g.fillRect(h - 3, 0, 6, s);
  };
  streak(true); streak(false);
  g.globalCompositeOperation = "source-over";
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(120, 120, 1);
  return sp;
}

// Low-poly palm: a tapered trunk and a crown of drooping frond planes (+coconuts).
// A slight lean is applied to the whole group for variety.
function makePalm() {
  const g = new THREE.Group();
  const H = 3.4;
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.3, H, 6),
    new THREE.MeshStandardMaterial({ color: 0x9c7a4d, roughness: 0.9 }),
  );
  trunk.position.y = H / 2;
  g.add(trunk);
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x2f9e4f, roughness: 0.7, side: THREE.DoubleSide });
  const frondGeo = new THREE.PlaneGeometry(2.4, 0.7);
  frondGeo.translate(1.2, 0, 0);          // extend from the crown centre outward
  const crown = new THREE.Group();
  crown.position.y = H;
  const N = 7;
  for (let i = 0; i < N; i++) {
    const leaf = new THREE.Mesh(frondGeo, leafMat);
    leaf.rotation.y = (i / N) * Math.PI * 2;
    leaf.rotation.z = -0.35;              // droop
    crown.add(leaf);
  }
  const cocoMat = new THREE.MeshStandardMaterial({ color: 0x5b3b22, roughness: 0.8 });
  for (let i = 0; i < 3; i++) {
    const coco = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), cocoMat);
    const a = i * 2.1;
    coco.position.set(Math.cos(a) * 0.25, -0.12, Math.sin(a) * 0.25);
    crown.add(coco);
  }
  g.add(crown);
  g.rotation.z = (Math.random() - 0.5) * 0.12;
  g.scale.setScalar(0.8 + Math.random() * 0.5);
  return g;
}

// Low-poly rocky cliff/islet with a grassy top — faceted (flatShading) rock and
// a thin grass cap, like the 2000s tropical-game outcrops.
function makeCliff(height, radius) {
  const g = new THREE.Group();
  const rock = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.78, radius * 1.15, height, 7, 1),
    new THREE.MeshStandardMaterial({ color: 0x8a7c63, roughness: 1, flatShading: true }),
  );
  rock.position.y = height / 2;
  rock.scale.set(1, 1, 0.8 + Math.random() * 0.35);
  rock.rotation.y = Math.random() * Math.PI;
  g.add(rock);
  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.74, radius * 0.82, height * 0.16, 7, 1),
    new THREE.MeshStandardMaterial({ color: 0x4f8a3a, roughness: 0.9, flatShading: true }),
  );
  cap.position.y = height + height * 0.05;
  cap.scale.copy(rock.scale);
  cap.rotation.y = rock.rotation.y;
  g.add(cap);
  return g;
}

// A cavernous version of the island palms: a broad SINGLE trunk that's hollow,
// with an arched doorway cut out (facing `entranceAngle`) and a dark interior you
// can walk into — topped with the same drooping frond crown as makePalm().
// Returns { group, walls } — walls are LOCAL XZ AABBs the caller offsets to world.
function makeCavernTree(entranceAngle) {
  const g = new THREE.Group();
  const walls = [];
  const H = 5.2, rB = 1.5, rT = 1.2, DOOR = 1.05;   // trunk height, radii, doorway angle
  const bark = new THREE.MeshStandardMaterial({ color: 0x9c7a4d, roughness: 0.9, side: THREE.DoubleSide });
  const dark = new THREE.MeshStandardMaterial({ color: 0x130d08, roughness: 1, side: THREE.DoubleSide });

  // Hollow trunk = a gapped (partial) cylinder; the gap, centred on entranceAngle,
  // is the doorway. A dark inner shell makes the inside read dark.
  const start = entranceAngle + DOOR / 2, span = Math.PI * 2 - DOOR;
  const outer = new THREE.Mesh(new THREE.CylinderGeometry(rT, rB, H, 28, 1, true, start, span), bark);
  outer.position.y = H / 2; g.add(outer);
  const inner = new THREE.Mesh(new THREE.CylinderGeometry(rT - 0.12, rB - 0.12, H - 0.04, 28, 1, true, start, span), dark);
  inner.position.y = H / 2; g.add(inner);

  // Arch header: a short cylinder slice filling the TOP of the doorway, so the
  // opening only reaches partway up → an arch rather than a full-height slot.
  const archH = H * 0.6, rA = rB + (rT - rB) * 0.6;
  const header = new THREE.Mesh(
    new THREE.CylinderGeometry(rA - 0.04, rA, H - archH, 12, 1, true, entranceAngle - DOOR / 2, DOOR), bark);
  header.position.y = (archH + H) / 2; g.add(header);

  // Cap the top + a dark ceiling so it's enclosed and dark inside.
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(rT + 0.06, rT + 0.06, 0.4, 28), bark);
  cap.position.y = H; g.add(cap);
  const ceil = new THREE.Mesh(new THREE.CircleGeometry(rT - 0.1, 28), dark);
  ceil.rotation.x = Math.PI / 2; ceil.position.y = H - 0.06; g.add(ceil);

  // Frond crown on top (matches the island palms, scaled up).
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x2f9e4f, roughness: 0.7, side: THREE.DoubleSide });
  const frondGeo = new THREE.PlaneGeometry(4.6, 1.3); frondGeo.translate(2.3, 0, 0);
  const crown = new THREE.Group(); crown.position.y = H + 0.3;
  const NF = 9;
  for (let i = 0; i < NF; i++) {
    const leaf = new THREE.Mesh(frondGeo, leafMat);
    leaf.rotation.y = (i / NF) * Math.PI * 2; leaf.rotation.z = -0.32;
    crown.add(leaf);
  }
  g.add(crown);

  // Collision: a ring of small boxes around the trunk, skipping the doorway arc.
  const Rc = (rB + rT) / 2, Nc = 18;
  for (let i = 0; i < Nc; i++) {
    const th = (i / Nc) * Math.PI * 2;
    const d = Math.atan2(Math.sin(th - entranceAngle), Math.cos(th - entranceAngle));
    if (Math.abs(d) < DOOR / 2 + 0.12) continue;   // leave the doorway walkable
    const x = Math.cos(th) * Rc, z = Math.sin(th) * Rc, e = 0.36;
    walls.push({ minX: x - e, maxX: x + e, minZ: z - e, maxZ: z + e });
  }
  return { group: g, walls };
}

function buildRoom(stage, slot, mat, roofMat, floorMat, tabId) {
  const g = new THREE.Group();
  g.position.set(slot.x, 0, slot.z);
  const half = ROOM / 2;
  // Pitched (gable) roof: a triangular prism with a ridge and overhanging eaves.
  // Above the player → no collision; no shadow maps → it doesn't dim the inside.
  const oh = 0.4, bh = half + oh, peak = 2.6;
  const shape = new THREE.Shape();
  shape.moveTo(-bh, 0); shape.lineTo(bh, 0); shape.lineTo(0, peak); shape.lineTo(-bh, 0);
  const roofGeo = new THREE.ExtrudeGeometry(shape, { depth: ROOM + 2 * oh, bevelEnabled: false });
  roofGeo.translate(0, 0, -(ROOM / 2 + oh));
  const roof = new THREE.Mesh(roofGeo, roofMat);
  roof.position.set(0, WALL_H, 0);
  g.add(roof);
  // Wooden floor, just above the grass (avoids z-fighting), filling the room.
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM, ROOM), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0.1, 0);   // above the sand island
  g.add(floor);
  const walls = [];   // world-space AABBs (XZ) for collision
  const addWall = (w, d, x, z) => {
    g.add(wallBox(w, d, x, z, mat));
    walls.push({
      minX: slot.x + x - w / 2, maxX: slot.x + x + w / 2,
      minZ: slot.z + z - d / 2, maxZ: slot.z + z + d / 2,
    });
  };
  const sides = { N: true, S: true, E: true, W: true };
  delete sides[slot.door];
  if (sides.N) addWall(ROOM, WALL_T, 0, -half);
  if (sides.S) addWall(ROOM, WALL_T, 0, half);
  if (sides.W) addWall(WALL_T, ROOM, -half, 0);
  if (sides.E) addWall(WALL_T, ROOM, half, 0);
  // door wall = two segments leaving a centred gap (walkable), + LED above
  const seg = (ROOM - DOOR_W) / 2;
  const off = DOOR_W / 2 + seg / 2;
  const led = makeLed(stage.label, stage.status);
  if (slot.door === "N" || slot.door === "S") {
    const z = slot.door === "N" ? -half : half;
    addWall(seg, WALL_T, -off, z);
    addWall(seg, WALL_T, off, z);
    led.mesh.position.set(0, DOOR_H + 0.45, z + (slot.door === "N" ? -0.02 : 0.02));
    led.mesh.rotation.y = slot.door === "N" ? Math.PI : 0;
  } else {
    const x = slot.door === "W" ? -half : half;
    addWall(WALL_T, seg, x, -off);
    addWall(WALL_T, seg, x, off);
    led.mesh.position.set(x + (slot.door === "W" ? -0.02 : 0.02), DOOR_H + 0.45, 0);
    led.mesh.rotation.y = slot.door === "W" ? -Math.PI / 2 : Math.PI / 2;
  }
  g.add(led.mesh);

  // A "flatscreen TV" on the FAR wall (opposite the door), mirroring this stage's
  // live terminal. Built for every stage but only revealed when a terminal exists
  // at this tab id — so container stages (no top-level terminal) never show one.
  let screen = null;
  if (tabId) {
    const FAR = { E: "W", W: "E", N: "S", S: "N" }[slot.door];
    const sc = document.createElement("canvas");
    sc.width = 768; sc.height = 384;
    const tex = new THREE.CanvasTexture(sc);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(3.7, 1.85), new THREE.MeshBasicMaterial({ map: tex }));
    mesh.userData.screenTabId = tabId;
    const bezel = new THREE.Mesh(
      new THREE.BoxGeometry(4.0, 2.15, 0.12),
      new THREE.MeshStandardMaterial({ color: 0x0b0b10, roughness: 0.5 }),
    );
    const Y = 1.6;
    const place = (m, inset) => {
      if (FAR === "N") { m.position.set(0, Y, -half + inset); m.rotation.y = 0; }
      else if (FAR === "S") { m.position.set(0, Y, half - inset); m.rotation.y = Math.PI; }
      else if (FAR === "W") { m.position.set(-half + inset, Y, 0); m.rotation.y = Math.PI / 2; }
      else { m.position.set(half - inset, Y, 0); m.rotation.y = -Math.PI / 2; }
    };
    place(bezel, 0.09); place(mesh, 0.16);
    g.add(bezel); g.add(mesh);
    screen = { tabId, label: stage.label, canvas: sc, ctx: sc.getContext("2d"), tex, mesh, bezel, _standby: true };
    paintStandby(screen);   // visible immediately; live output replaces it on start
  }

  return { group: g, led, walls, screen };
}

const tropical = {
  id: "tropical",
  label: "Tropical Island",
  fog: { color: 0xcfe9f5, near: 70, far: 280 },   // bright cyan haze to the horizon

  background() { return makeSkyTexture(); },

  buildWorld(scene, renderer, camera) {
    // Bright tropical lighting: cool sky fill + warm sun key from the sun sprite.
    scene.add(new THREE.HemisphereLight(0xcdeeff, 0x7a6a48, 1.05));
    const dir = new THREE.DirectionalLight(0xfff3da, 1.25);
    dir.position.set(60, 70, -120);
    scene.add(dir);
    const sun = makeSunSprite();
    sun.position.set(60, 64, -150);
    scene.add(sun);

    // Turquoise ocean to the horizon + a sandy island the rooms sit on.
    const water = makeWaterTexture();
    water.wrapS = water.wrapT = THREE.RepeatWrapping;
    water.repeat.set(60, 60);
    const ocean = new THREE.Mesh(
      new THREE.PlaneGeometry(1000, 1000),
      new THREE.MeshStandardMaterial({ map: water, color: 0x1c84bf, roughness: 0.22, metalness: 0.5 }),
    );
    ocean.rotation.x = -Math.PI / 2;
    scene.add(ocean);

    // Pale turquoise shallows hugging the shore, fading into the deep blue.
    const shallows = new THREE.Mesh(
      new THREE.CircleGeometry(56, 64),
      new THREE.MeshStandardMaterial({
        map: water, alphaMap: makeShallowAlpha(), transparent: true, depthWrite: false,
        color: 0x6fe6df, roughness: 0.3, metalness: 0.25,
      }),
    );
    shallows.rotation.x = -Math.PI / 2;
    shallows.position.y = 0.02;
    scene.add(shallows);

    const sand = makeSandTexture();
    sand.wrapS = sand.wrapT = THREE.RepeatWrapping;
    sand.repeat.set(9, 9);
    const island = new THREE.Mesh(
      new THREE.CircleGeometry(30, 64),
      new THREE.MeshStandardMaterial({ map: sand, roughness: 1 }),
    );
    island.rotation.x = -Math.PI / 2;
    island.position.y = 0.04;
    scene.add(island);

    // Grassy interior (leaves a sandy beach ring at the island's edge).
    const grassTex = makeGroundTexture();
    grassTex.repeat.set(6, 6);
    const grass = new THREE.Mesh(
      new THREE.CircleGeometry(23, 48),
      new THREE.MeshStandardMaterial({ map: grassTex, roughness: 1 }),
    );
    grass.rotation.x = -Math.PI / 2;
    grass.position.y = 0.05;
    scene.add(grass);

    // Low-poly palms ringing the island.
    const palms = new THREE.Group();
    const ringPalms = (radius, count, phase) => {
      for (let i = 0; i < count; i++) {
        const a = phase + (i / count) * Math.PI * 2;
        const p = makePalm();
        p.position.set(Math.cos(a) * radius, 0.05, Math.sin(a) * radius);
        p.rotation.y = Math.random() * Math.PI * 2;
        palms.add(p);
      }
    };
    ringPalms(23, 9, 0.35);
    ringPalms(29, 8, 0);
    scene.add(palms);

    // Rocky grass-topped cliffs/islets rising out of the water (scenic backdrop),
    // some crowned with a palm. [distance, angle, height, radius, palm].
    const cliffs = new THREE.Group();
    [[46, 0.4, 11, 4.5, true], [52, 1.7, 8, 3.5, false], [60, 2.7, 15, 6, true],
     [44, 3.9, 9, 4, false], [66, 4.7, 12, 5, true], [50, 5.8, 10, 4, false]]
      .forEach(([dist, ang, hgt, rad, palm]) => {
        const cf = makeCliff(hgt, rad);
        cf.position.set(Math.cos(ang) * dist, 0, Math.sin(ang) * dist);
        if (palm) { const p = makePalm(); p.position.y = hgt * 1.08; p.scale.multiplyScalar(1.2); cf.add(p); }
        cliffs.add(cf);
      });
    scene.add(cliffs);

    // A little 3D Claude that walks the island's shoreline (animated in the loop).
    const claude = makeClaude();
    claude.angle = 0; claude.phase = 0;
    scene.add(claude.group);

    // Two cavernous trees at polar-opposite points on the grass — walk inside them.
    // On the diagonals (rooms sit on the axes) so they don't clash. Their colliders
    // live in treeWalls (separate from per-stage room walls so they survive rebuilds).
    // Each tree is a portal: the +π/4 one advances to the NEXT running workspace,
    // the −π/4 one goes to the PREVIOUS. The door faces the island centre; the
    // spawn pose is just OUTSIDE the door (centre side) so arriving doesn't instantly
    // re-trigger, facing the hub.
    const treeWalls = [], trees = [];
    [["next", Math.PI / 4], ["prev", Math.PI / 4 + Math.PI]].forEach(([role, ang]) => {
      const tr = 17, tx = Math.cos(ang) * tr, tz = Math.sin(ang) * tr;
      const eA = Math.atan2(-tz, -tx);                       // doorway direction (toward centre)
      const { group, walls } = makeCavernTree(eA);
      group.position.set(tx, 0.05, tz);
      scene.add(group);
      for (const wl of walls) treeWalls.push({
        minX: tx + wl.minX, maxX: tx + wl.maxX, minZ: tz + wl.minZ, maxZ: tz + wl.maxZ,
      });
      const sx = tx + Math.cos(eA) * 2.6, sz = tz + Math.sin(eA) * 2.6;   // emerge point
      trees.push({ role, x: tx, z: tz, sx, sz, syaw: Math.atan2(sx, sz) });
    });

    // Warm resort buildings: cream walls, thatched roofs, wooden floors.
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xefe6d2, roughness: 0.9, metalness: 0.0 });
    const roofMat = new THREE.MeshStandardMaterial({ map: makeThatchTexture(), color: 0xb78f4c, roughness: 1 });
    const floorMat = new THREE.MeshStandardMaterial({ map: makeWoodTexture(), roughness: 0.8 });
    const roomsGroup = new THREE.Group();
    scene.add(roomsGroup);

    // Bloom post-process for the glossy 2000s glow (sun, sparkle, LED signs).
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.7, 0.6, 0.95));

    return { roomsGroup, mats: { wallMat, roofMat, floorMat }, water, claude, treeWalls, trees, composer };
  },

  layout(count) { return Array.from({ length: count }, (_, i) => slotFor(i)); },

  buildStage(stage, slot, mats, tabId) {
    return buildRoom(stage, slot, mats.wallMat, mats.roofMat, mats.floorMat, tabId);
  },

  paintStatus(led, status) { paintLed(led, status); },

  animate(S, dt) {
    if (S.water) {                 // drift the sea
      S.water.offset.x += dt * 0.03;
      S.water.offset.y += dt * 0.02;
    }
    const cl = S.claude;           // walk Claude around the shoreline
    if (cl) {
      cl.angle += dt * 0.13;               // angular speed around the island
      cl.phase += dt * 7;                  // leg step frequency
      const R = 26, a = cl.angle;
      cl.group.position.set(Math.cos(a) * R, Math.abs(Math.sin(cl.phase)) * 0.07, Math.sin(a) * R);
      cl.group.rotation.y = Math.atan2(-Math.sin(a), Math.cos(a));   // face direction of travel
      const sw = Math.sin(cl.phase) * 0.5;                           // diagonal leg gait
      cl.legs[0].rotation.x = sw; cl.legs[3].rotation.x = sw;
      cl.legs[1].rotation.x = -sw; cl.legs[2].rotation.x = -sw;
    }
    // Advance marquee labels (only those that overflow).
    const rooms = S.rooms;
    if (rooms) rooms.forEach((led) => {
      if (led._needsScroll) { led.scroll += dt * LED_SCROLL; paintLed(led, led.status); }
    });
  },
};

export default tropical;
