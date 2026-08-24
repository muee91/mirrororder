use std::{
    env,
    ffi::OsString,
    path::{Path, PathBuf},
};
use tauri::{path::BaseDirectory, AppHandle, Manager};

const PACKAGED_CORE_DIR: &str = "mirrororder-core";
const PACKAGED_PYTHON_DIR: &str = "mirrororder-python";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RuntimeOrigin {
    ExplicitOverride,
    PackagedResource,
    DevelopmentSource,
}

#[derive(Clone, Debug)]
pub struct PythonRuntimeLayout {
    pub origin: RuntimeOrigin,
    pub core_root: PathBuf,
    pub source_dir: PathBuf,
    pub python_executable: OsString,
}

fn valid_core_root(root: PathBuf) -> Option<PathBuf> {
    root.join("src").join("script_organizer").is_dir().then_some(root)
}

fn explicit_core_root() -> Result<Option<PathBuf>, String> {
    let Some(value) = env::var_os("MIRRORORDER_CORE_ROOT") else {
        return Ok(None);
    };
    let root = PathBuf::from(value);
    valid_core_root(root.clone()).map(Some).ok_or_else(|| {
        format!(
            "MIRRORORDER_CORE_ROOT 未包含 src/script_organizer：{}",
            root.display()
        )
    })
}

fn packaged_core_root(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .resolve(PACKAGED_CORE_DIR, BaseDirectory::Resource)
        .ok()
        .and_then(valid_core_root)
}

fn development_core_root() -> Option<PathBuf> {
    valid_core_root(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
}

fn packaged_python_candidates(root: &Path) -> Vec<PathBuf> {
    if cfg!(target_os = "windows") {
        vec![root.join("python.exe"), root.join("bin").join("python.exe")]
    } else {
        vec![root.join("bin").join("python3"), root.join("bin").join("python")]
    }
}

fn packaged_python(app: &AppHandle) -> Option<OsString> {
    let root = app
        .path()
        .resolve(PACKAGED_PYTHON_DIR, BaseDirectory::Resource)
        .ok()?;
    packaged_python_candidates(&root)
        .into_iter()
        .find(|path| path.is_file())
        .map(PathBuf::into_os_string)
}

fn system_python() -> OsString {
    if cfg!(target_os = "windows") {
        OsString::from("python")
    } else {
        OsString::from("python3")
    }
}

pub fn resolve_python_runtime(app: &AppHandle) -> Result<PythonRuntimeLayout, String> {
    if let Some(core_root) = explicit_core_root()? {
        let python_executable = env::var_os("MIRRORORDER_PYTHON").unwrap_or_else(system_python);
        return Ok(PythonRuntimeLayout {
            origin: RuntimeOrigin::ExplicitOverride,
            source_dir: core_root.join("src"),
            core_root,
            python_executable,
        });
    }

    if let Some(core_root) = packaged_core_root(app) {
        let python_executable = match env::var_os("MIRRORORDER_PYTHON").or_else(|| packaged_python(app)) {
            Some(value) => value,
            None => {
                return Err(
                    "安装包已包含 MirrorOrder Python Core，但缺少 mirrororder-python 解释器资源。runtime packaging worktree 必须先提供可签名的 portable Python；不会静默依赖用户机器上的 python3。"
                        .to_string(),
                )
            }
        };
        return Ok(PythonRuntimeLayout {
            origin: RuntimeOrigin::PackagedResource,
            source_dir: core_root.join("src"),
            core_root,
            python_executable,
        });
    }

    let core_root = development_core_root().ok_or_else(|| {
        "找不到 MirrorOrder Python Core。开发环境可设置 MIRRORORDER_CORE_ROOT；安装包必须携带 mirrororder-core 资源。"
            .to_string()
    })?;
    let python_executable = env::var_os("MIRRORORDER_PYTHON").unwrap_or_else(system_python);
    Ok(PythonRuntimeLayout {
        origin: RuntimeOrigin::DevelopmentSource,
        source_dir: core_root.join("src"),
        core_root,
        python_executable,
    })
}

pub fn python_path_with_source(source_dir: &Path) -> Result<OsString, String> {
    let mut paths = vec![source_dir.to_path_buf()];
    if let Some(existing) = env::var_os("PYTHONPATH") {
        paths.extend(env::split_paths(&existing));
    }
    env::join_paths(paths).map_err(|error| format!("无法构造 PYTHONPATH：{error}"))
}

#[cfg(test)]
mod tests {
    use super::{packaged_python_candidates, valid_core_root};
    use std::{env, fs};

    #[test]
    fn core_root_requires_script_organizer_under_src() {
        let root = env::temp_dir().join(format!("mirrororder-runtime-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src").join("script_organizer")).unwrap();
        assert!(valid_core_root(root.clone()).is_some());
        fs::remove_dir_all(root.join("src").join("script_organizer")).unwrap();
        assert!(valid_core_root(root.clone()).is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn packaged_python_candidates_are_scoped_to_runtime_root() {
        let root = std::path::Path::new("/runtime");
        for candidate in packaged_python_candidates(root) {
            assert!(candidate.starts_with(root));
        }
    }
}
