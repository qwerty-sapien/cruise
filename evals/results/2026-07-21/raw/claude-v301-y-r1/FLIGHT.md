# Flight Plan

status: complete

## Outcome
Refactor `slugify` and `tag_key` in text_tools.py to share one Unicode-aware
normalization helper (casefold + Unicode whitespace splitting via NFKC),
while keeping distinct separators ("-" vs "_") and unchanged public
signatures. Add regression tests for mixed Unicode whitespace/casing.

## Scope fence
- touchpoints: text_tools.py, test_text_tools.py
- non_goals: no new deps, no network, no commit, no other files

## Invariants
- slugify(value) -> str, tag_key(value) -> str signatures unchanged
- slugify uses "-" separator, tag_key uses "_" separator
- Existing test behavior (ASCII cases) preserved

## Acceptance
- python -m unittest discover (or run test_text_tools.py) passes
