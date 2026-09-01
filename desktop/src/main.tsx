import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { initializeDesktopAppearance } from "./app/desktopAppearance";
import { ErrorBoundary } from "./app/ErrorBoundary";
import "./styles.css";
import "./desktop-theme.css";
import "./desktop-theme-tools.css";
import "./features/material-script/golden-material-script-theme.css";
import "./desktop-theme-slate.css";
import "./desktop-theme-frozen-surfaces.css";
import "./features/status/status-center-recovery.css";
import "./features/media/media-binding-recovery.css";
import "./features/status/status-center-redesign.css";
import "./app/mirrororder-redesign.css";
import "./app/mirrororder-workspaces-redesign.css";

initializeDesktopAppearance();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
