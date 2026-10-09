import unittest, difflib, random, pathlib, os
from udiff import unified_diff
ROOT = pathlib.Path(os.environ["RUN_DIR"])
class T(unittest.TestCase):
    def check(self, a, b, n=3):
        self.assertEqual(unified_diff(a, b, "x", "y", n=n), list(difflib.unified_diff(a, b, "x", "y", n=n)), (a, b, n))
    def test_basic(self):
        L = lambda s: [c + "\n" for c in s]
        self.check(L("abc"), L("abc")); self.check([], L("ab")); self.check(L("ab"), [])
        self.check(L("abcdefghijklmnop"), L("abXdefghijklmnYp")); self.check(L("a"), L("b"))
        self.check(L("abcabba"), L("cbabac")); self.check(L("abcdefg"), L("abcdefg") + L("h"), n=0)
        self.check(L("aaaaabaaaa"), L("aaaabaaaaa"), n=1)
    def test_random(self):
        rnd = random.Random(3)
        for _ in range(600):
            a = [rnd.choice("abcde") + "\n" for _ in range(rnd.randint(0, 25))]
            b = list(a)
            for _ in range(rnd.randint(0, 6)):
                op = rnd.random(); i = rnd.randint(0, len(b))
                if op < 0.4: b.insert(i, rnd.choice("abcdefg") + "\n")
                elif b and op < 0.8: b.pop(min(i, len(b) - 1))
                elif b: b[min(i, len(b) - 1)] = rnd.choice("xyz") + "\n"
            self.check(a, b, n=rnd.choice([0, 1, 2, 3, 5]))
    def test_no_difflib(self):
        import re
        src = (ROOT / "udiff.py").read_text()
        self.assertIsNone(re.search(r"^\s*(import|from)\s+difflib", src, re.M))
