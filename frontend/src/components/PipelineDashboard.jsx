import React, { useState, useEffect, useRef } from "react";
import { runPipeline, mountNodeTerm, unmountTab } from "../terminalController.js";
import { parseDsl } from "../pipelineDsl.js";
import { b64dec } from "../wire.js";

function decodeResult(result) {
  if (!result?.output) return "";
  try {
    return new TextDecoder().decode(b64dec(result.output));
  } catch {
    return result.output;
  }
}

/** A live xterm view for a single pipeline node session. */
function NodeTerminal({ tabId }) {
  const hostRef = useRef(null);
  useEffect(() => {
    if (hostRef.current) mountNodeTerm(tabId, hostRef.current);
    return () => unmountTab(tabId);
  }, [tabId]);
  return <div className="node-term-host" ref={hostRef} />;
}

export default function PipelineDashboard({ pipelines, tabs }) {
  const [specText, setSpecText] = useState(
    "# Sample Pipeline\n" +
    "dir: @~/Code/terminal-project\n" +
    "seq:   auggie --print -m prism-a --mcp-config '{}' \"hello no code edits\"\n" +
    "batch: claude, bash -c \"sleep 2; echo Job B\"\n" +
    "seq:   bash -c \"echo Done. Output: {{input}}\"\n" +
    "# Per-command dir: append @path or @\"path with spaces\"\n" +
    "# seq: git log @~/Code/terminal-project"
  );
  const [preview, setPreview] = useState(null);

  const active = pipelines[pipelines.length - 1];

  // Auto-parse preview on change
  useEffect(() => {
    try {
      setPreview(parseDsl(specText));
    } catch (e) {
      console.error("Parse error:", e);
    }
  }, [specText]);

  const handleRun = () => {
    if (preview) runPipeline(preview);
  };

  const renderNode = (node) => {
    if (node.type === "batch") {
      return (
        <div key={node.id || Math.random()} className="node-container batch">
          <div className="node-label">Batch</div>
          <div className="node-children">
            {node.nodes.map(n => renderNode(n))}
          </div>
        </div>
      );
    }

    return (
      <div key={node.id || Math.random()} className="node-container terminal">
        <div className="terminal-status-dot pending"></div>
        <div className="terminal-id">Terminal</div>
        <div className="terminal-argv">{node.argv.join(" ")}</div>
      </div>
    );
  };

  // Live view mirrors the preview tree: sequences stack vertically (series),
  // batches lay out horizontally (parallel), and every leaf is an interactive
  // terminal. Status/session are looked up by spec id from the live pipeline.
  const renderLiveNodeTree = (node) => {
    if (node.type === "sequence") {
      return (
        <div key={node.id} className="live-flow series">
          {node.nodes.map((child, i) => (
            <React.Fragment key={child.id}>
              {i > 0 && <div className="series-connector" />}
              {renderLiveNodeTree(child)}
            </React.Fragment>
          ))}
        </div>
      );
    }

    if (node.type === "batch") {
      return (
        <div key={node.id} className="node-container batch live">
          <div className="node-label">Batch · parallel</div>
          <div className="node-children parallel">
            {node.nodes.map(child => renderLiveNodeTree(child))}
          </div>
        </div>
      );
    }

    // terminal leaf
    const status = active.statusById?.[node.id] || "pending";
    const tabId = `node-${node.id}`;
    const hasTab = tabs.some(t => t.id === tabId);
    return (
      <div
        key={node.id}
        className={`node-container terminal live status-${status} ${status === 'waiting' ? 'pulse' : ''}`}
      >
        <div className="node-term-head">
          <div className="terminal-status-dot"></div>
          <span className="terminal-id">{node.argv.join(" ")}</span>
          <span className="terminal-status-text">{status}</span>
          {status === 'waiting' && <span className="hitl-hint">Needs Input</span>}
        </div>
        {hasTab && <NodeTerminal tabId={tabId} />}
      </div>
    );
  };

  return (
    <div className="pipeline-screen">
      <div className="pipeline-sidebar">
        <div className="sidebar-header">Pipeline Spec</div>
        <textarea
          className="dsl-editor"
          value={specText}
          onChange={(e) => setSpecText(e.target.value)}
          spellCheck="false"
        />
        <button className="btn-run" onClick={handleRun} disabled={!!active && active.status === "running"}>
          {active && active.status === "running" ? "Running..." : "Run Pipeline"}
        </button>
      </div>

      <div className="pipeline-main">
        {active ? (
          <div className="active-view">
            <div className="pipeline-header">
              <span className="pipeline-title">Live Pipeline #{active.id}</span>
              <span className={`status-pill status-${active.status}`}>{active.status}</span>
            </div>
            <div className="live-tree">
              {active.spec
                ? renderLiveNodeTree(active.spec)
                : <div className="text-faint">Waiting for pipeline spec…</div>}
            </div>
            {active.result && (
              <div className="pipeline-result">
                <div className="result-label">Final Output</div>
                <pre className="result-data">{decodeResult(active.result)}</pre>
              </div>
            )}
          </div>
        ) : (
          <div className="preview-view">
            <div className="pipeline-header">
              <span className="pipeline-title">Preview</span>
            </div>
            <div className="node-list">
              {preview?.nodes.map(node => renderNode(node))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
