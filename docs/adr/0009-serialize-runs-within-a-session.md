# Serialize Runs within each Session

Only one Run may execute at a time for a given Agent and Session Key, and later Runs wait in FIFO order even while the active Run is awaiting Approval. This sacrifices same-conversation parallelism to preserve deterministic history, Tool side-effect ordering, and restart recovery while allowing different Sessions to run concurrently.
