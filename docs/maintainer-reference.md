# lasso-nextcloud

Release-backed Nextcloud service for Service Lasso.

This repo packages Nextcloud `34.0.4` and a pinned static PHP runtime into Service Lasso release artifacts and publishes a current `service.json` manifest that apps can copy into their own `services/nextcloud/service.json`.

Topology: `Traefik -> Caddy (lasso-caddy) -> lasso-nextcloud (FastCGI)`.

## Service Contract

- Service ID: `nextcloud`
- Primary endpoint: `fastcgi` (`tcp`, loopback, preferred port `9000`)
- Health: singular `healthcheck` TCP readiness on `${endpoint.fastcgi.bind}:${endpoint.fastcgi.port}` for current Core importer compatibility
- Execution: managed `@node` provider runs the acquired `lasso-nextcloud.mjs` launcher
- Backend: `php-cgi` (Windows) / `php-fpm` (Linux, macOS)
- Dependencies: `@node`, `postgres`, `zitadel`
- Data path: `${SERVICE_ROOT}/runtime/data`
- Config path: `${SERVICE_ROOT}/runtime/config`
- Custom-apps path: `${SERVICE_ROOT}/runtime/apps`
- Default bootstrap admin: `admin` / `service-lasso`
- Default database: `nextcloud` on the managed PostgreSQL service

The launcher:

1. creates the retained config, data and custom-apps directories;
2. on first run, provisions the PostgreSQL database after a bounded readiness retry, writes the deployment `CAN_INSTALL` marker and runs `occ maintenance:install`;
3. reconciles trusted domains, the writable custom-apps path and (optionally) the public CLI URL on every start;
4. runs `occ upgrade` so schema and app migrations match the packaged server;
5. writes a per-request `auto_prepend_file` (FastCGI front-ends do not forward the manager environment) and starts the FastCGI pool — `php-cgi -b host:port` on Windows, `php-fpm --nodaemonize` on Linux/macOS — in the foreground so Service Lasso can supervise it.

## Release Assets

Pushes to `main` (after all three platform lifecycle jobs pass) create a release named `yyyy.m.d-<shortsha>` with:

- `lasso-nextcloud-34.0.4-win32.zip`
- `lasso-nextcloud-34.0.4-linux.tar.gz`
- `lasso-nextcloud-34.0.4-darwin.tar.gz`
- `service.json`
- `SHA256SUMS.txt`

Every archive bundles the pinned Nextcloud server, the platform PHP runtime and the launcher. Windows uses the official `windows.php.net` non-thread-safe PHP build (which ships both `php.exe` and `php-cgi.exe`); Linux and macOS bundle the `static-php.dev` `bulk` **CLI** build (for `occ`) **and** the `bulk` **FPM** build (`php-fpm`) so no system PHP or extension packages are required.

## Local Verification

```powershell
npm test
```

This packages the current platform artifact, validates the canonical FastCGI manifest, extracts it and materializes the actual install files. It installs Nextcloud against a bundled SQLite database, confirms the FastCGI pool accepts connections and reports `installed`, confirms the installation is retained across a restart and confirms the listener closes when the wrapper stops. Set `NEXTCLOUD_PACKAGE_ARCHIVE` to test a held archive without rebuilding.

The archive smoke test uses SQLite so the gate stays self-contained and does not require a running PostgreSQL server. The manifest still defaults to `pgsql` and declares the `postgres` dependency; the PostgreSQL-backed journey is part of the consuming app's Local acceptance.

## Environment Contract

`service.json` authors service interfaces through canonical `endpoints[]` entries and exports for the front (lasso-caddy):

- `NEXTCLOUD_FASTCGI_HOST`
- `NEXTCLOUD_FASTCGI_PORT`
- `NEXTCLOUD_FASTCGI_ADDR` (`host:port`)
- `NEXTCLOUD_SOURCE_DIR` (`${SERVICE_ARTIFACT_ROOT}/nextcloud`, the front's `root`)
- `NEXTCLOUD_CONFIG_DIR`, `NEXTCLOUD_DATA_DIR`

Service-local settings (all overridable by the consuming app):

- `NEXTCLOUD_FASTCGI_HOST`, `NEXTCLOUD_FASTCGI_PORT`
- `NEXTCLOUD_TRUSTED_DOMAINS` (comma-separated public hostnames the front will receive)
- `NEXTCLOUD_PUBLIC_URL` (optional; pins `overwrite.cli.url`)
- `NEXTCLOUD_CONFIG_DIR`
- `NEXTCLOUD_DATA_DIR`
- `NEXTCLOUD_APPS_DIR`
- `NEXTCLOUD_DB_TYPE` (`pgsql` by default)
- `NEXTCLOUD_DB_NAME`
- `NEXTCLOUD_DB_HOST`, `NEXTCLOUD_DB_PORT`, `NEXTCLOUD_DB_USER`, `NEXTCLOUD_DB_PASSWORD`
- `NEXTCLOUD_ADMIN_USER`, `NEXTCLOUD_ADMIN_PASSWORD`, `NEXTCLOUD_ADMIN_EMAIL`
- `NEXTCLOUD_OIDC_ENABLED` (`true` by default)
- `NEXTCLOUD_OIDC_ISSUER` (`${ZITADEL_URL}` by default)
- `NEXTCLOUD_OIDC_PROVIDER_NAME` (`Zitadel` by default)
- `NEXTCLOUD_OIDC_CLIENT_ID`, `NEXTCLOUD_OIDC_CLIENT_SECRET` (empty by default; supplied by the consuming project)
- `NEXTCLOUD_OIDC_SCOPE` (`openid email profile` by default)

## Identity (ZITADEL OIDC)

The service declares `zitadel` in `depend_on` and bundles the Nextcloud
`user_oidc` app. On start, `configureOidc()` enables the app and registers the
ZITADEL provider from `NEXTCLOUD_OIDC_ISSUER`, `NEXTCLOUD_OIDC_CLIENT_ID` and
`NEXTCLOUD_OIDC_CLIENT_SECRET` (the secret is passed by environment-variable name
so it never appears on the managed command line). When the credentials are empty
the step is skipped and Nextcloud runs with local admin login only.

`npm run test:oidc` runs the metadata-only OIDC bootstrap contract for the
ZITADEL `service-lasso` / `nextcloud` application. Like `lasso-zitadel`'s
`bootstrap:oidc`, it reconciles a supplied state snapshot against the desired
redirect/post-logout URIs, allowed origins and grant types, and emits a
plan (`create`/`update`/`noop`) plus metadata containing a `secretref://`
pointer — never a raw secret or token.

## End-to-End Acceptance

`npm run e2e` (workflow `e2e.yml`) is the full-stack acceptance gate:

- PostgreSQL when `NEXTCLOUD_E2E_PG_HOST` is set, otherwise SQLite;
- install + FastCGI readiness + `occ status` installed + retained restart;
- when a front is available (`NEXTCLOUD_E2E_CADDY_BIN` test front or
  `NEXTCLOUD_E2E_FRONT_BASE_URL` from lasso-caddy): a real Nextcloud WebDAV file
  round-trip;
- when `NEXTCLOUD_E2E_OIDC_ISSUER` is set: ZITADEL OIDC discovery, the
  `user_oidc` provider registration and a real login redirect to the provider.

CI runs it on Linux with PostgreSQL, ZITADEL and a Caddy test front. Windows
runs install/readiness/OIDC only; the WebDAV journey depends on the complete
fork-hosted Windows fix set.

## Windows Compatibility Patches

Nextcloud does not support Windows as a server platform. The packager applies
documented compatibility patches to the bundled server in the Windows archive:

- `lib/private/DB/MigrationService.php` — allow both `/` and `\` separators when
  matching migration filenames (otherwise zero migrations are discovered and
  installation aborts with `no such table: oc_users`).
- `lib/private/legacy/OC_Util.php` — accept a Windows drive-qualified absolute
  data directory in `checkDataDirectoryValidity`.
- `lib/private/Files/Storage/Local.php` — normalize separators in the
  data-directory containment check so `realpath()` output matches on Windows.

Each patch is guarded: packaging fails if the upstream string changes, so the
archive can never silently ship an unreviewed or stale patch. Applied patches are
recorded in each archive's `SERVICE-LASSO-PACKAGE.json` under `patches`. Linux and
macOS archives are unmodified upstream Nextcloud.

Windows scope: with these patches the service installs, configures, reports
readiness and starts the FastCGI pool; the file **write** lands on disk and the
cache update completes. The remaining Windows defect is that the DAV `PUT`
response never returns: after `File::put()` completes, Sabre fires `afterBind`,
whose `FilesPlugin::sendFileIdHeader` calls `tree->getNodeForPath()` on the
just-created node and stalls. This reproduces with both `php -S` and
Caddy + `php-cgi`, so it is a Nextcloud/Windows issue, not the web server.
Windows is therefore install/readiness-only until a `servicelasso/feat/…` branch
in `service-lasso/fork-nextcloud-server` fixes it and merges into
`servicelasso/master`. Linux and macOS are the reference platforms.

## Fork-hosted server builds

`service-lasso/fork-nextcloud-server` hosts the Service Lasso build pipeline that
produces a runnable Nextcloud server archive (bundling the `3rdparty` submodule)
and applies the Windows patches at build time. See [../fork/README.md](../fork/README.md).
Set `NEXTCLOUD_FORK_SERVER_ARCHIVE` to that archive to package the fork build
instead of the upstream release; the in-repo patches are then skipped.

## Known Limitations

- Nextcloud is a FastCGI backend only; it requires an external front (lasso-caddy) for HTTP and lasso-traefik for edge routing.
- Windows is not an officially supported Nextcloud server platform; Linux and macOS are the reference platforms.
