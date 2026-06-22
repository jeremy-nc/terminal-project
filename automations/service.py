"""AutomationStore: user-defined rules that turn domain events into actions.

Today the one kind is ``pr`` — a detected pull request becomes a worktree
workspace running a pipeline (see kinds.py). Each rule has a trigger ``kind``,
kind-specific ``match`` filters, and a pipeline DSL ``spec``. The FRONTEND
evaluates rules against events and asks the backend to get-or-create + run; this
store only persists the rules (gitignored ``automations.json``, no secrets).
"""
import json
import os
import uuid

from .kinds import get_automation_kind


class AutomationStore:
    def __init__(self, config_path: str):
        self._config_path = config_path
        self._rules = []   # [{id, name, active, kind, match:{...}, spec}]
        self._load()

    def _load(self):
        if not os.path.exists(self._config_path):
            return
        try:
            with open(self._config_path) as f:
                d = json.load(f) or {}
        except (OSError, ValueError) as e:
            print(f"[automations] load failed ({self._config_path}): {e}", flush=True)
            return
        self._rules = [self._norm(r) for r in (d.get("rules") or []) if r.get("id")]

    def _save(self):
        try:
            tmp = self._config_path + ".tmp"
            with open(tmp, "w") as f:
                json.dump({"rules": self._rules}, f, indent=2)
            os.replace(tmp, self._config_path)
        except OSError as e:
            print(f"[automations] save failed ({self._config_path}): {e}", flush=True)

    @staticmethod
    def _norm(r: dict) -> dict:
        """Coerce a rule to the canonical shape; keep only match fields the kind
        actually declares (an unknown kind keeps its match as-is, untrusted)."""
        kind = str(r.get("kind") or "pr")
        spec_kind = get_automation_kind(kind)
        allowed = ({f["name"] for f in spec_kind["match_fields"]}
                   if spec_kind else None)
        match = {}
        for k, v in (r.get("match") or {}).items():
            if allowed is None or k in allowed:
                match[str(k)] = str(v or "").strip()
        return {"id": str(r.get("id")), "name": str(r.get("name") or "Automation"),
                "active": bool(r.get("active", True)), "kind": kind,
                "description": str(r.get("description") or ""),  # blank → UI shows the kind's default
                "match": match, "spec": str(r.get("spec") or "")}

    def save_rule(self, rule: dict) -> dict:
        """Create (no id) or update (existing id) a rule. Returns the stored rule."""
        rid = str(rule.get("id") or "").strip() or uuid.uuid4().hex[:8]
        norm = self._norm({**rule, "id": rid})
        for i, r in enumerate(self._rules):
            if r["id"] == rid:
                self._rules[i] = norm
                break
        else:
            self._rules.append(norm)
        self._save()
        return norm

    def delete_rule(self, rid: str):
        self._rules = [r for r in self._rules if r["id"] != str(rid)]
        self._save()

    def to_json(self) -> dict:
        return {"rules": list(self._rules)}
