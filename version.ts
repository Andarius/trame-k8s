// Plugin release identity: Trame compares VERSION with the latest GitHub release of REPO.
// src/mod.rs carries the same two constants; version_test.ts keeps them equal.
export const VERSION = "0.2.0";
export const REPO = "Andarius/trame-k8s";

/** Why a pushed tag cannot release this version, or null when it matches (`v` prefix optional). */
export function tagMismatch(tag: string, version = VERSION): string | null {
  const bare = tag.replace(/^refs\/tags\//, "").replace(/^v/, "");
  return bare === version ? null : `tag ${tag} does not match plugin version ${version} (version.ts)`;
}

if (import.meta.main) {
  const error = tagMismatch(process.argv[2] ?? "");
  if (error) {
    console.error(error);
    process.exit(1);
  }
}
