"""RepoIndex: scan configured roots for local git checkouts and map
``owner/name`` -> local path.

The map is derived from each repo's ``remote.origin.url`` (so it reflects whatever
the local git config says); only the configured roots are persisted to JSON. The
scan is one level deep under each root and skips our generated ``*.worktrees``
dirs. ``owner/name`` keys are matched case-insensitively (GitHub is).
"""
import json
import os
import re
import subprocess

DEFAULT_ROOTS = ["~/Code"]

# git@github.com:Owner/name.git | https://github.com/Owner/name(.git) | ssh://…/Owner/name
_REMOTE_RE = re.compile(r"[:/]([^/:]+)/([^/]+?)(?:\.git)?/?$")


def _parse_owner_name(url: str):
    m = _REMOTE_RE.search((url or "").strip())
    return f"{m.group(1)}/{m.group(2)}" if m else None


def _git(repo: str, *args: str) -> str:
    try:
        r = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, timeout=5)
        return r.stdout.strip() if r.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


class RepoIndex:
    def __init__(self, config_path: str):
        self._config_path = config_path
        self._roots = list(DEFAULT_ROOTS)
        self._repos = []   # [{"name": "Owner/name", "path": abs, "root": base}]
        self._map = {}     # lower("owner/name") -> abs path
        self._load()
        self.scan()

    # ── config persistence (roots only; the map is re-scanned) ──────────────
    def _load(self):
        if not os.path.exists(self._config_path):
            return
        try:
            with open(self._config_path) as f:
                roots = (json.load(f) or {}).get("roots")
            if isinstance(roots, list) and roots:
                self._roots = [str(r) for r in roots if str(r).strip()]
        except (OSError, ValueError) as e:
            print(f"[repos] load failed ({self._config_path}): {e}", flush=True)

    def _save(self):
        try:
            tmp = self._config_path + ".tmp"
            with open(tmp, "w") as f:
                json.dump({"roots": self._roots}, f, indent=2)
            os.replace(tmp, self._config_path)
        except OSError as e:
            print(f"[repos] save failed ({self._config_path}): {e}", flush=True)

    # ── scanning ────────────────────────────────────────────────────────────
    def scan(self):
        """Re-index: one level under each root, read remote.origin.url, dedupe by
        owner/name. Returns the repo list."""
        repos, seen = [], set()
        for root in self._roots:
            base = os.path.normpath(os.path.expanduser(root))
            if not os.path.isdir(base):
                continue
            for entry in sorted(os.listdir(base)):
                if entry.startswith(".") or entry.endswith(".worktrees"):
                    continue  # hidden, or our own generated worktree containers
                path = os.path.join(base, entry)
                if not os.path.isdir(path):
                    continue
                is_git = os.path.exists(os.path.join(path, ".git")) or bool(_git(path, "rev-parse", "--git-dir"))
                if not is_git:
                    continue
                name = _parse_owner_name(_git(path, "config", "--get", "remote.origin.url"))
                if not name or name.lower() in seen:
                    continue
                seen.add(name.lower())
                repos.append({"name": name, "path": path, "root": base})
        self._repos = repos
        self._map = {r["name"].lower(): r["path"] for r in repos}
        return self._repos

    # ── queries / config ─────────────────────────────────────────────────────
    def resolve(self, owner_name: str):
        """Local path for a GitHub ``owner/name``, or None if not checked out."""
        return self._map.get((owner_name or "").lower())

    def roots(self):
        return list(self._roots)

    def set_roots(self, roots):
        cleaned = [str(r).strip() for r in (roots or []) if str(r).strip()]
        self._roots = cleaned or list(DEFAULT_ROOTS)
        self._save()
        return self.scan()

    def to_json(self):
        """Broadcast shape: the configured roots + the resolved repo map."""
        return {"roots": self._roots, "repos": self._repos}
