# Use a modular monolith with a SQLite-backed durable state machine

The first release runs the HTTP API, Run worker, Scheduler, and Channel adapters as modules in one Node.js service, with SQLite storing current workflow state, queue leases, Approvals, and append-only Run Events. The CLI uses only HTTP. This keeps local deployment and transactional recovery simple while preserving module ports for later adapters, avoiding Temporal infrastructure and the versioning burden of full event sourcing.
