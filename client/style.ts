/**
 * Typography and helpers matched to Paseo's own diff viewer
 * (packages/app/src/git/diff-document, styles/theme.ts) so a commit here reads
 * the same as the built-in Changes view. Values are Paseo's defaults: plugins
 * cannot read the user's Appearance settings (code font/size).
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { useSettings } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Platform } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { appearanceSettings, syntaxPaletteRpc } from "../shared/git";

export type Theme = PluginTheme;

/** diff-document/surface.web.tsx DEFAULT_MONO_STACK; native: theme DEFAULT_MONO_FONT_STACK. */
export const MONO = Platform.select({
  web: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  ios: "ui-monospace",
  default: "monospace",
});

/** styles/theme.ts DEFAULT_UI_FONT_STACK. */
export const UI = Platform.select({
  web: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  ios: "system-ui",
  default: undefined,
});

/** DEFAULT_CODE_FONT_SIZE = 12; diff line height = round(code size * 1.5). */
export const CODE_SIZE = 12;

export interface CodeFont {
  family: string | undefined;
  size: number;
  lineHeight: number;
}

/**
 * The code font from this plugin's settings, resolved the way Paseo resolves
 * Appearance > code font (diff-document/surface.web.tsx): blank -> default stack,
 * line height = round(size * 1.5).
 */
/**
 * Token style -> colour for the chosen syntax theme, light or dark from the
 * Paseo theme's background (Paseo picks the palette by colour scheme too).
 */
export function useSyntaxColors(theme: Theme): Record<string, string> | null {
  const settings = useSettings(appearanceSettings);
  const syntaxTheme = settings.status === "ready" ? settings.values.syntaxTheme : "one";
  const scheme = isDark(theme.colors.surface0) ? "dark" : "light";
  const palette = useRpc(syntaxPaletteRpc);
  const query = useQuery({
    queryKey: ["syntax-palette", syntaxTheme, scheme],
    queryFn: () => palette({ theme: syntaxTheme, scheme }),
    staleTime: Infinity,
  });
  return query.data?.colors ?? null;
}

function isDark(color: string): boolean {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(color);
  if (!match) return true;
  const [r, g, b] = match.slice(1).map((hex) => parseInt(hex, 16));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0) < 128;
}

/** Diff layout + wrap preferences, and a setter that saves them (host settings). */
export function useDiffPrefs(): {
  layout: "unified" | "split";
  wrap: boolean;
  set: (patch: { diffLayout?: "unified" | "split"; wrapLines?: boolean }) => void;
} {
  const settings = useSettings(appearanceSettings);
  const ready = settings.status === "ready" ? settings : null;
  return {
    layout: ready?.values.diffLayout ?? "unified",
    wrap: ready?.values.wrapLines ?? true,
    set: (patch) => {
      if (ready) void ready.save({ ...ready.values, ...patch }, ready.revision);
    },
  };
}

export function useCodeFont(): CodeFont {
  const settings = useSettings(appearanceSettings);
  const values = settings.status === "ready" ? settings.values : null;
  const family = values?.codeFontFamily.trim() || MONO;
  const size = values?.codeFontSize ?? CODE_SIZE;
  return useMemo(() => ({ family, size, lineHeight: Math.round(size * 1.5) }), [family, size]);
}
/** theme fontSize.base / fontSize.sm. */
export const UI_SIZE = 14;
export const UI_SMALL = 12;

/** `#rrggbb` + alpha (Paseo: hexColorWithAlpha); non-hex theme colours get no tint. */
export function tint(color: string, alpha: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return "transparent";
  return color + Math.round(alpha * 255).toString(16).padStart(2, "0");
}

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
/** file-header-presentation.ts formatDiffCount: 1200 -> "1.2k". */
export function formatCount(value: number): string {
  return compact.format(value).toLowerCase();
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** "25 Nov 2026, 18:04" in the viewer's locale. */
export function fullDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Day bucket for grouping the commit list: "Today", "Yesterday", or a date. */
export function dayLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(now) - day(date)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "short", day: "numeric", month: "short",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

/** "3 hours ago" style, falling back to the date for anything older than a month. */
export function ago(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  const steps: [number, string][] = [[60, "second"], [60, "minute"], [24, "hour"], [30, "day"]];
  let value = seconds;
  for (const [size, unit] of steps) {
    if (value < size) {
      const n = Math.floor(value);
      return n <= 0 && unit === "second" ? "just now" : `${n} ${unit}${n === 1 ? "" : "s"} ago`;
    }
    value /= size;
  }
  return new Date(then).toLocaleDateString();
}
