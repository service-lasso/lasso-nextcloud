# Fork-hosted server builds

`service-lasso/fork-nextcloud-server` is a fork of `nextcloud/server`. It hosts
the Service Lasso build pipeline for a **runnable** Nextcloud server archive.

Why a fork is needed:

- Nextcloud's official release archives bundle the `3rdparty` composer
  dependencies, but `3rdparty` is a **git submodule** in the source repository,
  so a plain GitHub tag tarball is not runnable.
- Windows needs small compatibility patches (migration discovery path
  separators and drive-qualified data-directory validation). Applying them in
  the fork keeps the packaged service reproducible and reviewable.

## Branch model

- Upstream branches and the `v*` tags stay a **pristine mirror**. Do not commit
  Service Lasso changes there.
- **All Service Lasso branches use the `servicelasso/` prefix** so they never
  collide with upstream. Examples: `servicelasso/master`,
  `servicelasso/feat/fix-webdav`, `servicelasso/fix/...`.
- **`servicelasso/master` is our master.** It is based on the Nextcloud version
  we currently ship (`v34.0.4`) and carries the Service Lasso pipeline and the
  Windows compatibility patches. Every other Service Lasso branch (features,
  fixes, version bumps) merges into `servicelasso/master`, and releases are cut
  from it.
- This directory holds the reviewable source of the workflow and notes that are
  landed on `servicelasso/master`.

## Build and release

`service-lasso-build-server.yml` (triggers on pushes to `servicelasso/master`,
`servicelasso/nextcloud-*`, `servicelasso/feat/**`, `servicelasso/fix/**`, and on
`workflow_dispatch`):

1. checks out the branch with `submodules: recursive` (fetches `nextcloud/3rdparty`);
2. applies the documented Windows compatibility patches at build time (a no-op
   once the patches are committed on the branch);
3. stages the working tree as `nextcloud/` and produces
   `nextcloud-<version>-service-lasso.zip` plus a SHA-256;
4. uploads the archive as a workflow artifact on every push, and publishes it as
   a GitHub release on a `workflow_dispatch` with `publish=true`.

Note: the `service-lasso` organisation restricts `GITHUB_TOKEN` write access
(`Write permissions for workflows are disabled by the organization`), so the
release step can fail with `403 Resource not accessible by integration`. Either
the organisation must allow write permissions for Actions, or the workflow must
publish with a PAT/App token secret. Until then, cut the release by dispatching
the workflow (or publish the built artifact with an authenticated `gh`):

```powershell
gh workflow run service-lasso-build-server.yml `
  --repo service-lasso/fork-nextcloud-server `
  --ref servicelasso/master -f version=34.0.4 -f publish=true
```

## Consuming the fork archive

Set these in the Service Lasso release environment for `lasso-nextcloud`:

```text
NEXTCLOUD_FORK_SERVER_ARCHIVE=<url-or-local-path-to-nextcloud-<version>-service-lasso.zip>
NEXTCLOUD_FORK_SERVER_FORMAT=zip
```

`scripts/package.mjs` then packages the fork archive directly and skips the
in-repo compatibility patches (the archive already carries them), recording
`server.source = fork` in `SERVICE-LASSO-PACKAGE.json`. Without
`NEXTCLOUD_FORK_SERVER_ARCHIVE`, packaging falls back to the upstream release
plus the guarded in-repo patches.
