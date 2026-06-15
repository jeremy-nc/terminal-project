"""Workspace: a named pipeline-in-a-directory.

A Workspace is the top-level unit the UI shows as a "session" tab. It owns:
  - a persisted DEFINITION: id, name, dir, dsl (the side-panel text), and
  - an in-memory CONTEXT: the current PipelineRun (node outputs, status), set
    when it executes and overridden on each re-run. Not persisted.

WorkspaceStore is an in-memory registry persisted to a JSON file (the definition
subset only). It's the source of truth for "what sessions exist"; run state is
transient and lives on each Workspace's PipelineRun.

NB: distinct from the low-level ``Session`` in session.py (a single PTY/virtual
stream). A Workspace runs a pipeline whose nodes spawn those PTY sessions.
"""
import json
import os
import uuid


class Workspace:
    def __init__(self, id: str, name: str, dir: str, dsl: str = ""):
        self.id = id
        self.name = name
        self.dir = dir          # working directory (raw, may contain ~)
        self.dsl = dsl          # side-panel pipeline source
        self.run = None         # current PipelineRun (in-memory context); set on execute

    def to_json(self) -> dict:
        """The persisted definition subset (run context is transient)."""
        return {"id": self.id, "name": self.name, "dir": self.dir, "dsl": self.dsl}

    @classmethod
    def from_json(cls, d: dict) -> "Workspace":
        return cls(d["id"], d.get("name", ""), d.get("dir", ""), d.get("dsl", ""))


class WorkspaceStore:
    def __init__(self, path: str):
        self._path = path
        self._workspaces = {}  # id -> Workspace (insertion-ordered)
        self._load()

    def _load(self) -> None:
        if not os.path.exists(self._path):
            return
        try:
            with open(self._path) as f:
                data = json.load(f)
            for d in data.get("workspaces", []):
                ws = Workspace.from_json(d)
                self._workspaces[ws.id] = ws
        except (OSError, ValueError, KeyError) as e:
            print(f"[workspace] load failed ({self._path}): {e}", flush=True)

    def _save(self) -> None:
        # Atomic write so a crash mid-save can't truncate the store.
        try:
            tmp = self._path + ".tmp"
            with open(tmp, "w") as f:
                json.dump({"workspaces": [w.to_json() for w in self._workspaces.values()]}, f, indent=2)
            os.replace(tmp, self._path)
        except OSError as e:
            print(f"[workspace] save failed ({self._path}): {e}", flush=True)

    def list(self) -> list:
        return list(self._workspaces.values())

    def get(self, wid: str):
        return self._workspaces.get(wid)

    def create(self, dir: str, name: str = None) -> Workspace:
        wid = uuid.uuid4().hex[:8]
        # Default name: the directory's basename, else a numbered fallback.
        name = name or os.path.basename(os.path.normpath(os.path.expanduser(dir))) or f"session-{len(self._workspaces) + 1}"
        ws = Workspace(wid, name, dir, "")
        self._workspaces[wid] = ws
        self._save()
        return ws

    def set_pipeline(self, wid: str, dsl: str):
        ws = self._workspaces.get(wid)
        if ws is not None:
            ws.dsl = dsl
            self._save()
        return ws

    def delete(self, wid: str):
        ws = self._workspaces.pop(wid, None)
        if ws is not None:
            self._save()
        return ws
