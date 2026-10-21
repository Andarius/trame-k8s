import { describe, expect, test } from "bun:test";
import { type KubeItem, parseCluster, quantity } from "./parse.ts";

const T = "2026-10-20T10:00:00Z";
const meta = (name: string, ns = "app", extra: Partial<KubeItem["metadata"]> = {}) => ({ name, namespace: ns, creationTimestamp: T, ...extra });
const tpl = (app: string, env: Record<string, string> = {}, image = `reg/${app}:v1`) => ({
  metadata: { labels: { app } },
  spec: { containers: [{ image, env: Object.entries(env).map(([name, value]) => ({ name, value })), resources: { requests: { cpu: "250m", memory: "256Mi" } } }] },
});
const deploy = (name: string, ns = "app", env: Record<string, string> = {}, replicas = 1, ready = replicas): KubeItem => ({
  kind: "Deployment", metadata: meta(name, ns), spec: { replicas, template: tpl(name, env) }, status: { readyReplicas: ready },
});
const service = (name: string, ns = "app", app = name): KubeItem => ({
  kind: "Service", metadata: meta(name, ns), spec: { selector: { app }, ports: [{ port: 80 }] },
});
const pod = (name: string, owner: { kind: string; name: string }, opts: { ns?: string; node?: string | null; hash?: string; status?: Record<string, unknown> } = {}): KubeItem => ({
  kind: "Pod",
  metadata: meta(name, opts.ns ?? "app", { ownerReferences: [owner], labels: opts.hash ? { "pod-template-hash": opts.hash } : {} }),
  spec: { nodeName: opts.node === undefined ? "n1" : opts.node ?? undefined, containers: [{ resources: { requests: { cpu: "500m", memory: "1Gi" } } }] },
  status: opts.status ?? { phase: "Running", conditions: [{ type: "Ready", status: "True" }], containerStatuses: [{ restartCount: 0 }] },
});

const items: KubeItem[] = [
  deploy("api", "app", { DATABASE_URL: "postgres://u:p@pg.data:5432/db", CACHE: "redis:6379", NOT_A_HOST: "pgx-driver", BROKER: "amqp://myqueue:5672" }, 2, 1),
  { kind: "StatefulSet", metadata: meta("pg", "data"), spec: { replicas: 1, template: tpl("pg", {}, "ghcr.io/cloudnative-pg/postgresql:16.4") }, status: { readyReplicas: 1 } },
  deploy("redis"),
  deploy("queue"),
  service("queue"),
  { kind: "DaemonSet", metadata: meta("agent", "ops"), spec: { template: tpl("agent") }, status: { desiredNumberScheduled: 2, numberReady: 2 } },
  { kind: "CronJob", metadata: meta("etl"), spec: { suspend: false, jobTemplate: { spec: { template: tpl("etl") } } }, status: { lastScheduleTime: T } },
  { kind: "Job", metadata: meta("etl-29000", "app", { ownerReferences: [{ kind: "CronJob", name: "etl" }] }), status: { failed: 1 } },
  service("api"), service("pg", "data"), service("redis"),
  { kind: "Ingress", metadata: meta("api"), spec: { rules: [{ host: "api.example.com", http: { paths: [{ backend: { service: { name: "api" } } }] } }] } },
  { kind: "Ingress", metadata: meta("api-ts"), spec: { defaultBackend: { service: { name: "api" } }, tls: [{ hosts: ["api-tailnet"] }] } },
  { kind: "HTTPRoute", metadata: meta("pg-route", "gw"), spec: { hostnames: ["pg.example.com"], rules: [{ backendRefs: [{ name: "pg", namespace: "data" }] }] } },
  pod("api-7d9f-a", { kind: "ReplicaSet", name: "api-7d9f" }, { hash: "7d9f" }),
  pod("api-7d9f-b", { kind: "ReplicaSet", name: "api-7d9f" }, {
    hash: "7d9f",
    status: { phase: "Running", conditions: [], containerStatuses: [{ restartCount: 4, state: { waiting: { reason: "CrashLoopBackOff" } }, lastState: { terminated: { reason: "OOMKilled" } } }] },
  }),
  pod("pg-0", { kind: "StatefulSet", name: "pg" }, { ns: "data" }),
  pod("etl-29000-x", { kind: "Job", name: "etl-29000" }, { node: null, status: { phase: "Pending", conditions: [{ type: "PodScheduled", status: "False", message: "0/2 nodes are available: 2 Insufficient cpu." }] } }),
  { kind: "PodMetrics", metadata: meta("api-7d9f-a"), containers: [{ name: "api", usage: { cpu: "100m", memory: "200Mi" } }, { name: "side", usage: { cpu: "50m", memory: "56Mi" } }] },
  { kind: "Node", metadata: { name: "n1", labels: { "node-role.kubernetes.io/control-plane": "true", "node-role.kubernetes.io/etcd": "true" } }, spec: { providerID: "scaleway://instance/fr-par-1/abc" }, status: { allocatable: { cpu: "4", memory: "8Gi" }, conditions: [{ type: "Ready", status: "True" }] } },
];
const cluster = parseCluster("dev", { items }, T);
const find = (ns: string, name: string) => cluster.workloads.find((w) => w.ns === ns && w.name === name)!;

describe("parseCluster", () => {
  test.each([
    { id: "deployment owns its ReplicaSet pods", ns: "app", name: "api", want: { desired: 2, ready: 1, restarts: 4, reason: "CrashLoopBackOff · OOMKilled" } },
    { id: "statefulset", ns: "data", name: "pg", want: { kind: "StatefulSet", ready: 1, logoHint: null } },
    { id: "daemonset counts scheduled", ns: "ops", name: "agent", want: { kind: "DaemonSet", desired: 2, ready: 2 } },
    { id: "cronjob owns pods through its job; last job failed", ns: "app", name: "etl", want: { failed: true, reason: "0/2 nodes are available: 2 Insufficient cpu." } },
  ])("$id", ({ ns, name, want }) => {
    expect(find(ns, name)).toMatchObject(want);
  });

  test.each([
    { id: "ingress rule host", ns: "app", name: "api", hosts: ["api.example.com", "api-tailnet"] },
    { id: "httproute in another namespace", ns: "data", name: "pg", hosts: ["pg.example.com"] },
    { id: "no route", ns: "app", name: "redis", hosts: [] },
  ])("hosts: $id", ({ ns, name, hosts }) => {
    expect(find(ns, name).hosts).toEqual(hosts);
  });

  test("env values that address a Service become deps; lookalikes do not", () => {
    expect(find("app", "api").deps).toEqual(["app/redis", "data/pg"]);
  });

  test("unscheduled pods keep a null node, and node requests sum running pods only", () => {
    expect(find("app", "etl").pods[0].node).toBeNull();
    expect(cluster.nodes[0]).toMatchObject({
      ready: true, roles: ["control-plane", "etcd"],
      cpu: { alloc: 4000, req: 1500, use: 150 }, mem: { alloc: 8 * 2 ** 30, req: 3 * 2 ** 30, use: 256 * 2 ** 20 },
    });
  });

  test("pods carry their requests and metrics-server usage, null without a reading", () => {
    const [a, b] = find("app", "api").pods;
    expect([a.cpu, a.mem]).toEqual([{ req: 500, use: 150 }, { req: 2 ** 30, use: 256 * 2 ** 20 }]);
    expect([b.cpu.use, b.mem.use]).toEqual([null, null]);
    expect(cluster.provider).toBe("scaleway");
  });
});

test.each([
  { id: "millicores", q: "250m", milli: true, want: 250 },
  { id: "whole cores", q: "4", milli: true, want: 4000 },
  { id: "fractional cores", q: "0.5", milli: true, want: 500 },
  { id: "nanocores", q: "1500000n", milli: true, want: 2 },
  { id: "binary memory", q: "512Mi", milli: false, want: 512 * 2 ** 20 },
  { id: "decimal memory", q: "1G", milli: false, want: 1e9 },
  { id: "exponent", q: "1e3", milli: false, want: 1000 },
  { id: "garbage", q: "lots", milli: false, want: 0 },
  { id: "missing", q: undefined, milli: true, want: 0 },
])("quantity: $id", ({ q, milli, want }) => {
  expect(quantity(q, milli)).toBe(want);
});
