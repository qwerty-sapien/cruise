# Flight Plan

status: complete

## Outcome
Add `display_name(value)` to formatter.py: trim/collapse whitespace, title-case
the result. `format_name` behavior must remain unchanged. Add focused tests
in test_formatter.py and run the full local unittest suite.

## Scope / touchpoints
- formatter.py
- test_formatter.py

## Non-goals
- Do not modify config.py
- Do not change DEFAULT_STYLE
- Do not redesign format_name
- No package installs, no network, no commits

## Invariants
- `format_name` output unchanged for all existing/new tests
- `DEFAULT_STYLE` value in config.py unchanged
- No changes outside formatter.py / test_formatter.py

## Acceptance
- `python3 -m unittest discover -v` (or `python3 -m unittest test_formatter -v`) passes, full suite, no network/install

## Micro-goals
1. Implement display_name in formatter.py
2. Add focused tests for display_name (whitespace collapse/trim, title-case) without altering existing tests
3. Run full local unittest suite; confirm pass
