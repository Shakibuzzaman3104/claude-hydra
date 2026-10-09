from export.normalize import normalize

_norm = lambda r: normalize(r, dash_to_underscore=True, drop_none=True)



def _escape(text):
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def to_xml(records):
    parts = ["<records>"]
    for record in records:
        row = _norm(record)
        fields = "".join(f"<{k}>{_escape(v)}</{k}>" for k, v in sorted(row.items()))
        parts.append(f"<record>{fields}</record>")
    parts.append("</records>")
    return "".join(parts)
