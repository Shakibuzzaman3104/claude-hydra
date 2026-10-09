import unittest
from iniparse import parse, ParseError
SRC = '''
; top comment
timeout = 30
  # indented comment
[ server ]
Host = example.com ; inline
port: 8080
path = a=b:c
msg = "say \\"hi\\" \\\\ ok" ; trailing
hash = a#b
[client]
name = x
[server]
PORT = 9090
empty =
'''
class T(unittest.TestCase):
    def setUp(self): self.c = parse(SRC)
    def test_values(self):
        c = self.c
        self.assertEqual(c.get("server", "host"), "example.com")
        self.assertEqual(c.get("server", "HOST"), "example.com")
        self.assertEqual(c.get("server", "port"), "9090")
        self.assertEqual(c.get("server", "path"), "a=b:c")
        self.assertEqual(c.get("server", "msg"), 'say "hi" \\ ok')
        self.assertEqual(c.get("server", "hash"), "a#b")
        self.assertEqual(c.get("server", "empty"), "")
        self.assertEqual(c.get("client", "timeout"), "30")
        self.assertEqual(c.get("nosuch", "timeout"), "30")
        self.assertEqual(c.get("client", "nope", "fb"), "fb")
        self.assertEqual(c.sections(), ["server", "client"])
    def test_colon_first(self):
        self.assertEqual(parse("[a]\nk: v=1").get("a", "k"), "v=1")
        self.assertEqual(parse("[a]\nk= v:1").get("a", "k"), "v:1")
    def test_errors(self):
        for src, line in [("[a]\ngarbage", 2), ("[unclosed", 1), ("\n\n= v", 3), ('[a]\nk = "abc', 2),
                          ('[a]\nk = "a\\nb"', 2), ('[a]\nk = "a" junk', 2)]:
            with self.assertRaises(ParseError, msg=src) as e: parse(src)
            self.assertEqual(e.exception.line_no, line, src)
    def test_quote_comment(self):
        self.assertEqual(parse('[a]\nk = "x ; y"   # c').get("a", "k"), "x ; y")
        self.assertEqual(parse('[a]\nk = "x"').get("a", "k"), "x")
