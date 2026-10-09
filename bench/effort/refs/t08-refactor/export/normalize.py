def normalize(record, none="", keep_bool=False, round_floats=False, dash_to_underscore=False, drop_none=False):
    out = {}
    for key, value in record.items():
        key = key.strip().lower().replace(" ", "_")
        if dash_to_underscore:
            key = key.replace("-", "_")
        if value is None:
            if drop_none:
                continue
            value = none
        elif isinstance(value, bool):
            value = value if keep_bool else ("true" if value else "false")
        elif isinstance(value, float):
            value = round(value, 2) if round_floats else f"{value:.2f}"
        else:
            value = str(value).strip()
        out[key] = value
    return out
