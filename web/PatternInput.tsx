// A pattern field completing from the polled workloads: `ns/*`, then `ns/name`, for the item being typed.
import { type KeyboardEvent, useMemo, useState } from "react";
import { MenuRow, Popover, TextInput } from "@trame/web-api";
import type { Workload } from "../model.ts";
import { completePattern } from "./patterns.ts";

export default function PatternInput({ value, onChange, workloads, onKeyDown, className, placeholder, autoFocus }: {
  value: string;
  onChange: (v: string) => void;
  workloads: Workload[];
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  className?: string;
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
      <TextInput
        mono
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
          else return onKeyDown?.(e);
          e.preventDefault();
        }}
        placeholder={placeholder}
        className={className}
      />
      {shown && (
        // portalled: a Modal's scrolling body would clip it
        <Popover portal onClose={() => setOpen(false)} className="max-h-[240px] overflow-y-auto">
          {items.map((it, i) => (
            <MenuRow
              key={it}
              dense
              active={i === idx}
              // mousedown, so the input keeps focus and its blur does not close the list first
              onMouseDown={(e) => {
                e.preventDefault();
                pick(i);
              }}
              onMouseEnter={() => setIdx(i)}
              className={`font-mono ${i === idx ? "bg-panel" : ""}`}
            >
              {it}
            </MenuRow>
          ))}
        </Popover>
      )}
    </div>
  );
}
