import type { ProductionPage } from "../../app/resumeState";

export interface ProductionModule {
  page: ProductionPage;
  label: string;
  description: string;
  requiresSync: boolean;
}

export interface ProductionModuleGroup {
  id: "delivery" | "organize" | "editorial";
  title: string;
  modules: readonly ProductionModule[];
}

const RAW_MEDIA_GROUP: ProductionModuleGroup = {
  id: "delivery",
  title: "同步与交付",
  modules: [
    { page: "sync-task", label: "同步任务", description: "进度、异常和重试", requiresSync: false },
    { page: "sync-inspect", label: "同步核对", description: "机位与源视频监看", requiresSync: true },
    { page: "sync-delivery", label: "工程交付", description: "外部剪辑软件", requiresSync: true },
  ],
};

const ORGANIZE_GROUP: ProductionModuleGroup = {
  id: "organize",
  title: "拍摄素材",
  modules: [
    { page: "slate", label: "交互场记", description: "实际拍摄顺序", requiresSync: true },
    { page: "script", label: "剧本关联", description: "故事顺序与对白", requiresSync: true },
    { page: "identity", label: "演员与角色", description: "人物素材和身份", requiresSync: true },
    { page: "media-library", label: "素材库", description: "源文件清单", requiresSync: false },
    { page: "media-binding", label: "本机素材", description: "硬盘重连与检查", requiresSync: false },
  ],
};

const EDITORIAL_GROUP: ProductionModuleGroup = {
  id: "editorial",
  title: "剪辑辅助",
  modules: [
    { page: "watch", label: "看片审阅", description: "人工选择与判断", requiresSync: true },
    { page: "timeline", label: "选片组接", description: "生成外部 NLE 起点", requiresSync: true },
  ],
};

export function modulesForProject(inputKind: string): readonly ProductionModuleGroup[] {
  return inputKind === "media-directory"
    ? [RAW_MEDIA_GROUP, ORGANIZE_GROUP, EDITORIAL_GROUP]
    : [ORGANIZE_GROUP, EDITORIAL_GROUP];
}

export function canOpenProductionModule(page: ProductionPage, inputKind: string, syncReady: boolean): boolean {
  const module = modulesForProject(inputKind).flatMap((group) => group.modules).find((item) => item.page === page);
  if (page === "takes") return inputKind !== "media-directory" || syncReady;
  if (!module) return false;
  return !module.requiresSync || inputKind !== "media-directory" || syncReady;
}

interface Props {
  inputKind: string;
  selected: ProductionPage;
  syncReady: boolean;
  syncPhase: string;
  onNavigate: (page: ProductionPage) => void;
}

export function ProjectModuleNavigation({ inputKind, selected, syncReady, syncPhase, onNavigate }: Props) {
  const selectedModule = selected === "takes" ? "media-library" : selected;
  return (
    <div className="project-module-navigation">
      {modulesForProject(inputKind).map((group) => (
        <div className="project-module-group" role="group" aria-label={group.title} key={group.id}>
          <span className="project-module-group-title" aria-hidden="true">{group.title}</span>
          {group.modules.map((item) => {
            const available = canOpenProductionModule(item.page, inputKind, syncReady);
            return (
              <button type="button" className={`project-module-link${selectedModule === item.page ? " is-active" : ""}`}
                key={item.page} aria-current={selectedModule === item.page ? "page" : undefined}
                disabled={!available}
                title={available ? item.description : "同步完成后开放此模块"}
                onClick={() => onNavigate(item.page)}>
                <span className="project-module-link-title">{item.label}</span>
                {item.page === "sync-task" && syncPhase === "running" && <span className="project-module-running" aria-label="运行中" />}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
