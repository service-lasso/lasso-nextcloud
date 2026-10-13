This folder is an example managed-service inventory for app/reference repos that embed Service Lasso.

Important distinction:
- the root `service.json` is still the canonical manifest for the template service repo itself
- the manifests under `services/` are example inventory entries showing what a host/app repo should carry when it wants to manage a small baseline stack through Service Lasso

Current baseline inventory:
- `echo-service`
- `@serviceadmin`
- `@node`
- `@localcert`
- `@nginx`
- `@traefik`

Optional provider inventory:
- `@python` disabled release-backed Python 3.11.5 provider; Windows artifact only
- `@java` disabled release-backed Java 17 provider

If a host/app repo includes `@serviceadmin`, it should also include the manifests needed to satisfy Service Admin's declared service dependencies.

Core Service Lasso services use the `@` prefix: `@node`, `@python`, `@java`, `@localcert`, `@nginx`, `@traefik`, and `@serviceadmin`. `echo-service` stays unprefixed because it is the sample/test managed service.
