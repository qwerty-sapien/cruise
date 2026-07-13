# Reservation service fixture

`reservations.py` stores inventory and reservations in SQLite.

Current behavior supports legacy calls:

```python
reserve(connection, "SKU-1", 2)
```

The new Goal must make client-request retries and concurrent duplicate delivery idempotent while retaining that legacy call during the current slice. The repository has no network or production dependency.

Run:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v
```
