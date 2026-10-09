import re


class EvalError(Exception):
    def __init__(self, message, pos):
        super().__init__(f"{message} at {pos}")
        self.pos = pos


TOK = re.compile(r"\s*(?:(\d+\.\d*|\.\d+|\d+)|([A-Za-z_]\w*)|(.))")
FUNCS = {"min": (1, None, lambda *a: min(a)), "max": (1, None, lambda *a: max(a)), "abs": (1, 1, abs), "round": (1, 1, round)}


def evaluate(source, variables=None):
    variables = variables or {}
    toks, pos = [], 0
    while True:
        m = TOK.match(source, pos)
        if not m or m.end() == pos and not m.group(0):
            break
        if m.group(0).strip() == "":
            break
        start = m.start(1) if m.group(1) else m.start(2) if m.group(2) else m.start(3)
        if m.group(1):
            t = m.group(1); toks.append(("num", float(t) if "." in t else int(t), start))
        elif m.group(2):
            toks.append(("id", m.group(2), start))
        else:
            c = m.group(3)
            if c not in "+-*/%^(),":
                raise EvalError("bad char", start)
            toks.append(("op", c, start))
        pos = m.end()
    toks.append(("end", None, len(source)))
    i = 0

    def peek():
        return toks[i]

    def take():
        nonlocal i
        t = toks[i]; i += 1; return t

    def expect(v):
        t = take()
        if t[0] != "op" or t[1] != v:
            raise EvalError("expected " + v, t[2])

    def expr():
        v = term()
        while peek()[0] == "op" and peek()[1] in "+-":
            op = take()[1]; r = term(); v = v + r if op == "+" else v - r
        return v

    def term():
        v = unary()
        while peek()[0] == "op" and peek()[1] in "*/%":
            t = take(); r = unary()
            if r == 0 and t[1] in "/%":
                raise EvalError("division by zero", t[2])
            v = v * r if t[1] == "*" else v / r if t[1] == "/" else v % r
        return v

    def unary():
        if peek()[0] == "op" and peek()[1] in "+-":
            op = take()[1]; v = unary(); return -v if op == "-" else +v
        return power()

    def power():
        b = atom()
        if peek()[0] == "op" and peek()[1] == "^":
            take(); return b ** unary()
        return b

    def atom():
        t = take()
        if t[0] == "num":
            return t[1]
        if t[0] == "id":
            if peek()[0] == "op" and peek()[1] == "(":
                if t[1] not in FUNCS:
                    raise EvalError("unknown function", t[2])
                take(); args = []
                if not (peek()[0] == "op" and peek()[1] == ")"):
                    args.append(expr())
                    while peek()[0] == "op" and peek()[1] == ",":
                        take(); args.append(expr())
                expect(")")
                lo, hi, f = FUNCS[t[1]]
                if len(args) < lo or (hi is not None and len(args) > hi):
                    raise EvalError("arity", t[2])
                return f(*args)
            if t[1] not in variables:
                raise EvalError("unknown name", t[2])
            return variables[t[1]]
        if t[0] == "op" and t[1] == "(":
            v = expr(); expect(")"); return v
        raise EvalError("unexpected", t[2])

    v = expr()
    if peek()[0] != "end":
        raise EvalError("trailing", peek()[2])
    return v
