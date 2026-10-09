import threading
import time
from collections import deque


class RateLimiter:
    """Sliding-window limiter: at most `limit` allowed calls in any `window` seconds."""

    def __init__(self, limit, window, clock=time.monotonic):
        self.limit = limit
        self.window = window
        self.clock = clock
        self._calls = deque()
        self._lock = threading.Lock()

    def _evict(self, now):
        while self._calls and now - self._calls[0] > self.window:
            self._calls.popleft()

    def allow(self):
        now = self.clock()
        with self._lock:
            self._evict(now)
            if len(self._calls) <= self.limit:
                self._calls.append(now)
                return True
            return False

    def remaining(self):
        with self._lock:
            self._evict(self.clock())
            return self.limit - len(self._calls)

    def retry_after(self):
        """Seconds until the next call would be allowed (0 if allowed now)."""
        now = self.clock()
        with self._lock:
            self._evict(now)
            if len(self._calls) < self.limit:
                return 0
            return self._calls[0] + self.window - now
