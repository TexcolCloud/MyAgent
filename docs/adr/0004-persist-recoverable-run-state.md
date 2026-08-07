# Persist recoverable session, Run, and Approval state

Conversation state, Run progress, and pending Approvals must survive a process restart. The added storage and state-machine complexity is accepted so an Operator can safely resume work after downtime; recovery means continuing from the last durable step rather than attempting to preserve an in-flight network call.
