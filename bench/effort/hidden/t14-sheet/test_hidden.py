import unittest
from sheet import Sheet
class T(unittest.TestCase):
    def test_values(self):
        s = Sheet(); s.set("a1", "3"); s.set("A2", "-2.5"); s.set("A3", "hello"); s.set("A4", "1e3")
        self.assertEqual(s.get("A1"), 3); self.assertIs(type(s.get("A1")), int); self.assertEqual(s.get("a2"), -2.5)
        self.assertEqual(s.get("A3"), "hello"); self.assertEqual(s.get("A4"), 1000.0); self.assertIsNone(s.get("B1"))
        self.assertEqual(s.raw("A1"), "3"); self.assertEqual(s.raw("C9"), "")
        for bad in ("A0", "A1000", "AA1", "1A", "", "A"):
            with self.assertRaises(ValueError): s.get(bad)
    def test_formulas(self):
        s = Sheet()
        for k, v in {"A1": "2", "A2": "3", "A3": "4", "B1": "x"}.items(): s.set(k, v)
        cases = {"=A1+A2*A3": 14, "=(A1+A2)*A3": 20, "=-A1-A2": -5, "=A1/A1": 1.0, "=10-4-3": 3, "=Z9+1": 1,
                 "=SUM(A1:A3)": 9, "=SUM(A3:A1)": 9, "=AVG(A1:A2)": 2.5, "=AVG(A1:B1)": 2.0, "=COUNT(A1:B3)": 3, "=MIN(A1:A3)": 2,
                 "=MAX(C1:C5)": 0, "=AVG(C1:C3)": "#DIV/0!", "=IF(A1>1, 10, 20)": 10, "=IF(A1>=3, 10, 1/0)": "#DIV/0!",
                 "=IF(A1<>2, 1/0, 7)": 7, "=A1=2": 1, "=A1+B1": "#VALUE!", "=FOO(A1)": "#NAME?", "=A1+": "#VALUE!",
                 "=1/0": "#DIV/0!", "=A1000": "#REF!", "=AA1+1": "#REF!", "=SUM(A1:B1)*2": 4}
        for i, (f, want) in enumerate(cases.items()):
            s.set("D1", f); got = s.get("D1"); self.assertEqual(got, want, f)
            if isinstance(want, str): self.assertIsInstance(got, str, f)
            else: self.assertIs(type(got), type(want), f)
    def test_propagation_and_recalc(self):
        s = Sheet(); s.set("A1", "1"); s.set("B1", "=A1*2"); s.set("C1", "=A1+B1"); s.set("D1", "=SUM(B1:C1)")
        self.assertEqual(s.get("D1"), 5)
        s.recalc_count = 0; s.set("A1", "10")
        self.assertEqual((s.get("B1"), s.get("C1"), s.get("D1")), (20, 30, 50)); self.assertEqual(s.recalc_count, 3)
        s.set("A1", "=1/0"); self.assertEqual(s.get("D1"), "#DIV/0!")
        s.set("E1", "=IF(1, 5, A1)"); self.assertEqual(s.get("E1"), 5)
        s.set("A1", "word"); self.assertEqual(s.get("B1"), "#VALUE!"); self.assertEqual(s.get("D1"), "#VALUE!")
        self.assertEqual(s.get("E1"), 5)
    def test_cycles(self):
        s = Sheet(); s.set("A1", "=B1+1"); s.set("B1", "=C1+1"); s.set("C1", "5"); self.assertEqual(s.get("A1"), 7)
        s.set("D1", "=A1*2"); s.set("C1", "=A1"); self.assertEqual([s.get(c) for c in ("A1", "B1", "C1", "D1")], ["#CYCLE!"] * 4)
        s.set("C1", "1"); self.assertEqual([s.get(c) for c in ("A1", "B1", "C1", "D1")], [3, 2, 1, 6])
        s.set("E1", "=E1"); self.assertEqual(s.get("E1"), "#CYCLE!"); s.set("F1", "=SUM(E1:E2)"); self.assertEqual(s.get("F1"), "#CYCLE!")
    def test_undo(self):
        s = Sheet(); self.assertFalse(s.undo())
        s.set("A1", "1"); s.set("B1", "=A1+1"); s.set("A1", "5"); self.assertEqual(s.get("B1"), 6)
        self.assertTrue(s.undo()); self.assertEqual(s.get("B1"), 2); self.assertEqual(s.raw("A1"), "1")
        s.set("C1", "=B1"); s.set("C1", ""); self.assertIsNone(s.get("C1")); self.assertTrue(s.undo()); self.assertEqual(s.get("C1"), 2)
        s.set("A1", "=B1"); self.assertEqual(s.get("A1"), "#CYCLE!"); self.assertTrue(s.undo()); self.assertEqual(s.get("B1"), 2)
        while s.undo(): pass
        self.assertIsNone(s.get("A1")); self.assertEqual(s.get("B1"), None); self.assertFalse(s.undo())
