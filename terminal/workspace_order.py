"""WorkspaceOrder: a DECOUPLED display ordering for workspaces.

Just a persisted list of workspace ids in display order — kept separate from the
Workspace model on purpose, so a Workspace carries no ordering field. The UI
reorders tabs by replacing this list; workspaces created/deleted elsewhere are
reconciled at read time (unknown ids appended to the end, deleted ids dropped),
so the order never has to be kept in lockstep with the store.
"""
import json
import os


class WorkspaceOrder:
    def __init__(self, path: str):
        self._path = path
        self._order = []   # [workspace_id] in display order
        self._load()

    def _load(self) -> None:
        if not os.path.exists(self._path):
            return
        try:
            with open(self._path) as f:
                data = json.load(f) or {}
            self._order = [str(x) for x in (data.get("order") or []) if x]
        except (OSError, ValueError) as e:
            print(f"[workspace_order] load failed ({self._path}): {e}", flush=True)

    def _save(self) -> None:
        try:
            tmp = self._path + ".tmp"
            with open(tmp, "w") as f:
                json.dump({"order": self._order}, f, indent=2)
            os.replace(tmp, self._path)
        except OSError as e:
            print(f"[workspace_order] save failed ({self._path}): {e}", flush=True)

    def set(self, order) -> list:
        """Replace the order with the ids the UI dragged into place."""
        self._order = [str(x) for x in (order or []) if x]
        self._save()
        return self._order

    def effective(self, existing_ids) -> list:
        """The order to actually display: stored ids that still exist, then any
        existing workspace not yet in the order (new ones) appended."""
        existing = list(existing_ids)
        seen = set()
        out = []
        for i in self._order:
            if i in existing and i not in seen:
                out.append(i)
                seen.add(i)
        for i in existing:
            if i not in seen:
                out.append(i)
        return out

    def reconcile(self, existing_ids) -> list:
        """Like ``effective``, but SELF-HEALING: persist the reconciled list when it
        differs from what's stored — so deleted ids are pruned and newly-created
        ones (e.g. a Dependabot auto-workspace, appended at the end) are remembered.
        Decoupled by design: it keys off the live workspace set, so it covers every
        create/delete path without hooking into any of them. Cheap — writes only on
        an actual change, then stays quiet."""
        new = self.effective(existing_ids)
        if new != self._order:
            self._order = new
            self._save()
        return new
