def _normalize(record):
    out = {}
    for key, value in record.items():
        key = key.strip().lower().replace(" ", "_").replace("-", "_")
        if value is None:
            continue
        elif isinstance(value, bool):
            value = "true" if value else "false"
        elif isinstance(value, float):
            value = f"{value:.2f}"
        else:
            value = str(value).strip()
        out[key] = value
    return out


def _escape(text):
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def to_xml(records):
    parts = ["<records>"]
    for record in records:
        row = _normalize(record)
        fields = "".join(f"<{k}>{_escape(v)}</{k}>" for k, v in sorted(row.items()))
        parts.append(f"<record>{fields}</record>")
    parts.append("</records>")
    return "".join(parts)
