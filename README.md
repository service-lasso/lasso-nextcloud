# lasso-nextcloud

`lasso-nextcloud` packages [Nextcloud](https://nextcloud.com/) as a **FastCGI application backend** for Service Lasso.

It does not run an HTTP server. The service installs Nextcloud, provisions PostgreSQL, and hosts a FastCGI pool (`php-cgi` on Windows, `php-fpm` on Linux/macOS). An external front — [lasso-caddy](https://github.com/service-lasso/lasso-caddy) — translates HTTP to FastCGI, and [lasso-traefik](https://github.com/service-lasso/lasso-traefik) routes at the edge.

```
Traefik  ──HTTP──>  Caddy (lasso-caddy)  ──FastCGI──>  lasso-nextcloud (php-cgi / php-fpm)
```

## Service Contract

- Service ID: `nextcloud`
- Upstream server: `nextcloud-34.0.4`
- Runtime backend: FastCGI — `php-cgi` (Windows) / `php-fpm` (Linux, macOS), PHP `8.3.32`
- Primary endpoint: `fastcgi` (`tcp`, loopback, preferred port `9000`)
- Health: TCP readiness on `${endpoint.fastcgi.bind}:${endpoint.fastcgi.port}`
- Dependencies: `@node` (launcher provider), `postgres` (database), `zitadel` (identity)
- Identity: [ZITADEL](https://zitadel.com/) OIDC via the bundled Nextcloud `user_oidc` app
- Data: `${SERVICE_ROOT}/runtime/data`; Config: `${SERVICE_ROOT}/runtime/config`; Apps: `${SERVICE_ROOT}/runtime/apps`
- Default admin: `admin` / `service-lasso`
- Release platforms: `win32`, `linux`, `darwin`

The service exports `NEXTCLOUD_FASTCGI_ADDR` (`host:port`) and `NEXTCLOUD_SOURCE_DIR` so the front (lasso-caddy) can point `php_fastcgi` at the pool and set its `root` to the Nextcloud source. `overwritehost`/`overwriteprotocol` are cleared so the front-end's `Host` header is honoured; add public hostnames via `NEXTCLOUD_TRUSTED_DOMAINS` and set `NEXTCLOUD_PUBLIC_URL` to pin the CLI URL.

## Release Artifacts

Pushes to `main` create a GitHub release named with the Service Lasso version pattern:

```text
yyyy.m.d-<shortsha>
```

The release contains:

- `lasso-nextcloud-34.0.4-win32.zip`
- `lasso-nextcloud-34.0.4-linux.tar.gz`
- `lasso-nextcloud-34.0.4-darwin.tar.gz`
- `service.json`
- `SHA256SUMS.txt`

Each archive bundles the pinned Nextcloud server, the platform PHP runtime (`php` CLI + `php-cgi`/`php-fpm` + extensions) and the Node launcher.

## Local Validation

```powershell
npm test
```

This packages the current platform artifact, validates the canonical FastCGI manifest, extracts it, materializes the install files, installs Nextcloud against a bundled SQLite database, confirms the FastCGI pool accepts connections and reports `installed`, and confirms the installation is retained across a restart. Set `NEXTCLOUD_PACKAGE_ARCHIVE` to verify a held archive.

### End-to-end acceptance

```powershell
npm run e2e
```

Installs against PostgreSQL (when `NEXTCLOUD_E2E_PG_HOST` is set, otherwise SQLite) and confirms FastCGI readiness + retained restart. When a front is configured (`NEXTCLOUD_E2E_CADDY_BIN` for a test Caddy, or `NEXTCLOUD_E2E_FRONT_BASE_URL` from lasso-caddy) it also performs a real Nextcloud **WebDAV file round-trip**; with `NEXTCLOUD_E2E_OIDC_ISSUER` it verifies ZITADEL OIDC discovery, the `user_oidc` provider and a real login redirect. `e2e.yml` runs it on Linux with PostgreSQL, ZITADEL and a Caddy front.

### OIDC bootstrap

`npm run test:oidc` runs the metadata-only OIDC bootstrap contract for the ZITADEL `nextcloud` application (see [docs/maintainer-reference.md](docs/maintainer-reference.md)).

## Windows Compatibility Patches

Nextcloud does not support Windows as a server platform. The Windows archive applies documented, guarded compatibility patches to the bundled server (migration discovery, data-directory validation, data-directory containment). Windows install/readiness work; the known issue is described in [docs/maintainer-reference.md](docs/maintainer-reference.md). The [fork build](fork/README.md) (`service-lasso/fork-nextcloud-server`) is the home for the complete Windows fix set. Set `NEXTCLOUD_FORK_SERVER_ARCHIVE` to package the fork archive instead of the upstream release.

[Service contract, packaging, and maintainer commands](docs/maintainer-reference.md)
