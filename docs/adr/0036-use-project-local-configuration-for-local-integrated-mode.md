# Use project-local configuration for local integrated mode

Local Integrated Mode defaults to `.myagent/myagent.yaml` and never implicitly imports a legacy Workspace-root `myagent.yaml`; an Operator may select another configuration explicitly with `--config`. During migration, `myagent serve` and `myagent config validate` retain the root `myagent.yaml` default so established explicit-service and validation workflows remain compatible.

## Consequences

An existing root configuration is used by Local Integrated Mode only after explicit Operator choice or a controlled migration into Project Agent State. This prevents a normal interactive invocation from silently selecting historic endpoint or credential-reference behavior while preserving a predictable compatibility boundary for advanced service workflows.
