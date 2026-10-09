from dataclasses import dataclass


@dataclass
class User:
    id: int
    name: str
    email: str = ""
    active: bool = True

    def to_dict(self):
        return {"id": self.id, "name": self.name, "email": self.email, "active": self.active}

    @classmethod
    def from_dict(cls, data):
        return cls(id=int(data["id"]), name=str(data.get("name", "")), email=str(data.get("email", "")), active=bool(data.get("active", True)))

    def validate(self):
        errors = []
        if self.id <= 0:
            errors.append("id must be positive")
        if not self.name.strip():
            errors.append("name is required")
        if self.email and "@" not in self.email:
            errors.append("email is invalid")
        return errors
