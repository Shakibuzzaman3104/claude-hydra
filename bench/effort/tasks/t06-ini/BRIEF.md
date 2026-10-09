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
