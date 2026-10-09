def _matching_blocks(a, b):
    b2j = {}
    for j, x in enumerate(b):
        b2j.setdefault(x, []).append(j)

    def longest(alo, ahi, blo, bhi):
        besti, bestj, bestsize = alo, blo, 0
        j2len = {}
        for i in range(alo, ahi):
            new = {}
            for j in b2j.get(a[i], ()):
                if j < blo:
                    continue
                if j >= bhi:
                    break
                k = new[j] = j2len.get(j - 1, 0) + 1
                if k > bestsize:
                    besti, bestj, bestsize = i - k + 1, j - k + 1, k
            j2len = new
        return besti, bestj, bestsize

    queue, blocks = [(0, len(a), 0, len(b))], []
    while queue:
        alo, ahi, blo, bhi = queue.pop()
        i, j, k = x = longest(alo, ahi, blo, bhi)
        if k:
            blocks.append(x)
            if alo < i and blo < j:
                queue.append((alo, i, blo, j))
            if i + k < ahi and j + k < bhi:
                queue.append((i + k, ahi, j + k, bhi))
    blocks.sort()
    i1 = j1 = k1 = 0
    out = []
    for i2, j2, k2 in blocks:
        if i1 + k1 == i2 and j1 + k1 == j2:
            k1 += k2
        else:
            if k1:
                out.append((i1, j1, k1))
            i1, j1, k1 = i2, j2, k2
    if k1:
        out.append((i1, j1, k1))
    out.append((len(a), len(b), 0))
    return out


def _opcodes(a, b):
    i = j = 0
    ops = []
    for ai, bj, size in _matching_blocks(a, b):
        tag = ""
        if i < ai and j < bj:
            tag = "replace"
        elif i < ai:
            tag = "delete"
        elif j < bj:
            tag = "insert"
        if tag:
            ops.append((tag, i, ai, j, bj))
        i, j = ai + size, bj + size
        if size:
            ops.append(("equal", ai, i, bj, j))
    return ops


def _grouped(a, b, n):
    codes = _opcodes(a, b)
    if not codes:
        codes = [("equal", 0, 1, 0, 1)]
    if codes[0][0] == "equal":
        tag, i1, i2, j1, j2 = codes[0]
        codes[0] = tag, max(i1, i2 - n), i2, max(j1, j2 - n), j2
    if codes[-1][0] == "equal":
        tag, i1, i2, j1, j2 = codes[-1]
        codes[-1] = tag, i1, min(i2, i1 + n), j1, min(j2, j1 + n)
    nn = n + n
    group = []
    for tag, i1, i2, j1, j2 in codes:
        if tag == "equal" and i2 - i1 > nn:
            group.append((tag, i1, min(i2, i1 + n), j1, min(j2, j1 + n)))
            yield group
            group = []
            i1, j1 = max(i1, i2 - n), max(j1, j2 - n)
        group.append((tag, i1, i2, j1, j2))
    if group and not (len(group) == 1 and group[0][0] == "equal"):
        yield group


def _range(start, stop):
    beginning = start + 1
    length = stop - start
    if length == 1:
        return str(beginning)
    if not length:
        beginning -= 1
    return f"{beginning},{length}"


def unified_diff(a, b, fromfile="a", tofile="b", n=3):
    out, started = [], False
    for group in _grouped(a, b, n):
        if not started:
            started = True
            out += [f"--- {fromfile}\n", f"+++ {tofile}\n"]
        first, last = group[0], group[-1]
        out.append(f"@@ -{_range(first[1], last[2])} +{_range(first[3], last[4])} @@\n")
        for tag, i1, i2, j1, j2 in group:
            if tag == "equal":
                out += [" " + x for x in a[i1:i2]]
                continue
            if tag in ("replace", "delete"):
                out += ["-" + x for x in a[i1:i2]]
            if tag in ("replace", "insert"):
                out += ["+" + x for x in b[j1:j2]]
    return out
