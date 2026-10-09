from dataclasses import dataclass


@dataclass(frozen=True)
class Event:
    id: str
    kind: str          # "deposit" | "withdraw" | "transfer" | "reverse"
    account: str       # source account (for transfer: from)
    amount: int = 0    # cents, always positive in the event
    target: str = ""   # transfer destination
    reverses: str = "" # for kind == "reverse": the id of the event being reversed
