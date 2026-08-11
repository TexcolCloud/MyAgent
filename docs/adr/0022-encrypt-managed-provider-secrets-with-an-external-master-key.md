# Encrypt managed provider Secrets with an external master key

API Keys entered through the Model Control Plane are stored as immutable AES-256-GCM Secret Versions in SQLite, while the active and optional previous master keys remain external to the database and its backups. Plaintext YAML, a key file beside the database, and mandatory operating-system credential stores were rejected because they either defeat backup separation or prevent consistent Windows, Linux, and headless deployment; existing environment Secret references remain supported without being copied automatically.
