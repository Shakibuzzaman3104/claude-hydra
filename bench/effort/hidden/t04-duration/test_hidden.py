import unittest
from duration import parse_duration as p
class T(unittest.TestCase):
    def test_ok(self):
        for s, v in [("90s", 90), ("5m", 300), ("2h", 7200), ("1d", 86400), ("1h30m", 5400), ("1h 30m 10s", 5410),
                     ("2d4h", 187200), ("  3m ", 180), ("90", 90), ("0", 0), ("0s", 0), ("1d 1s", 86401), ("10m5s", 605)]:
            self.assertEqual(p(s), v, s); self.assertIsInstance(p(s), int)
    def test_bad(self):
        for s in ["", "   ", "-5m", "+5m", "5x", "1.5h", "5M", "30m1h", "1h1h", "1h 30", "h", "1 h", "1h  ", "m5", "1h,30m", "5ms", "1s1m"]:
            if s == "1h  ":
                self.assertEqual(p(s), 3600); continue
            with self.assertRaises(ValueError, msg=s):
                p(s)
