/**
 * One commit, or a range (`base...head`, like a pull request), laid out like a
 * GitHub/GitLab page: a header, the changed files as a folder tree, then each
 * file's diff under a sticky header.
 *
 * The diff rows copy Paseo's built-in viewer (packages/app/src/git/diff-document):
 * one line-number gutter (or two columns in split view) coloured by change, a
 * 1px divider, code without +/- markers on a 15% green / 10% red wash, word-level
 * changes on a stronger wash, syntax colours from @getpaseo/highlight, and file
 * headers with name, muted directory, +N -N and a square change icon.
 *
 * Row layout is the pure shared/diff-model.ts; this file only draws rows and
 * fetches on demand: hidden context between hunks (file.lines) and the full
 * diff of a file that was cut for size (file.diff).
 *
 * Font families are inline on every monospace Text: in Paseo's web host a
 * fontFamily from StyleSheet.create does not take effect, while inline does.
 */
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { copyText, FlatList, Icon, Loading, Markdown, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { type FlatList as NativeFlatList, Pressable, StyleSheet, Text, View } from "react-native";
import {
  buildRows,
  type Cell,
  type DiffRow,
  type Expansion,
  type Gap,
  maxLineNumber,
  segments,
} from "../shared/diff-model";
import {
  type Commit,
  type DiffTarget,
  type FileDiff,
  fileDiffRpc,
  fileLinesRpc,
  patchRpc,
  showCommitRpc,
  showRangeRpc,
} from "../shared/git";
import { IconButton, Notice, Row as ListRow, SPACE } from "./row";
import {
  ago,
  type CodeFont,
  formatCount,
  fullDate,
  shortSha,
  tint,
  type Theme,
  UI,
  UI_SIZE,
  UI_SMALL,
  useCodeFont,
  useDiffPrefs,
  useSyntaxColors,
} from "./style";
import { type RepoWeb, webUrl } from "./web-links";

/** The view's own header, ahead of the model's rows. */
type Row = { kind: "head"; key: "head" } | DiffRow;

interface Loaded {
  files: FileDiff[];
  /** Revision whose file contents fill "show more context" (the new side). */
  contextRev: string;
  commit: (Commit & { body: string }) | null;
  range: { base: string; head: string; mergeBase: string; commits: Commit[] } | null;
}

const CHUNK = 500;

export function CommitView({ repo, target, web, theme, compact, onBack, onOpenCommit, onFileHistory }: {
  repo: string;
  target: DiffTarget;
  web: RepoWeb | null;
  theme: Theme;
  compact: boolean;
  onBack: (() => void) | null;
  onOpenCommit: (sha: string) => void;
  onFileHistory: (path: string) => void;
}) {
  const showCommit = useRpc(showCommitRpc);
  const showRange = useRpc(showRangeRpc);
  const loadFile = useRpc(fileDiffRpc);
  const loadLines = useRpc(fileLinesRpc);
  const loadPatch = useRpc(patchRpc);
  const query = useQuery({
    queryKey: ["diff", repo, target],
    queryFn: async (): Promise<Loaded> => {
      if (target.kind === "commit") {
        const { commit, files } = await showCommit({ repo, sha: target.sha });
        return { files, contextRev: commit.sha, commit, range: null };
      }
      const result = await showRange({ repo, base: target.base, head: target.head });
      return {
        files: result.files,
        contextRev: result.headSha,
        commit: null,
        range: { base: target.base, head: target.head, mergeBase: result.mergeBase, commits: result.commits },
      };
    },
    // A commit never changes; a range moves with its refs, refreshed by the repo watcher.
    staleTime: target.kind === "commit" ? Infinity : 0,
  });

  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set());
  const [expansions, setExpansions] = useState<ReadonlyMap<string, Expansion>>(new Map());
  const [overrides, setOverrides] = useState<ReadonlyMap<number, FileDiff>>(new Map());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [showAllCommits, setShowAllCommits] = useState(false);
  const list = useRef<NativeFlatList<Row>>(null);
  const toast = useToast();
  const font = useCodeFont();
  const prefs = useDiffPrefs();
  const layout = compact ? "unified" : prefs.layout;
  const syntax = useSyntaxColors(theme);
  const s = useStyles(theme, compact, font);

  const files = useMemo(
    () => (query.data?.files ?? []).map((file, index) => overrides.get(index) ?? file),
    [query.data, overrides],
  );
  const rows = useMemo<Row[]>(() => {
    if (!query.data) return [];
    return [{ kind: "head", key: "head" }, ...buildRows({
      files, collapsed, layout, expansions,
      canExpand: (file) => !file.binary && !file.truncated && file.lines !== null
        && (file.status === "modified" || file.status === "renamed" || file.status === "copied"),
    })];
  }, [query.data, files, collapsed, layout, expansions]);
  const gutters = useMemo(() => {
    const model = rows.filter((row): row is DiffRow => row.kind !== "head");
    const widths = new Map<number, number>();
    files.forEach((_, index) => widths.set(index, gutterWidth(maxLineNumber(model, index), font.size)));
    return widths;
  }, [files, rows, font.size]);
  const sticky = useMemo(() => rows.flatMap((row, index) => (row.kind === "file" ? [index] : [])), [rows]);
  const contentWidth = useMemo(
    () => (prefs.wrap ? null : estimateWidth(rows, gutters, font, layout)),
    [prefs.wrap, rows, gutters, font, layout],
  );

  if (query.isPending) return <Loading />;
  if (query.isError) return <Notice theme={theme} icon="CircleAlert" tone="danger" text={query.error.message} />;
  const loaded = query.data;
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const mono = { fontFamily: font.family };
  const ui = { fontFamily: UI };

  const withBusy = async (key: string, work: () => Promise<void>) => {
    if (busy.has(key)) return;
    setBusy((prev) => new Set(prev).add(key));
    try {
      await work();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };
  const toggle = (index: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(index)) next.add(index);
      return next;
    });
  const jumpTo = (index: number) => {
    const row = rows.findIndex((r) => r.kind === "file" && r.file === index);
    if (row >= 0) list.current?.scrollToIndex({ index: row, animated: true });
  };
  const expand = (file: number, gap: Gap) =>
    withBusy(gap.key, async () => {
      const path = files[file]?.path;
      if (!path) return;
      const want = Math.min(gap.count ?? CHUNK, CHUNK);
      const result = await loadLines({ repo, rev: loaded.contextRev, path, start: gap.newStart, end: gap.newStart + want - 1 });
      setExpansions((prev) => {
        const next = new Map(prev);
        const before = prev.get(gap.key);
        const beforeRuns = before?.runs ?? before?.lines.map(() => null) ?? [];
        const addedRuns = result.tokens ?? result.lines.map(() => null);
        next.set(gap.key, {
          lines: [...(before?.lines ?? []), ...result.lines],
          runs: before?.runs || result.tokens ? [...beforeRuns, ...addedRuns] : null,
          total: result.total,
        });
        return next;
      });
    });
  const loadFull = (index: number) =>
    withBusy(`load-${index}`, async () => {
      const path = files[index]?.path;
      if (!path) return;
      const { file } = await loadFile({ repo, target, path });
      if (!file) throw new Error("Could not load this file's diff");
      setOverrides((prev) => new Map(prev).set(index, file));
    });
  const copyPatch = () =>
    withBusy("patch", async () => {
      const { patch } = await loadPatch({ repo, target });
      await copyText(patch);
      toast.show("Patch copied");
    });
  const pageUrl = web
    ? target.kind === "commit"
      ? webUrl(web, { kind: "commit", sha: target.sha })
      : webUrl(web, { kind: "compare", base: target.base, head: target.head })
    : null;

  const actions = (
    <View style={s.actions}>
      <IconButton theme={theme} icon="ClipboardCopy" text="Copy patch" label="Copy the whole patch" onPress={() => void copyPatch()} disabled={busy.has("patch")} />
      {pageUrl ? (
        <IconButton theme={theme} icon="ExternalLink" text={web?.forge === "gitlab" ? "GitLab" : "GitHub"} label="Open in browser" onPress={() => void openExternalUrl(pageUrl)} />
      ) : null}
      <View style={s.flex} />
      {!compact ? (
        <IconButton
          theme={theme}
          icon={layout === "split" ? "Rows2" : "Columns2"}
          label={layout === "split" ? "Unified view" : "Side-by-side view"}
          active={layout === "split"}
          onPress={() => prefs.set({ diffLayout: layout === "split" ? "unified" : "split" })}
        />
      ) : null}
      <IconButton
        theme={theme}
        icon="WrapText"
        label={prefs.wrap ? "Scroll long lines" : "Wrap long lines"}
        active={prefs.wrap}
        onPress={() => prefs.set({ wrapLines: !prefs.wrap })}
      />
    </View>
  );

  const back = onBack ? (
    <View style={s.backRow}>
      <IconButton theme={theme} icon="ChevronLeft" label="Back to commits" text="Commits" onPress={onBack} />
    </View>
  ) : null;

  let header = null;
  if (loaded.commit) {
    const commit = loaded.commit;
    header = (
      <View style={s.header}>
        {back}
        <Text style={[s.subject, ui]} selectable>{commit.subject}</Text>
        {commit.body ? <Markdown>{commit.body}</Markdown> : null}
        <View style={s.metaRow}>
          <Icon name={commit.parents.length > 1 ? "GitMerge" : "GitCommitHorizontal"} size={14} color={theme.colors.foregroundMuted} />
          <Text style={[s.muted, ui]}>
            {commit.author} committed {ago(commit.date)} · {fullDate(commit.date)}
            {commit.parents.length > 1 ? ` · merge, diff against first parent ${shortSha(commit.parents[0] ?? "")}` : ""}
          </Text>
        </View>
        <View style={s.metaRow}>
          <Text style={[s.sha, mono]} selectable>{shortSha(commit.sha)}</Text>
          <IconButton
            theme={theme}
            icon="Copy"
            label={`Copy commit hash ${commit.sha}`}
            onPress={() => copyText(commit.sha).then(() => toast.show("Commit hash copied"), () => toast.error("Could not copy"))}
          />
          <Stats files={files.length} additions={additions} deletions={deletions} s={s} />
        </View>
        {actions}
      </View>
    );
  } else if (loaded.range) {
    const range = loaded.range;
    const count = range.commits.length;
    header = (
      <View style={s.header}>
        {back}
        <View style={s.metaRow}>
          <Icon name="GitCompareArrows" size={16} color={theme.colors.foregroundMuted} />
          <Text style={[s.subject, ui]}>Comparing</Text>
          <Text style={[s.refName, mono]}>{range.base}</Text>
          <Text style={[s.muted, ui]}>…</Text>
          <Text style={[s.refName, mono]}>{range.head}</Text>
        </View>
        <View style={s.metaRow}>
          <Text style={[s.muted, ui]}>{count}{count >= 500 ? "+" : ""} commit{count === 1 ? "" : "s"} · merge base</Text>
          <Text style={[s.sha, mono]}>{shortSha(range.mergeBase)}</Text>
          <Stats files={files.length} additions={additions} deletions={deletions} s={s} />
        </View>
        <View style={s.rangeCommits}>
          {(showAllCommits ? range.commits : range.commits.slice(0, 5)).map((commit) => (
            <ListRow key={commit.sha} theme={theme} compact={compact} label={`Open commit ${commit.subject}`} onPress={() => onOpenCommit(commit.sha)} style={s.rangeCommit}>
              <Icon name={commit.parents.length > 1 ? "GitMerge" : "GitCommitHorizontal"} size={14} color={theme.colors.foregroundMuted} />
              <Text style={[s.sha, mono]}>{shortSha(commit.sha)}</Text>
              <Text style={[s.rangeSubject, ui]} numberOfLines={1}>{commit.subject}</Text>
            </ListRow>
          ))}
          {count > 5 ? (
            <View style={s.backRow}>
              <IconButton
                theme={theme}
                icon={showAllCommits ? "ChevronUp" : "ChevronDown"}
                text={showAllCommits ? "Show fewer" : `Show all ${count}`}
                label="Toggle the commit list"
                onPress={() => setShowAllCommits((prev) => !prev)}
              />
            </View>
          ) : null}
        </View>
        {actions}
      </View>
    );
  }

  const renderRow = ({ item }: { item: Row }) => {
    switch (item.kind) {
      case "head":
        return header;
      case "dir":
        return (
          <View style={[s.treeRow, { paddingLeft: SPACE[2] + item.depth * 14 }]}>
            <Icon name="Folder" size={14} color={theme.colors.foregroundMuted} />
            <Text style={[s.dirName, ui]} numberOfLines={1}>{item.name}</Text>
          </View>
        );
      case "entry": {
        const file = files[item.file];
        if (!file) return null;
        return (
          <ListRow
            theme={theme}
            compact={compact}
            label={`Jump to ${file.path}`}
            onPress={() => jumpTo(item.file)}
            style={[s.entry, { paddingLeft: SPACE[2] + item.depth * 14 }]}
          >
            <ChangeIcon file={file} theme={theme} />
            <Text style={[s.entryName, ui]} numberOfLines={1}>{item.name}</Text>
            <FileStats file={file} s={s} />
          </ListRow>
        );
      }
      case "file": {
        const file = files[item.file];
        if (!file) return null;
        const isCollapsed = collapsed.has(item.file);
        const blobUrl = web && file.status !== "deleted"
          ? webUrl(web, { kind: "blob", rev: loaded.contextRev, path: file.path })
          : null;
        return (
          <View style={s.fileHeader}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: !isCollapsed }}
              accessibilityLabel={`${isCollapsed ? "Expand" : "Collapse"} ${file.path}`}
              onPress={() => toggle(item.file)}
              style={s.fileToggle}
            >
              <Icon name={isCollapsed ? "ChevronRight" : "ChevronDown"} size={14} color={theme.colors.foregroundMuted} />
              <PathLabel path={file.path} oldPath={file.oldPath} s={s} />
              <FileStats file={file} s={s} />
              <ChangeIcon file={file} theme={theme} />
            </Pressable>
            <IconButton
              theme={theme}
              icon="Copy"
              label={`Copy path ${file.path}`}
              onPress={() => copyText(file.path).then(() => toast.show("Path copied"), () => toast.error("Could not copy"))}
            />
            <IconButton theme={theme} icon="History" label={`History of ${file.path}`} onPress={() => onFileHistory(file.path)} />
            {blobUrl ? <IconButton theme={theme} icon="ExternalLink" label={`Open ${file.path} in browser`} onPress={() => void openExternalUrl(blobUrl)} /> : null}
          </View>
        );
      }
      case "hunk":
        return (
          <View style={s.lineRow}>
            <View style={[s.gutter, { width: gutters.get(item.file) }]} />
            <Text style={[s.code, s.codeMuted, mono]}>{item.text}</Text>
          </View>
        );
      case "gap": {
        const loading = busy.has(item.gap.key);
        const label = item.hidden === null
          ? "Show more lines"
          : `Show ${item.hidden > CHUNK ? `${CHUNK} of ${item.hidden}` : item.hidden} hidden line${item.hidden === 1 ? "" : "s"}`;
        return (
          <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={() => void expand(item.file, item.gap)} style={s.gap}>
            <View style={[s.gapGutter, { width: gutters.get(item.file) }]}>
              <Icon name="ChevronsUpDown" size={14} color={theme.colors.accent} />
            </View>
            <Text style={[s.gapText, ui]}>{loading ? "Loading…" : label}</Text>
          </Pressable>
        );
      }
      case "unified":
        return <CodeRow cell={item.cell} gutter={gutters.get(item.file) ?? 0} s={s} theme={theme} syntax={syntax} font={font} />;
      case "split":
        return (
          <View style={s.splitRow}>
            <View style={[s.half, s.halfLeft]}>
              {item.left
                ? <CodeRow cell={item.left} gutter={gutters.get(item.file) ?? 0} s={s} theme={theme} syntax={syntax} font={font} />
                : <View style={s.emptyHalf} />}
            </View>
            <View style={s.half}>
              {item.right
                ? <CodeRow cell={item.right} gutter={gutters.get(item.file) ?? 0} s={s} theme={theme} syntax={syntax} font={font} />
                : <View style={s.emptyHalf} />}
            </View>
          </View>
        );
      case "note":
        return (
          <View style={s.noteRow}>
            <Text style={[s.note, mono]}>{item.text}</Text>
            {item.action === "load" ? (
              <IconButton
                theme={theme}
                icon="Download"
                text={busy.has(`load-${item.file}`) ? "Loading…" : "Load full diff"}
                label="Load this file's full diff"
                disabled={busy.has(`load-${item.file}`)}
                onPress={() => void loadFull(item.file)}
              />
            ) : null}
          </View>
        );
    }
  };

  const listView = (
    <FlatList
      ref={list}
      style={contentWidth ? [s.screen, { width: contentWidth }] : s.screen}
      data={rows}
      keyExtractor={(row: Row) => row.key}
      renderItem={renderRow}
      stickyHeaderIndices={sticky}
      initialNumToRender={60}
      windowSize={15}
      onScrollToIndexFailed={({ index, averageItemLength }) => {
        // Rows are variable height: land near it, then retry once it is laid out.
        list.current?.scrollToOffset({ offset: index * averageItemLength, animated: false });
        setTimeout(() => list.current?.scrollToIndex({ index, animated: true }), 100);
      }}
    />
  );

  // No-wrap: one horizontal scroller around the virtualised list, sized to the
  // longest line (monospace estimate). Headers scroll with it.
  return contentWidth
    ? <ScrollView horizontal style={s.screen} contentContainerStyle={s.hScroll}>{listView}</ScrollView>
    : listView;
}

function CodeRow({ cell, gutter, s, theme, syntax, font }: {
  cell: Cell;
  gutter: number;
  s: Styles;
  theme: Theme;
  syntax: Record<string, string> | null;
  font: CodeFont;
}) {
  const c = theme.colors;
  const numberColor = cell.type === "add" ? c.statusSuccess : cell.type === "remove" ? c.statusDanger : c.foregroundMuted;
  const background = cell.type === "add" ? s.lineAdd : cell.type === "remove" ? s.lineRemove : null;
  const strong = cell.type === "add" ? tint(c.statusSuccess, 0.35) : tint(c.statusDanger, 0.3);
  const parts = segments(cell.text, syntax ? cell.runs : null, cell.changes);
  const plain = parts.length <= 1 && !parts[0]?.style && !parts[0]?.changed;
  return (
    <View style={[s.lineRow, background]}>
      <Text style={[s.lineNo, { width: gutter, color: numberColor, fontFamily: font.family }]}>{cell.number ?? ""}</Text>
      <Text style={[s.code, { fontFamily: font.family }]}>
        {plain ? cell.text : parts.map((part, index) => (
          <Text
            key={index}
            style={{
              fontFamily: font.family,
              color: part.style ? syntax?.[part.style] : undefined,
              backgroundColor: part.changed ? strong : undefined,
            }}
          >
            {part.text}
          </Text>
        ))}
      </Text>
    </View>
  );
}

/** File name in the foreground, its directory muted after it (file-header-presentation.ts). */
function PathLabel({ path, oldPath, s }: { path: string; oldPath?: string | null; s: Styles }) {
  const slash = path.lastIndexOf("/");
  return (
    <Text style={[s.pathLabel, { fontFamily: UI }]} numberOfLines={1}>
      <Text style={s.fileName}>{slash >= 0 ? path.slice(slash + 1) : path}</Text>
      {slash >= 0 ? <Text style={s.directory}>{` ${path.slice(0, slash)}`}</Text> : null}
      {oldPath ? <Text style={s.directory}>{`  ← ${oldPath}`}</Text> : null}
    </Text>
  );
}

function FileStats({ file, s }: { file: FileDiff; s: Styles }) {
  return (
    <Text style={[s.stats, { fontFamily: UI }]}>
      <Text style={s.add}>+{formatCount(file.additions)}</Text>
      {" "}
      <Text style={s.del}>-{formatCount(file.deletions)}</Text>
    </Text>
  );
}

function Stats({ files, additions, deletions, s }: { files: number; additions: number; deletions: number; s: Styles }) {
  return (
    <Text style={[s.muted, { fontFamily: UI }]}>
      {files} file{files === 1 ? "" : "s"} changed{"  "}
      <Text style={s.add}>+{formatCount(additions)}</Text> <Text style={s.del}>-{formatCount(deletions)}</Text>
    </Text>
  );
}

/** paint.web.ts paintChangeIcon: square-plus / square-minus / square-dot, 14px. */
function ChangeIcon({ file, theme }: { file: FileDiff; theme: Theme }) {
  const [name, color] = file.status === "added"
    ? ["SquarePlus", theme.colors.statusSuccess]
    : file.status === "deleted"
      ? ["SquareMinus", theme.colors.statusDanger]
      : ["SquareDot", theme.colors.statusWarning];
  return <Icon name={name} size={14} color={color} />;
}

/** code-insets.ts lineNumberGutterWidth. */
function gutterWidth(maxLine: number, fontSize: number): number {
  return Math.max(2, String(maxLine).length) * Math.ceil(fontSize * 0.62) + 12;
}

/** Width that fits the longest line without wrapping (monospace estimate). */
function estimateWidth(rows: Row[], gutters: Map<number, number>, font: CodeFont, layout: "unified" | "split"): number {
  const char = font.size * 0.62;
  let widest = 0;
  for (const row of rows) {
    if (layout === "unified" && row.kind === "unified") {
      widest = Math.max(widest, (gutters.get(row.file) ?? 0) + 16 + columns(row.cell.text) * char);
    }
    if (layout === "split" && row.kind === "split") {
      const side = Math.max(columns(row.left?.text ?? ""), columns(row.right?.text ?? ""));
      widest = Math.max(widest, 2 * ((gutters.get(row.file) ?? 0) + 16 + side * char));
    }
  }
  return Math.max(640, Math.ceil(widest) + 24);
}

/** Display columns, counting a tab as 8 like the browser's default tab-size. */
function columns(text: string): number {
  return text.length + (text.split("\t").length - 1) * 7;
}

type Styles = ReturnType<typeof useStyles>;

function useStyles(theme: Theme, compact: boolean, font: CodeFont) {
  return useMemo(() => {
    const c = theme.colors;
    const pad = compact ? 12 : 16;
    const code = { fontSize: font.size, lineHeight: font.lineHeight };
    return StyleSheet.create({
      screen: { flex: 1, backgroundColor: c.surface0 },
      hScroll: { flexGrow: 1 },
      flex: { flex: 1 },
      // Commit / range header.
      header: { padding: pad, gap: SPACE[2], borderBottomWidth: 1, borderBottomColor: c.border, marginBottom: SPACE[2], backgroundColor: c.surface0 },
      backRow: { flexDirection: "row", marginLeft: -SPACE[2] },
      subject: { color: c.foreground, fontSize: compact ? 15 : 16, fontWeight: "600" },
      muted: { color: c.foregroundMuted, fontSize: UI_SMALL },
      metaRow: { flexDirection: "row", gap: SPACE[2], alignItems: "center", flexWrap: "wrap" },
      sha: { ...code, color: c.foregroundMuted },
      refName: { ...code, color: c.foreground, backgroundColor: c.surface1, paddingHorizontal: SPACE[1.5], borderRadius: 4 },
      actions: { flexDirection: "row", alignItems: "center", gap: SPACE[1], marginLeft: -SPACE[2], flexWrap: "wrap" },
      rangeCommits: { gap: SPACE[0.5], marginHorizontal: -SPACE[2] },
      rangeCommit: { alignItems: "center", minHeight: 28, paddingVertical: SPACE[1] },
      rangeSubject: { flex: 1, color: c.foreground, fontSize: UI_SMALL + 1 },
      // Changed-file tree.
      treeRow: { flexDirection: "row", alignItems: "center", gap: SPACE[2], minHeight: 26, paddingRight: SPACE[2], marginHorizontal: SPACE[2] },
      dirName: { color: c.foregroundMuted, fontSize: UI_SMALL + 1, flex: 1 },
      entry: { alignItems: "center", minHeight: 26, marginHorizontal: SPACE[2], paddingVertical: SPACE[0.5] },
      entryName: { flex: 1, color: c.foreground, fontSize: UI_SMALL + 1 },
      // File header (file-header-presentation.ts: 30px, 12 left, 8 right).
      fileHeader: {
        flexDirection: "row", alignItems: "center", gap: SPACE[1], height: 30, marginTop: SPACE[2],
        paddingLeft: SPACE[2], paddingRight: SPACE[1], backgroundColor: c.surface0,
        borderTopWidth: 1, borderBottomWidth: 1, borderColor: c.border,
      },
      fileToggle: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: SPACE[2], height: 28 },
      pathLabel: { flex: 1, fontSize: UI_SIZE },
      fileName: { color: c.foreground },
      directory: { color: c.foregroundMuted },
      stats: { fontSize: UI_SMALL },
      add: { color: c.statusSuccess },
      del: { color: c.statusDanger },
      // Diff body (diff-document palette + paint).
      lineRow: { flexDirection: "row", backgroundColor: c.surface0, flex: 1 },
      lineAdd: { backgroundColor: tint(c.statusSuccess, 0.15) },
      lineRemove: { backgroundColor: tint(c.statusDanger, 0.1) },
      gutter: { borderRightWidth: 1, borderRightColor: c.border },
      lineNo: { ...code, textAlign: "right", paddingRight: 7, borderRightWidth: 1, borderRightColor: c.border },
      code: { ...code, flex: 1, color: c.foreground, paddingLeft: 8, paddingRight: 8 },
      codeMuted: { color: c.foregroundMuted },
      splitRow: { flexDirection: "row" },
      half: { flex: 1, minWidth: 0 },
      halfLeft: { borderRightWidth: 1, borderRightColor: c.border },
      emptyHalf: { flex: 1, backgroundColor: c.surface1 },
      gap: { flexDirection: "row", alignItems: "center", backgroundColor: tint(c.accent, 0.08), minHeight: font.lineHeight + 6 },
      gapGutter: { alignItems: "center", justifyContent: "center", alignSelf: "stretch", borderRightWidth: 1, borderRightColor: c.border },
      gapText: { color: c.accent, fontSize: UI_SMALL, paddingLeft: 8 },
      noteRow: { flexDirection: "row", alignItems: "center", gap: SPACE[2], paddingRight: SPACE[2] },
      note: { ...code, color: c.foregroundMuted, paddingHorizontal: 12, paddingVertical: 6 },
    });
  }, [theme, compact, font]);
}
