import unittest, pathlib, os
ROOT = pathlib.Path(os.environ["RUN_DIR"])
class T(unittest.TestCase):
    def test_pricing(self):
        from shop import pricing
        self.assertFalse(hasattr(pricing, "calc_total"))
        self.assertEqual(pricing.compute_total([(10, 2), (5, 1)], 0.1), 27.5)
        self.assertEqual(pricing.calc_discount(100, 15), 15.0)
    def test_cart(self):
        from shop.cart import Cart
        c = Cart(); c.add(10, 2); c.add(5)
        self.assertEqual(c.total(), 25.0); self.assertEqual(c.total_after(10), 22.5)
    def test_checkout(self):
        from shop.checkout import checkout
        self.assertEqual(checkout([(10, 1)], 0.0), {"total": 10.0, "calc_total_version": 2})
    def test_report(self):
        from shop import report
        self.assertEqual(report.line([(1.5, 2)]), "TOTAL 3.00")
        self.assertIn("as ct", (ROOT / "shop/report.py").read_text())
    def test_no_old_name(self):
        for f in (ROOT / "shop").glob("*.py"):
            src = f.read_text().replace('"calc_total_version"', "")
            self.assertNotIn("calc_total", src, f.name)
