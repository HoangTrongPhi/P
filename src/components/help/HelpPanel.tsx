import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { HelpBlock, HelpLang, HelpTopic, L } from "../../help/types";

/*
 * Generic, bilingual Help panel: topic list with a filter on the left, the topic on the right,
 * a VI / EN switch in the header. No app-specific imports (only React and the help content
 * types) and no icon library, so it can move into the shared `@abyss/ui` package unchanged.
 * Styling uses the Studio theme tokens (bg-panel, text-ink, border-edge, accent, …) and the
 * global `kbd` style, so it follows the light / dark theme.
 */

export interface HelpPanelLabels {
  /** Dialog title, shown after the app name. */
  title: L;
  /** Placeholder / accessible name of the topic filter. */
  search: L;
  noResults: L;
  close: L;
  /** Accessible name of the topic list. */
  topics: L;
  /** Accessible name of the VI / EN switch. */
  language: L;
  /** Footer hint (keyboard). */
  hint: L;
  /** The header button that opens the PDF user guide (`onOpenGuide`). */
  openGuide: L;
  openGuideTitle: L;
}

export interface HelpPanelProps {
  open: boolean;
  onClose: () => void;
  topics: HelpTopic[];
  /** Topic shown when the panel opens (e.g. the current tab); falls back to the first topic. */
  initialTopicId?: string;
  lang: HelpLang;
  onLangChange: (lang: HelpLang) => void;
  appName: string;
  /** Shows a "PDF" button in the header that opens the full user guide (in `lang`). */
  onOpenGuide?: (lang: HelpLang) => void;
  labels?: Partial<HelpPanelLabels>;
}

const DEFAULT_LABELS: HelpPanelLabels = {
  title: { vi: "Hướng dẫn", en: "Help" },
  search: { vi: "Tìm chủ đề…", en: "Filter topics…" },
  noResults: { vi: "Không có chủ đề phù hợp", en: "No matching topics" },
  close: { vi: "Đóng", en: "Close" },
  topics: { vi: "Chủ đề", en: "Topics" },
  language: { vi: "Ngôn ngữ", en: "Language" },
  hint: { vi: "F1 mở / đóng · Esc để đóng", en: "F1 opens / closes · Esc closes" },
  openGuide: { vi: "PDF", en: "PDF" },
  openGuideTitle: { vi: "Mở tài liệu hướng dẫn đầy đủ (PDF)", en: "Open the full user guide (PDF)" },
};

const LANGS: { id: HelpLang; label: string; name: string }[] = [
  { id: "vi", label: "VI", name: "Tiếng Việt" },
  { id: "en", label: "EN", name: "English" },
];

export function HelpPanel(props: HelpPanelProps) {
  if (!props.open) return null;
  return <HelpDialog {...props} />;
}

// ---------------------------------------------------------------- dialog

function HelpDialog({ onClose, topics, initialTopicId, lang, onLangChange, appName, onOpenGuide, labels }: HelpPanelProps) {
  const t = useMemo(() => ({ ...DEFAULT_LABELS, ...labels }), [labels]);
  const [topicId, setTopicId] = useState(() => (topics.some((x) => x.id === initialTopicId) ? initialTopicId! : topics[0]?.id));
  const [query, setQuery] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const articleRef = useRef<HTMLElement>(null);

  const index = useMemo(() => topics.map((x) => ({ topic: x, title: fold(`${x.title.vi} ${x.title.en}`), body: fold(topicText(x)) })), [topics]);
  const shown = useMemo(() => {
    const q = fold(query.trim());
    if (!q) return topics;
    const words = q.split(/\s+/);
    const hits = index.filter((e) => words.every((w) => e.title.includes(w) || e.body.includes(w)));
    // Title matches first, otherwise keep the authored order.
    return [...hits.filter((e) => words.every((w) => e.title.includes(w))), ...hits.filter((e) => !words.every((w) => e.title.includes(w)))].map((e) => e.topic);
  }, [index, query, topics]);
  const topic = topics.find((x) => x.id === topicId) ?? topics[0];

  // Focus the filter on open; give focus back to whatever had it when the panel closes.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    searchRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (query && document.activeElement === searchRef.current) setQuery("");
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, query]);

  useEffect(() => {
    articleRef.current?.scrollTo({ top: 0 });
  }, [topicId]);

  /** Keep Tab inside the dialog. */
  const trapTab = (e: ReactKeyboardEvent) => {
    if (e.key !== "Tab" || !dialogRef.current) return;
    const items = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input, [tabindex]:not([tabindex="-1"])')];
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  /** Arrow keys in the filter walk the (filtered) topic list; Enter opens the first match. */
  const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!shown.length) return;
    const i = shown.findIndex((x) => x.id === topicId);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      const next = i < 0 ? 0 : (i + step + shown.length) % shown.length;
      setTopicId(shown[next].id);
    } else if (e.key === "Enter") {
      e.preventDefault();
      setTopicId(shown[0].id);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid animate-fade-in place-items-center bg-black/60 p-4 backdrop-blur-[2px]" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-panel-title"
        lang={lang}
        className="flex h-[min(88vh,760px)] w-full max-w-5xl animate-pop-in flex-col overflow-hidden rounded-xl border border-edge bg-panel shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={trapTab}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center gap-3 border-b border-edge px-4 py-3">
          <BookIcon className="size-4 text-accent" />
          <h2 id="help-panel-title" className="flex-1 truncate text-[14px] font-semibold text-ink">
            {appName} <span className="font-normal text-ink-faint">·</span> {t.title[lang]}
          </h2>
          {onOpenGuide && (
            <button
              type="button"
              title={t.openGuideTitle[lang]}
              onClick={() => onOpenGuide(lang)}
              className="flex h-7 items-center gap-1.5 rounded-lg border border-edge px-2.5 text-[11.5px] font-semibold text-ink-muted transition-colors hover:border-accent/50 hover:text-accent"
            >
              <FileIcon className="size-3.5" />
              {t.openGuide[lang]}
            </button>
          )}
          <div role="radiogroup" aria-label={t.language[lang]} className="flex rounded-lg border border-edge bg-canvas/60 p-0.5">
            {LANGS.map((l) => (
              <button
                key={l.id}
                type="button"
                role="radio"
                aria-checked={lang === l.id}
                title={l.name}
                onClick={() => onLangChange(l.id)}
                className={
                  "h-6 rounded-md px-2.5 text-[11.5px] font-semibold tracking-wide transition-colors " +
                  (lang === l.id ? "bg-accent/15 text-accent" : "text-ink-faint hover:text-ink")
                }
              >
                {l.label}
              </button>
            ))}
          </div>
          <button type="button" className="icon-btn" aria-label={t.close[lang]} title={`${t.close[lang]} (Esc)`} onClick={onClose}>
            <CloseIcon className="size-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* Topic list */}
          <aside className="flex w-60 shrink-0 flex-col border-r border-edge bg-panel-raised/40">
            <div className="p-2.5">
              <div className="relative">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-faint" />
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={onSearchKey}
                  placeholder={t.search[lang]}
                  aria-label={t.search[lang]}
                  spellCheck={false}
                  className="h-8 w-full rounded-md border border-edge bg-canvas/70 pr-2 pl-8 text-[12.5px] text-ink outline-none placeholder:text-ink-faint focus:border-accent/60"
                />
              </div>
            </div>
            <nav aria-label={t.topics[lang]} className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
              {shown.length === 0 && <div className="px-3 py-6 text-center text-[12px] text-ink-faint">{t.noResults[lang]}</div>}
              {shown.map((x) => {
                const active = x.id === topic?.id;
                return (
                  <button
                    key={x.id}
                    type="button"
                    aria-current={active ? "page" : undefined}
                    onClick={() => setTopicId(x.id)}
                    className={
                      "relative mb-0.5 flex w-full flex-col rounded-lg px-2.5 py-1.5 text-left transition-colors " +
                      (active ? "bg-accent/12 text-ink" : "text-ink-muted hover:bg-tint/5 hover:text-ink")
                    }
                  >
                    {active && <span className="absolute top-2 bottom-2 left-0 w-[3px] rounded-r-full bg-accent" />}
                    <span className="truncate text-[12.5px] font-medium">{x.title[lang]}</span>
                    <span className="line-clamp-1 text-[11px] text-ink-faint">{x.summary[lang]}</span>
                  </button>
                );
              })}
            </nav>
          </aside>

          {/* Topic */}
          <article ref={articleRef} className="min-w-0 flex-1 overflow-y-auto px-7 py-6 select-text">
            {topic && <TopicView topic={topic} lang={lang} />}
          </article>
        </div>

        <div className="flex shrink-0 items-center justify-between border-t border-edge px-4 py-2 text-[11px] text-ink-faint">
          <span>{t.hint[lang]}</span>
          <span>
            {shown.length}/{topics.length}
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- content

function TopicView({ topic, lang }: { topic: HelpTopic; lang: HelpLang }) {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <header>
        <h3 className="text-[19px] leading-tight font-semibold text-ink">{topic.title[lang]}</h3>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-muted">
          <Inline text={topic.summary[lang]} />
        </p>
      </header>
      {topic.sections.map((s, i) => (
        <section key={i} className="flex flex-col gap-2.5">
          <h4 className="flex items-center gap-2 text-[13.5px] font-semibold text-ink">
            <span className="h-3.5 w-[3px] rounded-full bg-accent" />
            {s.heading[lang]}
          </h4>
          {s.blocks.map((b, j) => (
            <Block key={j} block={b} lang={lang} />
          ))}
        </section>
      ))}
    </div>
  );
}

function Block({ block, lang }: { block: HelpBlock; lang: HelpLang }) {
  switch (block.kind) {
    case "p":
      return (
        <p className="text-[13px] leading-relaxed text-ink-muted">
          <Inline text={block.text[lang]} />
        </p>
      );
    case "steps":
      return (
        <ol className="flex flex-col gap-2">
          {block.items.map((it, i) => (
            <li key={i} className="flex gap-2.5 text-[13px] leading-relaxed text-ink-muted">
              <span className="mt-px grid size-5 shrink-0 place-items-center rounded-full bg-accent/15 text-[11px] font-semibold text-accent">{i + 1}</span>
              <span className="min-w-0">
                <Inline text={it[lang]} />
              </span>
            </li>
          ))}
        </ol>
      );
    case "tips":
      return (
        <ul className="flex flex-col gap-1.5 rounded-lg border border-edge bg-panel-raised/50 px-3.5 py-2.5">
          {block.items.map((it, i) => (
            <li key={i} className="flex gap-2.5 text-[12.5px] leading-relaxed text-ink-muted">
              <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-accent/70" />
              <span className="min-w-0">
                <Inline text={it[lang]} />
              </span>
            </li>
          ))}
        </ul>
      );
    case "keys":
      return (
        <div className="overflow-hidden rounded-lg border border-edge">
          {block.items.map((it, i) => (
            <div key={i} className={"flex items-center gap-4 px-3 py-1.5 text-[12.5px] " + (i % 2 ? "bg-panel-raised/40" : "")}>
              <span className="flex w-48 shrink-0 flex-wrap items-center gap-1">
                <Keys keys={it.keys} />
              </span>
              <span className="min-w-0 text-ink-muted">
                <Inline text={it.label[lang]} />
              </span>
            </div>
          ))}
        </div>
      );
  }
}

/** `"Ctrl+K / Ctrl+P"` → <kbd>Ctrl</kbd><kbd>K</kbd> / <kbd>Ctrl</kbd><kbd>P</kbd>. */
function Keys({ keys }: { keys: string }) {
  return (
    <>
      {keys.split(/(\s\/\s|\s…\s)/).map((part, i) =>
        i % 2 ? (
          <span key={i} className="px-0.5 text-[11px] text-ink-faint">
            {part.trim()}
          </span>
        ) : (
          <Fragment key={i}>
            {part.split("+").map((k, j) => (
              <kbd key={j}>{k}</kbd>
            ))}
          </Fragment>
        ),
      )}
    </>
  );
}

/** Tiny inline formatter: `**bold**` and `` `code` ``; everything else is plain text. */
function Inline({ text }: { text: string }) {
  const out: ReactNode[] = [];
  text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).forEach((part, i) => {
    if (!part) return;
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
      out.push(
        <strong key={i} className="font-semibold text-ink">
          {part.slice(2, -2)}
        </strong>,
      );
    } else if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      out.push(
        <code key={i} className="rounded border border-edge bg-tint/5 px-1 py-px font-mono text-[0.9em] text-ink">
          {part.slice(1, -1)}
        </code>,
      );
    } else out.push(part);
  });
  return <>{out}</>;
}

// ---------------------------------------------------------------- search helpers

/** Lower-case and strip diacritics, so "huong dan" finds "Hướng dẫn". */
function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[đĐ]/g, "d").toLowerCase();
}

/** All text of a topic in both languages, for the filter. */
function topicText(topic: HelpTopic): string {
  const parts: string[] = [topic.summary.vi, topic.summary.en];
  for (const s of topic.sections) {
    parts.push(s.heading.vi, s.heading.en);
    for (const b of s.blocks) {
      if (b.kind === "p") parts.push(b.text.vi, b.text.en);
      else if (b.kind === "keys") for (const k of b.items) parts.push(k.keys, k.label.vi, k.label.en);
      else for (const it of b.items) parts.push(it.vi, it.en);
    }
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------- glyphs (inline: no icon dependency)

function Glyph({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

function BookIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <path d="M12 7v14" />
      <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
    </Glyph>
  );
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <path d="m21 21-4.34-4.34" />
      <circle cx="11" cy="11" r="8" />
    </Glyph>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <path d="M18 6 6 18M6 6l12 12" />
    </Glyph>
  );
}

function FileIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8" />
    </Glyph>
  );
}
