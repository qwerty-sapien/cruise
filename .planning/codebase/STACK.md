# Technology Stack

**Analysis Date:** 2026-07-14

## Languages

**Primary:**
- JavaScript (ES modules) - All runtime code, CLI, and plugin implementation

## Runtime

**Environment:**
- Node.js 20+ (required in `engines` field)
- macOS/Unix environment for development

**Package Manager:**
- npm (implied by `package.json`, no lock file present)
- Lockfile: Not committed to repository

## Frameworks

**Core:**
- Codex app-server - RPC protocol client for IDE integration via stdio
  - SDK/Client: Custom `AppServerClient` in `scripts/lib/app-server-client.mjs`
  - No external npm dependency

**Testing:**
- Node.js built-in `node:test` module - All unit and integration tests
- Node.js built-in `node:assert/strict` module - Assertions

**Build/Dev:**
- No build tool required - ES modules run directly with Node.js
- Custom validation suite in `scripts/validate-suite.mjs` for contract verification

## Key Dependencies

**Critical (Built-in Node.js modules only):**
- `node:child_process` - Spawning external commands (git, renderers)
- `node:fs/promises` - Asynchronous filesystem operations
- `node:path` - Path resolution and manipulation
- `node:crypto` - SHA-256 hashing, UUID generation
- `node:os` - Home directory, temp directory access
- `node:readline/promises` - Interactive terminal input
- `node:url` - URL/file path conversion
- `node:events` - EventEmitter for RPC protocol
- `node:stream` - Stream handling

**Internal (No External Packages):**
- Custom YAML parser/serializer in `scripts/lib/yaml-state.mjs`
- No database libraries (state persisted as YAML files)
- No external templating engines

**Optional External Tools (Runtime dependencies, not npm):**
- `glow` - Primary markdown renderer (attempts to spawn)
- `python3` with `rich` library - Fallback markdown renderer (attempts to spawn)
- `git` - Repository inspection via `spawnSync`

## Configuration

**Environment:**
- `CODEX_HOME` - Location of Codex configuration directory (defaults to `~/.codex`)
- `PATH` - Used to locate external tools (glow, git, python3)

**Build:**
- No build configuration files present
- Direct execution via Node.js CLI

## Platform Requirements

**Development:**
- Node.js 20 or higher
- Git installed for repository operations
- Codex application installed (required for plugin to function)

**Production:**
- Node.js 20 or higher
- Codex application with app-server capability
- Optional: `glow` or `python3` with `rich` for enhanced plan preview rendering

## CLI & Plugin Integration

**Entry Points:**
- `scripts/cruise.mjs` - Terminal CLI for Goal workflow execution (7 worker levels)
- `scripts/cruise-runtime.mjs` - Worker execution runtime (internal use only)
- Exported modules:
  - `./session` → `scripts/lib/session.mjs` - Session management
  - `./milestone-controller-host` → `scripts/lib/milestone-controller-host.mjs` - Milestone control

**Plugin Manifest:**
- `.codex-plugin/plugin.json` - Codex integration configuration
  - Declares 6 public skills: build, quick, refine, goal, debug, research
  - Skills directory: `./skills/`
  - License: MIT

## Testing Infrastructure

**Run Commands:**
```bash
npm test                # Run all test files
npm run validate        # Validate suite contracts and policies
npm run test:evals      # Run evaluation test suites
npm run test:evals:static    # Static analysis tests only
npm run test:evals:behavior  # Behavior/integration tests
```

**Test Organization:**
- Location: `tests/` directory (co-located with main code)
- Test files pattern: `*.test.mjs`
- 29+ test files covering routing, contract validation, discovery, provisioning, and workflow policy

## Data Persistence

**Format:**
- YAML for state/configuration (custom parser, not external library)
- No JSON or binary formats for runtime state
- No database (filesystem-based state)

**Locations:**
- `.cruise/` - Project and milestone state
- `.cruise/runs/` - Individual run state
- `.cruise/goal/` - Goal workflow state
- `.codex-plugin/` - Plugin configuration

---

*Stack analysis: 2026-07-14*
