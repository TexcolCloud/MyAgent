# Keep doctor read-only and secret-safe

`myagent doctor` is a Diagnostic Surface that checks configuration readability, Project Agent State permissions, SQLite and migration health, Secret-reference resolvability without displaying Secret values, worker/readiness state, Provider Egress Gateway availability, TUI/TTY support, and listener binding. It supports human-readable and machine-readable output, but never repairs configuration, migrations, credentials, or network state implicitly.

## Consequences

Doctor can be used safely by CI, support, and scripts without receiving authority to mutate durable state or reveal credentials. Repairs remain explicit Controlled TUI Workflows, Automation Surface operations, or recovery commands.
