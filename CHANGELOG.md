# Changelog

## 0.3.0
- rearchitect to a **FastCGI application backend**: the service hosts `php-cgi` (Windows) / `php-fpm` (Linux, macOS) and no longer runs an HTTP server
- `service.json`: canonical `fastcgi` TCP endpoint (preferred port 9000) with TCP readiness; exports `NEXTCLOUD_FASTCGI_ADDR` and `NEXTCLOUD_SOURCE_DIR` for the external front (lasso-caddy); `depend_on` includes `@node`, `postgres`, `zitadel`
- launcher injects the deployment config/data paths per request via `auto_prepend_file` (FastCGI front-ends do not forward the manager environment) and supervises the FastCGI pool
- packaging bundles the static-php CLI build (for `occ`) plus the FPM build on Linux/macOS; Windows uses `php-cgi.exe` from the official build
- verification and E2E assert FastCGI readiness + `occ status`; the E2E optionally runs a real WebDAV round-trip through a Caddy front and OIDC checks

## 0.2.0
- integrate ZITADEL as part of the stack: `zitadel` dependency, bundled `user_oidc` app, and launcher-driven OIDC provider configuration
- add the metadata-only ZITADEL OIDC bootstrap contract + tests (`npm run test:oidc`)
- add full-stack end-to-end acceptance (`npm run e2e`, workflow `e2e.yml`): PostgreSQL + WebDAV round-trip + OIDC discovery/provider/redirect
- support packaging a runnable server archive from `service-lasso/fork-nextcloud-server` (`NEXTCLOUD_FORK_SERVER_ARCHIVE`) with the fork build workflow
- expand Windows compatibility patches (migration discovery, data-directory validation, data-directory containment) and tolerate the Windows installer not returning after `installed=true`

## 0.1.0
- bootstrap `lasso-nextcloud` from `service-lasso/service-template`
- release-backed Nextcloud 34.0.4 service with a bundled static PHP 8.3.32 runtime
- `@node` launcher that installs Nextcloud, provisions PostgreSQL and serves it via the PHP built-in server
- packaging and verification scripts plus a Windows/Linux/macOS release workflow
