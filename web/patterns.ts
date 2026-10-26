import type { Workload } from "../model.ts";

const LIMIT = 8;

// candidates for the last comma-separated item, and the text once one is picked
export function completePattern(text: string, workloads: Workload[]): { items: string[]; replace: (item: string) => string } {
  const at = text.lastIndexOf(",");
  const head = at < 0 ? "" : text.slice(0, at + 1) + " ";
  const word = text.slice(at + 1).trim().toLowerCase();
  if (!word) return { items: [], replace: (v) => `${head}${v}` };
  const ns = [...new Set(workloads.map((w) => w.ns))].sort().map((n) => `${n}/*`);
  const apps = [...new Set(workloads.map((w) => `${w.ns}/${w.name}`))].sort();
  const items = [...ns, ...apps].filter((c) => c.toLowerCase().includes(word) && c.toLowerCase() !== word).slice(0, LIMIT);
  return { items, replace: (v) => `${head}${v}` };
}
