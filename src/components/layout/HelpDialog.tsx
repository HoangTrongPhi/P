import { useCallback } from "react";
import { HELP_TOPICS } from "../../help/topics";
import { openUserGuide } from "../../lib/userGuide";
import { useAppStore } from "../../stores/appStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { HelpPanel } from "../help/HelpPanel";

/** Poseidon's wiring of the generic Help panel: F1 / header "?" / command palette, opens on the current tab. */
export function HelpDialog() {
  const open = useAppStore((s) => s.helpOpen);
  const setOpen = useAppStore((s) => s.setHelpOpen);
  const activeTab = useAppStore((s) => s.activeTab);
  const lang = useSettingsStore((s) => s.helpLang);
  const setLang = useSettingsStore((s) => s.setHelpLang);
  const close = useCallback(() => setOpen(false), [setOpen]);

  return <HelpPanel open={open} onClose={close} topics={HELP_TOPICS} initialTopicId={activeTab} lang={lang} onLangChange={setLang} onOpenGuide={openUserGuide} appName="Poseidon" />;
}
