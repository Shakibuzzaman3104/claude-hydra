Extend `parse_duration` in duration.py.
- Units: d (86400), h (3600), m (60), s (1).
- Combined forms: "1h30m", "1h 30m 10s", "2d4h". Spaces are allowed only between parts (and around the whole string, which is stripped).
- Units must appear in strictly descending order (d, h, m, s) and at most once each: "30m1h" and "1h1h" are errors.
- A bare number with no unit, e.g. "90", means seconds — but only when it is the entire input ("1h 30" is an error).
- Errors raise ValueError: empty or whitespace-only input, negative numbers or signs ("-5m", "+5m"), unknown units, decimals ("1.5h"), uppercase units ("5M").
- "0s" and "0" are valid and return 0.
Acceptance: returns an int number of seconds; existing "90s"/"5m" keep working.
