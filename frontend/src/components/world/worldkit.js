import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

// Shared, theme-agnostic helpers for the 3D world: terminal-screen painting,
// keyboard→PTY byte translation, the LED dot-matrix sign kit, wall geometry, and
// the eye height. Themes and the core engine import from here.

// Paint a node terminal's styled rows onto a room screen's canvas. Each row is a
// list of {t, fg, bg, bold} spans (from readNodeScreen) carrying real terminal
// colour. When `active` (the screen being typed into) a blinking block cursor is
// drawn at the terminal's reported cursor cell.
export const SCREEN_FONT = "12px ui-monospace, Menlo, monospace";
export const ROWH = 15, PADX = 8, PADY = 8, DEFAULT_FG = "#cdd6d0";
export function paintScreen(screen, data, active) {
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
export function paintStandby(screen) {
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
export function keyEventToBytes(e) {
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

const EYE = 1.6;         // camera/eye height
export { EYE };

// Wall/door geometry shared by themes that build box rooms.
const WALL_H = 3.2;      // wall height
const DOOR_W = 2.4;      // door opening width

export const STATUS_STYLE = {
  pending: { bg: "#2a2a33", fg: "#bcbcc8" },
  running: { bg: "#15315c", fg: "#6fb6ff" },
  waiting: { bg: "#5a4a10", fg: "#f7c948" },
  finished: { bg: "#143b22", fg: "#5ec98b" },
  error: { bg: "#4a1616", fg: "#ff8a80" },
};
export const styleFor = (s) => STATUS_STYLE[s] || STATUS_STYLE.pending;

export function makeLed(label, status) {
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
export const FONT5x7 = {
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
export const GLYPH_W = 5, GLYPH_H = 7, GLYPH_GAP = 1, GLYPH_UNIT = GLYPH_W + GLYPH_GAP;

// Draw a string of bitmap glyphs into the dot grid starting at column `startCol`
// (no centring), clipping anything outside the grid.
export function drawGlyphs(grid, cols, s, startCol, rowTop) {
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
export function stampCentered(grid, cols, str, rowTop) {
  const s = (str || "").toUpperCase();
  const w = s.length * GLYPH_UNIT - GLYPH_GAP;
  drawGlyphs(grid, cols, s, Math.floor((cols - w) / 2), rowTop);
}
// Continuously scrolling text: repeats the string (with a gap) across the panel,
// shifted left by `offset` dot-columns, so it loops seamlessly.
export function stampScroll(grid, cols, str, rowTop, offset) {
  const s = (str || "").toUpperCase();
  const period = s.length * GLYPH_UNIT + 6;            // +6 blank cols between loops
  let start = -(((offset % period) + period) % period);
  while (start < cols) { drawGlyphs(grid, cols, s, start, rowTop); start += period; }
}

export const LED_DOT = 6, LED_SCROLL = 9;                      // dot spacing; scroll cols/sec
export function paintLed(led, status) {
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

export function wallBox(w, d, x, z, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, WALL_H, d), mat);
  m.position.set(x, WALL_H / 2, z);
  return m;
}

// The little 3D Claude mascot: a soft terracotta rounded-box body with ear nubs,
// two black eyes on the front (+Z) face, and four stubby legs on hip pivots so they
// can swing as it walks. Returns { group, legs } — `legs` are the hip pivots a theme
// can rotate for a walk gait (a static ornament just ignores them). Built ~1.7 units
// tall (body at y≈0.95); scale the group down to use it as a desk figurine.
export function makeClaude() {
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
