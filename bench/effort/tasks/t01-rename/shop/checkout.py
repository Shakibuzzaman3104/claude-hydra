from shop import pricing


def checkout(items, tax):
    total = pricing.calc_total(items, tax)
    return {"total": total, "calc_total_version": 2}
