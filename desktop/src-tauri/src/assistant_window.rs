use serde::{Deserialize, Serialize};
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

pub const DEFAULT_GLOBAL_SHORTCUT: &str = "CommandOrControl+Alt+J";
pub const XIAOJING_WINDOW_URL: &str = "xiaojing.html";

const MAIN_WINDOW: &str = "main";
const XIAOJING_WINDOW: &str = "xiaojing";
const VISIBILITY_CHANGED: &str = "xiaojing:visibility-changed";
const CONTEXT_UPDATED: &str = "xiaojing:context-updated";

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(default)]
pub struct XiaoJingProjectSummary {
    pub project_id: String,
    pub name: String,
    pub input_kind: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(default)]
pub struct XiaoJingContextSnapshot {
    pub base_url: String,
    pub workspace_id: String,
    pub workspace_name: String,
    pub projects: Vec<XiaoJingProjectSummary>,
    pub project_id: String,
    pub project_name: String,
    pub current_page: String,
    pub selection: serde_json::Value,
    pub selection_summary: String,
    pub appearance: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct XiaoJingWindowStatePayload {
    pub visible: bool,
    pub always_on_top: bool,
    pub global_shortcut: String,
    pub global_shortcut_registered: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct XiaoJingMainAction {
    pub kind: String,
    pub project_id: Option<String>,
    pub group_id: Option<String>,
    pub clip_id: Option<String>,
    pub destination: Option<String>,
    pub page: Option<String>,
}

struct InnerState {
    snapshot: Option<XiaoJingContextSnapshot>,
    always_on_top: bool,
    global_shortcut: String,
    global_shortcut_registered: bool,
}

impl Default for InnerState {
    fn default() -> Self {
        Self {
            snapshot: None,
            always_on_top: true,
            global_shortcut: DEFAULT_GLOBAL_SHORTCUT.to_string(),
            global_shortcut_registered: false,
        }
    }
}

#[derive(Default)]
pub struct AssistantWindowState {
    inner: Mutex<InnerState>,
    window_transition: Mutex<()>,
}

impl AssistantWindowState {
    fn lock_inner(&self) -> Result<MutexGuard<'_, InnerState>, String> {
        self.inner.lock().map_err(|_| "小镜状态不可用".into())
    }
}

fn ensure_xiaojing_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(XIAOJING_WINDOW) {
        return Ok(window);
    }

    let always_on_top = app
        .state::<AssistantWindowState>()
        .lock_inner()?
        .always_on_top;
    let builder = WebviewWindowBuilder::new(
        app,
        XIAOJING_WINDOW,
        WebviewUrl::App(XIAOJING_WINDOW_URL.into()),
    )
    .title("小镜")
    .inner_size(440.0, 700.0)
    .min_inner_size(380.0, 500.0)
    .resizable(true)
    .always_on_top(always_on_top)
    .visible_on_all_workspaces(true)
    .shadow(true)
    .background_color(tauri::window::Color(9, 11, 15, 255))
    .visible(false);
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    let window = builder.build().map_err(|error| error.to_string())?;
    let window_clone = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = window_clone.hide();
            let _ = window_clone.emit_to(MAIN_WINDOW, VISIBILITY_CHANGED, false);
        }
    });
    Ok(window)
}

fn is_xiaojing_visible(app: &AppHandle) -> bool {
    app.get_webview_window(XIAOJING_WINDOW)
        .is_some_and(|window| window.is_visible().unwrap_or(false))
}

fn window_state(app: &AppHandle) -> Result<XiaoJingWindowStatePayload, String> {
    let state = app.state::<AssistantWindowState>();
    let inner = state.lock_inner()?;
    Ok(XiaoJingWindowStatePayload {
        visible: is_xiaojing_visible(app),
        always_on_top: inner.always_on_top,
        global_shortcut: inner.global_shortcut.clone(),
        global_shortcut_registered: inner.global_shortcut_registered,
    })
}

fn with_window_transition(
    app: &AppHandle,
    operation: impl FnOnce() -> Result<(), String>,
) -> Result<XiaoJingWindowStatePayload, String> {
    let state = app.state::<AssistantWindowState>();
    // The shortcut and IPC can request the first window at the same time.
    let _transition = state
        .window_transition
        .lock()
        .map_err(|_| "小镜窗口状态不可用")?;
    operation()?;
    window_state(app)
}

fn change_visibility(
    app: &AppHandle,
    requested_visibility: Option<bool>,
) -> Result<XiaoJingWindowStatePayload, String> {
    with_window_transition(app, || {
        let visible = requested_visibility.unwrap_or_else(|| !is_xiaojing_visible(app));
        if visible {
            let window = ensure_xiaojing_window(app)?;
            let state = app.state::<AssistantWindowState>();
            window
                .set_always_on_top(state.lock_inner()?.always_on_top)
                .map_err(|error| error.to_string())?;
            window.unminimize().map_err(|error| error.to_string())?;
            window.show().map_err(|error| error.to_string())?;
            let focus_result = window.set_focus();
            app.emit_to(MAIN_WINDOW, VISIBILITY_CHANGED, true)
                .map_err(|error| error.to_string())?;
            if let Some(snapshot) = &state.lock_inner()?.snapshot {
                app.emit_to(XIAOJING_WINDOW, CONTEXT_UPDATED, snapshot)
                    .map_err(|error| error.to_string())?;
            }
            focus_result.map_err(|error| error.to_string())?;
        } else {
            if let Some(window) = app.get_webview_window(XIAOJING_WINDOW) {
                window.hide().map_err(|error| error.to_string())?;
            }
            app.emit_to(MAIN_WINDOW, VISIBILITY_CHANGED, false)
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    })
}

fn show_xiaojing(app: &AppHandle) -> Result<XiaoJingWindowStatePayload, String> {
    change_visibility(app, Some(true))
}

fn hide_xiaojing(app: &AppHandle) -> Result<XiaoJingWindowStatePayload, String> {
    change_visibility(app, Some(false))
}

fn toggle_xiaojing(app: &AppHandle) -> Result<XiaoJingWindowStatePayload, String> {
    change_visibility(app, None)
}

fn register_global_shortcut(app: &AppHandle) {
    let state = app.state::<AssistantWindowState>();
    let Ok(shortcut) = state
        .lock_inner()
        .map(|inner| inner.global_shortcut.clone())
    else {
        return;
    };
    let registered = app
        .global_shortcut()
        .on_shortcut(shortcut.as_str(), |app_handle, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                // WebView2 must create windows off the event handler thread.
                let app = app_handle.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let _ = toggle_xiaojing(&app);
                });
            }
        })
        .is_ok();
    if let Ok(mut inner) = state.lock_inner() {
        inner.global_shortcut_registered = registered;
    };
}

fn setup_main_window_lifecycle(app: &AppHandle) {
    if let Some(main_window) = app.get_webview_window(MAIN_WINDOW) {
        let app = app.clone();
        main_window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(window) = app.get_webview_window(XIAOJING_WINDOW) {
                    let _ = window.destroy();
                }
                app.exit(0);
            }
        });
    }
}

fn prewarm_xiaojing_window(app: &AppHandle) {
    let app_handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(900));
        let _ = with_window_transition(&app_handle, || {
            if app_handle.get_webview_window(XIAOJING_WINDOW).is_none() {
                ensure_xiaojing_window(&app_handle)?;
            }
            Ok(())
        });
    });
}

pub fn setup(app: &AppHandle) {
    setup_main_window_lifecycle(app);
    register_global_shortcut(app);
    prewarm_xiaojing_window(app);
}

#[tauri::command]
pub async fn xiaojing_toggle(app: AppHandle) -> Result<XiaoJingWindowStatePayload, String> {
    toggle_xiaojing(&app)
}

#[tauri::command]
pub async fn xiaojing_show(app: AppHandle) -> Result<XiaoJingWindowStatePayload, String> {
    show_xiaojing(&app)
}

#[tauri::command]
pub async fn xiaojing_hide(app: AppHandle) -> Result<XiaoJingWindowStatePayload, String> {
    hide_xiaojing(&app)
}

#[tauri::command]
pub async fn xiaojing_set_always_on_top(
    app: AppHandle,
    pinned: bool,
) -> Result<XiaoJingWindowStatePayload, String> {
    with_window_transition(&app, || {
        let state = app.state::<AssistantWindowState>();
        let mut inner = state.lock_inner()?;
        if let Some(window) = app.get_webview_window(XIAOJING_WINDOW) {
            window
                .set_always_on_top(pinned)
                .map_err(|error| error.to_string())?;
        }
        inner.always_on_top = pinned;
        Ok(())
    })
}

#[tauri::command]
pub async fn xiaojing_window_state(app: AppHandle) -> Result<XiaoJingWindowStatePayload, String> {
    window_state(&app)
}

#[tauri::command]
pub async fn xiaojing_sync_context(
    app: AppHandle,
    snapshot: XiaoJingContextSnapshot,
) -> Result<(), String> {
    let state = app.state::<AssistantWindowState>();
    let mut inner = state.lock_inner()?;
    inner.snapshot = Some(snapshot.clone());
    if app.get_webview_window(XIAOJING_WINDOW).is_some() {
        app.emit_to(XIAOJING_WINDOW, CONTEXT_UPDATED, snapshot)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn xiaojing_get_context(
    app: AppHandle,
) -> Result<Option<XiaoJingContextSnapshot>, String> {
    Ok(app
        .state::<AssistantWindowState>()
        .lock_inner()?
        .snapshot
        .clone())
}

fn should_focus_main_window(action: &XiaoJingMainAction) -> bool {
    action.kind != "task_submitted"
}

#[tauri::command]
pub fn xiaojing_dispatch_action(app: AppHandle, action: XiaoJingMainAction) -> Result<(), String> {
    if should_focus_main_window(&action) {
        let window = app
            .get_webview_window(MAIN_WINDOW)
            .ok_or("镜序主窗口不可用")?;
        window.unminimize().map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
    }
    app.emit_to(MAIN_WINDOW, "xiaojing:main-action", action)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tauri_plugin_global_shortcut::Shortcut;

    #[test]
    fn xiaojing_uses_dedicated_window_entry() {
        assert_eq!(XIAOJING_WINDOW_URL, "xiaojing.html");
    }

    #[test]
    fn assistant_window_defaults_to_pinned() {
        let state = AssistantWindowState::default();
        let inner = state.lock_inner().unwrap();
        assert!(inner.snapshot.is_none());
        assert!(inner.always_on_top);
        assert_eq!(inner.global_shortcut, DEFAULT_GLOBAL_SHORTCUT);
        assert!(!inner.global_shortcut_registered);
    }

    #[test]
    fn default_shortcut_is_parseable() {
        assert_eq!(DEFAULT_GLOBAL_SHORTCUT, "CommandOrControl+Alt+J");
        assert!(DEFAULT_GLOBAL_SHORTCUT.parse::<Shortcut>().is_ok());
    }

    #[test]
    fn context_snapshot_roundtrips_and_defaults_missing_fields() {
        let snapshot = XiaoJingContextSnapshot {
            base_url: "http://127.0.0.1:8765".into(),
            workspace_id: "ws".into(),
            workspace_name: "Workspace".into(),
            projects: vec![XiaoJingProjectSummary {
                project_id: "demo".into(),
                name: "Demo".into(),
                input_kind: "media-directory".into(),
            }],
            project_id: "demo".into(),
            project_name: "Demo".into(),
            current_page: "watch".into(),
            selection: json!({"group_id": "G1", "clip_id": "CA"}),
            selection_summary: "Take G1".into(),
            appearance: "dark".into(),
        };
        let serialized = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(serialized["selection"]["clip_id"], "CA");
        assert_eq!(
            serde_json::from_value::<XiaoJingContextSnapshot>(serialized).unwrap(),
            snapshot
        );
        assert_eq!(
            serde_json::from_value::<XiaoJingContextSnapshot>(json!({})).unwrap(),
            XiaoJingContextSnapshot::default()
        );
    }

    #[test]
    fn submitted_tasks_keep_focus_in_the_hud() {
        let action: XiaoJingMainAction =
            serde_json::from_value(json!({"kind": "task_submitted"})).unwrap();
        assert!(!should_focus_main_window(&action));
        let action: XiaoJingMainAction =
            serde_json::from_value(json!({"kind": "open_take", "group_id": "G1"})).unwrap();
        assert!(should_focus_main_window(&action));
    }
}
