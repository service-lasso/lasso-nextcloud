# Packaging

Reference packaging scripts:
- `scripts/package.ps1`
- `scripts/package.sh`

Current first-pass direction:
- package the minimal sample service into a release artifact under `dist/`
- include `service.json`, runtime payload, and config
- use the produced artifact as the thing later consumed by the shared harness

## App Artifact Modes

Service repos publish installable service archives from their own releases.

Apps that consume Service Lasso can then produce two useful runtime artifact modes:
- `runtime` / bootstrap-download: the app ships `services/<service-id>/service.json`, and Service Lasso downloads the service archive from that manifest during install/acquire.
- `bundled`: the app package step has already run Service Lasso package/acquire behavior and stored the service archive under `services/<service-id>/.state/artifacts/<tag>/<assetName>` before the app artifact is published.

Bundled app artifacts should not need a first-run service archive download. The service manifest still remains the source of truth for release metadata; the bundled archive is the already-acquired payload that matches that manifest.
