// Deployed build identity: which commit is live? (F4, #63)
//
// The commit hash is baked at build time via esbuild --define:
//   --define:__BUILD_COMMIT__='"<short-hash>"'
//
// Anything without a baked hash (vitest, `wrangler dev`, a build outside
// git) reports honestly as local/dev instead of inventing a hash.

declare const __BUILD_COMMIT__: string | undefined;

function bakedCommit(): string {
  try {
    if (typeof __BUILD_COMMIT__ !== "undefined" && __BUILD_COMMIT__) {
      return __BUILD_COMMIT__;
    }
  } catch {
    // ReferenceError outside the bundle: fall through to local.
  }
  return "local";
}

export const BUILD_COMMIT: string = bakedCommit();

export interface BuildInfo {
  commit: string;
  /** True when no commit was baked in (local/dev build). */
  local: boolean;
}

export function buildInfo(): BuildInfo {
  const commit = bakedCommit();
  return { commit, local: commit === "local" || commit === "dev" };
}
