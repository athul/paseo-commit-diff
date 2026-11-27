import { resolveSyntaxColors } from "@getpaseo/highlight";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { discoverRepos } from "./server/discover";
import {
  fileDiff, fileLines, listCommits, listRefs, patchText, resolveRepo, showCommit, showRange, watchRepo,
} from "./server/git";
import {
  appearanceSettings,
  discoverReposRpc,
  fileDiffRpc,
  fileLinesRpc,
  listCommitsRpc,
  listRefsRpc,
  patchRpc,
  recentReposSettings,
  resolveRepoRpc,
  showCommitRpc,
  showRangeRpc,
  syntaxPaletteRpc,
  watchRepoSubscription,
} from "./shared/git";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(recentReposSettings);
  server.registerSettings(appearanceSettings);
  server.handle(resolveRepoRpc, resolveRepo);
  server.handle(discoverReposRpc, discoverRepos);
  server.handle(listRefsRpc, listRefs);
  server.handle(listCommitsRpc, listCommits);
  server.handle(showCommitRpc, showCommit);
  server.handle(showRangeRpc, showRange);
  server.handle(fileDiffRpc, fileDiff);
  server.handle(fileLinesRpc, fileLines);
  server.handle(patchRpc, patchText);
  server.handle(watchRepoSubscription, watchRepo);
  server.handle(syntaxPaletteRpc, ({ theme, scheme }) => ({ colors: resolveSyntaxColors(theme, scheme) }));
  return () => {};
}
