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

from ..pty_utils import fork_pty
from .macos import open_terminal_run

SOCKET = "nct"
CONF = os.path.join(os.path.dirname(__file__), "tmux.conf")


def _session_name(sid: str) -> str:
    return f"nct-{sid}"


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

    def _tmux(self, *args):
        try:
            subprocess.run(["tmux", "-L", SOCKET, *args], check=False, capture_output=True)
        except FileNotFoundError:
            pass
