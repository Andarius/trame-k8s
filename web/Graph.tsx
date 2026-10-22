// Force-directed drawing of a GraphData, in the manner of Trame's sessions graph.
import { useEffect, useRef, useState } from "react";
import { drag } from "d3-drag";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { select } from "d3-selection";
import { zoom, zoomIdentity, zoomTransform, type ZoomTransform } from "d3-zoom";
import { filterTerm, type GLink, type GNode, type GraphData, type Ref } from "./graph-model.ts";

type Node = GNode & SimulationNodeDatum & { side?: Side };
type Link = Omit<GLink, "source" | "target"> & SimulationLinkDatum<Node> & { source: Node; target: Node };

const LABELS_AT = 1.4; // zoom from which every label shows, not only the hubs'
const LINE = "var(--color-chipline)";
const BG = "var(--color-panel)";
const fontOf = (d: Node) => (d.kind === "cluster" ? 13 : d.kind === "ns" || d.kind === "app" ? 10.5 : 9.5);

type Side = "r" | "l" | "t" | "b";
type Box = { x0: number; x1: number; y0: number; y1: number };
const SIDES: Side[] = ["r", "l", "t", "b"];
export type Layout = "compact" | "spread" | "radial";
export const LAYOUTS: { id: Layout; label: string; title: string }[] = [
  { id: "radial", label: "Radial", title: "Rings around each cluster: hubs, then their workloads" },
  { id: "compact", label: "Compact", title: "Short tethers, everything close to its hub" },
  { id: "spread", label: "Spread", title: "Longer tethers and more repulsion, so labels get room" },
];
// per-layout multipliers on tether length and repulsion, and how hard label boxes push apart
const TUNE: Record<Layout, { dist: number; charge: number; push: number }> = {
  compact: { dist: 1, charge: 1, push: 0.6 },
  spread: { dist: 1.8, charge: 2.2, push: 0.8 },
  radial: { dist: 1, charge: 1.2, push: 0.7 },
};
const RING = 90;
const PICK_EVERY = 10; // ticks between side choices, so labels do not flutter

// the dot-plus-label box with the label on that side (the dot alone when there is no label)
function box(n: Node, side: Side): Box {
  const fs = n.label ? fontOf(n) : 0;
  const w = n.label ? n.label.length * fs * 0.55 : 0;
  const h = Math.max(n.r, fs * 0.6) + 2;
  const x = n.x!, y = n.y!;
  if (!n.label) return { x0: x - n.r - 2, x1: x + n.r + 2, y0: y - h, y1: y + h };
  if (side === "r") return { x0: x - n.r - 2, x1: x + n.r + 4 + w + 2, y0: y - h, y1: y + h };
  if (side === "l") return { x0: x - n.r - 4 - w - 2, x1: x + n.r + 2, y0: y - h, y1: y + h };
  const half = Math.max(n.r, w / 2) + 2;
  if (side === "t") return { x0: x - half, x1: x + half, y0: y - n.r - 4 - fs - 2, y1: y + n.r + 2 };
  return { x0: x - half, x1: x + half, y0: y - n.r - 2, y1: y + n.r + 4 + fs + 2 };
}

const overlap = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

// keeps every box clear of the others, pushing along the smaller overlap; a label moves to whichever side
// overlaps least. Not scaled by alpha, like forceCollide, so it still wins once the tethers have cooled.
function forceLabels(nodes: Node[], push: number) {
  let tick = 0;
  return () => {
    if (tick++ % PICK_EVERY === 0) {
      const current = nodes.map((n) => box(n, n.side ?? "r"));
      nodes.forEach((n, i) => {
        if (!n.label) return;
        const cost = (side: Side) => {
          let sum = 0;
          const c = box(n, side);
          for (let j = 0; j < nodes.length; j++) if (j !== i) sum += overlap(c, current[j]);
          return sum;
        };
        const now = cost(n.side ?? "r");
        if (now === 0) return;
        let best: Side = n.side ?? "r", bestCost = now;
        for (const side of SIDES) {
          const c = cost(side);
          if (c < bestCost * 0.7) {
            best = side;
            bestCost = c;
          }
        }
        n.side = best;
      });
    }
    const boxes = nodes.map((n) => ({ n, ...box(n, n.side ?? "r") })).sort((a, b) => a.x0 - b.x0);
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i];
      for (let j = i + 1; j < boxes.length && boxes[j].x0 < a.x1; j++) {
        const b = boxes[j];
        const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        if (ox <= 0 || oy <= 0) continue;
        if (oy <= ox) {
          const s = oy * 0.5 * push, sign = a.n.y! < b.n.y! ? -1 : 1;
          a.n.vy! += sign * s;
          b.n.vy! -= sign * s;
        } else {
          const s = ox * 0.5 * push, sign = a.n.x! < b.n.x! ? -1 : 1;
          a.n.vx! += sign * s;
          b.n.vx! -= sign * s;
        }
      }
    }
  };
}

// rings around each root (a node nothing points at): its hubs at RING, their children at 2·RING, …
function forceRings(nodes: Node[], links: Link[], ring: number) {
  const parent = new Map<Node, Node>();
  for (const l of links) if (!parent.has(l.target)) parent.set(l.target, l.source);
  const info = nodes.map((n) => {
    let root = n, depth = 0;
    while (parent.has(root) && depth < 20) {
      root = parent.get(root)!;
      depth++;
    }
    return { root, depth };
  });
  return (alpha: number) => {
    nodes.forEach((n, i) => {
      const { root, depth } = info[i];
      if (!depth) return;
      const dx = n.x! - root.x!, dy = n.y! - root.y!, d = Math.hypot(dx, dy) || 1;
      const k = ((depth * ring - d) / d) * 0.5 * alpha;
      n.vx! += dx * k;
      n.vy! += dy * k;
    });
  };
}

// positions survive polls and view switches, so a refresh doesn't reshuffle the graph
const placed = new Map<string, { x: number; y: number }>();

export default function Graph({ graph, viewKey, layout, onSelect, onFilter }: {
  graph: GraphData;
  viewKey: string;
  layout: Layout;
  onSelect: (ref: Ref) => void;
  onFilter: (term: string) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [tip, setTip] = useState<{ lines: string[]; x: number; y: number } | null>(null);
  const select$ = useRef(onSelect);
  select$.current = onSelect;
  const filter$ = useRef(onFilter);
  filter$.current = onFilter;

  // rebuild only when what is drawn changes, not on every poll
  const shape = JSON.stringify([
    viewKey,
    layout,
    graph.nodes.map((n) => [n.id, n.label, n.color, n.hollow, n.pulse, n.logo, n.tip]),
    graph.links.map((l) => [l.source, l.target, l.color, l.label]),
  ]);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const pos = (id: string) => placed.get(`${viewKey}|${id}`);
    const nodes: Node[] = graph.nodes.map((n) => ({ ...n, ...pos(n.id) }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links: Link[] = graph.links
      .filter((l) => byId.has(l.source) && byId.has(l.target))
      .map((l) => ({ ...l, source: byId.get(l.source)!, target: byId.get(l.target)! }));
    const fresh = nodes.some((n) => n.x === undefined);

    const svg = select(el);
    svg.selectAll("*").remove();
    const defs = svg.append("defs");
    defs.append("clipPath").attr("id", `k8s-dot-${viewKey}`).attr("clipPathUnits", "objectBoundingBox")
      .append("circle").attr("cx", 0.5).attr("cy", 0.5).attr("r", 0.5);
    defs.append("marker").attr("id", `k8s-arrow-${viewKey}`).attr("viewBox", "0 -4 8 8").attr("refX", 8)
      .attr("markerWidth", 6).attr("markerHeight", 6).attr("orient", "auto")
      .append("path").attr("d", "M0,-4L8,0L0,4").attr("fill", LINE);
    const world = svg.append("g");

    const link = world.append("g").selectAll("path").data(links.filter((l) => !l.hidden)).join("path")
      .attr("fill", "none")
      .attr("stroke", (d) => d.color ?? LINE)
      .attr("stroke-width", (d) => d.width ?? 0.9)
      .attr("stroke-dasharray", (d) => (d.dashed ? "3 2" : null))
      .attr("vector-effect", "non-scaling-stroke")
      .attr("marker-end", (d) => (d.arrow ? `url(#k8s-arrow-${viewKey})` : null));
    const linkLabel = world.append("g").attr("pointer-events", "none").selectAll("text")
      .data(links.filter((l) => l.label)).join("text")
      .attr("font-size", 8.5).attr("text-anchor", "middle").attr("fill", (d) => d.color ?? "var(--color-ink-muted)")
      .attr("paint-order", "stroke").attr("stroke", BG).attr("stroke-width", 3)
      .text((d) => d.label!);
    const pulse = world.append("g").attr("pointer-events", "none").selectAll("circle")
      .data(nodes.filter((n) => n.pulse)).join("circle")
      .attr("class", "k8s-pulse").attr("fill", "none").attr("stroke", (d) => d.color).attr("r", (d) => d.r);
    const node = world.append("g").selectAll<SVGCircleElement, Node>("circle").data(nodes).join("circle")
      .attr("r", (d) => d.r)
      .attr("fill", (d) => (d.hollow ? BG : d.ringColor ? d.color : d.logo ? "var(--color-canvas)" : d.color))
      .attr("fill-opacity", (d) => (d.ringColor && !d.hollow ? 0.18 : 1))
      .attr("stroke", (d) => (d.hollow || d.logo || d.ringColor ? d.ringColor ?? d.color : BG))
      .attr("stroke-width", (d) => (d.ringColor ? 2 : d.hollow || d.logo ? 1.6 : 1))
      .attr("stroke-dasharray", (d) => (d.dashed ? "2 1.5" : null))
      .style("cursor", (d) => (d.ref ? "pointer" : "grab"));
    const logo = world.append("g").attr("pointer-events", "none").selectAll("image")
      .data(nodes.filter((n) => n.logo)).join("image")
      .attr("href", (d) => d.logo!)
      .attr("width", (d) => d.r * 1.2).attr("height", (d) => d.r * 1.2)
      .attr("preserveAspectRatio", "xMidYMid meet")
      .attr("clip-path", `url(#k8s-dot-${viewKey})`)
      .on("error", function () {
        select(this).remove();
      });
    const glyph = world.append("g").attr("pointer-events", "none").selectAll("text")
      .data(nodes.filter((n) => !n.logo && (n.kind === "cluster" || n.kind === "internet"))).join("text")
      .attr("text-anchor", "middle").attr("dominant-baseline", "central")
      .attr("font-size", (d) => d.r).attr("fill", (d) => d.ringColor ?? d.color)
      .text((d) => (d.kind === "cluster" ? "⎈" : "◎"));
    const label = world.append("g").attr("pointer-events", "none").selectAll<SVGTextElement, Node>("text")
      .data(nodes.filter((n) => n.label)).join("text")
      .attr("font-size", fontOf)
      .attr("font-weight", (d) => (d.kind === "cluster" ? 600 : 400))
      .attr("fill", (d) => (d.kind === "ns" || d.kind === "app" ? d.color : d.kind === "cluster" ? "var(--color-ink)" : "var(--color-ink-soft)"))
      .attr("paint-order", "stroke").attr("stroke", BG).attr("stroke-width", 3)
      .text((d) => d.label);

    let k = 1;
    const showLabels = (focus?: Set<Node>) => {
      label.attr("display", (d) => (d.labelAlways || k >= LABELS_AT || focus?.has(d) ? null : "none"));
      linkLabel.attr("display", k >= 1.1 ? null : "none");
    };
    const zoomer = zoom<SVGSVGElement, unknown>().scaleExtent([0.2, 5]).on("zoom", (e: { transform: ZoomTransform }) => {
      world.attr("transform", e.transform.toString());
      k = e.transform.k;
      showLabels();
    });
    svg.call(zoomer).on("dblclick.zoom", null);

    const tune = TUNE[layout];
    const sim = forceSimulation(nodes)
      .force("link", forceLink<Node, Link>(links).distance((d) => d.dist * tune.dist).strength((d) => d.strength ?? 0.7))
      .force("charge", forceManyBody<Node>().strength((d) => d.charge * tune.charge))
      .force("x", forceX<Node>((d) => d.column ?? 0).strength((d) => (d.column !== undefined ? 0.25 : 0.04)))
      .force("y", forceY(0).strength(0.06))
      // lane nodes stack vertically, so they need room for their label line
      .force("collide", forceCollide<Node>((d) => (d.kind === "cluster" ? 50 : d.column !== undefined ? d.r + 8 : d.r + 3)))
      .force("labels", forceLabels(nodes, tune.push))
      .force("rings", layout === "radial" ? forceRings(nodes, links, RING) : null);

    const edge = (d: Link) => {
      const s = d.source, t = d.target;
      if (!d.arrow) return `M${s.x},${s.y}L${t.x},${t.y}`;
      const dx = t.x! - s.x!, dy = t.y! - s.y!, len = Math.hypot(dx, dy) || 1;
      return `M${s.x},${s.y}L${t.x! - (dx / len) * (t.r + 2)},${t.y! - (dy / len) * (t.r + 2)}`;
    };
    sim.on("tick", () => {
      link.attr("d", edge);
      linkLabel.attr("x", (d) => (d.source.x! + d.target.x!) / 2).attr("y", (d) => (d.source.y! + d.target.y!) / 2 - 3);
      node.attr("cx", (d) => d.x!).attr("cy", (d) => d.y!);
      pulse.attr("cx", (d) => d.x!).attr("cy", (d) => d.y!);
      logo.attr("x", (d) => d.x! - d.r * 0.6).attr("y", (d) => d.y! - d.r * 0.6);
      glyph.attr("x", (d) => d.x!).attr("y", (d) => d.y! + 0.5);
      label
        .attr("x", (d) => (d.side === "l" ? d.x! - d.r - 4 : d.side === "t" || d.side === "b" ? d.x! : d.x! + d.r + 4))
        .attr("y", (d) => (d.side === "t" ? d.y! - d.r - 4 : d.side === "b" ? d.y! + d.r + 4 + fontOf(d) * 0.8 : d.y! + 3.5))
        .attr("text-anchor", (d) => (d.side === "l" ? "end" : d.side === "t" || d.side === "b" ? "middle" : "start"));
      for (const n of nodes) placed.set(`${viewKey}|${n.id}`, { x: n.x!, y: n.y! });
    });

    if (fresh) {
      // settle off-screen, then frame everything once
      sim.stop();
      for (let i = 0; i < 300; i++) sim.tick();
      sim.alpha(0.05).restart();
      const xs = nodes.map((n) => n.x!), ys = nodes.map((n) => n.y!);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      const s = Math.min(1.6, 0.9 * Math.min(width / (x1 - x0 + 160 || 1), height / (y1 - y0 + 60 || 1)));
      svg.call(zoomer.transform, zoomIdentity.translate(width / 2, height / 2).scale(s).translate(-(x0 + x1) / 2, -(y0 + y1) / 2));
    } else {
      sim.alpha(0.15);
      svg.call(zoomer.transform, zoomTransform(el).k === 1 ? zoomIdentity.translate(width / 2, height / 2) : zoomTransform(el));
    }

    node.call(
      drag<SVGCircleElement, Node>()
        .on("start", (e, d) => {
          if (!e.active) sim.alphaTarget(0.2).restart();
          d.fx = d.x;
          d.fy = d.y;
        })
        .on("drag", (e, d) => {
          d.fx = e.x;
          d.fy = e.y;
        })
        .on("end", (e, d) => {
          if (!e.active) sim.alphaTarget(0);
          d.fx = null;
          d.fy = null;
        }),
    );

    const near = new Map(nodes.map((n) => [n, new Set([n])]));
    for (const l of links) {
      if (l.hidden) continue;
      near.get(l.source)!.add(l.target);
      near.get(l.target)!.add(l.source);
    }
    node
      .on("mouseenter", (e: MouseEvent, d) => {
        const focus = near.get(d)!;
        node.attr("opacity", (n) => (focus.has(n) ? 1 : 0.25));
        logo.attr("opacity", (n) => (focus.has(n) ? 1 : 0.25));
        link.attr("opacity", (l) => (l.source === d || l.target === d ? 1 : 0.12));
        showLabels(focus);
        const box = el.getBoundingClientRect();
        setTip({ lines: d.tip, x: e.clientX - box.left, y: e.clientY - box.top });
      })
      .on("mouseleave", () => {
        node.attr("opacity", 1);
        logo.attr("opacity", 1);
        link.attr("opacity", 1);
        showLabels();
        setTip(null);
      })
      .on("click", (e: MouseEvent, d) => {
        e.stopPropagation();
        if (d.ref) select$.current(d.ref);
      })
      .on("dblclick", (e: MouseEvent, d) => {
        e.stopPropagation();
        const term = filterTerm(d);
        if (term) filter$.current(term);
      });
    showLabels();
    return () => {
      sim.stop();
    };
    // `shape` stands for graph + viewKey
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [shape]);

  return (
    <div className="relative h-full min-h-0 w-full">
      <style>{"@keyframes k8s-pulse{0%{stroke-opacity:.9;stroke-width:1.5}100%{stroke-opacity:0;stroke-width:9}}.k8s-pulse{animation:k8s-pulse 1.6s ease-out infinite}"}</style>
      <svg ref={svgRef} className="block h-full w-full cursor-grab active:cursor-grabbing" />
      {tip && (
        <div
          className="pointer-events-none absolute z-10 max-w-[280px] rounded-lg border border-overlay-border bg-panel-modal px-2.5 py-1.5 text-[11.5px]"
          style={{ left: tip.x + 12, top: tip.y + 12 }}
        >
          <div className="font-medium text-ink">{tip.lines[0]}</div>
          {tip.lines.slice(1).map((l, i) => <div key={i} className="text-[10.5px] text-ink-muted">{l}</div>)}
        </div>
      )}
      {!graph.nodes.length && (
        <div className="absolute inset-0 grid place-items-center text-[12px] text-ink-muted">Nothing to draw for this filter.</div>
      )}
    </div>
  );
}
