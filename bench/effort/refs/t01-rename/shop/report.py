from .pricing import compute_total as ct


def line(items):
    return f"TOTAL {ct(items):.2f}"
