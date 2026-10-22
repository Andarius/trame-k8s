// Plugin release identity: Trame compares VERSION with the latest GitHub release of REPO.
export const VERSION = "0.1.0";
export const REPO = "Getsoren/trame-k8s";

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
