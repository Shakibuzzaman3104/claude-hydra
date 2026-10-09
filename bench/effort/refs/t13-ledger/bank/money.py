from decimal import Decimal


def parse_amount(text):
    return int((Decimal(text) * 100).to_integral_value())


def format_amount(cents):
    sign = "-" if cents < 0 else ""
    cents = abs(cents)
    return f"{sign}{cents // 100}.{cents % 100:02d}"
