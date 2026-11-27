import type { PluginClientContext } from "@getpaseo/plugin/client";
import { CommitDiffPanel } from "./client/panel";
import { SettingsScreen } from "./client/settings";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "commits",
    title: "Commits",
    icon: "GitCommitHorizontal",
    context: "workspace",
    Component: CommitDiffPanel,
  });
  client.addCommandCenterItem({
    id: "open-commits",
    title: "Open commit diffs",
    icon: "GitCommitHorizontal",
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("commits");
    },
  });
  client.addSettingsScreen({
    id: "settings",
    title: "Commit Diff",
    icon: "GitCommitHorizontal",
    Component: SettingsScreen,
  });
  return () => {};
}
