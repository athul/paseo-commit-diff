/**
 * Forge URLs for "open in browser". The daemon has already reduced the remote
 * to `https://host/org/repo` with credentials stripped (repo.resolve `web`).
 */
export interface RepoWeb {
  url: string;
  forge: "github" | "gitlab" | "other";
}

export type WebTarget =
  | { kind: "commit"; sha: string }
  | { kind: "blob"; rev: string; path: string }
  | { kind: "compare"; base: string; head: string };

/** GitHub-style paths for github/other; GitLab puts them under `/-/`. */
export function webUrl(web: RepoWeb, target: WebTarget): string {
  const base = web.forge === "gitlab" ? `${web.url}/-` : web.url;
  switch (target.kind) {
    case "commit":
      return `${base}/commit/${target.sha}`;
    case "blob":
      return `${base}/blob/${encodeURIComponent(target.rev)}/${target.path.split("/").map(encodeURIComponent).join("/")}`;
    case "compare":
      return `${base}/compare/${encodeRef(target.base)}...${encodeRef(target.head)}`;
  }
}

/** Keep "/" in branch names readable; escape everything else. A remote prefix is the user's ref as typed. */
function encodeRef(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}
