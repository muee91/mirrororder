// Real-Host surface gate. Resolve the selected project from the same workspace
// summary App uses; this shell does not stand in for native packaged acceptance.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ProjectWorkbench } from "../../src/features/production/ProjectWorkbench";
import { initializeDesktopAppearance } from "../../src/app/desktopAppearance";
import { HostConnection } from "../../src/api/host";
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

const baseUrl = globalThis.location.origin;
const projectId = new URLSearchParams(globalThis.location.search).get("project_id")?.trim() || "project";
const root = createRoot(document.getElementById("root")!);

void new HostConnection(baseUrl).projects().then((projects) => {
  const project = projects.find((item) => item.project_id === projectId);
  if (!project) throw new Error(`工作区没有项目 ${projectId}`);
  root.render(
    <StrictMode>
      <div className="mirrororder-redesign-shell">
        <ProjectWorkbench baseUrl={baseUrl} project={project} />
      </div>
    </StrictMode>,
  );
}).catch((error: unknown) => {
  root.render(<div role="alert">{error instanceof Error ? error.message : String(error)}</div>);
});
