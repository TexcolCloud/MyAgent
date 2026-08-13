# Make local integrated mode the primary entry

`myagent` is the primary Local Integrated Mode entry, and `myagent tui --local` is its explicit equivalent; `myagent tui --api-url ...` remains the path for attaching to an existing service. `myagent serve` remains a supported Explicit Service Mode for debugging, tests, advanced automation, and independently connected local clients rather than the normal interactive product entry.

## Consequences

The interactive product can become TUI-first without deleting the stable HTTP service and CLI boundaries that support automation, diagnostics, and future Channels. The bare `tui` command must acquire one unambiguous compatibility behavior during migration rather than guessing whether to start or attach to a service.
