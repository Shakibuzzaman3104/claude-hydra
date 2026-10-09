import re

CELL = re.compile(r"([A-Za-z])([1-9]\d{0,2})$")
ERRORS = ("#DIV/0!", "#REF!", "#CYCLE!", "#VALUE!", "#NAME?")
TOKEN = re.compile(r"\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z]+\d+)|([A-Za-z]+)|(<>|<=|>=|[-+*/(),:=<>]))")


class Err(Exception):
    def __init__(self, code):
        self.code = code


def norm(name):
    if not isinstance(name, str) or not CELL.match(name):
        raise ValueError(name)
    return name.upper()


def is_err(v):
    return isinstance(v, str) and v in ERRORS


def parse_number(raw):
    try:
        return int(raw)
    except ValueError:
        pass
    try:
        return float(raw)
    except ValueError:
        return None


def tokenize(src):
    toks, pos = [], 0
    src = src.rstrip()
    while pos < len(src):
        m = TOKEN.match(src, pos)
        if not m or m.end() == pos:
            raise Err("#VALUE!")
        num, ref, name, op = m.groups()
        toks.append(("num", num) if num else ("ref", ref.upper()) if ref else ("name", name.upper()) if name else ("op", op))
        pos = m.end()
    toks.append(("end", None))
    return toks


def refs_of(src):
    out = set()
    try:
        toks = tokenize(src)
    except Err:
        return out
    for i, (k, v) in enumerate(toks):
        if k == "ref":
            if i + 2 < len(toks) and toks[i + 1] == ("op", ":") and toks[i + 2][0] == "ref":
                out |= expand(v, toks[i + 2][1])
            elif CELL.match(v):
                out.add(v)
    return out


def expand(a, b):
    ma, mb = CELL.match(a), CELL.match(b)
    if not ma or not mb:
        return set()
    c1, c2 = sorted([ma.group(1), mb.group(1)])
    r1, r2 = sorted([int(ma.group(2)), int(mb.group(2))])
    return {f"{chr(c)}{r}" for c in range(ord(c1), ord(c2) + 1) for r in range(r1, r2 + 1)}


class Sheet:
    def __init__(self):
        self._raw, self._val, self._undo = {}, {}, []
        self.recalc_count = 0

    def raw(self, name):
        return self._raw.get(norm(name), "")

    def get(self, name):
        return self._val.get(norm(name))

    def set(self, name, raw):
        name = norm(name)
        self._undo.append((name, self._raw.get(name, "")))
        self._assign(name, raw)

    def undo(self):
        if not self._undo:
            return False
        name, raw = self._undo.pop()
        self._assign(name, raw)
        return True

    def _assign(self, name, raw):
        if raw == "":
            self._raw.pop(name, None)
        else:
            self._raw[name] = raw
        self._recompute_from(name)

    def _deps(self, name):
        raw = self._raw.get(name, "")
        return refs_of(raw[1:]) if raw.startswith("=") else set()

    def _recompute_from(self, start):
        dependents = {}
        for cell in self._raw:
            for d in self._deps(cell):
                dependents.setdefault(d, set()).add(cell)
        affected, stack = set(), [start]
        while stack:
            c = stack.pop()
            if c in affected:
                continue
            affected.add(c)
            stack.extend(dependents.get(c, ()))
        # cycle detection over formula cells
        graph = {c: self._deps(c) for c in self._raw}
        on_cycle = set()
        index, low, st, onst, counter = {}, {}, [], set(), [0]

        def strong(v):
            index[v] = low[v] = counter[0]; counter[0] += 1; st.append(v); onst.add(v)
            for w in graph.get(v, ()):
                if w not in graph:
                    continue
                if w not in index:
                    strong(w); low[v] = min(low[v], low[w])
                elif w in onst:
                    low[v] = min(low[v], index[w])
            if low[v] == index[v]:
                comp = []
                while True:
                    w = st.pop(); onst.discard(w); comp.append(w)
                    if w == v:
                        break
                if len(comp) > 1 or v in graph.get(v, ()):
                    on_cycle.update(comp)

        for v in graph:
            if v not in index:
                strong(v)
        tainted, stack = set(), list(on_cycle)
        while stack:
            c = stack.pop()
            if c in tainted:
                continue
            tainted.add(c); stack.extend(dependents.get(c, ()))
        done = set()

        def visit(c):
            if c in done:
                return
            done.add(c)
            if c in tainted:
                self._val[c] = "#CYCLE!"; return
            for d in self._deps(c):
                if d in affected:
                    visit(d)
            raw = self._raw.get(c)
            if raw is None:
                self._val.pop(c, None)
            elif raw.startswith("="):
                self.recalc_count += 1
                try:
                    self._val[c] = self._eval(raw[1:])
                except Err as e:
                    self._val[c] = e.code
            else:
                n = parse_number(raw)
                self._val[c] = raw if n is None else n

        for c in sorted(affected):
            visit(c)

    def _eval(self, src):
        toks, i = tokenize(src), 0

        def peek():
            return toks[i]

        def take():
            nonlocal i
            t = toks[i]; i += 1; return t

        def cellval(ref):
            if not CELL.match(ref):
                raise Err("#REF!")
            v = self._val.get(ref)
            if is_err(v):
                raise Err(v)
            return v

        def num(v):
            if v is None:
                return 0
            if isinstance(v, str):
                raise Err("#VALUE!")
            return v

        def compare():
            v = expr()
            if peek()[0] == "op" and peek()[1] in ("=", "<>", "<", "<=", ">", ">="):
                op = take()[1]; r = expr(); a, b = num(v), num(r)
                return int({"=": a == b, "<>": a != b, "<": a < b, "<=": a <= b, ">": a > b, ">=": a >= b}[op])
            return v

        def expr():
            v = term()
            while peek() in (("op", "+"), ("op", "-")):
                op = take()[1]; r = term(); v = num(v) + num(r) if op == "+" else num(v) - num(r)
            return v

        def term():
            v = unary()
            while peek() in (("op", "*"), ("op", "/")):
                op = take()[1]; r = unary(); a, b = num(v), num(r)
                if op == "*":
                    v = a * b
                else:
                    if b == 0:
                        raise Err("#DIV/0!")
                    v = a / b
            return v

        def unary():
            if peek() == ("op", "-"):
                take(); return -num(unary())
            if peek() == ("op", "+"):
                take(); return num(unary())
            return atom()

        def skip_arg():
            nonlocal i
            depth = 0
            while True:
                k, v = toks[i]
                if k == "end":
                    raise Err("#VALUE!")
                if (k, v) == ("op", "("):
                    depth += 1
                elif (k, v) == ("op", ")"):
                    if depth == 0:
                        return
                    depth -= 1
                elif (k, v) == ("op", ",") and depth == 0:
                    return
                i += 1

        def expect(v):
            if take() != ("op", v):
                raise Err("#VALUE!")

        def atom():
            k, v = take()
            if k == "num":
                return float(v) if any(c in v for c in ".eE") else int(v)
            if k == "ref":
                return cellval(v)
            if (k, v) == ("op", "("):
                r = expr(); expect(")"); return r
            if k == "name":
                if peek() != ("op", "("):
                    raise Err("#VALUE!")
                take()
                if v == "IF":
                    cond = compare(); expect(",")
                    if num(cond):
                        r = expr(); expect(","); skip_arg()
                    else:
                        skip_arg(); expect(","); r = expr()
                    expect(")"); return r
                if v not in ("SUM", "MIN", "MAX", "AVG", "COUNT"):
                    raise Err("#NAME?")
                nums = []
                while True:
                    if peek()[0] == "ref" and toks[i + 1] == ("op", ":"):
                        a = take()[1]; take(); kb, b = take()
                        if kb != "ref":
                            raise Err("#VALUE!")
                        if not CELL.match(a) or not CELL.match(b):
                            raise Err("#REF!")
                        ma, mb = CELL.match(a), CELL.match(b)
                        c1, c2 = sorted([ma.group(1), mb.group(1)]); r1, r2 = sorted([int(ma.group(2)), int(mb.group(2))])
                        for c in range(ord(c1), ord(c2) + 1):
                            for r in range(r1, r2 + 1):
                                x = self._val.get(f"{chr(c)}{r}")
                                if is_err(x):
                                    raise Err(x)
                                if isinstance(x, (int, float)):
                                    nums.append(x)
                    else:
                        nums.append(num(expr()))
                    if peek() == ("op", ","):
                        take(); continue
                    break
                expect(")")
                if v == "SUM":
                    return sum(nums)
                if v == "COUNT":
                    return len(nums)
                if v == "AVG":
                    if not nums:
                        raise Err("#DIV/0!")
                    return float(sum(nums) / len(nums))
                if not nums:
                    return 0
                return min(nums) if v == "MIN" else max(nums)
            raise Err("#VALUE!")

        r = compare()
        if peek()[0] != "end":
            raise Err("#VALUE!")
        return r
