import React, { useRef, useEffect } from "react";
import * as THREE from "three";
import { readNodeScreen } from "../terminalController.js";

// Paint a node terminal's rows onto a room screen's canvas (monospace, CRT-green).
function paintScreen(screen, data) {
  const { ctx, canvas } = screen;
  ctx.fillStyle = "#07140d";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = "12px ui-monospace, Menlo, monospace";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#9effb0";
  const rows = data?.rows || [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]) ctx.fillText(rows[i].slice(0, 96), 8, 8 + i * 15);
  }
  screen.tex.needsUpdate = true;
}

/**
 * Experimental first-person 3D view of a pipeline. Each top-level stage becomes a
 * simple box room around a central hub, with a door facing the hub and an LED
 * panel above it showing the stage's live status. Walk with WASD; click to capture
 * the mouse for look (Esc releases). Purely visual for now — no collision, no
 * interaction. Deliberately simple geometry.
 */
const ROOM = 8;          // room inner size
const WALL_H = 3.2;      // wall height
const WALL_T = 0.18;     // wall thickness
const DOOR_W = 2.4;      // door opening width
const DOOR_H = 2.4;      // door opening height
const D = 7;             // hub-to-room distance along an axis
const EYE = 1.6;         // camera/eye height

// Room slots around the hub, growing per the mock: W, E, N, S, then stacked.
// door = which local wall holds the door (faces the hub). +X=E, -X=W, -Z=N, +Z=S.
const SLOTS = [
  { x: -D, z: 0, door: "E" },
  { x: D, z: 0, door: "W" },
  { x: 0, z: -D, door: "S" },
  { x: 0, z: D, door: "N" },
  { x: -D, z: -ROOM, door: "E" },
  { x: D, z: -ROOM, door: "W" },
  { x: -D, z: ROOM, door: "E" },
  { x: D, z: ROOM, door: "W" },
  { x: 0, z: -D - ROOM, door: "S" },
  { x: 0, z: D + ROOM, door: "N" },
];
function slotFor(i) {
  if (i < SLOTS.length) return SLOTS[i];
  // fallback ring for overflow
  const a = (i * Math.PI * 2) / 12;
  return { x: Math.round(Math.cos(a) * (D + ROOM)), z: Math.round(Math.sin(a) * (D + ROOM)), door: "S" };
}

const STATUS_STYLE = {
  pending: { bg: "#2a2a33", fg: "#9a9aa3" },
  running: { bg: "#15315c", fg: "#6fb6ff" },
  waiting: { bg: "#5a4a10", fg: "#f7c948" },
  finished: { bg: "#143b22", fg: "#5ec98b" },
  error: { bg: "#4a1616", fg: "#ff8a80" },
};
const styleFor = (s) => STATUS_STYLE[s] || STATUS_STYLE.pending;

function makeLed(label, status) {
  const canvas = document.createElement("canvas");
  canvas.width = 256; canvas.height = 64;
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(DOOR_W, DOOR_W * (64 / 256)),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true }),
  );
  const led = { canvas, ctx: canvas.getContext("2d"), tex, mesh, label };
  paintLed(led, status);
  return led;
}
function paintLed(led, status) {
  const { ctx, canvas } = led;
  const { bg, fg } = styleFor(status);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = fg; ctx.lineWidth = 3;
  ctx.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
  ctx.fillStyle = fg;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.font = "600 13px ui-monospace, Menlo, monospace";
  ctx.fillText((led.label || "").slice(0, 26), canvas.width / 2, 18);
  ctx.font = "700 22px ui-monospace, Menlo, monospace";
  ctx.fillText((status || "pending").toUpperCase(), canvas.width / 2, 44);
  led.tex.needsUpdate = true;
}

function wallBox(w, d, x, z, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, WALL_H, d), mat);
  m.position.set(x, WALL_H / 2, z);
  return m;
}

// Procedural cloudy sky as an equirectangular background (no external asset):
// a blue gradient with soft white cloud blobs in the upper band.
function makeSkyTexture() {
  const w = 1024, h = 512;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "#3b6fa6");      // zenith
  grad.addColorStop(0.55, "#6f9fc8");
  grad.addColorStop(0.82, "#aecbe6");   // horizon haze
  grad.addColorStop(1, "#cfe0f0");
  g.fillStyle = grad; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 30; i++) {
    const cx = Math.random() * w, cy = h * 0.1 + Math.random() * h * 0.45;
    const r = 28 + Math.random() * 80;
    const rg = g.createRadialGradient(cx, cy, 0, cx, cy, r);
    rg.addColorStop(0, "rgba(255,255,255,0.9)");
    rg.addColorStop(0.5, "rgba(255,255,255,0.35)");
    rg.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = rg; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildRoom(stage, slot, mat, tabId) {
  const g = new THREE.Group();
  g.position.set(slot.x, 0, slot.z);
  const half = ROOM / 2;
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
    bezel.visible = false; mesh.visible = false;
    g.add(bezel); g.add(mesh);
    screen = { tabId, canvas: sc, ctx: sc.getContext("2d"), tex, mesh, bezel };
  }

  return { group: g, led, walls, screen };
}

export default function WorldView({ stages, workspaceId }) {
  const hostRef = useRef(null);
  const stagesRef = useRef(stages);
  stagesRef.current = stages;
  const wsRef = useRef(workspaceId);
  wsRef.current = workspaceId;
  const S = useRef({});

  // ── scene + render loop (set up once) ───────────────────────────────────
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = makeSkyTexture();
    scene.fog = new THREE.Fog(0xb6cde4, 36, 140);   // haze toward the sky colour

    const camera = new THREE.PerspectiveCamera(72, 1, 0.1, 400);
    camera.position.set(0, EYE, 0);

    scene.add(new THREE.HemisphereLight(0xdcebff, 0x4a4a55, 1.1));
    const dir = new THREE.DirectionalLight(0xfff4e0, 0.85);
    dir.position.set(8, 16, 6);
    scene.add(dir);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      new THREE.MeshStandardMaterial({ color: 0x3a3f4d, roughness: 1 }),
    );
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);
    const grid = new THREE.GridHelper(120, 60, 0x5a607a, 0x474c61);
    scene.add(grid);

    // Lighter walls so the rooms read clearly against the dark floor / bright sky.
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x9aa0b8, roughness: 0.85, metalness: 0.0 });
    const roomsGroup = new THREE.Group();
    scene.add(roomsGroup);

    Object.assign(S.current, { renderer, scene, camera, roomsGroup, wallMat, rooms: new Map(), sig: "" });

    // ── manual first-person controls ──────────────────────────────────────
    let yaw = 0, pitch = 0, locked = false;
    const keys = {};
    const onKeyDown = (e) => { keys[e.code] = true; };
    const onKeyUp = (e) => { keys[e.code] = false; };
    const onMouseMove = (e) => {
      if (!locked) return;
      yaw -= e.movementX * 0.0022;
      pitch -= e.movementY * 0.0022;
      pitch = Math.max(-1.3, Math.min(1.3, pitch));
    };
    const canvas = renderer.domElement;
    const onClick = () => canvas.requestPointerLock();
    const onLockChange = () => { locked = document.pointerLockElement === canvas; };
    canvas.addEventListener("click", onClick);
    document.addEventListener("pointerlockchange", onLockChange);
    document.addEventListener("mousemove", onMouseMove);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    const clock = new THREE.Clock();
    let raf = 0, lastScreen = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(clock.getDelta(), 0.05);
      // Paused whenever hidden at ANY level (the world toggle, or the workspace
      // panel's display:none) — detected via zero host size. The component stays
      // mounted so the camera position persists; we just don't render nothing.
      if (!host.clientWidth || !host.clientHeight) {
        if (document.pointerLockElement === canvas) document.exitPointerLock();
        return;
      }
      const speed = 5 * dt;
      const f = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
      const r = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
      if (f || r) {
        const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
        const rx = Math.cos(yaw), rz = -Math.sin(yaw);
        const dx = (fx * f + rx * r) * speed;
        const dz = (fz * f + rz * r) * speed;
        // Per-axis collision so you slide along walls; door gaps have no box.
        const R = 0.35, walls = S.current.walls || [];
        const hit = (px, pz) => {
          for (let i = 0; i < walls.length; i++) {
            const a = walls[i];
            if (px > a.minX - R && px < a.maxX + R && pz > a.minZ - R && pz < a.maxZ + R) return true;
          }
          return false;
        };
        if (!hit(camera.position.x + dx, camera.position.z)) camera.position.x += dx;
        if (!hit(camera.position.x, camera.position.z + dz)) camera.position.z += dz;
      }
      camera.position.y = EYE;
      camera.rotation.set(pitch, yaw, 0, "YXZ");

      // Mirror live terminals onto room screens (throttled). Reveal the TV only
      // when a terminal exists at that tab id; hide it otherwise.
      const now = performance.now();
      if (now - lastScreen > 140) {
        lastScreen = now;
        const screens = S.current.screens || [];
        for (let i = 0; i < screens.length; i++) {
          const s = screens[i];
          const data = readNodeScreen(s.tabId);
          const on = !!data;
          s.mesh.visible = on; s.bezel.visible = on;
          if (on) paintScreen(s, data);
        }
      }

      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(loop);

    const resize = () => {
      const w = host.clientWidth, h = host.clientHeight;
      if (!w || !h) return;   // hidden — keep last size, avoid a NaN aspect
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("click", onClick);
      document.removeEventListener("pointerlockchange", onLockChange);
      document.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      if (document.pointerLockElement === canvas) document.exitPointerLock();
      renderer.dispose();
      host.removeChild(canvas);
    };
  }, []);

  // ── rebuild rooms when the stage set changes; repaint LEDs on status change ──
  useEffect(() => {
    const st = S.current;
    if (!st.scene) return;
    const sig = stages.map((s) => s.id).join("|");
    if (sig !== st.sig) {
      st.sig = sig;
      st.roomsGroup.clear();
      st.rooms = new Map();
      st.walls = [];
      st.screens = [];
      stages.forEach((stage, i) => {
        const tabId = wsRef.current ? `${wsRef.current}::node-${stage.id}` : null;
        const { group, led, walls, screen } = buildRoom(stage, slotFor(i), st.wallMat, tabId);
        st.roomsGroup.add(group);
        st.rooms.set(stage.id, led);
        st.walls.push(...walls);
        if (screen) st.screens.push(screen);
      });
    }
    stages.forEach((stage) => {
      const led = st.rooms.get(stage.id);
      if (led) paintLed(led, stage.status);
    });
  }, [stages]);

  return (
    <div className="world-view">
      <div className="world-host" ref={hostRef} />
      <div className="world-crosshair" />
      <div className="world-hint">click to look · WASD to move · Esc to release</div>
    </div>
  );
}
