"""Serve ACP ``terminal/*`` for an agent: run a command as a child process,
capture its merged stdout/stderr up to a byte limit, and report exit status.

Headless — the agent gets output + exit code back over JSON-RPC; live embedding of
the terminal in the UI is a future enhancement. Each process runs in its own
process group so a kill takes down any children it spawned."""
import asyncio
import os
import signal


def _sig_name(n: int) -> str:
    try:
        return signal.Signals(n).name
    except ValueError:
        return str(n)


class AcpTerminal:
    """One running command: pumps merged output into a bounded buffer and tracks
    exit. ``output`` and ``exit_status`` are safe to read at any time."""

    def __init__(self, proc, byte_limit, on_data=None, on_exit=None):
        self.proc = proc
        self.byte_limit = byte_limit or (1 << 20)  # 1 MB default cap
        self.buf = bytearray()
        self.truncated = False
        self._on_data = on_data   # called with each output chunk (bytes) as it arrives
        self._on_exit = on_exit   # called with exit_status() once the process ends
        self._pump_task = asyncio.create_task(self._pump())

    async def _pump(self) -> None:
        out = self.proc.stdout
        while True:
            chunk = await out.read(65536)
            if not chunk:
                break
            room = self.byte_limit - len(self.buf)
            if room > 0:
                self.buf += chunk[:room]
            if len(chunk) > max(room, 0):
                self.truncated = True
            if self._on_data:
                try:
                    self._on_data(chunk)
                except Exception:  # noqa: BLE001 — a bad sink must not kill the pump
                    pass
        if self._on_exit:
            await self.proc.wait()
            try:
                self._on_exit(self.exit_status())
            except Exception:  # noqa: BLE001
                pass

    def exit_status(self):
        rc = self.proc.returncode
        if rc is None:
            return None
        if rc < 0:  # killed by signal
            return {"exitCode": None, "signal": _sig_name(-rc)}
        return {"exitCode": rc, "signal": None}

    def output(self) -> dict:
        return {
            "output": self.buf.decode("utf-8", "replace"),
            "truncated": self.truncated,
            "exitStatus": self.exit_status(),
        }

    async def wait(self):
        await self.proc.wait()
        try:
            await self._pump_task
        except Exception:  # noqa: BLE001 — best-effort drain
            pass
        return self.exit_status()

    async def kill(self) -> None:
        if self.proc.returncode is None:
            try:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGKILL)
            except (ProcessLookupError, OSError):
                pass


async def spawn_terminal(command, args, cwd, env, byte_limit, on_data=None, on_exit=None) -> AcpTerminal:
    """Launch ``command`` with merged stdout/stderr in its own process group.
    ``env`` is the ACP shape — a list of ``{"name","value"}`` — merged over the
    server env. ``on_data``/``on_exit`` stream output and completion to a sink."""
    full_env = dict(os.environ)
    for item in (env or []):
        if isinstance(item, dict) and "name" in item:
            full_env[item["name"]] = item.get("value", "")
    proc = await asyncio.create_subprocess_exec(
        command, *(args or []),
        cwd=cwd,
        env=full_env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        start_new_session=True,
    )
    return AcpTerminal(proc, byte_limit, on_data=on_data, on_exit=on_exit)
