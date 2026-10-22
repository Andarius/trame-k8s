# trame-k8s

A Kubernetes plugin for [Trame](https://github.com/Andarius/trame). It shows the workloads of your kube contexts as cluster columns, or as force graphs:

- **Infra:** cluster → group or namespace → workload. A group spanning several namespaces keeps each namespace with two or more of its workloads as a hub of its own.
- **Apps:** the same app across clusters, with version drift highlighted.
- **Traffic:** hosts → workloads → what their env points at.
- **Capacity:** cluster → node → pod.

## Use

In a Trame checkout, list this repo's path relative to it (here `~/Projects/Work/trame-k8s` next to `~/Projects/trame`), then build Trame with the plugin compiled in:

```bash
echo '{ "plugins": ["../Work/trame-k8s"] }' > plugins.local.json
just plugins   # composes src/mod.rs into trame-local and web/ into the plugins bundle
just dev       # or rebuild and restart your Trame build
```

Enable it under Plugins and tick the contexts to poll. Nothing is polled until a context is ticked.

The sidebar column beside the rail picks the clusters to show, a group, and whether system namespaces or only issues are shown. The toolbar holds the view and the search, which is GitHub-like: words match name, namespace, cluster, group, image and host; `cluster:`, `ns:`, `group:`, `kind:`, `image:`, `host:` and `is:` (`ready`, `rolled`, `degraded`, `down`, `zero`) narrow a field; `-` excludes; quote a value with spaces.

The backend runs `kubectl --context=<ctx> get … -A -o json` per context, from the Trame process (30 s timeout per call). It uses your kubeconfig and is read-only. Gateway API `HTTPRoute`s are read when the CRD exists.

- **Logos** resolve in this order: a settings override (`name`, `ns/name`, `context/ns/name`, or a context; `*` matches within a segment, an exact key wins), then a `trame.dev/logo: <slug>` annotation, then a guess from the image name. Logos are [simple-icons](https://simpleicons.org) slugs, fetched once through the plugin and cached.
- **Dependency edges** (Traffic view) come from plain `env[].value` entries that name a Service. `envFrom`, Secrets and ConfigMaps are not read.

`src/mod.rs` is the backend, a native Rust module compiled into `trame-local` (it reaches Trame only through `crate::plugins::api`); `web/index.ts` is the frontend (via `@trame/web-api`). Nothing is written to the database.

## Test

From the Trame checkout, with the plugin composed:

```bash
cargo clippy -p trame-local --all-targets --locked -- -D warnings
cargo test -p trame-local --locked --lib   # the Rust unit tests: parsing, settings, logos, groups
(cd app/web && npm run typecheck)
```

In this repo, `bun test` runs the web-side tests, the import boundary check and the version check.

## Release

Bump `VERSION` in `version.ts` and `src/mod.rs`, merge, then push a matching tag (`git tag v0.2.0 && git push origin v0.2.0`). The release workflow refuses a tag that differs from `VERSION` and publishes a GitHub release with generated notes; Trame then shows "Update available" for older installs.
