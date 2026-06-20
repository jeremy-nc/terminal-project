import React, { useRef, useEffect } from "react";

/**
 * Glowing orbs spun clockwise out of the cursor, following it as it moves.
 * Performance: glows are pre-rendered once to small sprite canvases and blitted
 * with drawImage (additive) — no per-particle shadowBlur or gradient creation,
 * so it doesn't stall the main thread (which made the screen feel slow to load).
 */
const COLORS = ["#7c6cff", "#8f82ff", "#b3a6ff", "#5ec9ff", "#c8a8ff"];

// Module-level last-known pointer, updated continuously. The browser exposes no
// synchronous "where is the cursor" API, so we track it always — then an FX can
// start exactly at the cursor (e.g. the click that opened the view) instead of
// the screen centre, and follow it without each instance wiring its own listener.
const pointer = {
  x: typeof window !== "undefined" ? window.innerWidth / 2 : 0,
  y: typeof window !== "undefined" ? window.innerHeight / 2 : 0,
};
if (typeof window !== "undefined") {
  const track = (e) => { pointer.x = e.clientX; pointer.y = e.clientY; };
  window.addEventListener("pointermove", track, { passive: true });
  window.addEventListener("pointerdown", track, { passive: true });
}

function makeGlowSprite(color, size = 48) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, color);
  grad.addColorStop(0.35, color + "99");  // #RRGGBBAA
  grad.addColorStop(1, color + "00");
  g.fillStyle = grad;
  g.beginPath();
  g.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  g.fill();
  return c;
}

// A lens-flare sprite: bright core + soft halo + anamorphic streaks (long
// horizontal, shorter vertical, faint diagonals). Pre-rendered once; drawn
// additively at the cursor each frame.
function makeFlareSprite(size = 256) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const cx = size / 2, cy = size / 2;
  g.globalCompositeOperation = "lighter";

  // soft coloured halo
  let grd = g.createRadialGradient(cx, cy, 0, cx, cy, size / 2);
  grd.addColorStop(0, "rgba(205,196,255,0.85)");
  grd.addColorStop(0.12, "rgba(150,135,255,0.5)");
  grd.addColorStop(0.5, "rgba(124,108,255,0.12)");
  grd.addColorStop(1, "rgba(124,108,255,0)");
  g.fillStyle = grd;
  g.beginPath(); g.arc(cx, cy, size / 2, 0, Math.PI * 2); g.fill();

  // hot white core
  grd = g.createRadialGradient(cx, cy, 0, cx, cy, size * 0.1);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.5, "rgba(224,216,255,0.8)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.beginPath(); g.arc(cx, cy, size * 0.1, 0, Math.PI * 2); g.fill();

  // streaks
  const streak = (angle, len, thick, color) => {
    g.save();
    g.translate(cx, cy); g.rotate(angle);
    const lg = g.createLinearGradient(-len, 0, len, 0);
    lg.addColorStop(0, "rgba(0,0,0,0)");
    lg.addColorStop(0.5, color);
    lg.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = lg;
    g.fillRect(-len, -thick / 2, len * 2, thick);
    g.restore();
  };
  streak(0, size * 0.5, 3, "rgba(190,182,255,0.9)");          // horizontal anamorphic
  streak(0, size * 0.5, 10, "rgba(124,108,255,0.22)");        // soft wide horizontal
  streak(Math.PI / 2, size * 0.28, 2, "rgba(190,182,255,0.6)"); // vertical
  streak(Math.PI / 4, size * 0.2, 1.5, "rgba(170,160,255,0.4)");
  streak(-Math.PI / 4, size * 0.2, 1.5, "rgba(170,160,255,0.4)");
  return c;
}

export default function CursorOrbs({ duration = 2400 }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const sprites = COLORS.map((c) => makeGlowSprite(c));
    const flare = makeFlareSprite();
    let w = 0, h = 0;

    const resize = () => {
      w = window.innerWidth; h = window.innerHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.width = w + "px"; canvas.style.height = h + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const ps = [];
    let angle = 0;                  // emit direction, advances clockwise
    const start = performance.now();
    let raf = 0;

    const frame = (now) => {
      const t = now - start;
      const emitting = t < duration * 0.7;
      ctx.clearRect(0, 0, w, h);

      if (emitting) {
        for (let i = 0; i < 3; i++) {
          angle += 0.42;            // clockwise spin speed
          const spd = 3 + Math.random() * 3;
          ps.push({
            x: pointer.x, y: pointer.y,   // emit from the live cursor
            vx: Math.cos(angle) * spd, vy: Math.sin(angle) * spd,
            life: 1, decay: 0.012 + Math.random() * 0.01,
            r: 7 + Math.random() * 7,
            s: Math.floor(angle / 0.42) % sprites.length,
          });
        }
      }

      ctx.globalCompositeOperation = "lighter";   // additive glow on overlap

      // Lens flare at the cursor — fades in, holds, fades out with the emit tail.
      const fadeIn = Math.min(1, t / 180);
      const fadeOut = t > duration * 0.7
        ? Math.max(0, 1 - (t - duration * 0.7) / (duration * 0.3)) : 1;
      const flareAlpha = fadeIn * fadeOut;
      if (flareAlpha > 0.01) {
        const fs = 280 + Math.sin(t / 110) * 26;   // gentle pulse
        ctx.globalAlpha = flareAlpha;
        ctx.drawImage(flare, pointer.x - fs / 2, pointer.y - fs / 2, fs, fs);
      }

      for (let i = ps.length - 1; i >= 0; i--) {
        const p = ps[i];
        p.x += p.vx; p.y += p.vy;
        p.vx *= 0.985; p.vy *= 0.985;
        p.life -= p.decay;
        if (p.life <= 0) { ps.splice(i, 1); continue; }
        const d = p.r * (0.6 + p.life) * 2;
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.drawImage(sprites[p.s], p.x - d / 2, p.y - d / 2, d, d);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";

      if (emitting || ps.length) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [duration]);

  return <canvas ref={canvasRef} className="appfx-canvas" />;
}
