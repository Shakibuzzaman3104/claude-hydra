from dataclasses import dataclass


@dataclass
class Customer:
    id: int
    name: str
    email: str
    balance: float


@dataclass
class ImportResult:
    customers: list
    errors: list  # list of (line_number, message)


def import_customers(text):
    """Parse a customers CSV export (header: id,name,email,balance)."""
    customers, errors = [], []
    lines = text.split("\n")
    header = lines[0].split(",")
    for number, line in enumerate(lines[1:], start=2):
        if not line:
            continue
        fields = line.split(",")
        if len(fields) != len(header):
            continue
        row = dict(zip(header, fields))
        try:
            customers.append(Customer(int(row["id"]), row["name"], row["email"], float(row["balance"])))
        except ValueError:
            continue
    return ImportResult(customers, errors)
