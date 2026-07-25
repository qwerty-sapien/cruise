# Backend and data assurance profile

Select `backend-data` for persistent state, authentication, network services, queues, or migrations. Define gates for:

- `data-integrity`: schemas, constraints, transactions, migrations, rollback/retry semantics, and compatibility preserve data.
- `security`: authentication, authorization, input handling, secret boundaries, and least privilege are deliberate.
- `concurrency`: duplicate, reordered, concurrent, partial, and retried operations remain safe or explicitly unsupported.
- `observability`: material failures are diagnosable without leaking sensitive data; health and recovery signals are meaningful.

Use realistic failure-path probes. A successful request does not establish idempotency, authorization isolation, transactionality, or recovery from partial failure.
