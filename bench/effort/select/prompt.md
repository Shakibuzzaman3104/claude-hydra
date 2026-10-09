You are the Lead in a Claude Code session using Hydra: you send implementation tasks to cheaper Head agents (Command Code, model deepseek/deepseek-v4.1-flash) and choose each Head's reasoning effort. This is the effort rule Hydra gives you:

<rule>
- You pick each Head's reasoning `effort`. Measured over 126 Hydra runs (DeepSeek V4.1 Flash, 15 tasks from a rename to a spreadsheet engine): `low` passed 95% for 0.7x the cost of `high` (95%) and 0.3x `max` (98%); `low` with a retry one level up on failure passed 100% for less than `high` alone. Higher effort mostly buys longer runs, not fewer failures, so:
  - `low` (the default) for every Head whose result you will check by running something (tests, a build, the app) or, for mechanical edits, by reading the diff. That includes long, multi-file and algorithmic work, as long as the task text is a full spec.
  - When the check fails, send the Head back one level up with the failure in the task: `low`, then `high`, then `max`. If `max` fails too, rewrite the brief or do it yourself.
  - `max` first only when you cannot check the result cheaply (nothing to run or test) and the work is subtle: state, cycles, concurrency, an algorithm, or a bug known only by its symptoms.
  - Never raise effort to make up for a vague brief: write the spec first.
  - A level the Head model lacks is raised to its nearest one. deepseek-v4.1-flash takes low, high and max: medium runs as high, xhigh as max.
</rule>

For each scenario below, choose the `effort` you would pass for that Head (one of low, medium, high, xhigh, max). Answer ONLY with a JSON object mapping scenario id to effort, e.g. {"s01": "low"}. No prose.

## s01
Situation: First Head for this task. You can run this project's test suite after the Head finishes.
Task brief:
Rename the function `calc_total` to `compute_total`.
Files: shop/pricing.py (definition), shop/cart.py (import + 2 calls), shop/checkout.py (`pricing.calc_total` call), shop/report.py (import; keep its alias `ct`).
Constraints: do not rename `calc_discount`; do not change the dictionary key "calc_total_version" in checkout.py (it is a wire format); no other changes.
Acceptance: `compute_total` is the only name; every module imports and behaves exactly as before.


## s02
Situation: First Head for this task. You can run this project's test suite after the Head finishes.
Task brief:
Add an `email` field to `User` in models.py.
- Declare `email: str = ""` right after `name`.
- `to_dict` includes `"email": self.email` (after "name").
- `from_dict` reads it with `str(data.get("email", ""))`, like `name`.
- `validate` appends "email is invalid" when email is non-empty and has no "@" (an empty email is allowed).
Acceptance: existing behaviour unchanged; positional construction `User(1, "a")` still works.


## s03
Situation: First Head for this task. You can run this project's test suite after the Head finishes.
Task brief:
Add a `count` subcommand to todo_cli.py, wired the same way as `list`.
- `todo count` prints the number of open (not done) todos as a bare integer line, e.g. `2`.
- `todo count --done` prints the number of done todos; `todo count --all` prints the total. `--done` and `--all` together is a usage error (argparse mutually exclusive group, so it exits with status 2).
- Returns 0. Works when the file does not exist yet (prints 0).
Acceptance: `main(["--file", path, "count"], out)` writes "2\n" for two open todos; existing commands unchanged.


## s04
Situation: First Head for this task. You can run this project's test suite after the Head finishes.
Task brief:
Extend `parse_duration` in duration.py.
- Units: d (86400), h (3600), m (60), s (1).
- Combined forms: "1h30m", "1h 30m 10s", "2d4h". Spaces are allowed only between parts (and around the whole string, which is stripped).
- Units must appear in strictly descending order (d, h, m, s) and at most once each: "30m1h" and "1h1h" are errors.
- A bare number with no unit, e.g. "90", means seconds — but only when it is the entire input ("1h 30" is an error).
- Errors raise ValueError: empty or whitespace-only input, negative numbers or signs ("-5m", "+5m"), unknown units, decimals ("1.5h"), uppercase units ("5M").
- "0s" and "0" are valid and return 0.
Acceptance: returns an int number of seconds; existing "90s"/"5m" keep working.


## s05
Situation: First Head for this task. You can run this project's test suite after the Head finishes.
Task brief:
Implement `LRUCache` in lru.py (standard library only; no functools.lru_cache).
- `LRUCache(capacity, on_evict=None)`: capacity is an int >= 0, else ValueError (also for non-int, bools included). Capacity 0 stores nothing (put is a no-op that does NOT call on_evict).
- `get(key, default=None)`: returns the value and marks it most recently used; a miss returns default and changes nothing.
- `put(key, value)`: inserts or updates; either way the key becomes most recently used. Inserting beyond capacity evicts the least recently used entry and calls `on_evict(key, value)` for it. Updating an existing key never evicts.
- `peek(key, default=None)`: like get but does not change recency.
- `key in cache` does not change recency. `len(cache)` is the entry count.
- `keys()`: list of keys from most to least recently used.
- `resize(new_capacity)`: same validation; shrinking evicts LRU entries (calling on_evict for each, oldest first).
- `stats()`: dict {"hits": int, "misses": int, "evictions": int}; get counts hits/misses, peek does not.
- If on_evict raises, the eviction still completes and the exception propagates to the caller after the cache is consistent.
Acceptance: all operations O(1) except keys()/resize; behaviour exactly as above.


## s06
Situation: First Head for this task. You can run this project's test suite after the Head finishes.
Task brief:
Implement `parse(text) -> Config` in iniparse.py (no configparser).
Syntax, line by line (lines are numbered from 1):
- Blank lines are ignored. A line whose first non-space character is `;` or `#` is a comment.
- `[name]` starts a section (surrounding spaces on the line and inside the brackets are trimmed). Section names are case-sensitive. A repeated section header continues the same section.
- `key = value` or `key: value` — the first `=` or `:` (whichever comes first) separates. Key and value are trimmed. Keys are case-insensitive (store lowercased). An empty key is a ParseError.
- A value wrapped in double quotes is unquoted, with escapes `\"` -> `"` and `\\` -> `\`; any other backslash escape is a ParseError; an unterminated quote is a ParseError; text after the closing quote other than an inline comment is a ParseError.
- Inline comments: in an unquoted value, ` ;` or ` #` (a space followed by `;` or `#`) starts a comment that is stripped. After a closing quote, optional spaces then `;`/`#` comment are allowed.
- Duplicate keys in a section: last one wins.
- Key/value lines before any section go into section "DEFAULT".
- Any other line (e.g. `garbage`, `[unclosed`) raises ParseError with that line's number.
Config:
- `get(section, key, fallback=None)`: key lookup is case-insensitive; if the section lacks the key, fall back to "DEFAULT"'s value; else return fallback. Unknown section: still consults DEFAULT.
- `sections()`: list of section names in first-appearance order, excluding "DEFAULT".
Acceptance: values are always str.


## s07
Situation: First Head for this task. You can run this project's test suite after the Head finishes.
Task brief:
Add cursor pagination to listing orders, across app/repo.py, app/service.py and app/api.py.
- Order ids are positive ints, unique. Results are ordered by id ascending (today they are in insertion order — fix that).
- Repo: `list_page(status=None, after_id=None, limit=20)` returns at most `limit` rows with id > after_id (or from the start), filtered by status, ordered by id. Keep `list_all` working and also id-ordered.
- Service: `list_orders(status=None, cursor=None, limit=20)` returns `(orders, next_cursor)`. The cursor is opaque to clients: the URL-safe base64 (no padding) of the string "v1:<status or empty>:<last id>" (see the API bullet for why the status is in it). next_cursor is None when there are no more rows after this page (do not return a cursor that leads to an empty page). Invalid cursors (bad base64, wrong prefix, non-int id, id <= 0, a status that does not match the status argument) raise `InvalidCursor` (define it in service.py, subclass ValueError).
- Rows inserted or deleted between page requests must not cause skipped or repeated rows for ids that existed throughout (that is why the cursor is an id, not an offset).
- API: `handle_list_orders(service, query)` reads `query["limit"]` (string or absent; default 20; must parse as an int in 1..100) and `query["cursor"]` (absent or a string). Response 200 body: {"orders": [...], "next_cursor": <str or None>}. A bad limit -> {"status": 400, "body": {"error": "invalid limit"}}; a bad cursor -> {"status": 400, "body": {"error": "invalid cursor"}}. `status` filter keeps working, and a cursor is only valid together with the same status filter it was made for; a mismatch is an invalid cursor.
Acceptance: walking pages with next_cursor returns every matching order exactly once, in id order.


## s08
Situation: First Head for this task. You can run this project's test suite after the Head finishes.
Task brief:
Refactor: the three exporters in export/ each carry their own copy of `_normalize`. Extract one shared normalizer into a new module export/normalize.py and make csv_export.py, json_export.py and xml_export.py use it, deleting their private `_normalize` functions.
Constraints:
- The output of `to_csv`, `to_json` and `to_xml` must stay byte-for-byte identical for every input. The three copies are NOT identical — read them carefully and make the shared function parameterised so each exporter keeps its exact current behaviour.
- Keep the public functions' names and signatures. No behaviour changes, no new dependencies.
Acceptance: no exporter defines its own `_normalize`; each imports from export.normalize; outputs unchanged.


## s09
Situation: First Head for this task. You can run this project's test suite after the Head finishes.
Task brief:
Bug report against ratelimit.py (`RateLimiter`). Find the root causes and fix them; keep the public API (`allow`, `remaining`, `retry_after`, constructor with injectable `clock`).
Reported symptoms:
1. With limit=3, users sometimes get a 4th call through inside one window.
2. A call recorded at time t counts only while now < t + window: at now = t + window it no longer counts. Today it is still counted.
3. `retry_after()` sometimes reports a wait after which `allow()` is still refused.
4. The clock can jump backwards (the injected clock is not always monotonic in production). After a backwards jump, the limiter must not lock users out for longer than `window` seconds of real progress: whenever the limiter reads the clock, rewrite every recorded call time later than `now` to `now` (permanently).
5. `remaining()` must never be negative, and `retry_after()` must never be negative.
6. limit=0 (a disabled key) crashes `retry_after()`; it must return `math.inf`, and `allow()` always refuses.
Acceptance: all six hold for any sequence of calls and clock values.


## s10
Situation: First Head for this task. You can run this project's test suite after the Head finishes.
Task brief:
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


## s11
Situation: First Head for this task. You can run this project's test suite after the Head finishes.
Task brief:
Implement `evaluate(source, variables=None)` in expr.py: a safe arithmetic evaluator (no eval/exec/ast/compile).
Grammar and semantics:
- Numbers: integers (`42`) and decimals (`3.5`, `.5`, `5.`); results are Python ints when every operand and operation stays integral (`7 // 2` style integer division does not exist; `/` always returns float), else floats.
- Identifiers `[A-Za-z_][A-Za-z0-9_]*` look up `variables`; unknown names raise EvalError at the identifier's start.
- Operators, lowest to highest precedence: `+ -` (left-assoc), `* / %` (left-assoc), unary `+ -` (prefix, may repeat: `--3` = 3), `^` power (RIGHT-assoc, and binds tighter than unary on its left but its right operand may itself be unary: `-2^2` = -4, `2^-1` = 0.5, `2^3^2` = 512).
- Parentheses; function calls `min(a, b, ...)`, `max(...)` (1+ args), `abs(x)`, `round(x)` (1 arg; Python round). Wrong arity or unknown function raises EvalError at the function name.
- Whitespace anywhere between tokens.
- Division or modulo by zero raises EvalError at the operator's position.
- Positions are 0-based character offsets into `source`. Syntax errors (unexpected token, missing `)`, trailing input, empty input) raise EvalError at the offending token's start (end of input = len(source)).
Acceptance: e.g. evaluate("2 + 3 * x", {"x": 4}) == 14; evaluate("1 +") raises EvalError with pos 3.


## s12
Situation: First Head for this task. You can run this project's test suite after the Head finishes.
Task brief:
Implement `unified_diff(a, b, fromfile="a", tofile="b", n=3)` in udiff.py WITHOUT importing difflib (or any diff library).
- `a` and `b` are lists of lines that each end with "\n". Return a list of output lines, each ending with "\n".
- The output must be identical to `list(difflib.unified_diff(a, b, fromfile, tofile, n=n))` from CPython 3.13 for any input: the "--- a\n" / "+++ b\n" headers (no dates), `@@ -l,s +l,s @@` hunk headers with difflib's exact rules for line numbers and for the `,s` part (a count of 1 is omitted; an empty range is written as `l-1,0` style exactly as difflib does), context lines prefixed with " ", removals "-", additions "+", and hunks grouped/merged exactly the way difflib groups opcodes with `n` lines of context.
- Identical inputs return [].
- This means reproducing difflib.SequenceMatcher's matching (longest matching block first, recursively, with its "junk" heuristic disabled — use autojunk=False semantics: no popular-element pruning) and `get_grouped_opcodes(n)`.
Acceptance: byte-identical to difflib.unified_diff(a, b, fromfile, tofile, n=n) when SequenceMatcher would be built with autojunk=False — the hidden tests compare against difflib with inputs shorter than 200 lines, where autojunk has no effect anyway.


## s13
Situation: First Head for this task. You can run this project's test suite after the Head finishes.
Task brief:
Bug reports against the bank/ package (money.py, events.py, ledger.py, report.py). Find and fix the root causes; keep the public API (Event, Ledger.apply/replay/balances, InsufficientFunds, parse_amount, format_amount, balance_report).
1. Deposits of "0.29" or "19.99" show up a cent short.
2. Amounts like 5 cents print as "0.5" instead of "0.05"; -5 cents must print "-0.05".
3. A transfer of an account's entire balance is refused.
4. Reversing a transfer makes the money move in the same direction again instead of back.
5. Our event bus delivers at-least-once: replaying a stream where the same event id appears twice double-counts it. Applying an already-applied event id must be a no-op (it must not raise and must not be recorded twice).
6. Reversing an event id that was never applied crashes with StopIteration; it must raise KeyError. Reversing the same event twice (two different reverse events pointing at one original) must only reverse it once — the second is a no-op. Reversing a "reverse" event is not supported: raise ValueError.
7. A rejected event (InsufficientFunds) must leave balances and history untouched.
8. balance_report must list accounts by balance, highest first, ties by account name ascending; today "9.00" sorts above "10.00".
Acceptance: all eight hold; amounts stay integer cents everywhere.


## s14
Situation: First Head for this task. You can run this project's test suite after the Head finishes.
Task brief:
Implement `Sheet` in sheet.py: a small spreadsheet engine (standard library only, no eval/exec).
Cells and values
- Cell names are a column letter A–Z plus a row 1–999 (`A1`, `Z999`), case-insensitive on input, uppercase in output. Anything else passed to the API raises ValueError.
- `set(name, raw)`: raw is a str. "" clears the cell. A raw starting with "=" is a formula; otherwise if it parses as an int or float (Python syntax for int()/float(), e.g. "3", "-2.5", "1e3") the value is that number, else the value is the string itself.
- `get(name)`: the cell's current value: int/float/str, None for an empty cell, or an error string: "#DIV/0!", "#REF!", "#CYCLE!", "#VALUE!", "#NAME?".
- `raw(name)`: the raw text last set ("" for empty).
Formulas
- Grammar: + - * / with usual precedence and left associativity, unary minus, parentheses, numeric literals, cell references, ranges `A1:B3` (only inside functions), and functions SUM, MIN, MAX, AVG, COUNT, IF(cond, a, b), with comparison operators = <> < <= > >= returning 1 or 0 (only as the top level of IF's first argument or of a whole formula).
- Empty cells referenced directly count as 0. In ranges, SUM/MIN/MAX/AVG/COUNT skip empty and string cells; COUNT counts numeric cells; AVG always returns a float, and AVG of no numbers is "#DIV/0!"; MIN/MAX of no numbers is 0. Ranges may be given in any corner order (B3:A1 == A1:B3).
- A string cell used in arithmetic gives "#VALUE!". Division by zero gives "#DIV/0!". An unknown function name gives "#NAME?". A syntax error in the formula gives "#VALUE!".
- Errors propagate: any formula that reads an error value (directly or in a range) evaluates to that same error (the first one encountered in left-to-right evaluation order). IF only evaluates the branch it takes.
- Integer arithmetic stays int except `/`, which always gives float; a formula result that is a float with an integral value stays a float.
Recalculation
- Whenever a cell changes, every cell that depends on it (transitively) is recalculated, each exactly once per change, in dependency order. Expose `recalc_count` (an int attribute) incremented once per formula evaluation, so this is testable.
- Cycles: every cell on a cycle (and any cell that depends on a cycle cell) shows "#CYCLE!". When the cycle is broken by a later `set`, the cells recover their proper values.
- `#REF!`: a formula referencing a row > 999 or column outside A–Z (e.g. "=A1000", "=AA1") is "#REF!".
Undo
- `undo()` reverts the most recent `set` (any number of times, back to the empty sheet); values recalculate accordingly. Undo with nothing to undo is a no-op returning False; otherwise returns True.
Acceptance: all of the above; the hidden tests check values, propagation, recalc counts, cycles and undo.


## s15
Situation: First Head for this task. You can run this project's test suite after the Head finishes.
Task brief:
Customers report that our CSV importer (importer.py, `import_customers`) silently loses rows. samples/ holds three real exports and samples/README.md says what each should produce. Investigate why rows are lost, fix the root causes in general (not just for these files), and make the importer report every row it cannot import instead of dropping it silently.
Requirements:
- Every non-blank data row either becomes a Customer or adds exactly one `(line_number, message)` to `errors`, where line_number is the 1-based physical line on which that record starts.
- Header column order may vary and header names are case-insensitive with surrounding spaces ignored; a missing required column (id, name, email or balance) fails the whole file: return no customers and a single error at line 1.
- Keep the public API (`import_customers(text) -> ImportResult`, `Customer`, `ImportResult`). Standard library only.
Acceptance: the three samples produce what samples/README.md says, and no row is ever silently dropped.


## s16
Situation: First Head. There are no tests in this project and nothing can be executed here (no interpreter, no build); you will review the diff only before shipping.
Task brief:
Implement `Sheet` in sheet.py: a small spreadsheet engine (standard library only, no eval/exec).
Cells and values
- Cell names are a column letter A–Z plus a row 1–999 (`A1`, `Z999`), case-insensitive on input, uppercase in output. Anything else passed to the API raises ValueError.
- `set(name, raw)`: raw is a str. "" clears the cell. A raw starting with "=" is a formula; otherwise if it parses as an int or float (Python syntax for int()/float(), e.g. "3", "-2.5", "1e3") the value is that number, else the value is the string itself.
- `get(name)`: the cell's current value: int/float/str, None for an empty cell, or an error string: "#DIV/0!", "#REF!", "#CYCLE!", "#VALUE!", "#NAME?".
- `raw(name)`: the raw text last set ("" for empty).
Formulas
- Grammar: + - * / with usual precedence and left associativity, unary minus, parentheses, numeric literals, cell references, ranges `A1:B3` (only inside functions), and functions SUM, MIN, MAX, AVG, COUNT, IF(cond, a, b), with comparison operators = <> < <= > >= returning 1 or 0 (only as the top level of IF's first argument or of a whole formula).
- Empty cells referenced directly count as 0. In ranges, SUM/MIN/MAX/AVG/COUNT skip empty and string cells; COUNT counts numeric cells; AVG always returns a float, and AVG of no numbers is "#DIV/0!"; MIN/MAX of no numbers is 0. Ranges may be given in any corner order (B3:A1 == A1:B3).
- A string cell used in arithmetic gives "#VALUE!". Division by zero gives "#DIV/0!". An unknown function name gives "#NAME?". A syntax error in the formula gives "#VALUE!".
- Errors propagate: any formula that reads an error value (directly or in a range) evaluates to that same error (the first one encountered in left-to-right evaluation order). IF only evaluates the branch it takes.
- Integer arithmetic stays int except `/`, which always gives float; a formula result that is a float with an integral value stays a float.
Recalculation
- Whenever a cell changes, every cell that depends on it (transitively) is recalculated, each exactly once per change, in dependency order. Expose `recalc_count` (an int attribute) incremented once per formula evaluation, so this is testable.
- Cycles: every cell on a cycle (and any cell that depends on a cycle cell) shows "#CYCLE!". When the cycle is broken by a later `set`, the cells recover their proper values.
- `#REF!`: a formula referencing a row > 999 or column outside A–Z (e.g. "=A1000", "=AA1") is "#REF!".
Undo
- `undo()` reverts the most recent `set` (any number of times, back to the empty sheet); values recalculate accordingly. Undo with nothing to undo is a no-op returning False; otherwise returns True.
Acceptance: all of the above; the hidden tests check values, propagation, recalc counts, cycles and undo.


## s17
Situation: First Head. There are no tests in this project and nothing can be executed here (no interpreter, no build); you will review the diff only before shipping.
Task brief:
Bug report against ratelimit.py (`RateLimiter`). Find the root causes and fix them; keep the public API (`allow`, `remaining`, `retry_after`, constructor with injectable `clock`).
Reported symptoms:
1. With limit=3, users sometimes get a 4th call through inside one window.
2. A call recorded at time t counts only while now < t + window: at now = t + window it no longer counts. Today it is still counted.
3. `retry_after()` sometimes reports a wait after which `allow()` is still refused.
4. The clock can jump backwards (the injected clock is not always monotonic in production). After a backwards jump, the limiter must not lock users out for longer than `window` seconds of real progress: whenever the limiter reads the clock, rewrite every recorded call time later than `now` to `now` (permanently).
5. `remaining()` must never be negative, and `retry_after()` must never be negative.
6. limit=0 (a disabled key) crashes `retry_after()`; it must return `math.inf`, and `allow()` always refuses.
Acceptance: all six hold for any sequence of calls and clock values.


## s18
Situation: First Head. There are no tests in this project and nothing can be executed here (no interpreter, no build); you will review the diff only before shipping.
Task brief:
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


## s19
Situation: First Head. There are no tests in this project and nothing can be executed here (no interpreter, no build); you will review the diff only before shipping. (The diff is a pure rename you can verify by reading it.)
Task brief:
Rename the function `calc_total` to `compute_total`.
Files: shop/pricing.py (definition), shop/cart.py (import + 2 calls), shop/checkout.py (`pricing.calc_total` call), shop/report.py (import; keep its alias `ct`).
Constraints: do not rename `calc_discount`; do not change the dictionary key "calc_total_version" in checkout.py (it is a wire format); no other changes.
Acceptance: `compute_total` is the only name; every module imports and behaves exactly as before.


## s20
Situation: Retry: a Head at effort low finished this task, but 3 of 5 tests failed. You are sending it back. You can run this project's test suite after the Head finishes.
Task brief:
Implement `Sheet` in sheet.py: a small spreadsheet engine (standard library only, no eval/exec).
Cells and values
- Cell names are a column letter A–Z plus a row 1–999 (`A1`, `Z999`), case-insensitive on input, uppercase in output. Anything else passed to the API raises ValueError.
- `set(name, raw)`: raw is a str. "" clears the cell. A raw starting with "=" is a formula; otherwise if it parses as an int or float (Python syntax for int()/float(), e.g. "3", "-2.5", "1e3") the value is that number, else the value is the string itself.
- `get(name)`: the cell's current value: int/float/str, None for an empty cell, or an error string: "#DIV/0!", "#REF!", "#CYCLE!", "#VALUE!", "#NAME?".
- `raw(name)`: the raw text last set ("" for empty).
Formulas
- Grammar: + - * / with usual precedence and left associativity, unary minus, parentheses, numeric literals, cell references, ranges `A1:B3` (only inside functions), and functions SUM, MIN, MAX, AVG, COUNT, IF(cond, a, b), with comparison operators = <> < <= > >= returning 1 or 0 (only as the top level of IF's first argument or of a whole formula).
- Empty cells referenced directly count as 0. In ranges, SUM/MIN/MAX/AVG/COUNT skip empty and string cells; COUNT counts numeric cells; AVG always returns a float, and AVG of no numbers is "#DIV/0!"; MIN/MAX of no numbers is 0. Ranges may be given in any corner order (B3:A1 == A1:B3).
- A string cell used in arithmetic gives "#VALUE!". Division by zero gives "#DIV/0!". An unknown function name gives "#NAME?". A syntax error in the formula gives "#VALUE!".
- Errors propagate: any formula that reads an error value (directly or in a range) evaluates to that same error (the first one encountered in left-to-right evaluation order). IF only evaluates the branch it takes.
- Integer arithmetic stays int except `/`, which always gives float; a formula result that is a float with an integral value stays a float.
Recalculation
- Whenever a cell changes, every cell that depends on it (transitively) is recalculated, each exactly once per change, in dependency order. Expose `recalc_count` (an int attribute) incremented once per formula evaluation, so this is testable.
- Cycles: every cell on a cycle (and any cell that depends on a cycle cell) shows "#CYCLE!". When the cycle is broken by a later `set`, the cells recover their proper values.
- `#REF!`: a formula referencing a row > 999 or column outside A–Z (e.g. "=A1000", "=AA1") is "#REF!".
Undo
- `undo()` reverts the most recent `set` (any number of times, back to the empty sheet); values recalculate accordingly. Undo with nothing to undo is a no-op returning False; otherwise returns True.
Acceptance: all of the above; the hidden tests check values, propagation, recalc counts, cycles and undo.


## s21
Situation: Second retry: Heads at low and then at high both left 1 failing test. You are sending it back again. You can run this project's test suite after the Head finishes.
Task brief:
Implement `evaluate(source, variables=None)` in expr.py: a safe arithmetic evaluator (no eval/exec/ast/compile).
Grammar and semantics:
- Numbers: integers (`42`) and decimals (`3.5`, `.5`, `5.`); results are Python ints when every operand and operation stays integral (`7 // 2` style integer division does not exist; `/` always returns float), else floats.
- Identifiers `[A-Za-z_][A-Za-z0-9_]*` look up `variables`; unknown names raise EvalError at the identifier's start.
- Operators, lowest to highest precedence: `+ -` (left-assoc), `* / %` (left-assoc), unary `+ -` (prefix, may repeat: `--3` = 3), `^` power (RIGHT-assoc, and binds tighter than unary on its left but its right operand may itself be unary: `-2^2` = -4, `2^-1` = 0.5, `2^3^2` = 512).
- Parentheses; function calls `min(a, b, ...)`, `max(...)` (1+ args), `abs(x)`, `round(x)` (1 arg; Python round). Wrong arity or unknown function raises EvalError at the function name.
- Whitespace anywhere between tokens.
- Division or modulo by zero raises EvalError at the operator's position.
- Positions are 0-based character offsets into `source`. Syntax errors (unexpected token, missing `)`, trailing input, empty input) raise EvalError at the offending token's start (end of input = len(source)).
Acceptance: e.g. evaluate("2 + 3 * x", {"x": 4}) == 14; evaluate("1 +") raises EvalError with pos 3.


## s22
Situation: Retry: a Head at effort low left one failing test (a ragged CSV row imported with an empty email). You can run this project's test suite after the Head finishes.
Task brief:
Customers report that our CSV importer (importer.py, `import_customers`) silently loses rows. samples/ holds three real exports and samples/README.md says what each should produce. Investigate why rows are lost, fix the root causes in general (not just for these files), and make the importer report every row it cannot import instead of dropping it silently.
Requirements:
- Every non-blank data row either becomes a Customer or adds exactly one `(line_number, message)` to `errors`, where line_number is the 1-based physical line on which that record starts.
- Header column order may vary and header names are case-insensitive with surrounding spaces ignored; a missing required column (id, name, email or balance) fails the whole file: return no customers and a single error at line 1.
- Keep the public API (`import_customers(text) -> ImportResult`, `Customer`, `ImportResult`). Standard library only.
Acceptance: the three samples produce what samples/README.md says, and no row is ever silently dropped.


## s23
Situation: First Head. You can run the build and the app's 400-test suite. The task is a 30-file migration from one logging API to another, fully specified with a mapping table.
Task brief:
Replace every call to OldLog.x(...) with Logger.x(...) per MIGRATION.md (30 files, mapping table included). No behaviour change.

## s24
Situation: First Head. Production hotfix: nothing can be run locally and there are no tests for this module. The bug is known only by its symptom.
Task brief:
Users intermittently see another user's cart after logging in on a shared device. Find the cause in session/cache.py and fix it.

