// What a key or pattern list catches, from the last snapshot: a count, the first names, every name on hover.
import { matchesKey, type Workload } from "../model.ts";

export default function Matches({ patterns, workloads }: { patterns: string[]; workloads: Workload[] }) {
  const hit = [...new Set(workloads.filter((w) => patterns.some((p) => matchesKey(w, p))).map((w) => `${w.ns}/${w.name}`))];
  if (!patterns.length) return null;
  return (
    <span className="min-w-0 truncate text-[10.5px] text-ink-muted" title={hit.join("\n")}>
      {hit.length ? `${hit.length} · ${hit.slice(0, 3).join(", ")}${hit.length > 3 ? ` +${hit.length - 3}` : ""}` : "no workload matches"}
    </span>
  );
}
