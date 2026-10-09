from bank.events import Event


class InsufficientFunds(Exception):
    pass


class Ledger:
    def __init__(self):
        self.balances = {}
        self.history = []

    def _add(self, account, delta):
        self.balances[account] = self.balances.get(account, 0) + delta

    def apply(self, event: Event):
        if event.kind == "deposit":
            self._add(event.account, event.amount)
        elif event.kind == "withdraw":
            if self.balances.get(event.account, 0) < event.amount:
                raise InsufficientFunds(event.id)
            self._add(event.account, -event.amount)
        elif event.kind == "transfer":
            if self.balances.get(event.account, 0) <= event.amount:
                raise InsufficientFunds(event.id)
            self._add(event.account, -event.amount)
            self._add(event.target, event.amount)
        elif event.kind == "reverse":
            original = next(e for e in self.history if e.id == event.reverses)
            if original.kind == "deposit":
                self._add(original.account, -original.amount)
            elif original.kind == "withdraw":
                self._add(original.account, original.amount)
            elif original.kind == "transfer":
                self._add(original.account, -original.amount)
                self._add(original.target, original.amount)
        self.history.append(event)

    def replay(self, events):
        for event in events:
            self.apply(event)
        return self
