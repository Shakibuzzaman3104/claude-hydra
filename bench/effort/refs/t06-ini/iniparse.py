import re


class ParseError(ValueError):
    def __init__(self, line_no, message):
        super().__init__(f"line {line_no}: {message}")
        self.line_no = line_no


class Config:
    def __init__(self):
        self._data = {"DEFAULT": {}}
        self._order = []

    def get(self, section, key, fallback=None):
        key = key.lower()
        if key in self._data.get(section, {}):
            return self._data[section][key]
        return self._data["DEFAULT"].get(key, fallback)

    def sections(self):
        return list(self._order)


def _value(raw, n):
    if raw.startswith('"'):
        out, i = [], 1
        while i < len(raw):
            c = raw[i]
            if c == "\\":
                if i + 1 < len(raw) and raw[i + 1] in '"\\':
                    out.append(raw[i + 1]); i += 2; continue
                raise ParseError(n, "bad escape")
            if c == '"':
                rest = raw[i + 1:].lstrip(" ")
                if rest and rest[0] not in ";#":
                    raise ParseError(n, "text after quote")
                return "".join(out)
            out.append(c); i += 1
        raise ParseError(n, "unterminated quote")
    m = re.search(r" [;#]", raw)
    return (raw[:m.start()] if m else raw).strip()


def parse(text):
    cfg, section = Config(), "DEFAULT"
    for n, line in enumerate(text.splitlines(), 1):
        s = line.strip()
        if not s or s[0] in ";#":
            continue
        if s.startswith("["):
            if not s.endswith("]"):
                raise ParseError(n, "bad section")
            section = s[1:-1].strip()
            if section not in cfg._data:
                cfg._data[section] = {}
                if section != "DEFAULT":
                    cfg._order.append(section)
            continue
        idx = [i for i in (s.find("="), s.find(":")) if i >= 0]
        if not idx:
            raise ParseError(n, "garbage")
        i = min(idx)
        key = s[:i].strip().lower()
        if not key:
            raise ParseError(n, "empty key")
        cfg._data[section][key] = _value(s[i + 1:].strip(), n)
    return cfg
