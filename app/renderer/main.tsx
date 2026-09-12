import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Bundled rather than fetched. The identity should not depend on the machine
// having a network, and a chat window that reaches out to a font host on open
// is a chat window that tells somebody else when you opened it.
import "@fontsource/cormorant-garamond/300.css";
import "@fontsource/cormorant-garamond/400.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./theme.css";

import { App } from "./App.js";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("the window has no root to render into");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
