/**
 * Pressable row/button with Paseo's own list geometry and states, taken from
 * packages/app/src/components/sidebar/sidebar-header-row.tsx and
 * sidebar-workspace-row-content.tsx: 8px radius, 36px min height (44 on touch),
 * 8px gaps and padding, hover fill, `surface2` when pressed or selected.
 *
 * Paseo's `SidebarRow` cannot be used here: it requires the sidebar item frame
 * and throws elsewhere. Hover uses onHoverIn/Out, which react-native-web
 * implements; on touch it simply never fires.
 */
import { Icon } from "@getpaseo/plugin/client/ui";
import { type ReactNode, useState } from "react";
import { Pressable, type StyleProp, Text, View, type ViewStyle } from "react-native";
import type { Theme } from "./style";
import { UI, UI_SMALL } from "./style";

export const SPACE = { 0.5: 2, 1: 4, 1.5: 6, 2: 8, 3: 12, 4: 16 } as const;
export const RADIUS = { sm: 2, md: 6, lg: 8, full: 9999 } as const;

export function Row({ theme, compact, onPress, selected, label, children, style }: {
  theme: Theme;
  compact: boolean;
  onPress: () => void;
  selected?: boolean;
  label: string;
  /** Content, or a function of the hover state (e.g. full date on hover). */
  children: ReactNode | ((state: { hovered: boolean }) => ReactNode);
  style?: StyleProp<ViewStyle>;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: Boolean(selected) }}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => [
        {
          flexDirection: "row",
          alignItems: "flex-start",
          gap: SPACE[2],
          minHeight: compact ? 44 : 36,
          paddingVertical: SPACE[1.5],
          paddingHorizontal: SPACE[2],
          borderRadius: RADIUS.lg,
        },
        hovered && { backgroundColor: theme.colors.surface1 },
        (pressed || selected) && { backgroundColor: theme.colors.surface2 },
        style,
      ]}
    >
      {typeof children === "function" ? children({ hovered }) : children}
    </Pressable>
  );
}

/** Small icon button (refresh, copy, back) with the same hover/press fills. */
export function IconButton({ theme, icon, label, onPress, text, active, disabled }: {
  theme: Theme;
  icon: string;
  label: string;
  onPress: () => void;
  text?: string;
  /** Toggle buttons: drawn pressed-in while on. */
  active?: boolean;
  disabled?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled}
      accessibilityState={{ selected: active, disabled }}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => [
        disabled && { opacity: 0.5 },
        {
          flexDirection: "row", alignItems: "center", gap: SPACE[1],
          height: 28, minWidth: 28, justifyContent: "center",
          paddingHorizontal: text ? SPACE[2] : 0, borderRadius: RADIUS.md,
        },
        hovered && { backgroundColor: theme.colors.surface1 },
        (pressed || active) && { backgroundColor: theme.colors.surface2 },
      ]}
    >
      <Icon name={icon} size={14} color={hovered || active ? theme.colors.foreground : theme.colors.foregroundMuted} />
      {text ? (
        <Text style={{ color: hovered || active ? theme.colors.foreground : theme.colors.foregroundMuted, fontFamily: UI, fontSize: UI_SMALL }}>
          {text}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** Centered icon + message, for empty and error states. */
export function Notice({ theme, icon, text, tone }: { theme: Theme; icon: string; text: string; tone?: "danger" }) {
  const color = tone === "danger" ? theme.colors.statusDanger : theme.colors.foregroundMuted;
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: SPACE[2], padding: SPACE[4], minHeight: 120 }}>
      <Icon name={icon} size={20} color={color} />
      <Text style={{ color, fontFamily: UI, fontSize: UI_SMALL, textAlign: "center" }}>{text}</Text>
    </View>
  );
}
