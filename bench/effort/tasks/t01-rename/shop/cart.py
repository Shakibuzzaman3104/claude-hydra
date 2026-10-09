from shop.pricing import calc_total, calc_discount


class Cart:
    def __init__(self):
        self.items = []

    def add(self, price, qty=1):
        self.items.append((price, qty))

    def total(self, tax=0.0):
        return calc_total(self.items, tax)

    def total_after(self, percent, tax=0.0):
        t = calc_total(self.items, tax)
        return round(t - calc_discount(t, percent), 2)
