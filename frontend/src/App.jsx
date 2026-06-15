import React, { useSyncExternalStore, useEffect, useState } from "react";
import {
  subscribe, getSnapshot,
  newTab, activateTab, closeTab, restartTab, fitActive, refitNodes,
} from "./terminalController.js";
import TabBar from "./components/TabBar.jsx";
import TabStage from "./components/TabStage.jsx";
import InputBar from "./components/InputBar.jsx";
import PipelineDashboard from "./components/PipelineDashboard.jsx";
import WorkspaceTabBar from "./components/WorkspaceTabBar.jsx";

export default function App() {
  const { status, tabs, activeTabId, workspaces, activeWorkspaceId } = useSyncExternalStore(subscribe, getSnapshot);
  const [view, setView] = useState("terminal"); // "terminal" | "pipeline"

  // Open the first interactive tab once the WebSocket is open.
  useEffect(() => {
    if (status === "open" && tabs.filter(t => !t.isNode).length === 0) newTab();
  }, [status, tabs]);

  // Refit active terminal on window resize.
  useEffect(() => {
    window.addEventListener("resize", fitActive);
    return () => window.removeEventListener("resize", fitActive);
  }, []);

  // Both views are kept mounted (hidden via display:none), so on switching
  // back, recompute the now-visible terminals' sizes once laid out.
  useEffect(() => {
    if (view === "terminal") requestAnimationFrame(fitActive);
    else requestAnimationFrame(refitNodes);
  }, [view]);

  const visibleTabs = tabs.filter(t => !t.isNode || activeTabId === t.id);

  return (
    <div className="app">
      <div className="toolbar">
        <span className="title">Browser Terminal</span>

        <div className="view-toggle">
          <button
            className={`toggle-btn ${view === "terminal" ? "active" : ""}`}
            onClick={() => setView("terminal")}
          >
            Terminal
          </button>
          <button
            className={`toggle-btn ${view === "pipeline" ? "active" : ""}`}
            onClick={() => setView("pipeline")}
          >
            Pipeline
          </button>
        </div>

        <button onClick={() => activeTabId && restartTab(activeTabId)}>
          Restart Tab
        </button>
        <span className={`status status-${status}`}>{status}</span>
      </div>

      {view === "terminal" && (
        <div className="tabbar">
          <TabBar
            tabs={visibleTabs}
            activeTabId={activeTabId}
            onActivate={(id) => activateTab(id)}
            onClose={closeTab}
            onNew={newTab}
          />
        </div>
      )}

      <div className={`stage ${view === "pipeline" ? "pipeline-view" : ""}`}>
        {/* Both views stay mounted and toggle via display:none so neither's
            xterm instances (or PTY sessions) are disposed on switch — unmounting
            respawns shells and refits cold, which renders garbled. */}
        <div
          className="pipeline-view-wrap"
          style={{ display: view === "pipeline" ? "flex" : "none" }}
        >
          <WorkspaceTabBar workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} />
          <div className="ws-panels">
            {workspaces.length === 0 ? (
              <div className="ws-empty">Create a session (+) to define and run a pipeline.</div>
            ) : (
              // Every workspace's panel stays mounted; only the active one is
              // shown. Hiding (not unmounting) keeps each panel's node terminals
              // alive across tab switches — no lossy re-attach/replay.
              workspaces.map((w) => (
                <div
                  key={w.id}
                  className="ws-panel"
                  style={{ display: w.id === activeWorkspaceId ? "flex" : "none" }}
                >
                  <PipelineDashboard workspace={w} tabs={tabs} />
                </div>
              ))
            )}
          </div>
        </div>

        <div
          className="terminal-view"
          style={{ display: view === "terminal" ? "flex" : "none" }}
        >
          <div className="main-pane">
            {tabs.map((tab) => (
              <TabStage key={tab.id} tab={tab} active={tab.id === activeTabId} />
            ))}
          </div>
          <div className="mirror-pane">
            <div className="mirror-label">Mirror (read-only)</div>
            {tabs.map((tab) => (
              <TabStage
                key={tab.id}
                tab={tab}
                active={tab.id === activeTabId}
                isMirror
              />
            ))}
          </div>
        </div>
      </div>

      <InputBar />
    </div>
  );
}
