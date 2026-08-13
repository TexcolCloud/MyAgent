# Make local TUI invocation explicit and safe

`myagent`, `myagent tui`, and `myagent tui --local` invoke Local Integrated Mode, while `myagent tui --api-url ...` is Attached TUI Mode and never performs service discovery. Each local invocation creates its own random-port loopback Local Service Instance and never reuses or terminates an existing service. When an interactive local invocation finds no Project Agent State, it asks for explicit Project Initialization before creating `.myagent/`; that initialization creates only minimum state, then enters a Setup Workflow without inferring Provider credentials, Models, Profiles, Agent assignments, or defaults. The Setup Workflow contains an explicit, named and confirmed Agent Creation Step rather than an automatic default Agent. Noninteractive invocations fail deterministically instead of modifying a Workspace.

## Considered Options

- Keeping bare `tui` attached to a default port would preserve old syntax but make adjacent TUI commands have incompatible product meanings.
- Probing a default listener before deciding whether to attach would silently select credentials and a service owner.
- Unprompted initialization would make first use shorter but could unexpectedly modify a repository or script working directory.
