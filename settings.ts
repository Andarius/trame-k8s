// The plugin's settings slice: what may be saved, and how logos and groups resolve from it.
import { imageIcon, matchesKey, providerIcon, SLUG_RE, type Snapshot, type Workload } from "./model.ts";

export type K8sSettings = {
  contexts: string[]; // kube contexts to poll; empty polls nothing
  pollSeconds: number;
  kubectl: string;
  autoLogos: boolean; // guess logos from image names
  logos: Record<string, string>; // `name` | `ns/name` | `context/ns/name` | `context` (`*` within a segment) → slug or https URL
  groups: Record<string, string[]>; // group → patterns shaped like logo keys, `*` within a segment
};

export const DEFAULTS: K8sSettings = { contexts: [], pollSeconds: 60, kubectl: "kubectl", autoLogos: true, logos: {}, groups: {} };

// passed to kubectl as one argv entry; the leading-dash ban keeps a name from reading as a flag
export const CONTEXT_RE = /^[\w.@:/][\w.@:/-]{0,252}$/;
const KUBECTL_RE = /^(kubectl|\/[\w./-]+)$/;
const LOGO_KEY_RE = /^[\w.@:/*-]{1,300}$/;
const MAX_LOGOS = 300;
const GROUP_RE = /^[\w][\w .-]{0,39}$/;
const PATTERN_RE = /^[\w.@:/*-]{1,300}$/;
const MAX_GROUPS = 50;
const MAX_PATTERNS = 100;

export const isHttpsUrl = (v: string) => {
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
};

// a stored slice read back with defaults; anything malformed falls back instead of failing the poll
export function readSettings(raw: Record<string, unknown>): K8sSettings {
  return { ...DEFAULTS, ...sanitizeSettings(raw, {}) } as K8sSettings;
}

// allowlist a settings patch (fields absent from `raw` are left as they are)
export function sanitizeSettings(raw: Record<string, unknown>, _current: Record<string, unknown>): Partial<K8sSettings> {
  const out: Partial<K8sSettings> = {};
  if (Array.isArray(raw.contexts)) {
    out.contexts = [...new Set(raw.contexts.filter((c): c is string => typeof c === "string" && CONTEXT_RE.test(c)))];
  }
  if (typeof raw.pollSeconds === "number" && Number.isFinite(raw.pollSeconds)) {
    out.pollSeconds = Math.min(3600, Math.max(15, Math.round(raw.pollSeconds)));
  }
  if (typeof raw.kubectl === "string" && KUBECTL_RE.test(raw.kubectl)) out.kubectl = raw.kubectl;
  if (typeof raw.autoLogos === "boolean") out.autoLogos = raw.autoLogos;
  if (raw.logos && typeof raw.logos === "object" && !Array.isArray(raw.logos)) {
    const entries = Object.entries(raw.logos as Record<string, unknown>)
      .filter((e): e is [string, string] =>
        LOGO_KEY_RE.test(e[0]) && typeof e[1] === "string" && (SLUG_RE.test(e[1]) || isHttpsUrl(e[1]))
      )
      .slice(0, MAX_LOGOS);
    out.logos = Object.fromEntries(entries);
  }
  if (raw.groups && typeof raw.groups === "object" && !Array.isArray(raw.groups)) {
    const entries = Object.entries(raw.groups as Record<string, unknown>)
      .filter((e): e is [string, unknown[]] => GROUP_RE.test(e[0]) && Array.isArray(e[1]))
      .map(([g, ps]): [string, string[]] => [
        g,
        [...new Set(ps.filter((p): p is string => typeof p === "string" && PATTERN_RE.test(p)))].slice(0, MAX_PATTERNS),
      ])
      .filter(([, ps]) => ps.length)
      .slice(0, MAX_GROUPS);
    out.groups = Object.fromEntries(entries);
  }
  return out;
}

const ROUTE = "/api/plugins/k8s";
// a slug is served from the icon cache; a URL only through its settings key, so the proxy fetches nothing else
const logoUrl = (key: string, value: string) =>
  SLUG_RE.test(value) ? `${ROUTE}/icon/${value}` : `${ROUTE}/logo?key=${encodeURIComponent(key)}`;

// an exact key wins over a pattern; patterns apply in their written order
export function workloadLogo(w: Workload, s: K8sSettings): string | null {
  for (const k of [`${w.cluster}/${w.ns}/${w.name}`, `${w.ns}/${w.name}`, w.name]) if (s.logos[k]) return logoUrl(k, s.logos[k]);
  for (const [k, v] of Object.entries(s.logos)) if (k.includes("*") && matchesKey(w, k)) return logoUrl(k, v);
  // the annotation lives in the cluster: a slug only, never a URL the host would fetch
  if (w.logoHint && SLUG_RE.test(w.logoHint)) return `${ROUTE}/icon/${w.logoHint}`;
  const auto = s.autoLogos ? imageIcon(w.images) : null;
  return auto ? `${ROUTE}/icon/${auto}` : null;
}

// first group with a matching pattern wins, then the annotation
export function workloadGroup(w: Workload, s: K8sSettings): string | null {
  for (const [group, patterns] of Object.entries(s.groups)) if (patterns.some((p) => matchesKey(w, p))) return group;
  return w.groupHint && GROUP_RE.test(w.groupHint) ? w.groupHint : null;
}

export function withSettings(snap: Snapshot, s: K8sSettings): Snapshot {
  return {
    ...snap,
    clusters: snap.clusters.map((c) => {
      const own = s.logos[c.context];
      const auto = s.autoLogos ? providerIcon(c.provider) : null;
      return {
        ...c,
        logo: own ? logoUrl(c.context, own) : auto ? `${ROUTE}/icon/${auto}` : null,
        workloads: c.workloads.map((w) => ({ ...w, logo: workloadLogo(w, s), group: workloadGroup(w, s) })),
      };
    }),
  };
}
