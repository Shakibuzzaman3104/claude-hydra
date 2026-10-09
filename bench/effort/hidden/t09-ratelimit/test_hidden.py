import unittest
from ratelimit import RateLimiter
class Clock:
    def __init__(self, t=0.0): self.t = t
    def __call__(self): return self.t
class T(unittest.TestCase):
    def test_limit(self):
        c = Clock(); r = RateLimiter(3, 10, c)
        self.assertEqual([r.allow() for _ in range(5)], [True, True, True, False, False])
        self.assertEqual(r.remaining(), 0)
    def test_boundary(self):
        c = Clock(); r = RateLimiter(1, 10, c); self.assertTrue(r.allow())
        c.t = 9.999; self.assertFalse(r.allow()); c.t = 10; self.assertTrue(r.allow())
    def test_retry_after(self):
        c = Clock(); r = RateLimiter(2, 10, c); r.allow(); c.t = 4; r.allow(); c.t = 5
        w = r.retry_after(); self.assertAlmostEqual(w, 5); c.t += w; self.assertTrue(r.allow())
        c.t = 100; self.assertEqual(r.retry_after(), 0)
    def test_retry_after_matches_allow(self):
        import random
        rnd = random.Random(7)
        for _ in range(300):
            c = Clock(rnd.uniform(0, 50)); r = RateLimiter(rnd.randint(1, 4), rnd.choice([1, 2.5, 10]), c)
            for _ in range(30):
                c.t += rnd.choice([0, 0.1, 0.5, 1, 3])
                r.allow()
                w = r.retry_after(); self.assertGreaterEqual(w, 0)
                self.assertGreaterEqual(r.remaining(), 0)
                if w > 0:
                    save = c.t; c.t = save + w + 1e-9
                    self.assertGreater(r.remaining(), 0)
                    c.t = save
    def test_backwards(self):
        c = Clock(1000); r = RateLimiter(2, 10, c); r.allow(); r.allow()
        c.t = 0; self.assertFalse(r.allow())
        self.assertGreaterEqual(r.retry_after(), 0); self.assertLessEqual(r.retry_after(), 10)
        c.t = 10; self.assertTrue(r.allow())
    def test_never_negative(self):
        import math
        c = Clock(); r = RateLimiter(0, 5, c); self.assertFalse(r.allow()); self.assertEqual(r.remaining(), 0)
        self.assertEqual(r.retry_after(), math.inf)
