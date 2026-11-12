# User control of the Cruise campaign budget

Cruise defaults to its campaign quota policy. An explicit user decision can disable that additional gate for every source-launcher invocation by writing `~/.cruise/budget-policy.json`:

```json
{"schema_version":1,"campaign_budget_enabled":false}
```

This bypasses Cruise campaign reservations and campaign-cap pauses, including strict mode. It does not change provider rate limits, account permissions, model access, approval review or billing. Set the boolean to `true`, or remove this file, to restore the default. A malformed policy is an error; it never silently disables the gate. Each guard reads the policy once, so restart an active command after changing it. A custom quota `baseDirectory` uses the policy file in its parent directory, keeping tests and isolated deployments separate.

This setting affects the launcher source that contains this feature. An older independently installed plugin/launcher requires the corresponding code release; changing skills alone does not add runtime support.
