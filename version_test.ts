import { expect, test } from "bun:test";
import { tagMismatch } from "./version.ts";

// the release workflow refuses a tag that would publish a release under the wrong version
test.each([
  { id: "v-prefixed tag", tag: "v0.1.0", ok: true },
  { id: "bare tag", tag: "0.1.0", ok: true },
  { id: "full ref", tag: "refs/tags/v0.1.0", ok: true },
  { id: "other version", tag: "v0.2.0", ok: false },
  { id: "prerelease suffix", tag: "v0.1.0-rc.1", ok: false },
  { id: "empty tag", tag: "", ok: false },
])("$id", ({ tag, ok }) => {
  expect(tagMismatch(tag, "0.1.0") === null).toBe(ok);
});
