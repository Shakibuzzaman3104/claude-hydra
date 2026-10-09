Add an `email` field to `User` in models.py.
- Declare `email: str = ""` right after `name`.
- `to_dict` includes `"email": self.email` (after "name").
- `from_dict` reads it with `str(data.get("email", ""))`, like `name`.
- `validate` appends "email is invalid" when email is non-empty and has no "@" (an empty email is allowed).
Acceptance: existing behaviour unchanged; positional construction `User(1, "a")` still works.
