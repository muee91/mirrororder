use mirrororder_timeline_core::{Command, TimelineProject};
use serde::{Deserialize, Serialize};
use std::{
    env,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const PERSISTENCE_VERSION: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimelineDocument {
    pub version: u32,
    pub saved_at_ms: u64,
    pub generation: String,
    pub journal_sequence: u64,
    pub project: TimelineProject,
}

#[derive(Debug, Clone)]
pub struct LoadedCheckpoint {
    pub project: TimelineProject,
    pub used_backup: bool,
    pub generation: String,
    pub journal_sequence: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum JournalOperation {
    Apply { command: Command },
    ApplyBatch { commands: Vec<Command> },
    Undo,
    Redo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JournalEntry {
    pub generation: String,
    pub sequence: u64,
    pub created_at_ms: u64,
    pub operation: JournalOperation,
}

#[derive(Debug, Clone)]
pub struct JournalRead {
    pub entries: Vec<JournalEntry>,
    pub ignored_partial_tail: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PersistenceStatus {
    pub project_id: String,
    pub checkpoint_path: String,
    pub journal_path: String,
    pub backup_path: String,
    pub generation: String,
    pub checkpoint_sequence: u64,
    pub journal_operations: usize,
    pub ignored_partial_tail: bool,
}

#[derive(Debug, Clone)]
pub struct TimelineStorage {
    project_id: String,
    checkpoint_path: PathBuf,
    journal_path: PathBuf,
    backup_path: PathBuf,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn stable_hash(value: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

pub fn new_generation(project_id: &str) -> String {
    format!(
        "{:016x}-{:08x}-{:016x}",
        now_ms(),
        std::process::id(),
        stable_hash(project_id)
    )
}

fn safe_project_key(project_id: &str) -> String {
    let readable: String = project_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    let readable = readable.trim_matches('_');
    let readable = if readable.is_empty() { "project" } else { readable };
    format!("{readable}-{:016x}", stable_hash(project_id))
}

fn default_data_root() -> Result<PathBuf, String> {
    if cfg!(target_os = "windows") {
        return env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|path| path.join("MirrorOrder").join("timeline-v1"))
            .ok_or_else(|| "找不到 Windows LOCALAPPDATA，无法持久化 Timeline".to_string());
    }
    if cfg!(target_os = "macos") {
        return env::var_os("HOME")
            .map(PathBuf::from)
            .map(|path| path.join("Library").join("Application Support").join("MirrorOrder").join("timeline-v1"))
            .ok_or_else(|| "找不到 HOME，无法持久化 Timeline".to_string());
    }
    if let Some(root) = env::var_os("XDG_DATA_HOME") {
        return Ok(PathBuf::from(root).join("MirrorOrder").join("timeline-v1"));
    }
    env::var_os("HOME")
        .map(PathBuf::from)
        .map(|path| path.join(".local").join("share").join("MirrorOrder").join("timeline-v1"))
        .ok_or_else(|| "找不到 XDG_DATA_HOME/HOME，无法持久化 Timeline".to_string())
}

fn sync_parent(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        if let Some(parent) = path.parent() {
            let directory = File::open(parent)
                .map_err(|error| format!("无法打开 Timeline 目录 {}：{error}", parent.display()))?;
            directory
                .sync_all()
                .map_err(|error| format!("无法同步 Timeline 目录 {}：{error}", parent.display()))?;
        }
    }
    Ok(())
}

fn atomic_replace(path: &Path, backup: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| format!("Timeline checkpoint 路径没有父目录：{}", path.display()))?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建 Timeline 目录 {}：{error}", parent.display()))?;
    let temp = path.with_extension("json.tmp");
    {
        let mut file = OpenOptions::new().create(true).truncate(true).write(true).open(&temp)
            .map_err(|error| format!("无法创建 Timeline 临时文件 {}：{error}", temp.display()))?;
        file.write_all(bytes).map_err(|error| format!("无法写入 Timeline 临时文件 {}：{error}", temp.display()))?;
        file.sync_all().map_err(|error| format!("无法同步 Timeline 临时文件 {}：{error}", temp.display()))?;
    }
    if path.exists() {
        if backup.exists() {
            fs::remove_file(backup).map_err(|error| format!("无法替换 Timeline 备份 {}：{error}", backup.display()))?;
        }
        fs::rename(path, backup).map_err(|error| format!("无法把旧 Timeline checkpoint 移到备份 {} → {}：{error}", path.display(), backup.display()))?;
    }
    if let Err(error) = fs::rename(&temp, path) {
        if backup.exists() && !path.exists() {
            let _ = fs::rename(backup, path);
        }
        return Err(format!("无法提交 Timeline checkpoint {}：{error}", path.display()));
    }
    sync_parent(path)?;
    Ok(())
}

impl TimelineStorage {
    pub fn for_project(project_id: &str) -> Result<Self, String> {
        let project_id = project_id.trim();
        if project_id.is_empty() {
            return Err("Timeline persistence 需要 project_id".to_string());
        }
        Self::with_root(project_id, default_data_root()?)
    }

    pub fn with_root(project_id: &str, root: PathBuf) -> Result<Self, String> {
        let project_id = project_id.trim();
        if project_id.is_empty() {
            return Err("Timeline persistence 需要 project_id".to_string());
        }
        let key = safe_project_key(project_id);
        let directory = root.join(key);
        Ok(Self {
            project_id: project_id.to_string(),
            checkpoint_path: directory.join("checkpoint.json"),
            journal_path: directory.join("journal.jsonl"),
            backup_path: directory.join("checkpoint.json.bak"),
        })
    }

    pub fn exists(&self) -> bool {
        self.checkpoint_path.is_file() || self.backup_path.is_file()
    }

    pub fn write_checkpoint(&self, project: &TimelineProject, generation: &str, journal_sequence: u64) -> Result<(), String> {
        if project.project_id != self.project_id {
            return Err(format!("拒绝把 project {} 写入 {} 的 Timeline 存储", project.project_id, self.project_id));
        }
        if generation.trim().is_empty() {
            return Err("Timeline checkpoint generation 不能为空".to_string());
        }
        let document = TimelineDocument {
            version: PERSISTENCE_VERSION,
            saved_at_ms: now_ms(),
            generation: generation.to_string(),
            journal_sequence,
            project: project.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&document).map_err(|error| format!("无法序列化 Timeline checkpoint：{error}"))?;
        atomic_replace(&self.checkpoint_path, &self.backup_path, &bytes)?;
        // A failed truncate is harmless for recovery: the checkpoint records
        // the last included sequence, so stale journal rows are skipped.
        self.truncate_journal()?;
        Ok(())
    }

    fn decode_checkpoint(&self, bytes: &[u8]) -> Result<TimelineDocument, String> {
        let document = serde_json::from_slice::<TimelineDocument>(bytes).map_err(|error| format!("Timeline checkpoint JSON 损坏：{error}"))?;
        if document.version != PERSISTENCE_VERSION {
            return Err(format!("不支持的 Timeline persistence version：{}", document.version));
        }
        if document.project.project_id != self.project_id {
            return Err("Timeline checkpoint project_id 不匹配".to_string());
        }
        if document.generation.trim().is_empty() {
            return Err("Timeline checkpoint generation 缺失".to_string());
        }
        Ok(document)
    }

    pub fn load_checkpoint(&self) -> Result<LoadedCheckpoint, String> {
        if let Ok(bytes) = fs::read(&self.checkpoint_path) {
            if let Ok(document) = self.decode_checkpoint(&bytes) {
                return Ok(LoadedCheckpoint {
                    project: document.project,
                    used_backup: false,
                    generation: document.generation,
                    journal_sequence: document.journal_sequence,
                });
            }
        }
        let bytes = fs::read(&self.backup_path).map_err(|error| format!("Timeline checkpoint 不可读，且备份 {} 也无法读取：{error}", self.backup_path.display()))?;
        let document = self.decode_checkpoint(&bytes).map_err(|error| format!("Timeline 备份损坏：{error}"))?;
        Ok(LoadedCheckpoint {
            project: document.project,
            used_backup: true,
            generation: document.generation,
            journal_sequence: document.journal_sequence,
        })
    }

    pub fn append(&self, entry: &JournalEntry) -> Result<(), String> {
        if entry.generation.trim().is_empty() || entry.sequence == 0 {
            return Err("Timeline journal 需要 generation 且 sequence 必须大于 0".to_string());
        }
        let parent = self.journal_path.parent().ok_or_else(|| "Timeline journal 路径没有父目录".to_string())?;
        fs::create_dir_all(parent).map_err(|error| format!("无法创建 Timeline journal 目录：{error}"))?;
        let mut file = OpenOptions::new().create(true).append(true).open(&self.journal_path)
            .map_err(|error| format!("无法打开 Timeline journal：{error}"))?;
        serde_json::to_writer(&mut file, entry).map_err(|error| format!("无法编码 Timeline journal：{error}"))?;
        file.write_all(b"\n").map_err(|error| format!("无法提交 Timeline journal：{error}"))?;
        file.sync_data().map_err(|error| format!("无法同步 Timeline journal：{error}"))?;
        Ok(())
    }

    pub fn read_journal(&self) -> Result<JournalRead, String> {
        if !self.journal_path.exists() {
            return Ok(JournalRead { entries: Vec::new(), ignored_partial_tail: false });
        }
        let bytes = fs::read(&self.journal_path).map_err(|error| format!("无法读取 Timeline journal：{error}"))?;
        let ended_with_newline = bytes.ends_with(b"\n");
        let reader = BufReader::new(bytes.as_slice());
        let mut entries = Vec::new();
        let mut ignored_partial_tail = false;
        let lines: Vec<_> = reader.lines().collect::<Result<Vec<_>, _>>().map_err(|error| format!("无法解析 Timeline journal 行：{error}"))?;
        let last_index = lines.len().saturating_sub(1);
        for (index, line) in lines.into_iter().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<JournalEntry>(&line) {
                Ok(entry) => entries.push(entry),
                Err(error) if index == last_index && !ended_with_newline => {
                    ignored_partial_tail = true;
                    let _ = error;
                }
                Err(error) => return Err(format!("Timeline journal 第 {} 行损坏：{error}", index + 1)),
            }
        }
        Ok(JournalRead { entries, ignored_partial_tail })
    }

    pub fn truncate_journal(&self) -> Result<(), String> {
        if let Some(parent) = self.journal_path.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("无法创建 Timeline journal 目录：{error}"))?;
        }
        let file = OpenOptions::new().create(true).truncate(true).write(true).open(&self.journal_path)
            .map_err(|error| format!("无法清空 Timeline journal：{error}"))?;
        file.sync_all().map_err(|error| format!("无法同步空 Timeline journal：{error}"))?;
        Ok(())
    }

    pub fn status(&self, generation: &str, checkpoint_sequence: u64) -> Result<PersistenceStatus, String> {
        let journal = self.read_journal()?;
        let journal_operations = journal.entries.iter()
            .filter(|entry| entry.generation == generation && entry.sequence > checkpoint_sequence)
            .count();
        Ok(PersistenceStatus {
            project_id: self.project_id.clone(),
            checkpoint_path: self.checkpoint_path.display().to_string(),
            journal_path: self.journal_path.display().to_string(),
            backup_path: self.backup_path.display().to_string(),
            generation: generation.to_string(),
            checkpoint_sequence,
            journal_operations,
            ignored_partial_tail: journal.ignored_partial_tail,
        })
    }
}

pub fn journal_entry(generation: &str, sequence: u64, operation: JournalOperation) -> JournalEntry {
    JournalEntry {
        generation: generation.to_string(),
        sequence,
        created_at_ms: now_ms(),
        operation,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mirrororder_timeline_core::TimelineProject;

    fn temp_root(label: &str) -> PathBuf {
        let nonce = now_ms();
        env::temp_dir().join(format!("mirrororder-{label}-{}-{nonce}", std::process::id()))
    }

    #[test]
    fn stable_project_key_does_not_collide_on_sanitized_names() {
        assert_ne!(safe_project_key("项目/一"), safe_project_key("项目:一"));
        assert_eq!(safe_project_key("p1"), safe_project_key("p1"));
    }

    #[test]
    fn checkpoint_and_journal_round_trip() {
        let root = temp_root("timeline-persistence");
        let storage = TimelineStorage::with_root("p1", root.clone()).unwrap();
        let project = TimelineProject::empty("p1", "main");
        let generation = new_generation("p1");
        storage.write_checkpoint(&project, &generation, 0).unwrap();
        storage.append(&journal_entry(&generation, 1, JournalOperation::Undo)).unwrap();
        let restored = storage.load_checkpoint().unwrap();
        assert_eq!(restored.project, project);
        assert!(!restored.used_backup);
        assert_eq!(restored.generation, generation);
        assert_eq!(restored.journal_sequence, 0);
        assert_eq!(storage.read_journal().unwrap().entries[0].sequence, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn checkpoint_sequence_makes_stale_journal_rows_harmless() {
        let root = temp_root("timeline-checkpoint-window");
        let storage = TimelineStorage::with_root("p1", root.clone()).unwrap();
        let project = TimelineProject::empty("p1", "main");
        let generation = new_generation("p1");
        storage.write_checkpoint(&project, &generation, 1).unwrap();
        storage.append(&journal_entry(&generation, 1, JournalOperation::Undo)).unwrap();
        let loaded = storage.load_checkpoint().unwrap();
        assert_eq!(loaded.journal_sequence, 1);
        assert_eq!(storage.status(&generation, loaded.journal_sequence).unwrap().journal_operations, 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_new_generation_ignores_old_journal_rows() {
        let root = temp_root("timeline-generation");
        let storage = TimelineStorage::with_root("p1", root.clone()).unwrap();
        let project = TimelineProject::empty("p1", "main");
        let old = new_generation("old");
        let current = new_generation("current");
        storage.write_checkpoint(&project, &current, 0).unwrap();
        storage.append(&journal_entry(&old, 99, JournalOperation::Undo)).unwrap();
        assert_eq!(storage.status(&current, 0).unwrap().journal_operations, 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn primary_checkpoint_failure_falls_back_to_backup() {
        let root = temp_root("timeline-backup");
        let storage = TimelineStorage::with_root("p1", root.clone()).unwrap();
        let first = TimelineProject::empty("p1", "main");
        let generation = new_generation("p1");
        storage.write_checkpoint(&first, &generation, 0).unwrap();
        storage.write_checkpoint(&first, &generation, 0).unwrap();
        fs::write(&storage.checkpoint_path, b"{broken").unwrap();
        let restored = storage.load_checkpoint().unwrap();
        assert_eq!(restored.project, first);
        assert!(restored.used_backup);
        fs::remove_dir_all(root).unwrap();
    }
}
