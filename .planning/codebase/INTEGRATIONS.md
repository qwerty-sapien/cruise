# External Integrations

**Analysis Date:** 2026-07-14

## APIs & External Services

**Codex IDE Integration:**
- Service: Anthropic Codex application (IDE plugin)
- What it's used for: Goal workflow execution, model catalog access, user input/approval
- SDK/Client: Custom RPC client via stdio protocol
  - Implementation: `scripts/lib/app-server-client.mjs`
  - Communication: JSONL-based RPC over stdin/stdout
  - Methods: `model/list`, `thread/goal/get`, `thread/goal/set`, `item/tool/requestUserInput`
  - No external npm dependency for this protocol

**Model Access (via Codex):**
- Service: Anthropic models (Luna, Terra, Sol tiers)
- Models configured:
  - `gpt-5.6-luna` - Level 1 coordination (medium reasoning)
  - `gpt-5.6-terra` - Levels 2-4 work execution (medium/high/xhigh reasoning)
  - `gpt-5.6-sol` - Levels 5-7 critical work (high/xhigh/ultra reasoning)
- Auth: Codex handles auth; Cruise does not manage API keys
- Config: `scripts/lib/model-policy.mjs` - Model tier definitions

**Repository Inspection:**
- Service: Git CLI (local filesystem)
- What it's used for: Baseline capture, commit inspection, file tracking
- Client: `node:child_process` spawning `git` commands
- Auth: None (local repository access)
- Usage locations:
  - `scripts/lib/origin.mjs` - Repository baseline capture
  - `scripts/lib/routing.mjs` - Repository analysis for skill routing

## Data Storage

**Databases:**
- Not used - No external database integrations
- All state persisted as YAML files in `.cruise/` directory

**File Storage:**
- Local filesystem only
  - Project state: `.cruise/project/`
  - Milestone state: `.cruise/milestones/`
  - Goal state: `.cruise/goal/`
  - Run state: `.cruise/runs/`
- No cloud storage integration

**Caching:**
- In-memory only during execution
- No external cache service

## Authentication & Identity

**Auth Provider:**
- Custom/None - Cruise does not manage authentication
- Codex application handles IDE authentication
- Git operations use local repository credentials (system git config)
- Workers spawned via Codex app-server inherit parent authentication context

**Sandbox & Authorization:**
- Implementation: Custom sandbox policy engine
  - `scripts/lib/provision-policy.mjs` - Capability provisioning rules
  - `scripts/lib/worker-policy.mjs` - Worker execution constraints
  - `scripts/lib/handoff.mjs` - Handoff boundary validation
- No external identity provider

## Monitoring & Observability

**Error Tracking:**
- None - Errors logged to stderr/stdout
- No external error tracking service

**Logs:**
- Stdout/stderr only
- No persistent logging to external service
- Run state captured in `.cruise/runs/<run-id>/` YAML files for diagnostics

## CI/CD & Deployment

**Hosting:**
- Not deployed as a service
- Distributed as npm plugin for Codex
- Repository: https://github.com/qwerty-sapien/cruise

**CI Pipeline:**
- No detected CI/CD configuration
- Local validation via `npm run validate` and `npm test`
- Evaluation suite for behavior verification

## Environment Configuration

**Required env vars:**
- `CODEX_HOME` (optional) - Codex configuration directory (defaults to `~/.codex`)
- `PATH` - System PATH (used to locate git, glow, python3)

**Secrets location:**
- No secrets managed by Cruise
- Codex authentication stored in `~/.codex/` (parent application)
- Repository credentials delegated to git (system git config)

**System Dependencies:**
- `git` - Required for repository inspection
- `glow` - Optional markdown renderer (CLI tool)
- `python3` - Optional fallback markdown renderer with `rich` library

## Webhooks & Callbacks

**Incoming:**
- None - Cruise is CLI-driven only

**Outgoing:**
- None - No external callbacks or webhooks

## Worker Communication

**Protocol:**
- Codex app-server RPC via stdio
- JSONL-formatted requests/responses
- Bidirectional communication with request/response binding

**Worker Isolation:**
- Each worker runs in isolated `node:child_process` spawned via Codex
- Private runtime snapshot (not writing to host `~/.codex` state)
- Sandbox enforcement via Codex app-server permissions

## Provision & Capability Discovery

**Sources:**
- Host-native tools (Codex bundled)
- Installed plugins or skills
- Repository-local skills (`.cruise/skills/`)
- User local skills (Codex user directory)
- MCP servers (if configured in Codex)
- Cruise bundled skills (6 public skills)

**Trust Model:**
- Official (bundled/upstream)
- Allowlisted (pre-approved)
- Established-community (1000+ stars)
- Uncertain (requires approval)
- Rejected (blocked)

## Plan Rendering

**Markdown Renderers (External Tools):**

1. **Primary:** `glow` CLI tool
   - Used for terminal-friendly markdown rendering
   - Command: `glow -s dark -w <width> -`
   - Fallback if not installed

2. **Secondary:** `python3` with `rich` library
   - Used if `glow` unavailable
   - Command: `python3 -c '<rich markdown renderer>'`
   - Fallback if `python3` not available

3. **Tertiary:** Plain text wrapping (built-in)
   - No external dependencies
   - Always works

## External Contracts & Boundaries

**Plugin Manifest:**
- Location: `.codex-plugin/plugin.json`
- Declares interface with Codex
- Registers 6 public skills with default prompts

**Schema Validation:**
- All YAML state validated against schemas in `internal/schemas/`
- Schemas are YAML files, not external services
- Custom schema validator in `scripts/lib/yaml-state.mjs`

## Network Access

**Direct Network:**
- None - Cruise makes no direct network calls
- All network access flows through Codex app-server (parent application)

**Proxy/VPN:**
- Respects system proxy configuration (inherited from Codex)
- No explicit proxy handling in Cruise

---

*Integration audit: 2026-07-14*
