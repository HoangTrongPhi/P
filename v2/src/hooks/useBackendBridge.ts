import { useEffect } from "react";
import { getAppInfo, getLogHistory, inTauri, onBackendLog } from "../lib/ipc";
import { uiLog, useAppStore } from "../stores/appStore";

if (!inTauri) {
  uiLog("warn", "Running outside Tauri — backend commands are unavailable (UI preview mode).");
}

/** Subscribes to backend log events and loads app info once at startup. */
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
      .then((info) => !disposed && setAppInfo(info))
      .catch((err) => uiLog("error", `app_info failed: ${err}`));
    return () => {
      disposed = true;
      unlisten.then((fn) => fn());
    };
  }, []);
}
