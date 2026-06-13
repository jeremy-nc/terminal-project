"""Bare-PTY backend: a direct ``pty.fork`` + ``execvpe`` of the shell.

This is the original (pre-tmux) terminal backing, preserved verbatim behind
the :class:`~terminal.backends.base.TerminalBackend` port. Selecting this
backend yields byte-identical behaviour to the original SessionManager: the
child execs ``argv`` directly, so the PTY is wired straight to the shell.
"""
import os
import pty
import signal
import sys

from ..pty_utils import set_winsize


class BarePtyBackend:
    name = "bare"

    def spawn(self, sid, argv, cols, rows, cwd=None):
        pid, fd = pty.fork()
        if pid == 0:  # child
            env = os.environ.copy()
            env["TERM"] = "xterm-256color"
            if cwd:
                try:
                    os.chdir(cwd)
                except OSError as e:
                    # Print to stderr (visible in server log), then fall through
                    # to exec so the session still starts (in the original dir).
                    print(f"[pty] chdir({cwd!r}) failed: {e}", file=sys.stderr, flush=True)
            try:
                os.execvpe(argv[0], argv, env)
            except FileNotFoundError:
                os.execvpe("bash", ["bash"], env)
            os._exit(1)
        # parent
        set_winsize(fd, rows, cols)
        os.set_blocking(fd, False)
        return pid, fd

    def kill(self, sess):
        try:
            os.kill(sess.pid, signal.SIGHUP)
        except ProcessLookupError:
            pass

    def shutdown(self, sess):
        try:
            os.kill(sess.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
