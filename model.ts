// Snapshot shapes the backend (src/model.rs) serves and the panel (web/) reads; matching rules mirror src/model.rs.

export type WorkloadKind = "Deployment" | "StatefulSet" | "DaemonSet" | "CronJob";

export type Usage = { req: number; use: number | null }; // use is null without metrics-server

export type PodView = {
  name: string;
  node: string | null; // null while unscheduled
  phase: string;
  ready: boolean;
  restarts: number;
  reason: string | null;
  cpu: Usage; // millicores
  mem: Usage; // bytes
};

export type ServiceView = { name: string; type: string; ports: string[] };

export type Workload = {
  cluster: string;
  ns: string;
  name: string;
  kind: WorkloadKind;
  desired: number;
  ready: number;
  images: string[];
  rolledAt: string | null;
  services: ServiceView[];
  hosts: string[];
  deps: string[]; // `${ns}/${name}` of workloads this one reaches, same cluster
  pods: PodView[];
  reason: string | null; // first unready pod's reason, or the last failed job's
  restarts: number;
  failed: boolean; // CronJob only: last job failed
  logoHint: string | null; // `trame.dev/logo` annotation (a simple-icons slug)
  tech: string[]; // the tool it runs (annotation or image guess), then its kinds: postgresql, db, sql
  logo: string | null; // resolved URL, filled per /state request
  groupHint: string | null; // `trame.dev/group` annotation
  group: string | null; // resolved per /state request
};

export type NodeView = {
  name: string;
  roles: string[]; // `node-role.kubernetes.io/<role>` labels, sorted
  ready: boolean;
  cpu: { alloc: number; req: number; use: number | null }; // millicores
  mem: { alloc: number; req: number; use: number | null }; // bytes
};

export type ClusterView = {
  context: string;
  provider: string | null; // from the nodes' providerID scheme
  error: string | null;
  polledAt: string | null; // last successful poll; workloads are kept when a later poll fails
  workloads: Workload[];
  nodes: NodeView[];
  logo: string | null;
};

export type Snapshot = { clusters: ClusterView[]; polledAt: string | null; configured: boolean };

export type Health = "ok" | "fresh" | "deg" | "down" | "zero";

export const FRESH_MS = 3_600_000;

export const SYSTEM_NAMESPACES = new Set([
  "kube-system",
  "kube-public",
  "kube-node-lease",
  "cert-manager",
  "ingress-nginx",
  "external-secrets",
  "argocd",
  "cnpg-system",
  "kyverno",
  "gatekeeper-system",
]);

export const isSystem = (ns: string) => SYSTEM_NAMESPACES.has(ns) || ns.endsWith("-system");

export function health(w: Workload, now = Date.now()): Health {
  if (w.kind === "CronJob") return w.desired === 0 ? "zero" : w.failed ? "deg" : "ok";
  if (w.desired === 0) return "zero";
  if (w.ready === 0) return "down";
  if (w.ready < w.desired) return "deg";
  return w.rolledAt && now - Date.parse(w.rolledAt) < FRESH_MS ? "fresh" : "ok";
}

export const unhealthy = (w: Workload) => {
  const h = health(w);
  return h === "deg" || h === "down";
};

// a host older than this field sends no roles
export const rolesOf = (n: Partial<Pick<NodeView, "roles">>) => n.roles ?? [];
export const isControlPlane = (n: Partial<Pick<NodeView, "roles">>) => rolesOf(n).some((r) => r === "control-plane" || r === "master");

const globRe = (pattern: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*")}$`);

// a settings key or pattern (`name`, `ns/name`, `context/ns/name`, `*` within a segment) against the workload's key
// with as many segments
export function matchesKey(w: Pick<Workload, "cluster" | "ns" | "name">, pattern: string): boolean {
  const keys = [w.name, `${w.ns}/${w.name}`, `${w.cluster}/${w.ns}/${w.name}`];
  const key = keys[pattern.split("/").length - 1];
  return key !== undefined && globRe(pattern).test(key);
}

export const SLUG_RE = /^[a-z0-9]{1,60}$/;
