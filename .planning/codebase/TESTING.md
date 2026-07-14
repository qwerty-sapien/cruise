# Testing Patterns

**Analysis Date:** 2026-07-14

## Test Framework

**Runner:**
- Node.js built-in test runner (node:test)
- No external test framework (Jest, Vitest, etc.)
- Node.js 20+ required (specified in `package.json` engines field)

**Assertion Library:**
- `node:assert/strict` for all assertions
- Strict mode enables stricter equality checks (`===`)

**Run Commands:**
```bash
npm test                    # Run all tests in tests/*.test.mjs
npm run test:evals          # Run evaluation-focused tests
npm run test:evals:static   # Run static analysis tests only
npm run test:evals:behavior # Run behavioral evaluation tests
```

**All tests run via:** `node --test tests/*.test.mjs`

## Test File Organization

**Location:**
- All test files in `tests/` directory
- Co-located helpers in `tests/helpers/` subdirectory

**Naming:**
- Test files: `*.test.mjs` (e.g., `cli.test.mjs`, `session.test.mjs`, `picker.test.mjs`)
- Helper modules: descriptive names like `build-contract-artifacts.mjs`, `milestone-runtime-fixture.mjs`

**Test file mapping:**
- `tests/session.test.mjs` → `scripts/lib/session.mjs`
- `tests/picker.test.mjs` → `scripts/lib/picker.mjs`
- `tests/cli.test.mjs` → `scripts/cruise.mjs`
- `tests/interaction.test.mjs` → `scripts/lib/interaction.mjs`
- `tests/workflow-policy.test.mjs` → `scripts/lib/workflow-policy.mjs`

**Coverage:**
- Approximately 30+ test files covering core modules
- Focused on contract validation, state transitions, and error cases

## Test Structure

**Basic Pattern:**
```javascript
import assert from 'node:assert/strict';
import test from 'node:test';

test('test description in plain English', () => {
  // Arrange
  const input = createTestData();
  
  // Act
  const result = functionUnderTest(input);
  
  // Assert
  assert.equal(result.status, 'expected');
});
```

**Async Test with Cleanup:**
```javascript
test('creates temporary directory and cleans up', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'test-'));
  
  t.after(() => rm(directory, { recursive: true, force: true }));
  
  // Test code here
  assert.ok(await stat(directory));
});
```

**Context Parameter (t):**
- Available as second parameter in test function signature
- `t.after(callback)` registers cleanup functions (runs after test completes)
- Used for file system cleanup and resource disposal

**Test Descriptions:**
- Start with lowercase verb or article: "rejects root-model overrides...", "doctor model policy requires..."
- Describe the test outcome, not the implementation
- Example: "terminal session rejects an absent request instead of inventing Origin bytes"

## Mocking

**Framework:**
- No external mocking library; use handwritten mock classes
- Approach: Create fake implementations that mimic the real interface

**Mock Pattern (from `session.test.mjs`):**
```javascript
class FakeAppServer extends EventEmitter {
  constructor({
    labels = ['Approve Plan', 'Start Cruise'],
    onResponse = null,
    onTurnStart = null,
    // ... many configuration options
  } = {}) {
    super();
    this.labels = labels;
    this.calls = [];    // Track all method calls
    this.responses = []; // Track all responses
    // ... initialize state
  }

  async start() {
    this.calls.push({ method: 'initialize' });
    return {};
  }

  async request(method, params) {
    this.calls.push({ method, params });
    // Conditional responses based on method
    if (method === 'thread/start') return { thread: { id: 'thread-test' }, ... };
    if (method === 'turn/start') { /* emit events */ }
    throw new Error(`Unexpected request: ${method}`);
  }
}
```

**Mock Features:**
- Extend real classes when possible (e.g., `FakeAppServer extends EventEmitter`)
- Track all calls: `this.calls.push({ method, params })`
- Support conditional behavior via constructor options
- Emit events that the real implementation would emit: `this.emit('notification', { ... })`
- Throw for unexpected calls: `throw new Error(\`Unexpected request: ${method}\`)`

**Another Mock Example (from `picker.test.mjs`):**
```javascript
class FakeInput extends EventEmitter {
  constructor({ isTTY = true, isRaw = false, readableFlowing = null } = {}) {
    super();
    this.isTTY = isTTY;
    this.isRaw = isRaw;
    this.readableFlowing = readableFlowing;
    this.rawModeCalls = [];  // Record method calls
    this.resumeCalls = 0;
    this.pauseCalls = 0;
  }

  setRawMode(value) {
    this.rawModeCalls.push(value);
    this.isRaw = value;
    return this;
  }

  resume() {
    this.resumeCalls += 1;
    this.readableFlowing = true;
    return this;
  }
}
```

## Fixtures and Factories

**Test Data Creation:**
Located in `tests/helpers/`, exported as functions that return test data objects.

**Factory Function Pattern (from `workflow-policy.test.mjs`):**
```javascript
function evidenceItem(id, status, supports = []) {
  return createEvidenceItem({
    id,
    gate: 'mandatory',
    scope: 'task',
    status,
    performed: true,
    procedure: `Perform ${id}`,
    // ... more fields
    identity: { source: 'test fixture', build: 'test', environment: 'node:test' },
  });
}

function planApproval(overrides = {}) {
  return {
    selectedLabel: 'Approve Plan',
    planDigest: DIGEST_A,
    currentPlanDigest: DIGEST_A,
    repositoryBaselineDigest: DIGEST_A,
    // ... more fields
    ...overrides,  // Allow overrides
  };
}
```

**File System Fixtures (from `session.test.mjs`):**
```javascript
async function createContract({ mutateOrigin = null } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'cruise-session-test-'));
  const directory = join(cwd, '.cruise', 'goal');
  await mkdir(directory, { recursive: true });
  
  // Write test artifacts
  await writeFile(join(directory, 'ORIGIN.yaml'), stringifyYaml(origin));
  await writeFile(join(directory, 'SPEC.md'), '# Specification\n');
  await writeFile(join(directory, 'PLAN.md'), '# Approved plan\n');
  
  return { cwd, directory };
}
```

**Fixture Helper Pattern (from `picker.test.mjs`):**
```javascript
function gate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };  // Return deferred-style object
}
```

## Test Patterns

**Async Error Testing:**
```javascript
test('controls raise on invalid state', async () => {
  const client = new FakeAppServer({ /* options */ });
  const session = createSession(client, cwd);

  await assert.rejects(
    session.run(),
    /interrupted/,  // Regex or error class to match
  );
  assert.equal(client.stopped, true);
});
```

**Event-based Testing:**
```javascript
test('emits milestone ready event', async (t) => {
  const client = new FakeAppServer();
  const { session } = createSession(client, cwd);
  let readyDriver = null;

  session.once('milestoneControllerReady', (driver) => {
    readyDriver = driver;
  });

  const result = await session.run();

  assert.equal(readyDriver.describe().milestone_id, 'M-003');
});
```

**Deep Equality Testing:**
```javascript
test('preserves exact response order', async () => {
  const client = new FakeAppServer();
  const { session } = createSession(client, cwd);
  const result = await session.run();

  assert.deepEqual(
    client.responses.map(({ id }) => id),
    ['q0', 'q1', 'q2'],
  );
});
```

**Regex Matching:**
```javascript
test('validates certificate chain', async () => {
  const result = validateChain(data);

  assert.match(result.detail, /sha256:[0-9a-f]{64}/);
  assert.doesNotMatch(result.detail, /fallback|warn/iu);
});
```

**State Inspection After Test:**
```javascript
test('state transitions correctly', () => {
  const initial = { cursor: 0 };
  const up = reducePicker(initial, { type: "up" }, 3);

  assert.deepEqual(initial, { cursor: 0 });          // Original unchanged
  assert.deepEqual(up, { state: { cursor: 2 }, outcome: null }); // New state
});
```

## Common Assertions

**Pattern Assertions:**
```javascript
assert.equal(result.status, 'complete');
assert.ok(isValid);
assert.throws(() => functionThatThrows(), /error message/);
assert.deepEqual(object, expectedObject);
assert.match(string, /regex/);
assert.doesNotMatch(string, /regex/);
assert.strictEqual(value, expectedValue);
```

## Async Testing Patterns

**Waiting for Events:**
```javascript
const { cwd } = await createContract();
const client = new FakeAppServer();
const { session } = createSession(client, cwd);

const requestSeen = new Promise((resolve) => client.once('request', resolve));
const running = session.run();
await requestSeen;

// Now perform action that requires the running state
await session.interrupt();
```

**Testing with PassThrough Streams:**
```javascript
test('propagates typed cancellation', async () => {
  const input = new PassThrough();
  const lineReader = createLineReader({ input });
  
  const pending = readLineOnce({
    prompt: 'Other: ',
    input,
    output: { write() { return true; } },
    lineReader,
  });
  
  lineReader.cancel('ctrl-c');
  
  await assert.rejects(pending, (error) => error.code === 'CRUISE_INPUT_CANCELLED');
});
```

**Testing Stream-based Output:**
```javascript
test('TTY output renders correctly', async () => {
  const output = new FakeOutput({ columns: 80 });
  
  await pickOne({
    title: 'Choose option',
    options: ['Option A', 'Option B'],
    input,
    output,
  });

  assert.match(output.text(), /Option A/);
  assert.match(output.text(), /Option B/);
});
```

## Test Coverage

**Requirements:**
- No explicit coverage target enforced
- Test organization suggests focus on critical paths: contract validation, state transitions, error handling

**Emphasis:**
- Happy path tests
- Error/rejection scenarios (async failures, invalid inputs)
- State mutation tests (verify operations don't accidentally mutate inputs)
- Boundary cases (empty arrays, extreme terminal widths, concurrent approvals)

## Test Data Patterns

**Creation Helpers (from `build-contract-artifacts.mjs`):**
```javascript
export function projectMarkdown(projectId = 'PRJ-01') {
  return `# ${projectId} Cruise test project

## Identity
A durable product contract for deterministic Cruise execution.
// ... more content
`;
}

export function projectState({
  projectId = 'PRJ-01',
  milestoneId = 'M-003',
  repositoryBaselineDigest,
  // ... more parameters
} = {}) {
  return {
    schema_version: 1,
    kind: 'cruise_project_state',
    project_id: projectId,
    // ... more fields
  };
}
```

**Fixture Constants:**
```javascript
const NOW = '2026-07-13T00:00:00Z';
const DIGEST_A = 'a'.repeat(64);
```

## CI/CD Integration

**Test Suites:**
- `npm test` runs all tests (expected during development)
- `npm run test:evals` runs evaluation-focused tests (likely in CI)
- `npm run test:evals:static` for static schema validation only
- `npm run test:evals:behavior` for behavioral contract tests

**Configuration:**
- No `jest.config.js` or `vitest.config.js` (uses Node defaults)
- `package.json` defines all test scripts

---

*Testing analysis: 2026-07-14*
