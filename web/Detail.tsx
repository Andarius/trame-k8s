// The peek panel: whatever a click on a column row or a graph node points at.
import { type ReactNode, useState } from "react";
import { openInBrowser } from "@trame/web-api";
import { type ClusterView, health, type Workload } from "../model.ts";
import { ago, appKey, driftOf, HEALTH_COLOR, HEALTH_LABEL, type Ref, tagOf } from "./graph-model.ts";

const SHORT_KIND = { Deployment: "deploy", StatefulSet: "sts", DaemonSet: "ds", CronJob: "cronjob" } as const;

export function Dot({ w }: { w: Workload }) {
  const h = health(w);
  return (
    <span
      title={HEALTH_LABEL[h]}
      className="inline-block size-[7px] flex-none rounded-full"
      style={h === "zero" ? { boxShadow: `inset 0 0 0 1.5px ${HEALTH_COLOR[h]}` } : { background: HEALTH_COLOR[h] }}
    />
  );
}

export function Logo({ src, size = 13 }: { src: string | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) return <span style={{ width: size }} className="flex-none text-center text-ink-muted/60">◌</span>;
  return <img src={src} width={size} height={size} alt="" className="flex-none" onError={() => setBroken(true)} />;
}

function Copy({ label, text }: { label: string; text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title={text}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
      className="rounded-md border border-chipline px-1.5 py-0.5 text-[11px] text-ink-muted hover:border-copper hover:text-copper"
    >
      {done ? "✓ copied" : `⧉ ${label}`}
    </button>
  );
}

const Label = ({ children }: { children: string }) => (
  <div className="mb-1 mt-3 text-[10.5px] font-medium uppercase tracking-[0.8px] text-ink-muted/80">{children}</div>
);

function Row({ w, onSelect, right }: { w: Workload; onSelect: (r: Ref) => void; right?: string }) {
  return (
    <button
      type="button"
      onClick={() => onSelect({ type: "workload", context: w.cluster, ns: w.ns, name: w.name })}
      className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] hover:bg-card"
    >
      <Dot w={w} />
      <Logo src={w.logo} size={12} />
      <span className="min-w-0 truncate text-ink">{w.name}</span>
      <span className="ml-auto flex-none font-mono text-[10.5px] text-ink-muted">{right ?? `${w.ready}/${w.desired}`}</span>
    </button>
  );
}

function WorkloadDetail({ w, all, onSelect }: { w: Workload; all: Workload[]; onSelect: (r: Ref) => void }) {
  const h = health(w);
  const target = `${SHORT_KIND[w.kind]}/${w.name}`;
  const base = `kubectl --context=${w.cluster} -n ${w.ns}`;
  const same = all.filter((x) => x.cluster === w.cluster);
  const deps = w.deps.map((d) => same.find((x) => appKey(x) === d)).filter((x): x is Workload => !!x);
  const users = same.filter((x) => x.deps.includes(appKey(w)));
  const elsewhere = all.filter((x) => appKey(x) === appKey(w) && x.cluster !== w.cluster);
  return (
    <>
      <div className="flex items-center gap-2">
        <Logo src={w.logo} size={18} />
        <span className="truncate text-[14px] font-semibold text-ink">{w.name}</span>
      </div>
      <div className="text-[10.5px] text-ink-muted">{w.cluster} / {w.ns} · {w.kind}</div>
      <div className="mt-3 grid grid-cols-[84px_1fr] gap-x-3 gap-y-1 text-[12px]">
        <span className="text-ink-muted">State</span>
        <span style={{ color: HEALTH_COLOR[h] }}>{HEALTH_LABEL[h]} · {w.ready}/{w.desired}</span>
        {w.reason && (
          <>
            <span className="text-ink-muted">Why</span>
            <span className="break-words text-ink-soft">{w.reason}</span>
          </>
        )}
        <span className="text-ink-muted">{w.kind === "CronJob" ? "Last run" : "Rolled out"}</span>
        <span className="text-ink-soft">{ago(w.rolledAt)} ago</span>
        <span className="text-ink-muted">Restarts</span>
        <span className="text-ink-soft">{w.restarts}</span>
        {w.services.map((s) => (
          <span key={s.name} className="contents">
            <span className="text-ink-muted">Service</span>
            <span className="text-ink-soft">{s.name} <span className="text-ink-muted">{s.type} :{s.ports.join(",")}</span></span>
          </span>
        ))}
      </div>
      <Label>Images</Label>
      {w.images.map((i) => <div key={i} className="break-all font-mono text-[11px] text-ink-soft">{i}</div>)}
      {w.hosts.length > 0 && (
        <>
          <Label>Hosts</Label>
          {w.hosts.map((host) => (
            <button key={host} type="button" onClick={() => openInBrowser(`https://${host}`)} className="block text-left text-[12px] text-ink-soft hover:text-copper">
              {host} ↗
            </button>
          ))}
        </>
      )}
      {elsewhere.length > 0 && (
        <>
          <Label>Other clusters</Label>
          {elsewhere.map((x) => <Row key={x.cluster} w={x} onSelect={onSelect} right={`${x.cluster} · ${x.images.map(tagOf).join(",")}`} />)}
        </>
      )}
      {deps.length > 0 && (
        <>
          <Label>Talks to (from env)</Label>
          {deps.map((x) => <Row key={appKey(x)} w={x} onSelect={onSelect} />)}
        </>
      )}
      {users.length > 0 && (
        <>
          <Label>{`Used by · ${users.length}`}</Label>
          {users.map((x) => <Row key={appKey(x)} w={x} onSelect={onSelect} />)}
        </>
      )}
      <Label>{`Pods · ${w.pods.length}`}</Label>
      {w.pods.map((p) => (
        <div key={p.name} className="mb-1 rounded-md border border-line px-2 py-1">
          <div className="flex items-center gap-2 font-mono text-[11px] text-ink-soft">
            <span className="inline-block size-[7px] rounded-full" style={{ background: p.ready ? HEALTH_COLOR.ok : p.reason ? HEALTH_COLOR.down : HEALTH_COLOR.deg }} />
            <span className="truncate">{p.name}</span>
          </div>
          <div className="text-[10.5px] text-ink-muted">{p.phase} · {p.node ?? "not scheduled"} · {p.restarts} restarts</div>
          {p.reason && <div className="break-words text-[10.5px] text-ink-soft">{p.reason}</div>}
        </div>
      ))}
      <Label>Commands</Label>
      <div className="flex flex-wrap gap-1">
        <Copy label="logs" text={`${base} logs ${target} --tail=200`} />
        <Copy label="describe" text={`${base} describe ${target}`} />
        <Copy label="events" text={`${base} events --for ${target}`} />
        {w.kind !== "CronJob" && <Copy label="rollout restart" text={`${base} rollout restart ${target}`} />}
      </div>
    </>
  );
}

export default function Detail({ selected, clusters, workloads, onSelect, onClose }: {
  selected: Ref;
  clusters: ClusterView[];
  workloads: Workload[]; // every workload, unfiltered: a peek may lead outside the current filter
  onSelect: (r: Ref) => void;
  onClose: () => void;
}) {
  let body: ReactNode = <div className="text-[12px] text-ink-muted">Gone from the last poll.</div>;
  if (selected.type === "workload") {
    const w = workloads.find((x) => x.cluster === selected.context && x.ns === selected.ns && x.name === selected.name);
    if (w) body = <WorkloadDetail w={w} all={workloads} onSelect={onSelect} />;
  } else if (selected.type === "cluster" || selected.type === "ns") {
    const c = clusters.find((x) => x.context === selected.context);
    const own = workloads.filter((w) => w.cluster === selected.context && (selected.type === "cluster" || w.ns === selected.ns));
    const bad = own.filter((w) => ["deg", "down"].includes(health(w)));
    if (c) {
      body = (
        <>
          <div className="flex items-center gap-2">
            {selected.type === "cluster" ? <Logo src={c.logo} size={18} /> : null}
            <span className="text-[14px] font-semibold text-ink">{selected.type === "ns" ? selected.ns : c.context}</span>
          </div>
          <div className="text-[10.5px] text-ink-muted">
            {selected.type === "ns" ? `${c.context} · ` : `${c.provider ?? "unknown provider"} · ${c.nodes.length} nodes · `}
            {own.length} workloads · polled {ago(c.polledAt)} ago
          </div>
          {c.error && <div className="mt-2 break-words text-[11.5px] text-blocked">{c.error}</div>}
          {bad.length > 0 && (
            <>
              <Label>{`Unhealthy · ${bad.length}`}</Label>
              {bad.map((w) => <Row key={`${w.ns}/${w.name}`} w={w} onSelect={onSelect} />)}
            </>
          )}
          <Label>Workloads</Label>
          {own.map((w) => <Row key={`${w.ns}/${w.name}`} w={w} onSelect={onSelect} right={selected.type === "cluster" ? w.ns : undefined} />)}
        </>
      );
    }
  } else if (selected.type === "app") {
    const instances = workloads.filter((w) => appKey(w) === selected.app);
    const drift = driftOf(instances);
    body = (
      <>
        <div className="text-[14px] font-semibold text-ink">{selected.app}</div>
        <div className="text-[10.5px] text-ink-muted">
          {[...drift.values()].some(Boolean) ? "versions differ across clusters" : "same version everywhere"}
        </div>
        <Label>Instances</Label>
        {instances.map((w) => (
          <div key={w.cluster} className={drift.get(w) ? "[&_.font-mono]:text-paused" : ""}>
            <Row w={w} onSelect={onSelect} right={`${w.cluster} · ${w.images.map(tagOf).join(",")}`} />
          </div>
        ))}
      </>
    );
  } else if (selected.type === "node") {
    const c = clusters.find((x) => x.context === selected.context);
    const n = c?.nodes.find((x) => x.name === selected.node);
    const on = workloads.filter((w) => w.cluster === selected.context && w.pods.some((p) => p.node === selected.node));
    if (n) {
      const pct = (a: { req: number; alloc: number }) => (a.alloc ? Math.round((a.req / a.alloc) * 100) : 0);
      body = (
        <>
          <div className="text-[14px] font-semibold text-ink">{n.name}</div>
          <div className="text-[10.5px] text-ink-muted">{selected.context} · {n.ready ? "Ready" : "NotReady"}</div>
          <div className="mt-3 grid grid-cols-[84px_1fr] gap-x-3 gap-y-1 text-[12px]">
            <span className="text-ink-muted">CPU req.</span>
            <span className="text-ink-soft">{pct(n.cpu)}% · {(n.cpu.req / 1000).toFixed(1)} / {(n.cpu.alloc / 1000).toFixed(1)} cores</span>
            <span className="text-ink-muted">Memory req.</span>
            <span className="text-ink-soft">{pct(n.mem)}% · {(n.mem.req / 2 ** 30).toFixed(1)} / {(n.mem.alloc / 2 ** 30).toFixed(1)} GiB</span>
          </div>
          <Label>{`Workloads on it · ${on.length}`}</Label>
          {on.map((w) => <Row key={`${w.ns}/${w.name}`} w={w} onSelect={onSelect} right={w.ns} />)}
        </>
      );
    }
  }
  return (
    <aside className="absolute bottom-2.5 right-2.5 top-2.5 z-20 w-[320px] max-w-[calc(100%-20px)] overflow-auto rounded-xl border border-overlay-border bg-panel-modal px-3.5 py-3">
      <button type="button" onClick={onClose} className="absolute right-2.5 top-2 text-ink-muted hover:text-ink" title="Close">✕</button>
      {body}
    </aside>
  );
}
