from bank.money import format_amount


def balance_report(ledger):
    rows = [(account, format_amount(cents)) for account, cents in ledger.balances.items()]
    rows.sort(key=lambda row: row[1], reverse=True)
    return "\n".join(f"{account}: {amount}" for account, amount in rows)
