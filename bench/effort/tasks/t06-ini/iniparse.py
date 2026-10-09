class ParseError(ValueError):
    def __init__(self, line_no, message):
        super().__init__(f"line {line_no}: {message}")
        self.line_no = line_no


class Config:
    def get(self, section, key, fallback=None):
        raise NotImplementedError

    def sections(self):
        raise NotImplementedError


def parse(text):
    """Parse INI text into a Config. See BRIEF.md."""
    raise NotImplementedError
