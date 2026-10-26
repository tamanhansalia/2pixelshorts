//! Storage cleanup: finds files 2pixelshorts created and moves them to the Trash.
//!
//! Only paths this scanner classifies itself are ever deleted. The UI's
//! selection is a request, never an authority: `delete` re-scans and refuses
//! anything that is no longer an app-made, unprotected item. Original
//! recordings carry no app marker, so they can never be listed.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Sidecars the pipeline writes as `<output>.mp4<suffix>`; they mark a render.
const RENDER_SIDECARS: [&str; 4] = [".words.json", ".edl.json", ".edit.json", ".takes_packed.md"];
/// Written by stream_clip.py next to each downloaded clip.
const SOURCE_SIDECAR: &str = ".source.json";
/// Framing report, written as `<stem>.framing.json` beside a render.
const FRAMING_SUFFIX: &str = ".framing.json";
/// Staged render files (`tempfile.mkstemp` in short_pipeline.py).
const PARTIAL_PREFIX: &str = ".pixel_render_";
/// A staged render still being written is never "half finished".
const PARTIAL_MIN_AGE: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageScope {
    /// Folders holding app outputs or downloads (from history, drafts, queue).
    #[serde(default)]
    pub directories: Vec<String>,
    /// Original record spellings, returned on deletion to reconcile relative paths.
    #[serde(default)]
    pub record_paths: Vec<String>,
    /// Render outputs recorded by the app, including older exports without sidecars.
    #[serde(default)]
    pub rendered_videos: Vec<String>,
    /// Stream clips downloaded before downloads wrote a `.source.json` marker.
    #[serde(default)]
    pub legacy_stream_clips: Vec<String>,
    /// Files in use (rendering or waiting to publish): listed, never deleted.
    #[serde(default)]
    pub protected: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StorageKind {
    Render,
    StreamClip,
    Partial,
    Analysis,
    Cache,
    EngineBackup,
}

#[derive(Debug, Clone, Serialize)]
pub struct StorageItem {
    /// Identity of the item: the video, cache folder, or backup folder.
    pub path: String,
    pub kind: StorageKind,
    pub bytes: u64,
    /// Everything moved to the Trash together with this item.
    pub files: Vec<String>,
    pub modified_ms: Option<u64>,
    pub protected: bool,
}

#[derive(Debug, Serialize)]
pub struct DeleteFailure {
    pub path: String,
    pub error: String,
}

#[derive(Debug, Default, Serialize)]
pub struct DeleteReport {
    /// Item paths that were moved to the Trash.
    pub removed: Vec<String>,
    /// Every file path moved with them, for updating app records.
    pub removed_files: Vec<String>,
    pub failed: Vec<DeleteFailure>,
    pub bytes: u64,
}

/// Fixed locations owned by the app, outside any project folder.
pub struct Roots {
    pub cache_dirs: Vec<PathBuf>,
    pub engine_backups: Option<PathBuf>,
    /// YouTube/Twitch clip windows downloaded with no local source file.
    pub clip_dir: Option<PathBuf>,
}

impl Roots {
    pub fn detect() -> Self {
        let home = std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from);
        // trending.py caches in `<helpers>/../.cache`.
        let mut cache_dirs: Vec<PathBuf> = Vec::new();
        let script = PathBuf::from(crate::jobs::resolve_pipeline_script());
        if let Some(engine) = script.parent().and_then(|helpers| helpers.parent()) {
            cache_dirs.push(engine.join(".cache"));
        }
        if let Some(home) = &home {
            cache_dirs.push(home.join(".2pixelshorts").join("video-use").join(".cache"));
        }
        Roots {
            cache_dirs: cache_dirs.iter().map(|d| identity(d)).collect(),
            engine_backups: home.as_ref().map(|h| h.join(".2pixelshorts").join("engine-backups")),
            clip_dir: home.map(|h| h.join(".2pixelshorts").join("clips")),
        }
    }
}

fn identity(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| {
        if path.is_absolute() { path.to_path_buf() } else {
            std::env::current_dir().unwrap_or_default().join(path)
        }
    })
}

fn modified_ms(meta: &std::fs::Metadata) -> Option<u64> {
    meta.modified().ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
}

/// Regular files only: symlinks are never followed or listed.
fn regular_file(path: &Path) -> Option<std::fs::Metadata> {
    std::fs::symlink_metadata(path).ok().filter(|m| m.is_file())
}

fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else { return 0 };
    entries
        .flatten()
        .map(|entry| match entry.file_type() {
            Ok(t) if t.is_dir() => dir_size(&entry.path()),
            Ok(t) if t.is_file() => entry.metadata().map(|m| m.len()).unwrap_or(0),
            _ => 0,
        })
        .sum()
}

fn is_mp4(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with(".mp4")
}

/// `<anything>_clip<digits>.mp4`, the only name Studio gives stream downloads.
fn is_stream_clip_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let Some(stem) = lower.strip_suffix(".mp4") else { return false };
    if let Some(legacy) = stem.strip_prefix("stream_src_") {
        if let Some((stamp, index)) = legacy.split_once('_') {
            if !stamp.is_empty() && !index.is_empty()
                && stamp.bytes().all(|b| b.is_ascii_digit())
                && index.bytes().all(|b| b.is_ascii_digit()) {
                return true;
            }
        }
    }
    let Some(index) = stem.rfind("_clip") else { return false };
    let digits = &stem[index + "_clip".len()..];
    index > 0 && !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

fn stem_of(name: &str) -> &str {
    name.rfind('.').map_or(name, |i| &name[..i])
}

fn build_item(kind: StorageKind, path: &Path, files: Vec<PathBuf>) -> StorageItem {
    let metas: Vec<_> = files.iter().filter_map(|f| regular_file(f)).collect();
    StorageItem {
        path: path.to_string_lossy().into_owned(),
        kind,
        bytes: metas.iter().map(|m| m.len()).sum(),
        modified_ms: metas.iter().filter_map(modified_ms).max(),
        files: files.iter().map(|f| f.to_string_lossy().into_owned()).collect(),
        protected: false,
    }
}

fn scan_directory(dir: &Path, legacy: &HashSet<PathBuf>, renders: &HashSet<PathBuf>, now: SystemTime, out: &mut Vec<StorageItem>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let names: BTreeMap<String, std::fs::Metadata> = entries
        .flatten()
        .filter_map(|entry| {
            let meta = std::fs::symlink_metadata(entry.path()).ok().filter(|m| m.is_file())?;
            Some((entry.file_name().to_string_lossy().into_owned(), meta))
        })
        .collect();
    let mut claimed: HashSet<String> = HashSet::new();

    for (name, meta) in &names {
        if !is_mp4(name) {
            continue;
        }
        let framing = format!("{}{}", stem_of(name), FRAMING_SUFFIX);
        let with = |suffixes: &[&str]| -> Vec<String> {
            suffixes.iter().map(|s| format!("{name}{s}")).filter(|n| names.contains_key(n)).collect()
        };
        let (kind, mut members) = if name.starts_with(PARTIAL_PREFIX) {
            let age = meta.modified().ok().and_then(|m| now.duration_since(m).ok());
            if age.is_none_or(|a| a < PARTIAL_MIN_AGE) {
                continue;
            }
            (StorageKind::Partial, vec![])
        } else if !with(&RENDER_SIDECARS).is_empty() || renders.contains(&identity(&dir.join(name))) {
            (StorageKind::Render, with(&RENDER_SIDECARS))
        } else if names.contains_key(&format!("{name}{SOURCE_SIDECAR}")) {
            (StorageKind::StreamClip, with(&[SOURCE_SIDECAR]))
        } else if legacy.contains(&identity(&dir.join(name))) && is_stream_clip_name(name) {
            (StorageKind::StreamClip, vec![])
        } else {
            continue;
        };
        let source = format!("{name}{SOURCE_SIDECAR}");
        if names.contains_key(&source) && !members.contains(&source) {
            members.push(source);
        }
        if names.contains_key(&framing) {
            members.push(framing);
        }
        members.insert(0, name.clone());
        claimed.extend(members.iter().cloned());
        let files = members.iter().map(|m| dir.join(m)).collect();
        out.push(build_item(kind, &dir.join(name), files));
    }

    // Sidecars whose video is gone, grouped under the missing video's path.
    let mut orphans: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
    for name in names.keys() {
        if claimed.contains(name) {
            continue;
        }
        let base = RENDER_SIDECARS
            .iter()
            .chain(std::iter::once(&SOURCE_SIDECAR))
            .find_map(|s| name.strip_suffix(s).filter(|b| is_mp4(b)).map(str::to_string))
            .or_else(|| name.strip_suffix(FRAMING_SUFFIX).map(|stem| format!("{stem}.mp4")));
        if let Some(base) = base.filter(|b| !names.contains_key(b)) {
            orphans.entry(base).or_default().push(dir.join(name));
        }
    }
    for (base, files) in orphans {
        // A staged render's framing report belongs with the half-finished renders,
        // and only once the render that wrote it has stopped.
        let kind = if base.starts_with(PARTIAL_PREFIX) {
            let fresh = files.iter().filter_map(|f| regular_file(f)?.modified().ok())
                .any(|m| now.duration_since(m).map_or(true, |age| age < PARTIAL_MIN_AGE));
            if fresh {
                continue;
            }
            StorageKind::Partial
        } else {
            StorageKind::Analysis
        };
        out.push(build_item(kind, &dir.join(base), files));
    }
}

fn scan_at(scope: &StorageScope, roots: &Roots, now: SystemTime) -> Vec<StorageItem> {
    let mut items = Vec::new();
    let legacy: HashSet<PathBuf> = scope.legacy_stream_clips.iter().map(|p| identity(Path::new(p))).collect();
    let renders: HashSet<PathBuf> = scope.rendered_videos.iter().map(|p| identity(Path::new(p))).collect();
    let mut seen_dirs = HashSet::new();
    // Helpers inherit the app working directory for relative output names. Scan
    // it even after records are cleared so marked leftovers remain discoverable.
    for dir in scope.directories.iter().map(String::as_str) {
        let dir = identity(Path::new(dir));
        if !dir.is_dir() || !seen_dirs.insert(dir.clone()) {
            continue;
        }
        scan_directory(&dir, &legacy, &renders, now, &mut items);
    }
    if let Some(clip_dir) = &roots.clip_dir {
        let dir = identity(clip_dir);
        if dir.is_dir() && seen_dirs.insert(dir.clone()) {
            scan_directory(&dir, &legacy, &renders, now, &mut items);
        }
    }

    let mut seen_caches = HashSet::new();
    for dir in &roots.cache_dirs {
        if !dir.is_dir() || !seen_caches.insert(identity(dir)) {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        let mut files: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                name.starts_with("trending_") && name.ends_with(".json") && regular_file(p).is_some()
            })
            .collect();
        if !files.is_empty() {
            files.sort();
            items.push(build_item(StorageKind::Cache, dir, files));
        }
    }

    if let Some(backups) = roots.engine_backups.as_deref().filter(|p| p.is_dir()) {
        if let Ok(entries) = std::fs::read_dir(backups) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                items.push(StorageItem {
                    path: path.to_string_lossy().into_owned(),
                    kind: StorageKind::EngineBackup,
                    bytes: dir_size(&path),
                    files: vec![path.to_string_lossy().into_owned()],
                    modified_ms: entry.metadata().ok().as_ref().and_then(modified_ms),
                    protected: false,
                });
            }
        }
    }

    let protected: HashSet<PathBuf> = scope.protected.iter().map(|p| identity(Path::new(p))).collect();
    for item in &mut items {
        item.protected = item.files.iter().any(|f| protected.contains(&identity(Path::new(f))));
    }
    items.sort_by(|a, b| a.kind.cmp(&b.kind).then(b.modified_ms.cmp(&a.modified_ms)));
    items
}

pub fn scan(scope: &StorageScope, roots: &Roots) -> Vec<StorageItem> {
    scan_at(scope, roots, SystemTime::now())
}

/// Re-scan, then hand each still-eligible requested item to `remove`.
pub fn delete_with(
    scope: &StorageScope,
    roots: &Roots,
    paths: &[String],
    remove: impl Fn(&[PathBuf]) -> Result<(), String>,
) -> DeleteReport {
    let items = scan(scope, roots);
    let mut report = DeleteReport::default();
    for path in paths.iter().collect::<std::collections::BTreeSet<_>>() {
        let Some(item) = items.iter().find(|item| identity(Path::new(&item.path)) == identity(Path::new(path))) else {
            report.failed.push(DeleteFailure { path: path.clone(), error: "No longer found as an app file".into() });
            continue;
        };
        if item.protected {
            report.failed.push(DeleteFailure { path: path.clone(), error: "In use by a render or a queued post".into() });
            continue;
        }
        let files: Vec<PathBuf> = item.files.iter().map(PathBuf::from).filter(|f| f.exists()).collect();
        // Resolve aliases before removal, while canonicalization still works.
        let identities: HashSet<_> = files.iter().map(|p| identity(p)).collect();
        let aliases: Vec<_> = scope.record_paths.iter()
            .filter(|p| identities.contains(&identity(Path::new(p))))
            .cloned().collect();
        match remove(&files) {
            Ok(()) => {
                report.removed.push(path.clone());
                report.removed_files.extend(item.files.iter().cloned());
                report.removed_files.extend(aliases);
                report.bytes += item.bytes;
            }
            Err(error) => report.failed.push(DeleteFailure { path: path.clone(), error }),
        }
    }
    report
}

pub fn move_to_trash(files: &[PathBuf]) -> Result<(), String> {
    if files.is_empty() {
        return Ok(());
    }
    #[allow(unused_mut)]
    let mut context = trash::TrashContext::default();
    // The Finder method asks for Automation permission; NSFileManager does not.
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        context.set_delete_method(DeleteMethod::NsFileManager);
    }
    context.delete_all(files).map_err(|e| format!("Could not move to Trash: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn touch(dir: &Path, name: &str, bytes: usize) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, vec![0u8; bytes]).unwrap();
        path
    }

    fn roots(cache: &Path, backups: &Path) -> Roots {
        Roots {
            cache_dirs: vec![cache.to_path_buf()],
            engine_backups: Some(backups.to_path_buf()),
            clip_dir: None,
        }
    }

    fn scope_for(dir: &Path) -> StorageScope {
        StorageScope { directories: vec![dir.to_string_lossy().into_owned()], ..Default::default() }
    }

    fn find<'a>(items: &'a [StorageItem], name: &str) -> Option<&'a StorageItem> {
        items.iter().find(|i| i.path.ends_with(name))
    }

    #[test]
    fn classifies_only_app_made_files() {
        let tmp = tempfile::tempdir().unwrap();
        let (dir, cache, backups) = (tmp.path().join("out"), tmp.path().join("cache"), tmp.path().join("backups"));
        for d in [&dir, &cache, &backups.join("upgrade-1")] {
            fs::create_dir_all(d).unwrap();
        }
        touch(&dir, "short.mp4", 100);
        touch(&dir, "short.mp4.words.json", 10);
        touch(&dir, "short.mp4.edl.json", 10);
        touch(&dir, "short.framing.json", 5);
        touch(&dir, "talk_clip1.mp4", 300);
        touch(&dir, "talk_clip1.mp4.source.json", 2);
        touch(&dir, "my_recording.mp4", 999);
        touch(&dir, "notes_clip2.mp4", 50);
        touch(&dir, "gone.mp4.words.json", 7);
        touch(&dir, "gone.framing.json", 3);
        touch(&cache, "trending_ai_any.json", 4);
        touch(&cache, "unrelated.json", 4);
        touch(&backups.join("upgrade-1"), "python", 40);

        let items = scan(&scope_for(&dir), &roots(&cache, &backups));
        let render = find(&items, "short.mp4").unwrap();
        assert_eq!(render.kind, StorageKind::Render);
        assert_eq!(render.files.len(), 4);
        assert_eq!(render.bytes, 125);
        let clip = find(&items, "talk_clip1.mp4").unwrap();
        assert_eq!((clip.kind, clip.files.len()), (StorageKind::StreamClip, 2));
        assert!(find(&items, "my_recording.mp4").is_none(), "originals are never listed");
        assert!(find(&items, "notes_clip2.mp4").is_none(), "unmarked clip names need a record");
        let orphan = find(&items, "gone.mp4").unwrap();
        assert_eq!((orphan.kind, orphan.files.len(), orphan.bytes), (StorageKind::Analysis, 2, 10));
        let cache_item = items.iter().find(|i| i.kind == StorageKind::Cache).unwrap();
        assert_eq!(cache_item.files.len(), 1);
        let backup = items.iter().find(|i| i.kind == StorageKind::EngineBackup).unwrap();
        assert_eq!(backup.bytes, 40);
    }

    #[test]
    fn legacy_stream_clips_need_record_and_clip_name() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let clip = touch(dir, "stream_src_1_clip3.mp4", 20);
        let other = touch(dir, "holiday.mp4", 20);
        let scope = StorageScope {
            legacy_stream_clips: vec![clip.to_string_lossy().into(), other.to_string_lossy().into()],
            ..scope_for(dir)
        };
        let items = scan(&scope, &roots(&dir.join("none"), &dir.join("none")));
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].kind, StorageKind::StreamClip);
    }

    #[test]
    fn partial_renders_wait_until_the_render_has_stopped() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        touch(dir, ".pixel_render_abc.mp4", 30);
        touch(dir, ".pixel_render_abc.framing.json", 3);
        let scope = scope_for(dir);
        let none = roots(&dir.join("none"), &dir.join("none"));
        assert!(scan_at(&scope, &none, SystemTime::now()).is_empty());
        let later = scan_at(&scope, &none, SystemTime::now() + PARTIAL_MIN_AGE * 2);
        assert_eq!(later.len(), 1);
        assert_eq!((later[0].kind, later[0].files.len()), (StorageKind::Partial, 2));
    }

    #[test]
    fn delete_refuses_unlisted_and_protected_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let short = touch(dir, "a.mp4", 10);
        touch(dir, "a.mp4.words.json", 1);
        let busy = touch(dir, "b.mp4", 10);
        touch(dir, "b.mp4.edl.json", 1);
        let original = touch(dir, "original.mp4", 10);
        let scope = StorageScope { protected: vec![busy.to_string_lossy().into()], ..scope_for(dir) };
        let none = roots(&dir.join("none"), &dir.join("none"));
        let requested: Vec<String> = [&short, &busy, &original].iter().map(|p| p.to_string_lossy().into()).collect();
        let report = delete_with(&scope, &none, &requested, |files| {
            files.iter().try_for_each(|f| fs::remove_file(f).map_err(|e| e.to_string()))
        });
        assert_eq!(report.removed, vec![short.to_string_lossy().to_string()]);
        assert_eq!(report.removed_files.len(), 2);
        assert_eq!(report.bytes, 11);
        assert_eq!(report.failed.len(), 2);
        assert!(!short.exists() && busy.exists() && original.exists());
    }

    #[test]
    fn relative_paths_find_and_remove_old_exports_with_record_aliases() {
        let cwd = std::env::current_dir().unwrap();
        let tmp = tempfile::tempdir_in(&cwd).unwrap();
        let dir = tmp.path();
        let video = touch(dir, "old.mp4", 25);
        let relative = video.strip_prefix(&cwd).unwrap().to_string_lossy().into_owned();
        let original = touch(dir, "original.mp4", 99);
        let scope = StorageScope {
            directories: vec![dir.strip_prefix(&cwd).unwrap().to_string_lossy().into_owned()],
            rendered_videos: vec![relative.clone()],
            record_paths: vec![relative.clone()],
            ..Default::default()
        };
        let none = roots(&dir.join("none"), &dir.join("none"));
        let items = scan(&scope, &none);
        assert_eq!(items.len(), 1);
        assert!(Path::new(&items[0].path).is_absolute());
        let busy = StorageScope { protected: vec![relative.clone()], ..scope.clone() };
        assert!(scan(&busy, &none)[0].protected);
        let report = delete_with(&scope, &none, &[items[0].path.clone()], |files| {
            files.iter().try_for_each(|f| fs::remove_file(f).map_err(|e| e.to_string()))
        });
        assert!(report.removed_files.contains(&relative));
        assert!(!video.exists());
        assert!(original.exists());
        assert!(scan(&scope, &none).is_empty());
    }

    #[test]
    fn cleanup_includes_packed_takes_and_source_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        touch(dir, "short.mp4", 10);
        touch(dir, "short.mp4.words.json", 2);
        touch(dir, "short.mp4.takes_packed.md", 3);
        touch(dir, "short.mp4.source.json", 4);
        touch(dir, "gone.mp4.takes_packed.md", 5);
        let items = scan(&scope_for(dir), &roots(&dir.join("none"), &dir.join("none")));
        assert_eq!(find(&items, "short.mp4").unwrap().files.len(), 4);
        assert_eq!(find(&items, "gone.mp4").unwrap().kind, StorageKind::Analysis);
    }

    #[test]
    fn native_trash_removes_only_selected_temporary_fixture() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let video = touch(dir, "pixel-storage-test.mp4", 10);
        let sidecar = touch(dir, "pixel-storage-test.mp4.words.json", 2);
        let original = touch(dir, "keep-original.mp4", 5);
        let scope = scope_for(dir);
        let none = roots(&dir.join("none"), &dir.join("none"));
        let report = delete_with(&scope, &none, &[video.to_string_lossy().into_owned()], move_to_trash);
        assert!(report.failed.is_empty(), "{:?}", report.failed);
        assert_eq!(report.removed.len(), 1);
        assert!(!video.exists() && !sidecar.exists());
        assert!(original.exists());
        assert!(scan(&scope, &none).is_empty());
    }

    #[test]
    fn stream_clip_names() {
        assert!(is_stream_clip_name("My_Stream_clip12.mp4"));
        assert!(is_stream_clip_name("stream_src_1791383341047_9.mp4"));
        assert!(!is_stream_clip_name("_clip1.mp4"));
        assert!(!is_stream_clip_name("talk_clip.mp4"));
        assert!(!is_stream_clip_name("talk_clip1a.mp4"));
    }

    #[test]
    fn app_clip_dir_is_scanned_without_a_studio_record() {
        let tmp = tempfile::tempdir().unwrap();
        let clips = tmp.path().join("clips");
        fs::create_dir_all(&clips).unwrap();
        touch(&clips, "Talk_clip1.mp4", 40);
        touch(&clips, "Talk_clip1.mp4.source.json", 4);
        let items = scan(
            &StorageScope::default(),
            &Roots {
                cache_dirs: vec![],
                engine_backups: None,
                clip_dir: Some(clips),
            },
        );
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].kind, StorageKind::StreamClip);
        assert!(items[0].path.ends_with("Talk_clip1.mp4"));
    }
}
