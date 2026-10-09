Customers report that our CSV importer (importer.py, `import_customers`) silently loses rows. samples/ holds three real exports and samples/README.md says what each should produce. Investigate why rows are lost, fix the root causes in general (not just for these files), and make the importer report every row it cannot import instead of dropping it silently.
Requirements:
- Every non-blank data row either becomes a Customer or adds exactly one `(line_number, message)` to `errors`, where line_number is the 1-based physical line on which that record starts.
- Header column order may vary and header names are case-insensitive with surrounding spaces ignored; a missing required column (id, name, email or balance) fails the whole file: return no customers and a single error at line 1.
- Keep the public API (`import_customers(text) -> ImportResult`, `Customer`, `ImportResult`). Standard library only.
Acceptance: the three samples produce what samples/README.md says, and no row is ever silently dropped.
