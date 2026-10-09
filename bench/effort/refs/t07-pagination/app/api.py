from app.service import OrderService, InvalidCursor


def handle_list_orders(service: OrderService, query: dict) -> dict:
    raw = query.get("limit")
    try:
        limit = 20 if raw is None else int(raw)
    except ValueError:
        limit = 0
    if not 1 <= limit <= 100:
        return {"status": 400, "body": {"error": "invalid limit"}}
    try:
        orders, nxt = service.list_orders(status=query.get("status"), cursor=query.get("cursor"), limit=limit)
    except InvalidCursor:
        return {"status": 400, "body": {"error": "invalid cursor"}}
    return {"status": 200, "body": {"orders": orders, "next_cursor": nxt}}
