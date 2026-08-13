# Keep the HTTP control plane in local integrated mode

Local Integrated Mode hosts the same loopback HTTP/SSE Model Control Plane used by Explicit Service Mode; the TUI Client remains an authenticated client and does not call application services, SQLite, Secrets, Tools, or provider adapters directly. This preserves one authorization, redaction, lifecycle, SSE, and black-box test boundary while allowing the local product entry to own the short-lived service host.

## Considered Options

- Direct TUI-to-application-service calls would remove local HTTP requests but create a second control path and grant the TUI access to service-owned authority.
- A separate local transport would preserve an abstraction but require a second long-lived equivalent of the HTTP control surface.
