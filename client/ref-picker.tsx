/**
 * Branch / remote / tag picker in Paseo's Modal, with a filter box. Used for the
 * history ref and for picking a compare base or head.
 */
import { useRpc } from "@getpaseo/plugin/client";
import { FlatList, Icon, Loading, Modal, TextInput } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { type GitRef, listRefsRpc } from "../shared/git";
import { Notice, Row, SPACE } from "./row";
import { type CodeFont, shortSha, type Theme, UI, UI_SIZE, UI_SMALL } from "./style";

const KIND_ICON: Record<GitRef["kind"], string> = { branch: "GitBranch", remote: "Cloud", tag: "Tag" };
const KIND_LABEL: Record<GitRef["kind"], string> = { branch: "Branch", remote: "Remote", tag: "Tag" };

export function RefPicker({ repo, open, title, current, onClose, onPick, theme, compact, font }: {
  repo: string;
  open: boolean;
  title: string;
  current: string | null;
  onClose: () => void;
  onPick: (ref: string) => void;
  theme: Theme;
  compact: boolean;
  font: CodeFont;
}) {
  const list = useRpc(listRefsRpc);
  const refs = useQuery({ queryKey: ["refs", repo], queryFn: () => list({ repo }), enabled: open });
  const [filter, setFilter] = useState("");
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (refs.data?.refs ?? []).filter((ref) => !needle || ref.name.toLowerCase().includes(needle));
  }, [refs.data, filter]);
  const c = theme.colors;

  return (
    <Modal title={title} open={open} onOpenChange={(next) => !next && onClose()}>
      <Modal.Content scrollable={false} contentContainerStyle={{ padding: SPACE[3], gap: SPACE[2] }} style={{ height: 460 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE[2], paddingHorizontal: SPACE[2], height: 32, borderWidth: 1, borderColor: c.border, borderRadius: 6, backgroundColor: c.surface1 }}>
          <Icon name="Search" size={14} color={c.foregroundMuted} />
          <TextInput
            value={filter}
            onChangeText={setFilter}
            placeholder="Filter branches and tags"
            placeholderTextColor={c.foregroundMuted}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Filter refs"
            style={{ flex: 1, color: c.foreground, fontFamily: UI, fontSize: UI_SIZE, borderWidth: 0, paddingVertical: 0 }}
          />
        </View>
        {refs.isPending ? <Loading /> : refs.isError ? (
          <Notice theme={theme} icon="CircleAlert" tone="danger" text={refs.error.message} />
        ) : (
          <FlatList
            data={shown}
            keyExtractor={(ref: GitRef) => `${ref.kind}:${ref.name}`}
            ListEmptyComponent={<Notice theme={theme} icon="Search" text="No matching refs" />}
            renderItem={({ item }: { item: GitRef }) => (
              <Row
                theme={theme}
                compact={compact}
                label={`${KIND_LABEL[item.kind]} ${item.name}`}
                selected={item.name === current}
                onPress={() => { onPick(item.name); onClose(); }}
                style={{ alignItems: "center" }}
              >
                <Icon name={KIND_ICON[item.kind]} size={14} color={item.current ? c.accent : c.foregroundMuted} />
                <Text style={{ flex: 1, color: c.foreground, fontFamily: UI, fontSize: UI_SIZE }} numberOfLines={1}>{item.name}</Text>
                {item.current ? <Text style={{ color: c.accent, fontFamily: UI, fontSize: UI_SMALL }}>current</Text> : null}
                <Text style={{ color: c.foregroundMuted, fontFamily: font.family, fontSize: UI_SMALL }}>{shortSha(item.sha)}</Text>
              </Row>
            )}
          />
        )}
      </Modal.Content>
    </Modal>
  );
}
