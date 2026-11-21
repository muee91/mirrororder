use serde::Serialize;
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::Mutex,
};
#[cfg(target_os = "macos")]
use tauri::{Emitter, Manager};

const MAX_PENDING: usize = 32;

#[derive(Clone, Serialize)]
pub struct DocumentOpen {
    id: u32,
    path: PathBuf,
}

#[derive(Default)]
struct Queue {
    pending: VecDeque<DocumentOpen>,
    next_id: u32,
}

impl Queue {
    fn push(&mut self, path: PathBuf) -> bool {
        if !is_project_package(&path) {
            return false;
        }
        if self.pending.len() >= MAX_PENDING || self.pending.iter().any(|entry| entry.path == path)
        {
            return false;
        }
        self.next_id = self.next_id.wrapping_add(1);
        self.pending.push_back(DocumentOpen {
            id: self.next_id,
            path,
        });
        true
    }
    fn finish(&mut self, id: u32) -> bool {
        if !self.pending.front().is_some_and(|entry| entry.id == id) {
            return false;
        }
        self.pending.pop_front();
        true
    }
}

fn is_project_package(path: &Path) -> bool {
    path.is_absolute()
        && path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("mirrorproj"))
}

#[derive(Default)]
pub struct DocumentQueue(Mutex<Queue>);

#[tauri::command]
pub fn peek_document_open(
    queue: tauri::State<'_, DocumentQueue>,
) -> Result<Option<DocumentOpen>, String> {
    let guard = queue
        .0
        .lock()
        .map_err(|_| "无法读取 Finder 打开队列".to_string())?;
    Ok(guard.pending.front().cloned())
}

#[tauri::command]
pub fn finish_document_open(queue: tauri::State<'_, DocumentQueue>, id: u32) -> Result<(), String> {
    let mut guard = queue
        .0
        .lock()
        .map_err(|_| "无法更新 Finder 打开队列".to_string())?;
    if !guard.finish(id) {
        return Err("Finder 打开请求已经变更".into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn receive(app: &tauri::AppHandle, urls: &[tauri::Url]) {
    let changed = {
        let queue = app.state::<DocumentQueue>();
        let Ok(mut guard) = queue.0.lock() else {
            return;
        };
        let mut changed = false;
        for url in urls {
            if url.scheme() != "file"
                || url
                    .host_str()
                    .is_some_and(|host| !host.eq_ignore_ascii_case("localhost"))
                || url.query().is_some()
                || url.fragment().is_some()
            {
                continue;
            }
            if let Ok(path) = url.to_file_path() {
                changed |= guard.push(path);
            }
        }
        changed
    };
    // The event carries no paths. The queue is the authority and still exists
    // if the WebView was not subscribed at cold launch.
    if changed {
        let _ = app.emit_to("main", "mirrororder-document-open", ());
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn opens_only_own_types_and_keeps_order_until_matching_acknowledgment() {
        let mut q = Queue::default();
        assert!(!q.push(PathBuf::from("relative.mirrorproj")));
        assert!(!q.push(PathBuf::from("/tmp/workspace.toml")));
        assert!(!q.push(PathBuf::from("/tmp/foreign.fcpxml")));
        assert!(q.push(PathBuf::from("/tmp/中文 A.MIRRORPROJ")));
        assert!(!q.push(PathBuf::from("/tmp/中文 A.MIRRORPROJ")));
        assert!(!q.push(PathBuf::from("/tmp/backup.mirrorpkg")));
        assert!(q.push(PathBuf::from("/tmp/other.mirrorproj")));
        assert_eq!(
            q.pending.front().unwrap().path,
            PathBuf::from("/tmp/中文 A.MIRRORPROJ")
        );
        assert!(!q.finish(2));
        assert!(q.finish(1));
        assert_eq!(
            q.pending.front().unwrap().path,
            PathBuf::from("/tmp/other.mirrorproj")
        );
        assert!(q.finish(2));
        assert!(q.pending.is_empty());
    }
}
