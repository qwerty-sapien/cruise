# Cruise

Cruise is a small Codex plugin with five intent-oriented skills: Build, Quick,
Refine, Goal, and Debug. It uses normal Codex conversations, permissions, and
native Goal state instead of a Cruise-owned workflow authority.

## Persistent state

On an explicit `cruise` invocation, Cruise writes exactly one managed file:

```text
.cruise/ORIGIN.md
```

Its contents are the user’s request exactly as received. It is a convenience
note, not an approval, checksum, baseline, archive, or immutable contract. A
later explicit invocation replaces it. Cruise never creates run directories,
YAML control artifacts, hashes, packets, reports, archives, or retry ledgers.

## Using Cruise

```sh
cruise quick -C ~/src/app "Fix the failing parser test"
cruise refine -C ~/src/app "Plan and implement safer retries"
cruise goal -C ~/src/app "Complete the migration with verification"
cruise worker -C ~/src/app "Run the focused verification"
```

`cruise goal` is the autonomous lane. It activates a native Goal and starts a
new continuation turn whenever the Goal is still active after a completed turn.
The agent evaluates each subtask’s evidence and moves to the next ready one;
phase gates are not user approvals. Cruise asks only for material unresolved
product decisions and host-required approvals for sensitive, external, or
destructive effects.

Ordinary Codex approvals still govern commands, file changes, network access,
and external effects. A worker reports factual transport failures: an upstream
HTTP 503 is an upstream failure, not a DNS failure. Cruise may retry a transport
failure once before any tool or file activity; otherwise a normal follow-up can
retry without a magic phrase or a fresh run.
