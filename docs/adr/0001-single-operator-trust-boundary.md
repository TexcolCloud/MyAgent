# Limit the first release to one trusted Operator

The first release assumes one trusted Operator and access from the local machine or a trusted private network. Local SQLite data and files rely on operating-system account and file permissions rather than application-layer encryption. This avoids building multi-tenant identity, isolation, and key management while retaining session separation and explicit approval for sensitive actions; public access and mutually untrusted users are out of scope because they require a different authentication, policy, and storage threat model.
