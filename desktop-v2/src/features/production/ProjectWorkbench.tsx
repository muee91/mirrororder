import { useState } from "react";
import type { ProjectSummary } from "../../api/host";
import { AssistantWorkbench } from "../assistant/AssistantWorkbench";
import { TimelineWorkbench } from "../editor/TimelineWorkbench";
import "../editor/timeline.css";
import { IdentityWorkbench } from "../identity/IdentityWorkbench";
import { MaterialScriptWorkbench } from "../material-script/MaterialScriptWorkbench";
import "../material-script/material-script.css";
import { SlateWorkbench } from "../slate/SlateWorkbench";
import "./production.css";

interface Props {
  baseUrl: string;
  project: ProjectSummary;
}

type ProductionTab = "material" | "slate" | "identity" | "assistant" | "timeline";

const TABS: Array<{ id: ProductionTab; label: string; phase: string }> = [
  { id: "material", label: "素材 / 剧本", phase: "P2" },
  { id: "slate", label: "场记", phase: "P3" },
  { id: "identity", label: "人物", phase: "P3" },
  { id: "assistant", label: "小镜", phase: "P3" },
  { id: "timeline", label: "剪辑", phase: "P4–P5" },
];

export function ProjectWorkbench({ baseUrl, project }: Props) {
  const [tab, setTab] = useState<ProductionTab>("material");
  const [materialFocusGroupId, setMaterialFocusGroupId] = useState<string | null>(null);

  function openTakeFromEvidence(groupId: string): void {
    const value = groupId.trim();
    if (!value) return;
    setMaterialFocusGroupId(value);
    setTab("material");
  }

  return (
    <section className="project-production-workbench">
      <nav className="project-workbench-nav" aria-label="Desktop v2 制作工作台">
        {TABS.map((item) => (
          <button type="button" className={tab === item.id ? "is-active" : ""} key={item.id} onClick={() => setTab(item.id)}>
            <span>{item.label}</span>
            <small>{item.phase}</small>
          </button>
        ))}
      </nav>

      {tab === "material" ? <MaterialScriptWorkbench baseUrl={baseUrl} project={project} initialGroupId={materialFocusGroupId} /> : null}
      {tab === "slate" ? <SlateWorkbench baseUrl={baseUrl} projectId={project.project_id} /> : null}
      {tab === "identity" ? <IdentityWorkbench baseUrl={baseUrl} projectId={project.project_id} onOpenTake={openTakeFromEvidence} /> : null}
      {tab === "assistant" ? <AssistantWorkbench baseUrl={baseUrl} projectId={project.project_id} /> : null}
      {tab === "timeline" ? <TimelineWorkbench baseUrl={baseUrl} projectId={project.project_id} /> : null}
    </section>
  );
}
