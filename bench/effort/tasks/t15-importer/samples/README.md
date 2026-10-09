Three customer exports that lose rows in production (expected results from our support team):
- excel_windows.csv: should import 2 customers (Ann Lee 10.5, Bob 0.0). Today it imports 0.
- quoted.csv: should import 3 customers: "Lee, Ann", 'Bob "The Builder" Smith', and "Multi\nLine Name" (4.25). Today it imports none of the quoted ones correctly.
- eu_and_messy.csv: should import Ann with balance 1234.5 and Bob with 7.0; Cy has an empty balance, which means 0.0; Di's balance "abc" is invalid and must be REPORTED, not silently dropped.
