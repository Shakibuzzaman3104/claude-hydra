from export.normalize import normalize

_norm = lambda r: normalize(r)



def to_csv(records):
    rows = [_norm(r) for r in records]
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
