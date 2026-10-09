def parse_amount(text):
    """'12.34' -> amount in cents."""
    return int(float(text) * 100)


def format_amount(cents):
    sign = "-" if cents < 0 else ""
    cents = abs(cents)
    return f"{sign}{cents // 100}.{cents % 100}"
