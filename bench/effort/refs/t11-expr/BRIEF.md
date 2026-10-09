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
