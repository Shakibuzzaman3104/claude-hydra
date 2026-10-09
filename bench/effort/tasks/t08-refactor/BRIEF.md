Refactor: the three exporters in export/ each carry their own copy of `_normalize`. Extract one shared normalizer into a new module export/normalize.py and make csv_export.py, json_export.py and xml_export.py use it, deleting their private `_normalize` functions.
Constraints:
- The output of `to_csv`, `to_json` and `to_xml` must stay byte-for-byte identical for every input. The three copies are NOT identical — read them carefully and make the shared function parameterised so each exporter keeps its exact current behaviour.
- Keep the public functions' names and signatures. No behaviour changes, no new dependencies.
Acceptance: no exporter defines its own `_normalize`; each imports from export.normalize; outputs unchanged.
