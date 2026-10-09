from .pricing import calc_total as ct


def line(items):
    return f"TOTAL {ct(items):.2f}"
