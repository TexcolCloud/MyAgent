# Require explicit remote Attached TUI consent

Attached TUI Mode rejects non-loopback API URLs by default. Remote Attached TUI Mode requires both an `--allow-remote` override and an exact-origin confirmation value, displays the origin, TLS state, and credential-source category without displaying credentials, and accepts Run/Admin credentials only through an OS credential helper, a named controlled environment variable, or a masked prompt; token arguments, configuration, logs, SQLite, and shell history remain forbidden.

## Considered Options

- A single remote override could send credentials to a copied, redirected, or unintended origin.
- Permitting token arguments would make elevated Control Plane credentials visible in shell history and process inspection.
- Disallowing remote attachment entirely would unnecessarily remove an explicit advanced Explicit Service Mode use case.
