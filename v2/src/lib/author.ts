/**
 * Who made Project P and how to reach them, shown in the About / Contact dialog
 * (navigation rail, or "About & contact" in the command palette).
 * Empty fields are hidden; links open in the default browser / mail app.
 */
export interface AuthorLink {
  label: string;
  /** `https://…` or `mailto:…` only. */
  url: string;
}

export const AUTHOR = {
  name: "Phineas",
  role: "",
  /** One or two sentences: what you do, what you are open to. */
  bio: "",
  email: "",
  location: "",
  links: [] as AuthorLink[],
};
