# service-template

_Status: starter template repo_

`service-template` is the canonical starting point for new Service Lasso service repos.

Use this repo when you want to create a new service repo that already has:
- the expected service repo layout
- a starter `service.json`
- a starter `services/` inventory example for app/reference repos that embed Service Lasso
- starter packaging scripts
- starter verify scripts and harness contract shape
- starter docs for service contract, packaging, and validation
- starter CI scaffolding
- documented GitHub-template-first repo bootstrap flow
- runtime extension guidance for compiled daemons, Node services, and bootstrap/system services

## Use this template

Recommended flow:

1. Create the new GitHub repo **through GitHub's template mechanism** from `service-lasso/service-template`.
   - GitHub UI: click **Use this template** on this repo.
   - GitHub CLI: `gh repo create service-lasso/<repo-name> --public --template service-lasso/service-template`.
2. Verify GitHub recorded the origin:

   ```powershell
   gh api repos/service-lasso/<repo-name> --jq '.template_repository.full_name'
   # must print: service-lasso/service-template
   ```

3. Clone the new GitHub-created repo locally.
4. Rename the sample service files/content for the real service.
5. Replace the sample runtime payload with the real service payload.
6. Update `service.json`, `verify/service-harness.json`, workflows, package/test/verify scripts, and docs for the new service.
7. Run the local package + test flow.
8. Open a focused PR and wait for `validate-template` to pass on Windows/Linux/macOS.

Do **not** start from a local copy or another service repo and retrofit the template later. File parity is not enough; the GitHub repo itself must show it was generated from `service-lasso/service-template`.

See `docs/bootstrap-new-service-repo.md` for the full GitHub-template-first checklist and remediation process for incorrectly-created repos.

## Quick start

### Local package

```powershell
pwsh -NoLogo -NoProfile -File .\scripts\package.ps1
```

### Local tests

```powershell
pwsh -NoLogo -NoProfile -File .\scripts\test.ps1
```

## Start here for deeper design context

Read in this order if you need the underlying design/spec context:

1. `docs/openspec-drafts/SPEC-SERVICE-TEMPLATE-REPO.md`
2. `docs/openspec-drafts/OPENSPEC-TRACKER.md`
3. `docs/service-contract.md`
4. `docs/service-json-reference.md`
5. `docs/packaging.md`
6. `docs/validation.md`
7. `docs/bootstrap-new-service-repo.md`
8. `docs/runtime-extension-points.md`
9. `docs/reference/adjacent/SPEC-SERVICE-LASSO-HARNESS.md`

## What is here

### OpenSpec drafts
- `docs/openspec-drafts/SPEC-SERVICE-TEMPLATE-REPO.md`
- `docs/openspec-drafts/OPENSPEC-TRACKER.md`

### Supporting reference/planning docs
- `docs/service-contract.md`
- `docs/service-json-reference.md`
- `docs/packaging.md`
- `docs/validation.md`
- `docs/reference/SERVICE-TEMPLATE-REPO.md`
- `docs/reference/SERVICE-STRUCTURE-REVIEW.md`
- `docs/reference/PROPOSED-CODEBASE-STRUCTURE.md`
- `docs/reference/DECISION-CONTEXT.md`
- `docs/reference/shared-runtime/QUESTION-LIST-AND-CODE-VALIDATION.md`
- `docs/reference/shared-runtime/ARCHITECTURE-DECISIONS.md`
- `docs/reference/shared-runtime/SERVICE-MANAGER-BEHAVIOR.md`
- `docs/reference/adjacent/SPEC-SERVICE-LASSO-HARNESS.md`
- `docs/reference/EXAMPLE-REPO-TREE.md`
- `docs/reference/EXAMPLE-service.json`
- `docs/reference/EXAMPLE-service-harness.json`
- `docs/reference/EXAMPLE-verify.ps1`
- `docs/reference/EXAMPLE-verify.sh`

## Purpose

This repo is the canonical starting point for Service Lasso service repos.

Its role is to define:
- one-service-per-repo expectations
- service repo layout
- service author documentation expectations
- sample service expectations
- packaging/release expectations
- validation-harness integration expectations

## Current status

This repo is usable now as a starter template.

It currently includes:
- actual starter repo files (`service.json`, `verify/`, `scripts/`, `runtime/`, `config/`, `.github/workflows/`)
- a tracked example `services/` inventory for downstream app/reference repos
- a packaged first-pass sample artifact at `dist/echo-service-win32.zip`
- a starter multi-OS GitHub Actions workflow that packages release archives and runs basic tests
- starter harness-contract files and thin verify wrappers
- supporting reference/spec docs for deeper design work

Important current validation note:
- the pipeline now downloads and invokes the released `service-lasso-harness` binary in CI
- it still keeps the starter local package/test flow alongside harness verification
- the current harness version is pinned in workflow config and can be advanced intentionally over time

Important current manifest note:
- the bounded first-pass core runtime now expects service release/install metadata to live directly in `service.json`
- the current template example uses a bounded `artifact.kind`, `artifact.source`, and `artifact.platforms` shape to show that direction explicitly
- bundled app artifacts mean the app package step has already acquired service archives into `services/<service-id>/.state/artifacts/<tag>/<assetName>` so first run can install without downloading those archives

## Baseline app inventory rule

This repo still models the canonical one-service-per-repo contract through the root `service.json`.

In addition, it now carries a tracked example `services/` inventory to show what app/reference repos should own when they embed Service Lasso.

Current baseline inventory:
- `services/echo-service/service.json`
- `services/@serviceadmin/service.json`
- `services/@node/service.json`
- `services/@localcert/service.json`
- `services/@nginx/service.json`
- `services/@traefik/service.json`

Optional provider inventory:
- `services/@python/service.json` disabled release-backed Python 3.11.5 provider; Windows artifact only
- `services/@java/service.json` disabled release-backed Java 17 provider

Important rule:
- app/reference repos should own the exact `services/` manifests for the services they intend to manage
- if an app repo includes `@serviceadmin`, it should also include the manifests needed to satisfy Service Admin's declared service dependencies
- core Service Lasso services use the `@` prefix: `@node`, `@python`, `@java`, `@localcert`, `@nginx`, `@traefik`, `@serviceadmin`, and `@secretsbroker`; `echo-service` stays unprefixed because it is the sample/test managed service
- environment settings like `VITE_SERVICE_LASSO_API_BASE_URL` still belong in app/runtime config, not as extra service manifests
