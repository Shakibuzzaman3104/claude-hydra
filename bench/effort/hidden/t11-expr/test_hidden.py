import unittest
from expr import evaluate as ev, EvalError
class T(unittest.TestCase):
    def test_values(self):
        cases = [("2 + 3 * x", 14, {"x": 4}), ("-2^2", -4), ("2^-1", 0.5), ("2^3^2", 512), ("--3", 3), ("-(2+3)*2", -10),
                 ("7 / 2", 3.5), ("8 / 2", 4.0), ("7 % 3", 1), ("-7 % 3", 2), ("10 - 4 - 3", 3), ("2 * 3 % 4", 2),
                 (".5 + 5.", 5.5), ("min(3, 1, 2) + max(4)", 5), ("abs(-3) + round(2.5) + round(3.5)", 9),
                 ("  ( 1 )  ", 1), ("2^2^-1", 2 ** (2 ** -1)), ("-x^2", -9, {"x": 3}), ("+-+1", -1), ("max(1, min(5, 2^2))", 4)]
        for c in cases:
            src, want = c[0], c[1]; v = c[2] if len(c) > 2 else None
            got = ev(src, v); self.assertEqual(got, want, src); self.assertIs(type(got), type(want), src)
    def test_errors(self):
        cases = [("1 +", 3), ("", 0), ("(1 + 2", 6), ("1 2", 2), ("y + 1", 0), ("4 / (2 - 2)", 2), ("5 % 0", 2),
                 ("foo(1)", 0), ("abs(1, 2)", 0), ("min()", 0), ("1 + * 2", 4), ("2 ^", 3), (")", 0), ("1 + y", 4), ("3 $ 4", 2)]
        for src, pos in cases:
            with self.assertRaises(EvalError, msg=src) as e: ev(src, {})
            self.assertEqual(e.exception.pos, pos, src)
