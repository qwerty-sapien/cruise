# Permissions and UI Verification

Front-load a truthful permission envelope and use localhost, browser control, or Computer Use only when it materially improves clarification or completion evidence.

## Table of contents

- [1. Two approval layers](#1-two-approval-layers)
- [2. Permission envelope](#2-permission-envelope)
- [3. Lock permissions precisely](#3-lock-permissions-precisely)
- [4. Discovery previews](#4-discovery-previews)
- [5. Tool selection](#5-tool-selection)
- [6. Localhost lifecycle](#6-localhost-lifecycle)
- [7. Browser verification](#7-browser-verification)
- [8. Computer Use](#8-computer-use)
- [9. Evidence quality](#9-evidence-quality)
- [10. Cleanup and interruption](#10-cleanup-and-interruption)

## 1. Two approval layers

Keep these distinct:

1. **Contract approval** — the user locks a permission boundary in `DECISIONS.md` and chooses Start.
2. **Runtime approval** — Codex, the sandbox, managed policy, a tool, an OS dialog, or a service may still require approval at action time.

Contract approval never overrides runtime enforcement. Runtime approval for one command never expands the contract. Require both when both apply.

## 2. Permission envelope

Classify expected capabilities before Start:

| Capability | Example | Default without locked permission |
| --- | --- | --- |
| Repository writes | Edit source/tests/docs in declared ownership | Allowed only after Start and within node scope |
| Planning writes | Write `.cruise/goal/` artifacts | Allowed before Start |
| Tests/builds | Unit tests, compiler, local build | Inspect side effects; stay in owned/temp paths |
| Dependency install | npm/pip/cargo downloads or lock changes | Ask up front; runtime approval may follow |
| Network read | Fetch docs, packages, remote metadata | Ask when material or restricted |
| Local process | Dev server, emulator, DB, worker | Ask up front with command, port, lifetime, cleanup |
| Browser control | In-app Browser, Chrome, Playwright | Ask when authenticated state or visible interaction is involved |
| Computer Use | Native app, OS UI, unsupported interaction | Separate explicit opt-in |
| Git history | Commit, tag, branch rewrite | Not implied by repository edits |
| Remote git | Push, PR, release | Separate explicit permission |
| External mutation | Deploy, migrate, send message, change SaaS state | Separate locked decision with exact target |
| High-risk effect | Destructive action, credentials, intrusive test, paid compute, production data | Never defer or infer; exact locked approval required |

Use `None approved` for capabilities not granted. Do not bundle a high-risk effect into a broad “all permissions” choice.

## 3. Lock permissions precisely

Each permission decision records:

- capability and purpose;
- exact target, paths, host, account, environment, port range, or resource;
- allowed operations and prohibited operations;
- owner;
- duration or expiry;
- cost/resource ceiling;
- data sensitivity boundary;
- required runtime approval;
- evidence and cleanup;
- reopening trigger.

Example:

```markdown
## D-04 — Local UX verification

- Status: Locked
- Allowed: run `npm run dev -- --port 4173` against local fixture data;
  control an isolated browser at `http://127.0.0.1:4173`;
  capture screenshots for AC-03.
- Prohibited: external hosts, real accounts, production data, persistent browser-profile changes.
- Owner: UI verification node
- Lifetime: one Cruise run; stop process after evidence capture
- Runtime approvals: still required when surfaced
- Evidence: command, PID, build identity, scenarios, screenshots, shutdown result
```

## 4. Discovery previews

A preview may be useful before the contract is locked when words cannot settle a material UX or workflow choice.

Use one of:

- **existing-state preview** — run the current app and inspect existing behavior;
- **disposable prototype** — create a bounded spike only in an approved temporary directory or isolated worktree;
- **reference-flow inspection** — examine an approved external or native workflow through a suitable tool.

Never merge, ship, or treat a disposable preview as implementation evidence. Record what it demonstrated and which decision it informed. If the preview would require production data, an external mutation, credentials, destructive setup, or paid resources, obtain a separate locked permission or do not run it.

The target repository remains implementation-inactive before Start unless the user explicitly creates and approves a narrowly scoped discovery exception. Prefer temporary isolation.

## 5. Tool selection

Choose the narrowest capable surface:

1. repository tests or API-level checks;
2. purpose-built connector or CLI;
3. Playwright or in-app Browser for isolated web flows;
4. Chrome control when the user's existing signed-in Chrome state is required;
5. Computer Use for native apps, OS dialogs, canvas/remote desktop, or interactions no safer tool exposes.

Follow the instructions for any selected tool skill. Do not claim a capability is unavailable without checking the tools surfaced in the current session.

Do not use Computer Use simply because it is visually convenient. It is less deterministic and can interact with broader desktop state.

## 6. Localhost lifecycle

Before launching:

- verify the command and expected writes;
- choose a loopback address and approved port;
- isolate caches, logs, DBs, uploads, and fixtures;
- avoid real credentials and production connections;
- record the source/build identity;
- define readiness, failure, and shutdown checks.

During the run:

- capture command, PID/session, URL, port, startup output, and readiness;
- keep the process inside the approved lifetime;
- detect port conflicts without killing unrelated processes;
- do not expose the server beyond loopback unless separately approved.

After evidence:

- stop only the tracked process/session;
- confirm the port closed;
- record retained artifacts;
- report cleanup failures rather than using broad process kills.

## 7. Browser verification

Define a reproducible scenario:

| Field | Required content |
| --- | --- |
| Build | Commit/tree/diff and build identity |
| Route | Exact URL and starting state |
| Environment | Browser/version, viewport, locale, theme, flags |
| Data | Fixture/account identity without secrets |
| Steps | Ordered interactions |
| Expected | Decidable observations tied to AC IDs |
| Evidence | Screenshot, trace, DOM/accessibility inspection, console/network result |
| Cleanup | Session, data, and process cleanup |

Use semantic/DOM/accessibility assertions when possible. Screenshots supplement, not replace, behavioral evidence. For visual requirements, approve a reproducible rubric or reference artifact.

Check critical alternate states: loading, empty, error, keyboard/focus, narrow viewport, and authorization boundaries when relevant.

## 8. Computer Use

Require a separate explicit opt-in because Computer Use can see and manipulate broad desktop state.

Before use:

- name the app/window, purpose, allowed interactions, prohibited areas, and expected evidence;
- minimize or close unrelated sensitive windows where feasible;
- avoid password managers, personal messages, and unrelated accounts;
- confirm whether a purpose-built connector, browser, or CLI can do the job more safely.

During use:

- stay within named apps/windows and approved actions;
- stop on unexpected authentication, purchase, destructive confirmation, privacy-sensitive content, or system-wide settings;
- never send, publish, purchase, delete, or change credentials without an exact separate approval;
- record observations and tool limitations honestly.

Computer-use screenshots alone do not prove backend state. Pair them with deterministic system or repository evidence when the criterion spans both.

## 9. Evidence quality

UI evidence must answer:

- which approved criterion it protects;
- which exact build and environment it used;
- what steps were performed;
- what observable result distinguishes pass from failure;
- whether the tool reported errors or hidden failures;
- whether data, process, browser, and desktop state were cleaned up.

Use status `NOT_RUN` when a required tool, permission, environment, or authenticated state is unavailable. Do not substitute a static code review for a mandatory end-to-end interaction unless the approved criterion allows it.

## 10. Cleanup and interruption

Track every process, temporary workspace, browser context, account mutation, downloaded dependency, and external effect.

Interrupt when:

- required permission was not locked or runtime approval is denied;
- the requested tool would expose unrelated sensitive state;
- the server connects to an unapproved external target;
- the preview requires implementation beyond its discovery scope;
- evidence cannot be tied to the approved build;
- cleanup cannot be performed safely;
- an observed UX contradiction changes product intent or acceptance criteria.

Report the exact state and safe next choices. Do not clean unrelated user state or terminate untracked processes.
