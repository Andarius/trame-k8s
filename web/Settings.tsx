// Kubernetes settings: which contexts to poll (nothing is polled until one is ticked), cadence, logos.
import { useEffect, useState } from "react";
import { getPluginSettings, savePluginSettings } from "@trame/web-api";
import { listContexts, refreshState } from "./api.ts";

type Slice = { contexts: string[]; pollSeconds: number; kubectl: string; autoLogos: boolean; logos: Record<string, string> };
const DEFAULTS: Slice = { contexts: [], pollSeconds: 60, kubectl: "kubectl", autoLogos: true, logos: {} };

const input = "rounded-md border border-line bg-panel px-2.5 py-1.5 text-[11.5px] text-ink outline-none focus:border-chipline";
const label = "mb-1.5 mt-4 text-[10.5px] font-medium uppercase tracking-[0.8px] text-ink-muted/80";

const toLines = (logos: Record<string, string>) => Object.entries(logos).map(([k, v]) => `${k} = ${v}`).join("\n");
const fromLines = (text: string) =>
  Object.fromEntries(
    text.split("\n").map((l) => l.split("=").map((s) => s.trim())).filter((p) => p.length >= 2 && p[0] && p[1])
      .map(([k, ...v]) => [k, v.join("=")]),
  );

export function K8sSettings() {
  const [slice, setSlice] = useState<Slice | null>(null);
  const [available, setAvailable] = useState<string[]>([]);
  const [contextError, setContextError] = useState<string | null>(null);
  const [logoText, setLogoText] = useState("");
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
      setLogoText(toLines(s.logos));
    });
    void loadContexts();
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
    const wanted = fromLines(logoText);
    const next = await save({ logos: wanted });
    const dropped = Object.keys(wanted).filter((k) => !(k in next.logos));
    setLogoText(toLines(next.logos));
    setStatus(dropped.length ? `Ignored (need a simple-icons slug or an https URL): ${dropped.join(", ")}` : "Saved");
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
        Overrides, one per line: <code>name</code>, <code>ns/name</code>, <code>context/ns/name</code> or a context, then{" "}
        <code>=</code> and a simple-icons slug or an https image URL. A workload can also carry a{" "}
        <code>trame.dev/logo: &lt;slug&gt;</code> annotation.
      </p>
      <textarea
        value={logoText}
        onChange={(e) => setLogoText(e.target.value)}
        rows={5}
        placeholder={"backend = fastapi\nsoren-dev/web = react\nsaas-prod = https://example.com/logo.svg"}
        className={`${input} w-full font-mono`}
      />
      <div className="mt-1.5 flex items-center gap-2">
        <button type="button" onClick={() => void saveLogos()} className="rounded-md bg-copper px-2.5 py-1 text-[11.5px] font-medium text-copper-ink">
          Save logos
        </button>
        {status && <span className="text-[11px] text-ink-muted">{status}</span>}
      </div>
    </div>
  );
}
