"""SlackService: a small Slack client domain — read (channels, recent messages,
your mentions) and write (post a message), plus an OAuth "Add to Slack" flow.

Secrets (token, the xoxd cookie, OAuth client secret) live in the ``SLACK_*`` env
vars or a gitignored ``slack.json`` (never committed, written 0600) and are never
broadcast. Three ways to connect:
  - OAuth flow  — register an app, click "Add to Slack" (-> user token xoxp-).
  - Paste token — a bot (xoxb-) or user (xoxp-) OAuth token.
  - Browser     — an xoxc- web token + its xoxd- session cookie (no app needed).

The client is synchronous (``slack_sdk.WebClient`` makes blocking HTTP calls), so
the server invokes these methods off the event loop (``asyncio.to_thread``). All
calls catch broadly so a bad token / network blip can never crash the server.
"""
import json
import os
import re
from urllib.parse import urlencode

from slack_sdk import WebClient

# User-token scopes requested by the OAuth "Add to Slack" flow (read history/DMs,
# search your mentions, post as you). Mirror these as User Token Scopes on the app.
SLACK_USER_SCOPES = (
    "channels:read,channels:history,groups:read,groups:history,"
    "im:read,im:history,mpim:read,mpim:history,search:read,users:read,chat:write"
)


_MENTION_RE = re.compile(r"<@([UWB][A-Z0-9]+)>")   # bare user/bot mentions (no |label yet)


def _err(e) -> str:
    """Human-readable error from a SlackApiError (its ``response['error']``) or any
    other exception."""
    r = getattr(e, "response", None)
    try:
        return (r.get("error") if r else None) or str(e)
    except Exception:
        return str(e)


class SlackService:
    def __init__(self, config_path: str):
        self._config_path = config_path
        self._token = (os.environ.get("SLACK_TOKEN") or "").strip()
        self._cookie = (os.environ.get("SLACK_COOKIE") or "").strip()          # xoxd- (browser)
        self._client_id = (os.environ.get("SLACK_CLIENT_ID") or "").strip()
        self._client_secret = (os.environ.get("SLACK_CLIENT_SECRET") or "").strip()
        self._redirect_uri = (os.environ.get("SLACK_REDIRECT_URI") or "").strip()
        self._polled = []                  # channel ids the background poller watches
        self._multiplexers = []            # [{id, name, channels:[ids]}] merged read-only views
        self._load()                       # env wins per-field; else slack.json
        self._client = self._make_client()
        self._channels = []                # cached: [{id, name, is_private}]
        self._user_cache = {}              # user id -> display name
        self._self_id = None               # authenticated user id (for the self-DM)
        self._team_url = ""                # workspace base url (for message permalinks)
        self.refresh()

    def _make_client(self):
        """Build the WebClient. A browser-session ("stealth") ``xoxc-`` token needs
        its matching ``d`` cookie (``xoxd-``) sent as a Cookie header; a bot/user
        token (``xoxb-``/``xoxp-``) authenticates on its own."""
        if not self._token:
            return None
        if self._token.startswith("xoxc") and self._cookie:
            return WebClient(token=self._token, headers={"Cookie": f"d={self._cookie}"})
        return WebClient(token=self._token)

    # ── config (gitignored slack.json) ──────────────────────────────────────
    def _load(self):
        if not os.path.exists(self._config_path):
            return
        try:
            with open(self._config_path) as f:
                d = json.load(f) or {}
        except (OSError, ValueError) as e:
            print(f"[slack] load failed ({self._config_path}): {e}", flush=True)
            return
        self._token = self._token or (d.get("token") or "").strip()
        self._cookie = self._cookie or (d.get("cookie") or "").strip()
        self._client_id = self._client_id or (d.get("client_id") or "").strip()
        self._client_secret = self._client_secret or (d.get("client_secret") or "").strip()
        self._redirect_uri = self._redirect_uri or (d.get("redirect_uri") or "").strip()
        self._polled = d.get("polled") or self._polled
        self._multiplexers = d.get("multiplexers") or self._multiplexers

    def _save(self):
        try:
            tmp = self._config_path + ".tmp"
            with open(tmp, "w") as f:
                json.dump({"token": self._token, "cookie": self._cookie,
                           "client_id": self._client_id, "client_secret": self._client_secret,
                           "redirect_uri": self._redirect_uri, "polled": self._polled,
                           "multiplexers": self._multiplexers}, f)
            os.replace(tmp, self._config_path)
            try:
                os.chmod(self._config_path, 0o600)   # secrets — owner read/write only
            except OSError:
                pass
        except OSError as e:
            print(f"[slack] save failed ({self._config_path}): {e}", flush=True)

    def set_token(self, token: str, cookie: str = ""):
        """Persist a new token (+ optional ``xoxd`` cookie for browser mode) and
        reconnect. Returns the broadcast state."""
        self._token = (token or "").strip()
        self._cookie = (cookie or "").strip()
        self._client = self._make_client()
        self._user_cache.clear()
        self._self_id = None
        self._team_url = ""
        self._save()
        self.refresh()
        return self.to_json()

    def configured(self) -> bool:
        return self._client is not None

    # ── poller subscription (channels watched for new messages) ──────────────
    def set_polled(self, channels):
        """Set the channels the background poller fetches + broadcasts updates for."""
        self._polled = [str(c) for c in (channels or []) if c]
        self._save()
        return self._polled

    def polled(self):
        return list(self._polled)

    def set_multiplexers(self, muxes):
        """Persist the read-only merge views: [{id, name, channels:[ids]}]."""
        out = []
        for m in (muxes or []):
            if not isinstance(m, dict) or not m.get("id"):
                continue
            out.append({"id": str(m["id"]), "name": str(m.get("name") or "Multiplexer"),
                        "channels": [str(c) for c in (m.get("channels") or []) if c]})
        self._multiplexers = out
        self._save()
        return self._multiplexers

    def multiplexers(self):
        return list(self._multiplexers)

    def poll_set(self):
        """Channels the poller should refresh: the pinned set PLUS every channel in
        any multiplexer, deduped."""
        s = set(self._polled)
        for m in self._multiplexers:
            s.update(m.get("channels") or [])
        return list(s)

    # ── OAuth "Add to Slack" flow ────────────────────────────────────────────
    def set_app(self, client_id: str, client_secret: str, redirect_uri: str):
        """Store the OAuth app credentials (Client ID/Secret) + the redirect URI
        registered in the Slack app. Needed before the authorize/exchange steps."""
        self._client_id = (client_id or "").strip()
        self._client_secret = (client_secret or "").strip()
        self._redirect_uri = (redirect_uri or "").strip()
        self._save()

    def has_app(self) -> bool:
        return bool(self._client_id and self._client_secret and self._redirect_uri)

    def authorize_url(self, state: str) -> str:
        """The Slack consent URL to send the user to (requests a USER token)."""
        q = urlencode({"client_id": self._client_id, "user_scope": SLACK_USER_SCOPES,
                       "redirect_uri": self._redirect_uri, "state": state})
        return f"https://slack.com/oauth/v2/authorize?{q}"

    def oauth_exchange(self, code: str):
        """Exchange the OAuth ``code`` for a user token and connect. {ok}|{ok,error}."""
        if not self.has_app():
            return {"ok": False, "error": "oauth app not configured"}
        try:
            resp = WebClient().oauth_v2_access(
                client_id=self._client_id, client_secret=self._client_secret,
                code=code, redirect_uri=self._redirect_uri)
            token = ((resp.get("authed_user") or {}).get("access_token")
                     or resp.get("access_token") or "")
            if not token:
                return {"ok": False, "error": "no token in response"}
            self.set_token(token)          # persists + reconnects + refreshes channels
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": _err(e)}

    # ── reads ────────────────────────────────────────────────────────────────
    def refresh(self):
        """Re-fetch the channel list into the cache. Returns the channels."""
        self._channels = self._fetch_channels()
        return self._channels

    def _fetch_channels(self, limit: int = 200):
        """Channels YOU'RE in (your Slack sidebar), PAGINATED via the cursor so a
        big workspace doesn't truncate the list. We use users.conversations (just
        your channels) rather than conversations.list (every public channel in the
        workspace, which gets cut off by `limit` and drops joined ones)."""
        if not self._client:
            return []
        chans, cursor = [], None
        self_id = self._auth_user_id()
        try:
            while True:
                r = self._client.users_conversations(
                    types="public_channel,private_channel,im",
                    exclude_archived=True, limit=limit, cursor=cursor)
                for c in r.get("channels", []):
                    if c.get("is_archived"):
                        continue
                    if c.get("is_im"):          # ONLY your own DM-to-self, not all DMs
                        if c.get("user") != self_id:
                            continue
                        chans.append({"id": c["id"], "name": self._user_name(self_id) or "you",
                                      "is_private": True, "is_im": True, "is_member": True})
                    else:
                        chans.append({"id": c["id"], "name": c.get("name", c["id"]),
                                      "is_private": bool(c.get("is_private")),
                                      "is_im": False, "is_member": True})
                cursor = (r.get("response_metadata") or {}).get("next_cursor")
                if not cursor:
                    break
            # channels first (alphabetical), then your self-DM at the end.
            chans.sort(key=lambda c: (c.get("is_im", False), c["name"].lower()))
            return chans
        except Exception as e:
            print(f"[slack] channels: {_err(e)}", flush=True)
            return chans

    def channel_messages(self, channel: str, limit: int = 30):
        """Recent messages in a channel, oldest→newest, with resolved author name."""
        if not self._client:
            return []
        try:
            r = self._client.conversations_history(channel=channel, limit=limit)
            out = []
            for m in reversed(r.get("messages", [])):
                if m.get("type") != "message":
                    continue
                out.append({"ts": m.get("ts"), "user": self._user_name(m.get("user")),
                            "text": self._resolve_mentions(m.get("text", ""))})
            return out
        except Exception as e:
            print(f"[slack] history ({channel}): {_err(e)}", flush=True)
            return []

    def my_mentions(self, count: int = 20):
        """Recent messages mentioning you — needs a USER token with ``search:read``."""
        if not self._client:
            return []
        try:
            me = self._client.auth_test().get("user_id")
            r = self._client.search_messages(query=f"<@{me}>", count=count, sort="timestamp")
            return [{"ts": m.get("ts"), "channel": (m.get("channel") or {}).get("name"),
                     "user": m.get("username"), "text": self._resolve_mentions(m.get("text", "")),
                     "permalink": m.get("permalink")}
                    for m in r.get("messages", {}).get("matches", [])]
        except Exception as e:
            print(f"[slack] mentions: {_err(e)}", flush=True)
            return []

    # ── write ────────────────────────────────────────────────────────────────
    def post_message(self, channel: str, text: str):
        """Post a message. Returns {ok, ts} or {ok:false, error}."""
        if not self._client:
            return {"ok": False, "error": "not_configured"}
        try:
            r = self._client.chat_postMessage(channel=channel, text=text)
            return {"ok": True, "ts": r.get("ts")}
        except Exception as e:
            return {"ok": False, "error": _err(e)}

    # ── helpers ──────────────────────────────────────────────────────────────
    def _auth_user_id(self):
        """The authed user's id (cached) — for the self-DM. Captures the workspace
        url too (same auth.test call) so the client can build message permalinks."""
        if self._self_id is None and self._client:
            try:
                r = self._client.auth_test()
                self._self_id = r.get("user_id") or ""
                self._team_url = r.get("url") or ""
            except Exception:
                self._self_id = ""
        return self._self_id or ""

    def team_url(self):
        self._auth_user_id()   # ensures it's populated (cached)
        return self._team_url or ""

    def _resolve_mentions(self, text):
        """Rewrite bare ``<@U123>`` user mentions to ``<@U123|Display Name>`` (using the
        cached name lookup) so the UI can render readable @names. Channel (``<#C…|name>``)
        and special (``<!channel>``) tokens already carry a label / are handled client-side."""
        if not text or "<@" not in text:
            return text
        return _MENTION_RE.sub(lambda m: f"<@{m.group(1)}|{self._user_name(m.group(1))}>", text)

    def _user_name(self, uid):
        if not uid:
            return ""
        if uid not in self._user_cache:
            name = uid
            try:
                p = self._client.users_info(user=uid).get("user", {})
                name = (p.get("profile", {}).get("display_name")
                        or p.get("real_name") or p.get("name") or uid)
            except Exception:
                pass
            self._user_cache[uid] = name
        return self._user_cache[uid]

    def to_json(self):
        """Broadcast shape — NEVER includes any secret."""
        return {"configured": self.configured(), "channels": self._channels,
                "hasApp": self.has_app(), "polled": list(self._polled),
                "multiplexers": list(self._multiplexers), "teamUrl": self.team_url()}
