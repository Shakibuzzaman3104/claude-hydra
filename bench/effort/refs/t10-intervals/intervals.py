import bisect


def _chk(a, b):
    for x in (a, b):
        if isinstance(x, bool) or not isinstance(x, int):
            raise TypeError("bounds must be int")


class IntervalSet:
    def __init__(self, intervals=()):
        self._iv = []
        for a, b in intervals:
            self.add(a, b)

    def add(self, a, b):
        _chk(a, b)
        if a >= b:
            return
        keep = []
        for s, e in self._iv:
            if e < a or s > b:
                keep.append((s, e))
            else:
                a, b = min(a, s), max(b, e)
        keep.append((a, b)); keep.sort(); self._iv = keep

    def remove(self, a, b):
        _chk(a, b)
        if a >= b:
            return
        out = []
        for s, e in self._iv:
            if e <= a or s >= b:
                out.append((s, e)); continue
            if s < a: out.append((s, a))
            if e > b: out.append((b, e))
        self._iv = out

    def __contains__(self, x):
        i = bisect.bisect_right(self._iv, (x, float("inf"))) - 1
        return i >= 0 and self._iv[i][0] <= x < self._iv[i][1]

    def intervals(self):
        return list(self._iv)

    def __len__(self):
        return sum(e - s for s, e in self._iv)

    def overlaps(self, a, b):
        return any(s < b and a < e for s, e in self._iv) if a < b else False

    def complement(self, lo, hi):
        r = IntervalSet([(lo, hi)])
        for s, e in self._iv: r.remove(s, e)
        return r

    def __or__(self, o):
        return IntervalSet(self._iv + o._iv)

    def __sub__(self, o):
        r = IntervalSet(self._iv)
        for s, e in o._iv: r.remove(s, e)
        return r

    def __and__(self, o):
        return self - (self - o)

    def __eq__(self, o):
        return isinstance(o, IntervalSet) and self._iv == o._iv

    def __repr__(self):
        return f"IntervalSet({self._iv!r})"
