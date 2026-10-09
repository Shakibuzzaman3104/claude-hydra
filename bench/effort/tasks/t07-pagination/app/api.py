from app.service import OrderService


def handle_list_orders(service: OrderService, query: dict) -> dict:
    status = query.get("status")
    orders = service.list_orders(status=status)
    return {"status": 200, "body": {"orders": orders}}
