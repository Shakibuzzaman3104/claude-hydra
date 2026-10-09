def _normalize(record):
    out = {}
    for key, value in record.items():
        key = key.strip().lower().replace(" ", "_")
        if value is None:
            value = ""
        elif isinstance(value, bool):
            value = "true" if value else "false"
        elif isinstance(value, float):
            value = f"{value:.2f}"
        else:
            value = str(value).strip()
        out[key] = value
    return out


def to_csv(records):
    rows = [_normalize(r) for r in records]
    if not rows:
        return ""
    headers = sorted({k for row in rows for k in row})
    lines = [",".join(headers)]
    for row in rows:
        cells = []
        for h in headers:
            cell = row.get(h, "")
            if "," in cell or '"' in cell:
                cell = '"' + cell.replace('"', '""') + '"'
            cells.append(cell)
        lines.append(",".join(cells))
    return "\n".join(lines)
