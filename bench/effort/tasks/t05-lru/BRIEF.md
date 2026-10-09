Implement `LRUCache` in lru.py (standard library only; no functools.lru_cache).
- `LRUCache(capacity, on_evict=None)`: capacity is an int >= 0, else ValueError (also for non-int, bools included). Capacity 0 stores nothing (put is a no-op that does NOT call on_evict).
- `get(key, default=None)`: returns the value and marks it most recently used; a miss returns default and changes nothing.
- `put(key, value)`: inserts or updates; either way the key becomes most recently used. Inserting beyond capacity evicts the least recently used entry and calls `on_evict(key, value)` for it. Updating an existing key never evicts.
- `peek(key, default=None)`: like get but does not change recency.
- `key in cache` does not change recency. `len(cache)` is the entry count.
- `keys()`: list of keys from most to least recently used.
- `resize(new_capacity)`: same validation; shrinking evicts LRU entries (calling on_evict for each, oldest first).
- `stats()`: dict {"hits": int, "misses": int, "evictions": int}; get counts hits/misses, peek does not.
- If on_evict raises, the eviction still completes and the exception propagates to the caller after the cache is consistent.
Acceptance: all operations O(1) except keys()/resize; behaviour exactly as above.
