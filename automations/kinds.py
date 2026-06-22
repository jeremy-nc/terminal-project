"""Automation kinds: the extensible registry of automation TRIGGERS.

Each kind describes a domain event ("a new PR was detected"), the filter fields
it exposes, and what it produces. The manifest drives the rule editor
generically — like workspace kinds drive the create modal — so a new kind shows
up in the UI with no bespoke form code. Evaluation (matching an event to a rule
and acting on it) is frontend-coordinated, with one evaluator per kind.

Today there is one kind: ``pr`` — a detected pull request → get-or-create a
worktree workspace on its branch + run the rule's pipeline spec. To add a domain
later (e.g. ``slack``): append a manifest entry here and a matching evaluator on
the frontend.
"""

AUTOMATION_KINDS = [
    {
        "id": "pr",
        "label": "Pull Request",
        "domain": "github",
        "description": ("When a new PR matching the filters is detected, "
                        "get-or-create a worktree workspace on its branch and "
                        "run the pipeline spec."),
        # Filter fields shown in the rule editor (all optional; blank = match any).
        "match_fields": [
            {"name": "author", "label": "Author contains", "placeholder": "dependabot"},
            {"name": "repo", "label": "Repo contains", "placeholder": "owner/name (blank = any)"},
        ],
        "produces": "workspace",
        "workspace_kind": "worktree",
    },
]

_BY_ID = {k["id"]: k for k in AUTOMATION_KINDS}


def automation_kinds_manifest() -> list:
    return [dict(k) for k in AUTOMATION_KINDS]


def get_automation_kind(kind_id: str):
    return _BY_ID.get(kind_id)
