# Runtime extension points

`service-template` starts with a deliberately tiny echo runtime, but real services may be Node apps, Go daemons, packaged third-party binaries, or system/bootstrap services.

Keep the template contract stable while adapting these extension points.

## What should stay stable

Every service repo should keep:

- root `service.json`
- `config/example.env`
- `scripts/package.ps1`
- `scripts/package.sh`
- `scripts/test.ps1`
- `scripts/test.sh`
- `scripts/verify.ps1`
- `scripts/verify.sh`
- `verify/service-harness.json`
- `.github/workflows/validate-template.yml`
- `.github/workflows/release.yml`

## What may change per service

### Runtime payload

The sample template ships scripts under `runtime/<platform>/`. Real services may replace that with:

- `cmd/<name>/` for Go binaries
- `src/` + package manager files for Node services
- packaged upstream binaries
- a checked-in runtime launcher that wraps another executable

### Package scripts

Package scripts should produce the platform artifacts declared in `service.json` and release workflow matrix entries.

Examples:

- script-only service: copy `runtime/<platform>` into staging
- Go service: `go build` the platform binary into staging
- Node service: build/install production assets into staging
- third-party binary service: download/copy the exact pinned binary into staging

### Test scripts

Test scripts should prove the adapted service identity and runtime behavior, not only that files exist.

Minimum checks:

- `service.json.id` matches the intended service id
- `verify/service-harness.json.serviceId` matches the same id
- runtime/daemon/CLI can start or produce a status response
- package-specific unit tests pass when present

### Workflows

If package/test scripts require a toolchain, install it in both workflows before package/test steps.

Examples:

- Go: `actions/setup-go`
- Node: `actions/setup-node` + package-manager install
- Python: `actions/setup-python`

Keep workflow changes focused and explicit so copied template repos do not inherit hidden assumptions.

## Service ids and repo names

Base/system service ids use `@`:

```text
@secretsbroker
@serviceadmin
@node
@python
@java
@localcert
@nginx
@traefik
```

Repo names should use normal GitHub-compatible names:

```text
lasso-secretsbroker
lasso-serviceadmin
```

The `@` belongs in `service.json`, dependency declarations, status surfaces, and Service Lasso UI/API references.

## Bootstrap services

Some services, such as `@secretsbroker`, may be service-shaped but started in a special bootstrap phase by Service Lasso core.

For these services:

- keep `depend_on` empty unless there is a real non-broker prerequisite
- make status/health available without normal service materialization
- expose typed states clearly
- keep Service Admin optional; CLI/API must work headless

## Validation rule

A service repo is not ready just because files were renamed. It needs at least:

```powershell
pwsh -NoLogo -NoProfile -File .\scripts\test.ps1
pwsh -NoLogo -NoProfile -File .\scripts\package.ps1
```

And CI should pass `validate-template` for Windows/Linux/macOS before the bootstrap PR is considered stable.
