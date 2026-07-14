# Coding Conventions

**Analysis Date:** 2026-07-14

## Naming Patterns

**Files:**
- `.mjs` extension for all JavaScript files (ES modules)
- Kebab-case for file names: `app-server-client.mjs`, `goal-contract.mjs`, `yaml-state.mjs`
- Test files: `*.test.mjs` (e.g., `cli.test.mjs`, `session.test.mjs`)

**Functions:**
- camelCase for function names: `parseArgs()`, `readLineOnce()`, `createSession()`
- Verb-noun pattern for clarity: `verifyPlanApproval()`, `answerUserInputRequest()`, `fitTerminalLine()`
- Helper functions often start with verb: `ensurePlanningDirectory()`, `deferred()`, `preparationPrompt()`

**Variables:**
- camelCase for all variable and parameter names
- Descriptive names over abbreviations: `repositoryRoot` not `repoRoot`, `milestoneId` not `mId`
- Constants use CONSTANT_CASE when frozen: `DEFAULT_COLUMNS`, `TERMINAL_GOAL_STATUSES`, `PUBLIC_ROUTES`

**Types & Classes:**
- PascalCase for class constructors: `CruiseSession`, `FakeAppServer`, `MemoryOutput`
- PascalCase for custom error classes: `CruiseInterruptedError`, `GoalActivationUncertainError`

## Code Style

**Formatting:**
- 2-space indentation (consistent throughout)
- Single quotes for string literals
- Semicolons required at statement ends
- No visible external linter configuration file

**Spacing:**
- One blank line between function definitions
- No trailing commas in single-line arrays/objects
- Function parameters grouped on same line when reasonable

**Comments:**
- Single-line comments use `//` and explain intent, not implementation
- Multi-line comments use `/** ... */` for module-level and important function documentation
- Example from `picker.mjs`:
  ```javascript
  /**
   * Conservatively estimate terminal cells without a width-table dependency.
   * ASCII is one cell; all other printable code points count as two. This may
   * truncate early, but it avoids under-counting common wide glyphs and wrapping
   * a row that the redraw logic assumes occupies exactly one terminal line.
   */
  export function terminalCellWidth(value) { ... }
  ```

## Import Organization

**Order of imports:**
1. Node.js built-in modules (`node:*`)
2. Relative imports from other project modules

**Within each group:**
- Alphabetically sorted for consistency

**Example from `session.mjs`:**
```javascript
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';

import { activateApprovedGoal, captureGoalApproval, ... } from './goal-contract.mjs';
import { verifyBuildApproval } from './build-contract.mjs';
```

**Path aliases:**
- Not used; explicit relative paths throughout
- Makes file relationships clear without configuration

## Error Handling

**Error Types:**
- `throw new Error('message')` for general errors
- `throw new TypeError('message')` for type/shape validation failures (see `handoff.mjs`, `picker.mjs`)
- `throw new RangeError('message')` for value range failures
- Custom error classes for domain-specific errors: `CruiseInterruptedError`, `GoalActivationUncertainError`

**Error Messages:**
- Descriptive and actionable: include what went wrong and context
- Examples:
  - `"Cruise requires a non-empty request so ORIGIN.yaml can preserve actual triggering bytes."`
  - `"options must be a non-empty array"`
  - `"optionCount must be a positive integer"`

**Pattern for validation:**
```javascript
function assertOptionCount(optionCount) {
  if (!Number.isInteger(optionCount) || optionCount < 1) {
    throw new RangeError("optionCount must be a positive integer");
  }
}
```

**Validation timing:**
- Early validation at function entry points
- Throw immediately if inputs are invalid
- No silent failures or defaulting invalid inputs

## Logging

**Framework:**
- No external logging library; uses explicit output streams
- Dependency injection pattern: `output` and `errorOutput` parameters

**Pattern:**
```javascript
function write(output, value) {
  output.write(String(value));
}

function writeLine(output, value = '') {
  write(output, `${value}\n`);
}
```

**Usage:**
- `output.write()` for normal messages
- `errorOutput.write()` for errors and warnings
- Messages include context like operation status: `output.write("valid origin ${path}\n")`
- No `console.log` or `console.error` in main code

## Function Design

**Size:**
- Functions typically 30-150 lines
- Longer functions broken into helper functions or separate modules
- Example: `parseArgs()` spans ~150 lines but handles distinct argument parsing phases

**Parameters:**
- Few parameters (typically 1-5)
- Use objects for multiple related parameters (e.g., `{ repositoryRoot, repositoryBaselineDigest, projectOriginSha256, ... }`)
- Optional parameters placed last
- Destructure parameters when appropriate

**Return Values:**
- Explicit returns, even if undefined
- Object returns use consistent shape: `{ status: 'value', detail: 'message', ... }`
- Async functions return Promises
- Promise rejections used for error conditions (see testing patterns)

**Examples:**
```javascript
export function keypressToAction(char, key) {
  if (char === "\r" || key.name === "return") return { type: "select" };
  if (char === " " || key.name === "space") return { type: "select" };
  // ... more conditions
  return null; // Explicit null return
}
```

## Module Design

**Exports:**
- Named exports preferred over default exports
- Functions and classes exported individually
- No barrel files (index.mjs re-exporting); `package.json` exports define public API

**Example from `package.json` exports:**
```json
"exports": {
  "./session": "./scripts/lib/session.mjs",
  "./milestone-controller-host": "./scripts/lib/milestone-controller-host.mjs"
}
```

**Module responsibilities:**
- One primary concern per module (e.g., `picker.mjs` handles CLI picker logic, `yaml-state.mjs` handles YAML parsing/writing)
- Related functions grouped in same module
- Cross-module dependencies managed explicitly

**Pattern example from `routing.mjs`:**
```javascript
export const PUBLIC_ROUTES = Object.freeze([...]);
export const ROUTE_CONFIDENCE_THRESHOLD = 0.85;

export function requestedTargetChange(rawPrompt, targetPattern) { ... }
```

## Object Immutability

**Frozen Objects:**
- Constants using `Object.freeze()` throughout for clarity: `PUBLIC_SKILLS`, `TERMINAL_GOAL_STATUSES`, `PROMPT_GATE_PATTERNS`
- Indicates intent that object is immutable across runtime
- Used for configuration and readonly reference data

**Example:**
```javascript
export const PUBLIC_ROUTES = Object.freeze([
  'build',
  'quick',
  'refine',
  'goal',
  'debug',
  'research',
]);
```

## Destructuring

**Common patterns:**
- Destructure named imports: `import { mkdtemp, mkdir, realpath } from 'node:fs/promises';`
- Destructure function parameters when unpacking nested objects:
  ```javascript
  function milestoneControllerContext({
    milestonePath = '.cruise/milestones/M-003-safe-rollout',
    milestoneId = 'M-003',
    currentPhaseId = 'P-01',
    // ...
  } = {}) { ... }
  ```

---

*Convention analysis: 2026-07-14*
