# Release gates

Both gates are mandatory:

1. `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v`
2. Run the privileged verifier on the approved Linux kernel with readable tracefs and effective UID 0; retain its signed report.

Static inspection or local decoder tests do not replace gate 2.
