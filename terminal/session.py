"""Session domain state and the transport-agnostic Subscriber abstraction.

Sessions emit *domain events* (plain dicts whose ``data`` field is raw
``bytes``) onto each attached :class:`Subscriber`. The transport layer is
responsible for serialising those events to the wire format; the domain has
no knowledge of JSON, base64, or WebSockets.
"""
import asyncio
from collections import deque

MAX_BUFFER_BYTES = 256 * 1024  # per-session ring buffer cap


class Subscriber:
    """A consumer of a session's output, decoupled from any transport.

    The domain calls :meth:`send` (non-blocking) to enqueue an event; the
    transport drains events via :meth:`get`.
    """

    def __init__(self):
        self.queue: asyncio.Queue = asyncio.Queue()

    def send(self, event: dict) -> None:
        self.queue.put_nowait(event)

    async def get(self) -> dict:
        return await self.queue.get()


class Session:
    def __init__(self, sid, fd, pid, cols, rows):
        self.id = sid
        self.fd = fd
        self.pid = pid
        self.cols = cols
        self.rows = rows
        self.buffer = deque()
        self.buffer_size = 0
        self.queue: asyncio.Queue = asyncio.Queue()
        self.subscribers = set()  # attached Subscriber objects
        self.alive = True
        self.cleanup_task = None

    def append(self, data: bytes) -> None:
        """Append to the ring buffer, evicting oldest chunks past the cap."""
        self.buffer.append(data)
        self.buffer_size += len(data)
        while self.buffer_size > MAX_BUFFER_BYTES and len(self.buffer) > 1:
            self.buffer_size -= len(self.buffer.popleft())

    def snapshot(self) -> bytes:
        return b"".join(self.buffer)
