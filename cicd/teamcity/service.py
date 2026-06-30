"""TeamCityService: the TeamCity subdomain of the CI/CD domain.

Reads a live build feed and controls builds (trigger / cancel / re-run) on a
TeamCity instance behind Google IAP. Fully self-contained: its own config + its
own Google OAuth credentials, sourced from env vars or an in-app connect form and
persisted to a gitignored ``teamcity.json`` (written 0600). Never references any
external tool's files or tokens.

Config fields (env wins per-field, else the JSON file):
  url           TEAMCITY_URL          e.g. https://upside-ci.com.au
  token         TEAMCITY_TOKEN        a TeamCity access token (profile page)
  oauth_client  TC_IAP_CLIENT_ID/SECRET  Desktop OAuth client for the IAP sign-in
The ``oauth`` creds (refresh token etc.) are obtained via the browser consent and
stored alongside. The HTTP client is sync; the server calls it via to_thread.
"""
import json
import os
from datetime import datetime

import httpx

from .client import TeamCityHTTP
from .iap import creds_from_dict, creds_to_dict, fresh_id_token, run_consent_flow

_BUILD_FIELDS = ("count,build(id,number,status,state,branchName,webUrl,"
                 "queuedDate,startDate,finishDate,buildTypeId,"
                 "buildType(id,name,projectId,projectName))")
_BUILD_LOCATOR = "running:any,canceled:any,failedToStart:any,branch:default:any,count:50"
# Branch query also pulls each build's VCS root, so we can scope to one repo
# (Dependabot reuses identical branch names across repos).
_BRANCH_FIELDS = ("count,build(id,number,status,state,branchName,webUrl,"
                  "queuedDate,startDate,finishDate,buildTypeId,"
                  "buildType(id,name,projectId,projectName),"
                  "revisions(revision(version,vcs-root-instance(name))))")


def _repo_slug(repo: str) -> str:
    """The repo's folder name (== its GitHub repo name for our checkouts), used to
    match a build's VCS root URL — e.g. ``proptrack-integration``."""
    base = os.path.basename((repo or "").rstrip("/"))
    return base[:-4] if base.endswith(".git") else base


def _build_in_repo(build: dict, slug: str) -> bool:
    """True if any of the build's VCS roots is this repo. We match the slug only on
    a path boundary (``/slug#``, ``:slug.git`` …) so ``nct-modern-sdk`` doesn't
    match ``nct-modern-sdk-2``."""
    if not slug:
        return True
    sl = slug.lower()
    bounded = (f"/{sl}#", f"/{sl}.git", f"/{sl}/", f":{sl}#", f":{sl}.git", f":{sl}/")
    for rev in (build.get("revisions") or {}).get("revision", []):
        name = ((rev.get("vcs-root-instance") or {}).get("name") or "").lower()
        if not name:
            continue
        if name.endswith(f"/{sl}") or name.endswith(f":{sl}") or any(b in name for b in bounded):
            return True
        if name.replace(" ", "").replace("-", "") == sl.replace("-", ""):  # named root e.g. "Beholder"
            return True
    return False


def _err(e) -> str:
    if isinstance(e, httpx.HTTPStatusError):
        return f"{e.response.status_code}: {(e.response.text or '')[:200]}"
    return str(e)


def _tc_epoch(s):
    """TeamCity timestamp (``20250621T143000+1000``) → epoch ms, or None."""
    if not s:
        return None
    try:
        return int(datetime.strptime(s, "%Y%m%dT%H%M%S%z").timestamp() * 1000)
    except (ValueError, TypeError):
        return None


class TeamCityService:
    def __init__(self, config_path: str):
        self._config_path = config_path
        self._url = (os.environ.get("TEAMCITY_URL") or "").strip()
        self._token = (os.environ.get("TEAMCITY_TOKEN") or "").strip()
        self._client_id = (os.environ.get("TC_IAP_CLIENT_ID") or "").strip()
        self._client_secret = (os.environ.get("TC_IAP_CLIENT_SECRET") or "").strip()
        self._creds = None          # google OAuth Credentials (our own grant)
        self._builds = []           # cached recent build feed
        self._projects = []         # cached project list (id, name, path) — for the picker
        self._build_types = []      # cached build configs (id, name, project, root) — drives trigger buttons
        self._proj_by_id = {}       # project id -> raw project, for path/root resolution
        self._watched_branches = []  # branches the poller refreshes + broadcasts (ref-counted by the UI)
        self._watched_build_types = []  # (buildTypeId, branch) pairs for the trigger-tile status LEDs
        self._connected = False     # last refresh/connect succeeded
        self._error = None          # last error string (shown in UI)
        self._load()

    # ── config (gitignored teamcity.json) ────────────────────────────────────
    def _load(self):
        if not os.path.exists(self._config_path):
            return
        try:
            with open(self._config_path) as f:
                d = json.load(f) or {}
        except (OSError, ValueError) as e:
            print(f"[teamcity] load failed ({self._config_path}): {e}", flush=True)
            return
        self._url = self._url or (d.get("url") or "").strip()
        self._token = self._token or (d.get("token") or "").strip()
        self._client_id = self._client_id or (d.get("oauth_client_id") or "").strip()
        self._client_secret = self._client_secret or (d.get("oauth_client_secret") or "").strip()
        self._creds = creds_from_dict(d.get("oauth"))

    def _save(self):
        try:
            tmp = self._config_path + ".tmp"
            with open(tmp, "w") as f:
                json.dump({"url": self._url, "token": self._token,
                           "oauth_client_id": self._client_id,
                           "oauth_client_secret": self._client_secret,
                           "oauth": creds_to_dict(self._creds) if self._creds else None}, f)
            os.replace(tmp, self._config_path)
            try:
                os.chmod(self._config_path, 0o600)   # secrets — owner only
            except OSError:
                pass
        except OSError as e:
            print(f"[teamcity] save failed ({self._config_path}): {e}", flush=True)

    def set_config(self, url=None, token=None, client_id=None, client_secret=None):
        """Persist connection settings from the in-app form (any subset)."""
        if url is not None:
            self._url = url.strip()
        if token is not None:
            self._token = token.strip()
        if client_id is not None:
            self._client_id = client_id.strip()
        if client_secret is not None:
            self._client_secret = client_secret.strip()
        self._save()

    # ── auth ──────────────────────────────────────────────────────────────────
    def _iap_token(self):
        """A fresh IAP id_token from our creds; persists the creds if refreshed."""
        tok, refreshed = fresh_id_token(self._creds)
        if refreshed:
            self._save()
        return tok

    def _http(self):
        return TeamCityHTTP(self._url, self._token, self._iap_token)

    def has_oauth_client(self) -> bool:
        return bool(self._client_id and self._client_secret)

    def has_creds(self) -> bool:
        return self._creds is not None

    def configured(self) -> bool:
        """Enough to attempt calls: a URL, a TeamCity token, and OAuth creds."""
        return bool(self._url and self._token and self._creds)

    def connect(self):
        """BLOCKING browser consent → store our own OAuth creds, then refresh.
        Returns {ok} | {ok:false, error}."""
        if not self.has_oauth_client():
            return {"ok": False, "error": "set the Google OAuth client id/secret first"}
        try:
            self._creds = run_consent_flow(self._client_id, self._client_secret)
            self._save()
        except Exception as e:
            return {"ok": False, "error": _err(e)}
        self.refresh()
        return {"ok": True} if self._connected else {"ok": False, "error": self._error}

    # ── reads ──────────────────────────────────────────────────────────────────
    def refresh(self):
        """Re-fetch the recent-build feed into the cache. Sets connected/error."""
        if not self.configured():
            self._connected = False
            return self._builds
        try:
            data = self._http().get("/app/rest/builds",
                                    params={"locator": _BUILD_LOCATOR, "fields": _BUILD_FIELDS})
            self._builds = [self._row(b) for b in (data.get("build") or [])]
            if not self._projects:        # load the project list once, on first connect
                self._fetch_projects()
            if not self._build_types:     # and the build configs (drives the trigger buttons)
                self._fetch_build_types()
            self._connected = True
            self._error = None
        except Exception as e:
            self._connected = False
            self._error = _err(e)
            print(f"[teamcity] refresh failed: {self._error}", flush=True)
        return self._builds

    def _fetch_projects(self):
        """Cache the full project list (id + readable path) for the picker. The
        path mirrors the feed's project names (``Monolith / Build / …``)."""
        try:
            data = self._http().get("/app/rest/projects",
                                    params={"locator": "count:5000",
                                            "fields": "project(id,name,parentProjectId,archived)"})
        except Exception as e:
            print(f"[teamcity] projects: {_err(e)}", flush=True)
            return
        raw = data.get("project") or []
        by_id = {p["id"]: p for p in raw}
        self._proj_by_id = by_id      # kept so build types can resolve their root project

        def path(p):
            parts, cur = [], p
            while cur and cur.get("id") != "_Root":
                parts.append(cur.get("name") or cur["id"])
                cur = by_id.get(cur.get("parentProjectId"))
            return " / ".join(reversed(parts))

        def proj(p):
            r = self._root_of(p.get("id"), by_id)   # top-level project (under _Root)
            return {"id": p["id"], "name": p.get("name"), "path": path(p),
                    "rootId": r.get("id"), "rootName": r.get("name")}

        self._projects = sorted(
            (proj(p) for p in raw if p.get("id") != "_Root" and not p.get("archived")),
            key=lambda p: p["path"].lower())

    @staticmethod
    def _root_of(project_id, by_id):
        """The top-level project (directly under ``_Root``) that contains
        ``project_id`` — used to scope build configs to one project tree, since a
        sub-project name (e.g. 'Ray White Development') can repeat across projects."""
        cur = by_id.get(project_id)
        while cur:
            par = cur.get("parentProjectId")
            if not par or par == "_Root":
                return cur
            nxt = by_id.get(par)
            if not nxt:
                return cur
            cur = nxt
        return {}

    def _fetch_build_types(self):
        """Cache every build configuration (id, name, immediate project, top-level
        project) so the client can offer one-click trigger buttons for known configs
        without a per-widget fetch. Loaded once on connect, alongside the projects."""
        try:
            data = self._http().get("/app/rest/buildTypes",
                                    params={"locator": "count:5000",
                                            "fields": "buildType(id,name,projectId,projectName)"})
        except Exception as e:
            print(f"[teamcity] build types: {_err(e)}", flush=True)
            return
        by_id = self._proj_by_id
        out = []
        for bt in (data.get("buildType") or []):
            pid = bt.get("projectId")
            p = by_id.get(pid) or {}
            r = self._root_of(pid, by_id)
            # TeamCity's buildType.projectName is the full PATH; use the authoritative
            # immediate project name from the project map so sub-project matching works.
            out.append({"id": bt.get("id"), "name": bt.get("name"), "projectId": pid,
                        "projectName": p.get("name") or bt.get("projectName"),
                        "rootId": r.get("id"), "rootName": r.get("name")})
        self._build_types = out

    def branch_builds(self, branch: str, repo: str = "", count: int = 25):
        """Recent builds for one VCS branch in a SPECIFIC repo, newest first.
        Scoped by the repo's VCS root because Dependabot reuses identical branch
        names across repos. Overfetches when a repo is given (a popular branch name
        spans many repos) then keeps only this repo's builds."""
        if not branch or not self.configured():
            return []
        n = 100 if repo else count
        locator = (f"branch:(name:{branch}),running:any,canceled:any,"
                   f"failedToStart:any,count:{n}")
        try:
            data = self._http().get("/app/rest/builds",
                                    params={"locator": locator, "fields": _BRANCH_FIELDS})
        except Exception as e:
            print(f"[teamcity] branch builds {branch}: {_err(e)}", flush=True)
            return []
        builds = data.get("build") or []
        if repo:
            slug = _repo_slug(repo)
            builds = [b for b in builds if _build_in_repo(b, slug)]
        return [self._row(b) for b in builds[:count]]

    # ── watched branches (the poller's union, ref-counted by the UI) ──────────
    def set_watched_branches(self, watched):
        """Replace the watched set. Each entry is ``{branch, repo}`` — repo scopes
        the query (see branch_builds). In-memory only: ephemeral UI state (which
        branch panels are open), rebuilt as they mount."""
        out = []
        for w in (watched or []):
            if isinstance(w, dict) and w.get("branch"):
                out.append({"branch": str(w["branch"]), "repo": str(w.get("repo") or "")})
        self._watched_branches = out
        return out

    def watched_branches(self):
        return list(self._watched_branches)

    # ── watched build configs (the trigger tiles' status LEDs, ref-counted) ───
    def set_watched_build_types(self, watched):
        """Replace the watched ``(buildTypeId, branch)`` set that drives the trigger
        tiles' status LEDs. In-memory UI state, rebuilt as tiles mount."""
        out = []
        for w in (watched or []):
            if isinstance(w, dict) and w.get("buildTypeId") and w.get("branch"):
                out.append({"buildTypeId": str(w["buildTypeId"]), "branch": str(w["branch"])})
        self._watched_build_types = out
        return out

    def watched_build_types(self):
        return list(self._watched_build_types)

    def build_type_status(self, build_type_id: str, branch: str):
        """The current status of ONE config on ONE branch, or None. Checks the build
        QUEUE first (a queued build is the most current state, and ``/app/rest/builds``
        does NOT return queued builds), then falls back to the latest running/finished
        build. Not repo-scoped — a config's status is unambiguous by its own id, and
        deploy/terraform configs frequently build a different VCS root than the app."""
        if not build_type_id or not branch or not self.configured():
            return None
        http = self._http()
        # 1. Queued? The queue is a separate resource; match the branch client-side.
        try:
            q = http.get("/app/rest/buildQueue",
                         params={"locator": f"buildType:(id:{build_type_id})", "fields": _BUILD_FIELDS})
            for qb in (q.get("build") or []):
                if (qb.get("branchName") or "") == branch:
                    return self._row(qb)   # state == "queued"
        except Exception as e:
            print(f"[teamcity] queue {build_type_id}@{branch}: {_err(e)}", flush=True)
        # 2. Else the latest running/finished build on this branch.
        locator = (f"buildType:(id:{build_type_id}),branch:(name:{branch}),"
                   f"running:any,canceled:any,failedToStart:any,count:1")
        try:
            data = http.get("/app/rest/builds",
                            params={"locator": locator, "fields": _BUILD_FIELDS})
        except Exception as e:
            print(f"[teamcity] build type status {build_type_id}@{branch}: {_err(e)}", flush=True)
            return None
        builds = data.get("build") or []
        return self._row(builds[0]) if builds else None

    def project_builds(self, project_id: str, count: int = 50):
        """Recent builds for one project (including its sub-projects), newest first."""
        if not project_id or not self.configured():
            return []
        locator = (f"affectedProject:(id:{project_id}),running:any,canceled:any,"
                   f"failedToStart:any,branch:default:any,count:{count}")
        try:
            data = self._http().get("/app/rest/builds",
                                    params={"locator": locator, "fields": _BUILD_FIELDS})
            return [self._row(b) for b in (data.get("build") or [])]
        except Exception as e:
            print(f"[teamcity] project builds {project_id}: {_err(e)}", flush=True)
            return []

    @staticmethod
    def _row(b: dict) -> dict:
        bt = b.get("buildType") or {}
        return {"id": b.get("id"), "number": b.get("number"),
                "status": b.get("status"), "state": b.get("state"),
                "branch": b.get("branchName"), "webUrl": b.get("webUrl"),
                "buildTypeId": b.get("buildTypeId") or bt.get("id"),
                "name": bt.get("name"), "project": bt.get("projectName"),
                "projectId": bt.get("projectId"),
                "started": _tc_epoch(b.get("startDate")),
                "finished": _tc_epoch(b.get("finishDate")),
                "queued": _tc_epoch(b.get("queuedDate")),
                # commit SHA (only present on the branch query, which fetches revisions)
                "revision": (((b.get("revisions") or {}).get("revision") or [{}])[0] or {}).get("version")}

    # ── writes ──────────────────────────────────────────────────────────────────
    def trigger(self, build_type_id: str, branch: str = None):
        """Queue a build of ``build_type_id`` (optionally on ``branch``)."""
        if not build_type_id:
            return {"ok": False, "error": "missing build type id"}
        body = {"buildType": {"id": build_type_id}}
        if branch:
            body["branchName"] = branch
        try:
            r = self._http().post("/app/rest/buildQueue", json_body=body)
            return {"ok": True, "id": r.get("id")}
        except Exception as e:
            return {"ok": False, "error": _err(e)}

    def cancel(self, build_id, state: str = "", comment: str = "stopped from terminal app"):
        """Stop a running build or remove a queued one."""
        if not build_id:
            return {"ok": False, "error": "missing build id"}
        base = "/app/rest/buildQueue" if state == "queued" else "/app/rest/builds"
        try:
            self._http().post(f"{base}/id:{build_id}",
                              json_body={"comment": comment, "readdIntoQueue": False})
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": _err(e)}

    def rerun(self, build_id):
        """Re-run a build: look up its config + branch, then queue a fresh build."""
        if not build_id:
            return {"ok": False, "error": "missing build id"}
        try:
            b = self._http().get(f"/app/rest/builds/id:{build_id}",
                                 params={"fields": "buildTypeId,branchName"})
        except Exception as e:
            return {"ok": False, "error": _err(e)}
        return self.trigger(b.get("buildTypeId"), b.get("branchName"))

    # ── broadcast shape (never any secret) ───────────────────────────────────
    def to_json(self) -> dict:
        return {"configured": self.configured(), "connected": self._connected,
                "url": self._url, "hasToken": bool(self._token),
                "hasOauthClient": self.has_oauth_client(), "hasCreds": self.has_creds(),
                "builds": self._builds, "projects": self._projects,
                "buildTypes": self._build_types, "error": self._error}
