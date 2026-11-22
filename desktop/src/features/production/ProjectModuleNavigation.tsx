import type { ProductionPage } from "../../app/resumeState";
import { StudioIcon, type StudioIconName } from "../../components/StudioIcons";

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

/**
 * The production rail intentionally exposes five stable workbenches. The
 * detailed pages remain addressable through each workbench's own subbar.
 */
const PRIMARY_MODULES: ReadonlyArray<{
  id: "sync" | "slate" | "script" | "material" | "review";
  label: string;
  icon: StudioIconName;
  target: ProductionPage;
  pages: readonly ProductionPage[];
  requiresSync: boolean;
}> = [
  { id: "sync", label: "同步", icon: "sync-task", target: "sync-task", pages: ["sync-task", "sync-inspect", "sync-delivery"], requiresSync: false },
  { id: "slate", label: "场记", icon: "slate", target: "slate", pages: ["slate"], requiresSync: true },
  { id: "script", label: "剧本", icon: "script", target: "script", pages: ["script"], requiresSync: true },
  { id: "material", label: "素材", icon: "media-library", target: "media-library", pages: ["media-library", "takes", "identity", "media-binding"], requiresSync: false },
  { id: "review", label: "审阅", icon: "watch", target: "watch", pages: ["watch", "timeline"], requiresSync: true },
];

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
  selected: ProductionPage | null;
  syncReady: boolean;
  syncPhase: string;
  onNavigate: (page: ProductionPage) => void;
}

export function ProjectModuleNavigation({ inputKind, selected, syncReady, syncPhase, onNavigate }: Props) {
  const selectedModule = selected === "takes" ? "media-library" : selected;

  function renderPrimaryButton(item: (typeof PRIMARY_MODULES)[number]) {
    const active = selectedModule !== null && item.pages.includes(selectedModule);
    const target = item.id === "sync" && syncReady ? "sync-inspect" : item.target;
    const available = canOpenProductionModule(target, inputKind, syncReady);
    const accessibleLabel = {
      // Keep the sync workbench name stable while its first page changes from
      // the task view to verification. The parenthesized state still tells
      // assistive technology which page will open before the first read.
      sync: syncReady ? "同步核对" : "同步核对（当前为同步任务）",
      slate: "交互场记",
      script: "剧本关联",
      material: "素材库",
      review: "看片审阅",
    }[item.id];
    const title = {
      sync: "多机位同步、听看核对与导出工程",
      slate: "按拍摄顺序看片、记场镜备注与标误录",
      script: "按剧本与台词检索实拍素材",
      material: "查看源文件、机位归属与换盘重连",
      review: "进阶：看片选片、粗剪顺片与团队协作",
    }[item.id];
    return (
      <button
        type="button"
        data-tauri-drag-region="no-drag"
        className={`project-module-link${active ? " is-active" : ""}${item.id === "review" ? " is-secondary-module" : ""}`}
        key={item.id}
        aria-current={active ? "page" : undefined}
        aria-label={accessibleLabel}
        disabled={!available}
        title={available ? title : "同步完成后开放此工作区"}
        onClick={() => {
          if (canOpenProductionModule(target, inputKind, syncReady)) onNavigate(target);
        }}
      >
        <StudioIcon name={item.icon} size={16} className="project-module-icon" />
        <span className="project-module-link-title">{item.label}</span>
        {item.id === "sync" && syncPhase === "running" && <span className="project-module-running" aria-label="同步中" />}
      </button>
    );
  }

  return (
    <div className="project-module-navigation" role="list">
      {PRIMARY_MODULES.map((item) => (
        <div className="project-module-group" role="listitem" key={item.id}>
          {item.id === "review" ? <div className="project-module-divider" aria-hidden="true" /> : null}
          {renderPrimaryButton(item)}
        </div>
      ))}
    </div>
  );
}
