import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { initializeDesktopAppearance } from "./app/desktopAppearance";
import { ErrorBoundary } from "./app/ErrorBoundary";
import "./styles.css";
import "./desktop-theme.css";

initializeDesktopAppearance();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
