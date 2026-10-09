import re

UNITS = {"s": 1, "m": 60}


def parse_duration(text):
    """Parse '90s' or '5m' into seconds."""
    match = re.fullmatch(r"(\d+)([sm])", text.strip())
    if not match:
        raise ValueError(f"bad duration: {text!r}")
    value, unit = match.groups()
    return int(value) * UNITS[unit]
