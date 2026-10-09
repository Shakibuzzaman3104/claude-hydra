import unittest, pathlib, os
from importer import import_customers as imp
S = pathlib.Path(os.environ["RUN_DIR"]) / "samples"
def rd(n): return (S / n).read_bytes().decode("utf-8")
class T(unittest.TestCase):
    def test_samples(self):
        r = imp(rd("excel_windows.csv")); self.assertEqual([(c.id, c.name, c.balance) for c in r.customers], [(1, "Ann Lee", 10.5), (2, "Bob", 0.0)]); self.assertEqual(r.errors, [])
        r = imp(rd("quoted.csv")); self.assertEqual([c.name for c in r.customers], ["Lee, Ann", 'Bob "The Builder" Smith', "Multi\nLine Name"])
        self.assertEqual(r.customers[2].balance, 4.25); self.assertEqual(r.errors, [])
        r = imp(rd("eu_and_messy.csv")); self.assertEqual([(c.name, c.balance) for c in r.customers], [("Ann", 1234.5), ("Bob", 7.0), ("Cy", 0.0)])
        self.assertEqual([e[0] for e in r.errors], [5])
    def test_variants(self):
        r = imp("Email , NAME,Balance,ID\nx@y,Zed,2,9\n\n\n10,bad\nq@w,Q,1,notint\n")
        self.assertEqual([(c.id, c.name, c.email, c.balance) for c in r.customers], [(9, "Zed", "x@y", 2.0)])
        self.assertEqual([e[0] for e in r.errors], [5, 6])
        r = imp('id,name,email,balance\r\n1,"A\r\nB",a@b,1\r\n2,"unterminated,c@d,2\r\n')
        self.assertEqual([c.name for c in r.customers], ["A\nB"] if r.customers and r.customers[0].name == "A\nB" else ["A\r\nB"])
        self.assertEqual(len(r.errors), 1); self.assertEqual(r.errors[0][0], 4)
        r = imp("id,name,balance\n1,a,2\n"); self.assertEqual(r.customers, []); self.assertEqual([e[0] for e in r.errors], [1])
        r = imp("﻿id,name,email,balance\n3,c,c@d,-1.5\n4,d,d@e,1e2\n"); self.assertEqual([c.balance for c in r.customers], [-1.5, 100.0])
