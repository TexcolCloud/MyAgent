# Require an explicit background host for unattended work

Local Integrated Mode is a Foreground Agent Host: closing its TUI closes its service and it does not continue Channel, Schedule, or other unattended work. Such work requires Explicit Service Mode or a future explicitly started Background Agent Host, so an Operator never closes a local TUI while unknowingly leaving a Personal Agent active.

## Considered Options

- Silently retaining the local service after TUI exit would blur foreground and background authority and make work ownership difficult to inspect.
- Letting Channels or Schedules self-start persistent local services would create unmanaged daemon lifetime and credential behavior.
