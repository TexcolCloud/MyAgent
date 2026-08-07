# Run approved commands as controlled host processes

The first release executes `run_command` on the host only after Approval, using structured `program`, `args`, and `cwd` fields with shell interpretation disabled, plus a fixed Workspace, environment allowlist, timeout, and output limits. Pipes, redirects, and shell expressions are outside the first release. This avoids requiring a container runtime but deliberately provides no OS-level sandbox, so the exact command Approval remains the authority boundary and the UI must not imply stronger isolation.
