import unittest, pathlib, os, json
ROOT = pathlib.Path(os.environ["RUN_DIR"])
RECS = [
    {" First Name ": "  Ann ", "age": 31, "score": 9.5, "vip": True, "note": None, "Zip-Code": "  01234 "},
    {"first name": 'Bo, "B"', "age": 0, "score": 0.004, "vip": False, "note": "<a&b>", "zip-code": None},
    {"ratio": 2.675, "flag": False, "n": None, "x y-z": 1},
]
EXPECT = {
 "csv": 'age,first_name,note,score,vip,zip-code\n31,Ann,,9.50,true,01234\n0,"Bo, ""B""",<a&b>,0.00,false,',
 "json": None, "xml": None,
}
class T(unittest.TestCase):
    def test_csv(self):
        from export.csv_export import to_csv
        exp = 'age,first_name,flag,n,note,ratio,score,vip,x_y-z,zip-code\n31,Ann,,,,,9.50,true,,01234\n0,"Bo, ""B""",,,<a&b>,,0.00,false,,\n,,false,,,2.67,,,1,'
        self.assertEqual(to_csv(RECS), exp); self.assertEqual(to_csv([]), "")
    def test_json(self):
        from export.json_export import to_json
        exp = json.dumps([
            {"age": "31", "first_name": "Ann", "note": None, "score": 9.5, "vip": True, "zip-code": "01234"},
            {"age": "0", "first_name": 'Bo, "B"', "note": "<a&b>", "score": 0.0, "vip": False, "zip-code": None},
            {"flag": False, "n": None, "ratio": 2.67, "x_y-z": "1"}], sort_keys=True)
        self.assertEqual(to_json(RECS), exp)
    def test_xml(self):
        from export.xml_export import to_xml
        exp = ("<records><record><age>31</age><first_name>Ann</first_name><score>9.50</score><vip>true</vip><zip_code>01234</zip_code></record>"
               "<record><age>0</age><first_name>Bo, \"B\"</first_name><note>&lt;a&amp;b&gt;</note><score>0.00</score><vip>false</vip></record>"
               "<record><flag>false</flag><ratio>2.67</ratio><x_y_z>1</x_y_z></record></records>")
        self.assertEqual(to_xml(RECS), exp)
    def test_structure(self):
        self.assertTrue((ROOT / "export/normalize.py").exists())
        for f in ("csv_export.py", "json_export.py", "xml_export.py"):
            src = (ROOT / "export" / f).read_text()
            self.assertNotIn("def _normalize", src, f)
            self.assertTrue("normalize" in src and ("from export.normalize" in src or "from .normalize" in src or "import normalize" in src), f)
