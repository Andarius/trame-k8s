// GitHub-like search over workloads: free words plus `field:value` qualifiers, `-` to negate.
import { type Health, health, type Workload } from "../model.ts";

export const QUALIFIERS = ["cluster", "ns", "group", "kind", "image", "host", "is"] as const;
export type Qualifier = (typeof QUALIFIERS)[number];

export type Term = { field: Qualifier | null; value: string; not: boolean };

const IS_ALIAS: Record<string, Health> = { ready: "ok", ok: "ok", fresh: "fresh", rolled: "fresh", degraded: "deg", deg: "deg", down: "down", zero: "zero", scaled: "zero" };

const isQualifier = (s: string): s is Qualifier => (QUALIFIERS as readonly string[]).includes(s);

// `cluster:prod -ns:kube-system "my app"`: a quoted value keeps its spaces, an unknown field is a free word
export function parseQuery(q: string): Term[] {
  const out: Term[] = [];
  for (const m of q.toLowerCase().matchAll(/(-?)(?:(\w+):)?(?:"([^"]*)"|(\S*))/g)) {
    const [, neg, field, quoted, bare] = m;
    const value = quoted ?? bare ?? "";
    // a qualifier still being typed (`cluster:`) filters nothing
    if (field && isQualifier(field)) value && out.push({ field, value, not: neg === "-" });
    else if (value) out.push({ field: null, value: field ? `${field}:${value}` : value, not: neg === "-" });
  }
  return out;
}

function hits(w: Workload, t: Term, now: number): boolean {
  const has = (...xs: string[]) => xs.some((s) => s.toLowerCase().includes(t.value));
  switch (t.field) {
    case "cluster": return has(w.cluster);
    case "ns": return has(w.ns);
    case "group": return has(w.group ?? "");
    case "kind": return has(w.kind);
    case "image": return has(...w.images);
    case "host": return has(...w.hosts);
    case "is": return health(w, now) === (IS_ALIAS[t.value] ?? t.value);
    default: return has(w.name, w.ns, w.cluster, w.group ?? "", ...w.images, ...w.hosts);
  }
}

export const matches = (w: Workload, terms: Term[], now = Date.now()) => terms.every((t) => hits(w, t, now) !== t.not);

export const QUALIFIER_HELP: Record<Qualifier, string> = {
  cluster: "kube context",
  ns: "namespace",
  group: "settings group",
  kind: "Deployment, StatefulSet, DaemonSet, CronJob",
  image: "image name or tag",
  host: "ingress or route host",
  is: "ready, rolled, degraded, down, zero",
};
export const IS_VALUES = ["ready", "rolled", "degraded", "down", "zero"];

export type Values = (field: Qualifier) => string[];
export type Completion = { items: string[]; replace: (item: string) => string };

const quote = (v: string) => (/\s/.test(v) ? `"${v}"` : v);

// completions for the word being typed: qualifiers, then a qualifier's values; `replace` is the text once one is picked
export function complete(text: string, values: Values, limit = 8): Completion {
  const m = text.match(/(-?)([^\s"]*)$/)!;
  const head = text.slice(0, m.index! + m[1].length);
  const word = m[2].toLowerCase();
  const colon = word.indexOf(":");
  const field = colon > 0 ? word.slice(0, colon) : null;
  if (field && isQualifier(field)) {
    const partial = word.slice(colon + 1);
    const items = [...new Set(values(field))].filter((v) => v.toLowerCase().includes(partial) && v.toLowerCase() !== partial).slice(0, limit);
    return { items, replace: (v) => `${head}${field}:${quote(v)} ` };
  }
  const items = word && colon < 0 ? QUALIFIERS.filter((q) => q.startsWith(word) && q !== word).map((q) => `${q}:`) : [];
  return { items, replace: (q) => `${head}${q}` };
}

export type Token = { kind: "key" | "neg" | "value" | "word" | "space"; text: string };

// the query split for highlighting; only a known qualifier is a key, the original text is kept verbatim
export function tokenize(q: string): Token[] {
  const out: Token[] = [];
  for (const m of q.matchAll(/(\s+)|(-?)(?:(\w+):)?("[^"]*"?|\S*)/g)) {
    const [, space, neg, field, rest] = m;
    if (space) out.push({ kind: "space", text: space });
    else if (field && isQualifier(field.toLowerCase())) {
      if (neg) out.push({ kind: "neg", text: neg });
      out.push({ kind: "key", text: `${field}:` });
      if (rest) out.push({ kind: "value", text: rest });
    } else if (neg || field || rest) out.push({ kind: "word", text: `${neg}${field ? `${field}:` : ""}${rest}` });
  }
  return out;
}
