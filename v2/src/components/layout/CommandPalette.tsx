import { CornerDownLeft, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildCommands, fuzzyScore, type PaletteCommand } from "../../lib/commands";
import { cn } from "../../lib/cn";
import { uiLog, useAppStore } from "../../stores/appStore";

/** Spotlight-style action launcher, opened with Ctrl+K / Ctrl+P. */
export function CommandPalette() {
  const open = useAppStore((s) => s.paletteOpen);
  const setOpen = useAppStore((s) => s.setPaletteOpen);
  if (!open) return null;
  return <PaletteDialog onClose={() => setOpen(false)} />;
}

function PaletteDialog({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const commands = useMemo(buildCommands, []);

  const results = useMemo(() => {
    if (!query.trim()) return commands;
    return commands
      .map((c) => ({ c, score: Math.max(fuzzyScore(query, c.title), fuzzyScore(query, c.keywords ?? "") - 200) }))
      .filter((r) => r.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.c);
  }, [commands, query]);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setCursor(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const run = (cmd: PaletteCommand | undefined) => {
    if (!cmd) return;
    onClose();
    Promise.resolve(cmd.run()).catch((err) => uiLog("error", `${cmd.title} failed: ${err}`));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((i) => (results.length ? (i + 1) % results.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(results[cursor]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  // Group headings only when browsing the full list; ranked results read better flat.
  const grouped = !query.trim();

  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-black/50 pt-[14vh] animate-fade-in" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label="Command palette"
        className="flex h-fit max-h-[60vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-edge-strong bg-panel shadow-2xl shadow-black/60 animate-pop-in"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-3 border-b border-edge px-4">
          <Search className="size-4 text-ink-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command or search…"
            className="h-12 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-faint"
            spellCheck={false}
            aria-activedescendant={results[cursor] ? `cmd-${results[cursor].id}` : undefined}
          />
          <kbd>Esc</kbd>
        </div>
        <div ref={listRef} className="overflow-y-auto p-1.5" role="listbox">
          {results.length === 0 && <div className="px-3 py-6 text-center text-[12px] text-ink-faint">No matching commands</div>}
          {results.map((cmd, i) => (
            <div key={cmd.id}>
              {grouped && (i === 0 || results[i - 1].group !== cmd.group) && (
                <div className="px-2.5 pt-2 pb-1 text-[10px] font-semibold tracking-wider text-ink-faint uppercase">{cmd.group}</div>
              )}
              <div
                id={`cmd-${cmd.id}`}
                data-index={i}
                role="option"
                aria-selected={i === cursor}
                onMouseMove={() => setCursor(i)}
                onClick={() => run(cmd)}
                className={cn(
                  "flex h-9 cursor-default items-center gap-3 rounded-lg px-2.5 text-[13px]",
                  i === cursor ? "bg-accent/14 text-ink" : "text-ink-muted",
                )}
              >
                <cmd.icon className={cn("size-4", i === cursor ? "text-accent" : "text-ink-faint")} strokeWidth={1.75} />
                <span className="flex-1 truncate">{cmd.title}</span>
                {cmd.shortcut && <span className="text-[11px] text-ink-faint">{cmd.shortcut}</span>}
                {i === cursor && <CornerDownLeft className="size-3.5 text-ink-faint" />}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
