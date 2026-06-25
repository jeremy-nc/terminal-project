"""Low-level PTY/OS helpers. No transport or asyncio concerns."""
import fcntl
import os
import pty
import pwd
import shutil
import struct
import sys
import termios


def set_winsize(fd: int, rows: int, cols: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def fork_pty(argv: list, cols: int, rows: int, cwd: str = None) -> tuple:
    """Fork a PTY, exec ``argv`` (chdir to ``cwd`` first if given), and return
    ``(pid, master_fd)`` with the fd sized to cols/rows and set non-blocking.

    Shared by every terminal backend: the fork/exec mechanics are identical
    across backings — only the ``argv`` a backend hands in differs (a bare
    shell vs. a ``tmux new-session`` wrapper). Falls back to bash if argv[0]
    isn't found."""
    pid, fd = pty.fork()
    if pid == 0:  # child
        env = os.environ.copy()
        env["TERM"] = "xterm-256color"
        if cwd:
            try:
                os.chdir(cwd)
            except OSError as e:
                # Print to stderr (visible in server log), then fall through to
                # exec so the session still starts (in the original dir).
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


def resolve_shell(name: str) -> list:
    """Resolve a requested shell name to an argv list, falling back to bash.

    For an interactive shell, use the user's LOGIN shell from their OS account
    (e.g. /bin/zsh) — correct regardless of how this server was launched. ($SHELL
    only reflects the launching process's shell, so a server started from bash
    would otherwise spawn bash and miss the user's zsh config.)"""
    if name == "claude" and shutil.which("claude"):
        return ["claude"]
    shell = None
    try:
        shell = pwd.getpwuid(os.getuid()).pw_shell    # the account's configured login shell
    except (KeyError, OSError):
        pass
    return [shell or os.environ.get("SHELL") or "bash"]
