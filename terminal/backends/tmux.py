"""tmux-backed terminal backend.

Sessions live inside an isolated tmux server, so the *same* live session can be
driven from the browser PTY and a native Terminal.app window at once. The
browser is just one attached client; the button opens a second.

Isolation: a dedicated socket (``-L nct``) plus a bundled minimal config keep
these sessions out of the user's own tmux. Sizing is pinned
(``window-size largest``, see tmux.conf) so attaching a second client of a
different size doesn't renegotiate/redraw the grid — the browser drives the
size and a smaller native window just shows a viewport.
"""
import os
import subprocess
import tempfile

from ..pty_utils import fork_pty
from .macos import open_terminal_run

SOCKET = "nct"
CONF = os.path.join(os.path.dirname(__file__), "tmux.conf")


def _session_name(sid: str) -> str:
    return f"nct-{sid}"


def _capfile(sid: str) -> str:
    return os.path.join(tempfile.gettempdir(), f"nct-cap-{sid}.out")


class TmuxBackend:
    name = "tmux"

    def spawn(self, sid, argv, cols, rows, cwd=None):
        # Wrap the shell in `tmux new-session` on our private socket/config. The
        # child execs tmux, which becomes the attached client; the real shell
        # runs one level down, owned by the tmux server (hence shareable).
        wrapped = [
            "tmux", "-L", SOCKET, "-f", CONF,
            "new-session", "-A", "-s", _session_name(sid),
            "--", *argv,
        ]
        return fork_pty(wrapped, cols, rows, cwd)

    def kill(self, sess):
        # Kill the tmux *session* — not just our client. The attached browser
        # client then exits, EOFs its PTY, and the manager emits the exit.
        self._tmux("kill-session", "-t", _session_name(sess.id))

    def shutdown(self, sess):
        self._tmux("kill-session", "-t", _session_name(sess.id))

    def native_handoff(self, sess):
        open_terminal_run(f"tmux -L {SOCKET} attach -t {_session_name(sess.id)}")

    # ── pipeline-node capture ────────────────────────────────────────────────
    def spawn_captured(self, sid, argv, cols, rows, cwd=None):
        name = _session_name(sid)
        capfile = _capfile(sid)
        try:
            os.remove(capfile)  # clear any stale file from a reused sid
        except OSError:
            pass
        # 1) Create the session DETACHED first, so it exists on the server
        #    before we tap it — no race against a client still registering it.
        create = ["tmux", "-L", SOCKET, "-f", CONF, "new-session", "-d",
                  "-s", name, "-x", str(cols), "-y", str(rows)]
        if cwd:
            create += ["-c", cwd]
        create += ["--", *argv]
        subprocess.run(create, check=True, capture_output=True)
        # 2) Tap the pane's RAW output (before tmux renders it) into a file —
        #    this is the clean stdout the coordinator pipes downstream.
        subprocess.run(["tmux", "-L", SOCKET, "pipe-pane", "-O", "-t", name,
                        f"cat > '{capfile}'"], check=False, capture_output=True)
        # 3) Fork our PTY as a display client attached to the live session.
        return fork_pty(["tmux", "-L", SOCKET, "attach", "-t", name], cols, rows)

    def read_capture(self, sess):
        # Always return bytes (never None): a tmux session's PTY stream is the
        # rendered screen, so the caller must use this clean tap, not that.
        try:
            with open(_capfile(sess.id), "rb") as f:
                return f.read()
        except OSError:
            return b""

    def end_capture(self, sess):
        # Toggle the pipe off (no-op if the session is already gone) and remove
        # the capture file.
        self._tmux("pipe-pane", "-t", _session_name(sess.id))
        try:
            os.remove(_capfile(sess.id))
        except OSError:
            pass

    def reset_server(self):
        # tmux only reads its config when the server starts, so kill any stale
        # server on our socket; the next session starts a fresh one with -f CONF.
        self._tmux("kill-server")

    def _tmux(self, *args):
        try:
            subprocess.run(["tmux", "-L", SOCKET, *args], check=False, capture_output=True)
        except FileNotFoundError:
            pass
