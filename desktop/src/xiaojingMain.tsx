import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initializeDesktopAppearance } from "./app/desktopAppearance";
import { ErrorBoundary } from "./app/ErrorBoundary";
import { XiaoJingFloatingWindow } from "./features/assistant/XiaoJingFloatingWindow";

initializeDesktopAppearance();
document.title = "小镜";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <XiaoJingFloatingWindow />
    </ErrorBoundary>
  </StrictMode>,
);
