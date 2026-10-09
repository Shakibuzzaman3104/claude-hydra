class InMemoryRepo:
    def __init__(self, rows=None):
        self._rows = {row["id"]: dict(row) for row in rows or []}

    def insert(self, row):
        self._rows[row["id"]] = dict(row)

    def delete(self, row_id):
        self._rows.pop(row_id, None)

    def list_all(self, status=None):
        return self.list_page(status=status, limit=None)

    def list_page(self, status=None, after_id=None, limit=20):
        rows = [r for i, r in sorted(self._rows.items()) if (after_id is None or i > after_id) and (status is None or r["status"] == status)]
        return [dict(r) for r in (rows if limit is None else rows[:limit])]
