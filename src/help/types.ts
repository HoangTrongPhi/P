/**
 * Content model for the in-app Help panel. Shared shape across the Abyss apps (Poseidon, Coral,
 * PrimeOffice): keep it free of app-specific imports so it can move into `@abyss/ui` as is.
 */

/** A bilingual string. Inline `**bold**` and `` `code` `` are rendered by the Help panel. */
export type L = { vi: string; en: string };

export type HelpLang = "vi" | "en";

export type HelpBlock =
  | { kind: "p"; text: L }
  /** Numbered how-to. */
  | { kind: "steps"; items: L[] }
  /** Bullet tips / notes / warnings. */
  | { kind: "tips"; items: L[] }
  /** Shortcuts. `keys` like `"Ctrl+K / Ctrl+P"`: `+` joins keys, ` / ` and ` … ` separate alternatives. */
  | { kind: "keys"; items: { keys: string; label: L }[] };

export type HelpSection = { heading: L; blocks: HelpBlock[] };

export type HelpTopic = { id: string; title: L; summary: L; sections: HelpSection[] };
