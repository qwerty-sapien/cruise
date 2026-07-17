#!/usr/bin/env node

// Cruise 0.2 deliberately has no private workflow runtime.  The former
// runtime created YAML runs, baseline snapshots, packets, hashes, and
// run-control state; keeping a callable compatibility path would reintroduce
// the authority model removed from the public CLI.
process.stderr.write('cruise-runtime is retired. Use `cruise` directly.\n');
process.exitCode = 2;
