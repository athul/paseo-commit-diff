/**
 * "Commits" workspace tab: pick any repo (the workspace's directory, a folder an
 * agent here works in, or a recent one), browse a branch/tag's history with
 * search, and open a commit or a range (`base...head`) as a diff.
 *
 * Per tab (`useTabState`): repo, ref, filter, selected commit or range, so two
 * tabs can watch two repos. Across workspaces: recently opened repos.
 *
 * Live: a daemon-side watcher on .git (HEAD, refs, packed-refs) invalidates the
 * queries, so a commit, checkout or fetch shows up at once with no polling.
 *
 * Built from Paseo's own pieces where a panel can use them (`Loading`, `Icon`,
 * `Modal`, `TextInput`, `FlatList`) and Paseo's list-row geometry (./row)
 * where it cannot. Font families are inline: in Paseo's web host a fontFamily
 * set via StyleSheet.create does not take effect.
 */
import {
  type PluginWorkspacePanelProps,
  useAgents,
  useRpc,
  useSettings,
  useSubscription,
  useTabState,
  useWorkspace,
} from "@getpaseo/plugin/client";
import { FlatList, Icon, Loading, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { z } from "zod";
import {
  type Commit,
  type DiffTarget,
  listCommitsRpc,
  recentReposSettings,
  resolveRepoRpc,
  watchRepoSubscription,
} from "../shared/git";
import { parseFilter } from "../shared/diff-model";
import { CommitView } from "./commit-view";
import { RefPicker } from "./ref-picker";
import { IconButton, Notice, RADIUS, Row, SPACE } from "./row";
import { ago, type CodeFont, dayLabel, formatCount, fullDate, shortSha, type Theme, UI, UI_SIZE, UI_SMALL, useCodeFont } from "./style";

const PAGE = 50;
const TabState = z.object({
  repo: z.string().nullable(),
  ref: z.string().nullable(),
  sha: z.string().nullable(),
  range: z.object({ base: z.string(), head: z.string() }).nullable(),
  filter: z.string(),
});
type TabState = z.infer<typeof TabState>;
const EMPTY: TabState = { repo: null, ref: null, sha: null, range: null, filter: "" };

/** Compare-mode progress: nothing picked yet, or the base chosen. */
type Compare = { base: string | null } | null;

export function CommitDiffPanel({ workspaceId, theme, layout, tab }: PluginWorkspacePanelProps) {
  const directory = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const [stored, setStored] = useTabState(tab, TabState, EMPTY);
  const state = { ...EMPTY, ...stored };
  const update = (patch: Partial<TabState>) => setStored({ ...state, ...patch });
  const repoPath = state.repo ?? directory;
  const font = useCodeFont();
  const s = useStyles(theme);
  const queryClient = useQueryClient();
  const [compare, setCompare] = useState<Compare>(null);
  const [order, setOrder] = useState<readonly string[]>([]);

  const resolve = useRpc(resolveRepoRpc);
  const repo = useQuery({
    queryKey: ["repo", repoPath],
    queryFn: () => resolve({ path: repoPath ?? "" }),
    enabled: Boolean(repoPath),
    retry: false,
  });
  const root = repo.data?.root ?? null;
  useRememberRepo(root);

  // Live updates from the daemon's .git watcher; fall back to polling if it fails.
  const watch = useSubscription(watchRepoSubscription, { repo: root ?? "/" }, () => {
    if (!root) return;
    void queryClient.invalidateQueries({ queryKey: ["commits", root] });
    void queryClient.invalidateQueries({ queryKey: ["refs", root] });
    void queryClient.invalidateQueries({ queryKey: ["repo", repoPath] });
    void queryClient.invalidateQueries({ queryKey: ["diff", root] });
  });
  const pollFallback = watch.status === "error" || watch.status === "closed" ? 30_000 : false;

  const open = (path: string) => { setCompare(null); update({ repo: path, ref: null, sha: null, range: null, filter: "" }); };
  const select = (sha: string | null) => update({ sha, range: null });
  const pickInList = (sha: string) => {
    if (!compare) return select(sha);
    if (!compare.base) return setCompare({ base: sha });
    setCompare(null);
    update({ sha: null, range: { base: compare.base, head: sha } });
  };

  // j / k: next / previous commit (web; ignored while typing in an input).
  const onKeyDown = (event: { nativeEvent: { key?: string; target?: { tagName?: string } }; preventDefault?: () => void }) => {
    const key = event.nativeEvent.key;
    const tag = event.nativeEvent.target?.tagName;
    if ((key !== "j" && key !== "k") || tag === "INPUT" || tag === "TEXTAREA" || order.length === 0) return;
    const at = state.sha ? order.indexOf(state.sha) : -1;
    const next = key === "j" ? Math.min(order.length - 1, at + 1) : Math.max(0, at - 1);
    const sha = order[next];
    if (sha) { event.preventDefault?.(); select(sha); }
  };
  const keyboard = Platform.OS === "web" ? ({ onKeyDown } as object) : {};

  const target: DiffTarget | null = state.range
    ? { kind: "range", base: state.range.base, head: state.range.head }
    : state.sha ? { kind: "commit", sha: state.sha } : null;

  const list = root ? (
    <CommitList
      root={root}
      branch={repo.data?.branch ?? null}
      defaultBranch={repo.data?.defaultBranch ?? null}
      gitRef={state.ref}
      filter={state.filter}
      selected={layout.compact ? null : state.sha}
      compare={compare}
      pollMs={pollFallback}
      onCompare={setCompare}
      onRange={(base, head) => { setCompare(null); update({ sha: null, range: { base, head } }); }}
      onRef={(ref) => update({ ref, sha: null })}
      onFilter={(filter) => update({ filter })}
      onSelect={pickInList}
      onOrder={setOrder}
      theme={theme}
      compact={layout.compact}
      font={font}
      s={s}
    />
  ) : null;
  const detail = root && target ? (
    <CommitView
      key={`${root}:${JSON.stringify(target)}`}
      repo={root}
      target={target}
      web={repo.data?.web ?? null}
      theme={theme}
      compact={layout.compact}
      onBack={layout.compact ? () => update({ sha: null, range: null }) : null}
      onOpenCommit={(sha) => update({ sha, range: null })}
      onFileHistory={(path) => update({ filter: `path:${/\s/.test(path) ? `"${path}"` : path}` })}
    />
  ) : null;

  let body;
  if (repo.isError) body = <Notice theme={theme} icon="CircleAlert" tone="danger" text={repo.error.message} />;
  else if (!list) body = <Loading />;
  else if (layout.compact) body = detail ?? list;
  else {
    body = (
      <View style={s.split}>
        <View style={s.listPane}>{list}</View>
        <View style={s.flex}>
          {detail ?? <Notice theme={theme} icon="GitCommitHorizontal" text="Select a commit to see its changes" />}
        </View>
      </View>
    );
  }

  return (
    <View style={s.screen} {...keyboard}>
      <RepoBar
        workspaceId={workspaceId}
        current={repoPath}
        directory={directory}
        onOpen={open}
        theme={theme}
        compact={layout.compact}
        font={font}
        s={s}
      />
      {body}
    </View>
  );
}

/** Path box plus one-tap rows: workspace directory, agents' folders, recent repos. */
function RepoBar({ workspaceId, current, directory, onOpen, theme, compact, font, s }: {
  workspaceId: string;
  current: string | null;
  directory: string | null;
  onOpen: (path: string) => void;
  theme: Theme;
  compact: boolean;
  font: CodeFont;
  s: Styles;
}) {
  const [draft, setDraft] = useState(current ?? "");
  useEffect(() => setDraft(current ?? ""), [current]);
  const settings = useSettings(recentReposSettings);
  const recent = settings.status === "ready" ? settings.values.repos : [];
  // Folders this workspace's agents work in (grouped by cwd: one key per folder).
  const agentGroups = useAgents({ where: (agent) => agent.workspaceId === workspaceId, groupBy: (agent) => agent.cwd });
  const agentDirs = agentGroups.map((group) => group.key).filter((dir) => dir && dir !== directory);
  const chips: { path: string; icon: string; hint: string }[] = [];
  const seen = new Set<string>();
  const add = (path: string | null, icon: string, hint: string) => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    chips.push({ path, icon, hint });
  };
  add(directory, "Monitor", "workspace");
  for (const dir of agentDirs) add(dir, "Bot", "agent");
  for (const path of recent) add(path, "FolderGit2", "recent");

  return (
    <View style={s.bar}>
      <View style={s.inputBox}>
        <Icon name="FolderGit2" size={14} color={theme.colors.foregroundMuted} />
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={() => draft.trim() && onOpen(draft.trim())}
          placeholder="Repository path, then Enter"
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="go"
          accessibilityLabel="Repository path"
          style={[s.input, { fontFamily: font.family, fontSize: font.size }]}
        />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
        {chips.map(({ path, icon, hint }) => {
          const active = path === current;
          return (
            <Row key={path} theme={theme} compact={compact} label={`Open ${path} (${hint})`} selected={active} onPress={() => onOpen(path)} style={s.chip}>
              <Icon name={icon} size={14} color={active ? theme.colors.foreground : theme.colors.foregroundMuted} />
              <Text style={[s.chipText, { fontFamily: UI }, active && s.foreground]} numberOfLines={1}>{basename(path)}</Text>
            </Row>
          );
        })}
      </ScrollView>
    </View>
  );
}

type Item = { type: "day"; key: string; label: string } | { type: "commit"; key: string; commit: Commit };

function CommitList(props: {
  root: string;
  branch: string | null;
  defaultBranch: string | null;
  gitRef: string | null;
  filter: string;
  selected: string | null;
  compare: Compare;
  pollMs: number | false;
  onCompare: (compare: Compare) => void;
  onRange: (base: string, head: string) => void;
  onRef: (ref: string | null) => void;
  onFilter: (filter: string) => void;
  onSelect: (sha: string) => void;
  onOrder: (order: readonly string[]) => void;
  theme: Theme;
  compact: boolean;
  font: CodeFont;
  s: Styles;
}) {
  const { root, branch, defaultBranch, gitRef, selected, compare, theme, compact, font, s } = props;
  const c = theme.colors;
  const list = useRpc(listCommitsRpc);
  const filter = useMemo(() => parseFilter(props.filter), [props.filter]);
  const ref = gitRef ?? undefined;
  const commits = useInfiniteQuery({
    queryKey: ["commits", root, ref ?? "HEAD", filter],
    queryFn: ({ pageParam }) => list({ repo: root, ref, filter, skip: pageParam, limit: PAGE }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.commits.length < PAGE ? undefined : pages.length * PAGE),
    refetchInterval: props.pollMs,
  });
  const first = commits.data?.pages[0];
  const unpushed = useMemo(() => new Set(first?.unpushed ?? []), [first]);
  const flat = useMemo(() => commits.data?.pages.flatMap((page) => page.commits) ?? [], [commits.data]);
  const items = useMemo(() => {
    const result: Item[] = [];
    let day = "";
    for (const commit of flat) {
      const label = dayLabel(commit.date);
      if (label !== day) result.push({ type: "day", key: `day-${label}-${commit.sha}`, label: (day = label) });
      result.push({ type: "commit", key: commit.sha, commit });
    }
    return result;
  }, [flat]);
  const { onOrder } = props;
  useEffect(() => onOrder(flat.map((commit) => commit.sha)), [flat, onOrder]);

  const [search, setSearch] = useState(props.filter);
  useEffect(() => setSearch(props.filter), [props.filter]);
  const { onFilter } = props;
  useEffect(() => {
    if (search === props.filter) return undefined;
    const timer = setTimeout(() => onFilter(search), 300);
    return () => clearTimeout(timer);
  }, [search, props.filter, onFilter]);

  const [picker, setPicker] = useState<"ref" | "base" | "head" | null>(null);
  const headRef = gitRef ?? branch ?? "HEAD";

  const header = (
    <View style={s.listHeader}>
      <View style={s.toolbar}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Branch or tag: ${headRef}`} onPress={() => setPicker("ref")} style={s.refButton}>
          <Icon name={gitRef && gitRef.includes("/") ? "Cloud" : "GitBranch"} size={14} color={c.foregroundMuted} />
          <Text style={[s.refText, { fontFamily: UI }]} numberOfLines={1}>{headRef}</Text>
          <Icon name="ChevronDown" size={12} color={c.foregroundMuted} />
        </Pressable>
        <View style={s.flex} />
        <IconButton theme={theme} icon="GitCompareArrows" label="Compare two commits or branches" active={compare !== null} onPress={() => props.onCompare(compare ? null : { base: null })} />
        <IconButton theme={theme} icon="RefreshCw" label="Refresh commits" onPress={() => void commits.refetch()} />
      </View>
      <View style={s.inputBox}>
        <Icon name="Search" size={14} color={c.foregroundMuted} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search · author:name · path:file"
          placeholderTextColor={c.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Search commits"
          style={[s.input, { fontFamily: UI, fontSize: UI_SMALL + 1 }]}
        />
        {search ? <IconButton theme={theme} icon="X" label="Clear search" onPress={() => { setSearch(""); onFilter(""); }} /> : null}
      </View>
      {compare ? (
        <View style={s.compareBanner}>
          <Text style={[s.meta, { fontFamily: UI, color: c.foreground }]}>
            {compare.base ? "Now pick the head commit, or:" : "Pick the base commit, or:"}
          </Text>
          <View style={s.compareActions}>
            {!compare.base && defaultBranch && defaultBranch !== headRef ? (
              <IconButton theme={theme} icon="GitPullRequest" text={`${headRef} vs ${defaultBranch}`} label={`Compare ${headRef} with ${defaultBranch}`} onPress={() => props.onRange(defaultBranch, headRef)} />
            ) : null}
            {!compare.base ? <IconButton theme={theme} icon="GitBranch" text="Base branch…" label="Pick the base from branches and tags" onPress={() => setPicker("base")} /> : null}
            {compare.base ? <IconButton theme={theme} icon="GitBranch" text={`Head: ${headRef}`} label={`Use ${headRef} as head`} onPress={() => props.onRange(compare.base ?? "", headRef)} /> : null}
            {compare.base ? <IconButton theme={theme} icon="GitBranch" text="Head branch…" label="Pick the head from branches and tags" onPress={() => setPicker("head")} /> : null}
            <IconButton theme={theme} icon="X" text="Cancel" label="Cancel compare" onPress={() => props.onCompare(null)} />
          </View>
          {compare.base ? <Text style={[s.meta, { fontFamily: UI }]}>Base: <Text style={{ fontFamily: font.family }}>{/^[0-9a-f]{40}$/.test(compare.base) ? shortSha(compare.base) : compare.base}</Text></Text> : null}
        </View>
      ) : null}
      {first?.upstream && unpushed.size > 0 ? (
        <View style={s.branchRow}>
          <Icon name="ArrowUpFromLine" size={12} color={c.statusWarning} />
          <Text style={[s.meta, { fontFamily: UI }]}>{unpushed.size}{unpushed.size >= 500 ? "+" : ""} not on {first.upstream}</Text>
        </View>
      ) : null}
    </View>
  );

  const pickerNode = (
    <RefPicker
      repo={root}
      open={picker !== null}
      title={picker === "base" ? "Compare: base" : picker === "head" ? "Compare: head" : "Branch or tag"}
      current={picker === "ref" ? headRef : null}
      onClose={() => setPicker(null)}
      onPick={(name) => {
        if (picker === "ref") props.onRef(name === branch ? null : name);
        else if (picker === "base") props.onCompare({ base: name });
        else if (picker === "head" && compare?.base) props.onRange(compare.base, name);
      }}
      theme={theme}
      compact={compact}
      font={font}
    />
  );

  if (commits.isPending) return <View style={s.flex}>{header}<Loading />{pickerNode}</View>;

  return (
    <View style={s.flex}>
      <FlatList
        data={items}
        keyExtractor={(item: Item) => item.key}
        contentContainerStyle={s.listContent}
        ListHeaderComponent={header}
        ListEmptyComponent={
          commits.isError
            ? <Notice theme={theme} icon="CircleAlert" tone="danger" text={commits.error.message} />
            : <Notice theme={theme} icon={props.filter ? "SearchX" : "GitCommitHorizontal"} text={props.filter ? "No commits match" : "No commits yet"} />
        }
        renderItem={({ item }: { item: Item }) => {
          if (item.type === "day") return <Text style={[s.day, { fontFamily: UI }]}>{item.label}</Text>;
          const commit = item.commit;
          const active = commit.sha === selected || commit.sha === compare?.base;
          const merge = commit.parents.length > 1;
          const pending = unpushed.has(commit.sha);
          return (
            <Row theme={theme} compact={compact} label={`Commit ${commit.subject}`} selected={active} onPress={() => props.onSelect(commit.sha)}>
              {({ hovered }) => (
                <>
                  <View style={s.iconBox}>
                    <Icon name={merge ? "GitMerge" : "GitCommitHorizontal"} size={14} color={active ? c.foreground : c.foregroundMuted} />
                  </View>
                  <View style={s.flex}>
                    <Text style={[s.subject, { fontFamily: UI }]} numberOfLines={2}>{commit.subject}</Text>
                    <View style={s.metaLine}>
                      <Text style={[s.sha, { fontFamily: font.family }]}>{shortSha(commit.sha)}</Text>
                      <Text style={[s.meta, s.flex, { fontFamily: UI }]} numberOfLines={1}>
                        {commit.author} · {hovered ? fullDate(commit.date) : ago(commit.date)}
                      </Text>
                    </View>
                    {pending || commit.stats ? (
                      <View style={s.metaLine}>
                        {pending ? (
                          <View style={s.badge}>
                            <Icon name="ArrowUp" size={10} color={c.statusWarning} />
                            <Text style={[s.badgeText, { fontFamily: UI }]}>unpushed</Text>
                          </View>
                        ) : null}
                        {commit.stats ? (
                          <Text style={[s.meta, { fontFamily: UI }]}>
                            {commit.stats.files} file{commit.stats.files === 1 ? "" : "s"}{"  "}
                            <Text style={{ color: c.statusSuccess }}>+{formatCount(commit.stats.additions)}</Text>{" "}
                            <Text style={{ color: c.statusDanger }}>-{formatCount(commit.stats.deletions)}</Text>
                          </Text>
                        ) : null}
                      </View>
                    ) : null}
                  </View>
                </>
              )}
            </Row>
          );
        }}
        onEndReachedThreshold={0.5}
        onEndReached={() => commits.hasNextPage && !commits.isFetchingNextPage && commits.fetchNextPage()}
        ListFooterComponent={commits.isFetchingNextPage ? <ActivityIndicator style={s.footer} color={c.foregroundMuted} /> : null}
      />
      {pickerNode}
    </View>
  );
}

/** Move a successfully opened repo to the front of the shared recent list. */
function useRememberRepo(root: string | null) {
  const settings = useSettings(recentReposSettings);
  const attempted = useRef<string | null>(null);
  useEffect(() => {
    if (!root || settings.status !== "ready" || settings.saving) return;
    const repos = settings.values.repos;
    // One attempt per repo: a failed save must not retry on every render.
    if (repos[0] === root || attempted.current === root) return;
    attempted.current = root;
    void settings.save({ repos: [root, ...repos.filter((path) => path !== root)].slice(0, 10) }, settings.revision);
  }, [root, settings]);
}

function basename(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

type Styles = ReturnType<typeof useStyles>;

function useStyles(theme: Theme) {
  return useMemo(() => {
    const c = theme.colors;
    return StyleSheet.create({
      screen: { flex: 1, backgroundColor: c.surface0 },
      flex: { flex: 1, minWidth: 0 },
      split: { flex: 1, flexDirection: "row" },
      listPane: { width: 360, borderRightWidth: 1, borderRightColor: c.border },
      bar: { paddingHorizontal: SPACE[3], paddingVertical: SPACE[2], gap: SPACE[2], borderBottomWidth: 1, borderBottomColor: c.border },
      inputBox: {
        flexDirection: "row", alignItems: "center", gap: SPACE[2],
        paddingLeft: SPACE[2], paddingRight: SPACE[0.5], height: 32,
        borderWidth: 1, borderColor: c.border, borderRadius: RADIUS.md, backgroundColor: c.surface1,
      },
      input: { flex: 1, color: c.foreground, paddingVertical: 0, borderWidth: 0 },
      chips: { gap: SPACE[1] },
      chip: { alignItems: "center", minHeight: 28, paddingVertical: SPACE[1], maxWidth: 240 },
      chipText: { color: c.foregroundMuted, fontSize: UI_SMALL },
      foreground: { color: c.foreground },
      listContent: { paddingHorizontal: SPACE[2], paddingBottom: SPACE[2], gap: SPACE[0.5] },
      listHeader: { gap: SPACE[2], paddingHorizontal: SPACE[1], paddingTop: SPACE[2], paddingBottom: SPACE[1] },
      toolbar: { flexDirection: "row", alignItems: "center", gap: SPACE[1] },
      refButton: {
        flexDirection: "row", alignItems: "center", gap: SPACE[1.5], height: 28, maxWidth: 220,
        paddingHorizontal: SPACE[2], borderRadius: RADIUS.md, borderWidth: 1, borderColor: c.border,
      },
      refText: { color: c.foreground, fontSize: UI_SMALL + 1, flexShrink: 1 },
      compareBanner: { gap: SPACE[1.5], padding: SPACE[2], borderRadius: RADIUS.lg, backgroundColor: c.surface1 },
      compareActions: { flexDirection: "row", flexWrap: "wrap", gap: SPACE[1], marginLeft: -SPACE[1] },
      branchRow: { flexDirection: "row", alignItems: "center", gap: SPACE[1], paddingHorizontal: SPACE[1] },
      day: { color: c.foregroundMuted, fontSize: UI_SMALL, fontWeight: "600", paddingHorizontal: SPACE[2], paddingTop: SPACE[3], paddingBottom: SPACE[1] },
      iconBox: { height: 20, justifyContent: "center" },
      subject: { color: c.foreground, fontSize: UI_SIZE, lineHeight: 20 },
      metaLine: { flexDirection: "row", alignItems: "center", gap: SPACE[2] },
      meta: { color: c.foregroundMuted, fontSize: UI_SMALL, lineHeight: 18 },
      sha: { color: c.foregroundMuted, fontSize: UI_SMALL },
      badge: {
        flexDirection: "row", alignItems: "center", gap: 2, paddingHorizontal: SPACE[1], height: 16,
        borderRadius: RADIUS.sm, borderWidth: 1, borderColor: c.statusWarning,
      },
      badgeText: { color: c.statusWarning, fontSize: 10, fontWeight: "500" },
      footer: { padding: SPACE[3] },
    });
  }, [theme]);
}
