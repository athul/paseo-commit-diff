/**
 * "Open repository" picker, modelled on Paseo's Add project > existing-folder
 * tab (packages/app/src/add-project-flow/existing-tab.tsx, result-list.tsx): a
 * search field ("Search folders or enter a path"), a card of result rows with
 * a folder icon, name and shortened path, an active row, Enter to open.
 *
 * Suggestions: this workspace, Paseo's projects, folders this workspace's
 * agents work in, recent repos (removable), then git repositories the daemon
 * found under the home folder. Paseo's own directory search and its native
 * Browse dialog are not exposed to plugins, hence the daemon-side discovery.
 */
import { useRpc } from "@getpaseo/plugin/client";
import { FlatList, Icon, Loading, Modal, TextInput } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { discoverReposRpc } from "../shared/git";
import { mergeOptions, rankRepos, type RepoOption, type RepoSource, shortenPath } from "../shared/repo-match";
import { IconButton, RADIUS, SPACE } from "./row";
import { type Theme, UI, UI_SIZE, UI_SMALL } from "./style";

const SOURCE_ICON: Record<RepoSource, string> = {
  typed: "CornerDownLeft", workspace: "Monitor", project: "FolderGit2", agent: "Bot", recent: "History", found: "Folder",
};
const SOURCE_LABEL: Partial<Record<RepoSource, string>> = {
  workspace: "This workspace", project: "Project", agent: "Agent", recent: "Recent",
};

export function RepoPicker({ open, onClose, onOpen, onRemoveRecent, current, workspaceDir, projectDirs, agentDirs, recent, theme, compact }: {
  open: boolean;
  onClose: () => void;
  onOpen: (path: string) => void;
  onRemoveRecent: (path: string) => void;
  current: string | null;
  workspaceDir: string | null;
  projectDirs: readonly string[];
  agentDirs: readonly string[];
  recent: readonly string[];
  theme: Theme;
  compact: boolean;
}) {
  const c = theme.colors;
  const discover = useRpc(discoverReposRpc);
  const found = useQuery({ queryKey: ["repos-discover"], queryFn: () => discover({}), enabled: open, staleTime: 60_000 });
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const home = found.data?.home ?? null;

  const options = useMemo(() => {
    const as = (paths: readonly (string | null)[], source: RepoSource): RepoOption[] =>
      paths.filter((path): path is string => Boolean(path)).map((path) => ({ path, source }));
    const merged = mergeOptions([
      as([workspaceDir], "workspace"),
      as(projectDirs, "project"),
      as(agentDirs, "agent"),
      as(recent, "recent"),
      as(found.data?.repos ?? [], "found"),
    ]);
    return rankRepos(merged, query);
  }, [workspaceDir, projectDirs, agentDirs, recent, found.data, query]);
  const index = Math.min(active, Math.max(0, options.length - 1));

  const choose = (option: RepoOption | undefined) => {
    if (!option) return;
    onOpen(option.path);
    close();
  };
  const close = () => {
    setQuery("");
    setActive(0);
    onClose();
  };
  // Arrow keys move the active row (web keyboards; harmless elsewhere).
  const onKeyPress = (event: { nativeEvent: { key: string }; preventDefault?: () => void }) => {
    const key = event.nativeEvent.key;
    if (key !== "ArrowDown" && key !== "ArrowUp") return;
    event.preventDefault?.();
    setActive((prev) => (key === "ArrowDown" ? Math.min(options.length - 1, prev + 1) : Math.max(0, prev - 1)));
  };

  return (
    <Modal title="Open repository" open={open} onOpenChange={(next) => !next && close()}>
      <Modal.Content scrollable={false} contentContainerStyle={{ padding: SPACE[3], gap: SPACE[3] }} style={{ height: compact ? 520 : 480 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE[2], paddingHorizontal: SPACE[3], height: 36, borderWidth: 1, borderColor: c.border, borderRadius: RADIUS.md, backgroundColor: c.surface1 }}>
          <Icon name="Search" size={16} color={c.foregroundMuted} />
          <TextInput
            value={query}
            onChangeText={(text) => { setQuery(text); setActive(0); }}
            onKeyPress={onKeyPress}
            onSubmitEditing={() => choose(options[index])}
            placeholder="Search folders or enter a path"
            placeholderTextColor={c.foregroundMuted}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="go"
            accessibilityLabel="Search folders"
            style={{ flex: 1, color: c.foreground, fontFamily: UI, fontSize: UI_SIZE, borderWidth: 0, paddingVertical: 0 }}
          />
        </View>
        {found.isPending && options.length === 0 ? <Loading /> : (
          <View style={{ flex: 1, borderWidth: 1, borderColor: c.border, borderRadius: RADIUS.lg, overflow: "hidden" }}>
            <FlatList
              data={options}
              keyExtractor={(option: RepoOption) => `${option.source}:${option.path}`}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={
                <View style={{ alignItems: "center", gap: SPACE[2], padding: SPACE[4] }}>
                  <Icon name="FolderSearch" size={20} color={c.foregroundMuted} />
                  <Text style={{ color: c.foregroundMuted, fontFamily: UI, fontSize: UI_SIZE }}>
                    {found.isError ? "Unable to search folders" : query.trim() ? "No matching folders" : "No folders yet"}
                  </Text>
                </View>
              }
              renderItem={({ item, index: i }: { item: RepoOption; index: number }) => (
                <ResultRow
                  option={item}
                  active={i === index}
                  current={item.path === current}
                  home={home}
                  theme={theme}
                  onPress={() => choose(item)}
                  onHover={() => setActive(i)}
                  onRemove={item.source === "recent" ? () => onRemoveRecent(item.path) : null}
                />
              )}
            />
          </View>
        )}
        {found.data?.truncated ? (
          <Text style={{ color: c.foregroundMuted, fontFamily: UI, fontSize: UI_SMALL }}>
            Some deep folders were not searched. Type a full path to open one.
          </Text>
        ) : null}
      </Modal.Content>
    </Modal>
  );
}

/** result-list.tsx row: 12px padding, 12px gap, icon slot, title + muted subtitle, surface2 when active. */
function ResultRow({ option, active, current, home, theme, onPress, onHover, onRemove }: {
  option: RepoOption;
  active: boolean;
  current: boolean;
  home: string | null;
  theme: Theme;
  onPress: () => void;
  onHover: () => void;
  onRemove: (() => void) | null;
}) {
  const c = theme.colors;
  const [hovered, setHovered] = useState(false);
  const short = shortenPath(option.path, home);
  const name = option.source === "typed" ? short : option.path.split("/").filter(Boolean).pop() ?? option.path;
  const subtitle = option.source === "typed" ? "Open this path" : short;
  const label = SOURCE_LABEL[option.source];
  return (
    <View
      style={{ flexDirection: "row", alignItems: "center", backgroundColor: active ? c.surface2 : "transparent" }}
      onPointerEnter={() => { setHovered(true); onHover(); }}
      onPointerLeave={() => setHovered(false)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${option.path}`}
        accessibilityState={{ selected: active }}
        onPress={onPress}
        style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: SPACE[3], paddingVertical: 10, paddingHorizontal: SPACE[3] }}
      >
        <Icon name={SOURCE_ICON[option.source]} size={16} color={active ? c.foreground : c.foregroundMuted} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: c.foreground, fontFamily: UI, fontSize: UI_SIZE }} numberOfLines={1}>{name}</Text>
          <Text style={{ color: c.foregroundMuted, fontFamily: UI, fontSize: UI_SMALL }} numberOfLines={1}>{subtitle}</Text>
        </View>
        {current ? <Icon name="Check" size={14} color={c.accent} /> : null}
        {label ? <Text style={{ color: c.foregroundMuted, fontFamily: UI, fontSize: UI_SMALL }}>{label}</Text> : null}
      </Pressable>
      {onRemove ? (
        <View style={{ paddingRight: SPACE[2], opacity: hovered || active ? 1 : 0 }}>
          <IconButton theme={theme} icon="X" label={`Remove ${option.path} from recent`} onPress={onRemove} />
        </View>
      ) : null}
    </View>
  );
}
