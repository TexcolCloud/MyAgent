# Stabilize Pi provider drivers and runtime versions

The Model Registry persists project-owned Provider Driver IDs and a resolved invocation contract rather than raw pi-ai catalog names, and it pins matching exact pi-ai and pi-tui versions. A library upgrade is an explicit, verified migration because catalog names and stream behavior can change; recording only a provider/model ID or accepting automatic 0.x upgrades was rejected because it would make a persisted Run depend on mutable library defaults.
