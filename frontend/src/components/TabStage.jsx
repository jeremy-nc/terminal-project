/**
 * TabStage
 *
 * Renders a single tab's terminal host div(s). When the div is first attached
 * to the DOM it calls mountTab on the controller; cleanup calls unmountTab.
 *
 * The `isMirror` prop selects whether to render the main or mirror host.
 * Both halves (main + mirror) share the same `tab.id` so the controller can
 * wire them together.
 */
import React, { useEffect, useRef } from "react";
import { mountTab, unmountTab, fitTab } from "../terminalController.js";

// One shared ref-pair registry so the main-half can tell the controller
// about both hosts before sending "start".
const _pendingHosts = new Map(); // tabId → { main, mirror }

function _tryMount(tabId) {
  const pair = _pendingHosts.get(tabId);
  if (pair?.main && pair?.mirror) {
    _pendingHosts.delete(tabId);
    mountTab(tabId, pair.main, pair.mirror);
  }
}

export default function TabStage({ tab, active, isMirror = false }) {
  const hostRef = useRef(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;

    // Register this half and try to mount when both halves are ready.
    if (!_pendingHosts.has(tab.id)) _pendingHosts.set(tab.id, {});
    const pair = _pendingHosts.get(tab.id);
    if (isMirror) {
      pair.mirror = el;
    } else {
      pair.main = el;
    }
    _tryMount(tab.id);

    return () => {
      if (!isMirror) {
        // Main half drives unmount when the tab is removed.
        unmountTab(tab.id);
        _pendingHosts.delete(tab.id);
      }
    };
  }, [tab.id, isMirror]);

  // Refit whenever this stage becomes active.
  useEffect(() => {
    if (active && !isMirror) fitTab(tab.id);
  }, [active, tab.id, isMirror]);

  return (
    <div
      ref={hostRef}
      className={`term-host${active ? "" : " hidden"}`}
      style={{ width: "100%", height: "100%" }}
    />
  );
}
