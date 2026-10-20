import { expect, test } from "bun:test";
import { type Health, health, type Workload } from "./model.ts";
import { driftOf } from "./web/graph-model.ts";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const w = (over: Partial<Workload>): Workload => ({
  cluster: "dev", ns: "app", name: "api", kind: "Deployment", desired: 2, ready: 2, images: ["reg/api:v1"],
  rolledAt: "2026-10-19T12:00:00Z", services: [], hosts: [], deps: [], pods: [], reason: null, restarts: 0,
  failed: false, logoHint: null, logo: null, ...over,
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
