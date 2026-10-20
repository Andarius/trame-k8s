import { expect, test } from "bun:test";
import type { Workload } from "./model.ts";
import { readSettings, sanitizeSettings, workloadLogo } from "./settings.ts";

// contexts and the kubectl path become argv entries: nothing may read as a flag or carry arguments
test.each([
  { id: "valid contexts kept, deduped", raw: { contexts: ["saas-dev", "admin@k8s-par-prd", "saas-dev"] }, want: { contexts: ["saas-dev", "admin@k8s-par-prd"] } },
  { id: "flag-like context dropped", raw: { contexts: ["--kubeconfig=/tmp/x", "-n", "ok"] }, want: { contexts: ["ok"] } },
  { id: "context with spaces dropped", raw: { contexts: ["a b"] }, want: { contexts: [] } },
  { id: "kubectl with arguments refused", raw: { kubectl: "kubectl --kubeconfig=/x" }, want: {} },
  { id: "relative kubectl path refused", raw: { kubectl: "./kubectl" }, want: {} },
  { id: "absolute kubectl path kept", raw: { kubectl: "/usr/local/bin/kubectl" }, want: { kubectl: "/usr/local/bin/kubectl" } },
  { id: "poll interval clamped", raw: { pollSeconds: 1 }, want: { pollSeconds: 15 } },
  { id: "unknown fields dropped", raw: { enabled: true, token: "x" }, want: {} },
  {
    id: "logos keep slugs and https URLs only",
    raw: { logos: { api: "fastapi", web: "https://cdn.test/web.svg", bad: "http://cdn.test/x.svg", evil: "file:///etc/passwd", "a b": "react" } },
    want: { logos: { api: "fastapi", web: "https://cdn.test/web.svg" } },
  },
])("sanitizeSettings: $id", ({ raw, want }) => {
  expect(sanitizeSettings(raw, {})).toEqual(want);
});

const w = (over: Partial<Workload>): Workload => ({
  cluster: "dev", ns: "app", name: "api", kind: "Deployment", desired: 1, ready: 1, images: ["reg/api:v1"], rolledAt: null,
  services: [], hosts: [], deps: [], pods: [], reason: null, restarts: 0, failed: false, logoHint: null, logo: null, ...over,
});

test.each([
  { id: "most specific override wins", over: {}, logos: { api: "react", "app/api": "fastapi", "dev/app/api": "python" }, want: "/api/plugins/k8s/icon/python" },
  { id: "URL override goes through its key, never the URL itself", over: {}, logos: { api: "https://cdn.test/a.svg" }, want: "/api/plugins/k8s/logo?key=api" },
  { id: "annotation slug", over: { logoHint: "fastapi" }, logos: {}, want: "/api/plugins/k8s/icon/fastapi" },
  { id: "annotation URL ignored: the cluster cannot make the host fetch", over: { logoHint: "https://evil.test/x.svg" }, logos: {}, want: null },
  { id: "guessed from the image", over: { images: ["ghcr.io/cloudnative-pg/postgresql:16"] }, logos: {}, want: "/api/plugins/k8s/icon/postgresql" },
  { id: "tag does not decide", over: { images: ["reg/backend:postgres-16"] }, logos: {}, want: null },
])("workloadLogo: $id", ({ over, logos, want }) => {
  expect(workloadLogo(w(over), readSettings({ logos }))).toBe(want);
});
