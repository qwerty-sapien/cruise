# Native launch

In an existing conversation, use `$cruise:goal <task>` in Codex or
`/cruise:goal <task>` in Claude Code. The skill runs in that conversation with
its native permissions and tools. Use native subagents and peer messages for
delegation; do not start another Cruise process merely to invoke a skill.

When a separate terminal session is useful, use the installed launcher:

```sh
cruise --codex goal -C /absolute/workspace "Complete the requested task"
cruise --codex worker -C /absolute/worker-workspace "One bounded task"
```

Choose `--claude` for Claude Code. Each CLI launch starts a separate native
session using that host's configuration. Cruise omits permission overrides;
this does not establish that temporary grants from a different conversation
are copied. Resolve any native approval in the session that requests it.

Launch directly under the native host's permissions. Do not add an
agent-authored `sandbox-exec` profile or permission flags as routine setup.
The historical research wrapper imposed extra filesystem denials before
Node started; changing Cruise versions alone cannot repair that wrapper.
Use the installed launcher on PATH rather than a hardcoded plugin-cache path.

For scripted output capture, use a valid working directory and accessible
logging destinations. A FIFO is a named pipe: it streams output to a reader
rather than storing file contents. Node must be able to inspect its inherited
descriptors. An extra OS profile denying metadata access to an output FIFO can
abort Node before Cruise runs. With ordinary native access, a FIFO is usable.
If explicitly required isolation restricts inherited descriptors, use
continuously drained anonymous pipes between child and supervisor. Preserve
native interactive input; use closed input only for a deliberately headless run.

For an explicitly blinded study, establish role/key isolation through supported
native controls and check the actual launch, each role's own workspace, peer
workspaces, and key access before starting the study. If those controls cannot
provide the requested boundary, report the limitation. Removing an experimental
sandbox does not preserve its isolation claim. Keep prior failed attempts and
never replay a scientific experiment solely because startup now works.
