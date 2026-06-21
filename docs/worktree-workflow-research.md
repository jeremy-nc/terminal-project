# Worktree & Parallel-Agent Workflow — Research & Recommendations

> Research compiled 2026-06-21. Covers (1) an audit of this app's git-worktree /
> workspace management, (2) how comparable parallel-agent tools handle worktrees
> and workflow, and (3) prioritised recommendations. Sources are cited inline and
> collected at the end. External findings were gathered via web research and, where
> possible, by reading the tools' source directly; unverified claims are flagged.

---

## Executive summary

Our worktree management is well-built for **one path — create-and-discard**: fetch a
PR/dependabot branch, run a pipeline, throw the checkout away. The careful parts
(origin-authoritative branch selection, non-destructive fetch, cancel→await→cleanup
ordering, the `closing` state machine, nested-dir prune) are genuinely good.

The structural gap is that **work flows in but never out**: there is no push / PR /
merge-back flow, kept branches accumulate as orphaned local refs, there's no worktree
inventory or reconciliation, no git-status visibility, and no env bootstrapping
(fresh worktrees often can't run). Every comparable tool converges on the patterns we
lack — most importantly a **Commit → Push → Create PR** backflow, **env-file copying**
into worktrees, **per-worktree ports**, a **durable fork point**, and **clean-vs-dirty
auto-cleanup**.

---

## Part 1 — Audit of our worktree management

Files: [`terminal/workspace_kinds.py`](../terminal/workspace_kinds.py),
[`terminal/workspace.py`](../terminal/workspace.py),
[`server.py`](../server.py) (≈ lines 454–514),
[`frontend/src/terminalController.js`](../frontend/src/terminalController.js),
and the create/close modals under `frontend/src/components/`.

### 1.1 What it does well

- **Origin-authoritative branch source selection** (`workspace_kinds.py:137–189`). When
  `origin` has the branch and the local copy carries no unpushed commits
  (`_has_unpushed` via `rev-list --count <branch> --not --remotes=origin`, ~line 209),
  it force-realigns the local ref to `origin/<branch>` (`branch -f`) rather than reusing
  a stale cache — the defence against "ride-along commits" on force-pushed
  dependabot/PR branches.
- **Non-destructive fetch.** Explicit refspec `+<branch>:refs/remotes/origin/<branch>`
  (~line 155) — download-only into the remote-tracking ref, never a merge. Also fetches
  the default branch so recently-merged commits on main aren't misread as local work.
- **New branches fork from a freshly-fetched remote default** (not the primary
  checkout's HEAD), with a documented fallback to local HEAD (`workspace_kinds.py:177–189`).
- **Prune of nested empty parents** (`_prune_empty_parents`, lines 81–97) — handles
  slashed branches (`dependabot/terraform/x`), stops at the first non-empty dir, never
  climbs above the `.worktrees` base; also called on the `worktree add` failure path.
- **Safe-by-default cleanup** — `git worktree remove` without `--force` unless asked; git
  refuses on a dirty tree and the warning is surfaced, not swallowed.
- **`cancel → await → cleanup` teardown ordering** (`server.py:490–503`) — the in-flight
  run is cancelled and **awaited** before any git op, so cleanup never races a live PTY;
  git work runs in an executor so it doesn't block the event loop.
- **`closing` state machine** (`workspace.py`, broadcast via `_workspace_list_event`),
  transient (excluded from `to_json`), mirrored as a spinner in the tab bar; **blocked-on-
  dirty** round-trips cleanly (un-set `closing` → `workspace_cleanup_blocked` →
  re-open dialog with Force); re-close guard; idempotent cleanup when the path is gone;
  atomic temp-file + `os.replace` store writes.

### 1.2 Gaps / risks / missing features

- **No merge / PR-back / push flow at all.** Nothing ever pushes, opens a PR, or merges.
  On close the checkout is deleted but the **branch is kept locally and never pushed**.
  For a *new* branch (`source == "new"`) the only copy of the work becomes a **dangling
  local branch with no worktree** — orphaned and invisible.
- **Kept branches accumulate forever → unbounded ref/disk growth.** No "delete branch"
  option, no listing, no GC.
- **No "list existing worktrees" view / no reconciliation** against `git worktree list`.
  After a crash or a manual `rm`, real worktrees and the JSON store drift with no recovery
  UI. A "Keep worktree" close deliberately manufactures an orphan with no way back.
- **Partial crash recovery.** If the process dies mid-`_close` after `git worktree remove`
  but before `workspaces.delete`, the record lingers as a zombie tab; no startup
  reconciliation against `git worktree list`.
- **`branch -f` realign can rewrite a ref under a *different* live worktree.** The
  unpushed check inspects commit reachability, not "is this branch checked out elsewhere"
  — a stale sibling worktree on the same branch isn't a git error and isn't guarded.
- **No handling of uncommitted work beyond block/Force.** No stash, no "commit first," no
  diff preview of what Force discards.
- **No git status visibility** (ahead/behind/dirty/stale) on the tab — you discover
  uncommitted work only when close fails.
- **No base-branch switching / rebase-onto-updated-main.** Base is chosen once and recorded
  as `meta["base"]` but never used again; long-lived worktrees silently drift.
- **`_default_branch` fallback can mispick** — reads `refs/remotes/origin/HEAD`, falls back
  to literal `main`/`master`; a repo whose default is `develop` and whose origin HEAD isn't
  set locally will mis-base on `main`.
- **`_sanitize_branch` is lossy and silent** — two names can collapse to one branch; the
  user is never told the branch differs from the name typed.
- **Default-branch fetch is best-effort but the whole staleness defence depends on it** — a
  transient failure silently degrades the "ride-along" check.
- **No concurrency lock on the shared repo** — multiple `_close`/`prepare` ops run in
  executors hitting the same repo (`branch -f`, `worktree add/remove`, `fetch`) with no
  serialisation; concurrent `worktree` ops can race git's metadata.

### 1.3 The conceptual model

**1 workspace = 1 git worktree = 1 branch = 1 dir at `<repo>.worktrees/<branch>`**, with
the workspace name driving the branch via a lossy sanitiser. A workspace is a thin,
nearly-stateless wrapper: `prepare()` provisions the checkout and records just enough meta
(`repo`, `branch`, `worktree_path`, `source`, optional `base`); `cleanup()` removes the
checkout but **never the branch**. This is clean and composable (kinds are pluggable
ports) but rigid and one-directional in three ways:

1. It models *checking out* a branch but has **no notion of *finishing* one** (no
   push/PR/merge/delete-branch) — work flows in but never out.
2. It's strictly 1:1:1 — no shared-branch, base-switch, or rebase concept, so anything
   long-lived drifts.
3. The app's record set is the **only inventory** — any crash, manual edit, or "Keep"
   close permanently desyncs the model from git's reality with no recovery UI.

It's excellent at the create-and-discard path it was designed for and absent everywhere
a worktree is meant to *outlive* a single session.

---

## Part 2 — How the field does it

Tools reviewed: **Emdash**, **Augment Code** (Intent / Cosmos / Auggie), **Conductor**,
**Crystal → Nimbalyst**, **vibe-kanban**, **Claude Squad**, **Sculptor**, **container-use**,
and **Anthropic's native Claude Code worktrees**.

### 2.1 Unit-of-work model — near-universal

One **task = one git worktree = one branch = one agent session**. Branch naming is
`category/<slug>`: `agent/TASK-123` (Augment), `emdash/<slug>-<shortid>` /
`task/…` / `feature/…` (Emdash), `worktree-<value>` (Anthropic). Worktrees usually live in
an **out-of-repo pool** keyed by project rather than nested in the checkout.

- Emdash disk layout (source-verified): `<worktreeDir>/<project>/<branchCategory>/<branch>`;
  default `worktreeDir` is `~/emdash/worktrees` locally, `.emdash/worktrees` over SSH.
  [[Emdash worktree-service.ts]][e-wt] [[Emdash docs/tasks]][e-tasks]
- Augment Intent: "one logical Space = one git worktree = one dedicated branch," dirs like
  `.trees/TASK-123`. [[Augment worktrees guide]][a-wt]
- Anthropic native: `.claude/worktrees/<value>/`, branch `worktree-<value>`; PR mode
  `claude --worktree "#1234"` fetches `pull/<n>/head` into `pr-<number>`. Recommends adding
  `.claude/worktrees/` to `.gitignore`. [[Anthropic worktrees]][an-wt]
- container-use puts agent branches in a dedicated remote namespace `container-use` so they
  don't pollute the normal branch list. [[container-use]][cu-gh]

### 2.2 The merge-back loop closes via PR

The canonical backflow everywhere is **Commit → Push → Create PR**, reviewed on GitHub,
with the human owning the merge; agents "can only open PRs, not force-push."

- Emdash diff view offers **Commit / Commit & Push / Commit & Create PR**, then surfaces CI
  checks and merge state in-app. [[Emdash diff view]][e-diff]
- Augment Remote Agents open **review-ready PRs**; branch protection allows PR-only, no
  force-push; "you still own the merge decision." [[Augment remote agents]][a-remote]
  [[Depot sandboxes]][depot]
- vibe-kanban auto-opens PRs with **AI-composed descriptions**. [[vibe-kanban]][vk-gh]
- container-use splits **`cu merge` (keep history)** vs **`cu apply` (squash the diff)** —
  an explicit history-vs-patch choice at integration. *(Exact semantics inferred from
  release notes + naming; confirm via `--help`.)* [[container-use]][cu-gh]
- Sculptor / Conductor instead **sync the agent's container/worktree back into your real
  local repo** ("Pairing Mode" / "Spotlight testing"), letting you test in your normal env
  and merge selectively; Sculptor **auto-flags conflicts and can hand them back to the
  agent**. [[Sculptor]][sculptor] [[Conductor]][conductor]

### 2.3 Env bootstrapping into worktrees — a first-class feature

A fresh worktree is a clean checkout, so gitignored `.env`/`node_modules`/secrets are
absent and it often can't run. The fix everyone adopts: **copy only gitignored-and-matched
files** into each new worktree (tracked files are never duplicated).

- Anthropic `.worktreeinclude` (`.gitignore` syntax; copies only matched **and** gitignored
  files). [[Anthropic worktrees]][an-wt]
- Emdash "preserved files" — `preservePatterns` globs copy untracked local files (`.env`,
  certs), explicitly skipping tracked paths. (source-verified) [[Emdash worktree-service.ts]][e-wt]
- Containerised tools (Sculptor, container-use) sidestep it entirely — deps baked into the
  image once. [[Sculptor]][sculptor] [[container-use]][cu-gh]

### 2.4 Per-worktree runtime (ports, dev servers, env)

Worktrees isolate **files**, not **ports/processes/env** — "two agents in separate worktrees
will still collide on port 3000" (Augment's own caveat). Mitigations:

- Emdash injects **`EMDASH_PORT = 50000 + (hash(path)%1000)*10`** plus `EMDASH_TASK_ID/NAME/
  PATH/ROOT_PATH/DEFAULT_BRANCH` per task — stable, collision-free dev-server ports with
  zero coordination. (source-verified) [[Emdash workspace-env.ts]][e-env]
- vibe-kanban gives each workspace "**a branch, a terminal, and a dev server**" plus a
  built-in browser with devtools/inspect/device-emulation — turning N variants into live
  side-by-side testing. [[vibe-kanban]][vk-gh] [[vibe-kanban deep-dive]][vk-blog]
- Augment explicitly flags ports/processes/env as the worktree model's weak spot.
  [[Augment worktrees guide]][a-wt]

### 2.5 Durable fork point & status

- Emdash stores the base at creation via **`git config branch.<name>.base <baseRef>`**
  (e.g. `origin/main`) → unambiguous ahead/behind and PR base later. (source-verified)
  [[Emdash worktree-service.ts]][e-wt]
- Diff/status panes with **ahead/behind**, dirty/staged/conflicted file icons, and PR
  checks are near-universal review surfaces (Emdash, vibe-kanban, Crystal, Claude Squad).
  [[Emdash diff view]][e-diff] [[Claude Squad worktrees]][cs-wiki]

### 2.6 Lifecycle hygiene — Anthropic's model is the gold standard

- **Conditional auto-cleanup on exit:** clean worktree (no uncommitted/untracked/new
  commits) → auto-removed; dirty → prompt keep-or-remove.
- **Stale-worktree GC sweep** after `cleanupPeriodDays`, **only if clean**; manually-named
  `--worktree` worktrees are **never** swept (explicit work is protected).
- **`git worktree lock` while an agent runs** so the GC can't remove a live one.
- Worktrees branch from `origin/HEAD` by default; `worktree.baseRef: "head"` to carry
  unpushed commits; non-interactive (`-p`) runs are **not** auto-cleaned (a known gotcha).
  [[Anthropic worktrees]][an-wt]
- Emdash validates-before-reuse (`worktree list --porcelain` + linked-`.git` check), runs
  `git worktree prune` after every remove and on startup, and **serialises git ops** through
  an internal queue to avoid concurrent-git races. (source-verified) [[Emdash worktree-service.ts]][e-wt]

### 2.7 Orchestration UX & the "N variants" pattern

- **Kanban board → workspaces** (vibe-kanban): plan → in-progress → review (diff + inline
  comments) → merged. [[vibe-kanban]][vk-gh]
- **Session list / tabs** with a diff-review pane (Conductor, Emdash, Crystal, Sculptor);
  **TUI switcher with preview/diff tabs** (Claude Squad). [[Conductor]][conductor]
  [[Claude Squad]][cs-gh]
- **Plan-approve-execute-verify** (Augment Intent): a **Coordinator** proposes a spec → human
  approves → **Implementor** agents run in waves (one worktree each) → a **Verifier** checks
  against the spec → hands back to the human. A **"living spec"** file is the shared
  coordination artifact. [[Augment Intent]][a-intent] [[Augment Cosmos]][a-cosmos]
- **"Run N variants of the same prompt, compare, pick one"** is the headline value-add —
  Crystal's entire reason to exist; also Conductor ("Claude and Codex on the same prompt in
  different tabs"), container-use, and Anthropic's own best-practices (3–5 worktrees = "the
  single biggest productivity unlock"). [[Crystal]][crystal] [[Anthropic best practices]][an-bp]
- **Universal caution:** parallelism multiplies **review load and token cost** — "four
  parallel agents potentially mean four times as many bugs to catch." Sculptor's
  **Instruction Audits** (plain-English rules auto-checked against the diff) are one
  pre-human-gate mitigation. [[Conductor]][conductor] [[Sculptor]][sculptor]

### 2.8 Isolation depth — a spectrum

| Depth | Tools | Isolates | Doesn't isolate |
|---|---|---|---|
| **Bare worktree** (us) | Anthropic native, Conductor, Crystal, Claude Squad, vibe-kanban, Emdash, Augment Intent | file edits, branch | host env, deps, ports, secrets — agents share the machine |
| **Containerised** | Sculptor, container-use | filesystem, deps, processes, ports | (cloud not required) |
| **Cloud sandbox** | Augment Remote Agents / Cosmos, Claude Code on web | everything, off your machine | — |

Sources: [[Sculptor]][sculptor], [[container-use]][cu-gh], [[Augment remote agents]][a-remote],
[[Depot sandboxes]][depot].

---

## Part 3 — Recommendations (tuned to this app)

We already have a **PR inbox** (`github/pulls`), a **repos index**, and a **pipeline engine
with fan-out** — unusual leverage that makes several "borrow" ideas nearly free.

### Tier 1 — high value, low effort

1. **Preserved-files copy** in `WorktreeKind.prepare()` — copy gitignored-and-matched files
   (`.env`, `.env.local`, certs) into the new worktree via a `preserve` glob list. Fixes
   "the worktree won't run." (Anthropic `.worktreeinclude` / Emdash preserved files.)
2. **Deterministic per-worktree `PORT`** injected into the session env (hash of the worktree
   path). Stops parallel dev-server collisions; pairs with the 3D "one room per stage" view.
   (Emdash `EMDASH_PORT`.)
3. **Git status on the tab** — `git status --porcelain` + `rev-list --count` for
   ahead/behind/dirty, shown as a small badge, instead of discovering dirty state only on
   close.

### Tier 2 — close the loop (the real gap)

4. **A "finish" action: Commit → Push → Create PR**, wired into the existing PR inbox. Even a
   minimal `gh pr create` makes worktrees a round trip. (Universal pattern.)
5. **Branch lifecycle on close** — offer *remove worktree **and** delete branch* vs *keep*,
   and adopt the **clean-vs-dirty** rule (auto-remove clean, prompt dirty, protect named,
   `git worktree lock` while running). Stops orphan-branch accumulation. (Anthropic model.)

### Tier 3 — robustness / scale

6. **A "Worktrees" view** backed by `git worktree list --porcelain`, with **reconciliation**
   (adopt orphans, GC stale *clean* ones) — fixes crash desync. (Emdash validate-before-reuse.)
7. **Serialise git ops per repo** (async lock around `prepare`/`cleanup`/`fetch`) — fixes the
   concurrent-`worktree` races. (Emdash `enqueueGitOp`.)
8. **Base-refresh / rebase action** using a stored fork point (adopt `git config
   branch.<name>.base`) so long-lived worktrees don't silently drift. (Emdash base config.)

### Where we can leapfrog

- **Pipeline fan-out + worktrees** is exactly the "run N variants, compare" pattern everyone
  wants — spawn K worktrees from one DSL and diff them.
- The **3D WorldView** is a genuinely novel orchestration UX no competitor has.

---

## Sources

Internal audit references this repository's source directly (file:line cited inline). External
findings below; where a claim was verified against a tool's source code it is noted inline as
"source-verified," and unverifiable/marketing claims are flagged in-text.

**Emdash**
- [Repo — generalaction/emdash](https://github.com/generalaction/emdash) [e-gh]
- [`worktree-service.ts` (add/remove/prune/list, base config, preserved files)](https://github.com/generalaction/emdash/blob/main/apps/emdash-desktop/src/main/core/projects/worktrees/worktree-service.ts) [e-wt]
- [`workspace-env.ts` (EMDASH_PORT + env)](https://github.com/generalaction/emdash/blob/main/apps/emdash-desktop/src/main/core/workspaces/workspace-env.ts) [e-env]
- [Docs — Tasks](https://emdash.sh/docs/tasks) [e-tasks] · [Docs — Diff View](https://emdash.sh/docs/diff-view) [e-diff]
- [Show HN (perf/reserve-pool/`.emdash.json` — author-stated)](https://news.ycombinator.com/item?id=47140322)

**Augment Code**
- [Intent — a workspace for agent orchestration](https://www.augmentcode.com/blog/intent-a-workspace-for-agent-orchestration) [a-intent]
- [Git worktrees for parallel AI agents (incl. limitations)](https://www.augmentcode.com/guides/git-worktrees-parallel-ai-agent-execution) [a-wt]
- [Remote Agents product](https://www.augmentcode.com/product/remote-agents) [a-remote]
- [Cosmos — the platform for AI-native engineering teams](https://www.augmentcode.com/blog/cosmos-the-platform-for-ai-native-engineering-teams) [a-cosmos]
- [Depot remote-agent sandboxes (container specs)](https://depot.dev/blog/now-available-remote-agent-sandboxes) [depot]
- [Auggie CLI docs](https://docs.augmentcode.com/cli/overview)

**Anthropic / Claude Code**
- [Run parallel sessions with worktrees](https://code.claude.com/docs/en/worktrees) [an-wt]
- [Best practices for Claude Code](https://www.anthropic.com/engineering/claude-code-best-practices) [an-bp]

**Landscape**
- [Conductor (conductor.build)](https://www.conductor.build/) [conductor]
- [Crystal — stravu/crystal (→ Nimbalyst)](https://github.com/stravu/crystal) [crystal]
- [vibe-kanban — BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) [vk-gh] · [Deep-dive](https://starlog.is/articles/ai-dev-tools/bloopai-vibe-kanban/) [vk-blog]
- [Claude Squad — smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad) [cs-gh] · [Worktree management (deepwiki)](https://deepwiki.com/smtg-ai/claude-squad/4.1-git-worktree-management) [cs-wiki]
- [Sculptor (Imbue)](https://imbue.com/sculptor/) [sculptor]
- [container-use — dagger/container-use](https://github.com/dagger/container-use) [cu-gh]
- [workmux (worktree + tmux pattern)](https://github.com/raine/workmux)

[e-gh]: https://github.com/generalaction/emdash
[e-wt]: https://github.com/generalaction/emdash/blob/main/apps/emdash-desktop/src/main/core/projects/worktrees/worktree-service.ts
[e-env]: https://github.com/generalaction/emdash/blob/main/apps/emdash-desktop/src/main/core/workspaces/workspace-env.ts
[e-tasks]: https://emdash.sh/docs/tasks
[e-diff]: https://emdash.sh/docs/diff-view
[a-intent]: https://www.augmentcode.com/blog/intent-a-workspace-for-agent-orchestration
[a-wt]: https://www.augmentcode.com/guides/git-worktrees-parallel-ai-agent-execution
[a-remote]: https://www.augmentcode.com/product/remote-agents
[a-cosmos]: https://www.augmentcode.com/blog/cosmos-the-platform-for-ai-native-engineering-teams
[depot]: https://depot.dev/blog/now-available-remote-agent-sandboxes
[an-wt]: https://code.claude.com/docs/en/worktrees
[an-bp]: https://www.anthropic.com/engineering/claude-code-best-practices
[conductor]: https://www.conductor.build/
[crystal]: https://github.com/stravu/crystal
[vk-gh]: https://github.com/BloopAI/vibe-kanban
[vk-blog]: https://starlog.is/articles/ai-dev-tools/bloopai-vibe-kanban/
[cs-gh]: https://github.com/smtg-ai/claude-squad
[cs-wiki]: https://deepwiki.com/smtg-ai/claude-squad/4.1-git-worktree-management
[sculptor]: https://imbue.com/sculptor/
[cu-gh]: https://github.com/dagger/container-use
