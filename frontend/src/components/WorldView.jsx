import React, { useRef, useEffect, useState, useCallback } from "react";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { readNodeScreen, sendTerminalInput, scrollNodeTerminal } from "../terminalController.js";

// Paint a node terminal's styled rows onto a room screen's canvas. Each row is a
// list of {t, fg, bg, bold} spans (from readNodeScreen) carrying real terminal
// colour. When `active` (the screen being typed into) a blinking block cursor is
// drawn at the terminal's reported cursor cell.
const SCREEN_FONT = "12px ui-monospace, Menlo, monospace";
const ROWH = 15, PADX = 8, PADY = 8, DEFAULT_FG = "#cdd6d0";
function paintScreen(screen, data, active) {
  const { ctx, canvas } = screen;
  ctx.fillStyle = "#07140d";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = SCREEN_FONT;
  const charW = screen._charW || (screen._charW = ctx.measureText("M").width);
  const rows = data?.rows || [];
  for (let y = 0; y < rows.length; y++) {
    const spans = rows[y];
    if (!spans || !spans.length) continue;
    const ry = PADY + y * ROWH;
    let col = 0;
    for (let s = 0; s < spans.length; s++) {
      const sp = spans[s];
      const x = PADX + col * charW, wpx = sp.t.length * charW;
      if (sp.bg) { ctx.fillStyle = sp.bg; ctx.fillRect(x, ry, wpx, ROWH); }
      ctx.font = sp.bold ? "bold " + SCREEN_FONT : SCREEN_FONT;
      ctx.fillStyle = sp.fg || DEFAULT_FG;
      ctx.fillText(sp.t, x, ry);
      col += sp.t.length;
    }
  }
  if (active && Number.isInteger(data?.cursorY) && Math.floor(performance.now() / 500) % 2 === 0) {
    ctx.fillStyle = "#9effb0";
    ctx.fillRect(PADX + data.cursorX * charW, PADY + data.cursorY * ROWH, charW, 14);
  }
  screen.tex.needsUpdate = true;
}

// Standby screen shown before a node has produced any output (or for rooms whose
// terminal hasn't started yet) — the room's TV reads "awaiting start" rather than
// being blank/hidden.
function paintStandby(screen) {
  const { ctx, canvas } = screen;
  const cx = canvas.width / 2, cy = canvas.height / 2;
  ctx.fillStyle = "#07140d";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillStyle = "#3f7d55";
  ctx.font = "600 22px ui-monospace, Menlo, monospace";
  ctx.fillText((screen.label || "node").toUpperCase().slice(0, 28), cx, cy - 16);
  ctx.fillStyle = "#9effb0";
  ctx.font = "500 15px ui-monospace, Menlo, monospace";
  ctx.fillText("● awaiting start…", cx, cy + 16);
  screen.tex.needsUpdate = true;
}

// Translate a keydown into the bytes a PTY expects (printables, controls, arrows).
// Returns null for keys we don't handle (so the browser keeps its default).
function keyEventToBytes(e) {
  if (e.metaKey) return null;                 // leave Cmd-shortcuts to the browser
  const k = e.key;
  if (e.ctrlKey) {
    if (k.length === 1 && /[a-z]/i.test(k)) return String.fromCharCode(k.toLowerCase().charCodeAt(0) - 96);
    if (k === "[") return "\x1b";
    return null;
  }
  switch (k) {
    case "Enter": return "\r";
    case "Backspace": return "\x7f";
    case "Tab": return "\t";
    case "Escape": return "\x1b";
    case "ArrowUp": return "\x1b[A";
    case "ArrowDown": return "\x1b[B";
    case "ArrowRight": return "\x1b[C";
    case "ArrowLeft": return "\x1b[D";
    case "Home": return "\x1b[H";
    case "End": return "\x1b[F";
    case "Delete": return "\x1b[3~";
    case "PageUp": return "\x1b[5~";
    case "PageDown": return "\x1b[6~";
    default: return k.length === 1 ? k : null;  // printable single chars
  }
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
const D = 10;            // hub-to-room distance — wide enough that the diagonal corner
                         // lanes (√2·|D−8| ≈ 2.8) stay open to walk out to the island
const EYE = 1.6;         // camera/eye height

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

const STATUS_STYLE = {
  pending: { bg: "#2a2a33", fg: "#bcbcc8" },
  running: { bg: "#15315c", fg: "#6fb6ff" },
  waiting: { bg: "#5a4a10", fg: "#f7c948" },
  finished: { bg: "#143b22", fg: "#5ec98b" },
  error: { bg: "#4a1616", fg: "#ff8a80" },
};
const styleFor = (s) => STATUS_STYLE[s] || STATUS_STYLE.pending;

function makeLed(label, status) {
  const canvas = document.createElement("canvas");
  canvas.width = 512; canvas.height = 128;   // hi-res so glyphs get enough dots
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 8;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(DOOR_W, DOOR_W * (canvas.height / canvas.width)),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true }),
  );
  const led = { canvas, ctx: canvas.getContext("2d"), tex, mesh, label, scroll: 0 };
  paintLed(led, status);
  return led;
}
// LED dot-matrix sign: render the label + status to an offscreen buffer, then
// sample it on a fixed grid and draw each cell as a dot — lit (status colour +
// glow) where text covers it, dim where it doesn't, so the matrix stays visible.
// 5×7 dot-matrix font (uppercase + digits + a little punctuation). Each glyph is
// 7 rows of 5 bits, so strokes are exactly one dot wide and grid-aligned — the
// classic LED-sign look. Unknown chars fall back to "?".
const FONT5x7 = {
  "A": ["01110","10001","10001","11111","10001","10001","10001"],
  "B": ["11110","10001","10001","11110","10001","10001","11110"],
  "C": ["01110","10001","10000","10000","10000","10001","01110"],
  "D": ["11110","10001","10001","10001","10001","10001","11110"],
  "E": ["11111","10000","10000","11110","10000","10000","11111"],
  "F": ["11111","10000","10000","11110","10000","10000","10000"],
  "G": ["01110","10001","10000","10111","10001","10001","01111"],
  "H": ["10001","10001","10001","11111","10001","10001","10001"],
  "I": ["11111","00100","00100","00100","00100","00100","11111"],
  "J": ["00111","00010","00010","00010","00010","10010","01100"],
  "K": ["10001","10010","10100","11000","10100","10010","10001"],
  "L": ["10000","10000","10000","10000","10000","10000","11111"],
  "M": ["10001","11011","10101","10101","10001","10001","10001"],
  "N": ["10001","10001","11001","10101","10011","10001","10001"],
  "O": ["01110","10001","10001","10001","10001","10001","01110"],
  "P": ["11110","10001","10001","11110","10000","10000","10000"],
  "Q": ["01110","10001","10001","10001","10101","10010","01101"],
  "R": ["11110","10001","10001","11110","10100","10010","10001"],
  "S": ["01111","10000","10000","01110","00001","00001","11110"],
  "T": ["11111","00100","00100","00100","00100","00100","00100"],
  "U": ["10001","10001","10001","10001","10001","10001","01110"],
  "V": ["10001","10001","10001","10001","10001","01010","00100"],
  "W": ["10001","10001","10001","10101","10101","11011","10001"],
  "X": ["10001","10001","01010","00100","01010","10001","10001"],
  "Y": ["10001","10001","01010","00100","00100","00100","00100"],
  "Z": ["11111","00001","00010","00100","01000","10000","11111"],
  "0": ["01110","10001","10011","10101","11001","10001","01110"],
  "1": ["00100","01100","00100","00100","00100","00100","01110"],
  "2": ["01110","10001","00001","00010","00100","01000","11111"],
  "3": ["11111","00010","00100","00010","00001","10001","01110"],
  "4": ["00010","00110","01010","10010","11111","00010","00010"],
  "5": ["11111","10000","11110","00001","00001","10001","01110"],
  "6": ["00110","01000","10000","11110","10001","10001","01110"],
  "7": ["11111","00001","00010","00100","01000","01000","01000"],
  "8": ["01110","10001","10001","01110","10001","10001","01110"],
  "9": ["01110","10001","10001","01111","00001","00010","01100"],
  " ": ["00000","00000","00000","00000","00000","00000","00000"],
  "-": ["00000","00000","00000","11111","00000","00000","00000"],
  ".": ["00000","00000","00000","00000","00000","00110","00110"],
  ":": ["00000","00110","00110","00000","00110","00110","00000"],
  "?": ["01110","10001","00001","00010","00100","00000","00100"],
};
const GLYPH_W = 5, GLYPH_H = 7, GLYPH_GAP = 1, GLYPH_UNIT = GLYPH_W + GLYPH_GAP;

// Draw a string of bitmap glyphs into the dot grid starting at column `startCol`
// (no centring), clipping anything outside the grid.
function drawGlyphs(grid, cols, s, startCol, rowTop) {
  for (let i = 0; i < s.length; i++) {
    const base = startCol + i * GLYPH_UNIT;
    if (base >= cols || base + GLYPH_W < 0) continue;   // glyph fully off-panel
    const glyph = FONT5x7[s[i]] || FONT5x7["?"];
    for (let r = 0; r < GLYPH_H; r++) {
      for (let c = 0; c < GLYPH_W; c++) {
        if (glyph[r][c] === "1") {
          const gc = base + c;
          if (gc >= 0 && gc < cols) grid[(rowTop + r) * cols + gc] = 1;
        }
      }
    }
  }
}
function stampCentered(grid, cols, str, rowTop) {
  const s = (str || "").toUpperCase();
  const w = s.length * GLYPH_UNIT - GLYPH_GAP;
  drawGlyphs(grid, cols, s, Math.floor((cols - w) / 2), rowTop);
}
// Continuously scrolling text: repeats the string (with a gap) across the panel,
// shifted left by `offset` dot-columns, so it loops seamlessly.
function stampScroll(grid, cols, str, rowTop, offset) {
  const s = (str || "").toUpperCase();
  const period = s.length * GLYPH_UNIT + 6;            // +6 blank cols between loops
  let start = -(((offset % period) + period) % period);
  while (start < cols) { drawGlyphs(grid, cols, s, start, rowTop); start += period; }
}

const LED_DOT = 6, LED_SCROLL = 9;                      // dot spacing; scroll cols/sec
function paintLed(led, status) {
  led.status = status;
  const { ctx, canvas } = led;
  const { fg } = styleFor(status);
  const W = canvas.width, H = canvas.height;
  const cols = Math.floor(W / LED_DOT), rows = Math.floor(H / LED_DOT);
  const maxChars = Math.floor((cols + GLYPH_GAP) / GLYPH_UNIT);

  // Build the lit grid from the bitmap font: label up top (marquee if it's too
  // long to fit), status centred below.
  const grid = new Uint8Array(cols * rows);
  const label = (led.label || "").toUpperCase();
  led._needsScroll = label.length > maxChars;
  if (led._needsScroll) stampScroll(grid, cols, label, 2, Math.floor(led.scroll || 0));
  else stampCentered(grid, cols, label, 2);
  stampCentered(grid, cols, (status || "pending"), 12);

  ctx.fillStyle = "#08090b";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(255,255,255,0.07)"; ctx.lineWidth = 2;
  ctx.strokeRect(2, 2, W - 4, H - 4);

  const off = LED_DOT / 2;
  ctx.shadowColor = fg;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const lit = grid[r * cols + c];
      ctx.beginPath();
      ctx.arc(c * LED_DOT + off, r * LED_DOT + off, lit ? 2.0 : 1.0, 0, Math.PI * 2);
      if (lit) { ctx.fillStyle = fg; ctx.shadowBlur = 3; }
      else { ctx.fillStyle = "rgba(150,160,180,0.06)"; ctx.shadowBlur = 0; }
      ctx.fill();
    }
  }
  ctx.shadowBlur = 0;
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

// A little 3D Claude mascot: a soft terracotta rounded-box body with ear nubs,
// two black eyes on the front (+Z) face, and four stubby legs on hip pivots so
// they can swing as it walks. Returns { group, legs } for the walk animation.
function makeClaude() {
  const g = new THREE.Group();
  const clay = new THREE.MeshStandardMaterial({ color: 0xcc785c, roughness: 0.65 });
  const black = new THREE.MeshStandardMaterial({ color: 0x1a1513, roughness: 0.5 });

  const body = new THREE.Mesh(new RoundedBoxGeometry(1.3, 1.15, 0.92, 5, 0.26), clay);
  body.position.y = 0.95; g.add(body);
  for (const s of [-1, 1]) {                          // ear nubs on the top corners
    const ear = new THREE.Mesh(new RoundedBoxGeometry(0.26, 0.3, 0.26, 4, 0.1), clay);
    ear.position.set(s * 0.52, 1.5, 0); g.add(ear);
  }
  for (const s of [-1, 1]) {                          // eyes on the front face
    const eye = new THREE.Mesh(new RoundedBoxGeometry(0.17, 0.3, 0.08, 4, 0.06), black);
    eye.position.set(s * 0.28, 1.02, 0.47); g.add(eye);
  }
  const legGeo = new RoundedBoxGeometry(0.2, 0.42, 0.22, 4, 0.08);
  const legs = [];                                    // [front-L, front-R, back-L, back-R]
  for (const z of [0.26, -0.26]) for (const x of [-0.36, 0.36]) {
    const pivot = new THREE.Group();                  // hip pivot so the leg swings from the top
    pivot.position.set(x, 0.5, z);
    const leg = new THREE.Mesh(legGeo, clay);
    leg.position.y = -0.2;
    pivot.add(leg); g.add(pivot); legs.push(pivot);
  }
  return { group: g, legs };
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

export default function WorldView({ stages, workspaceId, onPortal, spawn }) {
  const hostRef = useRef(null);
  const stagesRef = useRef(stages);
  stagesRef.current = stages;
  const wsRef = useRef(workspaceId);
  wsRef.current = workspaceId;
  const S = useRef({});
  // Portal: walking into a cavern tree calls onPortal(role); a spawn signal
  // ({tree, seq}) drops the camera at that tree's doorway (handled in the loop).
  const portalRef = useRef(onPortal);
  portalRef.current = onPortal;
  useEffect(() => { if (spawn && spawn.seq != null) S.current.pendingSpawn = spawn; }, [spawn && spawn.seq]);
  // Which screen (tab id) keystrokes route to, or null = walk mode. The ref drives
  // the render loop / key handlers; the state drives the banner UI.
  const typingRef = useRef(null);
  const [typing, setTyping] = useState(null);
  const crossRef = useRef(null);
  const exitTyping = useCallback(() => { typingRef.current = null; setTyping(null); }, []);

  // ── scene + render loop (set up once) ───────────────────────────────────
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = makeSkyTexture();
    scene.fog = new THREE.Fog(0xcfe9f5, 70, 280);   // bright cyan haze to the horizon

    const camera = new THREE.PerspectiveCamera(72, 1, 0.1, 600);
    camera.position.set(0, EYE, 0);

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
    S.current.claude = claude;

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
    S.current.treeWalls = treeWalls;
    S.current.trees = trees;

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

    Object.assign(S.current, { renderer, scene, camera, roomsGroup, wallMat, roofMat, floorMat, water, composer, rooms: new Map(), sig: "" });

    // ── manual first-person controls ──────────────────────────────────────
    let yaw = 0, pitch = 0, locked = false;
    const keys = {};
    const canvas = renderer.domElement;
    const raycaster = new THREE.Raycaster();
    const CENTER = new THREE.Vector2(0, 0);

    // Enter typing on whatever screen the crosshair is currently aimed at. The
    // aim is computed each frame in the loop (and lights the crosshair), so the
    // click/E handlers just consume the latest result.
    const tryEnterFromCenter = () => { if (S.current.aimTabId) enterTyping(S.current.aimTabId); };
    const enterTyping = (tabId) => {
      if (!tabId) return;
      typingRef.current = tabId;
      Object.keys(keys).forEach((k) => (keys[k] = false));   // drop any held movement key
      if (document.pointerLockElement === canvas) document.exitPointerLock();
      const stage = stagesRef.current.find((s) => `${wsRef.current}::node-${s.id}` === tabId);
      setTyping({ tabId, label: stage?.label || "terminal" });
    };

    const onKeyDown = (e) => {
      if (typingRef.current) {
        if (e.key === "Escape" && e.shiftKey) { e.preventDefault(); exitTyping(); return; }
        const bytes = keyEventToBytes(e);
        if (bytes != null) { e.preventDefault(); sendTerminalInput(typingRef.current, bytes); }
        return;   // never feed movement keys while typing
      }
      keys[e.code] = true;
      if (e.code === "KeyE" && locked) tryEnterFromCenter();
    };
    const onKeyUp = (e) => { keys[e.code] = false; };
    const onMouseMove = (e) => {
      if (!locked) return;
      yaw -= e.movementX * 0.0022;
      pitch -= e.movementY * 0.0022;
      pitch = Math.max(-1.3, Math.min(1.3, pitch));
    };
    const onClick = () => {
      if (typingRef.current) return;                  // exit is via the bar / Shift-Esc
      if (document.pointerLockElement === canvas) { tryEnterFromCenter(); return; }
      canvas.requestPointerLock();
    };
    // Typing mode: forward the raw wheel delta to the live node terminal's native
    // scroll DOM, so its scrollback moves and WorldView mirrors the new position.
    const onWheel = (e) => {
      if (!typingRef.current) return;
      e.preventDefault();
      scrollNodeTerminal(typingRef.current, e.deltaY);
    };
    const onLockChange = () => { locked = document.pointerLockElement === canvas; };
    canvas.addEventListener("click", onClick);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    document.addEventListener("pointerlockchange", onLockChange);
    document.addEventListener("mousemove", onMouseMove);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    const clock = new THREE.Clock();
    let raf = 0, lastScreen = 0, lastLed = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(clock.getDelta(), 0.05);
      // Paused whenever hidden at ANY level (the world toggle, or the workspace
      // panel's display:none) — detected via zero host size. The component stays
      // mounted so the camera position persists; we just don't render nothing.
      if (!host.clientWidth || !host.clientHeight) {
        if (document.pointerLockElement === canvas) document.exitPointerLock();
        if (typingRef.current) exitTyping();   // don't keep capturing keys while hidden
        return;
      }
      const speed = 5 * dt;
      const typing = !!typingRef.current;

      // Portal spawn: a new {tree, seq} drops the camera at that tree's doorway.
      const nowMs = performance.now();
      const ps = S.current.pendingSpawn;
      if (ps && ps.seq !== S.current.spawnApplied) {
        S.current.spawnApplied = ps.seq;
        const tt = (S.current.trees || []).find((t) => t.role === ps.tree);
        if (tt) { camera.position.set(tt.sx, EYE, tt.sz); yaw = tt.syaw; pitch = 0; S.current.portalCd = nowMs + 900; }
      }

      // Aim assist: while walking + locked, raycast the crosshair against the live
      // screens and remember the hit (also lights the crosshair). Range covers a
      // full room depth so you can trigger from the doorway, not just point-blank.
      let aimTabId = null;
      if (!typing && locked) {
        raycaster.setFromCamera(CENTER, camera);
        const ms = (S.current.screens || []).filter((s) => s.mesh.visible).map((s) => s.mesh);
        const hits = ms.length ? raycaster.intersectObjects(ms, false) : [];
        if (hits.length && hits[0].distance < 12) aimTabId = hits[0].object.userData.screenTabId;
      }
      S.current.aimTabId = aimTabId;
      if (crossRef.current) crossRef.current.classList.toggle("aim", !!aimTabId);

      const f = typing ? 0 : (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
      const r = typing ? 0 : (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
      if (f || r) {
        const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
        const rx = Math.cos(yaw), rz = -Math.sin(yaw);
        const dx = (fx * f + rx * r) * speed;
        const dz = (fz * f + rz * r) * speed;
        // Per-axis collision so you slide along walls; door gaps have no box.
        const R = 0.35, walls = (S.current.walls || []).concat(S.current.treeWalls || []);
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

      // Portal entry: stepping inside a cavern tree navigates to another running
      // workspace (next/prev). Cooldown avoids re-firing on the arrival spawn.
      if (nowMs > (S.current.portalCd || 0) && portalRef.current) {
        for (const tt of (S.current.trees || [])) {
          const ex = camera.position.x - tt.x, ez = camera.position.z - tt.z;
          if (ex * ex + ez * ez < 1.21) {     // inside the trunk (~1.1 radius)
            S.current.portalCd = nowMs + 900;
            portalRef.current(tt.role);
            break;
          }
        }
      }

      // Mirror live terminals onto room screens (throttled). Reveal the TV only
      // when a terminal exists at that tab id; hide it otherwise.
      const now = performance.now();
      // Advance marquee labels (only those that overflow) at ~16fps.
      if (now - lastLed > 60) {
        const elapsed = Math.min((now - lastLed) / 1000, 0.1);   // clamp after a pause
        lastLed = now;
        const rooms = S.current.rooms;
        if (rooms) rooms.forEach((led) => {
          if (led._needsScroll) { led.scroll += elapsed * LED_SCROLL; paintLed(led, led.status); }
        });
      }
      if (now - lastScreen > (typing ? 45 : 140)) {   // snappier while typing
        lastScreen = now;
        const screens = S.current.screens || [];
        for (let i = 0; i < screens.length; i++) {
          const s = screens[i];
          const data = readNodeScreen(s.tabId);
          if (data) { s._standby = false; paintScreen(s, data, s.tabId === typingRef.current); }
          else if (!s._standby) { s._standby = true; paintStandby(s); }
        }
      }

      if (S.current.water) {                 // drift the sea
        S.current.water.offset.x += dt * 0.03;
        S.current.water.offset.y += dt * 0.02;
      }
      const cl = S.current.claude;           // walk Claude around the shoreline
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
      const comp = S.current.composer;
      if (comp) comp.render(); else renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(loop);

    const resize = () => {
      const w = host.clientWidth, h = host.clientHeight;
      if (!w || !h) return;   // hidden — keep last size, avoid a NaN aspect
      renderer.setSize(w, h, false);
      if (S.current.composer) S.current.composer.setSize(w, h);
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
      canvas.removeEventListener("wheel", onWheel);
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
        const { group, led, walls, screen } = buildRoom(stage, slotFor(i), st.wallMat, st.roofMat, st.floorMat, tabId);
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
    <div className={`world-view${typing ? " typing" : ""}`}>
      <div className="world-host" ref={hostRef} />
      {!typing && <div className="world-crosshair" ref={crossRef} />}
      {typing ? (
        <div className="world-typing-bar">
          <span className="dot" />
          <span className="wt-label">Typing…</span>
          <button onClick={exitTyping}>✕ Shift-Esc</button>
        </div>
      ) : (
        <div className="world-hint">click to look · WASD move · aim a screen + click (or E) to type · Esc release</div>
      )}
    </div>
  );
}
