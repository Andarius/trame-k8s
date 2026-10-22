// The search box with its completion list: Tab or Enter picks, arrows move, Escape closes.
import { useMemo, useRef, useState } from "react";
import { complete, QUALIFIER_HELP, type Qualifier, tokenize, type Values } from "./search.ts";

const TOKEN_CLASS = { key: "text-copper", neg: "text-blocked", value: "text-ink", word: "text-ink", space: "" } as const;
const TEXT = "px-2.5 py-0.5 text-[13px] whitespace-pre";

export default function Search({ value, onChange, values }: { value: string; onChange: (v: string) => void; values: Values }) {
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const mirror = useRef<HTMLDivElement>(null);
  const { items, replace } = useMemo(() => complete(value, values), [value, values]);
  const shown = open && items.length > 0;
  const pick = (i: number) => {
    onChange(replace(items[i]));
    setIdx(0);
  };
  return (
    <div className="relative min-w-[160px] flex-1">
      {/* the coloured copy sits under a transparent-text input, same metrics, scrolled along with it */}
      <div ref={mirror} aria-hidden className={`pointer-events-none absolute inset-0 overflow-hidden rounded-md border border-transparent bg-panel ${TEXT}`}>
        {tokenize(value).map((t, i) => <span key={i} className={TOKEN_CLASS[t.kind]}>{t.text}</span>)}
      </div>
      <input
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setIdx(0);
        }}
        onFocus={() => setOpen(true)}
        onScroll={(e) => mirror.current && (mirror.current.scrollLeft = e.currentTarget.scrollLeft)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (!shown) return;
          if (e.key === "ArrowDown") setIdx((i) => (i + 1) % items.length);
          else if (e.key === "ArrowUp") setIdx((i) => (i + items.length - 1) % items.length);
          else if (e.key === "Tab" || e.key === "Enter") pick(idx);
          else if (e.key === "Escape") setOpen(false);
          else return;
          e.preventDefault();
        }}
        placeholder="⌕ search · ns: group: tech:db is:down · -ns:… · focus to list all"
        title="Words match name, namespace, cluster, group, image and host. Qualifiers: cluster: ns: group: kind: image: host: tech:(postgresql, redis… or db, cache, queue…) is:(ready|rolled|degraded|down|zero). Double-click a graph node to add it. Prefix - to exclude, quote values with spaces."
        className={`relative w-full rounded-md border border-chipline bg-transparent text-transparent caret-ink outline-none placeholder:text-ink-muted focus:border-copper ${TEXT}`}
      />
      {shown && (
        <ul className="absolute left-0 top-full z-30 mt-1 max-h-[360px] min-w-[320px] overflow-y-auto rounded-md border border-overlay-border bg-panel-modal py-1 shadow-lg">
          {items.map((it, i) => {
            const q = it.endsWith(":") ? (it.slice(0, -1) as Qualifier) : null;
            return (
              <li key={it}>
                <button
                  type="button"
                  // mousedown, so the input keeps focus and its blur does not close the list first
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(i);
                  }}
                  onMouseEnter={() => setIdx(i)}
                  className={`flex w-full items-center gap-3 px-2.5 py-1 text-left text-[12.5px] ${i === idx ? "bg-active-row text-ink" : "text-ink-soft"}`}
                >
                  <span className="font-mono">{it}</span>
                  {q && <span className="ml-auto truncate text-[11px] text-ink-muted">{QUALIFIER_HELP[q]}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
