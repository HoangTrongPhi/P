import { useEffect } from "react";
import { getAppInfo, getLogHistory, inTauri, onBackendLog } from "../lib/ipc";
import { uiLog, useAppStore } from "../stores/appStore";
import { scheduleStartupUpdateCheck } from "../stores/updateStore";

if (!inTauri) {
  uiLog("warn", "Running outside Tauri — backend commands are unavailable (UI preview mode).");
}

/** Subscribes to backend log events, loads app info once at startup, then checks for updates. */
export function useBackendBridge() {
  useEffect(() => {
    if (!inTauri) return;
    const { addLogs, setAppInfo } = useAppStore.getState();
    let disposed = false;
    // Listen first, then backfill, so no entry falls between the two.
    const unlisten = onBackendLog((entry) => addLogs([entry]));
    unlisten
      .then(() => getLogHistory())
      .then((history) => !disposed && addLogs(history))
      .catch((err) => uiLog("error", `Log bridge failed: ${err}`));
    getAppInfo()
      .then((info) => {
        if (disposed) return;
        setAppInfo(info);
        scheduleStartupUpdateCheck(info.debug);
      })
      .catch((err) => uiLog("error", `app_info failed: ${err}`));
    return () => {
      disposed = true;
      unlisten.then((fn) => fn());
    };
  }, []);
}
