import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { initializeDesktopAppearance } from "./app/desktopAppearance";
import { ErrorBoundary } from "./app/ErrorBoundary";
import "./styles.css";
import "./desktop-theme.css";
import "./desktop-theme-tools.css";
import "./desktop-theme-slate.css";
import "./desktop-theme-frozen-surfaces.css";
import "./features/media/media-binding-recovery.css";
import "./app/mirrororder-redesign.css";
import "./app/mirrororder-workspaces-redesign.css";
import "./app/app-chrome.css";
import "./design-system-v2.css";

initializeDesktopAppearance();

const isXiaoJingWindow = new URLSearchParams(window.location.search).get("window") === "xiaojing";
const XiaoJingFloatingWindow = lazy(() => import("./features/assistant/XiaoJingFloatingWindow")
  .then(({ XiaoJingFloatingWindow }) => ({ default: XiaoJingFloatingWindow })));
if (isXiaoJingWindow) document.title = "小镜";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      {isXiaoJingWindow ? <Suspense><XiaoJingFloatingWindow /></Suspense> : <App />}
    </ErrorBoundary>
  </StrictMode>,
);
