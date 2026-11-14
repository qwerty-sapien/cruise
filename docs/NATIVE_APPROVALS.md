# Native Codex approval review

Codex Goal (including the default `start` command) and Codex workers accept a
request-scoped option:

```sh
cruise --codex goal --approvals-reviewer auto_review "Implement the requested change"
cruise --codex worker --approvals-reviewer user "Inspect the supplied source"
```

The accepted values are `user`, `auto_review`, and `guardian_subagent`. Other
providers and commands reject this option. It does not change saved Codex
configuration. With no override, TTY stdin selects `user`; non-TTY or headless
stdin selects `auto_review`. Pipe-driven callers that supply explicit choices
must select `user`.

Codex 0.169.0's generated v2 protocol accepts `approvalsReviewer` on
`thread/start`, `turn/start`, and `thread/settings/update`. Its default is `user`.
In that mode a headless escalation can reach the terminal picker after stdin
has closed. Selecting native `auto_review` instead routes the escalation to
Codex's context-gathering risk review. Cruise does not grant the request itself.
The startup diagnostic and model instructions identify the selected reviewer;
selection is not evidence that any action has been approved.

Goal forwards the same reviewer on thread creation, initial Plan settings and
explicit bootstrap, execution and continuation turns, and settings updates
before native Goal activation or reactivation. Workers forward it on both
thread creation and their turn. `approvalPolicy: 'on-request'` and existing
sandbox scopes remain in force. A rejected or unsupported reviewer surfaces as
an error; Cruise does not silently select a different reviewer.

Explicit `user` mode retains the distinction between a refusal and a missing
input channel. Decline/cancel is a refusal. EOF or an unavailable picker is an
approval-channel error, with no fabricated approval or denial. Any native
request that still reaches Cruise requires its existing handler; selecting
`auto_review` does not authorize auto-answering unknown native requests.

Actual native denial notifications remain binding. Do not retry the denied
action unchanged or route around the reviewer. Continue unaffected work; return
only with materially safer new evidence allowed by the host, or the missing
user decision. Explain that the automatic native reviewer rejected the action
and preserve its stated reason. Native availability and policy decisions are
separate from Cruise's mock transcript tests; these tests do not prove that a
live native reviewer will approve an action.
