// Which kube contexts to poll and the Trame project each one is filed under in the sidebar.
import { useEffect, useState } from "react";
import { Button, ErrorNote, getPluginSettings, Modal, type Project, savePluginSettings, Select } from "@trame/web-api";
import { listContexts } from "./api.ts";

export type Picked = { contexts: string[]; projects: Record<string, string> };

export default function Contexts({ projects, onChange, onClose }: {
  projects: Project[];
  onChange: (picked: Picked) => void; // after each save, with what the host kept
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [available, setAvailable] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    listContexts().then((r) => {
      setAvailable(r.contexts);
      setError(r.error ?? null);
    }).catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
    void getPluginSettings("k8s").then((s) =>
      setPicked({ contexts: (s.contexts ?? []) as string[], projects: (s.projects ?? {}) as Record<string, string> })
    );
  }, []);

  if (!picked) return null;
  const save = async (patch: Partial<Picked>) => {
    const s = await savePluginSettings("k8s", patch);
    const next = { contexts: (s.contexts ?? []) as string[], projects: (s.projects ?? {}) as Record<string, string> };
    setPicked(next);
    onChange(next);
  };
  const toggle = (ctx: string) =>
    void save({ contexts: picked.contexts.includes(ctx) ? picked.contexts.filter((c) => c !== ctx) : [...picked.contexts, ctx] });
  const assign = (ctx: string, id: string) => {
    const { [ctx]: _, ...rest } = picked.projects;
    void save({ projects: id ? { ...rest, [ctx]: id } : rest });
  };
  // contexts saved earlier but gone from the kubeconfig stay listed, so they can be unticked
  const shown = [...new Set([...available, ...picked.contexts])];
  const options = [
    { value: "", label: "No project" },
    ...[...projects].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ value: p.id, label: p.name, icon: p.icon })),
  ];

  return (
    <Modal width={460} label="Clusters" onClose={onClose}>
      <div className="text-[14px] font-semibold text-ink">Clusters</div>
      <p className="text-[11.5px] text-ink-muted">
        Tick the kube contexts to poll (read-only <code>kubectl get</code>) and file each under a project.
      </p>
      {error && <ErrorNote className="break-words">{error}</ErrorNote>}
      <div className="-mx-1 flex max-h-[55vh] flex-col overflow-y-auto">
        {shown.map((ctx) => {
          const on = picked.contexts.includes(ctx);
          return (
            <div key={ctx} className="grid grid-cols-[auto_minmax(0,1fr)_160px] items-center gap-2 rounded-md px-1 py-0.5 hover:bg-active-row/50">
              <input
                type="checkbox"
                checked={on}
                onChange={() => toggle(ctx)}
                aria-label={`Poll ${ctx}`}
                className="accent-[var(--color-copper)]"
              />
              <button type="button" onClick={() => toggle(ctx)} className={`truncate text-left font-mono text-[11.5px] ${on ? "text-ink" : "text-ink-muted"}`}>
                {ctx}
                {!available.includes(ctx) && <span className="ml-1.5 font-sans text-[10.5px] text-ink-muted">not in kubeconfig</span>}
              </button>
              <Select value={picked.projects[ctx] ?? ""} options={options} onChange={(id) => assign(ctx, id)} />
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex items-center gap-2">
        <Button size="sm" onClick={() => void load()}>↻ Reload kubeconfig</Button>
        <Button variant="primary" onClick={onClose} className="ml-auto">Done</Button>
      </div>
    </Modal>
  );
}
