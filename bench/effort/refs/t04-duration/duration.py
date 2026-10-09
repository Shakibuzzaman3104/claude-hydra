import re

UNITS = {"d": 86400, "h": 3600, "m": 60, "s": 1}
PART = re.compile(r"(\d+)([dhms])")


def parse_duration(text):
    s = text.strip()
    if not s:
        raise ValueError("empty")
    if re.fullmatch(r"\d+", s):
        return int(s)
    pos, total, last = 0, 0, -1
    order = "dhms"
    while pos < len(s):
        if pos > 0:
            while pos < len(s) and s[pos] == " ":
                pos += 1
        m = PART.match(s, pos)
        if not m:
            raise ValueError(text)
        rank = order.index(m.group(2))
        if rank <= last:
            raise ValueError(text)
        last = rank
        total += int(m.group(1)) * UNITS[m.group(2)]
        pos = m.end()
    return total
