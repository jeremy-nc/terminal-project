import React, { useSyncExternalStore, useEffect, useState } from "react";
import {
  subscribe, getSnapshot,
  newTab, activateTab, closeTab, restartTab, fitActive, refitNodes,
} from "./terminalController.js";
import TabBar from "./components/TabBar.jsx";
import TabStage from "./components/TabStage.jsx";
import InputBar from "./components/InputBar.jsx";
import PipelineDashboard from "./components/PipelineDashboard.jsx";

export default function App() {
  const { status, tabs, activeTabId, pipelines } = useSyncExternalStore(subscribe, getSnapshot);
  const [view, setView] = useState("terminal"); // "terminal" | "pipeline"

  // Open the first tab once the WebSocket is open.
  useEffect(() => {
    if (status === "open" && tabs.length === 0) newTab();
  }, [status, tabs.length]);

  // If a pipeline starts, maybe switch to pipeline view automatically
  useEffect(() => {
    if (pipelines.length > 0 && pipelines[pipelines.length - 1].status === "running") {
      setView("pipeline");
    }
  }, [pipelines.length]);

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
          <PipelineDashboard pipelines={pipelines} tabs={tabs} />
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
