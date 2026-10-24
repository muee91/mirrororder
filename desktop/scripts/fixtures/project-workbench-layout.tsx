import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ProjectWorkbench } from "../../src/features/production/ProjectWorkbench";
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

const project = {
  project_id: "layout-runtime-project",
  name: "布局回归样本",
  input_kind: "layout-runtime",
  stats: { takes: 668, attention: 68 },
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="mirrororder-redesign-shell">
      <ProjectWorkbench baseUrl="http://127.0.0.1:9" project={project} />
    </div>
  </StrictMode>,
);
