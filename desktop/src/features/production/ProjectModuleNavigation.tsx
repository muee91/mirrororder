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
  title: "01 / 同步与交付",
  modules: [
    { page: "sync-task", label: "同步任务", description: "进度、异常和重试", requiresSync: false },
    { page: "sync-inspect", label: "同步核对", description: "机位与源视频监看", requiresSync: true },
    { page: "sync-delivery", label: "工程交付", description: "外部剪辑软件", requiresSync: true },
  ],
};

const ORGANIZE_GROUP: ProductionModuleGroup = {
  id: "organize",
  title: "02 / 拍摄素材",
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
  title: "03 / 剪辑辅助",
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
  return (
    <div className="project-module-navigation">
      <div className="project-module-intro">
        <span>制作流程</span>
        <strong>{inputKind === "media-directory" ? "先同步，再整理" : "素材整理与交付"}</strong>
        <small>{inputKind === "media-directory"
          ? syncReady ? "同步可核对 · 可以开始分发工程" : syncPhase === "running" ? "正在同步 · 可检查原始素材" : "同步完成前只开放必要操作"
          : "原有 FCPXML 项目不需要重新对轨"}</small>
      </div>
      {modulesForProject(inputKind).map((group) => (
        <div className="project-module-group" key={group.id}>
          <p className="project-module-group-title">{group.title}</p>
          {group.modules.map((item) => {
            const available = canOpenProductionModule(item.page, inputKind, syncReady);
            return (
              <button type="button" className={`project-module-link${selected === item.page ? " is-active" : ""}`}
                key={item.page} aria-current={selected === item.page ? "page" : undefined}
                disabled={!available}
                title={available ? item.description : "同步完成后开放此模块"}
                onClick={() => onNavigate(item.page)}>
                <span className="project-module-link-title">{item.label}</span>
                <small>{available ? item.description : "等待同步结果"}</small>
              </button>
            );
          })}
        </div>
      ))}
      <div className="project-module-footer">模型配置与团队协作位于全局工具，不要求剪辑师先完成 AI 设置。</div>
    </div>
  );
}
