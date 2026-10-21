// A pattern field completing from the polled workloads: `ns/*`, then `ns/name`, for the item being typed.
import { type KeyboardEvent, useMemo, useState } from "react";
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

export default function PatternInput({ value, onChange, workloads, onKeyDown, className, placeholder, autoFocus }: {
  value: string;
  onChange: (v: string) => void;
  workloads: Workload[];
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  className: string;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const { items, replace } = useMemo(() => completePattern(value, workloads), [value, workloads]);
  const shown = open && items.length > 0;
  const pick = (i: number) => {
    onChange(replace(items[i]));
    setIdx(0);
  };
  return (
    <div className="relative min-w-0">
      <input
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setIdx(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (!shown) return onKeyDown?.(e);
          if (e.key === "ArrowDown") setIdx((i) => (i + 1) % items.length);
          else if (e.key === "ArrowUp") setIdx((i) => (i + items.length - 1) % items.length);
          else if (e.key === "Tab" || e.key === "Enter") pick(idx);
          else if (e.key === "Escape") setOpen(false);
          else return onKeyDown?.(e);
          e.preventDefault();
        }}
        placeholder={placeholder}
        className={className}
      />
      {shown && (
        <ul className="absolute left-0 top-full z-30 mt-1 max-h-[240px] min-w-full overflow-y-auto rounded-md border border-overlay-border bg-panel-modal py-1 shadow-lg">
          {items.map((it, i) => (
            <li key={it}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(i);
                }}
                onMouseEnter={() => setIdx(i)}
                className={`w-full px-2.5 py-1 text-left font-mono text-[12px] ${i === idx ? "bg-active-row text-ink" : "text-ink-soft"}`}
              >
                {it}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
