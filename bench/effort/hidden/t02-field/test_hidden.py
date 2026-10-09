import unittest
from models import User
class T(unittest.TestCase):
    def test_positional(self):
        u = User(1, "a"); self.assertEqual(u.email, ""); self.assertTrue(u.active)
        self.assertEqual(User(1, "a", "x@y").email, "x@y")
    def test_dict(self):
        self.assertEqual(list(User(1, "a", "x@y").to_dict()), ["id", "name", "email", "active"])
        self.assertEqual(User.from_dict({"id": "3", "name": "b"}).email, "")
        self.assertEqual(User.from_dict({"id": 3, "name": "b", "email": "q@w"}).to_dict()["email"], "q@w")
    def test_validate(self):
        self.assertEqual(User(1, "a").validate(), [])
        self.assertEqual(User(1, "a", "nope").validate(), ["email is invalid"])
        self.assertEqual(User(0, " ", "nope").validate(), ["id must be positive", "name is required", "email is invalid"])
