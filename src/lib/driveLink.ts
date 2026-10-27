/** Telling a pasted Google Drive link from a folder path. */

export interface DriveLink {
  kind: "folder" | "file";
  id: string;
}

const PATTERNS: [DriveLink["kind"], RegExp][] = [
  ["folder", /drive\.google\.com\/(?:drive\/)?(?:u\/\d+\/)?folders\/([\w-]{10,})/i],
  ["file", /drive\.google\.com\/file\/d\/([\w-]{10,})/i],
  ["file", /docs\.google\.com\/\w+\/d\/([\w-]{10,})/i],
  ["folder", /drive\.google\.com\/(?:open|uc)\?(?:.*&)?id=([\w-]{10,})/i],
];

export function parseDriveLink(text: string): DriveLink | null {
  for (const [kind, re] of PATTERNS) {
    const m = text.trim().match(re);
    if (m) return { kind, id: m[1] };
  }
  return null;
}

/** `G:\…`, `\\server\share`, `/Users/…`: something to open as a folder. */
export function looksLikePath(text: string): boolean {
  const t = text.trim().replace(/^"|"$/g, "");
  return /^[a-z]:[\\/]/i.test(t) || t.startsWith("\\\\") || t.startsWith("/");
}

/** A pasted path without the quotes Explorer's "Copy as path" adds. */
export function cleanPath(text: string): string {
  return text.trim().replace(/^"|"$/g, "");
}
