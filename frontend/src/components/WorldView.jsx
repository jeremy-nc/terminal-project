import React, { useRef, useEffect, useState, useCallback } from "react";
import * as THREE from "three";
import {
  readNodeScreen, sendTerminalInput, scrollNodeTerminal,
  getPeers, getSelfPresenceId, reportPose,
} from "../terminalController.js";
import { getTheme } from "./world/themes/index.js";
import { paintScreen, paintStandby, keyEventToBytes, EYE, makeClaude } from "./world/worldkit.js";
import { useBranchTargets } from "./teamcityTargets.js";

// Per-id hue so multiple visitors are distinguishable. Tints the avatar's clay-
// coloured meshes (leaves the black eyes); clones the material so it's per-avatar.
const CLAY = 0xcc785c;
function tintAvatar(group, id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const hue = (h % 360) / 360;
  group.traverse((o) => {
    if (o.material && o.material.color && o.material.color.getHex() === CLAY) {
      o.material = o.material.clone();
      o.material.color.setHSL(hue, 0.55, 0.6);
    }
  });
}

/**
 * Experimental first-person 3D view of a pipeline. Each top-level stage becomes a
 * simple box room around a central hub, with a door facing the hub and an LED
 * panel above it showing the stage's live status. Walk with WASD; click to capture
 * the mouse for look (Esc releases). The look/feel of the world (lighting, props,
 * room style, animation) is provided by a swappable `theme`; this component is the
 * theme-agnostic engine (controls, collision, portals, screen mirroring).
 */
export default function WorldView({ stages, workspaceId, theme, branch, repo, onPortal, spawn }) {
  const hostRef = useRef(null);
  const stagesRef = useRef(stages);
  stagesRef.current = stages;
  const wsRef = useRef(workspaceId);
  wsRef.current = workspaceId;
  const S = useRef({});

  // Optional CI/CD prop data (shared with the sidebar tiles): the resolved trigger
  // configs + live status for this branch, plus a trigger fn. Stashed in refs so the
  // imperative render loop can feed the theme's makeCicd (if any) without re-setup.
  const { targets, recent, trigger } = useBranchTargets(branch, repo);
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const recentRef = useRef(recent);
  recentRef.current = recent;
  const triggerRef = useRef(null);
  triggerRef.current = (key) => {
    const t = (targetsRef.current || []).find((x) => x.key === key);
    if (t) trigger(t);
  };
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
      avatars: new Map(),   // presence_id -> remote visitor avatar (see render loop)
      sig: "",
    });

    // Optional per-world CI/CD prop (e.g. the office CI/CD vending machine). Themes
    // that don't implement makeCicd render nothing — the prop is entirely optional;
    // the status data is available regardless (the sidebar tiles still show it).
    if (themeMod.makeCicd) {
      const cicd = themeMod.makeCicd(S.current.mats);
      if (cicd) { scene.add(cicd.group); S.current.cicd = cicd; S.current.cicdWalls = cicd.walls || []; }
    }

    // ── manual first-person controls ──────────────────────────────────────
    let yaw = 0, pitch = 0, locked = false;
    const keys = {};
    const canvas = renderer.domElement;
    const raycaster = new THREE.Raycaster();
    const CENTER = new THREE.Vector2(0, 0);

    // Enter typing on whatever screen the crosshair is currently aimed at. The
    // aim is computed each frame in the loop (and lights the crosshair), so the
    // click/E handlers just consume the latest result.
    const tryEnterFromCenter = () => {
      if (S.current.aimTabId) { enterTyping(S.current.aimTabId); return; }
      if (S.current.aimCicdKey && triggerRef.current) triggerRef.current(S.current.aimCicdKey);   // trigger a CI/CD config
    };
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
      // CI/CD machine buttons share the crosshair aim (only when not already aiming
      // a screen). A hit lights the crosshair; click / E triggers that config.
      let aimCicdKey = null;
      if (!typing && locked && !aimTabId && S.current.cicd) {
        const bs = S.current.cicd.buttons || [];
        const meshes = bs.map((b) => b.mesh);
        const chits = meshes.length ? raycaster.intersectObjects(meshes, false) : [];
        if (chits.length && chits[0].distance < 6) {
          const b = bs.find((x) => x.mesh === chits[0].object);
          aimCicdKey = b ? b.key : null;
        }
      }
      S.current.aimCicdKey = aimCicdKey;
      S.current.aimTabId = aimTabId;
      if (crossRef.current) crossRef.current.classList.toggle("aim", !!(aimTabId || aimCicdKey));

      const f = typing ? 0 : (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
      const r = typing ? 0 : (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
      if (f || r) {
        const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
        const rx = Math.cos(yaw), rz = -Math.sin(yaw);
        const dx = (fx * f + rx * r) * speed;
        const dz = (fz * f + rz * r) * speed;
        // Per-axis collision so you slide along walls; door gaps have no box.
        const R = 0.35, walls = (S.current.walls || []).concat(S.current.treeWalls || []).concat(S.current.cicdWalls || []);
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

      // ── presence: report our pose (throttled, on-move) + render other visitors ──
      const wid = wsRef.current;
      // Our own camera pose at ~20Hz, only when it actually changed. The backend
      // relays it to same-world windows; receivers interpolate for smoothness.
      if (wid && nowMs - (S.current.lastPoseAt || 0) > 50) {
        const lp = S.current.lastPose;
        const moved = !lp || Math.abs(lp.x - camera.position.x) > 0.02
          || Math.abs(lp.z - camera.position.z) > 0.02 || Math.abs(lp.yaw - yaw) > 0.01;
        if (moved) {
          reportPose(camera.position.x, camera.position.y, camera.position.z, yaw);
          S.current.lastPose = { x: camera.position.x, z: camera.position.z, yaw };
        }
        S.current.lastPoseAt = nowMs;
      }
      // Reconcile + interpolate remote visitors: a peer is anyone focused on THIS
      // world (and not us). Add/remove avatars as they come and go; lerp each toward
      // its latest target every frame so motion looks continuous between packets.
      const peers = getPeers(), selfId = getSelfPresenceId(), avatars = S.current.avatars;
      const liveIds = new Set();
      peers.forEach((p, id) => {
        if (id === selfId || p.focus !== wid || p.x == null) return;
        liveIds.add(id);
        let av = avatars.get(id);
        if (!av) {                                  // theme's avatar, or the default Claude
          const built = (themeMod.makeAvatar || makeClaude)();
          tintAvatar(built.group, id);
          scene.add(built.group);
          av = { group: built.group, legs: built.legs || [], cur: { x: p.x, z: p.z, yaw: p.yaw || 0 }, phase: 0 };
          avatars.set(id, av);
        }
        av.tx = p.x; av.tz = p.z; av.tyaw = p.yaw || 0;
      });
      avatars.forEach((av, id) => {
        if (!liveIds.has(id)) { scene.remove(av.group); avatars.delete(id); return; }
        const k = Math.min(1, dt * 10);
        const ddx = av.tx - av.cur.x, ddz = av.tz - av.cur.z;
        av.cur.x += ddx * k; av.cur.z += ddz * k;
        let dy = av.tyaw - av.cur.yaw;
        while (dy > Math.PI) dy -= 2 * Math.PI;
        while (dy < -Math.PI) dy += 2 * Math.PI;
        av.cur.yaw += dy * k;
        av.group.position.set(av.cur.x, 0, av.cur.z);
        av.group.rotation.y = av.cur.yaw + Math.PI;   // model faces +z; camera-forward is -z at yaw 0
        const sp = Math.hypot(ddx, ddz);
        av.phase += sp * 9;
        const amp = Math.min(0.5, sp * 10);           // leg swing scales with speed
        for (let i = 0; i < av.legs.length; i++) av.legs[i].rotation.x = Math.sin(av.phase + (i % 2) * Math.PI) * amp;
      });

      // Optional CI/CD prop: feed it the latest TeamCity targets when they change,
      // and animate it each frame (e.g. cans dropping into the pile).
      if (S.current.cicd) {
        const ts = targetsRef.current || [];
        const sig = ts.map((t) => `${t.key}:${t.status ? `${t.status.state}:${t.status.status}:${t.status.id}` : "-"}`).join("|")
          + "#" + ((recentRef.current || []).length);
        if (sig !== S.current.cicdSig) {
          S.current.cicdSig = sig;
          S.current.cicd.update({ targets: ts, recent: recentRef.current || [] });
        }
        if (S.current.cicd.animate) S.current.cicd.animate(dt);
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
      (S.current.avatars || new Map()).forEach((av) => scene.remove(av.group));
      S.current.avatars = new Map();
      if (S.current.cicd) { scene.remove(S.current.cicd.group); S.current.cicd = null; }
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
