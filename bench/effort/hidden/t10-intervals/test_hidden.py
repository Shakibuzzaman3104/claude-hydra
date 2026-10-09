import unittest, random
from intervals import IntervalSet
def canon(s):
    xs = sorted(s); out = []
    for x in xs:
        if out and out[-1][1] == x: out[-1][1] = x + 1
        else: out.append([x, x + 1])
    return [tuple(i) for i in out]
class T(unittest.TestCase):
    def test_basic(self):
        s = IntervalSet([(1, 3), (3, 5), (7, 9)])
        self.assertEqual(s.intervals(), [(1, 5), (7, 9)]); self.assertEqual(len(s), 6)
        self.assertEqual(repr(s), "IntervalSet([(1, 5), (7, 9)])")
        s.remove(2, 8); self.assertEqual(s.intervals(), [(1, 2), (8, 9)])
        s.add(5, 5); s.add(6, 2); s.remove(9, 3); self.assertEqual(s.intervals(), [(1, 2), (8, 9)])
        self.assertIn(1, s); self.assertNotIn(2, s); self.assertFalse(s.overlaps(2, 8)); self.assertTrue(s.overlaps(2, 9))
        self.assertFalse(s.overlaps(5, 5))
        self.assertEqual(IntervalSet(), IntervalSet([(3, 3)])); self.assertEqual(IntervalSet().intervals(), [])
    def test_types(self):
        s = IntervalSet()
        for a, b in [(1.0, 2), (1, "2"), (True, 3), (None, 1)]:
            with self.assertRaises(TypeError): s.add(a, b)
            with self.assertRaises(TypeError): s.remove(a, b)
    def test_ops_immutable(self):
        a = IntervalSet([(0, 10)]); b = IntervalSet([(5, 15)])
        self.assertEqual((a | b).intervals(), [(0, 15)]); self.assertEqual((a & b).intervals(), [(5, 10)])
        self.assertEqual((a - b).intervals(), [(0, 5)]); self.assertEqual(a.intervals(), [(0, 10)]); self.assertEqual(b.intervals(), [(5, 15)])
        self.assertEqual(a.complement(-5, 20).intervals(), [(-5, 0), (10, 20)])
        self.assertEqual(a.complement(2, 8).intervals(), [])
    def test_random(self):
        rnd = random.Random(42)
        for _ in range(400):
            s, ref = IntervalSet(), set()
            for _ in range(25):
                a = rnd.randint(-30, 30); b = a + rnd.randint(-3, 12)
                if rnd.random() < 0.55: s.add(a, b); ref |= set(range(a, b))
                else: s.remove(a, b); ref -= set(range(a, b))
                self.assertEqual(s.intervals(), canon(ref)); self.assertEqual(len(s), len(ref))
            for x in range(-35, 50): self.assertEqual(x in s, x in ref)
            a, b = rnd.randint(-30, 30), rnd.randint(-30, 30)
            self.assertEqual(s.overlaps(a, b), bool(ref & set(range(a, b))))
            o, oref = IntervalSet(), set()
            for _ in range(6):
                p = rnd.randint(-30, 30); q = p + rnd.randint(1, 10); o.add(p, q); oref |= set(range(p, q))
            self.assertEqual((s | o).intervals(), canon(ref | oref)); self.assertEqual((s & o).intervals(), canon(ref & oref))
            self.assertEqual((s - o).intervals(), canon(ref - oref)); self.assertEqual(s.intervals(), canon(ref))
            self.assertEqual(s.complement(-40, 40).intervals(), canon(set(range(-40, 40)) - ref))
