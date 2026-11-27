/**
 * Settings > Commit diffs: mirror of Paseo's Appearance code font, code size and
 * syntax theme (plugins cannot read the app's own Appearance settings).
 */
import { type PluginSurfaceProps, useSettings } from "@getpaseo/plugin/client";
import { ScrollView, SettingsAction, SettingsInput, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text } from "react-native";
import { appearanceSettings, SYNTAX_THEMES, type SyntaxTheme } from "../shared/git";
import { UI, UI_SMALL } from "./style";

const SIZES = Array.from({ length: 13 }, (_, index) => String(index + 10));

export function SettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(appearanceSettings);
  const [font, setFont] = useState<string | null>(null);
  if (settings.status !== "ready") {
    const message = settings.status === "loading" ? "Loading…" : settings.error;
    return <Text style={{ color: theme.colors.foregroundMuted, fontFamily: UI, fontSize: UI_SMALL, padding: 16 }}>{message}</Text>;
  }
  const { values, revision } = settings;
  const save = (patch: Partial<typeof values>) => void settings.save({ ...values, ...patch }, revision);

  return (
    <ScrollView>
      <SettingsSection title="Diff appearance" info="Match these to Settings > Appearance so commits look like the Changes view.">
        <SettingsInput
          label="Code font"
          hint="Font family name, e.g. JetBrains Mono. Empty uses Paseo's default."
          initialValue={values.codeFontFamily}
          placeholder="Default"
          onChangeText={setFont}
          error={settings.saveError}
        />
        <SettingsAction
          label="Apply code font"
          actionLabel={settings.saving ? "Saving…" : "Apply"}
          disabled={font === null || font.trim() === values.codeFontFamily || settings.saving}
          onPress={() => font !== null && save({ codeFontFamily: font.trim() })}
        />
        <SettingsSelect
          label="Code size"
          value={String(values.codeFontSize)}
          options={SIZES.map((size) => ({ label: `${size}px`, value: size }))}
          onValueChange={(size) => save({ codeFontSize: Number(size) })}
        />
        <SettingsSelect<SyntaxTheme>
          label="Syntax theme"
          value={values.syntaxTheme}
          options={SYNTAX_THEMES}
          onValueChange={(syntaxTheme) => save({ syntaxTheme })}
        />
      </SettingsSection>
    </ScrollView>
  );
}
