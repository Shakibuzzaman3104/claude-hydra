import unittest
from bank.money import parse_amount, format_amount
from bank.events import Event
from bank.ledger import Ledger, InsufficientFunds
from bank.report import balance_report
D = lambda i, a, amt: Event(i, "deposit", a, amt)
class T(unittest.TestCase):
    def test_money(self):
        for s, c in [("0.29", 29), ("19.99", 1999), ("1", 100), ("0.01", 1), ("1234.56", 123456), ("0.1", 10)]:
            self.assertEqual(parse_amount(s), c, s)
        for c, s in [(5, "0.05"), (-5, "-0.05"), (100, "1.00"), (123456, "1234.56"), (0, "0.00"), (-250, "-2.50")]:
            self.assertEqual(format_amount(c), s, c)
    def test_transfer_all_and_reverse(self):
        l = Ledger().replay([D("1", "a", 500), Event("2", "transfer", "a", 500, "b")])
        self.assertEqual(l.balances, {"a": 0, "b": 500})
        l.apply(Event("3", "reverse", "", reverses="2")); self.assertEqual(l.balances, {"a": 500, "b": 0})
        l.apply(Event("4", "reverse", "", reverses="2")); self.assertEqual(l.balances, {"a": 500, "b": 0})
        with self.assertRaises(ValueError): l.apply(Event("5", "reverse", "", reverses="3"))
        with self.assertRaises(KeyError): l.apply(Event("6", "reverse", "", reverses="nope"))
    def test_idempotent(self):
        e = D("1", "a", 100); l = Ledger().replay([e, e, Event("2", "withdraw", "a", 40), Event("2", "withdraw", "a", 40)])
        self.assertEqual(l.balances, {"a": 60}); self.assertEqual([x.id for x in l.history], ["1", "2"])
    def test_rejected_untouched(self):
        l = Ledger().replay([D("1", "a", 100)])
        with self.assertRaises(InsufficientFunds): l.apply(Event("2", "transfer", "a", 101, "b"))
        with self.assertRaises(InsufficientFunds): l.apply(Event("3", "withdraw", "a", 101))
        self.assertEqual(l.balances, {"a": 100}); self.assertEqual(len(l.history), 1)
        l.apply(Event("2", "transfer", "a", 50, "b")); self.assertEqual(l.balances, {"a": 50, "b": 50})
    def test_report(self):
        l = Ledger().replay([D("1", "z", 900), D("2", "y", 1000), D("3", "b", 900), D("4", "q", 5)])
        self.assertEqual(balance_report(l), "y: 10.00\nb: 9.00\nz: 9.00\nq: 0.05")
