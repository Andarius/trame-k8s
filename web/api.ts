import { getPluginSettings, savePluginSettings } from "@trame/web-api";
import type { Snapshot } from "../model.ts";

const BASE = "/api/plugins/k8s";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const getState = () => call<Snapshot>("/state");
export const refreshState = () => call<Snapshot>("/refresh", { method: "POST" });
export const listContexts = () => call<{ contexts: string[]; error?: string }>("/contexts");

// a per-viewer convenience: storage can be missing or throw (private mode, cleared data)
export function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`trame-k8s:${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function savePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(`trame-k8s:${key}`, JSON.stringify(value));
  } catch {
    // preferences are best-effort
  }
}

// adds patterns to a group in the settings (a new group, or more patterns for one); says what the host refused
export async function addGroup(name: string, patterns: string[]): Promise<{ dropped: string[] }> {
  const current = ((await getPluginSettings("k8s")).groups ?? {}) as Record<string, string[]>;
  const groups = { ...current, [name]: [...new Set([...(current[name] ?? []), ...patterns])] };
  const saved = ((await savePluginSettings("k8s", { groups })).groups ?? {}) as Record<string, string[]>;
  const kept = new Set(saved[name] ?? []);
  return { dropped: name in saved ? patterns.filter((p) => !kept.has(p)) : [`${name} (bad name)`] };
}
