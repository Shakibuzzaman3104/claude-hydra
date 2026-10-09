def compute_total(items, tax=0.0):
    """Sum item prices and apply tax."""
    subtotal = sum(price * qty for price, qty in items)
    return round(subtotal * (1 + tax), 2)


def calc_discount(total, percent):
    return round(total * percent / 100, 2)
