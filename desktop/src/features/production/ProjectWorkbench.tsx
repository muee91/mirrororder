import { useState } from "react";
import type { ProjectSummary } from "../../api/host";
import { AssistantWorkbench } from "../assistant/AssistantWorkbench";
import { DeliveryWorkbench } from "../delivery/DeliveryWorkbench";
import { TimelineWorkbench } from "../editor/TimelineWorkbench";
import "../editor/timeline.css";
import { IdentityWorkbench } from "../identity/IdentityWorkbench";
import { MaterialScriptWorkbench } from "../material-script/MaterialScriptWorkbench";
import "../material-script/material-script.css";
import { MediaBindingWorkbench } from "../media/MediaBindingWorkbench";
import "../media/media.css";
import { SettingsStatusWorkbench } from "../settings/SettingsStatusWorkbench";
import "../settings/settings.css";
import { SlateWorkbench } from "../slate/SlateWorkbench";
import "./production.css";

interface Props {
  baseUrl: string;
  project: ProjectSummary;
}

type ProductionTab = "material" | "slate" | "identity" | "assistant" | "timeline" | "delivery" | "media" | "settings";

const TABS: Array<{ id: ProductionTab; label: string }> = [
  { id: "material", label: "素材 / 剧本" },
  { id: "slate", label: "场记" },
  { id: "identity", label: "人物" },
  { id: "assistant", label: "小镜" },
  { id: "timeline", label: "剪辑" },
  { id: "delivery", label: "交付" },
  { id: "media", label: "本机素材" },
  { id: "settings", label: "设置 / 状态" },
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
      <nav className="project-workbench-nav" aria-label="镜序制作工作台">
        {TABS.map((item) => (
          <button type="button" className={tab === item.id ? "is-active" : ""} key={item.id} onClick={() => setTab(item.id)}>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      {tab === "material" ? <MaterialScriptWorkbench baseUrl={baseUrl} project={project} initialGroupId={materialFocusGroupId} /> : null}
      {tab === "slate" ? <SlateWorkbench baseUrl={baseUrl} projectId={project.project_id} /> : null}
      {tab === "identity" ? <IdentityWorkbench baseUrl={baseUrl} projectId={project.project_id} onOpenTake={openTakeFromEvidence} /> : null}
      {tab === "assistant" ? <AssistantWorkbench baseUrl={baseUrl} projectId={project.project_id} /> : null}
      {tab === "timeline" ? <TimelineWorkbench baseUrl={baseUrl} projectId={project.project_id} /> : null}
      {tab === "delivery" ? <DeliveryWorkbench baseUrl={baseUrl} projectId={project.project_id} /> : null}
      {tab === "media" ? <MediaBindingWorkbench baseUrl={baseUrl} projectId={project.project_id} /> : null}
      {tab === "settings" ? <SettingsStatusWorkbench baseUrl={baseUrl} projectId={project.project_id} /> : null}
    </section>
  );
}
