"""Synthetic verifier whose credential is intentionally unavailable."""

import os
import sys


token = os.environ.get("ACME_SIGNING_TOKEN")
if token != "held-by-security-team":
    print("ERROR: mandatory ACME_SIGNING_TOKEN is unavailable", file=sys.stderr)
    raise SystemExit(23)

print("release credential verified")
