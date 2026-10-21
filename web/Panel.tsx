// Kubernetes panel: the polled snapshot as cluster columns or one of four graphs.
// The backend poller owns freshness; this view re-reads the in-memory snapshot.
import { useEffect, useMemo, useState } from "react";
import { type PanelProps, timeAgo } from "@trame/web-api";
import { type Health, health, isSystem, type Snapshot, unhealthy, type Workload } from "../model.ts";
import { getState, loadPref, refreshState, savePref } from "./api.ts";
import { buildGraph, type GraphView, HEALTH_COLOR, HEALTH_LABEL, type Ref } from "./graph-model.ts";
import Columns from "./Columns.tsx";
import Detail from "./Detail.tsx";
import Graph from "./Graph.tsx";

type View = "columns" | GraphView;
const VIEWS: { id: View; label: string; title: string }[] = [
  { id: "columns", label: "Columns", title: "One column per cluster" },
  { id: "infra", label: "Infra", title: "Cluster → namespace → workload; distance grows with time since rollout" },
  { id: "apps", label: "Apps", title: "Apps shared across clusters; yellow = version differs from the latest rollout" },
  { id: "traffic", label: "Traffic", title: "Hosts → workloads → what their env points at" },
  { id: "capacity", label: "Capacity", title: "Cluster → node → pod; loose red pods are unscheduled" },
];
const STATE_POLL_MS = 15_000;

const pill = (on: boolean) =>
  `rounded-md border px-2 py-0.5 text-[11.5px] ${on ? "border-copper text-copper" : "border-chipline text-ink-soft hover:border-ink-muted"}`;

function matches(w: Workload, q: string): boolean {
  return !q || [w.name, w.ns, w.cluster, w.group ?? "", ...w.images, ...w.hosts].some((s) => s.toLowerCase().includes(q));
}

export function K8sPanel({ onOpenSettings }: Pick<PanelProps, "onOpenSettings">) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<View>(() => loadPref("view", "columns"));
  const [hidden, setHidden] = useState<string[]>(() => loadPref("hidden", []));
  const [system, setSystem] = useState<boolean>(() => loadPref("system", false));
  const [issues, setIssues] = useState(false);
  const [onlyHealth, setOnlyHealth] = useState<Health | null>(null);
  const [onlyGroup, setOnlyGroup] = useState<string | null>(() => loadPref<string | null>("group", null));
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Ref | null>(null);

  useEffect(() => savePref("view", view), [view]);
  useEffect(() => savePref("hidden", hidden), [hidden]);
  useEffect(() => savePref("system", system), [system]);
  useEffect(() => savePref("group", onlyGroup), [onlyGroup]);

  useEffect(() => {
    let alive = true;
    const load = () =>
      getState().then((s) => alive && (setSnap(s), setError(null))).catch((e: Error) => alive && setError(e.message));
    void load();
    const t = setInterval(load, STATE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const refresh = () => {
    setBusy(true);
    refreshState().then(setSnap).catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };

  const all = useMemo(() => snap?.clusters.flatMap((c) => c.workloads) ?? [], [snap]);
  const groups = useMemo(() => [...new Set(all.map((w) => w.group).filter((g): g is string => !!g))].sort(), [all]);
  // a remembered group that no longer exists filters nothing
  const group = onlyGroup && groups.includes(onlyGroup) ? onlyGroup : null;
  const clusters = useMemo(() => snap?.clusters.filter((c) => !hidden.includes(c.context)) ?? [], [snap, hidden]);
  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      clusters.flatMap((c) => c.workloads).filter((w) =>
        (system || !isSystem(w.ns)) && (!issues || unhealthy(w)) && (!group || w.group === group) && matches(w, q)
      ),
    [clusters, system, issues, group, q],
  );
  // legend counts cover the other filters, so a state's count is what clicking it shows
  const healthCount = useMemo(() => {
    const n: Partial<Record<Health, number>> = {};
    for (const w of filtered) n[health(w)] = (n[health(w)] ?? 0) + 1;
    return n;
  }, [filtered]);
  const shown = useMemo(
    () => (onlyHealth ? filtered.filter((w) => health(w) === onlyHealth) : filtered),
    [filtered, onlyHealth],
  );
  const graph = useMemo(() => (view === "columns" ? null : buildGraph(view, clusters, shown)), [view, clusters, shown]);

  if (!snap) {
    return <div className="p-4 text-[12px] text-ink-muted">{error ? `Cannot reach the plugin: ${error}` : "Loading…"}</div>;
  }
  if (!snap.configured) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-[12.5px] text-ink-muted">
        <span className="text-[22px] text-copper">⎈</span>
        <span>No kube context selected yet.</span>
        <button type="button" onClick={onOpenSettings} className="rounded-md bg-copper px-3 py-1 text-[12px] font-medium text-copper-ink">
          Choose contexts
        </button>
      </div>
    );
  }

  const bad = all.filter(unhealthy).length;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
        <div className="mr-2 flex overflow-hidden rounded-md border border-chipline">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              title={v.title}
              onClick={() => setView(v.id)}
              className={`px-2 py-0.5 text-[11.5px] ${view === v.id ? "bg-active-row text-copper" : "text-ink-soft hover:text-ink"}`}
            >
              {v.label}
            </button>
          ))}
        </div>
        {snap.clusters.map((c) => {
          const on = !hidden.includes(c.context);
          return (
            <button
              key={c.context}
              type="button"
              onClick={() => setHidden((h) => (on ? [...h, c.context] : h.filter((x) => x !== c.context)))}
              className={pill(on)}
              title={c.error ?? undefined}
            >
              {c.error && <span className="text-blocked">! </span>}
              {c.context}
            </button>
          );
        })}
        {groups.map((g) => (
          <button
            key={g}
            type="button"
            onClick={() => setOnlyGroup(group === g ? null : g)}
            className={pill(group === g)}
            title={`Only the ${g} group`}
          >
            ◆ {g}
          </button>
        ))}
        <button type="button" onClick={() => setSystem(!system)} className={pill(system)} title="Show kube-system, cert-manager, argocd, …">
          system ns
        </button>
        <button type="button" onClick={() => setIssues(!issues)} className={pill(issues)} title="Only degraded and down workloads">
          issues{bad ? ` · ${bad}` : ""}
        </button>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="⌕ filter name, image, host…"
          className="min-w-[160px] flex-1 rounded-md border border-chipline bg-panel px-2 py-0.5 text-[12px] text-ink outline-none placeholder:text-ink-muted focus:border-copper"
        />
        <span className="ml-auto flex items-center gap-1.5 text-[10.5px] text-ink-muted">
          {snap.polledAt && <span>{timeAgo(snap.polledAt)}</span>}
          <button type="button" onClick={refresh} disabled={busy} className="rounded-md border border-line px-1.5 py-0.5 hover:border-chipline disabled:opacity-50" title="Poll the clusters now">
            {busy ? "…" : "↻"}
          </button>
          <button type="button" onClick={onOpenSettings} className="rounded-md border border-line px-1.5 py-0.5 hover:border-chipline" title="Settings">
            ⚙︎
          </button>
        </span>
      </div>
      <div className="relative min-h-0 flex-1">
        {view === "columns"
          ? <Columns clusters={clusters} workloads={shown} onSelect={setSelected} />
          : <Graph graph={graph!} viewKey={view} onSelect={setSelected} />}
        {selected && (
          <Detail selected={selected} clusters={snap.clusters} workloads={all} onSelect={setSelected} onClose={() => setSelected(null)} />
        )}
      </div>
      <div className="flex flex-wrap gap-3 border-t border-line px-3 py-1.5 text-[10.5px] text-ink-muted">
        {(Object.keys(HEALTH_LABEL) as (keyof typeof HEALTH_LABEL)[]).map((h) => (
          <button
            key={h}
            type="button"
            onClick={() => setOnlyHealth(onlyHealth === h ? null : h)}
            title={onlyHealth === h ? "Show every state" : `Only ${HEALTH_LABEL[h].toLowerCase()}`}
            className={`inline-flex items-center gap-1 whitespace-nowrap rounded px-1 -mx-1 ${
              onlyHealth === h ? "bg-active-row text-copper" : onlyHealth ? "opacity-50 hover:opacity-100" : "hover:text-ink"
            }`}
          >
            <span
              className="inline-block size-[7px] rounded-full"
              style={h === "zero" ? { boxShadow: `inset 0 0 0 1.5px ${HEALTH_COLOR[h]}` } : { background: HEALTH_COLOR[h] }}
            />
            {HEALTH_LABEL[h]}
            <span className="tabular-nums text-ink-muted/80">{healthCount[h] ?? 0}</span>
          </button>
        ))}
        {view !== "columns" && <span className="whitespace-nowrap">scroll to zoom · drag · click to peek</span>}
        <span className="ml-auto whitespace-nowrap">{shown.length} workloads</span>
      </div>
    </div>
  );
}
