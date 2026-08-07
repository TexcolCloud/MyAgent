# Model execution as a persistent Run resource with SSE events

An HTTP request creates a durable Run and returns its identity; clients observe persisted, monotonically sequenced Run Events over SSE and submit Approvals through separate requests. Run creation accepts an idempotency key so retries return the original Run, and SSE reconnects replay after `Last-Event-ID`. This avoids duplicate Tool Calls and tying execution or human decision time to one connection while enabling recovery after service restarts.
