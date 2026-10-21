# trame-k8s

A Kubernetes plugin for [Trame](https://github.com/Andarius/trame). It shows the workloads of your kube contexts as cluster columns, or as force graphs:

- **Infra:** cluster → group or namespace → workload. A group spanning several namespaces keeps each namespace with two or more of its workloads as a hub of its own.
- **Apps:** the same app across clusters, with version drift highlighted.
- **Traffic:** hosts → workloads → what their env points at.
- **Capacity:** cluster → node → pod.

## Use

In a Trame checkout, list this repo's path relative to it (here `~/Projects/Work/trame-k8s` next to `~/Projects/trame`):

```bash
echo '{ "plugins": ["../Work/trame-k8s"] }' > plugins.local.json
just plugins-install   # host binary + web bundle into the live data dir; then restart Trame
```

Enable it under Plugins and tick the contexts to poll. Nothing is polled until a context is ticked.

The sidebar column beside the rail picks the clusters to show, a group, and whether system namespaces or only issues are shown. The toolbar holds the view and the search, which is GitHub-like: words match name, namespace, cluster, group, image and host; `cluster:`, `ns:`, `group:`, `kind:`, `image:`, `host:` and `is:` (`ready`, `rolled`, `degraded`, `down`, `zero`) narrow a field; `-` excludes; quote a value with spaces.

The backend runs `kubectl --context=<ctx> get … -A -o json` per context on the plugin host. It uses your kubeconfig and is read-only. Gateway API `HTTPRoute`s are read when the CRD exists.

- **Logos** resolve in this order: a settings override (`name`, `ns/name`, `context/ns/name`, or a context; `*` matches within a segment, an exact key wins), then a `trame.dev/logo: <slug>` annotation, then a guess from the image name. Logos are [simple-icons](https://simpleicons.org) slugs, fetched once through the plugin and cached.
- **Dependency edges** (Traffic view) come from plain `env[].value` entries that name a Service. `envFrom`, Secrets and ConfigMaps are not read.

`mod.ts` is the backend (it imports Trame only via `@trame/plugin-api`), `web/index.ts` is the frontend (via `@trame/web-api`).

## Test

```bash
bun test
```
