class OrderService:
    def __init__(self, repo):
        self.repo = repo

    def list_orders(self, status=None):
        return self.repo.list_all(status=status)
