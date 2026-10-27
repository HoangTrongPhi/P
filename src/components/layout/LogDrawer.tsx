import { ChevronDown, Terminal, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { useAppStore } from "../../stores/appStore";
import type { LogEntry, LogLevel } from "../../types/pipeline";
import { PillBadge } from "../ui/PillBadge";

const LEVEL_STYLE: Record<LogLevel, string> = {
  debug: "text-ink-faint",
  info: "text-ink",
  warn: "text-amber",
  error: "text-rose",
};

const LEVEL_TONE = { debug: "neutral", info: "accent", warn: "amber", error: "rose" } as const;

const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour12: false });

/** Collapsible bottom terminal for structured log entries from Rust and the UI. */
export function LogDrawer() {
  const open = useAppStore((s) => s.logDrawerOpen);
  const toggle = useAppStore((s) => s.toggleLogDrawer);
  const height = useAppStore((s) => s.logDrawerHeight);
  const setHeight = useAppStore((s) => s.setLogDrawerHeight);
  const logs = useAppStore((s) => s.logs);
  const clear = useAppStore((s) => s.clearLogs);
  const [hidden, setHidden] = useState<Set<LogLevel>>(() => new Set(["debug"]));

  const counts = useMemo(() => {
    const c: Record<LogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 };
    for (const l of logs) c[l.level]++;
    return c;
  }, [logs]);
  const visible = useMemo(() => logs.filter((l) => !hidden.has(l.level)), [logs, hidden]);

  const toggleLevel = (lvl: LogLevel) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (!next.delete(lvl)) next.add(lvl);
      return next;
    });

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const move = (ev: PointerEvent) => setHeight(startH + (startY - ev.clientY));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <section className="relative shrink-0 border-t border-edge bg-panel" style={{ height: open ? height : 32 }}>
      {open && <div onPointerDown={startResize} className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize" />}
      <div className="flex h-8 items-center gap-2 px-3">
        <button type="button" onClick={() => toggle()} className="flex items-center gap-2 text-[12px] font-medium text-ink-muted hover:text-ink">
          <Terminal className="size-3.5" />
          Log
          <ChevronDown className={cn("size-3.5 transition-transform", !open && "rotate-180")} />
        </button>
        <div className="ml-2 flex items-center gap-1">
          {(Object.keys(counts) as LogLevel[]).map((lvl) => (
            <button key={lvl} type="button" onClick={() => toggleLevel(lvl)} title={`${hidden.has(lvl) ? "Show" : "Hide"} ${lvl}`}>
              <PillBadge tone={hidden.has(lvl) ? "neutral" : LEVEL_TONE[lvl]} className={cn(hidden.has(lvl) && "opacity-50")}>
                {lvl} {counts[lvl]}
              </PillBadge>
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <button type="button" onClick={clear} className="icon-btn size-6" aria-label="Clear log" title="Clear log">
          <Trash2 className="size-3.5" />
        </button>
      </div>
      {open && <LogLines entries={visible} height={height - 32} />}
    </section>
  );
}

function LogLines({ entries, height }: { entries: LogEntry[]; height: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Follow the tail unless the user scrolled up to read history.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [entries, height]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => (stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24);
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div ref={ref} className="overflow-y-auto px-3 pb-2 font-mono text-[11.5px] leading-[18px] select-text" style={{ height }}>
      {entries.length === 0 && <div className="text-ink-faint">No log output.</div>}
      {entries.map((e, i) => (
        <div key={i} className={cn("flex gap-3 whitespace-pre-wrap", LEVEL_STYLE[e.level])}>
          <span className="shrink-0 text-ink-faint">{fmtTime(e.tsMs)}</span>
          <span className="w-12 shrink-0 uppercase opacity-80">{e.level}</span>
          <span className="w-16 shrink-0 truncate text-ink-faint">{e.source}</span>
          <span className="min-w-0 break-words">{e.message}</span>
        </div>
      ))}
    </div>
  );
}
