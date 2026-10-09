from collections import OrderedDict


def _check(capacity):
    if isinstance(capacity, bool) or not isinstance(capacity, int) or capacity < 0:
        raise ValueError("capacity must be an int >= 0")


class LRUCache:
    def __init__(self, capacity, on_evict=None):
        _check(capacity)
        self.capacity, self.on_evict = capacity, on_evict
        self._d = OrderedDict()
        self._s = {"hits": 0, "misses": 0, "evictions": 0}

    def get(self, key, default=None):
        if key in self._d:
            self._d.move_to_end(key, last=False); self._s["hits"] += 1
            return self._d[key]
        self._s["misses"] += 1
        return default

    def peek(self, key, default=None):
        return self._d.get(key, default)

    def __contains__(self, key):
        return key in self._d

    def __len__(self):
        return len(self._d)

    def keys(self):
        return list(self._d)

    def _shrink(self, cap):
        error = None
        while len(self._d) > cap:
            k, v = self._d.popitem(last=True); self._s["evictions"] += 1
            if self.on_evict:
                try:
                    self.on_evict(k, v)
                except Exception as e:
                    error = error or e
        if error:
            raise error

    def put(self, key, value):
        if self.capacity == 0:
            return
        self._d[key] = value
        self._d.move_to_end(key, last=False)
        self._shrink(self.capacity)

    def resize(self, new_capacity):
        _check(new_capacity)
        self.capacity = new_capacity
        self._shrink(new_capacity)

    def stats(self):
        return dict(self._s)
