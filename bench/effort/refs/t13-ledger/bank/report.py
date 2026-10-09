from bank.money import format_amount


def balance_report(ledger):
    rows = sorted(ledger.balances.items(), key=lambda row: (-row[1], row[0]))
    return "\n".join(f"{account}: {format_amount(cents)}" for account, cents in rows)
