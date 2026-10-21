// Snapshot shapes shared by the backend (parse.ts, mod.ts) and the panel (web/).

export type WorkloadKind = "Deployment" | "StatefulSet" | "DaemonSet" | "CronJob";

export type PodView = {
  name: string;
  node: string | null; // null while unscheduled
  phase: string;
  ready: boolean;
  restarts: number;
  reason: string | null;
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
  logo: string | null; // resolved URL, filled per /state request
  groupHint: string | null; // `trame.dev/group` annotation
  group: string | null; // resolved per /state request
};

export type NodeView = {
  name: string;
  ready: boolean;
  cpu: { alloc: number; req: number }; // millicores
  mem: { alloc: number; req: number }; // bytes
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

// image repo → simple-icons slug; first match wins, so specific patterns come first
const IMAGE_ICONS: [RegExp, string][] = [
  [/ingress-nginx|nginx/, "nginx"],
  [/argoproj|argocd/, "argo"],
  [/cloudnative-pg|postgres|pgbouncer|timescale/, "postgresql"],
  [/redis|valkey/, "redis"],
  [/grafana|loki|tempo|mimir|alloy/, "grafana"],
  [/prometheus|alertmanager|node-exporter|kube-state-metrics/, "prometheus"],
  [/cert-manager|jetstack/, "letsencrypt"],
  [/traefik/, "traefikproxy"],
  [/rabbitmq/, "rabbitmq"],
  [/mongo/, "mongodb"],
  [/mariadb/, "mariadb"],
  [/mysql/, "mysql"],
  [/elasticsearch/, "elasticsearch"],
  [/kibana/, "kibana"],
  [/minio/, "minio"],
  [/vault/, "vault"],
  [/keycloak/, "keycloak"],
  [/clickhouse/, "clickhouse"],
  [/temporal/, "temporal"],
  [/sentry/, "sentry"],
  [/n8n/, "n8n"],
  [/metabase/, "metabase"],
  [/nats/, "natsdotio"],
  [/kafka/, "apachekafka"],
  [/qdrant/, "qdrant"],
  [/meilisearch/, "meilisearch"],
  [/opentelemetry|otel/, "opentelemetry"],
  [/fluent-?bit/, "fluentbit"],
  [/cilium/, "cilium"],
  [/istio/, "istio"],
  [/linkerd/, "linkerd"],
  [/coredns|metrics-server|kube-proxy|registry\.k8s\.io|k8s\.gcr\.io|kubectl/, "kubernetes"],
];

const PROVIDER_ICONS: Record<string, string> = {
  scaleway: "scaleway",
  gce: "googlecloud",
  hcloud: "hetzner",
  ovhcloud: "ovh",
  digitalocean: "digitalocean",
  k3s: "k3s",
  kind: "kubernetes",
};

// the repo part only: a tag like `:postgres-16` must not decide the logo
const repoOf = (image: string) => image.replace(/@.*$/, "").replace(/:[^/]*$/, "").toLowerCase();

export function imageIcon(images: string[]): string | null {
  for (const img of images.map(repoOf)) for (const [re, slug] of IMAGE_ICONS) if (re.test(img)) return slug;
  return null;
}

export const providerIcon = (provider: string | null) => (provider && PROVIDER_ICONS[provider]) ?? null;

export const SLUG_RE = /^[a-z0-9]{1,60}$/;
