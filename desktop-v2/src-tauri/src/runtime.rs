use std::{
    env,
    ffi::OsString,
    path::{Path, PathBuf},
};
use tauri::{path::BaseDirectory, AppHandle, Manager};

const PACKAGED_CORE_DIR: &str = "mirrororder-core";
const PACKAGED_PYTHON_DIR: &str = "mirrororder-python";
const PACKAGED_TOOLS_DIR: &str = "mirrororder-tools";

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
    pub tool_bin: Option<PathBuf>,
}

fn valid_core_root(root: PathBuf) -> Option<PathBuf> {
    let organizer = root.join("src").join("script_organizer");
    let multicam = root.join("vendor").join("multicam-audio-sync").join("scripts");
    (organizer.is_dir() && multicam.is_dir()).then_some(root)
}

fn explicit_core_root() -> Result<Option<PathBuf>, String> {
    let Some(value) = env::var_os("MIRRORORDER_CORE_ROOT") else {
        return Ok(None);
    };
    let root = PathBuf::from(value);
    valid_core_root(root.clone()).map(Some).ok_or_else(|| {
        format!(
            "MIRRORORDER_CORE_ROOT 缺少 src/script_organizer 或 vendor/multicam-audio-sync：{}",
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

fn required_tool_names() -> [&'static str; 2] {
    if cfg!(target_os = "windows") {
        ["ffmpeg.exe", "ffprobe.exe"]
    } else {
        ["ffmpeg", "ffprobe"]
    }
}

fn valid_tool_bin(root: PathBuf) -> Option<PathBuf> {
    let bin = root.join("bin");
    required_tool_names()
        .iter()
        .all(|name| bin.join(name).is_file())
        .then_some(bin)
}

fn packaged_tool_bin(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .resolve(PACKAGED_TOOLS_DIR, BaseDirectory::Resource)
        .ok()
        .and_then(valid_tool_bin)
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
            tool_bin: None,
        });
    }

    if let Some(core_root) = packaged_core_root(app) {
        let python_executable = match env::var_os("MIRRORORDER_PYTHON").or_else(|| packaged_python(app)) {
            Some(value) => value,
            None => {
                return Err(
                    "安装包已包含 MirrorOrder Python Core，但缺少 mirrororder-python 解释器资源。不会静默依赖用户机器上的 python3。"
                        .to_string(),
                )
            }
        };
        let tool_bin = packaged_tool_bin(app).ok_or_else(|| {
            "安装包缺少 mirrororder-tools/bin 下的 ffmpeg/ffprobe。制作运行时必须自带这两个硬依赖；模型与 ASR 后端仍可保持可选。"
                .to_string()
        })?;
        return Ok(PythonRuntimeLayout {
            origin: RuntimeOrigin::PackagedResource,
            source_dir: core_root.join("src"),
            core_root,
            python_executable,
            tool_bin: Some(tool_bin),
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
        tool_bin: None,
    })
}

pub fn python_path_with_source(source_dir: &Path) -> Result<OsString, String> {
    let mut paths = vec![source_dir.to_path_buf()];
    if let Some(existing) = env::var_os("PYTHONPATH") {
        paths.extend(env::split_paths(&existing));
    }
    env::join_paths(paths).map_err(|error| format!("无法构造 PYTHONPATH：{error}"))
}

pub fn path_with_tools(tool_bin: Option<&Path>) -> Result<Option<OsString>, String> {
    let Some(tool_bin) = tool_bin else {
        return Ok(None);
    };
    let mut paths = vec![tool_bin.to_path_buf()];
    if let Some(existing) = env::var_os("PATH") {
        paths.extend(env::split_paths(&existing));
    }
    env::join_paths(paths)
        .map(Some)
        .map_err(|error| format!("无法构造 packaged runtime PATH：{error}"))
}

#[cfg(test)]
mod tests {
    use super::{packaged_python_candidates, path_with_tools, valid_core_root, valid_tool_bin};
    use std::{env, fs, path::Path};

    #[test]
    fn core_root_requires_python_core_and_multicam_engine() {
        let root = env::temp_dir().join(format!("mirrororder-runtime-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src").join("script_organizer")).unwrap();
        assert!(valid_core_root(root.clone()).is_none());
        fs::create_dir_all(root.join("vendor").join("multicam-audio-sync").join("scripts")).unwrap();
        assert!(valid_core_root(root.clone()).is_some());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn packaged_python_candidates_are_scoped_to_runtime_root() {
        let root = Path::new("/runtime");
        for candidate in packaged_python_candidates(root) {
            assert!(candidate.starts_with(root));
        }
    }

    #[test]
    fn tool_root_requires_ffmpeg_and_ffprobe() {
        let root = env::temp_dir().join(format!("mirrororder-tools-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("bin")).unwrap();
        let names = if cfg!(target_os = "windows") {
            ["ffmpeg.exe", "ffprobe.exe"]
        } else {
            ["ffmpeg", "ffprobe"]
        };
        fs::write(root.join("bin").join(names[0]), b"tool").unwrap();
        assert!(valid_tool_bin(root.clone()).is_none());
        fs::write(root.join("bin").join(names[1]), b"tool").unwrap();
        assert_eq!(valid_tool_bin(root.clone()), Some(root.join("bin")));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn tool_path_is_prepended_without_dropping_existing_path() {
        let joined = path_with_tools(Some(Path::new("/runtime/bin"))).unwrap().unwrap();
        let paths: Vec<_> = env::split_paths(&joined).collect();
        assert_eq!(paths.first(), Some(&Path::new("/runtime/bin").to_path_buf()));
    }
}
