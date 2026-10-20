import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

// The plugin reaches Trame only through "@trame/plugin-api" (backend) and "@trame/web-api" (web),
// so a Trame refactor behind those modules never breaks it.
const ALLOWED: [string, (spec: string) => boolean][] = [
  ["./", (s) => s.startsWith("./") || s.startsWith("node:") || s === "bun:test" || s === "@trame/plugin-api"],
  ["./web/", (s) => s.startsWith("./") || s === "../model.ts" || s === "react" || s === "@trame/web-api" || /^d3-[a-z]+$/.test(s)],
];

test("the plugin imports Trame only through its plugin APIs", () => {
  const bad: string[] = [];
  for (const [dir, ok] of ALLOWED) {
    const root = new URL(dir, import.meta.url);
    for (const name of readdirSync(root)) {
      if (!/\.tsx?$/.test(name)) continue;
      const src = readFileSync(new URL(name, root), "utf8");
      const specs = [
        ...src.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gm),
        ...src.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g),
      ];
      for (const [, spec] of specs) if (!ok(spec)) bad.push(`${dir}${name}: ${spec}`);
    }
  }
  expect(bad).toEqual([]);
});
