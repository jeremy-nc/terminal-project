import React from "react";
import OpenInTerminalButton from "./OpenInTerminalButton.jsx";

export default function TabBar({ tabs, activeTabId, onActivate, onClose, onNew }) {
  return (
    <>
      <div className="tabs">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab${tab.id === activeTabId ? " active" : ""}`}
            onClick={() => onActivate(tab.id)}
          >
            <span className="tab-title">{tab.title}</span>
            {tab.status === "exited" && <span className="tab-badge">✕</span>}
            <OpenInTerminalButton sessionId={tab.sessionId} className="tab-action" />
            <button
              className="tab-close"
              onClick={(e) => { e.stopPropagation(); onClose(tab.id); }}
              title="Close tab"
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button className="new-tab" onClick={onNew} title="New tab">+</button>
    </>
  );
}
