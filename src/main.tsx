// Must run before anything reads `isTauri()`; a no-op outside `npm run dev` with `?mock`.
import "./dev/mockBackend";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initAppearance } from "./stores/settingsStore";
import "./styles/index.css";

// Saved theme and fonts, before the first paint.
initAppearance();

// Block the webview's default context menu outside text fields (desktop-app feel).
window.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement;
  if (!t.closest("input, textarea, [contenteditable], .select-text")) e.preventDefault();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
