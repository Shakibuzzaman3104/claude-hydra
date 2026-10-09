import base64, binascii


class InvalidCursor(ValueError):
    pass


def _enc(status, last):
    return base64.urlsafe_b64encode(f"v1:{status or ''}:{last}".encode()).decode().rstrip("=")


def _dec(cursor, status):
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
    except (binascii.Error, ValueError, UnicodeDecodeError):
        raise InvalidCursor(cursor)
    parts = raw.split(":")
    if len(parts) != 3 or parts[0] != "v1" or parts[1] != (status or ""):
        raise InvalidCursor(cursor)
    try:
        last = int(parts[2])
    except ValueError:
        raise InvalidCursor(cursor)
    if last <= 0:
        raise InvalidCursor(cursor)
    return last


class OrderService:
    def __init__(self, repo):
        self.repo = repo

    def list_orders(self, status=None, cursor=None, limit=20):
        after = _dec(cursor, status) if cursor is not None else None
        rows = self.repo.list_page(status=status, after_id=after, limit=limit + 1)
        page = rows[:limit]
        return page, (_enc(status, page[-1]["id"]) if len(rows) > limit else None)
