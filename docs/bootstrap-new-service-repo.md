# Bootstrap a new Service Lasso service repo

This is the canonical flow for creating Service Lasso service repos.

## Non-negotiable order

1. Create the GitHub repo from `service-lasso/service-template` using GitHub's template mechanism.
2. Verify GitHub records `service-lasso/service-template` as the repo's `template_repository`.
3. Clone the new GitHub-created repo locally.
4. Only then rename/adapt the service files and implementation.

Do **not** start from a local copy or another service repo and retrofit the template later. Do **not** treat file parity as completion. A repo that has the same files but lacks the GitHub template relationship is not a compliant Service Lasso service repo.

## GitHub template-first flow

Create the repository with either GitHub UI **Use this template** or GitHub CLI:

```powershell
gh repo create service-lasso/<repo-name> \
  --public \
  --template service-lasso/service-template \
  --description "<description>"
```

Before making service-specific changes, verify GitHub recorded the template origin:

```powershell
$template = gh api repos/service-lasso/<repo-name> --jq '.template_repository.full_name'
if ($template -ne 'service-lasso/service-template') {
  throw "Repo was not created from service-lasso/service-template; got: $template"
}
```

The GitHub UI should also show that the repo was generated from `service-lasso/service-template`. If the API returns `null`, stop: the repo was created incorrectly.

Then clone locally:

```powershell
git clone https://github.com/service-lasso/<repo-name>.git C:\projects\service-lasso\<repo-name>
cd C:\projects\service-lasso\<repo-name>
```

Then create a focused issue and branch for the first adaptation work:

```powershell
gh issue create --repo service-lasso/<repo-name> --title "Bootstrap <service-id> from service template" --body "..."
git checkout -b issue-1-bootstrap-<service>
```

## Required rename/adaptation checklist

Update these at minimum:

- `README.md`
- `service.json`
  - `id`
  - `name`
  - `description`
  - `logs.default.path`
  - `meta.repository.url`
  - docs/issues/support links
  - `artifact.source.repo`
  - platform `assetName` values
  - platform `command` values
  - action descriptions
  - `execconfig.executable`
  - `execconfig.args` when needed
  - `execconfig.env`
  - `execconfig.healthcheck`
- `verify/service-harness.json`
  - `serviceId`
  - artifact path
  - harness-compatible health shape
- `scripts/package.ps1`
- `scripts/package.sh`
- `scripts/test.ps1`
- `scripts/test.sh`
- `scripts/verify.ps1`
- `scripts/verify.sh`
- `.github/workflows/release.yml`
- `.github/workflows/validate-template.yml`

## System service naming

Base/system services use an `@` service id:

```text
@node
@python
@java
@localcert
@nginx
@traefik
@serviceadmin
@secretsbroker
```

Repo names should still use normal GitHub-friendly names, for example:

```text
lasso-secretsbroker -> service id @secretsbroker
lasso-serviceadmin  -> service id @serviceadmin
```

Sample/test services may remain unprefixed, for example `echo-service`.

## Compiled runtime services

If the service builds a binary, keep the template package/test/verify contract but add the toolchain setup explicitly.

For Go services, add this after checkout in both workflow files before package/test steps:

```yaml
- name: Set up Go
  uses: actions/setup-go@v6
  with:
    go-version-file: go.mod
```

Then package scripts should build the platform artifact before archiving it.

## Harness compatibility note

The released `service-lasso-harness` contract is intentionally narrower than `service.json`.

For example, `service.json` may carry an HTTP healthcheck:

```json
"healthcheck": {
  "type": "http",
  "url": "http://127.0.0.1:17890/health",
  "timeoutSeconds": 5
}
```

But `verify/service-harness.json` currently must stay compatible with the released harness schema. If the harness does not support a field such as `health.url`, keep the verify contract on the supported shape, for example:

```json
"health": {
  "type": "process",
  "timeoutSeconds": 30
}
```

Do not copy runtime-only `service.json` fields into the harness contract unless the harness schema supports them.

## Local scratch hygiene

Use repo-local `.tmp/` for temporary files and remove it before committing.

The template ignores `.tmp/`, `dist/`, `output/`, `.harness/`, and generated `verify/service-harness.ci.json`.

## Incorrectly-created repo remediation

If an existing service repo was created manually, copied from another repo, or normalized by applying template files later, it must be treated as incorrectly bootstrapped even if the file tree currently matches this template.

Remediation checklist:

1. Preserve the current repo state before replacing it:
   - current default branch commit
   - open/closed issues and PR links
   - release tags/assets/checksums
   - service-specific files or docs that must be re-applied
2. Create or recreate the GitHub repo through `service-lasso/service-template` using the template flow above.
3. Verify `.template_repository.full_name == "service-lasso/service-template"` with `gh api` before adapting files.
4. Re-apply only the service-specific implementation/config/docs on top of the template-created baseline.
5. Re-run package/test/verify and `validate-template`.
6. Do not close the remediation issue until both are true:
   - GitHub reports the template origin correctly.
   - The adapted service passes its required validation.

Current correction example: `service-lasso/lasso-dagu` must be recreated this way. Dagu remains just an optional managed service/executable; recreating its repo does not make Dagu required for Service Admin, Secrets Broker readiness, or normal Service Lasso service flows.

## Issue/PR trail

Every real service bootstrap should leave a visible trail:

- issue created before work starts
- start/resume comment
- template-origin verification comment showing `template_repository.full_name`
- validation comment
- PR linked to issue
- final comment with commit, PR, GitHub template-origin evidence, and validation evidence
