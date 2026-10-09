Bug report against ratelimit.py (`RateLimiter`). Find the root causes and fix them; keep the public API (`allow`, `remaining`, `retry_after`, constructor with injectable `clock`).
Reported symptoms:
1. With limit=3, users sometimes get a 4th call through inside one window.
2. A call recorded at time t counts only while now < t + window: at now = t + window it no longer counts. Today it is still counted.
3. `retry_after()` sometimes reports a wait after which `allow()` is still refused.
4. The clock can jump backwards (the injected clock is not always monotonic in production). After a backwards jump, the limiter must not lock users out for longer than `window` seconds of real progress: whenever the limiter reads the clock, rewrite every recorded call time later than `now` to `now` (permanently).
5. `remaining()` must never be negative, and `retry_after()` must never be negative.
6. limit=0 (a disabled key) crashes `retry_after()`; it must return `math.inf`, and `allow()` always refuses.
Acceptance: all six hold for any sequence of calls and clock values.
