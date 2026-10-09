import unittest, io, tempfile, os
import todo_cli
class T(unittest.TestCase):
    def setUp(self):
        self.p = os.path.join(tempfile.mkdtemp(), "t.json")
    def run_(self, *a):
        out = io.StringIO(); code = todo_cli.main(["--file", self.p, *a], out); return code, out.getvalue()
    def test_counts(self):
        self.assertEqual(self.run_("count"), (0, "0\n"))
        for t in ("a", "b", "c"): self.run_("add", t)
        self.run_("done", "2")
        self.assertEqual(self.run_("count"), (0, "2\n"))
        self.assertEqual(self.run_("count", "--done"), (0, "1\n"))
        self.assertEqual(self.run_("count", "--all"), (0, "3\n"))
    def test_exclusive(self):
        with self.assertRaises(SystemExit) as e:
            self.run_("count", "--done", "--all")
        self.assertEqual(e.exception.code, 2)
    def test_existing(self):
        self.run_("add", "x", "y"); self.assertEqual(self.run_("list"), (0, "1. [ ] x y\n"))
        self.assertEqual(self.run_("done", "5"), (1, "no todo #5\n"))
