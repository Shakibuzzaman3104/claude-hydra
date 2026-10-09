import unittest
from lru import LRUCache
class T(unittest.TestCase):
    def test_validation(self):
        for bad in (-1, 1.5, "2", True, None):
            with self.assertRaises(ValueError): LRUCache(bad)
    def test_basic(self):
        ev = []; c = LRUCache(2, on_evict=lambda k, v: ev.append((k, v)))
        c.put("a", 1); c.put("b", 2); self.assertEqual(c.get("a"), 1); c.put("c", 3)
        self.assertEqual(ev, [("b", 2)]); self.assertEqual(c.keys(), ["c", "a"]); self.assertEqual(len(c), 2)
        c.put("a", 10); self.assertEqual(ev, [("b", 2)]); self.assertEqual(c.keys(), ["a", "c"])
        self.assertEqual(c.get("zz", 7), 7)
    def test_peek_contains(self):
        c = LRUCache(2); c.put("a", 1); c.put("b", 2)
        self.assertEqual(c.peek("a"), 1); self.assertTrue("a" in c); self.assertEqual(c.keys(), ["b", "a"])
        c.put("c", 3); self.assertNotIn("a", c); self.assertEqual(c.peek("q", 0), 0)
    def test_zero(self):
        ev = []; c = LRUCache(0, on_evict=lambda k, v: ev.append(k)); c.put("a", 1)
        self.assertEqual(len(c), 0); self.assertEqual(ev, []); self.assertIsNone(c.get("a"))
    def test_resize_stats(self):
        ev = []; c = LRUCache(3, on_evict=lambda k, v: ev.append(k))
        for k in "abc": c.put(k, k)
        c.get("a"); c.get("x"); c.peek("b"); c.resize(1)
        self.assertEqual(ev, ["b", "c"]); self.assertEqual(c.keys(), ["a"])
        self.assertEqual(c.stats(), {"hits": 1, "misses": 1, "evictions": 2})
        with self.assertRaises(ValueError): c.resize(-2)
        c.resize(0); self.assertEqual(ev, ["b", "c", "a"]); self.assertEqual(len(c), 0)
    def test_evict_raises(self):
        def boom(k, v): raise RuntimeError("x")
        c = LRUCache(1, on_evict=boom); c.put("a", 1)
        with self.assertRaises(RuntimeError): c.put("b", 2)
        self.assertEqual(c.keys(), ["b"]); self.assertEqual(len(c), 1); self.assertEqual(c.stats()["evictions"], 1)
