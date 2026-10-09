from export.normalize import normalize

_norm = lambda r: normalize(r, none=None, keep_bool=True, round_floats=True)

import json




def to_json(records):
    return json.dumps([_norm(r) for r in records], sort_keys=True)
