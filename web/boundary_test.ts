import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

// The web side reaches Trame only through "@trame/web-api"; d3 modules come from Trame's app/web/package.json.
const ok = (s: string) =>
  s.startsWith("./") || s === "../model.ts" || s === "react" || s === "@trame/web-api" || /^d3-[a-z]+$/.test(s);

test("the web side imports Trame only through @trame/web-api", () => {
  const bad: string[] = [];
  const root = new URL("./", import.meta.url);
  for (const name of readdirSync(root)) {
    if (!/\.tsx?$/.test(name) || name.endsWith("_test.ts")) continue;
    const src = readFileSync(new URL(name, root), "utf8");
    const specs = [
      ...src.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gm),
      ...src.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g),
    ];
    for (const [, spec] of specs) if (!ok(spec)) bad.push(`${name}: ${spec}`);
  }
  expect(bad).toEqual([]);
});
