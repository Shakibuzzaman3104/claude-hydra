class EvalError(Exception):
    def __init__(self, message, pos):
        super().__init__(f"{message} at {pos}")
        self.pos = pos


def evaluate(source, variables=None):
    """Evaluate an arithmetic expression. See BRIEF.md."""
    raise NotImplementedError
