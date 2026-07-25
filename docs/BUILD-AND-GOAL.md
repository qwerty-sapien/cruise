# Build and Goal

Build clarifies a project or major milestone and compiles an editable
`.cruise/QUEUE.md`. Each ready milestone becomes one Flight v2 Goal. Queue
execution is sequential and stops on a blocker, stall, invalid state, or
unassured completion.

Goal is the self-driving implementation lane for both finite planned work and
larger consequential outcomes. It inspects first, asks only material questions
that repository evidence cannot answer, makes a compact plan, and immediately
implements it. If the user explicitly asks for planning, research, or design
only, Goal remains read-only and returns the plan without claiming product
completion.

An executable Goal:

1. records the exact launcher request in `.cruise/ORIGIN.md`;
2. compiles scope, invariants, risk, profiles, and falsifiable gates into
   `.cruise/FLIGHT.md`;
3. implements the next ready slice and gathers evidence through ordinary host
   tools and permissions;
4. challenges relevant failure paths and domain-quality dimensions;
5. binds receipts to the exact request, product state, and Flight contract;
6. keeps Flight active until `cruise attest` reports
   `ready_for_completion: true`, marks it complete, confirms
   `allows_completion: true`, or reports a concrete blocker or bounded stall.

Neither artifact authorizes work. Routine Plan-to-execution and micro-goal
transitions are already authorized by the Goal invocation; material product
decisions, secrets, scope expansion, and host-required external/destructive
approvals still return to the user.
