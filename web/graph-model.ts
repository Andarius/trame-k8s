// Snapshot → force-graph nodes and links for each graph view. Pure; Graph.tsx only draws.
import { type ClusterView, type Health, health, isControlPlane, rolesOf, type Workload } from "../model.ts";

export type Ref =
  | { type: "cluster"; context: string }
  | { type: "ns"; context: string; ns: string }
  | { type: "group"; context: string; group: string }
  | { type: "workload"; context: string; ns: string; name: string }
  | { type: "app"; app: string }
  | { type: "node"; context: string; node: string };

export type GNode = {
  id: string;
  kind: "cluster" | "ns" | "workload" | "app" | "host" | "node" | "pod" | "internet";
  label: string;
  r: number;
  color: string;
  hollow?: boolean;
  pulse?: boolean;
  dashed?: boolean;
  ringColor?: string; // a hub's ring, around a translucent fill
  logo?: string | null;
  labelAlways?: boolean;
  charge: number;
  column?: number; // x the layout pulls the node toward (traffic view's left-to-right lanes)
  tip: string[]; // first line is the title
  ref?: Ref;
};

export type GLink = {
  source: string;
  target: string;
  dist: number;
  strength?: number;
  color?: string;
  width?: number;
  dashed?: boolean;
  arrow?: boolean;
  label?: string;
  hidden?: boolean; // layout-only tether
};

export type GraphData = { nodes: GNode[]; links: GLink[] };
export type GraphView = "infra" | "apps" | "traffic" | "capacity";

export const HEALTH_COLOR: Record<Health, string> = {
  ok: "var(--color-active)",
  fresh: "var(--color-chart-1)",
  deg: "var(--color-paused)",
  down: "var(--color-blocked)",
  zero: "var(--color-done)",
};
export const HEALTH_LABEL: Record<Health, string> = {
  ok: "Ready",
  fresh: "Rolled out < 1h",
  deg: "Degraded",
  down: "Down",
  zero: "Scaled to 0",
};
const NS_COLOR = "var(--color-chart-7)";
const GROUP_COLOR = "var(--color-chart-5)";
const DRIFT = "var(--color-paused)";
const HOT = "var(--color-copper)";
const BUSY_NODE = 0.85;
const CONTROL = "var(--color-chart-7)";

export const workloadId = (w: Pick<Workload, "cluster" | "ns" | "name">) => `w:${w.cluster}/${w.ns}/${w.name}`;
export const appKey = (w: Pick<Workload, "ns" | "name">) => `${w.ns}/${w.name}`;

// a cluster's sections: groups first, then the namespaces of ungrouped workloads
export function sectionsOf(ws: Workload[]): { key: string; label: string; group: boolean; ws: Workload[] }[] {
  const out = new Map<string, { key: string; label: string; group: boolean; ws: Workload[] }>();
  for (const w of [...ws].sort((a, b) => Number(!a.group) - Number(!b.group) || (a.group ?? "").localeCompare(b.group ?? ""))) {
    const key = w.group ? `g:${w.group}` : `n:${w.ns}`;
    if (!out.has(key)) out.set(key, { key, label: w.group ?? w.ns, group: !!w.group, ws: [] });
    out.get(key)!.ws.push(w);
  }
  return [...out.values()];
}
export const tagOf = (image: string) => image.replace(/@.*$/, "").match(/:([^/:]+)$/)?.[1] ?? "latest";
const short = (s: string, max = 28) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "—";
  const m = Math.max(0, (now - Date.parse(iso)) / 60_000);
  return m < 60 ? `${m | 0}m` : m < 1440 ? `${(m / 60) | 0}h` : `${(m / 1440) | 0}d`;
}

// The instance whose images every other instance of the app is compared to: the latest rollout.
export function driftOf(instances: Workload[]): Map<Workload, boolean> {
  const sig = (w: Workload) => w.images.join(" ");
  const newest = [...instances].sort((a, b) => (b.rolledAt ?? "").localeCompare(a.rolledAt ?? ""))[0];
  return new Map(instances.map((w) => [w, !!newest && sig(w) !== sig(newest)]));
}

function clusterNode(c: ClusterView, ws: Workload[], extra: Partial<GNode> = {}): GNode {
  const bad = ws.filter((w) => ["deg", "down"].includes(health(w))).length;
  return {
    id: `c:${c.context}`,
    kind: "cluster",
    label: c.context,
    r: 16,
    color: c.error ? "var(--color-blocked)" : HOT,
    ringColor: c.error ? "var(--color-blocked)" : HOT,
    logo: c.logo,
    labelAlways: true,
    charge: -520,
    tip: [c.context, `${ws.length} workloads · ${c.nodes.length} nodes${bad ? ` · ${bad} unhealthy` : ""}`, ...(c.error ? [c.error] : [])],
    ref: { type: "cluster", context: c.context },
    ...extra,
  };
}

function workloadNode(w: Workload, now: number, id = workloadId(w)): GNode {
  const h = health(w);
  return {
    id,
    kind: "workload",
    label: short(w.name),
    r: w.logo ? 7 : w.kind === "StatefulSet" ? 5 : 4,
    color: HEALTH_COLOR[h],
    hollow: h === "zero",
    pulse: h === "fresh",
    dashed: w.kind === "CronJob",
    logo: w.logo,
    charge: -40,
    tip: [
      w.name,
      `${w.cluster} / ${w.ns} · ${w.kind}`,
      `${w.ready}/${w.desired} ready · ${w.images.map(tagOf).join(", ") || "—"} · ${ago(w.rolledAt, now)} ago`,
      ...(w.reason ? [w.reason] : []),
    ],
    ref: { type: "workload", context: w.cluster, ns: w.ns, name: w.name },
  };
}

// a group spanning several namespaces keeps each namespace with 2+ of its workloads as a hub of its own
const NS_HUB_MIN = 2;

// cluster → group or namespace → workload; a workload drifts out from its hub as its last rollout ages
function infra(clusters: ClusterView[], ws: Workload[], now: number): GraphData {
  const nodes: GNode[] = [], links: GLink[] = [];
  for (const c of clusters) {
    const own = ws.filter((w) => w.cluster === c.context);
    nodes.push(clusterNode(c, own));
    for (const sec of sectionsOf(own)) {
      const inNs = sec.ws;
      const id = `${sec.key[0]}:${c.context}/${sec.label}`;
      nodes.push({
        id, kind: "ns", label: sec.group ? `◆ ${sec.label}` : sec.label, r: sec.group ? 8 : 6,
        color: sec.group ? GROUP_COLOR : NS_COLOR, labelAlways: true, charge: sec.group ? -220 : -150,
        tip: [sec.label, `${sec.group ? "group" : "namespace"} · ${c.context} · ${inNs.length} workloads`],
        ref: sec.group ? { type: "group", context: c.context, group: sec.label } : { type: "ns", context: c.context, ns: sec.label },
      });
      links.push({ source: `c:${c.context}`, target: id, dist: 45, width: 1.3 });
      const perNs = new Map<string, number>();
      for (const w of inNs) perNs.set(w.ns, (perNs.get(w.ns) ?? 0) + 1);
      const split = sec.group && perNs.size > 1;
      for (const w of inNs) {
        nodes.push(workloadNode(w, now));
        let hub = id;
        if (split && perNs.get(w.ns)! >= NS_HUB_MIN) {
          hub = `${id}/${w.ns}`;
          if (!nodes.some((n) => n.id === hub)) {
            nodes.push({
              id: hub, kind: "ns", label: w.ns, r: 6, color: NS_COLOR, labelAlways: true, charge: -150,
              tip: [w.ns, `namespace · ${c.context} · ${perNs.get(w.ns)} workloads in ${sec.label}`],
              ref: { type: "ns", context: c.context, ns: w.ns },
            });
            links.push({ source: id, target: hub, dist: 32, width: 1.1 });
          }
        }
        const hours = w.rolledAt ? Math.max(0, (now - Date.parse(w.rolledAt)) / 3_600_000) : 24 * 30;
        links.push({ source: hub, target: workloadId(w), dist: 16 + 8 * Math.log2(1 + hours) });
      }
    }
  }
  return { nodes, links };
}

// an app (ns/name) deployed in several clusters is one node bridging them; drifted instances show their tag
function apps(clusters: ClusterView[], ws: Workload[], now: number): GraphData {
  const nodes: GNode[] = clusters.map((c) => clusterNode(c, ws.filter((w) => w.cluster === c.context)));
  const links: GLink[] = [];
  const byApp = new Map<string, Workload[]>();
  for (const w of ws) byApp.set(appKey(w), [...(byApp.get(appKey(w)) ?? []), w]);
  for (const [app, instances] of byApp) {
    const shared = new Set(instances.map((w) => w.cluster)).size > 1;
    const drift = driftOf(instances);
    const drifted = [...drift.values()].some(Boolean);
    const id = `a:${app}`;
    nodes.push({
      id, kind: "app", label: app, r: shared ? 8 : 5, color: drifted ? DRIFT : NS_COLOR, logo: instances[0].logo,
      labelAlways: shared, charge: shared ? -220 : -60,
      tip: [app, `${instances.length} instance(s)${drifted ? " · versions differ" : ""}`], ref: { type: "app", app },
    });
    for (const w of instances) {
      const iid = `i:${w.cluster}/${app}`;
      nodes.push({ ...workloadNode(w, now, iid), logo: null, r: 4, label: "" });
      const off = drift.get(w);
      links.push({ source: `c:${w.cluster}`, target: iid, dist: shared ? 60 : 28 });
      links.push({
        source: iid, target: id, dist: shared ? 30 : 14,
        color: off ? DRIFT : undefined, width: off ? 1.6 : undefined, label: off ? w.images.map(tagOf).join(", ") : undefined,
      });
    }
  }
  return { nodes, links };
}

// internet → hosts → workloads → what their env points at; only workloads on some path are drawn
function traffic(clusters: ClusterView[], ws: Workload[], now: number): GraphData {
  const byKey = new Map(ws.map((w) => [`${w.cluster}|${appKey(w)}`, w]));
  const involved = new Set<Workload>();
  for (const w of ws) {
    if (w.hosts.length) involved.add(w);
    for (const d of w.deps) {
      const t = byKey.get(`${w.cluster}|${d}`);
      if (t) involved.add(w).add(t);
    }
  }
  const nodes: GNode[] = [], links: GLink[] = [];
  if (!involved.size) return { nodes, links };
  const hasHosts = [...involved].some((w) => w.hosts.length);
  if (hasHosts) {
    nodes.push({ id: "internet", kind: "internet", label: "internet", r: 12, color: "var(--color-ink-soft)", ringColor: "var(--color-ink-soft)", labelAlways: true, charge: -400, column: -420, tip: ["Internet"] });
  }
  for (const c of clusters) {
    const own = [...involved].filter((w) => w.cluster === c.context);
    if (own.length) nodes.push(clusterNode(c, own, { r: 11, charge: -200, column: 300 }));
  }
  const seenHosts = new Set<string>();
  for (const w of involved) {
    const store = !w.hosts.length && !w.deps.length; // reached, reaches nothing: a backing store
    nodes.push({ ...workloadNode(w, now), labelAlways: !!w.hosts.length || store, column: w.hosts.length ? -120 : store ? 170 : 30 });
    links.push({ source: workloadId(w), target: `c:${w.cluster}`, dist: 140, strength: 0.03, hidden: true });
    for (const host of w.hosts) {
      const hid = `h:${host}`;
      if (!seenHosts.has(hid)) {
        seenHosts.add(hid);
        nodes.push({ id: hid, kind: "host", label: `↗ ${host}`, r: 3.5, color: "var(--color-ink-soft)", charge: -90, column: -280, tip: [host, `→ ${w.cluster} / ${appKey(w)}`] });
        links.push({ source: "internet", target: hid, dist: 70, arrow: true });
      }
      links.push({ source: hid, target: workloadId(w), dist: 50, arrow: true });
    }
    for (const d of w.deps) {
      const t = byKey.get(`${w.cluster}|${d}`);
      if (t) links.push({ source: workloadId(w), target: workloadId(t), dist: 45, arrow: true, dashed: true });
    }
  }
  return { nodes, links };
}

// cluster → node → pod; an unscheduled pod hangs loose off its cluster on a long red tether
function capacity(clusters: ClusterView[], ws: Workload[]): GraphData {
  const nodes: GNode[] = [], links: GLink[] = [];
  for (const c of clusters) {
    const own = ws.filter((w) => w.cluster === c.context);
    nodes.push(clusterNode(c, own));
    for (const n of c.nodes) {
      const cpu = n.cpu.alloc ? n.cpu.req / n.cpu.alloc : 0;
      const mem = n.mem.alloc ? n.mem.req / n.mem.alloc : 0;
      const busy = Math.max(cpu, mem) > BUSY_NODE;
      const id = `node:${c.context}/${n.name}`;
      const control = isControlPlane(n);
      nodes.push({
        id, kind: "node", label: `${control ? "⚙ " : ""}${n.name} · ${Math.round(cpu * 100)}%`, r: 8,
        color: !n.ready ? "var(--color-blocked)" : busy ? HOT : control ? CONTROL : "var(--color-chipline)",
        // control-plane nodes are a ring around a translucent fill, workers a solid dot
        ringColor: control ? (!n.ready ? "var(--color-blocked)" : busy ? HOT : CONTROL) : undefined,
        labelAlways: true, charge: -160,
        tip: [
          n.name,
          rolesOf(n).join(", ") || "worker",
          `cpu requests ${Math.round(cpu * 100)}% · memory ${Math.round(mem * 100)}%`,
          ...(n.ready ? [] : ["NotReady"]),
        ],
        ref: { type: "node", context: c.context, node: n.name },
      });
      links.push({ source: `c:${c.context}`, target: id, dist: 55, width: 1.3 });
    }
    const known = new Set(c.nodes.map((n) => n.name));
    for (const w of own) {
      for (const p of w.pods) {
        const id = `p:${c.context}/${w.ns}/${p.name}`;
        const color = p.ready ? HEALTH_COLOR.ok : p.reason ? HEALTH_COLOR.down : HEALTH_COLOR.deg;
        const pending = !p.node || !known.has(p.node);
        nodes.push({
          id, kind: "pod", label: "", r: pending ? 4 : 3, color, hollow: pending, dashed: pending, charge: -20,
          tip: [p.name, `${w.ns}/${w.name} · ${p.node ?? "not scheduled"}`, `${p.phase} · ${p.restarts} restarts`, ...(p.reason ? [p.reason] : [])],
          ref: { type: "workload", context: c.context, ns: w.ns, name: w.name },
        });
        links.push(pending
          ? { source: `c:${c.context}`, target: id, dist: 110, dashed: true, color: "var(--color-blocked)" }
          : { source: `node:${c.context}/${p.node}`, target: id, dist: 14 });
      }
    }
  }
  return { nodes, links };
}

export function buildGraph(view: GraphView, clusters: ClusterView[], ws: Workload[], now = Date.now()): GraphData {
  switch (view) {
    case "infra": return infra(clusters, ws, now);
    case "apps": return apps(clusters, ws, now);
    case "traffic": return traffic(clusters, ws, now);
    case "capacity": return capacity(clusters, ws);
  }
}
