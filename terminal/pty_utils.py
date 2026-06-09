"""Low-level PTY/OS helpers. No transport or asyncio concerns."""
import fcntl
import os
import shutil
import struct
import termios


def set_winsize(fd: int, rows: int, cols: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def resolve_shell(name: str) -> list:
    """Resolve a requested shell name to an argv list, falling back to bash."""
    if name == "claude" and shutil.which("claude"):
        return ["claude"]
    return [os.environ.get("SHELL") or "bash"]
