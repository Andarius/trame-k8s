// One column per cluster, workloads grouped by namespace.
import { useState } from "react";
import { openInBrowser } from "@trame/web-api";
import { type ClusterView, unhealthy, type Workload } from "../model.ts";
import { appKey, driftOf, type Ref, tagOf } from "./graph-model.ts";
import { Dot, Logo } from "./Detail.tsx";

const KIND_TAG = { Deployment: null, StatefulSet: "sts", DaemonSet: "ds", CronJob: "cron" } as const;

export default function Columns({ clusters, workloads, onSelect }: {
  clusters: ClusterView[];
  workloads: Workload[];
  onSelect: (r: Ref) => void;
}) {
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const byApp = new Map<string, Workload[]>();
  for (const w of workloads) byApp.set(appKey(w), [...(byApp.get(appKey(w)) ?? []), w]);
  const drifted = new Set<Workload>();
  for (const instances of byApp.values()) for (const [w, off] of driftOf(instances)) if (off) drifted.add(w);

  return (
    <div className="flex h-full min-h-0 gap-px overflow-x-auto bg-line">
      {clusters.map((c) => {
        const own = workloads.filter((w) => w.cluster === c.context);
        const bad = own.filter(unhealthy).length;
        const namespaces = [...new Set(own.map((w) => w.ns))];
        return (
          <section key={c.context} className="flex min-w-[240px] flex-1 flex-col bg-panel">
            <button
              type="button"
              onClick={() => onSelect({ type: "cluster", context: c.context })}
              className="flex items-center gap-1.5 border-b border-line px-3 py-2 text-left hover:bg-card"
            >
              {c.logo ? <Logo src={c.logo} size={14} /> : <span className="text-copper">⎈</span>}
              <span className="truncate text-[13px] font-semibold text-ink">{c.context}</span>
              <span className="ml-auto flex-none text-[10.5px] text-ink-muted">
                {own.length}
                {bad > 0 && <span className="text-blocked"> · {bad} ✕</span>}
              </span>
            </button>
            {c.error && <div className="break-words border-b border-line px-3 py-1.5 text-[10.5px] text-blocked" title={c.error}>{c.error}</div>}
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
              {namespaces.map((ns) => {
                const key = `${c.context}/${ns}`;
                const open = !folded.has(key);
                const inNs = own.filter((w) => w.ns === ns);
                return (
                  <div key={ns}>
                    <button
                      type="button"
                      onClick={() => setFolded((f) => {
                        const next = new Set(f);
                        if (open) next.add(key);
                        else next.delete(key);
                        return next;
                      })}
                      className="mb-1 mt-2.5 flex w-full items-center gap-1 text-[10.5px] font-medium uppercase tracking-[0.8px] text-ink-muted/80 hover:text-ink-soft"
                    >
                      {open ? "▾" : "▸"} {ns}
                      <span className="ml-auto normal-case tracking-normal text-ink-muted/60">
                        {inNs.some(unhealthy) && <span className="mr-1 text-blocked">●</span>}
                        {inNs.length}
                      </span>
                    </button>
                    {open && inNs.map((w) => (
                      <div
                        key={w.name}
                        role="button"
                        tabIndex={0}
                        onClick={() => onSelect({ type: "workload", context: w.cluster, ns: w.ns, name: w.name })}
                        onKeyDown={(e) => e.key === "Enter" && onSelect({ type: "workload", context: w.cluster, ns: w.ns, name: w.name })}
                        className="mb-1 cursor-pointer rounded-lg bg-card px-2 py-1.5 hover:ring-1 hover:ring-chipline"
                      >
                        <div className="flex items-center gap-1.5 text-[12.5px]">
                          <Dot w={w} />
                          <Logo src={w.logo} />
                          <span className="min-w-0 truncate text-ink" title={w.name}>{w.name}</span>
                          {KIND_TAG[w.kind] && <span className="flex-none text-[10px] text-ink-muted">{KIND_TAG[w.kind]}</span>}
                          <span className="ml-auto flex-none text-[10.5px] text-ink-muted">{w.ready}/{w.desired}</span>
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 text-[10.5px]">
                          <span
                            className={`min-w-0 truncate font-mono ${drifted.has(w) ? "text-paused" : "text-ink-muted"}`}
                            title={drifted.has(w) ? "differs from the latest rollout of this app in another cluster" : w.images.join("\n")}
                          >
                            {w.images.map(tagOf).join(", ")}
                          </span>
                          {w.hosts[0] && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                openInBrowser(`https://${w.hosts[0]}`);
                              }}
                              title={w.hosts.join("\n")}
                              className="ml-auto min-w-0 flex-none truncate text-ink-muted hover:text-copper"
                            >
                              ↗ {w.hosts[0].split(".")[0]}{w.hosts.length > 1 ? ` +${w.hosts.length - 1}` : ""}
                            </button>
                          )}
                        </div>
                        {w.reason && unhealthy(w) && <div className="mt-0.5 truncate text-[10.5px] text-ink-soft" title={w.reason}>{w.reason}</div>}
                      </div>
                    ))}
                  </div>
                );
              })}
              {!own.length && !c.error && <div className="px-1 py-3 text-[11.5px] text-ink-muted">Nothing matches.</div>}
            </div>
          </section>
        );
      })}
    </div>
  );
}
