// The sidebar column beside the rail: clusters to show, group, and the two toggles.
import { type ReactNode, useState } from "react";
import type { ClusterView, Workload } from "../model.ts";
import { Logo } from "./Detail.tsx";
import Matches from "./Matches.tsx";
import PatternInput from "./PatternInput.tsx";

const SECTION = "px-2 pb-1 pt-3 text-[10.5px] font-medium tracking-[0.8px] text-ink-muted/70";

function Row({ active, dim, onClick, title, children, count }: {
  active?: boolean;
  dim?: boolean;
  onClick: () => void;
  title?: string;
  children: ReactNode;
  count?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] ${
        active ? "bg-active-row font-medium text-ink" : dim ? "text-ink-muted/60 line-through hover:text-ink-soft" : "text-ink-muted hover:text-ink-soft"
      }`}
    >
      {children}
      {count !== undefined && <span className="ml-auto rounded-full bg-copper/12 px-1.5 text-[10px] tabular-nums text-copper">{count}</span>}
    </button>
  );
}

export type SideProps = {
  clusters: ClusterView[];
  hidden: string[];
  onToggleCluster: (context: string) => void;
  clusterCount: (context: string) => number;
  groups: string[];
  group: string | null;
  onGroup: (g: string | null) => void;
  groupCount: (g: string | null) => number;
  system: boolean;
  onSystem: () => void;
  issues: boolean;
  onIssues: () => void;
  bad: number;
  // saves a group from the inline form; resolves to what the host refused, if anything
  onAddGroup: (name: string, patterns: string[]) => Promise<string[]>;
  workloads: Workload[]; // for the form's match preview
};

const INPUT = "w-full rounded-md border border-chipline bg-panel px-2.5 py-1.5 text-[12.5px] text-ink outline-none placeholder:text-ink-muted focus:border-copper";

function AddGroup({ onAdd, onClose, workloads }: { onAdd: SideProps["onAddGroup"]; onClose: () => void; workloads: Workload[] }) {
  const [name, setName] = useState("");
  const [patterns, setPatterns] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const ps = patterns.split(",").map((x) => x.trim()).filter(Boolean);
  const submit = async () => {
    if (!name.trim() || !ps.length) return setNote("A name and at least one pattern");
    const dropped = await onAdd(name.trim(), ps).catch((e: Error) => [e.message]);
    if (dropped.length) setNote(`Ignored: ${dropped.join(", ")}`);
    else onClose();
  };
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") void submit();
    else if (e.key === "Escape") onClose();
  };
  return (
    // a fixed overlay from inside the sidebar: the plugin cannot portal, and the host's Modal is not in its API
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 pt-[16vh]" onClick={onClose}>
      <div
        role="dialog"
        aria-label="New group"
        className="flex w-[400px] flex-col gap-2.5 rounded-xl border border-overlay-border bg-panel-modal p-5 shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[14px] font-semibold text-ink">New group</div>
        <p className="text-[11.5px] text-ink-muted">
          Patterns are shaped like <code>name</code>, <code>ns/name</code> or <code>context/ns/name</code>; <code>*</code> matches within a segment.
          The first matching group wins.
        </p>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={keys} placeholder="name" className={INPUT} />
        <PatternInput
          value={patterns}
          onChange={setPatterns}
          workloads={workloads}
          onKeyDown={keys}
          placeholder="patterns: ns/*, name, ctx/ns/name"
          className={`${INPUT} font-mono`}
        />
        <Matches patterns={ps} workloads={workloads} />
        <div className="mt-1 flex items-center gap-2">
          {note && <span className="min-w-0 truncate text-[11px] text-ink-muted" title={note}>{note}</span>}
          <button type="button" onClick={onClose} className="ml-auto rounded-md px-2.5 py-1 text-[12px] text-ink-muted hover:text-ink">Cancel</button>
          <button type="button" onClick={() => void submit()} className="rounded-md bg-copper px-3 py-1 text-[12px] font-medium text-copper-ink">Add</button>
        </div>
      </div>
    </div>
  );
}

export default function Side(p: SideProps) {
  const [adding, setAdding] = useState(false);
  return (
    <>
      <nav aria-label="Clusters" className="flex flex-col gap-0.5">
        <div className={SECTION}>CLUSTERS</div>
        {p.clusters.map((c) => {
          const on = !p.hidden.includes(c.context);
          return (
            <Row
              key={c.context}
              dim={!on}
              onClick={() => p.onToggleCluster(c.context)}
              title={c.error ?? (on ? "Hide this cluster" : "Show this cluster")}
              count={on ? p.clusterCount(c.context) : undefined}
            >
              {c.logo ? <Logo src={c.logo} size={14} /> : <span className="w-[14px] text-center text-copper">⎈</span>}
              <span className="min-w-0 flex-1 truncate">{c.context}</span>
              {c.error && <span className="text-blocked">!</span>}
            </Row>
          );
        })}
      </nav>
      <nav aria-label="Groups" className="flex flex-col gap-0.5">
        <div className={`flex items-center ${SECTION}`}>
          GROUPS
          <button
            type="button"
            onClick={() => setAdding(true)}
            title="New group: a name and patterns like ns/* or name"
            className="ml-auto rounded px-1 text-[13px] leading-none text-ink-muted hover:bg-active-row hover:text-ink"
          >
            +
          </button>
        </div>
        {adding && <AddGroup onAdd={p.onAddGroup} onClose={() => setAdding(false)} workloads={p.workloads} />}
        {p.groups.length > 0 &&
          [null, ...p.groups].map((g) => (
            <Row key={g ?? "__all"} active={p.group === g} onClick={() => p.onGroup(g)} count={p.groupCount(g)}>
              {g && <span className="text-[color:var(--color-chart-5)]">◆</span>}
              <span className="min-w-0 flex-1 truncate">{g ?? "All"}</span>
            </Row>
          ))}
      </nav>
      <nav aria-label="Filters" className="flex flex-col gap-0.5">
        <div className={SECTION}>SHOW</div>
        <Row active={p.system} onClick={p.onSystem} title="kube-system, cert-manager, argocd, …">
          <span className="w-[14px] text-center">{p.system ? "☑" : "☐"}</span>
          <span className="min-w-0 flex-1 truncate">System namespaces</span>
        </Row>
        <Row active={p.issues} onClick={p.onIssues} title="Only degraded and down workloads" count={p.bad || undefined}>
          <span className="w-[14px] text-center">{p.issues ? "☑" : "☐"}</span>
          <span className="min-w-0 flex-1 truncate">Issues only</span>
        </Row>
      </nav>
    </>
  );
}
