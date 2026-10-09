Rename the function `calc_total` to `compute_total`.
Files: shop/pricing.py (definition), shop/cart.py (import + 2 calls), shop/checkout.py (`pricing.calc_total` call), shop/report.py (import; keep its alias `ct`).
Constraints: do not rename `calc_discount`; do not change the dictionary key "calc_total_version" in checkout.py (it is a wire format); no other changes.
Acceptance: `compute_total` is the only name; every module imports and behaves exactly as before.
