#!/usr/bin/env python3
"""A minimal ACP agent for exercising the client plumbing without installing a
real agent. Speaks newline-delimited JSON-RPC 2.0 over stdio.

On ``session/prompt`` it streams a few ``session/update`` notifications (a
thought, a message, a tool call, a markdown result), paced with small delays so
the streaming is visible. Two keywords trigger the interactive paths:
  - "approve" -> asks the client for permission before finishing (HITL);
  - "run"     -> creates a terminal running a slow multi-line command, so its
                 output streams live into the card, then finishes.
It is NOT a real agent — it calls no LLM and touches no files itself."""
import json
import sys
import time

_TICK = 0.4  # pacing between updates, so streaming is perceptible

# Request ids for our own client-directed requests, and the deferred prompt it
# is completing (a tiny state machine: create -> wait_for_exit -> finish).
_PERM_REQ_ID = 9001
_TERM_CREATE_ID = 9201
_TERM_WAIT_ID = 9202
_ctx = {}  # {sid, mid, terminalId?}
_sessions = {"n": 0}  # unique session ids so a Collab workspace can hold many


def _send(obj) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _upd(sid, update) -> None:
    _send({"jsonrpc": "2.0", "method": "session/update",
           "params": {"sessionId": sid, "update": update}})


def _msg(sid, text) -> None:
    _upd(sid, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}})


def _finish(sid, mid) -> None:
    _msg(sid, "## Result\n\nThe stub agent finished successfully.\n")
    _send({"jsonrpc": "2.0", "id": mid, "result": {"stopReason": "end_turn"}})


def _prompt_text(params) -> str:
    parts = []
    for block in params.get("prompt", []):
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(block.get("text", ""))
    return "".join(parts).strip()


def _handle_response(mid, msg) -> None:
    """Handle a response to one of OUR requests (permission / terminal steps)."""
    if not _ctx:
        return
    if mid == _PERM_REQ_ID:
        outcome = (msg.get("result") or {}).get("outcome", {})
        _msg(_ctx["sid"], f"\nPermission outcome: {outcome}\n\n")
        _finish(_ctx["sid"], _ctx["mid"])
        _ctx.clear()
    elif mid == _TERM_CREATE_ID:
        # Got the terminalId — now block on its exit (output streams meanwhile).
        _ctx["terminalId"] = (msg.get("result") or {}).get("terminalId")
        _send({"jsonrpc": "2.0", "id": _TERM_WAIT_ID, "method": "terminal/wait_for_exit",
               "params": {"sessionId": _ctx["sid"], "terminalId": _ctx["terminalId"]}})
    elif mid == _TERM_WAIT_ID:
        status = (msg.get("result") or {}).get("exitStatus")
        _msg(_ctx["sid"], f"\nCommand exited: {status}\n\n")
        _finish(_ctx["sid"], _ctx["mid"])
        _ctx.clear()


def _run_prompt(sid, mid, task) -> None:
    _upd(sid, {"sessionUpdate": "agent_thought_chunk",
               "content": {"type": "text", "text": "Reading the request and planning."}})
    time.sleep(_TICK)
    _msg(sid, f"Working on: {task}\n\n")
    time.sleep(_TICK)
    _upd(sid, {"sessionUpdate": "tool_call", "toolCallId": "t1", "kind": "execute",
               "title": "echo hello", "status": "pending", "rawInput": {"command": "echo hello"}})
    time.sleep(_TICK)
    _upd(sid, {"sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed",
               "content": [{"type": "content", "content": {"type": "text", "text": "hello\n"}}]})
    time.sleep(_TICK)

    low = task.lower()
    if "run" in low:
        # Live terminal: a slow multi-line command whose output streams into the card.
        _ctx.update({"sid": sid, "mid": mid})
        _msg(sid, "Running a command…\n\n")
        _send({"jsonrpc": "2.0", "id": _TERM_CREATE_ID, "method": "terminal/create",
               "params": {"sessionId": sid, "command": "sh",
                          "args": ["-c", "for i in 1 2 3 4; do echo line $i; sleep 0.5; done"]}})
        return
    if "approve" in low:
        # HITL: ask the client for permission before finishing.
        _ctx.update({"sid": sid, "mid": mid})
        _send({"jsonrpc": "2.0", "id": _PERM_REQ_ID, "method": "session/request_permission",
               "params": {"sessionId": sid,
                          "toolCall": {"title": "Write CHANGES.md", "kind": "edit",
                                       "content": [{"type": "content",
                                                    "content": {"type": "text", "text": "+ add a changelog entry\n"}}]},
                          "options": [
                              {"optionId": "allow_once", "name": "Allow", "kind": "allow_once"},
                              {"optionId": "allow_always", "name": "Always allow", "kind": "allow_always"},
                              {"optionId": "reject_once", "name": "Reject", "kind": "reject_once"}]}})
        return
    _finish(sid, mid)


def _handle(msg) -> None:
    mid = msg.get("id")
    method = msg.get("method")
    params = msg.get("params") or {}

    if method is None and ("result" in msg or "error" in msg):
        _handle_response(mid, msg)
    elif method == "initialize":
        _send({"jsonrpc": "2.0", "id": mid,
               "result": {"protocolVersion": 1, "agentCapabilities": {}, "authMethods": []}})
    elif method == "session/new":
        _sessions["n"] += 1
        _send({"jsonrpc": "2.0", "id": mid, "result": {"sessionId": f"stub-{_sessions['n']}"}})
    elif method == "session/prompt":
        _run_prompt(params.get("sessionId", "stub-1"), mid, _prompt_text(params) or "(no prompt)")
    elif mid is not None:
        _send({"jsonrpc": "2.0", "id": mid,
               "error": {"code": -32601, "message": f"method not found: {method}"}})


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        try:
            _handle(msg)
        except Exception as exc:  # noqa: BLE001 — keep the stub alive on bad input
            print(f"[stub] error: {exc}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
