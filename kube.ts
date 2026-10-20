// kubectl I/O: one `get` per context, and the contexts the local kubeconfig knows.
import type { ClusterView } from "./model.ts";
import { type KubeList, parseCluster } from "./parse.ts";

const KINDS = "deployments,statefulsets,daemonsets,cronjobs,jobs,pods,services,ingresses,nodes";
const ROUTES = "httproutes.gateway.networking.k8s.io";
const TIMEOUT_MS = 30_000;

export class KubectlError extends Error {}

async function run(argv: string[]): Promise<string> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  } catch (e) {
    throw new KubectlError(`cannot run ${argv[0]}: ${e instanceof Error ? e.message : e}`);
  }
  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new KubectlError(err.trim().split("\n").at(-1)?.slice(0, 300) || `exit ${code}`);
    return out;
  } finally {
    clearTimeout(timer);
  }
}

export async function listContexts(kubectl: string): Promise<string[]> {
  const out = await run([kubectl, "config", "get-contexts", "-o", "name"]);
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

const get = (kubectl: string, context: string, kinds: string) =>
  run([kubectl, `--context=${context}`, "get", kinds, "--all-namespaces", "-o", "json", "--request-timeout=20s"])
    .then((out) => JSON.parse(out) as KubeList);

export async function fetchCluster(kubectl: string, context: string): Promise<ClusterView> {
  // a separate call: a cluster without the Gateway API CRDs fails it, and that must not fail the poll
  const [core, routes] = await Promise.all([
    get(kubectl, context, KINDS),
    get(kubectl, context, ROUTES).catch(() => ({ items: [] })),
  ]);
  return parseCluster(context, { items: [...core.items, ...routes.items] }, new Date().toISOString());
}
