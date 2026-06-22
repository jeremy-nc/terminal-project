import React, { useState, useEffect, useMemo, useRef } from "react";
import { runWorkspace, cancelWorkspace, setWorkspaceDsl, mountNodeTerm, unmountTab } from "../terminalController.js";
import { parseDsl } from "../pipelineDsl.js";
import { b64dec } from "../wire.js";
import OpenInTerminalButton from "./OpenInTerminalButton.jsx";
import CopyLinkButton from "./CopyLinkButton.jsx";
import WorldView from "./WorldView.jsx";
import TeamCityBranchBuilds from "./TeamCityBranchBuilds.jsx";

// ── 3D-world stage helpers: one room per top-level pipeline stage ────────────
function stageLabel(node) {
  switch (node.type) {
    case "terminal": return (node.argv || []).join(" ") || "terminal";
    case "batch": return "Batch";
    case "fanout":
    case "dynamic_batch": return "Fan-out";
    case "agent": return "Agent";
    case "iteration": return "Loop";
    case "sequence": return "Sequence";
    default: return node.type || "node";
  }
}
function _collectIds(n, acc) {
  if (!n) return;
  acc.push(n.id);
  (n.nodes || []).forEach((c) => _collectIds(c, acc));
  if (n.body) _collectIds(n.body, acc);
}
/** Aggregate a stage's status from itself + descendants (error > waiting > running). */
function stageStatus(node, statusById) {
  const ids = [];
  _collectIds(node, ids);
  const sts = ids.map((id) => statusById[id]).filter(Boolean);
  if (!sts.length) return statusById[node.id] || "pending";
  if (sts.includes("error")) return "error";
  if (sts.includes("waiting")) return "waiting";
  if (sts.includes("running")) return "running";
  if (sts.every((s) => s === "finished")) return "finished";
  return "running";
}

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

/** A live xterm view for a single pipeline node session. When agentNodeId is
 *  set, the terminal is interactive (local echo + send line to the agent). */
function NodeTerminal({ tabId, agentNodeId = null }) {
  const hostRef = useRef(null);
  useEffect(() => {
    if (hostRef.current) mountNodeTerm(tabId, hostRef.current, agentNodeId);
    return () => unmountTab(tabId);
  }, [tabId, agentNodeId]);
  return <div className="node-term-host" ref={hostRef} />;
}

export default function PipelineDashboard({ workspace, tabs }) {
  // Backend for this run's pipeline-node sessions: "bare" (plain PTY, "Default")
  // or "tmux". Per-panel, so each workspace remembers its own choice.
  const [backend, setBackend] = useState("bare");
  // Experimental 3D "world" view of the live tree (per panel). `world` toggles
  // visibility; `worldMounted` keeps the (heavy, WebGL) scene mounted once opened
  // so the camera position persists between toggles — but never spins up a context
  // for a panel you never open it on.
  const [world, setWorld] = useState(false);
  const [worldMounted, setWorldMounted] = useState(false);
  const toggleWorld = () => setWorld((w) => { if (!w) setWorldMounted(true); return !w; });

  // This panel renders exactly one workspace. App keeps every workspace's panel
  // mounted (hiding inactive via display:none) so node terminals are never
  // disposed/re-attached on tab switch — re-attaching replays the raw PTY buffer,
  // which corrupts an interactive TUI (the repeating DA-query garbage).
  const active = workspace || null;
  // Git branch this workspace tracks (worktree kind only) — drives the TeamCity
  // branch panel. null for a plain directory workspace, which hides the panel.
  const branch = active?.kind === "worktree" ? (active?.meta?.branch || null) : null;

  // Parsed preview of the active workspace's DSL — used for the pre-run tree and
  // as the spec to run.
  const preview = useMemo(() => {
    if (!active) return null;
    try {
      return parseDsl(active.dsl || "");
    } catch (e) {
      console.error("Parse error:", e);
      return null;
    }
  }, [active?.id, active?.dsl]);

  // One 3D room per top-level pipeline stage, with its aggregated live status.
  const stages = useMemo(() => {
    const nodes = active?.spec?.nodes || [];
    return nodes.map((n) => ({ id: n.id, label: stageLabel(n), status: stageStatus(n, active.statusById || {}) }));
  }, [active?.spec, active?.statusById]);

  // Node-card tab id, namespaced per workspace (matches terminalController).
  const nt = (nodeId) => (active ? `${active.id}::node-${nodeId}` : null);

  // Follow the action: scroll the live tree to a stage's container the first
  // time one of its terminals starts.
  useEffect(() => {
    const stage = active?.currentStage;
    if (!stage) return;
    const el = document.getElementById(`pl-node-${stage}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [active?.currentStage]);

  const handleRun = () => {
    if (active && preview) runWorkspace(active.id, preview, backend);
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

    if (node.type === "agent") {
      return (
        <div key={node.id || Math.random()} className="node-container terminal agent">
          <div className="terminal-status-dot pending"></div>
          <div className="terminal-id">Agent · {node.backend}{node.model ? ` (${node.model})` : ""}</div>
          {node.system && <div className="agent-system">⚙ {node.system.split("\n")[0]}</div>}
          <div className="terminal-argv">{node.prompt}</div>
        </div>
      );
    }

    if (node.type === "iteration") {
      return (
        <div key={node.id || Math.random()} className="node-container batch iteration">
          <div className="node-label">
            Loop ×{node.max_iterations} max{node.until ? ` · until: ${node.until}` : " · self-assessed"}
          </div>
          <div className="node-children">
            {(node.body?.nodes || []).map(n => renderNode(n))}
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

  // Live view mirrors the preview tree, with status/session looked up by spec id
  // from the active workspace's run state.
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
                  const tabId = nt(child.nodeId);
                  const hasTab = tabs.some(t => t.id === tabId);
                  return (
                    <div
                      key={child.nodeId}
                      className={`node-container terminal live status-${status} ${status === 'waiting' ? 'pulse' : ''}`}
                    >
                      <div className="node-term-head">
                        {(status === "running" || status === "waiting") && <>
                          <CopyLinkButton workspaceId={active.id} nodeId={child.nodeId} className="node-action" />
                          <OpenInTerminalButton sessionId={active.sessionById?.[child.nodeId]} className="node-action" />
                        </>}
                        <div className="terminal-status-dot"></div>
                        <span className="terminal-id" title={(child.argv || []).join(" ")}>{(child.argv || []).join(" ")}</span>
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

    if (node.type === "agent") {
      const status = active.statusById?.[node.id] || "pending";
      const tabId = nt(node.id);
      const hasTab = tabs.some(t => t.id === tabId);
      const kids = active.childrenByParent?.[node.id] || [];
      return (
        <div key={node.id} id={`pl-node-${node.id}`} className="node-container batch live">
          <div className="node-label">Agent · {node.backend}{node.model ? ` (${node.model})` : ""}</div>
          {node.system && <div className="agent-system">⚙ {node.system.split("\n")[0]}</div>}
          <div className="node-children parallel">
            {/* the coordinator's own terminal — the first card in the row */}
            <div className={`node-container terminal agent live status-${status} ${status === 'waiting' ? 'pulse' : ''}`}>
              <div className="node-term-head">
                {(status === "running" || status === "waiting") &&
                  <CopyLinkButton workspaceId={active.id} nodeId={node.id} className="node-action" />}
                <div className="terminal-status-dot"></div>
                <span className="terminal-id">Coordinator</span>
                <span className="terminal-status-text">{status}</span>
              </div>
              {hasTab && <NodeTerminal tabId={tabId} agentNodeId={node.id} />}
              {status === "waiting" && <div className="agent-waiting-hint">⌨ type your reply, then Enter</div>}
            </div>
            {/* delegated sub-agents — next to the coordinator */}
            {kids.map(child => {
              const cstatus = active.statusById?.[child.nodeId] || "pending";
              const ctabId = nt(child.nodeId);
              const chasTab = tabs.some(t => t.id === ctabId);
              return (
                <div key={child.nodeId} className={`node-container terminal live status-${cstatus} ${cstatus === 'waiting' ? 'pulse' : ''}`}>
                  <div className="node-term-head">
                    {(cstatus === "running" || cstatus === "waiting") && <>
                      <CopyLinkButton workspaceId={active.id} nodeId={child.nodeId} className="node-action" />
                      <OpenInTerminalButton sessionId={active.sessionById?.[child.nodeId]} className="node-action" />
                    </>}
                    <div className="terminal-status-dot"></div>
                    <span className="terminal-id" title={(child.argv || []).join(" ")}>{(child.argv || []).join(" ")}</span>
                    <span className="terminal-status-text">{cstatus}</span>
                  </div>
                  {chasTab && <NodeTerminal tabId={ctabId} />}
                </div>
              );
            })}
          </div>
        </div>
      );
    }

    if (node.type === "iteration") {
      const iter = active.iterById?.[node.id];
      const max = iter?.max ?? node.max_iterations ?? 5;
      const cur = iter?.current || 0;
      const istatus = active.statusById?.[node.id];
      const badge = istatus === "finished"
        ? `done · ${cur}/${max} pass${cur === 1 ? "" : "es"}`
        : cur > 0 ? `pass ${cur}/${max}` : `up to ${max} passes`;
      return (
        <div key={node.id} id={`pl-node-${node.id}`} className={`node-container batch live iteration status-${istatus || "pending"}`}>
          <div className="node-label">
            <span className="iter-title">Loop</span>
            <span className="iter-badge">{badge}</span>
            {node.until && <span className="iter-until" title={`completes when: ${node.until}`}>until: {node.until}</span>}
          </div>
          <div className="iteration-body">
            {renderLiveNodeTree(node.body)}
          </div>
        </div>
      );
    }

    // terminal leaf
    const status = active.statusById?.[node.id] || "pending";
    const tabId = nt(node.id);
    const hasTab = tabs.some(t => t.id === tabId);
    return (
      <div
        key={node.id}
        id={`pl-node-${node.id}`}
        className={`node-container terminal live status-${status} ${status === 'waiting' ? 'pulse' : ''}`}
      >
        <div className="node-term-head">
          {(status === "running" || status === "waiting") && <>
            <CopyLinkButton workspaceId={active.id} nodeId={node.id} className="node-action" />
            <OpenInTerminalButton sessionId={active.sessionById?.[node.id]} className="node-action" />
          </>}
          <div className="terminal-status-dot"></div>
          <span className="terminal-id" title={node.argv.join(" ")}>{node.argv.join(" ")}</span>
          <span className="terminal-status-text">{status}</span>
          {status === 'waiting' && <span className="hitl-hint">Needs Input</span>}
        </div>
        {hasTab && <NodeTerminal tabId={tabId} />}
      </div>
    );
  };

  const running = active?.status === "running";

  return (
    <div className="pipeline-screen">
      <div className="pipeline-sidebar">
        {active ? (
          <>
            <div className="sidebar-header" title={active.dir}>Pipeline · {active.name}</div>
            <textarea
              className="dsl-editor"
              value={active.dsl}
              onChange={(e) => setWorkspaceDsl(active.id, e.target.value)}
              spellCheck="false"
              placeholder="seq: claude -p &quot;…&quot;"
            />
            <div className="backend-select" role="radiogroup" aria-label="Terminal backend">
              <span className="backend-label">Terminal</span>
              {[["bare", "Default"], ["tmux", "tmux"]].map(([value, label]) => (
                <label key={value} className="backend-option">
                  <input
                    type="radio"
                    name={`node-backend-${active.id}`}
                    value={value}
                    checked={backend === value}
                    onChange={() => setBackend(value)}
                  />
                  {label}
                </label>
              ))}
            </div>
            <button className="btn-run" onClick={handleRun} disabled={running}>
              {running ? "Running..." : "Run session"}
            </button>
          </>
        ) : (
          <>
            <div className="sidebar-header">Pipeline Spec</div>
            <div className="text-faint" style={{ padding: "8px 2px" }}>
              Create a session (the <strong>+</strong> above) to define and run a pipeline.
            </div>
          </>
        )}
      </div>

      <div className={`pipeline-main${world ? " world-on" : ""}`}>
        {!active ? (
          <div className="preview-view">
            <div className="pipeline-header"><span className="pipeline-title">No session</span></div>
          </div>
        ) : active.spec ? (
          <div className="active-view">
            <div className="pipeline-header">
              <span className="pipeline-title">{active.name}</span>
              <span className={`status-pill status-${active.status}`}>{active.status}</span>
              {running && <button className="btn-cancel" onClick={() => cancelWorkspace(active.id)}>Cancel</button>}
              <button className="btn-world" onClick={toggleWorld} title="Experimental 3D view">
                {world ? "▣ Pipeline" : "◷ World"}
              </button>
            </div>
            {/* Live tree stays MOUNTED and rendered at all times — never
                display:none. That avoids disposing/re-attaching node terminals
                (which replays the raw PTY buffer and corrupts interactive TUIs)
                AND keeps each terminal's scroll viewport alive (a display:none
                xterm can't scroll). In world view we park it OFF-SCREEN with
                position:FIXED — fixed (not absolute) so its containing block is
                the viewport, meaning the tall tree does NOT add to .pipeline-main's
                scroll height (absolute would, leaving the page scrollable behind
                the 3D canvas). WorldView then takes its place in normal flow. */}
            <div style={world
              ? { position: "fixed", left: "-99999px", top: 0, width: "100%" }
              : undefined}>
              {active.warnings?.length > 0 && (
                <div className="pipeline-warnings">
                  {active.warnings.map((w, i) => <div key={i} className="warn-line">⚠ {w}</div>)}
                </div>
              )}
              {active.status === "error" && active.error && (
                <div className="pipeline-error-banner">✕ {active.error}</div>
              )}
              <div className="live-tree">{renderLiveNodeTree(active.spec)}</div>
              {active.result && (
                <div className="pipeline-result">
                  <div className="result-label">Final Output</div>
                  <pre className="result-data">{decodeResult(active.result)}</pre>
                </div>
              )}
            </div>
            {worldMounted && (
              <div style={{ display: world ? "block" : "none" }}>
                <WorldView stages={stages} workspaceId={active.id} />
              </div>
            )}
          </div>
        ) : (
          <div className="preview-view">
            <div className="pipeline-header"><span className="pipeline-title">Preview</span></div>
            <div className="node-list">
              {preview?.nodes.map(node => renderNode(node))}
            </div>
          </div>
        )}
      </div>

      <div className="pipeline-outputs">
        <div className="outputs-main">
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
                {running ? "Outputs appear as each node finishes…" : "Run a session to see each node's output."}
              </div>
            )}
          </div>
        </div>
        {/* Branch-scoped TeamCity builds (bottom ~⅓); hides itself for non-git workspaces. */}
        <TeamCityBranchBuilds branch={branch} repo={active?.meta?.repo || ""} />
      </div>
    </div>
  );
}
