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
