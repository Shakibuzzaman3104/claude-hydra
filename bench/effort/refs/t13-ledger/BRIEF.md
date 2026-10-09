Bug reports against the bank/ package (money.py, events.py, ledger.py, report.py). Find and fix the root causes; keep the public API (Event, Ledger.apply/replay/balances, InsufficientFunds, parse_amount, format_amount, balance_report).
1. Deposits of "0.29" or "19.99" show up a cent short.
2. Amounts like 5 cents print as "0.5" instead of "0.05"; -5 cents must print "-0.05".
3. A transfer of an account's entire balance is refused.
4. Reversing a transfer makes the money move in the same direction again instead of back.
5. Our event bus delivers at-least-once: replaying a stream where the same event id appears twice double-counts it. Applying an already-applied event id must be a no-op (it must not raise and must not be recorded twice).
6. Reversing an event id that was never applied crashes with StopIteration; it must raise KeyError. Reversing the same event twice (two different reverse events pointing at one original) must only reverse it once — the second is a no-op. Reversing a "reverse" event is not supported: raise ValueError.
7. A rejected event (InsufficientFunds) must leave balances and history untouched.
8. balance_report must list accounts by balance, highest first, ties by account name ascending; today "9.00" sorts above "10.00".
Acceptance: all eight hold; amounts stay integer cents everywhere.
