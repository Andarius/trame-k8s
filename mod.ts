// Kubernetes plugin: workloads per kube context, polled with the local kubectl.
// Live state is a module-level snapshot fed by a self-rescheduling poll; nothing reaches the database.
import type { Plugin, PluginSettings } from "@trame/plugin-api";
import { type ClusterView, SLUG_RE, type Snapshot, unhealthy } from "./model.ts";
import { fetchCluster, listContexts } from "./kube.ts";
import { isHttpsUrl, readSettings, sanitizeSettings, withSettings } from "./settings.ts";

const ICON_CDN = "https://cdn.simpleicons.org";
const MAX_LOGO_BYTES = 512 * 1024;

type PluginContext = Parameters<NonNullable<Plugin["start"]>>[0];

let ctx: PluginContext | null = null;
let snapshot: Snapshot = { clusters: [], polledAt: null, configured: false };
let inflight: Promise<void> | null = null;
const logos = new Map<string, { body: ArrayBuffer; type: string } | null>();

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

async function settings() {
  return readSettings(ctx ? await ctx.settings() : {});
}

function poll(): Promise<void> {
  inflight ??= (async () => {
    const s = await settings();
    const previous = new Map(snapshot.clusters.map((c) => [c.context, c]));
    const clusters = await Promise.all(s.contexts.map(async (context): Promise<ClusterView> => {
      try {
        return await fetchCluster(s.kubectl, context);
      } catch (e) {
        // keep the last good state on screen, flagged, rather than blanking a cluster on one bad poll
        const error = e instanceof Error ? e.message : String(e);
        const last = previous.get(context);
        return last
          ? { ...last, error }
          : { context, provider: null, error, polledAt: null, workloads: [], nodes: [], logo: null };
      }
    }));
    snapshot = { clusters, polledAt: new Date().toISOString(), configured: s.contexts.length > 0 };
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function fetchLogo(url: string): Promise<{ body: ArrayBuffer; type: string } | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  const type = res?.headers.get("content-type") ?? "";
  if (!res?.ok || !type.startsWith("image/")) return null;
  const body = await res.arrayBuffer();
  return body.byteLength <= MAX_LOGO_BYTES ? { body, type } : null;
}

// near-black brand colours vanish on the dark canvas: ask the CDN for a light grey instead
const isDark = (svg: string) => {
  const hex = svg.match(/fill="#([0-9a-f]{6})"/i)?.[1];
  if (!hex) return false;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.25;
};

async function icon(slug: string) {
  if (!logos.has(`icon:${slug}`)) {
    let got = await fetchLogo(`${ICON_CDN}/${slug}`);
    if (got && isDark(new TextDecoder().decode(got.body))) got = await fetchLogo(`${ICON_CDN}/${slug}/a9b2c3`) ?? got;
    logos.set(`icon:${slug}`, got);
  }
  return logos.get(`icon:${slug}`);
}

const image = (got: { body: ArrayBuffer; type: string } | null | undefined) =>
  got
    ? new Response(got.body, { headers: { "content-type": got.type, "cache-control": "max-age=86400" } })
    : json({ error: "no logo" }, 404);

const plugin: Plugin = {
  id: "k8s",
  label: "Kubernetes",
  glyph: "⎈",
  description: "Workloads per cluster, from your kubeconfig contexts",
  ungatedRoutes: ["/contexts"],

  async routes(req, subPath, url) {
    if (subPath === "/state" && req.method === "GET") return json(withSettings(snapshot, await settings()));
    if (subPath === "/refresh" && req.method === "POST") {
      await poll();
      return json(withSettings(snapshot, await settings()));
    }
    if (subPath === "/contexts" && req.method === "GET") {
      try {
        return json({ contexts: await listContexts((await settings()).kubectl) });
      } catch (e) {
        return json({ contexts: [], error: e instanceof Error ? e.message : String(e) });
      }
    }
    const slug = subPath.match(/^\/icon\/([^/]+)$/)?.[1];
    if (slug && req.method === "GET") return SLUG_RE.test(slug) ? image(await icon(slug)) : json({ error: "bad slug" }, 400);
    if (subPath === "/logo" && req.method === "GET") {
      const key = url.searchParams.get("key") ?? "";
      const target = (await settings()).logos[key];
      if (!target || !isHttpsUrl(target)) return json({ error: "no logo" }, 404);
      if (!logos.has(`url:${target}`)) logos.set(`url:${target}`, await fetchLogo(target));
      return image(logos.get(`url:${target}`));
    }
    return null;
  },

  start(c) {
    ctx = c;
    const loop = async () => {
      try {
        if (await c.enabled()) await poll();
      } catch (e) {
        console.error("k8s poll:", e);
      }
      setTimeout(loop, ((await settings().catch(() => null))?.pollSeconds ?? 60) * 1000);
    };
    void loop();
  },

  onEnabled() {
    void poll();
  },

  badge() {
    const n = snapshot.clusters.reduce((sum, c) => sum + c.workloads.filter(unhealthy).length, 0);
    return n || null;
  },

  sanitizeSettings: (raw: PluginSettings, current: PluginSettings) => sanitizeSettings(raw, current),
};

export default plugin;
