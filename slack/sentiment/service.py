"""SentimentService: an OPTIONAL, fully-decoupled "is this message important?"
triage for Slack, living as a subdomain of ``slack``.

It never writes onto the raw Slack message — sentiment lives in a SIDE-TABLE
keyed by ``"<channel>:<ts>"`` — so the whole feature is a clean bolt-on: delete
this folder + the one wiring line in ``server.py`` + the frontend store slice and
the Slack domain is byte-for-byte unchanged.

How it gates the model: on every Slack poll the parent domain hands us the
current batch of messages. We diff that against the cache (``_needs``) and call
Claude Haiku ONLY for messages we've never scored — an unchanged poll scores
nothing, so polling frequently costs nothing. A message is scored exactly once
(re-scored only when the user edits their "what matters to me" note, tracked via
``profile_hash``). One batched Haiku call per poll, async, never blocks.

The Anthropic SDK reads the API key from the environment; the call is wrapped
broadly so a bad key / blip can never crash the poll loop — un-scored messages
simply retry on the next poll.
"""
import asyncio
import hashlib
import json
import os
from collections import OrderedDict

_MODEL = "claude-haiku-4-5"     # fast/cheap triage tier (user-chosen)
_MAX_CACHE = 4000               # bound the side-table (LRU eviction)
_MAX_PER_CALL = 120             # cap one batch so a backlog can't blow up a call
_REASON_MAX = 80

_SCHEMA = {
    "type": "object",
    "properties": {
        "results": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "i": {"type": "integer"},
                    "important": {"type": "boolean"},
                    "reason": {"type": "string"},
                },
                "required": ["i", "important", "reason"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["results"],
    "additionalProperties": False,
}

_BASE_SYSTEM = (
    "You triage Slack messages for one busy person. Flag a message as IMPORTANT "
    "when it plausibly needs their attention or action — err toward flagging these "
    "rather than missing them. Importance includes: requests for the user's input, "
    "feedback, review, a survey / form response, or a decision; action items and "
    "direct asks (especially addressed to them or to 'the team') that expect a "
    "response; deadlines or time-sensitive items; deployment / change freezes; "
    "outages and incidents; PSAs and announcements that change plans. When a "
    "message asks the reader to DO or DECIDE something, flag it. Do NOT flag "
    "routine social chatter with no ask: greetings, thanks, acknowledgements, "
    "reactions, jokes, or casual conversation.\n\n"
    "IMPORTANT examples: 'Please fill out this feedback form by Friday' (asks for "
    "your response); 'Thanks for taking part — I want your honest read, please "
    "don't soften it' (requests feedback); 'Prod is down, investigating' "
    "(incident); 'Change freeze starts Monday' (freeze); 'Can someone review my "
    "PR?' (request for action).\n"
    "NOT important examples: 'Morning all', 'thanks!', 'lol same', 'happy "
    "birthday!', a shared meme.\n\n"
    "For each message return `important` (bool) and a `reason` of at most 8 words "
    "explaining the flag — an empty string when not important."
)


def _key(item) -> str:
    return f"{item.get('channel')}:{item.get('ts')}"


class SentimentService:
    def __init__(self, broadcast, config_path: str):
        self._broadcast = broadcast       # Hub.send — fan a wire event to every window
        self._config_path = config_path
        self._enabled = False
        self._note = ""                   # the "what matters to me" note
        self._cache = OrderedDict()       # "channel:ts" -> {important, reason, profile_hash}
        self._client = None               # lazy AsyncAnthropic (no key needed until used)
        self._load()

    # ── config (slack_sentiment.json) ───────────────────────────────────────
    def _load(self):
        if not os.path.exists(self._config_path):
            return
        try:
            with open(self._config_path) as f:
                d = json.load(f) or {}
        except (OSError, ValueError) as e:
            print(f"[sentiment] load failed ({self._config_path}): {e}", flush=True)
            return
        self._enabled = bool(d.get("enabled"))
        self._note = str(d.get("note") or "")

    def _save(self):
        try:
            tmp = self._config_path + ".tmp"
            with open(tmp, "w") as f:
                json.dump({"enabled": self._enabled, "note": self._note}, f)
            os.replace(tmp, self._config_path)
        except OSError as e:
            print(f"[sentiment] save failed ({self._config_path}): {e}", flush=True)

    def enabled(self) -> bool:
        return self._enabled

    @property
    def _profile_hash(self) -> str:
        return hashlib.sha1(self._note.encode("utf-8")).hexdigest()[:8]

    def set_config(self, enabled=None, note=None) -> bool:
        """Update enabled / note (persisted). Returns True when the note CHANGED —
        the caller treats that as a reset (the cache is cleared so stale reasons
        vanish and everything re-scores against the new note)."""
        reset = False
        if note is not None and str(note) != self._note:
            self._note = str(note)
            self._cache.clear()            # profile changed → invalidate every score
            reset = True
        if enabled is not None:
            self._enabled = bool(enabled)
        self._save()
        return reset

    # ── wire events ──────────────────────────────────────────────────────────
    def _config(self) -> dict:
        return {"enabled": self._enabled, "note": self._note}

    def _map(self) -> dict:
        return {k: {"important": v["important"], "reason": v["reason"]}
                for k, v in self._cache.items()}

    def full_event(self) -> dict:
        """The complete state for a freshly-synced window: config + the whole
        side-table, replacing whatever the window held (``reset``)."""
        return {"type": "slack_sentiment", "config": self._config(),
                "sentiments": self._map(), "reset": True}

    def emit_config(self, reset: bool):
        """Broadcast a config change (and, when the note reset the cache, the now-
        empty/cleared map so every window drops stale highlights)."""
        self._broadcast({"type": "slack_sentiment", "config": self._config(),
                         "sentiments": self._map() if reset else {}, "reset": reset})

    # ── scoring ──────────────────────────────────────────────────────────────
    def _needs(self, items):
        """Dedupe the batch and keep only messages with no current score — i.e.
        never seen, or scored under a different note. Empty result → no API call."""
        ph, seen, out = self._profile_hash, set(), []
        for it in items:
            if not it.get("ts") or not (it.get("text") or "").strip():
                continue
            k = _key(it)
            if k in seen:
                continue
            seen.add(k)
            cur = self._cache.get(k)
            if cur is None or cur.get("profile_hash") != ph:
                out.append(it)
        return out

    async def maybe_score(self, items):
        """Score any NEW messages in this batch. No-op when disabled or when the
        diff is empty — this is the gate that keeps frequent polling free."""
        if not self._enabled or not items:
            return
        need = self._needs(items)
        if not need:
            return
        need = need[:_MAX_PER_CALL]
        scored = await self._classify(need)
        if scored:
            self._merge(scored)
            self._broadcast({"type": "slack_sentiment", "config": self._config(),
                             "sentiments": scored, "reset": False})

    def _merge(self, scored):
        ph = self._profile_hash
        for k, v in scored.items():
            self._cache[k] = {**v, "profile_hash": ph}
            self._cache.move_to_end(k)
        while len(self._cache) > _MAX_CACHE:
            self._cache.popitem(last=False)   # evict oldest

    def _system(self) -> str:
        """The triage prompt. With a note set, importance is defined PRIMARILY by
        what the user said matters; without one, the general bar applies."""
        note = self._note.strip()
        if not note:
            return _BASE_SYSTEM
        return (
            "You triage Slack messages for one busy person. The user has given you a "
            "list of the ONLY topics they care about — treat each comma-separated "
            "item as a distinct topic:\n\n"
            f"  \"{note}\"\n\n"
            "Flag a message as IMPORTANT only when it CLEARLY concerns one of those "
            "topics. Interpret each topic generously (synonyms, abbreviations, and "
            "related phrasing for THAT topic count), but stay strictly within the "
            "list. A message that does not clearly match a listed topic is NOT "
            "important — even if it looks urgent, like an outage, incident, error, or "
            "request, do NOT flag it unless it matches one of the user's topics. When "
            "unsure whether a message relates to a topic, do NOT flag it.\n\n"
            "For each message return `important` (bool) and, when important, a "
            "`reason` of at most 8 words that NAMES the matched topic (e.g. "
            "\"matches: deployment/merge freezes\"). Empty reason when not important."
        )

    async def _classify(self, need):
        """One batched Haiku call → {"channel:ts": {important, reason}}. Messages
        are indexed by position so we don't pay tokens echoing ts back. Any failure
        returns {} — the messages stay un-scored and retry next poll."""
        if self._client is None:
            from anthropic import AsyncAnthropic   # lazy: only if the feature is used
            self._client = AsyncAnthropic()

        payload = [{"i": i, "channel": it.get("channel"), "user": it.get("user") or "?",
                    "text": (it.get("text") or "")[:800]} for i, it in enumerate(need)]
        system = self._system()

        try:
            resp = await self._client.messages.create(
                model=_MODEL,
                max_tokens=2048,
                system=system,
                messages=[{"role": "user", "content":
                           "Triage these Slack messages:\n" + json.dumps(payload, ensure_ascii=False)}],
                output_config={"format": {"type": "json_schema", "schema": _SCHEMA}},
            )
            text = next((b.text for b in resp.content if b.type == "text"), "")
            results = (json.loads(text) or {}).get("results", [])
        except Exception as e:
            print(f"[sentiment] classify: {e}", flush=True)
            return {}

        out = {}
        for r in results:
            idx = r.get("i")
            if not isinstance(idx, int) or idx < 0 or idx >= len(need):
                continue
            important = bool(r.get("important"))
            reason = (str(r.get("reason") or "")[:_REASON_MAX]).strip() if important else ""
            out[_key(need[idx])] = {"important": important, "reason": reason}
        return out
