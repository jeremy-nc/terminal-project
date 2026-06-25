import React, { useRef, useEffect, useState, useCallback } from "react";
import * as THREE from "three";
import { readNodeScreen, sendTerminalInput, scrollNodeTerminal } from "../terminalController.js";
import { getTheme } from "./world/themes/index.js";
import { paintScreen, paintStandby, keyEventToBytes, EYE } from "./world/worldkit.js";

/**
 * Experimental first-person 3D view of a pipeline. Each top-level stage becomes a
 * simple box room around a central hub, with a door facing the hub and an LED
 * panel above it showing the stage's live status. Walk with WASD; click to capture
 * the mouse for look (Esc releases). The look/feel of the world (lighting, props,
 * room style, animation) is provided by a swappable `theme`; this component is the
 * theme-agnostic engine (controls, collision, portals, screen mirroring).
 */
export default function WorldView({ stages, workspaceId, theme, onPortal, spawn }) {
  const hostRef = useRef(null);
  const stagesRef = useRef(stages);
  stagesRef.current = stages;
  const wsRef = useRef(workspaceId);
  wsRef.current = workspaceId;
  const S = useRef({});
  // The active theme module. Kept in a ref (updated every render) so the one-time
  // setup effect reads the latest theme at mount; switching theme rebuilds on the
  // next mount of the component.
  const themeRef = useRef(null);
  themeRef.current = getTheme(theme);
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
    const themeMod = themeRef.current;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = themeMod.background();
    scene.fog = new THREE.Fog(themeMod.fog.color, themeMod.fog.near, themeMod.fog.far);

    const camera = new THREE.PerspectiveCamera(72, 1, 0.1, 600);
    camera.position.set(0, EYE, 0);

    const built = themeMod.buildWorld(scene, renderer, camera);
    Object.assign(S.current, {
      renderer, scene, camera,
      mats: built.mats,
      roomsGroup: built.roomsGroup,
      water: built.water,
      composer: built.composer,
      claude: built.claude,
      treeWalls: built.treeWalls,
      trees: built.trees,
      rooms: new Map(),
      sig: "",
    });

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
    let raf = 0, lastScreen = 0;
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

      // Portal entry: stepping inside a portal navigates to another running workspace
      // (next/prev). Fire only on the RISING EDGE (outside → inside) — otherwise the
      // camera you left parked inside a portal would re-fire the instant this world is
      // shown again (e.g. switching back to its tab), yanking you away. You step out and
      // back in to use it again. Cooldown still guards the arrival spawn.
      let insidePortal = false;
      if (portalRef.current) {
        for (const tt of (S.current.trees || [])) {
          const ex = camera.position.x - tt.x, ez = camera.position.z - tt.z;
          if (ex * ex + ez * ez < 1.21) {     // inside the portal (~1.1 radius)
            insidePortal = true;
            if (!S.current.portalInside && nowMs > (S.current.portalCd || 0)) {
              S.current.portalCd = nowMs + 900;
              portalRef.current(tt.role);
            }
            break;
          }
        }
      }
      S.current.portalInside = insidePortal;

      // Mirror live terminals onto room screens (throttled). Reveal the TV only
      // when a terminal exists at that tab id; hide it otherwise.
      const now = performance.now();
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

      // Per-frame theme animation (water drift, walking mascot, LED marquee, …).
      themeMod.animate(S.current, dt);

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
    const themeMod = themeRef.current;
    const sig = stages.map((s) => s.id).join("|");
    if (sig !== st.sig) {
      st.sig = sig;
      st.roomsGroup.clear();
      st.rooms = new Map();
      st.walls = [];
      st.screens = [];
      const slots = themeMod.layout(stages.length);
      stages.forEach((stage, i) => {
        const tabId = wsRef.current ? `${wsRef.current}::node-${stage.id}` : null;
        const { group, led, walls, screen } = themeMod.buildStage(stage, slots[i], st.mats, tabId);
        st.roomsGroup.add(group);
        st.rooms.set(stage.id, led);
        st.walls.push(...walls);
        if (screen) st.screens.push(screen);
      });
    }
    stages.forEach((stage) => {
      const led = st.rooms.get(stage.id);
      if (led) themeMod.paintStatus(led, stage.status);
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
