// Dev-only fixture for scripts/ux-audit.mjs: synthetic review model plus a
// window.__uxFetch interceptor the runner installs before app code loads.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ProjectWorkbench } from "../../src/features/production/ProjectWorkbench";
import { initializeDesktopAppearance } from "../../src/app/desktopAppearance";
import "../../src/styles.css";
import "../../src/desktop-theme.css";
import "../../src/desktop-theme-tools.css";
import "../../src/desktop-theme-slate.css";
import "../../src/desktop-theme-frozen-surfaces.css";
import "../../src/features/media/media-binding-recovery.css";
import "../../src/app/mirrororder-redesign.css";
import "../../src/app/mirrororder-workspaces-redesign.css";
import "../../src/app/app-chrome.css";
import "../../src/design-system-v2.css";

initializeDesktopAppearance();

const project = {
  project_id: "project",
  name: "人不狠，站不稳",
  input_kind: "fcpxml",
  stats: { takes: 1502, attention: 24 },
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="mirrororder-redesign-shell">
      <ProjectWorkbench baseUrl="http://127.0.0.1:5199" project={project} />
    </div>
  </StrictMode>,
);
