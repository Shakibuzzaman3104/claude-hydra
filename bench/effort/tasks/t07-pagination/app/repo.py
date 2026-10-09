class InMemoryRepo:
    def __init__(self, rows=None):
        self._rows = {row["id"]: dict(row) for row in rows or []}

    def insert(self, row):
        self._rows[row["id"]] = dict(row)

    def delete(self, row_id):
        self._rows.pop(row_id, None)

    def list_all(self, status=None):
        rows = self._rows.values()
        if status is not None:
            rows = [row for row in rows if row["status"] == status]
        return [dict(row) for row in rows]
