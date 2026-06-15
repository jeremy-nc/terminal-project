import React, { useEffect, useRef } from "react";
import { useSyncExternalStore } from "react";
import { subscribe, getSnapshot, mountSharedNode, unmountTab } from "../terminalController.js";

/** Full-window focused view of a single pipeline node, opened via
 *  /shared/workspace/{workspaceId}/t/{nodeId}. Attaches to the node's live
 *  session: mirrors its output and lets you drive it (HITL). */
export default function SharedNodeView({ workspaceId, nodeId }) {
  const { status } = useSyncExternalStore(subscribe, getSnapshot);
  const hostRef = useRef(null);

  useEffect(() => {
    if (status !== "open" || !hostRef.current) return;
    const key = mountSharedNode(workspaceId, nodeId, hostRef.current);
    return () => unmountTab(key);
  }, [status, workspaceId, nodeId]);

  return (
    <div className="shared-view">
      <div className="shared-head">
        <span className="shared-title">{nodeId}</span>
        <span className="shared-sub">workspace {workspaceId}</span>
        <span className={`status status-${status}`}>{status}</span>
      </div>
      <div className="shared-term" ref={hostRef} />
    </div>
  );
}
