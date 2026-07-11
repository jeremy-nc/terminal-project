"""DocsService: watch each open docs directory and broadcast its file tree.

A workspace's "Docs File Explorer" targets a sub-directory of its working dir — today
``docs`` (the UI chooses the sub-path; it may become ``meta/docs`` later). The UI
ref-counts its panels and sends the WHOLE watched set; we keep exactly one OS watcher
per directory and (re)broadcast that dir's tree on any change. So N panels of the same
dir share one watcher, and it stops when the last unmounts (the UI drops it from the
set) — or when the last window disconnects / on shutdown.

Decoupled: no imports from other domains. Events leave through an injected
``broadcast`` callable, marshalled onto the asyncio loop because watchdog fires its
callbacks on a background thread (and ``Subscriber.send`` enqueues to a non-thread-safe
asyncio.Queue). The dict key / broadcast ``dir`` is the EXACT string the UI sent (so the
client can match it); only the filesystem operations expand/resolve it.
"""
import os
import threading

from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

_SKIP_NAMES = {"node_modules", "__pycache__"}   # never list these (plus dotfiles)
_DEBOUNCE = 0.18                                 # seconds — coalesce bursts of FS events per dir


def _build_tree(root: str) -> list:
    """Recursive listing of ``root``: nodes ``{name, type, children?|size}``, dirs
    first then files (name-sorted). Hidden entries + heavy build dirs are skipped."""
    try:
        entries = list(os.scandir(root))
    except OSError:
        return []
    entries.sort(key=lambda e: (not _is_dir(e), e.name.lower()))
    out = []
    for e in entries:
        if e.name.startswith(".") or e.name in _SKIP_NAMES:
            continue
        if _is_dir(e):
            out.append({"name": e.name, "type": "dir", "children": _build_tree(e.path)})
        else:
            try:
                size = e.stat().st_size
            except OSError:
                size = 0
            out.append({"name": e.name, "type": "file", "size": size})
    return out


def _is_dir(entry) -> bool:
    try:
        return entry.is_dir()
    except OSError:
        return False


class _Handler(FileSystemEventHandler):
    def __init__(self, on_change):
        self._on_change = on_change

    def on_any_event(self, event):
        self._on_change()


class DocsService:
    def __init__(self, broadcast):
        self._broadcast = broadcast        # broadcast(event_dict); invoked on the loop thread
        self._loop = None
        self._observer = None
        self._watches = {}                 # key(dir str) -> {watch, handler, target, recursive}
        self._timers = {}                  # key -> threading.Timer (debounce)
        self._lock = threading.RLock()

    def set_loop(self, loop):
        self._loop = loop

    # ── watched set (the UI's ref-counted union; we mirror it 1:1) ─────────────
    def set_watched(self, dirs):
        """Replace the watched set with `dirs`. Start a watcher for each newly-added
        dir (and immediately emit its tree); stop watchers for removed ones."""
        want = {d for d in (dirs or []) if d}
        with self._lock:
            have = set(self._watches)
            for d in have - want:
                self._unwatch(d)
            for d in want - have:
                self._watch(d)
            new = want - have
        for d in new:
            self._emit(d)                  # send the current tree to freshly-opened panels
        return sorted(want)

    def is_allowed(self, path):
        """True if ``path`` resolves INSIDE a currently-watched docs dir. This is the
        security boundary for file read/write: only files under a docs/specs folder
        that the UI has open are reachable — never arbitrary paths (.env, secrets)."""
        if not path:
            return False
        rp = os.path.realpath(os.path.expanduser(path))
        with self._lock:
            roots = [os.path.realpath(os.path.expanduser(d)) for d in self._watches]
        return any(rp == r or rp.startswith(r + os.sep) for r in roots)

    def _target_for(self, d):
        """What to actually hand watchdog: the docs dir itself (recursive) when it
        exists, else its parent (non-recursive) so we notice it being created.
        Returns (target_path, recursive)."""
        rp = os.path.expanduser(d)
        return (rp, True) if os.path.isdir(rp) else (os.path.dirname(rp), False)

    def _watch(self, d):
        if self._observer is None:
            self._observer = Observer()
            self._observer.start()
        target, recursive = self._target_for(d)
        handler = _Handler(lambda dd=d: self._on_change(dd))
        watch = self._schedule(handler, target, recursive)
        self._watches[d] = {"watch": watch, "handler": handler, "target": target, "recursive": recursive}

    def _schedule(self, handler, target, recursive):
        if self._observer is None or not os.path.isdir(target):
            return None
        try:
            return self._observer.schedule(handler, target, recursive=recursive)
        except OSError:
            return None

    def _unwatch(self, d):
        info = self._watches.pop(d, None)
        if info and info["watch"] and self._observer:
            try:
                self._observer.unschedule(info["watch"])
            except Exception:
                pass
        t = self._timers.pop(d, None)
        if t:
            t.cancel()

    def _on_change(self, d):
        # Debounce per-dir (we're on watchdog's thread): coalesce a burst of events.
        with self._lock:
            if d not in self._watches:
                return
            old = self._timers.pop(d, None)
            if old:
                old.cancel()
            t = threading.Timer(_DEBOUNCE, lambda: self._refresh(d))
            self._timers[d] = t
            t.start()

    def _refresh(self, d):
        # The docs dir may have appeared/disappeared — re-point the watch if so, then
        # broadcast the (possibly now empty/populated) tree.
        with self._lock:
            info = self._watches.get(d)
            if info is None:
                return
            self._timers.pop(d, None)
            target, recursive = self._target_for(d)
            if (target, recursive) != (info["target"], info["recursive"]):
                if info["watch"] and self._observer:
                    try:
                        self._observer.unschedule(info["watch"])
                    except Exception:
                        pass
                info["watch"] = self._schedule(info["handler"], target, recursive)
                info["target"], info["recursive"] = target, recursive
        self._emit(d)

    def _emit(self, d):
        rp = os.path.expanduser(d)
        exists = os.path.isdir(rp)
        event = {"type": "docs_tree", "dir": d, "exists": exists,
                 "tree": _build_tree(rp) if exists else []}
        if self._loop is not None:
            self._loop.call_soon_threadsafe(self._broadcast, event)

    def stop_all(self):
        with self._lock:
            for d in list(self._watches):
                self._unwatch(d)
            for t in list(self._timers.values()):
                t.cancel()
            self._timers.clear()
            if self._observer is not None:
                try:
                    self._observer.stop()
                    self._observer.join(timeout=2)
                except Exception:
                    pass
                self._observer = None
