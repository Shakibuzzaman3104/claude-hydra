from dataclasses import dataclass


@dataclass
class User:
    id: int
    name: str
    active: bool = True

    def to_dict(self):
        return {"id": self.id, "name": self.name, "active": self.active}

    @classmethod
    def from_dict(cls, data):
        return cls(id=int(data["id"]), name=str(data.get("name", "")), active=bool(data.get("active", True)))

    def validate(self):
        errors = []
        if self.id <= 0:
            errors.append("id must be positive")
        if not self.name.strip():
            errors.append("name is required")
        return errors
