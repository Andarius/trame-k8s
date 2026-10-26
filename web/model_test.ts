import { expect, test } from "bun:test";
import { type Health, health, type Workload } from "../model.ts";
import { buildGraph, driftOf, filterTerm, type GNode } from "./graph-model.ts";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const w = (over: Partial<Workload>): Workload => ({
  cluster: "dev", ns: "app", name: "api", kind: "Deployment", desired: 2, ready: 2, images: ["reg/api:v1"],
  rolledAt: "2026-10-19T12:00:00Z", services: [], hosts: [], deps: [], pods: [], reason: null, restarts: 0,
  failed: false, logoHint: null, tech: [], logo: null, groupHint: null, group: null, ...over,
});

test.each<{ id: string; over: Partial<Workload>; want: Health }>([
  { id: "all ready", over: {}, want: "ok" },
  { id: "rolled out within the hour", over: { rolledAt: "2026-10-20T11:30:00Z" }, want: "fresh" },
  { id: "some ready", over: { ready: 1 }, want: "deg" },
  { id: "none ready", over: { ready: 0 }, want: "down" },
  { id: "scaled to zero", over: { desired: 0, ready: 0 }, want: "zero" },
  { id: "cronjob suspended", over: { kind: "CronJob", desired: 0 }, want: "zero" },
  { id: "cronjob last job failed", over: { kind: "CronJob", desired: 1, failed: true }, want: "deg" },
])("health: $id", ({ over, want }) => {
  expect(health(w(over), NOW)).toBe(want);
});

test("drift is measured against the latest rollout of the app", () => {
  const dev = w({ cluster: "dev", images: ["reg/api:v2"], rolledAt: "2026-10-20T09:00:00Z" });
  const prod = w({ cluster: "prod", images: ["reg/api:v1"], rolledAt: "2026-10-10T09:00:00Z" });
  const staging = w({ cluster: "stg", images: ["reg/api:v2"], rolledAt: "2026-10-19T09:00:00Z" });
  const drift = driftOf([prod, dev, staging]);
  expect([drift.get(dev), drift.get(prod), drift.get(staging)]).toEqual([false, true, false]);
});

test("infra: a group over several namespaces keeps a namespace with 2+ workloads as its own hub", () => {
  const ws = [
    w({ ns: "langfuse", name: "web", group: "ai" }),
    w({ ns: "langfuse", name: "worker", group: "ai" }),
    w({ ns: "litellm", name: "litellm", group: "ai" }),
    w({ ns: "app", name: "api" }),
  ];
  const cluster = { context: "dev", provider: null, error: null, polledAt: null, workloads: ws, nodes: [], logo: null };
  const g = buildGraph("infra", [cluster], ws, NOW);
  const parent = (name: string) => g.links.find((l) => l.target === `w:dev/${ws.find((x) => x.name === name)!.ns}/${name}`)!.source;
  expect([parent("web"), parent("worker"), parent("litellm"), parent("api")]).toEqual(["g:dev/ai/langfuse", "g:dev/ai/langfuse", "g:dev/ai", "n:dev/app"]);
  expect(g.links.find((l) => l.target === "g:dev/ai/langfuse")?.source).toBe("g:dev/ai");
});

test.each<{ id: string; n: Pick<GNode, "kind" | "id" | "ref">; want: string | null }>([
  { id: "cluster", n: { kind: "cluster", id: "c:dev", ref: { type: "cluster", context: "dev" } }, want: "cluster:dev" },
  { id: "group with spaces is quoted", n: { kind: "ns", id: "g:dev/ai kit", ref: { type: "group", context: "dev", group: "ai kit" } }, want: 'group:"ai kit"' },
  { id: "workload", n: { kind: "workload", id: "w:dev/app/api", ref: { type: "workload", context: "dev", ns: "app", name: "api" } }, want: "ns:app api" },
  { id: "app", n: { kind: "app", id: "a:app/api", ref: { type: "app", app: "app/api" } }, want: "ns:app api" },
  { id: "host", n: { kind: "host", id: "h:api.example.com" }, want: "host:api.example.com" },
  { id: "k8s node has none", n: { kind: "node", id: "k:dev/n1", ref: { type: "node", context: "dev", node: "n1" } }, want: null },
])("filterTerm: $id", ({ n, want }) => {
  expect(filterTerm(n)).toBe(want);
});
