import unittest, base64
from app.repo import InMemoryRepo
from app.service import OrderService, InvalidCursor
from app.api import handle_list_orders
def mk(n=25):
    import random
    ids = list(range(1, n + 1)); random.Random(1).shuffle(ids)
    return InMemoryRepo([{"id": i, "status": "open" if i % 3 else "closed"} for i in ids])
def walk(svc, query):
    seen, cur = [], None
    for _ in range(100):
        q = dict(query)
        if cur: q["cursor"] = cur
        r = handle_list_orders(svc, q); assert r["status"] == 200, r
        seen += [o["id"] for o in r["body"]["orders"]]; cur = r["body"]["next_cursor"]
        if cur is None: return seen
        assert r["body"]["orders"], "cursor led to empty page"
    raise AssertionError("loop")
class T(unittest.TestCase):
    def test_walk(self):
        s = OrderService(mk())
        self.assertEqual(walk(s, {"limit": "7"}), list(range(1, 26)))
        self.assertEqual(walk(s, {"limit": "5", "status": "closed"}), [3, 6, 9, 12, 15, 18, 21, 24])
        self.assertEqual(walk(s, {}), list(range(1, 26)))
    def test_exact_page_no_dangling(self):
        s = OrderService(mk(10)); r = handle_list_orders(s, {"limit": "10"})
        self.assertIsNone(r["body"]["next_cursor"]); self.assertEqual(len(r["body"]["orders"]), 10)
        r = handle_list_orders(s, {"limit": "5"}); self.assertIsNotNone(r["body"]["next_cursor"])
        r2 = handle_list_orders(s, {"limit": "5", "cursor": r["body"]["next_cursor"]})
        self.assertIsNone(r2["body"]["next_cursor"])
    def test_list_all_ordered(self):
        self.assertEqual([o["id"] for o in mk().list_all()], list(range(1, 26)))
    def test_mutation(self):
        repo = mk(20); s = OrderService(repo)
        orders, cur = s.list_orders(limit=5)
        repo.delete(2); repo.insert({"id": 3_000, "status": "open"}); repo.delete(6)
        o2, cur2 = s.list_orders(cursor=cur, limit=5)
        self.assertEqual([o["id"] for o in o2], [7, 8, 9, 10, 11])
    def test_cursor_format(self):
        s = OrderService(mk()); _, cur = s.list_orders(limit=3)
        self.assertNotIn("=", cur)
        raw = base64.urlsafe_b64decode(cur + "=" * (-len(cur) % 4)).decode()
        self.assertEqual(raw, "v1::3")
        _, cur = s.list_orders(status="open", limit=2)
        raw = base64.urlsafe_b64decode(cur + "=" * (-len(cur) % 4)).decode(); self.assertEqual(raw, "v1:open:2")
    def test_bad(self):
        s = OrderService(mk())
        for lim in ("0", "101", "abc", "-3", "5.5", ""):
            self.assertEqual(handle_list_orders(s, {"limit": lim}), {"status": 400, "body": {"error": "invalid limit"}}, lim)
        enc = lambda t: base64.urlsafe_b64encode(t.encode()).decode().rstrip("=")
        for cur in ("!!!", enc("v2::3"), enc("v1::x"), enc("v1::0"), enc("v1::-4"), enc("v1:closed:3")):
            self.assertEqual(handle_list_orders(s, {"cursor": cur}), {"status": 400, "body": {"error": "invalid cursor"}}, cur)
        with self.assertRaises(InvalidCursor): s.list_orders(cursor="!!!")
        self.assertTrue(issubclass(InvalidCursor, ValueError))
