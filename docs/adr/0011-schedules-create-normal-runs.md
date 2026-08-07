# Make Schedules create normal Runs

When a Schedule fires, it submits a predefined request through the same Agent kernel used by HTTP and Channels. Scheduled work therefore inherits Session serialization, Tool policy, Approval, persistence, and audit behavior instead of introducing a privileged execution path. After downtime, multiple missed occurrences are coalesced into at most one compensating Run before normal cron timing resumes.
