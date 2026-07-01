import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { wallBox, styleFor, paintStandby, makeClaude } from "../worldkit.js";

// The retro-cubicle-office theme: a fluorescent-lit open-plan floor of cross-shaped
// (+) partition clusters, each holding up to four cubicle desks with deep beige CRT
// monitors mirroring the live terminals. Partitions are fabric-covered with cream
// plastic top caps and posts; desks are L-shaped and cluttered with binders, phones
// and sticky notes — modelled on real late-90s cube farms to avoid a flat look.
// Status shows on a desk nameplate placard (the office reskin of the LED sign). Two
// water coolers are the walk-up portals to the prev/next running workspace.

const ROOM_HALF = 14;    // half the floor's side → 28×28 room
const CEIL_H = 3.2;      // ceiling height (matches wallBox's WALL_H)
const PART_H = 1.42;     // cubicle partition height — below eye level so you see over
const PART_T = 0.13;     // partition thickness
const ARM = 3.0;         // half-length of each partition arm (cross reaches ±ARM)
const CS = 11;           // centre-to-centre spacing between clusters
const COOLER_X = 12;     // water coolers sit against the left/right walls

// Cluster centres for `n` crosses, per the mock: 1 cross sits in front of the
// spawn (origin stays an open aisle); 2 stack along Z; 3–4 fill a 2×2 grid. The
// grid is centred so the origin always lands on an aisle, never inside a cross.
function clusterCenters(n) {
  if (n <= 1) return [[0, -5.5]];
  const cols = n <= 2 ? 1 : 2;
  const rows = Math.ceil(n / cols);
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols), c = i % cols;
    out.push([(c - (cols - 1) / 2) * CS, (r - (rows - 1) / 2) * CS]);
  }
  return out;
}

// Each stage is one desk. Desks fill clusters four-at-a-time (one per quadrant),
// so a cluster's first desk (quadrant 0) is its "anchor" and builds the shared
// cross partitions. Quadrants are 90° rotations of a canonical NE workstation.
function layout(count) {
  const centers = clusterCenters(Math.max(1, Math.ceil(count / 4)));
  const slots = Array.from({ length: count }, (_, i) => {
    const c = Math.floor(i / 4), q = i % 4;
    return { cx: centers[c][0], cz: centers[c][1], q, anchor: q === 0 };
  });
  // Guarantee a Nurture Cloud poster in every cluster of 4: pick one of the cluster's
  // desks (deterministically "random" per cluster) to carry it.
  const byCluster = {};
  slots.forEach((s, i) => { const c = Math.floor(i / 4); (byCluster[c] = byCluster[c] || []).push(i); });
  for (const c in byCluster) {
    const idxs = byCluster[c];
    slots[idxs[Math.floor(hash("ncpick:" + c)() * idxs.length)]].nc = true;
  }
  return slots;
}

// Tiny deterministic hash so each desk's clutter (binder colours, phone, etc.)
// stays stable across rebuilds but varies between desks.
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h = Math.imul(h ^ (h >>> 15), 2246822507); return ((h >>> 0) % 1000) / 1000; };
}

// ── procedural textures ──────────────────────────────────────────────────────

// Office carpet: muted blue-grey loop pile — dense two-tone fleck over a mottled
// base, with a faint carpet-tile seam grid.
function makeCarpetTexture() {
  const s = 512, c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d");
  g.fillStyle = "#3c424b"; g.fillRect(0, 0, s, s);
  for (let i = 0; i < 22; i++) {                    // soft mottle
    const x = Math.random() * s, y = Math.random() * s, r = 40 + Math.random() * 80;
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, `rgba(${Math.random() < 0.5 ? "26,30,36" : "82,90,102"},0.18)`);
    rg.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = rg; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  for (let i = 0; i < 16000; i++) {                 // loop-pile fleck
    g.fillStyle = Math.random() < 0.5
      ? `rgba(26,30,36,${0.12 + Math.random() * 0.22})`
      : `rgba(92,102,116,${0.08 + Math.random() * 0.18})`;
    g.fillRect(Math.random() * s, Math.random() * s, 1, 1 + Math.random());
  }
  g.strokeStyle = "rgba(18,20,24,0.5)"; g.lineWidth = 2;
  g.strokeRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(16, 16);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Suspended ceiling: a grid of off-white acoustic tiles with pin-hole speckle and
// a seam border.
function makeCeilingTexture() {
  const s = 256, c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d");
  g.fillStyle = "#dfe0db"; g.fillRect(0, 0, s, s);
  for (let i = 0; i < 4000; i++) {                  // acoustic-tile pinholes
    g.fillStyle = `rgba(140,140,130,${0.06 + Math.random() * 0.12})`;
    g.beginPath(); g.arc(Math.random() * s, Math.random() * s, 0.7, 0, Math.PI * 2); g.fill();
  }
  g.strokeStyle = "rgba(120,120,112,0.8)"; g.lineWidth = 4;
  g.strokeRect(2, 2, s - 4, s - 4);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(10, 10);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Woven partition fabric: a flecked base with a fine basket-weave dot grid so the
// big panels read as upholstered cloth, not flat colour.
function makeFabricTexture(base) {
  const s = 128, c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d");
  g.fillStyle = base; g.fillRect(0, 0, s, s);
  for (let y = 0; y < s; y += 3) for (let x = 0; x < s; x += 3) {
    const on = (((x / 3) + (y / 3)) % 2) === 0;     // alternating warp/weft cells
    g.fillStyle = on ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.07)";
    g.fillRect(x, y, 2, 2);
  }
  for (let i = 0; i < 1800; i++) {                  // slubs / fleck
    g.fillStyle = Math.random() < 0.5 ? "rgba(0,0,0,0.06)" : "rgba(255,255,255,0.05)";
    g.fillRect(Math.random() * s, Math.random() * s, 1, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(10, 3);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Grey laminate desk surface: faint lengthwise grain + sparse darker specks and a
// soft sheen band.
function makeLaminateTexture() {
  const s = 256, c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d");
  g.fillStyle = "#c7c1b0"; g.fillRect(0, 0, s, s);
  for (let y = 0; y < s; y += 2) {                  // subtle horizontal grain
    g.strokeStyle = `rgba(150,142,124,${0.05 + Math.random() * 0.06})`;
    g.lineWidth = 1; g.beginPath(); g.moveTo(0, y); g.lineTo(s, y + (Math.random() - 0.5) * 2); g.stroke();
  }
  for (let i = 0; i < 500; i++) {
    g.fillStyle = `rgba(110,104,90,${0.1 + Math.random() * 0.2})`;
    g.fillRect(Math.random() * s, Math.random() * s, 1.5, 1.5);
  }
  const lg = g.createLinearGradient(0, 0, s, s);    // sheen
  lg.addColorStop(0, "rgba(255,255,255,0.08)");
  lg.addColorStop(0.5, "rgba(255,255,255,0)");
  g.fillStyle = lg; g.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Night sky gradient for the scene background (near-black → faint blue at the horizon).
function makeSkyGradient() {
  const w = 16, h = 256, c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "#05080f"); grad.addColorStop(0.55, "#0c1424"); grad.addColorStop(1, "#1c2942");
  g.fillStyle = grad; g.fillRect(0, 0, w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// A UNIQUE tower façade sized to its own window grid (cols×rows): a dark curtain wall
// with only a sparse scatter of lit windows. Generated per building and mapped ONCE
// (no tiling) so towers don't share an obviously-repeating pattern.
function makeFacadeTexture(cols, rows) {
  const cell = 14, pad = 4, w = cols * cell, h = rows * cell;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  g.fillStyle = "#0f141b"; g.fillRect(0, 0, w, h);
  for (let r = 0; r < rows; r++) for (let cc = 0; cc < cols; cc++) {
    g.fillStyle = Math.random() < 0.15                // sparse: only ~1 in 7 windows lit
      ? `rgb(255,${224 + Math.random() * 28 | 0},${152 + Math.random() * 40 | 0})`
      : "#171c24";
    g.fillRect(cc * cell + pad / 2, r * cell + pad / 2, cell - pad, cell - pad);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// A 3D cityscape of box towers beyond the window wall (−Z): varied sizes, lit-window
// façades, fading into the dusk haze with distance (fog).
function makeCityscape() {
  const g = new THREE.Group();
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x12161d, roughness: 0.95 });
  for (let i = 0; i < 34; i++) {
    const w = 7 + Math.random() * 12, d = 7 + Math.random() * 12;
    // The office is high up: neighbouring towers RISE FROM FAR BELOW (bases out of view)
    // with rooflines scattered around / above eye level — so you look across + up at them.
    const top = 2 + Math.random() * 60;
    const baseY = -82 - Math.random() * 16;
    const h = top - baseY;
    const tex = makeFacadeTexture(Math.max(2, Math.round(w / 3)), Math.max(3, Math.round(h / 3)));
    // Lit windows EMIT brightly enough to cross the bloom threshold (so they GLOW), while
    // staying sparse; the dark façade fades into the night fog.
    const facadeMat = new THREE.MeshStandardMaterial({
      map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 1.2, roughness: 0.9,
    });
    // BoxGeometry face order: +X, −X, +Y, −Y, +Z, −Z → façade on the 4 sides, roof on top/bottom.
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d),
      [facadeMat, facadeMat, roofMat, roofMat, facadeMat, facadeMat]);
    const x = (Math.random() - 0.5) * 170;
    const z = -ROOM_HALF - 14 - Math.random() * 100;
    b.position.set(x, baseY + h / 2, z);
    b.rotation.y = (Math.random() - 0.5) * 0.5;
    g.add(b);
  }
  return g;
}

// ── status display: a pinned "report" poster on the cubicle wall ──────────────

// A printed report/infographic poster pinned to the cubicle partition: a titled
// header (the stage label) over procedurally-drawn charts. The accent + footer chip
// track the node status (repainted by paintPoster). Returns { ..., group } where
// group holds a cork backing board, the printed plane, and pushpins.
function makePoster(label, type) {
  const canvas = document.createElement("canvas");
  canvas.width = 380; canvas.height = 500;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const group = new THREE.Group();
  const board = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.81),
    new THREE.MeshStandardMaterial({ color: 0xd8cdb2, roughness: 0.97 }));
  group.add(board);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.74),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92 }));   // LIT paper, so it doesn't glow/bloom
  mesh.position.z = 0.006; group.add(mesh);
  for (const [px, py] of [[-0.25, 0.355], [0.25, 0.355], [-0.25, -0.355], [0.25, -0.355]]) {
    const pin = new THREE.Mesh(new THREE.SphereGeometry(0.013, 8, 6),
      new THREE.MeshStandardMaterial({ color: 0xcc3b3b, roughness: 0.4 }));
    pin.position.set(px, py, 0.014); group.add(pin);
  }
  const poster = { canvas, ctx: canvas.getContext("2d"), tex, group, label, type };
  paintPoster(poster, "pending");
  return poster;
}

// The Nurture Cloud brand poster — a procedural cloud logo (blue body with a
// white-grey-white swoosh converging to a sharp right point) over the NURTURE CLOUD
// wordmark. Status-independent. (Shape validated by offscreen render vs. the brand.)
function paintLogoPoster(p) {
  const { ctx, canvas } = p;
  const W = canvas.width, H = canvas.height;
  const blue = "#4ba3dd", grey = "#9aa3ab", white = "#ffffff";
  ctx.fillStyle = "#eef1f4"; ctx.fillRect(0, 0, W, H);
  const cx = W / 2, cy = 185;

  // Cloud silhouette: three prominent round puffs along the top (centre tallest), a
  // FLAT bottom, and the left/right puffs curving up from it.
  const circ = [[cx - 76, cy, 50], [cx, cy - 32, 60], [cx + 76, cy, 50]];
  ctx.save();
  ctx.beginPath();
  for (const [x, y, r] of circ) { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, Math.PI * 2); }
  ctx.rect(cx - 76, cy - 20, 152, 70);                 // flat-bottomed body between the side puffs
  ctx.clip();                                          // confine everything to the cloud
  ctx.fillStyle = blue; ctx.fillRect(cx - 170, cy - 130, 340, 260);

  // Swoosh: TWO grey stripes (with a white highlight above and a white gap between)
  // sweeping up from the left puff's bottom and CONVERGING to a sharp point at the
  // cloud's right edge. Filled bands so they taper to the point.
  const CP = [cx + 120, cy - 4];
  const ribbon = (y0, y1, dip, col) => {
    ctx.fillStyle = col; ctx.beginPath();
    ctx.moveTo(-20, y0);
    ctx.quadraticCurveTo(CP[0] - 150, (y0 + CP[1]) / 2 - dip, CP[0], CP[1]);
    ctx.quadraticCurveTo(CP[0] - 150, (y1 + CP[1]) / 2 - dip, -20, y1);
    ctx.closePath(); ctx.fill();
  };
  ribbon(cy - 10, cy + 6, 22, white);                // white highlight on top
  ribbon(cy + 10, cy + 24, 18, grey);                // grey stripe 1
  ribbon(cy + 26, cy + 32, 16, white);               // white gap
  ribbon(cy + 34, cy + 48, 12, grey);                // grey stripe 2
  ctx.restore();

  // Wordmark: NURTURE (blue) + CLOUD (grey).
  ctx.textBaseline = "middle"; ctx.textAlign = "left";
  ctx.font = "800 46px ui-sans-serif, system-ui, sans-serif";
  const t1 = "NURTURE", t2 = "CLOUD", gap = 16;
  const w1 = ctx.measureText(t1).width, w2 = ctx.measureText(t2).width;
  const x0 = cx - (w1 + gap + w2) / 2;
  ctx.fillStyle = blue; ctx.fillText(t1, x0, cy + 170);
  ctx.fillStyle = grey; ctx.fillText(t2, x0 + w1 + gap, cy + 170);
  p.tex.needsUpdate = true;
}
function paintPoster(p, status) {
  p.status = status;
  if (p.type === "logo") { paintLogoPoster(p); return; }
  const { ctx, canvas, label } = p;
  const W = canvas.width, H = canvas.height;
  const { bg, fg } = styleFor(status);
  const rng = hash("poster:" + (label || ""));
  ctx.fillStyle = "#e7e1d2"; ctx.fillRect(0, 0, W, H);                  // off-white paper (won't blow out)
  ctx.fillStyle = "#2f3b4c"; ctx.fillRect(0, 0, W, 70);                 // header band
  ctx.fillStyle = bg; ctx.fillRect(0, 66, W, 6);
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffffff"; ctx.font = "700 30px ui-sans-serif, system-ui, sans-serif";
  ctx.fillText((label || "REPORT").toUpperCase().slice(0, 16), 20, 30);
  ctx.fillStyle = "#9fb3c8"; ctx.font = "600 13px ui-sans-serif, system-ui, sans-serif";
  ctx.fillText("QUARTERLY STATUS REPORT", 20, 54);

  // KPI row — three big numbers with captions.
  const kpis = ["+24%", "98.2", "1.4k"];
  kpis.forEach((v, i) => {
    const x = 24 + i * 116;
    ctx.fillStyle = "#28323f"; ctx.font = "800 30px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(v, x, 110);
    ctx.fillStyle = "#7a8694"; ctx.font = "600 11px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(["GROWTH", "UPTIME", "RUNS"][i], x, 132);
  });

  // Bar chart.
  const bx = 24, by = 300, bw = 150, bh = 130;
  ctx.fillStyle = "#e7e2d6"; ctx.fillRect(bx, by - bh, bw, bh);
  for (let i = 0; i < 6; i++) {
    const h = (0.25 + rng() * 0.75) * (bh - 12);
    ctx.fillStyle = i === 5 ? bg : "#5b7ea8";
    ctx.fillRect(bx + 8 + i * 23, by - h, 15, h);
  }
  // Donut chart.
  const cx = 285, cy = 250, r = 52;
  let a0 = -Math.PI / 2;
  const segs = [0.45, 0.3, 0.25], cols = [bg, "#5b7ea8", "#c9cdd4"];
  segs.forEach((s, i) => {
    const a1 = a0 + s * Math.PI * 2;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, a0, a1); ctx.closePath();
    ctx.fillStyle = cols[i]; ctx.fill(); a0 = a1;
  });
  ctx.beginPath(); ctx.arc(cx, cy, 24, 0, Math.PI * 2); ctx.fillStyle = "#e7e1d2"; ctx.fill();

  // Line/sparkline panel.
  const lx = 24, ly = 360, lw = 332, lh = 70;
  ctx.fillStyle = "#e7e2d6"; ctx.fillRect(lx, ly, lw, lh);
  ctx.strokeStyle = bg; ctx.lineWidth = 3; ctx.beginPath();
  for (let i = 0; i <= 10; i++) {
    const x = lx + 8 + (i / 10) * (lw - 16), y = ly + lh - 8 - rng() * (lh - 16);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.stroke();
  // Faux paragraph lines.
  ctx.fillStyle = "#cdc6b6";
  for (let i = 0; i < 4; i++) ctx.fillRect(24, 444 + i * 12, (0.5 + rng() * 0.45) * (W - 48), 5);

  // Status chip (bottom-right).
  ctx.fillStyle = bg; ctx.fillRect(W - 132, H - 30, 120, 22);
  ctx.fillStyle = fg; ctx.font = "700 14px ui-monospace, Menlo, monospace"; ctx.textAlign = "center";
  ctx.fillText((status || "pending").toUpperCase(), W - 72, H - 18);
  p.tex.needsUpdate = true;
}

// ── props ─────────────────────────────────────────────────────────────────────

const NOTE_COLORS = [0xf4e04d, 0xf48fb1, 0x8fd3f4, 0xb9e08d];

// A small pinned sticky note (a quad just off a surface).
function stickyNote(rng) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.1),
    new THREE.MeshStandardMaterial({ color: NOTE_COLORS[Math.floor(rng() * NOTE_COLORS.length)], roughness: 0.95 }));
  m.rotation.z = (rng() - 0.5) * 0.4;
  return m;
}

// A late-90s beige CRT monitor modelled on the classic tube: a landscape (16:9)
// screen recessed behind a thin top/side bezel with a deeper bottom chin (control
// buttons + power LED + brand strip). The front bezel face stands PROUD and the tube
// steps DOWN and back behind it (per the reference), with side vent slits and a
// tilt-swivel base. The screen carries the live terminal (userData.screenTabId).
function makeMonitor(tabId, label, mats, rng) {
  const g = new THREE.Group();
  const SW = 0.56, SH = 0.315;                      // landscape screen (16:9, terminal-friendly)
  const SIDE = 0.03, CHIN = 0.11;                   // thin top/sides; deep chin → screen sits high
  const FW = SW + 2 * SIDE, FH = SH + SIDE + CHIN;  // bezel outer
  const SCY = (CHIN - SIDE) / 2;                    // screen centre raised above the bezel centre
  const front = mats.beige, trim = mats.beigeDark;

  // Stepped, back-sloping tube: the FRONT face is full height and tallest; the body
  // recedes down + back behind it. Vents sit on the mid section.
  const frontBody = new THREE.Mesh(new THREE.BoxGeometry(FW + 0.04, FH, 0.22), front);
  frontBody.position.set(0, 0, -0.075); g.add(frontBody);    // deep enough to back the bezel → no gap
  const midBody = new THREE.Mesh(new THREE.BoxGeometry(FW - 0.06, FH - 0.05, 0.18), front);
  midBody.position.set(0, -0.03, -0.24); g.add(midBody);
  const rearBody = new THREE.Mesh(new THREE.BoxGeometry(FW - 0.18, FH - 0.13, 0.14), front);
  rearBody.position.set(0, -0.055, -0.4); g.add(rearBody);
  const ventMat = new THREE.MeshStandardMaterial({ color: 0x4b4a44, roughness: 0.9 });
  for (const side of [-1, 1]) for (let j = 0; j < 4; j++) {
    const vent = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.012, 0.15), ventMat);
    vent.position.set(side * ((FW - 0.06) / 2 + 0.006), 0.05 - j * 0.04, -0.24); g.add(vent);
  }
  // Rounded brow lip overhanging the top of the front face (kept behind the post-its).
  const brow = new THREE.Mesh(new THREE.BoxGeometry(FW * 0.72, 0.035, 0.06), front);
  brow.position.set(0, FH / 2 - 0.004, 0.072); g.add(brow);

  // Recessed dark CRT face + the live terminal plane.
  const face = new THREE.Mesh(new THREE.PlaneGeometry(SW + 0.03, SH + 0.03),
    new THREE.MeshStandardMaterial({ color: 0x0f0d0a, roughness: 0.35 }));
  face.position.set(0, SCY, 0.055); g.add(face);
  const sc = document.createElement("canvas"); sc.width = 768; sc.height = 432;
  const tex = new THREE.CanvasTexture(sc); tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(SW, SH), new THREE.MeshBasicMaterial({ map: tex }));
  mesh.position.set(0, SCY, 0.072);                 // recessed behind the bezel
  let screen = null;
  if (tabId) {
    mesh.userData.screenTabId = tabId;
    screen = { tabId, label, canvas: sc, ctx: sc.getContext("2d"), tex, mesh, _standby: true };
  } else {
    const x = sc.getContext("2d");                  // dark, powered-off look
    x.fillStyle = "#07140d"; x.fillRect(0, 0, sc.width, sc.height);
    tex.needsUpdate = true;
  }
  g.add(mesh);

  // Glassy CRT front: a faint reflective overlay just in front of the terminal so
  // the screen catches the room / ceiling lights. ADDITIVE blending + a dielectric
  // fresnel (metalness 0) means it only ADDS reflected light — brightest at grazing
  // angles, near-invisible head-on — so the terminal text stays crisp and bright.
  if (mats.screenEnv) {
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(SW, SH),
      new THREE.MeshStandardMaterial({
        color: 0x000000, metalness: 0.0, roughness: 0.07,
        envMap: mats.screenEnv, envMapIntensity: 1.2,
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
    glass.position.set(0, SCY, 0.0735);              // just proud of the terminal plane (0.072)
    g.add(glass);
  }

  // Beige bezel: thin top/sides, a deeper chin carrying buttons + power LED + logo.
  const mkbar = (w, h, x, y) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.06), front);
    b.position.set(x, y, 0.072); g.add(b);          // front ≈ z 0.10; back embedded in the tube (no gap)
  };
  mkbar(FW, SIDE, 0, FH / 2 - SIDE / 2);            // top
  mkbar(SIDE, SH, -FW / 2 + SIDE / 2, SCY);         // left
  mkbar(SIDE, SH, FW / 2 - SIDE / 2, SCY);          // right
  mkbar(FW, CHIN, 0, -FH / 2 + CHIN / 2);           // chin (deeper)
  const chinY = -FH / 2 + CHIN / 2;
  for (let i = 0; i < 4; i++) {                     // control buttons
    const btn = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.016, 0.012), trim);
    btn.position.set(-0.05 + i * 0.036, chinY, 0.112); g.add(btn);
  }
  const powerBtn = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.012, 14), trim);
  powerBtn.rotation.x = Math.PI / 2; powerBtn.position.set(0.14, chinY, 0.112); g.add(powerBtn);
  // Power LED — recoloured by node status (paintStatus sets ledMat.color).
  const ledMat = new THREE.MeshBasicMaterial({ color: 0xbcbcc8 });
  const led = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.014, 0.008), ledMat);
  led.position.set(0.19, chinY, 0.114); g.add(led);
  const logo = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.013, 0.004), trim);
  logo.position.set(-0.16, chinY, 0.112); g.add(logo);        // brand strip

  for (let i = 0; i < 1 + Math.floor(rng() * 2); i++) {       // small post-its at the top edge of the bezel
    const n = stickyNote(rng);
    n.scale.setScalar(0.6);                                   // ~6cm, so they don't drape over the screen
    n.position.set(-0.08 + i * 0.12 + (rng() - 0.5) * 0.03, FH / 2 - 0.016, 0.118);  // in FRONT of the brow → not occluded
    g.add(n);
  }

  // Tilt-swivel stand: neck + swivel ring + dished base.
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.1, 0.1, 12), front);
  neck.position.set(0, -FH / 2 - 0.06, -0.05); g.add(neck);
  const swivel = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.025, 20), front);
  swivel.position.set(0, -FH / 2 - 0.115, -0.05); g.add(swivel);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.23, 0.03, 22), front);
  base.position.set(0, -FH / 2 - 0.14, -0.05); g.add(base);
  return { group: g, screen, standBottom: -FH / 2 - 0.155, ledMat };
}

// A swivel office chair: cushioned fabric seat + back on a post and a star base.
function makeChair(mats) {
  const g = new THREE.Group();
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.1, 0.44), mats.chair);
  seat.position.y = 0.5; g.add(seat);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.52, 0.08), mats.chair);
  back.position.set(0, 0.79, 0.2); g.add(back);   // backrest behind the sitter (+Z)
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.42, 8), mats.metal);
  post.position.y = 0.28; g.add(post);
  for (let i = 0; i < 5; i++) {                    // five-star base legs + casters
    const a = (i / 5) * Math.PI * 2;
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.04, 0.07), mats.metal);
    leg.position.set(Math.cos(a) * 0.15, 0.06, Math.sin(a) * 0.15); leg.rotation.y = -a; g.add(leg);
    const caster = new THREE.Mesh(new THREE.SphereGeometry(0.04, 6, 5), mats.metal);
    caster.position.set(Math.cos(a) * 0.28, 0.04, Math.sin(a) * 0.28); g.add(caster);
  }
  return g;
}

// A row of upright lever-arch binders leaning on a shelf/desk.
function makeBinders(rng, n) {
  const g = new THREE.Group();
  const colors = [0x6b2f2f, 0x2f4a6b, 0x3a5a36, 0x70502a, 0x44485a, 0x6b6450];
  let x = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.05 + rng() * 0.04, h = 0.28 + rng() * 0.08;
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.24),
      new THREE.MeshStandardMaterial({ color: colors[Math.floor(rng() * colors.length)], roughness: 0.8 }));
    b.position.set(x + w / 2, h / 2, 0); b.rotation.z = (rng() - 0.5) * 0.12; g.add(b);
    const label = new THREE.Mesh(new THREE.BoxGeometry(w * 0.6, h * 0.3, 0.245),
      new THREE.MeshStandardMaterial({ color: 0xeae4d2, roughness: 0.9 }));
    label.position.set(x + w / 2, h * 0.66, 0); g.add(label);
    x += w + 0.012;
  }
  return g;
}

// A boxy desk phone: base, sloped keypad, and a handset on the cradle.
function makeTelephone(mats) {
  const g = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.6 });
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.05, 0.2), dark);
  base.position.y = 0.025; g.add(base);
  const pad = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.02, 0.12),
    new THREE.MeshStandardMaterial({ color: 0x4a4e55, roughness: 0.5 }));
  pad.position.set(0, 0.06, 0.02); pad.rotation.x = -0.25; g.add(pad);
  const handset = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.05, 0.07), dark);
  handset.position.set(0, 0.085, -0.07); g.add(handset);
  for (const sx of [-0.11, 0.11]) {
    const ear = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.09), dark);
    ear.position.set(sx, 0.085, -0.07); g.add(ear);
  }
  return g;
}

// A pen cup with a few pens poking out.
function makePenCup(rng) {
  const g = new THREE.Group();
  const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.04, 0.1, 10),
    new THREE.MeshStandardMaterial({ color: 0x33363b, roughness: 0.6 }));
  cup.position.y = 0.05; g.add(cup);
  const inks = [0x1a1a1a, 0x2244aa, 0xaa2222, 0x227722];
  for (let i = 0; i < 3; i++) {
    const pen = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.18, 6),
      new THREE.MeshStandardMaterial({ color: inks[Math.floor(rng() * inks.length)], roughness: 0.5 }));
    pen.position.set((rng() - 0.5) * 0.04, 0.13, (rng() - 0.5) * 0.04);
    pen.rotation.set((rng() - 0.5) * 0.5, 0, (rng() - 0.5) * 0.5); g.add(pen);
  }
  return g;
}

// A beige QWERTY keyboard: a wedge tray with rows of keys + a spacebar. All the keys
// are merged into a single geometry (one draw call) so 16 desks stay cheap.
function makeKeyboard(mats) {
  const g = new THREE.Group();
  const W = 0.52, D = 0.19, ks = 0.024, kh = 0.014, pitch = 0.029;
  const base = new THREE.Mesh(new THREE.BoxGeometry(W, 0.022, D), mats.beige);
  base.position.y = 0.011; g.add(base);
  const geos = [];
  const addKey = (w, x, z) => {
    const geo = new THREE.BoxGeometry(w, kh, ks);
    geo.translate(x, 0.027, z); geos.push(geo);
  };
  [[13, -0.062], [13, -0.033], [12, -0.004], [11, 0.025]].forEach(([n, z]) => {
    const x0 = -((n - 1) * pitch) / 2;
    for (let i = 0; i < n; i++) addKey(ks, x0 + i * pitch, z);
  });
  addKey(0.17, 0, 0.054);                            // spacebar
  for (const x of [-0.155, -0.12, 0.12, 0.155]) addKey(ks, x, 0.054);   // modifiers
  const keys = new THREE.Mesh(mergeGeometries(geos),
    new THREE.MeshStandardMaterial({ color: 0xcfc8b6, roughness: 0.6 }));
  g.add(keys);
  return g;
}

// A two-button beige mouse: a rounded-ish body with left/right buttons split by a
// groove and a scroll wheel between them. Buttons face -Z (away from the sitter).
function makeMouse(mats) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.065, 0.02, 0.1), mats.beige);
  body.position.y = 0.012; g.add(body);
  for (const sx of [-1, 1]) {                        // left + right buttons
    const btn = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.012, 0.044), mats.beigeDark);
    btn.position.set(sx * 0.016, 0.026, -0.024); g.add(btn);
  }
  const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.009, 10),
    new THREE.MeshStandardMaterial({ color: 0x33363b, roughness: 0.6 }));
  wheel.rotation.z = Math.PI / 2; wheel.position.set(0, 0.03, -0.03); g.add(wheel);
  return g;
}

// A beige mini-tower PC that stands on the floor under the desk: CD + floppy drive
// bays, power button, activity LEDs, and side vents. Front (drive bays) faces +Z.
function makeTower(mats) {
  const g = new THREE.Group();
  const W = 0.2, Ht = 0.44, D = 0.46;
  const fz = D / 2 + 0.004;
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.6 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(W, Ht, D), mats.beige);
  body.position.y = Ht / 2; g.add(body);
  const cd = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.03, 0.012), mats.beigeDark);
  cd.position.set(0, Ht - 0.07, fz); g.add(cd);
  const cdbtn = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.008, 0.012), dark);
  cdbtn.position.set(0.062, Ht - 0.07, fz); g.add(cdbtn);
  const floppy = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.012, 0.012), dark);
  floppy.position.set(0, Ht - 0.13, fz); g.add(floppy);
  const pwr = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.012, 12), mats.beigeDark);
  pwr.rotation.x = Math.PI / 2; pwr.position.set(-0.05, 0.1, fz); g.add(pwr);
  for (const [x, c] of [[0.03, 0x39d353], [0.055, 0xe0b020]]) {
    const led = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.008, 0.008), new THREE.MeshBasicMaterial({ color: c }));
    led.position.set(x, 0.12, fz); g.add(led);
  }
  const ventMat = new THREE.MeshStandardMaterial({ color: 0x4b4a44, roughness: 0.9 });
  for (let i = 0; i < 5; i++) {
    const v = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.01, 0.18), ventMat);
    v.position.set(W / 2 + 0.002, 0.16 + i * 0.04, 0); g.add(v);
  }
  return g;
}

// One cubicle workstation in LOCAL space (monitor faces +Z, the open diagonal): an
// L-shaped laminate desk with a front fascia, CRT, keyboard, mouse, plus stage-varied
// clutter (binders, phone, pen cup, mug, papers, desk plant), an office chair, and
// the status placard. Returns { group, screen, placard }.
function makeWorkstation(stage, tabId, mats, showLogo) {
  const g = new THREE.Group();
  const rng = hash((stage && stage.id || "x") + (tabId || ""));
  const collide = [];                               // pieces that get solid collision

  // L-shaped surface: a main run + a perpendicular return wing on the right. The
  // desktop is deliberately NOT collidable — it overhangs at waist height, so you
  // can walk in past the chair and lean right over it. Only the solid masses at the
  // back (pedestal + monitor) collide, which still blocks passage to the partition.
  const mkTop = (w, d, x, z) => {
    const top = new THREE.Mesh(new THREE.BoxGeometry(w, 0.05, d), mats.deskTop);
    top.position.set(x, 0.74, z); g.add(top);
    const edge = new THREE.Mesh(new THREE.BoxGeometry(w + 0.02, 0.03, d + 0.02), mats.deskEdge);
    edge.position.set(x, 0.71, z); g.add(edge);     // dark front-edge trim
  };
  mkTop(1.4, 0.78, 0, 0);
  mkTop(0.55, 0.95, 0.92, -0.32);                   // return wing (back-right)
  const fascia = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.6, 0.04), mats.deskEdge);
  fascia.position.set(0, 0.42, -0.39); g.add(fascia);  // modesty panel at the BACK — knee-hole opens toward the chair
  for (const x of [-0.62, 0.62]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.72, 0.72), mats.deskLeg);
    leg.position.set(x, 0.36, 0); g.add(leg);
  }
  const ped = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.64, 0.5), mats.beige);
  ped.position.set(0.92, 0.32, -0.32); g.add(ped);  // drawer pedestal under the return wing (supports the binders)
  collide.push({ obj: ped, nx: 2, nz: 2 });
  const tower = makeTower(mats);
  tower.position.set(-0.4, 0, -0.05); g.add(tower);  // PC tower on the floor under the desk, clear of the leg + back fascia
  collide.push({ obj: tower });                      // group → single AABB (grid path needs a Mesh.geometry)
  for (const y of [0.5, 0.28, 0.12]) {
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.015, 0.01), mats.deskEdge);
    h.position.set(0.92, y, -0.06); g.add(h);        // on the pedestal's front face
  }

  const mon = makeMonitor(tabId, stage.label, mats, rng);
  mon.group.position.set(-0.1, 0.765 - mon.standBottom, -0.06); g.add(mon.group);  // stand base rests on the desktop
  // Invisible back-stop just behind the monitor — lets you push right up to the glass
  // (limited only by your body radius) yet still can't pass through to the partition.
  const stop = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.1, 0.04), new THREE.MeshBasicMaterial());
  stop.visible = false; stop.position.set(-0.1, 0.9, -0.33); g.add(stop);
  collide.push({ obj: stop, nx: 8, nz: 1 });         // thin + many cells → minimal rotation bloat
  const kb = makeKeyboard(mats);
  kb.position.set(-0.1, 0.765, 0.2); kb.rotation.x = -0.05; g.add(kb);
  const mouse = makeMouse(mats);
  mouse.position.set(0.28, 0.765, 0.18); g.add(mouse);

  // Clutter on the return wing + desk, varied per stage.
  const binders = makeBinders(rng, 3 + Math.floor(rng() * 3));
  binders.position.set(0.7, 0.765, -0.55); binders.rotation.y = 0.1; g.add(binders);
  if (rng() < 0.7) { const ph = makeTelephone(mats); ph.position.set(0.95, 0.765, 0.0); ph.rotation.y = -0.5; g.add(ph); }
  const pens = makePenCup(rng); pens.position.set(1.05, 0.765, -0.15); g.add(pens);
  const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.04, 0.1, 12),
    new THREE.MeshStandardMaterial({ color: 0xb5402f, roughness: 0.6 }));
  mug.position.set(-0.55, 0.81, 0.12); g.add(mug);
  const papers = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.025, 0.3),
    new THREE.MeshStandardMaterial({ color: 0xf4f1e8, roughness: 0.9 }));
  papers.position.set(-0.5, 0.76, -0.12); papers.rotation.y = (rng() - 0.5) * 0.5; g.add(papers);
  // little desk succulent for the "indoor plants" brief
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.08, 10),
    new THREE.MeshStandardMaterial({ color: 0x9c5a3c, roughness: 0.9 }));
  pot.position.set(0.52, 0.8, -0.28); g.add(pot);    // on the main desktop, back-right
  const bush = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6),
    new THREE.MeshStandardMaterial({ color: 0x3f8f4a, roughness: 0.8 }));
  bush.position.set(0.52, 0.89, -0.28); bush.scale.y = 0.8; g.add(bush);
  // A mini Claude figurine on the desk, beside the plant (borrowed from tropical).
  const claude = makeClaude().group;
  const cs = 0.15;
  claude.scale.setScalar(cs);
  claude.position.set(0.4, 0.765 - 0.09 * cs, 0.0);     // front-right of the desk, clear of the monitor
  claude.rotation.y = -0.5;                              // turned a little toward the chair
  g.add(claude);

  const chair = makeChair(mats);
  chair.position.set(-0.1, 0, 0.7); g.add(chair);    // sitter at +Z faces the monitor (−Z), backrest behind
  // (chair is intentionally NOT collidable — you can walk through it)

  // Title shows as a report poster pinned to the left partition wall of the cubicle
  // (the −Z direction points at the cluster centre; this lands on the side arm).
  // Title/report poster — ALWAYS present on the left partition (it's the status display).
  const poster = makePoster(stage.label, "report");
  poster.group.position.set(-1.0, 0.92, -1.0);
  poster.group.rotation.y = Math.PI / 4;             // flush to the side partition, facing into the cubicle
  g.add(poster.group);

  // One desk per cluster of 4 (chosen in layout) ALSO gets a Nurture Cloud poster.
  if (showLogo) {
    const nc = makePoster(stage.label, "logo");
    nc.group.position.set(1.05, 0.92, -1.05);
    nc.group.rotation.y = -Math.PI / 4;
    g.add(nc.group);
  }

  // Status display object the engine repaints: the monitor LED colour + the title poster.
  const statusObj = { ledMat: mon.ledMat, poster };
  return { group: g, screen: mon.screen, status: statusObj, collide };
}

// The shared (+) partition for a cluster: fabric-covered panels with a cream plastic
// top cap and corner/end posts, a darker kick at the floor, and a few pinned papers.
// Returns { group, walls } where walls are LOCAL XZ AABBs.
function makeCross(mats) {
  const g = new THREE.Group();
  const rng = hash("cross");
  for (const [w, d] of [[ARM * 2, PART_T], [PART_T, ARM * 2]]) {
    const panel = new THREE.Mesh(new THREE.BoxGeometry(w, PART_H, d), mats.partition);
    panel.position.y = PART_H / 2; g.add(panel);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(w + 0.08, 0.07, d + 0.08), mats.cap);
    cap.position.y = PART_H + 0.035; g.add(cap);    // overhanging cream top cap
    const kick = new THREE.Mesh(new THREE.BoxGeometry(w + 0.02, 0.08, d + 0.04), mats.cap);
    kick.position.y = 0.04; g.add(kick);            // base kick rail
  }
  // Posts: cream uprights at the centre and the four arm ends (the modular look).
  for (const [px, pz] of [[0, 0], [ARM, 0], [-ARM, 0], [0, ARM], [0, -ARM]]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.17, PART_H + 0.07, 0.17), mats.cap);
    post.position.set(px, (PART_H + 0.07) / 2, pz); g.add(post);
  }
  // A few papers/sticky notes pinned on the panels facing into the quadrants.
  for (let i = 0; i < 6; i++) {
    const onX = i % 2 === 0;                          // alternate the two panels
    const along = (rng() * 0.82) * ARM * (rng() < 0.5 ? 1 : -1);   // stays on the panel (|along| < ARM)
    const face = (rng() < 0.5 ? 1 : -1) * (PART_T / 2 + 0.006);
    if (rng() < 0.5) {
      const note = stickyNote(rng);
      if (onX) { note.position.set(along, 0.6 + rng() * 0.5, face); note.rotation.y = face > 0 ? 0 : Math.PI; }
      else { note.position.set(face, 0.6 + rng() * 0.5, along); note.rotation.y = face > 0 ? Math.PI / 2 : -Math.PI / 2; }
      g.add(note);
    } else {
      const paper = new THREE.Mesh(new THREE.PlaneGeometry(0.21, 0.28),
        new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.95 }));
      if (onX) { paper.position.set(along, 0.8 + rng() * 0.3, face); paper.rotation.y = face > 0 ? 0 : Math.PI; }
      else { paper.position.set(face, 0.8 + rng() * 0.3, along); paper.rotation.y = face > 0 ? Math.PI / 2 : -Math.PI / 2; }
      g.add(paper);
    }
  }
  const walls = [
    { minX: -ARM, maxX: ARM, minZ: -PART_T / 2, maxZ: PART_T / 2 },
    { minX: -PART_T / 2, maxX: PART_T / 2, minZ: -ARM, maxZ: ARM },
  ];
  return { group: g, walls };
}

// Worn enamel-paint door texture: a sage-green painted slab with two recessed panels,
// brush streaks and gloss, and the wood substrate chipping through at the edges/corners
// and around the handle — the classic old-office painted door.
function makeDoorTexture() {
  const w = 256, h = 560, c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  const enamel = "#7f8b70", enLt = "#94a085", enDk = "#69745b", wood = "#5b4632";
  g.fillStyle = wood; g.fillRect(0, 0, w, h);          // substrate (shows at chips)
  g.fillStyle = enamel; g.fillRect(0, 0, w, h);        // enamel field
  for (let i = 0; i < 70; i++) {                        // vertical brush streaks
    g.strokeStyle = Math.random() < 0.5
      ? `rgba(255,255,255,${0.03 + Math.random() * 0.05})`
      : `rgba(0,0,0,${0.03 + Math.random() * 0.06})`;
    g.lineWidth = 1 + Math.random() * 2; const x = Math.random() * w;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x + (Math.random() - 0.5) * 6, h); g.stroke();
  }
  const panel = (px, py, pw, ph) => {                  // recessed panel: shadow + highlight bevel
    g.strokeStyle = enDk; g.lineWidth = 5; g.strokeRect(px, py, pw, ph);
    g.strokeStyle = enLt; g.lineWidth = 2; g.strokeRect(px + 4, py + 4, pw - 8, ph - 8);
  };
  panel(34, 42, w - 68, 196);
  panel(34, 272, w - 68, h - 312);
  const lg = g.createLinearGradient(0, 0, w, h);       // enamel gloss sheen
  lg.addColorStop(0, "rgba(255,255,255,0.12)"); lg.addColorStop(0.5, "rgba(255,255,255,0)");
  g.fillStyle = lg; g.fillRect(0, 0, w, h);
  const chip = (x, y, s) => {                           // an irregular wood chip
    g.fillStyle = wood; g.beginPath(); g.moveTo(x, y);
    for (let k = 0; k < 5; k++) g.lineTo(x + (Math.random() - 0.5) * s, y + (Math.random() - 0.5) * s);
    g.closePath(); g.fill();
  };
  for (let i = 0; i < 80; i++) chip(Math.random() < 0.5 ? Math.random() * 9 : w - Math.random() * 9, Math.random() * h, 4 + Math.random() * 7);
  for (let i = 0; i < 55; i++) chip(Math.random() * w, Math.random() < 0.5 ? Math.random() * 9 : h - Math.random() * 9, 4 + Math.random() * 7);
  for (const [cxp, cyp] of [[0, 0], [w, 0], [0, h], [w, h]])   // heavier corner wear
    for (let i = 0; i < 26; i++) chip(cxp + (Math.random() - 0.5) * 38, cyp + (Math.random() - 0.5) * 48, 4 + Math.random() * 9);
  for (let i = 0; i < 16; i++) chip(w - 18 - Math.random() * 32, h * 0.5 + (Math.random() - 0.5) * 70, 3 + Math.random() * 6);  // wear by the handle
  g.strokeStyle = "rgba(60,46,32,0.5)"; g.lineWidth = 3; g.strokeRect(1.5, 1.5, w - 3, h - 3);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  return tex;
}

// A worn enamel office door (faces local +Z): painted slab + casing frame, a lever
// handle on a backplate, and a metal kick plate.
function makeDoor() {
  const g = new THREE.Group();
  const DW = 0.95, DH = 2.05, DT = 0.06;
  const slab = new THREE.Mesh(new THREE.BoxGeometry(DW, DH, DT),
    new THREE.MeshStandardMaterial({ map: makeDoorTexture(), roughness: 0.45 }));   // enamel = a little glossy
  slab.position.y = DH / 2; g.add(slab);
  const frameMat = new THREE.MeshStandardMaterial({ color: 0xcfc7b4, roughness: 0.75 });
  const fT = 0.08, fD = 0.12;
  for (const sx of [-1, 1]) {
    const jamb = new THREE.Mesh(new THREE.BoxGeometry(fT, DH + fT, fD), frameMat);
    jamb.position.set(sx * (DW / 2 + fT / 2), (DH + fT) / 2, 0); g.add(jamb);
  }
  const head = new THREE.Mesh(new THREE.BoxGeometry(DW + 2 * fT, fT, fD), frameMat);
  head.position.set(0, DH + fT / 2, 0); g.add(head);
  const metal = new THREE.MeshStandardMaterial({ color: 0x8a8d92, roughness: 0.4, metalness: 0.6 });
  const plate = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.14, 0.012), metal);
  plate.position.set(DW / 2 - 0.1, DH * 0.46, DT / 2 + 0.006); g.add(plate);
  const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.05, 10), metal);
  knob.rotation.x = Math.PI / 2; knob.position.set(DW / 2 - 0.1, DH * 0.46, DT / 2 + 0.03); g.add(knob);
  const lever = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.022, 0.022), metal);
  lever.position.set(DW / 2 - 0.16, DH * 0.46, DT / 2 + 0.05); g.add(lever);
  const kick = new THREE.Mesh(new THREE.BoxGeometry(DW - 0.06, 0.18, 0.012),
    new THREE.MeshStandardMaterial({ color: 0x9a9da2, roughness: 0.5, metalness: 0.5 }));
  kick.position.set(0, 0.12, DT / 2 + 0.006); g.add(kick);
  return g;
}

// A leafy potted ficus for the floor corners.
function makePlant() {
  const g = new THREE.Group();
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.2, 0.4, 14),
    new THREE.MeshStandardMaterial({ color: 0x7a4a30, roughness: 0.9 }));
  pot.position.y = 0.2; g.add(pot);
  const soil = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.04, 14),
    new THREE.MeshStandardMaterial({ color: 0x2c2018, roughness: 1 }));
  soil.position.y = 0.39; g.add(soil);
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.06, 0.72, 8),
    new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.9 }));
  trunk.position.y = 0.74; g.add(trunk);             // stem connecting pot → foliage
  const leaf = new THREE.MeshStandardMaterial({ color: 0x357a3c, roughness: 0.8 });
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const cl = new THREE.Mesh(new THREE.SphereGeometry(0.36 + Math.random() * 0.12, 8, 6), leaf);
    cl.position.set(Math.cos(a) * 0.22, 1.0 + Math.random() * 0.4, Math.sin(a) * 0.22);
    cl.scale.y = 1.3; g.add(cl);
  }
  const top = new THREE.Mesh(new THREE.SphereGeometry(0.42, 8, 6), leaf);
  top.position.y = 1.5; g.add(top);
  return g;
}

// A bulky beige photocopier with a darker lid, a paper tray and a control panel.
function makeCopier(mats) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.0, 0.7), mats.beige);
  body.position.y = 0.5; g.add(body);
  const lid = new THREE.Mesh(new THREE.BoxGeometry(1.02, 0.12, 0.72),
    new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.6 }));
  lid.position.y = 1.06; g.add(lid);
  const tray = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.06, 0.3), mats.beige);
  tray.position.set(0.0, 0.78, 0.42); tray.rotation.x = -0.25; g.add(tray);
  const panel = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.18, 0.04),
    new THREE.MeshStandardMaterial({ color: 0x202326, roughness: 0.5 }));
  panel.position.set(0.3, 0.95, 0.36); panel.rotation.x = -0.4; g.add(panel);
  return g;
}

// A two-drawer beige filing cabinet.
function makeCabinet(mats) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.0, 0.6), mats.beige);
  body.position.y = 0.5; g.add(body);
  for (const y of [0.7, 0.3]) {
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.03, 0.02),
      new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.5 }));
    handle.position.set(0, y, 0.31); g.add(handle);
    const seam = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.01, 0.01),
      new THREE.MeshStandardMaterial({ color: 0xb7b1a0 }));
    seam.position.set(0, y + 0.18, 0.305); g.add(seam);
  }
  return g;
}

// A free-standing water cooler — the walk-up portal. Bottle on a cabinet with a
// spigot; a bubble mesh rises through the bottle (animated). Returns
// { group, walls, bubble }; walls are LOCAL XZ AABBs.
function makeWaterCooler() {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.9, 0.42),
    new THREE.MeshStandardMaterial({ color: 0xeae6db, roughness: 0.7 }));
  base.position.y = 0.45; g.add(base);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.16, 0.12, 16),
    new THREE.MeshStandardMaterial({ color: 0xd8d4ca, roughness: 0.6 }));
  neck.position.y = 0.96; g.add(neck);
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x7fd0e6, roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.7,
  });
  const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.13, 0.5, 16), waterMat);
  bottle.position.y = 1.28; g.add(bottle);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.12, 12),
    new THREE.MeshStandardMaterial({ color: 0x3a6ea5, roughness: 0.5 }));
  cap.position.y = 1.58; g.add(cap);
  // Two paddle taps (cold/hot) + a recessed drip basin, all on the +Z (front) face.
  const blue = new THREE.MeshStandardMaterial({ color: 0x3a6ea5, roughness: 0.5 });
  const red = new THREE.MeshStandardMaterial({ color: 0xa83c3c, roughness: 0.5 });
  for (const [sx, mat] of [[-0.06, blue], [0.06, red]]) {
    const tap = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.07, 0.09), mat);
    tap.position.set(sx, 0.86, 0.22); g.add(tap);
  }
  const basin = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.03, 0.1),
    new THREE.MeshStandardMaterial({ color: 0x8f8b80, roughness: 0.6, metalness: 0.3 }));
  basin.position.set(0, 0.74, 0.22); g.add(basin);

  // Side-mounted paper-cup dispenser: a translucent tube of nested cups with one
  // poking out the bottom.
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.5, 12, 1, true),
    new THREE.MeshStandardMaterial({ color: 0xdedcd2, roughness: 0.5, side: THREE.DoubleSide, transparent: true, opacity: 0.5 }));
  tube.position.set(0.25, 1.15, 0.08); g.add(tube);
  const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.027, 0.46, 12),
    new THREE.MeshStandardMaterial({ color: 0xf2f0e8, roughness: 0.85 }));
  stack.position.set(0.25, 1.16, 0.08); g.add(stack);
  const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.027, 0.07, 12),
    new THREE.MeshStandardMaterial({ color: 0xf2f0e8, roughness: 0.85 }));
  cup.position.set(0.25, 0.87, 0.08); g.add(cup);

  const bubble = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6),
    new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }));
  bubble.position.set(0, 1.1, 0); g.add(bubble);
  const walls = [{ minX: -0.24, maxX: 0.24, minZ: -0.24, maxZ: 0.24 }];
  return { group: g, walls, bubble };
}

// ── theme ─────────────────────────────────────────────────────────────────────

// Classic soda-machine front for the CI/CD prop: a branded blue/red panel with a big
// vertical wordmark, and a right control column carrying the coin mech + the three
// selection buttons. The 3D LED buttons are placed over the column button housings.
const CICD_LABELS = ["BUILD", "DEV", "PROD"];   // short labels for the narrow column
const CICD_KEYS = ["build", "rwd-apply", "rwp-plan"];
const CICD_PANEL_W = 280, CICD_PANEL_H = 512;
const CICD_COL_X = 196, CICD_COL_W = 74;        // right control-column rect (texture px)
const CICD_ROWS_TY = [206, 296, 386];           // button-row centre-y in the column
function _rr(g, x, y, w, h, r) {                // rounded-rect path helper
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
function makeCicdPanel() {
  const W = CICD_PANEL_W, H = CICD_PANEL_H;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d");
  g.fillStyle = "#2a2d33"; g.fillRect(0, 0, W, H);              // metallic frame
  // ── main branded panel (white border → blue top / red bottom) ──
  const px = 10, py = 10, pw = 176, ph = H - 20;
  _rr(g, px, py, pw, ph, 18); g.fillStyle = "#f2f2f0"; g.fill();
  const ix = px + 12, iy = py + 12, iw = pw - 24, ih = ph - 24;
  g.fillStyle = "#1a97e0"; g.fillRect(ix, iy, iw, ih / 2);
  g.fillStyle = "#d62b2b"; g.fillRect(ix, iy + ih / 2, iw, ih / 2);
  g.textAlign = "center"; g.textBaseline = "middle"; g.fillStyle = "#f6f6f4";
  g.save(); g.translate(ix + iw * 0.60, iy + ih * 0.5); g.rotate(Math.PI / 2);  // vertical wordmark
  g.font = "bold 96px Georgia, 'Times New Roman', serif"; g.fillText("CI/CD", 0, 0); g.restore();
  g.save(); g.translate(ix + iw * 0.25, iy + ih * 0.62); g.rotate(Math.PI / 2);  // "Enjoy"
  g.font = "italic 22px Georgia, serif"; g.fillText("Enjoy", 0, 0); g.restore();
  // ── right control column: coin mech + price + three selection buttons ──
  const cx = CICD_COL_X, cw = CICD_COL_W, mid = cx + cw / 2;
  g.fillStyle = "#17191d"; g.fillRect(cx, 10, cw, H - 20);
  // ── coin mechanism (metallic): coin-insert bezel, ".75" plate + red readout, coin return ──
  g.fillStyle = "#b8bcc4"; _rr(g, cx + 6, 20, cw - 12, 106, 8); g.fill();
  g.strokeStyle = "#6b6f77"; g.lineWidth = 2; g.stroke();
  g.fillStyle = "#33363d"; _rr(g, cx + 15, 30, cw - 30, 30, 5); g.fill();       // insert bezel
  g.fillStyle = "#0b0d10"; _rr(g, cx + 22, 41, cw - 44, 11, 3); g.fill();       // slot opening
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillStyle = "#e8e6df"; g.fillRect(cx + 13, 74, 22, 18);                     // ".75" white plate
  g.fillStyle = "#111"; g.font = "bold 13px ui-monospace, monospace"; g.fillText(".75", cx + 24, 83);
  g.fillStyle = "#240000"; g.fillRect(cx + 39, 74, cw - 51, 18);               // red readout (within the housing)
  g.fillStyle = "#ff3b30"; g.font = "bold 10px ui-monospace, monospace"; g.fillText(".75", cx + 39 + (cw - 51) / 2, 83);
  g.fillStyle = "#9aa0a8"; g.beginPath(); g.arc(mid, 110, 9, 0, Math.PI * 2); g.fill();  // coin return
  g.strokeStyle = "#5a5e66"; g.lineWidth = 2; g.stroke();
  g.strokeStyle = "#33363d"; g.beginPath(); g.arc(mid, 110, 4, 0, Math.PI * 2); g.stroke();
  // ── selection buttons: brushed-metal sub-panel; each a white-bezel rectangular slot
  //    (the 3D colour button drops into it), with a small caption above ──
  g.fillStyle = "#5a5e66"; _rr(g, cx + 6, 148, cw - 12, H - 30 - 148, 8); g.fill();
  g.strokeStyle = "#20232a"; g.lineWidth = 2; g.stroke();
  g.textAlign = "center";
  CICD_LABELS.forEach((lab, i) => {
    const ty = CICD_ROWS_TY[i];
    g.fillStyle = "#0d0f12"; g.font = "700 9px ui-monospace, monospace";
    g.fillText(lab, mid, ty - 17);                                              // caption above
    g.fillStyle = "#e9e7e0"; _rr(g, cx + 12, ty - 13, cw - 24, 26, 4); g.fill();  // white bezel
    g.strokeStyle = "#8a8f98"; g.lineWidth = 1.5; g.stroke();
  });
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  return tex;
}

const office = {
  id: "office",
  label: "Retro Cubicles",
  fog: { color: 0x090e16, near: 42, far: 145 },     // dark night the city fades into

  background() { return makeSkyGradient(); },        // dusk sky behind the towers

  buildWorld(scene, renderer, camera) {
    // Flat fluorescent lighting: cool sky/ground fill, a soft top key, and bright
    // recessed ceiling panels that catch the bloom.
    scene.add(new THREE.HemisphereLight(0xf2f5ff, 0x3a3d42, 1.0));
    scene.add(new THREE.AmbientLight(0xffffff, 0.3));
    const key = new THREE.DirectionalLight(0xffffff, 0.5);
    key.position.set(8, 24, 6); scene.add(key);

    const shared = {
      beige: new THREE.MeshStandardMaterial({ color: 0xd9d2bf, roughness: 0.7 }),
      beigeDark: new THREE.MeshStandardMaterial({ color: 0xc5bda6, roughness: 0.7 }),
      deskTop: new THREE.MeshStandardMaterial({ map: makeLaminateTexture(), roughness: 0.55 }),
      deskEdge: new THREE.MeshStandardMaterial({ color: 0x4f5258, roughness: 0.5 }),
      deskLeg: new THREE.MeshStandardMaterial({ color: 0x6c6f75, roughness: 0.6, metalness: 0.3 }),
      partition: new THREE.MeshStandardMaterial({ map: makeFabricTexture("#8893a0"), roughness: 0.98 }),
      cap: new THREE.MeshStandardMaterial({ color: 0xe7e2d4, roughness: 0.6 }),
      chair: new THREE.MeshStandardMaterial({ map: makeFabricTexture("#37414d"), roughness: 0.95 }),
      metal: new THREE.MeshStandardMaterial({ color: 0x4a4d52, roughness: 0.5, metalness: 0.4 }),
    };

    // Carpet floor + suspended ceiling with recessed light troffers.
    const carpet = new THREE.Mesh(
      new THREE.PlaneGeometry(ROOM_HALF * 2, ROOM_HALF * 2),
      new THREE.MeshStandardMaterial({ map: makeCarpetTexture(), roughness: 1 }),
    );
    carpet.rotation.x = -Math.PI / 2; carpet.position.y = 0.01; scene.add(carpet);
    const ceiling = new THREE.Mesh(
      new THREE.PlaneGeometry(ROOM_HALF * 2, ROOM_HALF * 2),
      new THREE.MeshStandardMaterial({ map: makeCeilingTexture(), roughness: 1, side: THREE.DoubleSide }),
    );
    ceiling.rotation.x = Math.PI / 2; ceiling.position.y = CEIL_H; scene.add(ceiling);
    const housingMat = new THREE.MeshStandardMaterial({ color: 0xf4f3ec, roughness: 0.6 });
    const panelMat = new THREE.MeshBasicMaterial({ color: 0xfdfdf4 });
    for (let gx = -1; gx <= 1; gx++) for (let gz = -1; gz <= 1; gz++) {
      const housing = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.14, 1.1), housingMat);
      housing.position.set(gx * 8, CEIL_H - 0.05, gz * 8); scene.add(housing);     // recessed troffer
      const face = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 0.92), panelMat);
      face.rotation.x = Math.PI / 2; face.position.set(gx * 8, CEIL_H - 0.13, gz * 8); scene.add(face);
    }

    // Outer walls (collision lives in treeWalls so it survives room rebuilds).
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xcdc7b6, roughness: 0.9 });
    const treeWalls = [];
    const addOuter = (mesh, box) => { scene.add(mesh); treeWalls.push(box); };
    // Back (−Z) wall: a ribbon window — sill below + header above leave an opening you
    // see the city through. Collision stays full (you can't walk through; it's 2D in XZ).
    treeWalls.push({ minX: -ROOM_HALF, maxX: ROOM_HALF, minZ: -ROOM_HALF - 0.2, maxZ: -ROOM_HALF + 0.2 });
    const SILL = 1.0, HEAD = 2.7;
    const sill = new THREE.Mesh(new THREE.BoxGeometry(ROOM_HALF * 2, SILL, 0.3), wallMat);
    sill.position.set(0, SILL / 2, -ROOM_HALF); scene.add(sill);
    const header = new THREE.Mesh(new THREE.BoxGeometry(ROOM_HALF * 2, CEIL_H - HEAD, 0.3), wallMat);
    header.position.set(0, (HEAD + CEIL_H) / 2, -ROOM_HALF); scene.add(header);
    addOuter(wallBox(ROOM_HALF * 2, 0.3, 0, ROOM_HALF, wallMat),
      { minX: -ROOM_HALF, maxX: ROOM_HALF, minZ: ROOM_HALF - 0.2, maxZ: ROOM_HALF + 0.2 });
    addOuter(wallBox(0.3, ROOM_HALF * 2, -ROOM_HALF, 0, wallMat),
      { minX: -ROOM_HALF - 0.2, maxX: -ROOM_HALF + 0.2, minZ: -ROOM_HALF, maxZ: ROOM_HALF });
    addOuter(wallBox(0.3, ROOM_HALF * 2, ROOM_HALF, 0, wallMat),
      { minX: ROOM_HALF - 0.2, maxX: ROOM_HALF + 0.2, minZ: -ROOM_HALF, maxZ: ROOM_HALF });

    // Transparent glass in the opening + vertical mullions and a centre transom.
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_HALF * 2 - 0.2, HEAD - SILL),
      new THREE.MeshStandardMaterial({ color: 0x9fb8c8, transparent: true, opacity: 0.14,
        roughness: 0.08, metalness: 0.2, side: THREE.DoubleSide }));
    glass.position.set(0, (SILL + HEAD) / 2, -ROOM_HALF + 0.03); scene.add(glass);
    const frameMat = new THREE.MeshStandardMaterial({ color: 0xb7b1a0, roughness: 0.7 });
    for (let i = -6; i <= 6; i++) {                  // vertical mullions
      const mull = new THREE.Mesh(new THREE.BoxGeometry(0.07, HEAD - SILL, 0.08), frameMat);
      mull.position.set(i * (ROOM_HALF * 2 / 13), (SILL + HEAD) / 2, -ROOM_HALF + 0.06); scene.add(mull);
    }
    const transom = new THREE.Mesh(new THREE.BoxGeometry(ROOM_HALF * 2, 0.07, 0.08), frameMat);
    transom.position.set(0, (SILL + HEAD) / 2, -ROOM_HALF + 0.06); scene.add(transom);

    // The 3D city of towers beyond the glass.
    scene.add(makeCityscape());

    // A worn enamel-painted door mounted on the front (+Z) wall's interior face,
    // facing into the room. (The wall is 0.3 thick → its room face is at ROOM_HALF-0.15;
    // sit the door just in front of it so it isn't hidden inside the wall.)
    const door = makeDoor();
    door.position.set(4, 0, ROOM_HALF - 0.22); door.rotation.y = Math.PI; scene.add(door);

    // Floor decor: plants in the corners, a photocopier and filing cabinets along
    // walls. The bulky pieces are solid (added to treeWalls).
    [[-ROOM_HALF + 1.2, -ROOM_HALF + 1.2], [ROOM_HALF - 1.2, -ROOM_HALF + 1.2],
     [-ROOM_HALF + 1.2, ROOM_HALF - 1.2], [ROOM_HALF - 1.2, ROOM_HALF - 1.2]]
      .forEach(([x, z]) => {
        const p = makePlant(); p.position.set(x, 0, z); scene.add(p);
        treeWalls.push({ minX: x - 0.3, maxX: x + 0.3, minZ: z - 0.3, maxZ: z + 0.3 });
      });
    const copier = makeCopier(shared);
    copier.position.set(ROOM_HALF - 0.7, 0, ROOM_HALF - 4); copier.rotation.y = -Math.PI / 2;
    scene.add(copier);
    treeWalls.push({ minX: ROOM_HALF - 1.1, maxX: ROOM_HALF - 0.2, minZ: ROOM_HALF - 4.6, maxZ: ROOM_HALF - 3.4 });
    for (const z of [ROOM_HALF - 7, ROOM_HALF - 8.2]) {
      const cab = makeCabinet(shared);
      cab.position.set(-ROOM_HALF + 0.5, 0, z); cab.rotation.y = Math.PI / 2; scene.add(cab);
      treeWalls.push({ minX: -ROOM_HALF + 0.2, maxX: -ROOM_HALF + 0.9, minZ: z - 0.3, maxZ: z + 0.3 });
    }

    // Two water-cooler portals on the side walls: right = NEXT, left = PREVIOUS.
    // Each fires when you step within ~1.1 of it; you emerge a couple of units
    // toward the centre, facing it, so arriving doesn't instantly re-trigger.
    const trees = [], bubbles = [];
    [["next", COOLER_X], ["prev", -COOLER_X]].forEach(([role, x]) => {
      const { group, walls, bubble } = makeWaterCooler();
      group.position.set(x, 0, 0);
      group.rotation.y = x > 0 ? -Math.PI / 2 : Math.PI / 2;   // taps/dispenser face room centre
      scene.add(group);
      // walls are a symmetric square, so the y-rotation doesn't change the AABB.
      for (const w of walls) treeWalls.push({ minX: x + w.minX, maxX: x + w.maxX, minZ: w.minZ, maxZ: w.maxZ });
      bubbles.push(bubble);                          // bubble is a child of the group (already at world x)
      const sx = x - Math.sign(x) * 2.2, sz = 0;
      trees.push({ role, x, z: 0, sx, sz, syaw: Math.atan2(sx, sz) });
    });

    const roomsGroup = new THREE.Group();
    scene.add(roomsGroup);

    // Reflection probe: render the room shell ONCE into a small cube map, shared by
    // every CRT's glass overlay so the screens catch the ceiling lights / room.
    // Captured here, before desks + monitors exist, so screens reflect the room (not
    // each other) — no feedback, and just one cheap render.
    const reflectRT = new THREE.WebGLCubeRenderTarget(256);
    const reflectCam = new THREE.CubeCamera(0.1, 80, reflectRT);
    reflectCam.position.set(0, 2.2, 0);   // mid-room, near the ceiling troffers
    scene.add(reflectCam);
    reflectCam.update(renderer, scene);
    shared.screenEnv = reflectRT.texture;

    // Mild bloom for the CRT phosphor glow + ceiling panels (high threshold so only
    // the bright bits bloom — keeps the flat office look elsewhere).
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.4, 0.5, 0.82));

    // `claude`/`water` are opaque animation handles to the engine; the office uses
    // `claude` to carry its rising water-cooler bubbles.
    return { roomsGroup, mats: shared, water: null, claude: { bubbles }, treeWalls, trees, composer };
  },

  layout,

  buildStage(stage, slot, mats, tabId) {
    const g = new THREE.Group();
    const walls = [];
    const { cx, cz, q, anchor } = slot;
    g.position.set(cx, 0, cz);
    if (anchor) {                                   // first desk of a cluster builds the +
      const cross = makeCross(mats);
      g.add(cross.group);
      for (const w of cross.walls) walls.push({
        minX: cx + w.minX, maxX: cx + w.maxX, minZ: cz + w.minZ, maxZ: cz + w.maxZ,
      });
    }
    // The workstation is built for the NE quadrant and rotated 90°·q into place, so
    // its monitor always faces that quadrant's open diagonal (no mirrored text).
    const ws = makeWorkstation(stage, tabId, mats, slot.nc);
    const inner = new THREE.Group();
    inner.add(ws.group);
    ws.group.position.set(1.55, 0, -1.55);          // sit the desk in the NE quadrant
    ws.group.rotation.y = 3 * Math.PI / 4;          // monitor faces the open NE diagonal
    inner.rotation.y = q * (Math.PI / 2);
    g.add(inner);
    // Solid working area: the desk/chair/monitor are rotated, so axis-aligned colliders
    // come from each piece's world AABB. roomsGroup is untransformed, so once g's world
    // matrix is updated, a piece's matrixWorld == its final scene-space transform.
    g.updateMatrixWorld(true);
    const box = new THREE.Box3(), pt = new THREE.Vector3();
    for (const c of ws.collide) {
      if (c.nx) {
        // Mesh: tile its local XZ footprint into nx×nz cells, each transformed to a
        // small world AABB → a tight hug of the rotated piece (vs one bloated box).
        c.obj.geometry.computeBoundingBox();
        const bb = c.obj.geometry.boundingBox;
        const w = bb.max.x - bb.min.x, d = bb.max.z - bb.min.z;
        for (let i = 0; i < c.nx; i++) for (let j = 0; j < c.nz; j++) {
          box.makeEmpty();
          for (const a of [i, i + 1]) for (const b of [j, j + 1]) {
            pt.set(bb.min.x + w * a / c.nx, bb.max.y, bb.min.z + d * b / c.nz).applyMatrix4(c.obj.matrixWorld);
            box.expandByPoint(pt);
          }
          walls.push({ minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z });
        }
      } else {
        box.setFromObject(c.obj);                    // compact group (monitor) → single AABB
        if (!box.isEmpty()) walls.push({ minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z });
      }
    }
    if (ws.screen) paintStandby(ws.screen);
    return { group: g, led: ws.status, walls, screen: ws.screen };
  },

  paintStatus(st, status) {
    if (st.ledMat) st.ledMat.color.set(styleFor(status).fg);   // monitor LED = status colour
    if (st.poster) paintPoster(st.poster, status);
  },

  animate(S, dt) {
    const a = S.claude;                             // rise the water-cooler bubbles
    if (a && a.bubbles) for (const b of a.bubbles) {
      b.position.y += dt * 0.35;
      if (b.position.y > 1.45) b.position.y = 1.08;
    }
  },

  // Optional CI/CD prop: a drink vending machine. Build/Dev/Prod buttons (LED = live
  // build status, click to trigger), and each build drops in as a coloured can — a
  // pile of history on the floor, a fresh can dispensed when a build finishes. Fed
  // the resolved TeamCity targets by the engine; renders nothing for other worlds.
  makeCicd(mats) {   // eslint-disable-line no-unused-vars
    const g = new THREE.Group();
    g.position.set(-ROOM_HALF + 0.7, 0, ROOM_HALF - 6);
    g.rotation.y = Math.PI / 2;                     // front faces +X, into the room

    const body = new THREE.Mesh(new THREE.BoxGeometry(1.1, 2.0, 0.75),
      new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.5, metalness: 0.2 }));
    body.position.set(0, 1.0, 0); g.add(body);
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(1.08, 1.96),
      new THREE.MeshStandardMaterial({ map: makeCicdPanel(), roughness: 0.6 }));
    panel.position.set(0, 1.0, 0.376); g.add(panel);

    const COLOR = { ok: 0x4caf72, bad: 0xff6b6b, run: 0x6c9ae7, queue: 0xd9b144, none: 0x565961 };
    // Rectangular colour buttons that drop into the white bezels (soda-machine style).
    const ROWS_Y = [1.195, 0.844, 0.492], BX = 0.365, BZ = 0.40;
    const buttons = [], btnByKey = {};
    CICD_KEYS.forEach((key, i) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.075, 0.022),
        new THREE.MeshStandardMaterial({ color: COLOR.none, roughness: 0.4 }));
      m.position.set(BX, ROWS_Y[i], BZ);
      g.add(m); buttons.push({ mesh: m, key }); btnByKey[key] = m;
    });
    // Dispensing tray at the bottom of the main branded panel (cans pop out here).
    const tray = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.26, 0.09),
      new THREE.MeshStandardMaterial({ color: 0x0c0d10, roughness: 0.9 }));
    tray.position.set(-0.165, 0.36, 0.35); g.add(tray);
    const TRAY = { x: -0.165, y: 0.40 };

    const cx = g.position.x, cz = g.position.z;
    const walls = [{ minX: cx - 0.4, maxX: cx + 0.4, minZ: cz - 0.58, maxZ: cz + 0.58 }];

    // Each build is a can in the floor pile (positions are random per session). A can
    // is a coloured label body + shiny aluminium neck-taper, lid, and base ring.
    const CAN_R = 0.058, CAN_H = 0.13;
    const _bodyGeo = new THREE.CylinderGeometry(CAN_R, CAN_R, CAN_H, 18);
    const _neckGeo = new THREE.CylinderGeometry(CAN_R * 0.8, CAN_R, 0.022, 18);   // taper to the lid
    const _lidGeo = new THREE.CylinderGeometry(CAN_R * 0.8, CAN_R * 0.8, 0.006, 18);
    const _baseGeo = new THREE.CylinderGeometry(CAN_R, CAN_R * 0.86, 0.014, 18);  // base rim
    const _alu = new THREE.MeshStandardMaterial({ color: 0xd8dade, metalness: 0.9, roughness: 0.32 });
    const cans = [];
    const SK = (b) => !b ? "none"
      : b.state === "running" ? "run" : b.state === "queued" ? "queue"
      : b.status === "SUCCESS" ? "ok" : b.status === "FAILURE" ? "bad" : "none";
    // Lightweight physics: cans fall, bounce, and shove each other so they never
    // intersect. Each is a body { mesh, vx, vy, vz, asleep }; a settled can sleeps
    // until something knocks it. CAN_COLR is the floor-plane radius (cans rest
    // ~2·CAN_COLR apart); BND keeps the pile in front of the machine.
    const CAN_COLR = 0.072;
    const BND = { x0: TRAY.x - 0.42, x1: TRAY.x + 0.42, z0: 0.44, z1: 1.55 };
    const freeSpot = () => {                          // a non-overlapping resting spot (seeded history)
      for (let t = 0; t < 40; t++) {
        const px = TRAY.x + (Math.random() - 0.5) * 0.72, pz = 0.55 + Math.random() * 0.85;
        if (!cans.some((c) => { const dx = c.mesh.position.x - px, dz = c.mesh.position.z - pz; return dx * dx + dz * dz < (2 * CAN_COLR) ** 2; }))
          return { x: px, z: pz };
      }
      return { x: TRAY.x + (Math.random() - 0.5) * 0.72, z: 0.55 + Math.random() * 0.85 };
    };
    const makeCan = (sk, dispensed) => {
      if (cans.length > 26) { const old = cans.shift(); g.remove(old.mesh); }
      const grp = new THREE.Group();
      const bodyMat = new THREE.MeshStandardMaterial({ color: COLOR[sk] || COLOR.none, metalness: 0.35, roughness: 0.35 });
      grp.add(new THREE.Mesh(_bodyGeo, bodyMat));                      // coloured label
      const neck = new THREE.Mesh(_neckGeo, _alu); neck.position.y = CAN_H / 2 + 0.011; grp.add(neck);
      const lid = new THREE.Mesh(_lidGeo, _alu); lid.position.y = CAN_H / 2 + 0.025; grp.add(lid);
      const base = new THREE.Mesh(_baseGeo, _alu); base.position.y = -CAN_H / 2 - 0.007; grp.add(base);
      grp.userData.bodyMat = bodyMat;                                  // recoloured when the build ends
      grp.rotation.set(Math.PI / 2, 0, Math.random() * Math.PI);       // lying down, random roll
      let can;
      if (dispensed) {                                                 // pops from the tray with an arc
        grp.position.set(TRAY.x, TRAY.y, 0.44);
        can = { mesh: grp, vx: (Math.random() - 0.5) * 0.3, vy: 0.5, vz: 0.9 + Math.random() * 0.4, asleep: false };
      } else {                                                         // seeded history — settled, non-overlapping
        const s = freeSpot();
        grp.position.set(s.x, CAN_R, s.z);
        can = { mesh: grp, vx: 0, vy: 0, vz: 0, asleep: true };
      }
      g.add(grp);
      cans.push(can);
      return grp;
    };

    let seeded = false;
    const curId = {};      // key -> build id already represented by a can
    const active = {};     // key -> { can, id } the in-flight (running) can, recoloured on finish
    return {
      group: g, buttons, walls,
      update({ targets, recent }) {
        for (const t of (targets || [])) {          // button LED = live status
          const m = btnByKey[t.key]; if (!m) continue;
          const sk = SK(t.status);
          m.material.color.setHex(COLOR[sk] || COLOR.none);
          m.material.emissive.setHex(sk === "none" ? 0x000000 : (COLOR[sk] || 0x000000));
          m.material.emissiveIntensity = sk === "none" ? 0 : 0.55;
        }
        if (!seeded) {                               // first pass: seed history, note current builds
          seeded = true;
          for (const b of (recent || []).slice(0, 18)) makeCan(SK(b), false);   // settled history pile
          for (const t of (targets || [])) if (t.status) curId[t.key] = t.status.id;
          return;
        }
        for (const t of (targets || [])) {
          const b = t.status; if (!b) continue;
          const sk = SK(b), id = b.id;
          const tr = active[t.key];
          if (tr && tr.id === id) {                   // the can we popped for this build:
            tr.can.userData.bodyMat.color.setHex(COLOR[sk] || COLOR.none);   // keep its colour in sync (run → finished)
            if (sk !== "run" && sk !== "queue") active[t.key] = null; // settled → stop tracking
          } else if (sk === "run") {                  // ENTERED running → pop a can from the slot
            if (curId[t.key] !== id) { active[t.key] = { can: makeCan("run", true), id }; curId[t.key] = id; }
          } else if ((sk === "ok" || sk === "bad") && curId[t.key] !== id) {
            makeCan(sk, true); curId[t.key] = id;     // finished so fast we never saw it run → drop one now
          }
        }
      },
      animate(dt) {
        const h = Math.min(dt, 0.033);                // clamp the step for stability
        const G = -3.4, FLOOR = CAN_R, REST = 0.36, GF = 0.8;
        // Integrate gravity, bounce off the floor, reflect at the pile bounds.
        for (const c of cans) {
          if (c.asleep) continue;
          c.vy += G * h;
          const p = c.mesh.position;
          p.x += c.vx * h; p.y += c.vy * h; p.z += c.vz * h;
          if (p.y < FLOOR) { p.y = FLOOR; if (c.vy < 0) c.vy = -c.vy * REST; c.vx *= GF; c.vz *= GF; }
          if (p.x < BND.x0) { p.x = BND.x0; c.vx = Math.abs(c.vx) * 0.4; }
          if (p.x > BND.x1) { p.x = BND.x1; c.vx = -Math.abs(c.vx) * 0.4; }
          if (p.z < BND.z0) { p.z = BND.z0; c.vz = Math.abs(c.vz) * 0.4; }
          if (p.z > BND.z1) { p.z = BND.z1; c.vz = -Math.abs(c.vz) * 0.4; }
        }
        // Can-can collisions (XZ plane): separate any overlap and knock the other
        // can along the contact normal. A couple of relaxation passes for stability.
        const minD = CAN_COLR * 2;
        for (let it = 0; it < 2; it++) {
          for (let i = 0; i < cans.length; i++) {
            for (let j = i + 1; j < cans.length; j++) {
              const ci = cans[i], cj = cans[j], a = ci.mesh.position, b = cj.mesh.position;
              const dx = b.x - a.x, dz = b.z - a.z, d2 = dx * dx + dz * dz;
              if (d2 >= minD * minD) continue;
              const d = Math.sqrt(d2) || 1e-4, nx = dx / d, nz = dz / d, ov = (minD - d) * 0.5;
              a.x -= nx * ov; a.z -= nz * ov; b.x += nx * ov; b.z += nz * ov;   // separate
              const rvn = (cj.vx - ci.vx) * nx + (cj.vz - ci.vz) * nz;          // approaching speed
              if (rvn < 0) {                                                     // knock
                const imp = -rvn * 0.5;
                ci.vx -= nx * imp; ci.vz -= nz * imp; cj.vx += nx * imp; cj.vz += nz * imp;
                ci.asleep = false; cj.asleep = false;
              }
            }
          }
        }
        // Put nearly-stationary grounded cans to sleep (cheap + stable pile).
        for (const c of cans) {
          if (c.asleep) continue;
          if (c.vx * c.vx + c.vy * c.vy + c.vz * c.vz < 0.0004 && c.mesh.position.y <= FLOOR + 0.003) {
            c.vx = c.vy = c.vz = 0; c.asleep = true;
          }
        }
      },
    };
  },
};

export default office;
