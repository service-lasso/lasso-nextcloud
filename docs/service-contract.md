# Service Contract

This starter repo demonstrates the first-pass Service Lasso service contract.

Key starter files:
- `service.json` - service manifest
- `services/` - example managed-service inventory for app/reference repos
- `verify/service-harness.json` - harness validation contract
- `scripts/verify.*` - thin wrappers that call the shared harness binary
- `scripts/package.*` - reference packaging entrypoints
- `runtime/` - sample payload/runtime files
- `config/` - example config inputs
- `docs/service-json-reference.md` - one-stop reference for `service.json` fields, healthcheck setup, and first-pass contract guidance

This starter is intentionally minimal. It is meant to prove the contract shape, not to be a full production service.

Important distinction:
- the root `service.json` is the canonical manifest for the template service repo itself
- the tracked `services/` folder is an example inventory for downstream app/reference repos that embed Service Lasso and need to declare the services they want to manage

Current bounded release/install note:
- release/install metadata belongs inside `service.json`, not in a sidecar source file
- the bounded first-pass core runtime currently models that through an `artifact` block with:
  - `artifact.kind`
  - `artifact.source`
  - `artifact.platforms`
