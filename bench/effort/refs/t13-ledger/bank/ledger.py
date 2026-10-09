from bank.events import Event


class InsufficientFunds(Exception):
    pass


class Ledger:
    def __init__(self):
        self.balances = {}
        self.history = []
        self._applied = {}
        self._reversed = set()

    def _add(self, account, delta):
        self.balances[account] = self.balances.get(account, 0) + delta

    def apply(self, event: Event):
        if event.id in self._applied:
            return
        if event.kind == "deposit":
            self._add(event.account, event.amount)
        elif event.kind == "withdraw":
            if self.balances.get(event.account, 0) < event.amount:
                raise InsufficientFunds(event.id)
            self._add(event.account, -event.amount)
        elif event.kind == "transfer":
            if self.balances.get(event.account, 0) < event.amount:
                raise InsufficientFunds(event.id)
            self._add(event.account, -event.amount)
            self._add(event.target, event.amount)
        elif event.kind == "reverse":
            if event.reverses not in self._applied:
                raise KeyError(event.reverses)
            original = self._applied[event.reverses]
            if original.kind == "reverse":
                raise ValueError("cannot reverse a reversal")
            if event.reverses in self._reversed:
                return
            if original.kind == "deposit":
                self._add(original.account, -original.amount)
            elif original.kind == "withdraw":
                self._add(original.account, original.amount)
            elif original.kind == "transfer":
                self._add(original.account, original.amount)
                self._add(original.target, -original.amount)
            self._reversed.add(event.reverses)
        self._applied[event.id] = event
        self.history.append(event)

    def replay(self, events):
        for event in events:
            self.apply(event)
        return self
