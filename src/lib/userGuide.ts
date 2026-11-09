import type { HelpLang } from "../help/types";
import { uiLog } from "../stores/appStore";
import { useSettingsStore } from "../stores/settingsStore";
import { openUserGuide as openGuidePdf } from "./ipc";

/** Open the user guide PDF bundled with the app (`docs/user-guide`, built from the Help content by `npm run guide`). */
export function openUserGuide(lang: HelpLang = useSettingsStore.getState().helpLang) {
  openGuidePdf(lang).catch((e) => uiLog("error", `User guide: ${String(e)}`));
}
