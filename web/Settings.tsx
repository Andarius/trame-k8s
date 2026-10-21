// Kubernetes settings: which contexts to poll (nothing is polled until one is ticked), cadence, logos, groups.
import { type ReactNode, useEffect, useState } from "react";
import { getPluginSettings, savePluginSettings } from "@trame/web-api";
import { SLUG_RE, type Workload } from "../model.ts";
import { getState, listContexts, refreshState } from "./api.ts";
import { Logo } from "./Detail.tsx";
import Matches from "./Matches.tsx";
import PatternInput from "./PatternInput.tsx";

type Slice = {
  contexts: string[];
  pollSeconds: number;
  kubectl: string;
  autoLogos: boolean;
  logos: Record<string, string>;
  groups: Record<string, string[]>;
};
const DEFAULTS: Slice = { contexts: [], pollSeconds: 60, kubectl: "kubectl", autoLogos: true, logos: {}, groups: {} };

const input = "rounded-md border border-line bg-panel px-2.5 py-1.5 text-[11.5px] text-ink outline-none focus:border-chipline";
const label = "mb-1.5 mt-4 text-[10.5px] font-medium uppercase tracking-[0.8px] text-ink-muted/80";

type Row = { key: string; value: string };
const rowsOf = (o: Record<string, string | string[]>): Row[] =>
  Object.entries(o).map(([key, v]) => ({ key, value: Array.isArray(v) ? v.join(", ") : v }));
const splitPatterns = (text: string) => text.split(",").map((x) => x.trim()).filter(Boolean);
// a slug previews through the icon cache; a URL straight from the browser until it is saved, then through the host
function logoPreview(key: string, value: string, saved: Record<string, string>): string | null {
  if (SLUG_RE.test(value)) return `/api/plugins/k8s/icon/${value}`;
  if (value.startsWith("https://")) return saved[key] === value ? `/api/plugins/k8s/logo?key=${encodeURIComponent(key)}` : value;
  return null;
}

function Rows({ rows, onChange, keyHint, valueHint, extra, workloads, complete }: {
  rows: Row[];
  onChange: (rows: Row[]) => void;
  keyHint: string;
  valueHint: string;
  extra: (row: Row) => ReactNode;
  workloads: Workload[];
  complete: "key" | "value"; // which column holds patterns
}) {
  const set = (i: number, patch: Partial<Row>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const cls = `${input} w-full font-mono`;
  return (
    <div className="flex flex-col gap-1">
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[minmax(120px,1fr)_minmax(140px,1.4fr)_minmax(0,1fr)_auto] items-center gap-1.5">
          {complete === "key"
            ? <PatternInput value={r.key} onChange={(key) => set(i, { key })} workloads={workloads} placeholder={keyHint} className={cls} />
            : <input value={r.key} onChange={(e) => set(i, { key: e.target.value })} placeholder={keyHint} className={cls} />}
          {complete === "value"
            ? <PatternInput value={r.value} onChange={(value) => set(i, { value })} workloads={workloads} placeholder={valueHint} className={cls} />
            : <input value={r.value} onChange={(e) => set(i, { value: e.target.value })} placeholder={valueHint} className={cls} />}
          <div className="flex min-w-0 items-center gap-1.5">{extra(r)}</div>
          <button type="button" onClick={() => onChange(rows.filter((_, j) => j !== i))} title="Remove" className="px-1 text-ink-muted hover:text-blocked">✕</button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...rows, { key: "", value: "" }])} className="self-start rounded-md border border-line px-2 py-0.5 text-[11px] text-ink-muted hover:border-chipline">
        + Add
      </button>
    </div>
  );
}

export function K8sSettings() {
  const [slice, setSlice] = useState<Slice | null>(null);
  const [available, setAvailable] = useState<string[]>([]);
  const [contextError, setContextError] = useState<string | null>(null);
  const [logoRows, setLogoRows] = useState<Row[]>([]);
  const [groupRows, setGroupRows] = useState<Row[]>([]);
  const [workloads, setWorkloads] = useState<Workload[]>([]);
  const [groupStatus, setGroupStatus] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const loadContexts = () =>
    listContexts().then((r) => {
      setAvailable(r.contexts);
      setContextError(r.error ?? null);
    }).catch((e: Error) => setContextError(e.message));

  useEffect(() => {
    void getPluginSettings("k8s").then((raw) => {
      const s = { ...DEFAULTS, ...raw } as Slice;
      setSlice(s);
      setLogoRows(rowsOf(s.logos));
      setGroupRows(rowsOf(s.groups));
    });
    void loadContexts();
    void getState().then((snap) => setWorkloads(snap.clusters.flatMap((c) => c.workloads))).catch(() => {});
  }, []);

  if (!slice) return <div className="p-4 text-[12px] text-ink-muted">Loading…</div>;

  const save = async (patch: Partial<Slice>) => {
    const next = { ...DEFAULTS, ...(await savePluginSettings("k8s", patch)) } as Slice;
    setSlice(next);
    return next;
  };
  const toggle = (ctx: string) => {
    const contexts = slice.contexts.includes(ctx) ? slice.contexts.filter((c) => c !== ctx) : [...slice.contexts, ctx];
    void save({ contexts }).then(() => refreshState().catch(() => null));
  };
  const saveLogos = async () => {
    const wanted: Record<string, string> = Object.fromEntries(logoRows.map((r) => [r.key.trim(), r.value.trim()]).filter(([k, v]) => k && v));
    const next = await save({ logos: wanted });
    const dropped = Object.keys(wanted).filter((k) => !(k in next.logos));
    setLogoRows(rowsOf(next.logos));
    setStatus(dropped.length ? `Ignored (need a simple-icons slug or an https URL): ${dropped.join(", ")}` : "Saved");
  };
  const saveGroups = async () => {
    const wanted: Record<string, string[]> = Object.fromEntries(
      groupRows.map((r): [string, string[]] => [r.key.trim(), splitPatterns(r.value)]).filter(([k, ps]) => k && ps.length),
    );
    const next = await save({ groups: wanted });
    const kept = new Set(Object.entries(next.groups).flatMap(([g, ps]) => ps.map((p) => `${g}=${p}`)));
    const dropped = Object.entries(wanted).flatMap(([g, ps]) => ps.filter((p) => !kept.has(`${g}=${p}`)).map((p) => `${g}: ${p}`));
    setGroupRows(rowsOf(next.groups));
    setGroupStatus(dropped.length ? `Ignored: ${dropped.join(", ")}` : "Saved");
  };
  // contexts saved earlier but gone from the kubeconfig stay listed, so they can be unticked
  const shown = [...new Set([...available, ...slice.contexts])];

  return (
    <div className="text-[12px] text-ink-soft">
      <div className={label}>Contexts to poll</div>
      <p className="mb-2 text-[11.5px] text-ink-muted">
        Read with <code>kubectl get</code> using your kubeconfig. Nothing is polled until a context is ticked.
      </p>
      {contextError && <div className="mb-2 break-words text-[11.5px] text-blocked">{contextError}</div>}
      <div className="grid gap-1">
        {shown.map((ctx) => (
          <label key={ctx} className="flex cursor-pointer items-center gap-2">
            <input type="checkbox" checked={slice.contexts.includes(ctx)} onChange={() => toggle(ctx)} className="accent-[var(--color-copper)]" />
            <span className="font-mono text-[11.5px]">{ctx}</span>
            {!available.includes(ctx) && <span className="text-[10.5px] text-ink-muted">not in kubeconfig</span>}
          </label>
        ))}
      </div>
      <button type="button" onClick={() => void loadContexts()} className="mt-2 rounded-md border border-line px-2 py-0.5 text-[11px] text-ink-muted hover:border-chipline">
        ↻ Reload contexts
      </button>

      <div className={label}>Polling</div>
      <div className="flex flex-wrap items-center gap-2">
        <span>Every</span>
        <input
          type="number"
          min={15}
          max={3600}
          defaultValue={slice.pollSeconds}
          onBlur={(e) => void save({ pollSeconds: Number(e.target.value) })}
          className={`${input} w-20`}
        />
        <span>seconds, with</span>
        <input
          defaultValue={slice.kubectl}
          onBlur={(e) => void save({ kubectl: e.target.value.trim() })}
          className={`${input} w-56 font-mono`}
          title="kubectl, or an absolute path when the app's PATH lacks it"
        />
      </div>

      <div className={label}>Logos</div>
      <label className="flex cursor-pointer items-center gap-2">
        <input type="checkbox" checked={slice.autoLogos} onChange={() => void save({ autoLogos: !slice.autoLogos })} className="accent-[var(--color-copper)]" />
        Guess logos from image names (postgres, redis, grafana, argo…), fetched once from simple-icons
      </label>
      <p className="mb-1.5 mt-2 text-[11.5px] text-ink-muted">
        Overrides: a key (<code>name</code>, <code>ns/name</code>, <code>context/ns/name</code> or a context, <code>*</code> within a segment) and a{" "}
        simple-icons slug or an https image URL. An exact key wins over a pattern. A workload can also carry a{" "}
        <code>trame.dev/logo: &lt;slug&gt;</code> annotation.
      </p>
      <Rows
        rows={logoRows}
        onChange={setLogoRows}
        keyHint="langfuse/langfuse-*"
        valueHint="slug or https://…"
        workloads={workloads}
        complete="key"
        extra={(r) => (
          <>
            <Logo src={logoPreview(r.key.trim(), r.value.trim(), slice.logos)} size={16} />
            <Matches patterns={r.key.trim() ? [r.key.trim()] : []} workloads={workloads} />
          </>
        )}
      />
      <div className="mt-1.5 flex items-center gap-2">
        <button type="button" onClick={() => void saveLogos()} className="rounded-md bg-copper px-2.5 py-1 text-[11.5px] font-medium text-copper-ink">
          Save logos
        </button>
        {status && <span className="text-[11px] text-ink-muted">{status}</span>}
      </div>

      <div className={label}>Groups</div>
      <p className="mb-1.5 text-[11.5px] text-ink-muted">
        A name and comma-separated patterns shaped like logo keys (<code>name</code>, <code>ns/name</code>,{" "}
        <code>context/ns/name</code>), where <code>*</code> matches within a segment. The first matching group wins.
        A workload can also carry a <code>trame.dev/group: &lt;name&gt;</code> annotation.
      </p>
      <Rows
        rows={groupRows}
        onChange={setGroupRows}
        keyHint="ai"
        valueHint="langfuse/*, litellm/*, ai-*/*"
        workloads={workloads}
        complete="value"
        extra={(r) => <Matches patterns={splitPatterns(r.value)} workloads={workloads} />}
      />
      <div className="mt-1.5 flex items-center gap-2">
        <button type="button" onClick={() => void saveGroups()} className="rounded-md bg-copper px-2.5 py-1 text-[11.5px] font-medium text-copper-ink">
          Save groups
        </button>
        {groupStatus && <span className="text-[11px] text-ink-muted">{groupStatus}</span>}
      </div>
    </div>
  );
}
