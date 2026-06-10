import React, { useState, useEffect, useRef } from "react";
import { runPipeline, cancelPipeline, mountNodeTerm, unmountTab } from "../terminalController.js";
import { parseDsl } from "../pipelineDsl.js";
import { b64dec } from "../wire.js";

function decodeOne(result) {
  if (!result?.output) return "";
  try {
    return new TextDecoder().decode(b64dec(result.output));
  } catch {
    return result.output;
  }
}

function decodeResult(result) {
  // A fan-out / dynamic-batch stage resolves to a list of per-worker results.
  if (Array.isArray(result)) return result.map(decodeOne).join("\n");
  return decodeOne(result);
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
    "seq:   claude -p \"List three numbers between 1 and 100, comma-separated, numbers only\"\n" +
    "dyn_batch: claude -p \"In one sentence, say something interesting about {{input}}\"\n" +
    "batch: claude, bash -c \"echo Job B\"\n" +
    "seq:   bash -c \"echo Done. Output: {{input}}\"\n" +
    "# Stage 1 emits 3 numbers; dyn_batch structures them and fans out one\n" +
    "# terminal per number. The batch then runs an interactive claude beside a\n" +
    "# quick echo (interactive claude stays open until you exit it or Cancel).\n" +
    "# Best-of-N (8 identical runs): dyn_batch(8): claude -p \"pick a color\""
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

  // Follow the action: scroll the live tree to a stage's container the first
  // time one of its terminals starts. currentStage only changes per container,
  // so this fires once per stage and the user can scroll freely in between.
  useEffect(() => {
    const stage = active?.currentStage;
    if (!stage) return;
    const el = document.getElementById(`pl-node-${stage}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [active?.currentStage]);

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

    if (node.type === "dynamic_batch" || node.type === "fanout") {
      const label = node.type === "dynamic_batch" ? "Dynamic Batch" : "Fan-out";
      const width = node.count != null ? `×${node.count}` : "×N at runtime";
      return (
        <div key={node.id || Math.random()} className="node-container batch">
          <div className="node-label">{label} {width}</div>
          <div className="node-container terminal">
            <div className="terminal-status-dot pending"></div>
            <div className="terminal-id">Terminal template</div>
            <div className="terminal-argv">{node.argv.join(" ")}</div>
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
        <div key={node.id} id={`pl-node-${node.id}`} className="live-flow series">
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
        <div key={node.id} id={`pl-node-${node.id}`} className="node-container batch live">
          <div className="node-label">Batch · parallel</div>
          <div className="node-children parallel">
            {node.nodes.map(child => renderLiveNodeTree(child))}
          </div>
        </div>
      );
    }

    if (node.type === "dynamic_batch" || node.type === "fanout") {
      // Children don't exist in the spec — they're spawned at runtime and
      // arrive lazily via node_started events, keyed by this node's id.
      const kids = active.childrenByParent?.[node.id] || [];
      const label = node.type === "dynamic_batch" ? "Dynamic Batch · fan-out" : "Fan-out · parallel";
      return (
        <div key={node.id} id={`pl-node-${node.id}`} className="node-container batch live">
          <div className="node-label">{label}</div>
          <div className="node-children parallel">
            {kids.length === 0
              ? <div className="text-faint">Waiting for fan-out…</div>
              : kids.map(child => {
                  const status = active.statusById?.[child.nodeId] || "pending";
                  const tabId = `node-${child.nodeId}`;
                  const hasTab = tabs.some(t => t.id === tabId);
                  return (
                    <div
                      key={child.nodeId}
                      className={`node-container terminal live status-${status} ${status === 'waiting' ? 'pulse' : ''}`}
                    >
                      <div className="node-term-head">
                        <div className="terminal-status-dot"></div>
                        <span className="terminal-id">{(child.argv || []).join(" ")}</span>
                        <span className="terminal-status-text">{status}</span>
                      </div>
                      {hasTab && <NodeTerminal tabId={tabId} />}
                    </div>
                  );
                })}
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
        id={`pl-node-${node.id}`}
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
              {active.status === "running" && (
                <button className="btn-cancel" onClick={cancelPipeline}>Cancel</button>
              )}
            </div>
            {active.warnings?.length > 0 && (
              <div className="pipeline-warnings">
                {active.warnings.map((w, i) => <div key={i} className="warn-line">⚠ {w}</div>)}
              </div>
            )}
            {active.status === "error" && active.error && (
              <div className="pipeline-error-banner">✕ {active.error}</div>
            )}
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

      <div className="pipeline-outputs">
        <div className="sidebar-header">Node Outputs</div>
        <div className="outputs-list">
          {active && active.outputs && Object.keys(active.outputs).length > 0 ? (
            Object.entries(active.outputs)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([nodeId, res]) => (
                <div key={nodeId} className="output-item">
                  <div className="output-node-id">
                    <span>{nodeId}</span>
                    {res.exit_code != null && (
                      <span className="output-exit">exit {res.exit_code}</span>
                    )}
                  </div>
                  <pre className="output-text">{decodeOne(res)}</pre>
                </div>
              ))
          ) : (
            <div className="text-faint">
              {active && active.status === "running"
                ? "Outputs appear as each node finishes…"
                : "Run a pipeline to see each node's output."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
