import { expect, test } from "bun:test";
import type { Workload } from "./model.ts";
import { complete, matches, parseQuery, tokenize } from "./web/search.ts";
import { completePattern } from "./web/PatternInput.tsx";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const w = (over: Partial<Workload>): Workload => ({
  cluster: "saas-prod", ns: "langfuse", name: "langfuse-web", kind: "Deployment", desired: 2, ready: 2, images: ["ghcr.io/langfuse/web:4.15.0"],
  rolledAt: "2026-10-19T12:00:00Z", services: [], hosts: ["langfuse.example.com"], deps: [], pods: [], reason: null, restarts: 0,
  failed: false, logoHint: null, tech: [], logo: null, groupHint: null, group: "ai", ...over,
});

test.each([
  { id: "free words", q: "Lang web", want: [{ field: null, value: "lang", not: false }, { field: null, value: "web", not: false }] },
  { id: "qualifier and negation", q: "cluster:prod -ns:kube-system", want: [{ field: "cluster", value: "prod", not: false }, { field: "ns", value: "kube-system", not: true }] },
  { id: "quoted value keeps spaces", q: 'host:"my host" "a b"', want: [{ field: "host", value: "my host", not: false }, { field: null, value: "a b", not: false }] },
  { id: "unknown field is a free word", q: "foo:bar", want: [{ field: null, value: "foo:bar", not: false }] },
  { id: "empty", q: "   ", want: [] },
  { id: "qualifier without a value filters nothing", q: "web cluster:", want: [{ field: null, value: "web", not: false }] },
])("parseQuery: $id", ({ q, want }) => {
  expect(parseQuery(q)).toEqual(want);
});

test.each([
  { id: "free word across fields", q: "ghcr", over: {}, want: true },
  { id: "every term must hit", q: "langfuse missing", over: {}, want: false },
  { id: "cluster", q: "cluster:prod", over: {}, want: true },
  { id: "cluster miss", q: "cluster:dev", over: {}, want: false },
  { id: "negated ns", q: "-ns:langfuse", over: {}, want: false },
  { id: "group", q: "group:ai", over: {}, want: true },
  { id: "kind", q: "kind:cron", over: { kind: "CronJob" }, want: true },
  { id: "image", q: "image:4.15", over: {}, want: true },
  { id: "host", q: "host:example", over: {}, want: true },
  { id: "tech by tool prefix", q: "tech:postgres", over: { tech: ["postgresql", "db", "sql"] }, want: true },
  { id: "tech by kind", q: "tech:db", over: { tech: ["redis", "db", "cache"] }, want: true },
  { id: "tech miss", q: "tech:db", over: { tech: ["nginx", "proxy"] }, want: false },
  { id: "is:ready", q: "is:ready", over: {}, want: true },
  { id: "is:down", q: "is:down", over: { ready: 0 }, want: true },
  { id: "is:degraded alias", q: "is:degraded", over: { ready: 1 }, want: true },
  { id: "-is:ready", q: "-is:ready", over: {}, want: false },
])("matches: $id", ({ q, over, want }) => {
  expect(matches(w(over), parseQuery(q), NOW)).toBe(want);
});

const VALUES = (f: string) => ({ cluster: ["saas-dev", "saas-prod"], ns: ["ai kit", "langfuse"], is: ["ready", "down"] })[f] ?? [];

test.each([
  { id: "qualifiers for a word", text: "web cl", items: ["cluster:"], pick: "cluster:", want: "web cluster:" },
  { id: "values after the colon", text: "cluster:pr", items: ["saas-prod"], pick: "saas-prod", want: "cluster:saas-prod " },
  { id: "negation kept, value with spaces quoted", text: "-ns:ai", items: ["ai kit"], pick: "ai kit", want: '-ns:"ai kit" ' },
  { id: "complete value offers nothing", text: "is:ready", items: [], pick: null, want: null },
  { id: "unknown field offers nothing", text: "foo:ba", items: [], pick: null, want: null },
  { id: "nothing on a blank after words", text: "web ", items: [], pick: null, want: null },
  { id: "every qualifier in an empty box", text: "", items: ["cluster:", "ns:", "group:", "kind:", "image:", "host:", "tech:", "is:"], pick: "group:", want: "group:" },
])("complete: $id", ({ text, items, pick, want }) => {
  const c = complete(text, VALUES as never);
  expect(c.items).toEqual(items);
  if (pick) expect(c.replace(pick)).toBe(want);
});

test.each([
  { id: "key, value and words", q: "web cluster:prod", want: [["word", "web"], ["space", " "], ["key", "cluster:"], ["value", "prod"]] },
  { id: "negation and quoted value", q: '-ns:"a b"', want: [["neg", "-"], ["key", "ns:"], ["value", '"a b"']] },
  { id: "unknown key stays a word", q: "foo:bar", want: [["word", "foo:bar"]] },
  { id: "key being typed", q: "is:", want: [["key", "is:"]] },
])("tokenize: $id", ({ q, want }) => {
  expect(tokenize(q).map((t) => [t.kind, t.text])).toEqual(want);
});

test.each([
  { id: "namespaces first, then apps", text: "lang", items: ["langfuse/*", "langfuse/langfuse-web"], pick: "langfuse/*", want: "langfuse/*" },
  { id: "completes the last item only", text: "litellm/*, lang", items: ["langfuse/*", "langfuse/langfuse-web"], pick: "langfuse/*", want: "litellm/*, langfuse/*" },
  { id: "nothing on a blank item", text: "litellm/*, ", items: [], pick: null, want: null },
])("completePattern: $id", ({ text, items, pick, want }) => {
  const c = completePattern(text, [w({}), w({ ns: "litellm", name: "litellm" })]);
  expect(c.items).toEqual(items);
  if (pick) expect(c.replace(pick)).toBe(want);
});
