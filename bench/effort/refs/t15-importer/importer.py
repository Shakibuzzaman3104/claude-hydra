import csv, io
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
    errors: list


REQUIRED = ("id", "name", "email", "balance")


def import_customers(text):
    text = text.lstrip("﻿")
    reader = csv.reader(io.StringIO(text, newline=""))
    customers, errors = [], []
    start = 1
    try:
        header = [h.strip().lower() for h in next(reader)]
    except StopIteration:
        return ImportResult([], [(1, "empty file")])
    if any(col not in header for col in REQUIRED):
        return ImportResult([], [(1, "missing column")])
    idx = {c: header.index(c) for c in REQUIRED}
    start = reader.line_num + 1
    for fields in reader:
        line = start
        start = reader.line_num + 1
        if not fields or all(not f.strip() for f in fields) and len(fields) <= 1:
            continue
        if len(fields) != len(header):
            errors.append((line, "wrong field count")); continue
        try:
            raw = fields[idx["balance"]].strip().replace(",", "")
            customers.append(Customer(int(fields[idx["id"]].strip()), fields[idx["name"]], fields[idx["email"]].strip(), float(raw) if raw else 0.0))
        except ValueError as e:
            errors.append((line, str(e)))
    return ImportResult(customers, errors)
