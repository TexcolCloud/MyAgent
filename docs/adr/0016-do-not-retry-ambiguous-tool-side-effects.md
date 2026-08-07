# Do not retry ambiguous Tool side effects automatically

If the process can no longer determine whether a side-effecting Tool Call completed, it marks the call `unknown`, blocks the Run, and requires the Operator to resolve it as successful, failed, or explicitly retried. Exactly-once external effects cannot be guaranteed, and silently choosing at-least-once execution would risk duplicating commands or writes.
