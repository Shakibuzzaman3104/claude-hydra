import math, threading, time
from collections import deque


class RateLimiter:
    def __init__(self, limit, window, clock=time.monotonic):
        self.limit, self.window, self.clock = limit, window, clock
        self._calls = deque()
        self._lock = threading.Lock()

    def _now(self):
        now = self.clock()
        if self._calls and self._calls[-1] > now:
            self._calls = deque(min(t, now) for t in self._calls)
        while self._calls and now - self._calls[0] >= self.window:
            self._calls.popleft()
        return now

    def allow(self):
        with self._lock:
            now = self._now()
            if len(self._calls) < self.limit:
                self._calls.append(now)
                return True
            return False

    def remaining(self):
        with self._lock:
            self._now()
            return max(0, self.limit - len(self._calls))

    def retry_after(self):
        with self._lock:
            now = self._now()
            if self.limit <= 0:
                return math.inf
            if len(self._calls) < self.limit:
                return 0
            return max(0, self._calls[len(self._calls) - self.limit] + self.window - now)
