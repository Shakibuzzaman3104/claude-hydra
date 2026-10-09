import json


def _normalize(record):
    out = {}
    for key, value in record.items():
        key = key.strip().lower().replace(" ", "_")
        if value is None:
            value = None
        elif isinstance(value, bool):
            value = value
        elif isinstance(value, float):
            value = round(value, 2)
        else:
            value = str(value).strip()
        out[key] = value
    return out


def to_json(records):
    return json.dumps([_normalize(r) for r in records], sort_keys=True)
