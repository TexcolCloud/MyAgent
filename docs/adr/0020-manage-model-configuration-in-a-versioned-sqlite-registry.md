# Manage model configuration in a versioned SQLite registry

Provider Connections, Model Profiles, immutable revisions, and per-Agent Model Assignments are managed in SQLite rather than rewritten into Agent or global YAML files. This gives the HTTP control plane atomic updates, optimistic concurrency, durable verification, and auditable Promotion while allowing each Run to snapshot one exact model revision; file rewriting and permanent database-over-file overrides were rejected because they create fragile concurrent writes or competing sources of truth.
