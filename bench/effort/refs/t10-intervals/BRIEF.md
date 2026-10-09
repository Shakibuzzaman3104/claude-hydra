Implement `IntervalSet` in intervals.py: a set of integers stored as sorted, disjoint, non-adjacent half-open intervals [start, end) with start < end (ints, may be negative).
- `IntervalSet(intervals=())`: adds each (start, end) pair in order.
- `add(start, end)`: adds every integer in [start, end). Overlapping AND touching intervals merge ([1,3) + [3,5) -> [1,5)). Empty or inverted input (start >= end) is a no-op. Non-int (or bool) bounds raise TypeError.
- `remove(start, end)`: removes every integer in [start, end), splitting intervals as needed. Same no-op/TypeError rules.
- `__contains__(x)`: membership of an int, O(log n) (use bisect).
- `intervals()`: list of (start, end) tuples, sorted.
- `__len__()`: number of integers in the set (sum of lengths).
- `overlaps(start, end)`: True if any integer in [start, end) is in the set (False for empty input).
- `complement(lo, hi)`: a new IntervalSet of the integers in [lo, hi) that are NOT in this set.
- `__or__`, `__and__`, `__sub__` with another IntervalSet return new sets (union, intersection, difference); they must not mutate either operand.
- `__eq__`: equal when intervals() are equal. `__repr__`: `IntervalSet([(1, 5), (7, 9)])`.
Acceptance: after any sequence of operations the stored intervals are sorted, disjoint, non-adjacent and non-empty, and behave exactly like a Python set of ints.
