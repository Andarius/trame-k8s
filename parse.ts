// `kubectl get … -A -o json` List → one cluster's workloads, nodes and their relations.
import type { ClusterView, NodeView, PodView, ServiceView, Workload, WorkloadKind } from "./model.ts";

type Meta = {
  name: string;
  namespace?: string;
  creationTimestamp?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  ownerReferences?: { kind: string; name: string }[];
};
type Container = {
  image?: string;
  env?: { name: string; value?: string }[];
  resources?: { requests?: Record<string, string> };
};
type PodTemplate = { metadata?: { labels?: Record<string, string> }; spec?: { containers?: Container[] } };
type Condition = { type: string; status: string; reason?: string; message?: string; lastUpdateTime?: string };
type ContainerStatus = {
  restartCount?: number;
  state?: { waiting?: { reason?: string } };
  lastState?: { terminated?: { reason?: string } };
};
export type KubeItem = {
  kind: string;
  metadata: Meta;
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
  containers?: { name: string; usage?: Record<string, string> }[]; // PodMetrics
};
type PodUsage = { cpu: number; mem: number };
export type KubeList = { items: KubeItem[] };

const LOGO_ANNOTATION = "trame.dev/logo";
const GROUP_ANNOTATION = "trame.dev/group";
const ROLE_LABEL = "node-role.kubernetes.io/";
const WORKLOAD_KINDS = new Set<string>(["Deployment", "StatefulSet", "DaemonSet", "CronJob"]);

const num = (v: unknown, fallback = 0) => (typeof v === "number" ? v : fallback);
const key = (ns: string, name: string) => `${ns}/${name}`;

// Kubernetes resource quantity → millicores (cpu) or bytes (memory)
const SUFFIX: Record<string, number> = {
  n: 1e-9, u: 1e-6, m: 1e-3, "": 1,
  k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12,
  Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40,
};
export function quantity(q: string | undefined, milli = false): number {
  const m = q?.trim().match(/^([0-9.]+)(e[0-9]+|[a-zA-Z]*)$/);
  if (!m) return 0;
  const base = m[2].startsWith("e") ? 10 ** Number(m[2].slice(1)) : SUFFIX[m[2]];
  if (base === undefined) return 0;
  return Math.round(Number(m[1]) * base * (milli ? 1000 : 1));
}

function template(item: KubeItem): PodTemplate {
  const spec = item.spec ?? {};
  if (item.kind === "CronJob") {
    const job = spec.jobTemplate as { spec?: { template?: PodTemplate } } | undefined;
    return job?.spec?.template ?? {};
  }
  return (spec.template as PodTemplate | undefined) ?? {};
}

function podReason(pod: KubeItem): string | null {
  const status = pod.status ?? {};
  for (const cs of (status.containerStatuses ?? []) as ContainerStatus[]) {
    const waiting = cs.state?.waiting?.reason;
    const last = cs.lastState?.terminated?.reason;
    if (waiting && waiting !== "ContainerCreating") return last && last !== "Completed" ? `${waiting} · ${last}` : waiting;
  }
  const scheduled = ((status.conditions ?? []) as Condition[]).find((c) => c.type === "PodScheduled");
  if (scheduled?.status === "False") return scheduled.message?.slice(0, 160) ?? scheduled.reason ?? "Unschedulable";
  return status.phase === "Failed" ? (status.reason as string | undefined) ?? "Failed" : null;
}

const requested = (containers: Container[], res: string, milli: boolean) =>
  containers.reduce((s, c) => s + quantity(c.resources?.requests?.[res], milli), 0);

function podView(pod: KubeItem, usage: Map<string, PodUsage>): PodView {
  const status = pod.status ?? {};
  const statuses = (status.containerStatuses ?? []) as ContainerStatus[];
  const containers = (pod.spec?.containers ?? []) as Container[];
  const used = usage.get(key(pod.metadata.namespace ?? "", pod.metadata.name));
  return {
    cpu: { req: requested(containers, "cpu", true), use: used?.cpu ?? null },
    mem: { req: requested(containers, "memory", false), use: used?.mem ?? null },
    name: pod.metadata.name,
    node: (pod.spec?.nodeName as string | undefined) ?? null,
    phase: (status.phase as string | undefined) ?? "Unknown",
    ready: ((status.conditions ?? []) as Condition[]).some((c) => c.type === "Ready" && c.status === "True"),
    restarts: statuses.reduce((n, cs) => n + (cs.restartCount ?? 0), 0),
    reason: podReason(pod),
  };
}

// the workload a pod belongs to, through its ReplicaSet or Job when there is one
function ownerOf(pod: KubeItem, jobOwners: Map<string, string>): [WorkloadKind, string] | null {
  const ns = pod.metadata.namespace ?? "";
  for (const ref of pod.metadata.ownerReferences ?? []) {
    if (ref.kind === "ReplicaSet") {
      const hash = pod.metadata.labels?.["pod-template-hash"];
      return ["Deployment", hash && ref.name.endsWith(`-${hash}`) ? ref.name.slice(0, -hash.length - 1) : ref.name];
    }
    if (ref.kind === "StatefulSet" || ref.kind === "DaemonSet") return [ref.kind, ref.name];
    if (ref.kind === "Job") {
      const cron = jobOwners.get(key(ns, ref.name));
      return cron ? ["CronJob", cron] : null;
    }
  }
  return null;
}

const selects = (selector: Record<string, string>, labels: Record<string, string>) =>
  Object.entries(selector).every(([k, v]) => labels[k] === v);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// does an env value address this Service: `svc`, `svc.ns`, `svc.ns.svc[.cluster.local]`, as a host?
function addresses(value: string, svc: string, svcNs: string, fromNs: string): boolean {
  const host = `${escape(svc)}(\\.${escape(svcNs)}(\\.svc(\\.cluster\\.local)?)?)`;
  const re = new RegExp(`(^|[/@=,;\\s])${host}${svcNs === fromNs ? "?" : ""}([:/,;\\s]|$)`);
  return re.test(value);
}

function newest(dates: (string | undefined | null)[]): string | null {
  let best: string | null = null;
  for (const d of dates) if (d && (!best || d > best)) best = d;
  return best;
}

export function parseCluster(context: string, list: KubeList, polledAt: string): ClusterView {
  const items = list.items ?? [];
  const byKind = (k: string) => items.filter((i) => i.kind === k);

  const jobOwners = new Map<string, string>();
  const jobs = byKind("Job");
  for (const job of jobs) {
    const cron = job.metadata.ownerReferences?.find((r) => r.kind === "CronJob");
    if (cron) jobOwners.set(key(job.metadata.namespace ?? "", job.metadata.name), cron.name);
  }

  const pods = byKind("Pod").filter((p) => p.status?.phase !== "Succeeded");
  // metrics-server's PodMetrics, when the API is served
  const usage = new Map<string, PodUsage>();
  for (const m of byKind("PodMetrics")) {
    const cs = m.containers ?? [];
    usage.set(key(m.metadata.namespace ?? "", m.metadata.name), {
      cpu: cs.reduce((s, c) => s + quantity(c.usage?.cpu, true), 0),
      mem: cs.reduce((s, c) => s + quantity(c.usage?.memory), 0),
    });
  }
  const podsOf = new Map<string, KubeItem[]>();
  for (const pod of pods) {
    const owner = ownerOf(pod, jobOwners);
    if (!owner) continue;
    const k = `${owner[0]}:${key(pod.metadata.namespace ?? "", owner[1])}`;
    podsOf.set(k, [...(podsOf.get(k) ?? []), pod]);
  }

  const workloads: Workload[] = [];
  const labelsOf = new Map<Workload, Record<string, string>>();
  const envOf = new Map<Workload, string[]>();
  for (const item of items) {
    if (!WORKLOAD_KINDS.has(item.kind)) continue;
    const kind = item.kind as WorkloadKind;
    const ns = item.metadata.namespace ?? "";
    const spec = item.spec ?? {};
    const status = item.status ?? {};
    const tpl = template(item);
    const own = podsOf.get(`${kind}:${key(ns, item.metadata.name)}`) ?? [];
    const views = own.map((p) => podView(p, usage));

    let desired: number, ready: number, rolledAt: string | null, failed = false;
    if (kind === "DaemonSet") {
      desired = num(status.desiredNumberScheduled);
      ready = num(status.numberReady);
      rolledAt = newest(own.map((p) => p.metadata.creationTimestamp));
    } else if (kind === "CronJob") {
      const active = ((status.active ?? []) as unknown[]).length;
      desired = spec.suspend === true ? 0 : Math.max(1, active);
      ready = desired;
      rolledAt = (status.lastScheduleTime as string | undefined) ?? null;
      const last = jobs
        .filter((j) => jobOwners.get(key(ns, j.metadata.name)) === item.metadata.name)
        .sort((a, b) => (b.metadata.creationTimestamp ?? "").localeCompare(a.metadata.creationTimestamp ?? ""))[0];
      failed = !!last && num(last.status?.failed) > 0 && !num(last.status?.succeeded);
    } else {
      desired = num(spec.replicas, 1);
      ready = num(status.readyReplicas);
      const progressing = ((status.conditions ?? []) as Condition[]).find((c) => c.type === "Progressing");
      rolledAt = progressing?.lastUpdateTime ?? newest(own.map((p) => p.metadata.creationTimestamp));
    }

    const containers = tpl.spec?.containers ?? [];
    const w: Workload = {
      cluster: context,
      ns,
      name: item.metadata.name,
      kind,
      desired,
      ready,
      images: [...new Set(containers.map((c) => c.image).filter((i): i is string => !!i))],
      rolledAt,
      services: [],
      hosts: [],
      deps: [],
      pods: views,
      reason: views.find((p) => !p.ready && p.reason)?.reason ?? (failed ? "Last job failed" : null),
      restarts: views.reduce((n, p) => n + p.restarts, 0),
      failed,
      logoHint: item.metadata.annotations?.[LOGO_ANNOTATION] ?? null,
      logo: null,
      groupHint: item.metadata.annotations?.[GROUP_ANNOTATION] ?? null,
      group: null,
    };
    workloads.push(w);
    labelsOf.set(w, tpl.metadata?.labels ?? {});
    envOf.set(w, containers.flatMap((c) => (c.env ?? []).map((e) => e.value).filter((v): v is string => !!v)));
  }

  // Service → the workloads it selects
  const targets = new Map<string, Workload[]>();
  const services = byKind("Service");
  for (const svc of services) {
    const ns = svc.metadata.namespace ?? "";
    const selector = svc.spec?.selector as Record<string, string> | undefined;
    if (!selector || !Object.keys(selector).length) continue;
    const ports = ((svc.spec?.ports ?? []) as { port: number; protocol?: string }[])
      .map((p) => `${p.port}${p.protocol && p.protocol !== "TCP" ? `/${p.protocol}` : ""}`);
    const view: ServiceView = { name: svc.metadata.name, type: (svc.spec?.type as string | undefined) ?? "ClusterIP", ports };
    const selected = workloads.filter((w) => w.ns === ns && w.kind !== "CronJob" && selects(selector, labelsOf.get(w)!));
    for (const w of selected) w.services.push(view);
    targets.set(key(ns, svc.metadata.name), selected);
  }

  const expose = (hosts: string[], svcNs: string, svc: string | undefined) => {
    for (const w of (svc && targets.get(key(svcNs, svc))) || []) {
      for (const h of hosts) if (h && !w.hosts.includes(h)) w.hosts.push(h);
    }
  };
  // Ingress host → Service → workloads; a rule-less Ingress (e.g. Tailscale) names its hosts under tls
  type Backend = { service?: { name?: string } };
  type Rule = { host?: string; http?: { paths?: { backend?: Backend }[] } };
  for (const ing of byKind("Ingress")) {
    const ns = ing.metadata.namespace ?? "";
    const rules = (ing.spec?.rules ?? []) as Rule[];
    const tlsHosts = ((ing.spec?.tls ?? []) as { hosts?: string[] }[]).flatMap((t) => t.hosts ?? []);
    const fallback = (ing.spec?.defaultBackend as Backend | undefined)?.service?.name;
    for (const rule of rules) {
      for (const path of rule.http?.paths ?? []) expose(rule.host ? [rule.host] : tlsHosts, ns, path.backend?.service?.name);
    }
    if (fallback) expose(rules.some((r) => r.host) ? rules.map((r) => r.host!).filter(Boolean) : tlsHosts, ns, fallback);
  }
  // Gateway API: HTTPRoute hostnames → backendRefs (Services, possibly in another namespace)
  type BackendRef = { kind?: string; name?: string; namespace?: string };
  for (const route of byKind("HTTPRoute")) {
    const ns = route.metadata.namespace ?? "";
    const hosts = (route.spec?.hostnames ?? []) as string[];
    for (const rule of (route.spec?.rules ?? []) as { backendRefs?: BackendRef[] }[]) {
      for (const ref of rule.backendRefs ?? []) if ((ref.kind ?? "Service") === "Service") expose(hosts, ref.namespace ?? ns, ref.name);
    }
  }

  // env values naming a Service → dependency edges
  for (const w of workloads) {
    const values = envOf.get(w)!;
    if (!values.length) continue;
    const deps = new Set<string>();
    for (const svc of services) {
      const svcNs = svc.metadata.namespace ?? "";
      const selected = targets.get(key(svcNs, svc.metadata.name));
      if (!selected?.length) continue;
      if (!values.some((v) => addresses(v, svc.metadata.name, svcNs, w.ns))) continue;
      for (const t of selected) if (t !== w) deps.add(key(t.ns, t.name));
    }
    w.deps = [...deps].sort();
  }

  const nodes: NodeView[] = byKind("Node").map((n) => {
    const alloc = (n.status?.allocatable ?? {}) as Record<string, string>;
    const on = pods.filter((p) => p.spec?.nodeName === n.metadata.name && p.status?.phase !== "Failed");
    const req = (res: string, milli: boolean) => on.reduce((sum, p) => sum + requested((p.spec?.containers ?? []) as Container[], res, milli), 0);
    const use = (res: keyof PodUsage) =>
      usage.size ? on.reduce((sum, p) => sum + (usage.get(key(p.metadata.namespace ?? "", p.metadata.name))?.[res] ?? 0), 0) : null;
    return {
      name: n.metadata.name,
      roles: Object.keys(n.metadata.labels ?? {}).filter((k) => k.startsWith(ROLE_LABEL)).map((k) => k.slice(ROLE_LABEL.length)).sort(),
      ready: ((n.status?.conditions ?? []) as Condition[]).some((c) => c.type === "Ready" && c.status === "True"),
      cpu: { alloc: quantity(alloc.cpu, true), req: req("cpu", true), use: use("cpu") },
      mem: { alloc: quantity(alloc.memory), req: req("memory", false), use: use("mem") },
    };
  });
  const providerId = byKind("Node").map((n) => n.spec?.providerID as string | undefined).find(Boolean);

  workloads.sort((a, b) => a.ns.localeCompare(b.ns) || a.name.localeCompare(b.name));
  return {
    context,
    provider: providerId?.split("://")[0] || null,
    error: null,
    polledAt,
    workloads,
    nodes,
    logo: null,
  };
}
