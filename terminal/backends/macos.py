"""macOS helpers for launching the native Terminal.app.

Used by backends' ``native_handoff``. All commands run via ``subprocess`` with
list arguments (no shell), so caller-supplied paths can't inject. The one
AppleScript path interpolates only backend-controlled, charset-safe strings
(a tmux session name derived from a uuid hex).
"""
import shutil
import subprocess
import sys


def _require_macos() -> None:
    if sys.platform != "darwin":
        raise RuntimeError("Open in Terminal is only supported on macOS")


def open_terminal_at(cwd: str = None) -> None:
    """Open a new Terminal.app window running a login shell, in ``cwd`` if given."""
    _require_macos()
    args = ["open", "-a", "Terminal"]
    if cwd:
        args.append(cwd)
    subprocess.run(args, check=True, capture_output=True)


def open_terminal_run(command: str) -> None:
    """Open a new Terminal.app window and run ``command`` in it (via AppleScript)."""
    _require_macos()
    if not shutil.which("osascript"):
        raise RuntimeError("osascript not found")
    subprocess.run(
        [
            "osascript",
            "-e", f'tell application "Terminal" to do script "{command}"',
            "-e", 'tell application "Terminal" to activate',
        ],
        check=True,
        capture_output=True,
    )
