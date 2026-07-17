# Cruise operations

`cruise doctor` performs lightweight local availability checks. It does not
install host rules, require managed worker profiles, inspect plugin hashes, or
claim to test external DNS/service health.

Use ordinary Codex recovery when a model stream ends. The reported category is
based on the actual failure: DNS, connection, upstream, or unknown.
