//! Inspect GitHub packages before installation. Native Fez packages keep
//! their manifest; portable imports retain selected SKILL.md directories.
//! Foreign host integrations are reported, never executed or silently ported.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;

#[derive(serde::Serialize, Clone)]
pub(crate) struct InspectReport {
    pub name: String,
    pub kind: String,
    pub skills: Vec<PersonaFound>,
    pub agents: Vec<PersonaFound>,
    pub ignored: Vec<String>,
    pub refused: Vec<String>,
    pub unsupported: Vec<String>,
    pub permissions: Vec<String>,
    pub components: Vec<String>,
}

#[derive(serde::Serialize, Clone)]
pub(crate) struct PersonaFound {
    pub id: String,
    pub description: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct GitSource {
    pub owner: String,
    pub repo: String,
    pub reference: Option<String>,
    pub path: String,
    pub file: bool,
    // GitHub URLs can contain slash-bearing branch names. Resolve the
    // ref/path boundary before returning the canonical preview URL.
    unresolved: Option<Vec<String>>,
}

fn valid_segment(s: &str) -> bool {
    !s.is_empty() && s != "." && s != ".."
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

fn safe_path(path: &str) -> bool {
    !path.is_empty() && !path.contains(['\\', ':']) && !path.chars().any(char::is_control)
        && path.split('/').all(|p| !p.is_empty() && p != "." && p != "..")
}

fn decode(part: &str) -> Result<String, String> {
    let mut bytes = Vec::new();
    let mut chars = part.as_bytes().iter().copied();
    while let Some(c) = chars.next() {
        if c == b'%' {
            let hi = chars.next().and_then(|v| (v as char).to_digit(16));
            let lo = chars.next().and_then(|v| (v as char).to_digit(16));
            bytes.push(match (hi, lo) {
                (Some(a), Some(b)) => (a * 16 + b) as u8,
                _ => return Err("invalid percent encoding in GitHub URL".into()),
            });
        } else {
            bytes.push(c);
        }
    }
    String::from_utf8(bytes).map_err(|_| "invalid UTF-8 in GitHub URL".into())
}

fn encode(part: &str) -> String {
    part.bytes().map(|b| {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() }
        else { format!("%{b:02X}") }
    }).collect()
}

/// Accept repository, tree-directory, and blob-SKILL.md URLs. #ref remains
/// supported; GitHub #L12 line anchors on file links are presentation only.
pub(crate) fn parse_github_url(url: &str) -> Result<GitSource, String> {
    let url = url.trim();
    let (url, fragment) = url.split_once('#').map_or((url, None), |(u, f)| (u, Some(f)));
    let url = url.split('?').next().unwrap_or(url).trim_end_matches('/');
    let url = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://")).unwrap_or(url);
    let path = url.strip_prefix("github.com/").ok_or("only github.com URLs are supported")?;
    let parts = path.split('/').map(decode).collect::<Result<Vec<_>, _>>()?;
    if parts.len() < 2 || !valid_segment(&parts[0]) || !valid_segment(parts[1].trim_end_matches(".git")) {
        return Err("not a valid GitHub owner/repository".into());
    }
    let mut source = GitSource {
        owner: parts[0].clone(), repo: parts[1].trim_end_matches(".git").into(),
        reference: None, path: String::new(), file: false, unresolved: None,
    };
    if parts.len() > 2 {
        if parts.len() < 4 || !matches!(parts[2].as_str(), "tree" | "blob") {
            return Err("use a repository URL, a tree directory, or a blob SKILL.md link".into());
        }
        source.file = parts[2] == "blob";
        let tail = parts[3..].to_vec();
        if !tail.iter().all(|p| safe_path(p)) { return Err("invalid GitHub ref or path".into()); }
        if source.file && (tail.len() < 2 || tail.last().map(String::as_str) != Some("SKILL.md")) {
            return Err("a skill file link must point to SKILL.md".into());
        }
        source.reference = Some(tail[0].clone());
        source.path = tail[1..].join("/");
        source.unresolved = Some(tail);
    }
    if let Some(fragment) = fragment {
        let line_anchor = source.file && fragment.starts_with('L')
            && fragment.chars().all(|c| c == 'L' || c == '-' || c.is_ascii_digit());
        if !line_anchor {
            let reference = decode(fragment)?;
            if !reference.split('/').all(valid_segment) { return Err("invalid GitHub ref".into()); }
            source.reference = Some(reference);
            source.unresolved = None;
        }
    }
    Ok(source)
}

impl GitSource {
    pub(crate) fn require_pinned(&self) -> Result<(), String> {
        if self.unresolved.is_none() && self.reference.as_deref().is_some_and(|s| s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit())) { Ok(()) }
        else { Err("review the source first and install its exact commit".into()) }
    }
    pub(crate) fn url(&self) -> String {
        let root = format!("https://github.com/{}/{}", self.owner, self.repo);
        if self.path.is_empty() { return root; }
        format!("{}/{}/{}/{}", root, if self.file { "blob" } else { "tree" },
            encode(self.reference.as_deref().unwrap_or("HEAD")),
            self.path.split('/').map(encode).collect::<Vec<_>>().join("/"))
    }
    fn directory(&self) -> &str {
        if self.file { self.path.rsplit_once('/').map_or("", |(p, _)| p) } else { &self.path }
    }
    fn package_name(&self) -> String {
        let base = format!("gh-{}-{}", normalize_id(&self.owner), normalize_id(&self.repo));
        let scope = self.directory();
        if scope.is_empty() { return base; }
        // Source identity excludes the revision: updates keep the same package.
        let hash = scope.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
        format!("{base}-{:016x}", hash)
    }
}

/// Resolve a tree/blob ref without guessing that the first path segment is
/// the branch. Installation uses the canonical preview URL with a SHA override.
pub(crate) fn fetch_source(source: &mut GitSource) -> Result<(Vec<u8>, String), String> {
    if let Some(tail) = source.unresolved.take() {
        if tail.len() > 20 { return Err("GitHub path has too many segments".into()); }
        let max_ref = if source.file { tail.len() - 1 } else { tail.len() };
        for split in (1..=max_ref).rev() {
            let reference = tail[..split].join("/");
            let endpoint = format!("https://api.github.com/repos/{}/{}/commits/{}", source.owner, source.repo, encode(&reference));
            match ureq::get(&endpoint).set("User-Agent", "fez-desktop").timeout(std::time::Duration::from_secs(30)).call() {
                Ok(response) => {
                    let value: serde_json::Value = serde_json::from_str(&response.into_string().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
                    let sha = value.get("sha").and_then(|v| v.as_str()).ok_or("GitHub response has no commit SHA")?;
                    source.reference = Some(reference);
                    source.path = tail[split..].join("/");
                    let result = fetch(&source.owner, &source.repo, Some(sha))?;
                    return Ok(result);
                }
                Err(ureq::Error::Status(404 | 422, _)) => continue,
                Err(error) => return Err(format!("couldn't resolve GitHub source: {error}")),
            }
        }
        return Err("no matching GitHub branch, tag, or commit".into());
    }
    fetch(&source.owner, &source.repo, source.reference.as_deref())
}

/// A normalized package directory is not a repository identity. Keep older
/// import names, but never let a colliding source replace an existing package.
pub(crate) fn check_replacement(pkg: &serde_json::Value, installed: Option<&serde_json::Value>) -> Result<(), String> {
    let Some(old) = installed else { return Ok(()) };
    if old.get("name") != pkg.get("name") { return Err("package directory belongs to a different package".into()); }
    if let (Some(previous), Some(next)) = (old.pointer("/fez/gitSource"), pkg.pointer("/fez/gitSource")) {
        let previous_url = previous.get("url").and_then(|v| v.as_str()).unwrap_or("").trim_end_matches('/').to_lowercase();
        let next_url = next.get("url").and_then(|v| v.as_str()).unwrap_or("").trim_end_matches('/').to_lowercase();
        if previous_url != next_url || previous.get("path").and_then(|v| v.as_str()).unwrap_or("") != next.get("path").and_then(|v| v.as_str()).unwrap_or("") {
            return Err("package directory belongs to a different GitHub source; remove that package before replacing it".into());
        }
    }
    Ok(())
}

fn normalize_id(s: &str) -> String {
    s.to_lowercase().chars().map(|c| if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' { c } else { '-' }).collect()
}

struct ArchiveFiles {
    files: BTreeMap<String, Vec<u8>>,
    links: Vec<String>,
    modes: BTreeMap<String, u32>,
}

fn archive_files(tar_bytes: &[u8]) -> Result<ArchiveFiles, String> {
    let mut archive = tar::Archive::new(tar_bytes);
    let mut files = BTreeMap::new();
    let mut links = Vec::new();
    let mut modes = BTreeMap::new();
    let mut seen = BTreeMap::new();
    let mut archive_root = None;
    for (count, entry) in archive.entries().map_err(|e| e.to_string())?.enumerate() {
        if count >= 20000 { return Err("repository archive has too many entries".into()); }
        let mut entry = entry.map_err(|e| e.to_string())?;
        let raw_path = String::from_utf8(entry.path_bytes().into_owned()).map_err(|_| "non-UTF8 archive path")?;
        let Some((root, path)) = raw_path.split_once('/') else { continue };
        if !safe_path(root) { return Err("invalid archive root".into()); }
        if archive_root.as_deref().is_some_and(|previous| previous != root) { return Err("repository archive has multiple roots".into()); }
        archive_root = Some(root.to_string());
        let kind = entry.header().entry_type();
        let path = if kind.is_dir() { path.trim_end_matches('/') } else { path };
        if path.is_empty() { continue; }
        if !safe_path(path) { return Err(format!("unsafe repository path: {path}")); }
        if seen.insert(path.to_string(), kind.is_dir()).is_some_and(|previous| previous != kind.is_dir() || !kind.is_dir()) {
            return Err(format!("duplicate or conflicting repository path: {path}"));
        }
        if kind.is_dir() { continue; }
        if !kind.is_file() {
            links.push(path.to_string());
            continue;
        }
        let mode = entry.header().mode().map_err(|e| e.to_string())?;
        modes.insert(path.to_string(), if mode & 0o111 != 0 { 0o755 } else { 0o644 });
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        if files.insert(path.to_string(), bytes).is_some() { return Err(format!("duplicate repository path: {path}")); }
    }
    for path in seen.keys() {
        for (offset, _) in path.match_indices('/') {
            if seen.get(&path[..offset]) == Some(&false) { return Err(format!("conflicting repository path: {path}")); }
        }
    }
    Ok(ArchiveFiles { files, links, modes })
}

fn under(path: &str, directory: &str) -> bool {
    directory.is_empty() || path == directory || path.strip_prefix(directory).is_some_and(|p| p.starts_with('/'))
}

fn strip_directory<'a>(path: &'a str, directory: &str) -> Option<&'a str> {
    if directory.is_empty() { Some(path) } else { path.strip_prefix(directory)?.strip_prefix('/') }
}

fn metadata(bytes: &[u8], stem: &str) -> Result<(String, String), String> {
    let raw = std::str::from_utf8(bytes).map_err(|_| "skill is not valid UTF-8")?;
    let (name, description, _, _) = crate::package_install::skill_frontmatter(raw, stem);
    if name.trim().is_empty() || description.trim().is_empty() { return Err("skill requires a name and description".into()); }
    Ok((name, description))
}

fn json_file(files: &BTreeMap<String, Vec<u8>>, path: &str) -> Option<serde_json::Value> {
    files.get(path).and_then(|bytes| serde_json::from_slice(bytes).ok())
}

fn foreign_features(files: &BTreeMap<String, Vec<u8>>) -> Vec<String> {
    let mut features = BTreeSet::new();
    for (path, label) in [(".claude-plugin/plugin.json", "Claude Code plugin integration"), (".codex-plugin/plugin.json", "Codex plugin integration")] {
        if files.contains_key(path) { features.insert(label.to_string()); }
    }
    if files.keys().any(|p| p.starts_with("hooks/")) { features.insert("Plugin lifecycle hooks".into()); }
    if files.contains_key(".mcp.json") || files.contains_key("mcp.json") { features.insert("Plugin MCP server configuration".into()); }
    if let Some(pkg) = json_file(files, "package.json") {
        if pkg.pointer("/pi/extensions").is_some() { features.insert("Pi executable extensions".into()); }
    }
    for (path, label) in [(".opencode", "OpenCode plugin integration"), ("gemini-extension.json", "Gemini plugin integration")] {
        if files.keys().any(|p| under(p, path)) { features.insert(label.into()); }
    }
    features.into_iter().collect()
}

fn append(builder: &mut tar::Builder<Vec<u8>>, path: &str, bytes: &[u8], mode: u32) -> Result<(), String> {
    if !safe_path(path) { return Err(format!("unsafe install path: {path}")); }
    let mut header = tar::Header::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mode(mode);
    header.set_cksum();
    builder.append_data(&mut header, format!("package/{path}"), bytes).map_err(|e| e.to_string())
}

fn native_package(files: &ArchiveFiles, source: &GitSource, sha: &str, mut pkg: serde_json::Value) -> Result<(InspectReport, Option<Vec<u8>>), String> {
    let name = pkg.get("name").and_then(|v| v.as_str()).ok_or("Fez package is missing its name")?.to_string();
    let segments: Vec<_> = name.strip_prefix('@').unwrap_or(&name).split('/').collect();
    let basename = segments.last().copied().unwrap_or("");
    if segments.is_empty() || segments.len() > 2 || !segments.iter().all(|p| valid_segment(p))
        || (segments.len() == 2) != name.starts_with('@')
        || !basename.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')) {
        return Err("invalid Fez package name".into());
    }
    let mut report = InspectReport { name, kind: "fez-package".into(), skills: vec![], agents: vec![], ignored: vec![], refused: vec![], unsupported: vec![], permissions: vec![], components: vec![] };
    let fez = pkg.get_mut("fez").and_then(|v| v.as_object_mut()).ok_or("fez must be an object")?;
    for key in ["integrations", "extension", "agent"] {
        if fez.contains_key(key) { report.refused.push(format!("The desktop installer does not support fez.{key}; use a package with Fez parts")); }
    }
    if let Some(perms) = fez.get("permissions") {
        report.permissions = perms.as_array().ok_or("Fez permissions must be an array")?.iter()
            .map(|v| v.as_str().map(String::from).ok_or("invalid Fez permission")).collect::<Result<_, _>>()?;
    }
    let scoped_path = |path: &str| if source.directory().is_empty() { path.to_string() } else { format!("{}/{path}", source.directory()) };
    let check_file = |value: &mut serde_json::Value, label: &str| -> Result<(), String> {
        let path = value.as_str().ok_or_else(|| format!("{label} must name a file"))?;
        let path = path.strip_prefix("./").unwrap_or(path);
        if !safe_path(path) { return Err(format!("unsafe {label} path")); }
        if !files.files.contains_key(&scoped_path(path)) { return Err(format!("Declared {label} file {path} is missing; publish a built package")); }
        *value = serde_json::json!(path);
        Ok(())
    };
    if let Some(parts) = fez.get_mut("parts") {
        for (key, value) in parts.as_object_mut().ok_or("Fez parts must be an object")? {
            match key.as_str() {
                "gui" | "headless" | "relay" | "workspace" | "miner" => {
                    if let Err(error) = check_file(value, key) { report.refused.push(error); }
                }
                "background" => {
                    if !value.is_boolean() { report.refused.push("Background component must be true or false".into()); }
                }
                "skill" => {
                    if !value.is_object() { report.refused.push("Fez MCP tool configuration must be an object".into()); }
                    if value.get("args").is_some_and(|args| !args.as_array().is_some_and(|items| items.iter().all(|arg| arg.is_string()))) {
                        report.refused.push("MCP tool arguments must be a list of strings".into());
                    }
                    if let Some(args) = value.get_mut("args").and_then(|v| v.as_array_mut()) {
                        for arg in args {
                            if arg.as_str().is_some_and(|p| p.ends_with(".js") && !p.starts_with('/')) {
                                if let Err(error) = check_file(arg, "MCP tool") { report.refused.push(error); }
                            }
                        }
                    }
                }
                _ => { report.refused.push(format!("Unsupported Fez component: {key}")); }
            }
            if key == "background" {
                if value.as_bool() == Some(true) { report.components.push("background service".into()); }
            } else { report.components.push(if key == "skill" { "MCP tool".into() } else { key.clone() }); }
        }
    }
    for key in ["skills", "personas"] {
        if let Some(config) = fez.get_mut(key) {
            let config = config.as_object_mut().ok_or_else(|| format!("Fez {key} must be an object"))?;
            let dir = config.get("dir").map(|v| v.as_str().ok_or("directory must be a string")).transpose()?.unwrap_or(key);
            let dir = dir.strip_prefix("./").unwrap_or(dir).to_string();
            if !safe_path(&dir) { return Err(format!("unsafe {key} directory")); }
            config.insert("dir".into(), serde_json::json!(dir));
            if !files.files.keys().any(|path| strip_directory(path, &scoped_path(&dir)).is_some_and(|rel|
                if key == "skills" { rel == "SKILL.md" || rel.ends_with("/SKILL.md") || (!rel.contains('/') && rel.ends_with(".md")) }
                else { rel.ends_with(".md") })) {
                report.refused.push(format!("No {key} found in declared directory {dir}"));
            }
            report.components.push(key.into());
        }
    }
    fez.insert("gitSource".into(), serde_json::json!({ "url": format!("https://github.com/{}/{}",source.owner,source.repo), "path": source.directory(), "sha": sha }));
    if let Some(bins) = pkg.get_mut("bin") {
        let bins = bins.as_object_mut().ok_or("Fez commands must be a bin name-to-file map")?;
        for (name, value) in bins.iter_mut() {
            if !valid_segment(name) { return Err("invalid command name".into()); }
            if let Err(error) = check_file(value, "command") { report.refused.push(error); }
        }
        if !bins.is_empty() { report.components.push("commands".into()); }
    }
    report.refused.extend(files.links.iter().filter(|p| under(p, source.directory())).map(|p| format!("Package contains unsupported archive link: {p}")));
    if !report.refused.is_empty() { return Ok((report, None)); }
    let mut builder = tar::Builder::new(Vec::new());
    append(&mut builder, "package.json", &serde_json::to_vec_pretty(&pkg).map_err(|e| e.to_string())?, 0o644)?;
    for (path, bytes) in &files.files {
        if let Some(rel) = strip_directory(path, source.directory()) {
            if rel != "package.json" { append(&mut builder, rel, bytes, files.modes[path])?; }
        }
    }
    let tar = builder.into_inner().map_err(|e| e.to_string())?;
    if !crate::package_install::has_installable_content(&pkg, &tar) {
        report.refused.push("Manifest declares no installable Fez components".into());
        return Ok((report, None));
    }
    Ok((report, Some(tar)))
}

/// Select exact source paths, preserving each selected skill's original
/// bytes and relative resources. Native Fez manifests take precedence at
/// package scope; an explicit SKILL.md link always means just that skill.
pub(crate) fn convert(tar_bytes: &[u8], source: &GitSource, sha: &str, selected: Option<&[String]>) -> Result<(InspectReport, Option<Vec<u8>>), String> {
    let archive = archive_files(tar_bytes)?;
    let scope = source.directory();
    let manifest_path = if scope.is_empty() { "package.json".into() } else { format!("{scope}/package.json") };
    if !source.file {
        if let Some(bytes) = archive.files.get(&manifest_path) {
            let pkg: serde_json::Value = serde_json::from_slice(bytes).map_err(|e| format!("invalid {manifest_path}: {e}"))?;
            if pkg.get("fez").is_some() {
                if selected.is_some() { return Err("a native Fez package is installed as a whole".into()); }
                return native_package(&archive, source, sha, pkg);
            }
        }
    }
    let mut report = InspectReport { name: source.package_name(), kind: "skills".into(), skills: vec![], agents: vec![], ignored: vec![], refused: vec![], unsupported: foreign_features(&archive.files), permissions: vec![], components: vec![] };
    let mut roots = vec!["skills".to_string(), ".claude/skills".into(), ".agents/skills".into()];
    for manifest in [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", "package.json"] {
        if let Some(pkg) = json_file(&archive.files, manifest) {
            let value = if manifest == "package.json" { pkg.pointer("/pi/skills") } else { pkg.get("skills") };
            let values: Vec<_> = value.map(|v| if let Some(a) = v.as_array() { a.iter().collect() } else { vec![v] }).unwrap_or_default();
            for value in values {
                if let Some(path) = value.as_str() {
                    let path = path.strip_prefix("./").unwrap_or(path).trim_end_matches('/');
                    if safe_path(path) { roots.push(path.into()); }
                }
            }
        }
    }
    let mut directories: Vec<String> = Vec::new();
    let mut ids = BTreeSet::new();
    let mut agent_ids = BTreeSet::new();
    let mut candidates: Vec<_> = archive.files.iter().collect();
    candidates.sort_by_key(|(path, _)| (path.split('/').count(), *path));
    for (path, bytes) in candidates {
        if !under(path, scope) || (source.file && path != &source.path) { continue; }
        let directory = path.strip_suffix("/SKILL.md").or_else(|| (path == "SKILL.md").then_some(""));
        if let Some(directory) = directory {
            if !scope.is_empty() || directory.is_empty() || roots.iter().any(|root| under(directory, root)) {
                if directories.iter().any(|parent| under(directory, parent)) { continue; }
                let relative = roots.iter().find_map(|root| directory.strip_prefix(&format!("{root}/")))
                    .unwrap_or_else(|| directory.rsplit('/').next().filter(|s| !s.is_empty()).unwrap_or(&source.repo));
                let id = normalize_id(relative);
                if !ids.insert(id.clone()) { return Err(format!("duplicate skill id {id}")); }
                let (_, description) = metadata(bytes, &id).map_err(|e| format!("{path}: {e}"))?;
                directories.push(directory.to_string());
                report.skills.push(PersonaFound { id, description, path: path.clone() });
            }
        } else if scope.is_empty() && path.starts_with("agents/") && path.ends_with(".md") && !path[7..].contains('/') {
            let id = normalize_id(path[7..].trim_end_matches(".md"));
            if !agent_ids.insert(id.clone()) { return Err(format!("duplicate persona id {id}")); }
            let raw = std::str::from_utf8(bytes).map_err(|_| "persona is not valid UTF-8")?;
            let (_, description, _, _) = crate::package_install::skill_frontmatter(raw, &id);
            report.agents.push(PersonaFound { id, description, path: path.clone() });
        }
    }
    if report.skills.is_empty() && report.agents.is_empty() { return Err("no SKILL.md skills or personas found at the selected source".into()); }
    let known: BTreeSet<_> = report.skills.iter().chain(&report.agents).map(|s| s.path.clone()).collect();
    let selected: BTreeSet<_> = match selected {
        None => known.clone(),
        Some(paths) => {
            if paths.is_empty() || paths.iter().any(|p| !known.contains(p)) { return Err("select at least one skill/persona from this source; unknown selection refused".into()); }
            paths.iter().cloned().collect()
        }
    };
    let mut builder = tar::Builder::new(Vec::new());
    let mut included = BTreeSet::new();
    for skill in report.skills.iter().filter(|s| selected.contains(&s.path)) {
        let directory = skill.path.rsplit_once('/').map_or("", |(p, _)| p);
        for link in archive.links.iter().filter(|p| under(p, directory)) {
            report.refused.push(format!("Skill contains unsupported archive link: {link}"));
        }
        for (path, bytes) in &archive.files {
            if let Some(rel) = strip_directory(path, directory) {
                append(&mut builder, &format!("skills/{}/{rel}", skill.id), bytes, archive.modes[path])?;
                included.insert(path.clone());
            }
        }
    }
    let mut has_personas = false;
    for agent in report.agents.iter().filter(|s| selected.contains(&s.path)) {
        let raw = std::str::from_utf8(&archive.files[&agent.path]).map_err(|_| "invalid persona UTF-8")?;
        // Foreign agent definitions are a separate explicit selection. Keep
        // the established persona import, never auto-create from a skill.
        let body = raw.strip_prefix("---\n").and_then(|v| v.split_once("\n---\n").map(|(_, b)| b)).unwrap_or(raw);
        let content = format!("---\nharness: claude-code\ndescription: {}\n---\n\n{body}", serde_json::to_string(&agent.description).map_err(|e| e.to_string())?);
        append(&mut builder, &format!("personas/{}.md", agent.id), content.as_bytes(), 0o644)?;
        included.insert(agent.path.clone());
        has_personas = true;
    }
    report.ignored = archive.files.keys().filter(|p| !included.contains(*p)).take(20).cloned().collect();
    report.permissions = if has_personas { vec!["personas".into()] } else { vec![] };
    let mut fez = serde_json::json!({ "type":"persona-pack", "permissions": report.permissions, "gitSource": {
        "url": format!("https://github.com/{}/{}", source.owner, source.repo), "path": scope, "sha": sha, "selectedPaths": selected,
    }});
    if report.skills.iter().any(|s| selected.contains(&s.path)) { fez["skills"] = serde_json::json!({"dir":"skills"}); }
    if has_personas { fez["personas"] = serde_json::json!({"dir":"personas"}); }
    let pkg = serde_json::json!({ "name": report.name, "version": format!("0.0.0-{}", &sha[..sha.len().min(7)]), "fez": fez });
    append(&mut builder, "package.json", &serde_json::to_vec_pretty(&pkg).map_err(|e| e.to_string())?, 0o644)?;
    if !report.refused.is_empty() { return Ok((report, None)); }
    Ok((report, Some(builder.into_inner().map_err(|e| e.to_string())?)))
}

pub(crate) fn fetch(owner: &str, repo: &str, want_ref: Option<&str>) -> Result<(Vec<u8>, String), String> {
    let ghref = match want_ref {
        Some(r) => r.to_string(),
        None => {
            let repo_url = format!("https://api.github.com/repos/{owner}/{repo}");
            let body = ureq::get(&repo_url)
                .set("User-Agent", "fez-desktop")
                .timeout(std::time::Duration::from_secs(30))
                .call()
                .map_err(|e| format!("couldn't reach github for {owner}/{repo}: {e}"))?
                .into_string()
                .map_err(|e| format!("bad github response: {e}"))?;
            let json: serde_json::Value =
                serde_json::from_str(&body).map_err(|e| format!("bad github json: {e}"))?;
            json.get("default_branch")
                .and_then(|v| v.as_str())
                .ok_or_else(|| format!("no default_branch for {owner}/{repo}"))?
                .to_string()
        }
    };

    let commit_url = format!("https://api.github.com/repos/{owner}/{repo}/commits/{}", encode(&ghref));
    let body = ureq::get(&commit_url)
        .set("User-Agent", "fez-desktop")
        .timeout(std::time::Duration::from_secs(30))
        .call()
        .map_err(|e| format!("couldn't resolve {owner}/{repo}#{ghref}: {e}"))?
        .into_string()
        .map_err(|e| format!("bad github response: {e}"))?;
    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("bad github json: {e}"))?;
    let sha = json
        .get("sha")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("no sha resolved for {owner}/{repo}#{ghref}"))?
        .to_string();

    if sha.len() != 40 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) { return Err("invalid GitHub commit SHA".into()); }
    if ghref.len() == 40 && ghref.bytes().all(|b| b.is_ascii_hexdigit()) && !sha.eq_ignore_ascii_case(&ghref) {
        return Err("resolved commit differs from reviewed commit".into());
    }

    // Download and unpack (gzip → tar) into a Vec we can read twice — same
    // MAX_TGZ/MAX_TAR take-and-check pattern as install_package, so a
    // hostile or broken response can't run us out of memory.
    let tarball_url = format!("https://codeload.github.com/{owner}/{repo}/tar.gz/{sha}");
    const MAX_TGZ: u64 = 30 * 1024 * 1024;
    const MAX_TAR: u64 = 120 * 1024 * 1024;
    let mut gz = Vec::new();
    std::io::Read::read_to_end(
        &mut std::io::Read::take(
            ureq::get(&tarball_url)
                .set("User-Agent", "fez-desktop")
                .timeout(std::time::Duration::from_secs(120))
                .call()
                .map_err(|e| format!("download failed: {e}"))?
                .into_reader(),
            MAX_TGZ + 1,
        ),
        &mut gz,
    )
    .map_err(|e| format!("download read failed: {e}"))?;
    if gz.len() as u64 > MAX_TGZ {
        return Err(format!("{owner}/{repo} tarball exceeds {}MB — refusing", MAX_TGZ / (1024 * 1024)));
    }
    let mut tar_bytes = Vec::new();
    std::io::Read::read_to_end(
        &mut std::io::Read::take(flate2::read::GzDecoder::new(&gz[..]), MAX_TAR + 1),
        &mut tar_bytes,
    )
    .map_err(|e| format!("gunzip failed: {e}"))?;
    if tar_bytes.len() as u64 > MAX_TAR {
        return Err(format!("{owner}/{repo} expands past {}MB — refusing", MAX_TAR / (1024 * 1024)));
    }

    Ok((tar_bytes, sha))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::package_install::{install_from_tarball, installed_skills, tar_read};
    const SHA: &str = "0123456789abcdef0123456789abcdef01234567";
    const SKILL: &[u8] = b"---\nname: 'i-have-adhd'\ndescription: >\n  Keep output actionable.\ndisable-model-invocation: true\n---\nRead references/guide.md; run scripts/check.sh when asked.\n";

    fn repo(entries: &[(&str, &[u8], u32)]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        for (path, bytes, mode) in entries { append(&mut builder, path, bytes, *mode).unwrap(); }
        builder.into_inner().unwrap()
    }
    fn source(path: &str) -> GitSource {
        parse_github_url(&format!("https://github.com/owner/repo{path}#{SHA}")).unwrap()
    }
    fn manifest(tar: &[u8]) -> serde_json::Value {
        serde_json::from_slice(&tar_read(tar, "package.json").unwrap()).unwrap()
    }

    #[test]
    fn exact_links_keep_the_skill_scope_through_commit_pinning() {
        let parsed = parse_github_url("https://github.com/ayghri/i-have-adhd/blob/main/skills/i-have-adhd/SKILL.md?plain=1#L1-L4").unwrap();
        assert_eq!(parsed.owner, "ayghri");
        assert_eq!(parsed.reference.as_deref(), Some("main"));
        assert_eq!(parsed.directory(), "skills/i-have-adhd");
        assert!(parsed.require_pinned().is_err());
        let pinned = parse_github_url(&format!("{}#{SHA}", parsed.url())).unwrap();
        pinned.require_pinned().unwrap();
        assert_eq!(pinned.path, parsed.path);
        assert_eq!(pinned.package_name(), parsed.package_name());
        assert_ne!(pinned.package_name(), source("").package_name());
    }

    #[test]
    fn slash_branch_is_encoded_as_one_ref_segment_in_reviewed_url() {
        // State after fetch_source resolves the ref/path boundary.
        let mut parsed = source("/tree/main/skills/one");
        parsed.reference = Some("release/next".into());
        let canonical = parsed.url();
        assert!(canonical.contains("/tree/release%2Fnext/skills/one"));
        let pinned = parse_github_url(&format!("{canonical}#{SHA}")).unwrap();
        assert_eq!(pinned.path, "skills/one");
        pinned.require_pinned().unwrap();
        // A SHA-looking branch is still ambiguous unless the reviewed override is explicit.
        assert!(parse_github_url(&format!("https://github.com/o/r/tree/{SHA}/skills")).unwrap().require_pinned().is_err());
    }

    #[test]
    fn rejects_invalid_sources_instead_of_widening_scope() {
        for url in ["https://evil.test/o/r", "https://github.com/o/r/issues", "https://github.com/o/r/blob/main/README.md", "https://github.com/o/r/tree/main/%2E%2E/private", "https://github.com/o/r/tree/main/a%00b", "https://github.com/o/r/tree/main/%zz"] {
            assert!(parse_github_url(url).is_err(), "{url}");
        }
        assert_eq!(parse_github_url("github.com/o/r.git/#dev").unwrap().repo, "r");
    }

    #[test]
    fn exact_skill_preserves_bytes_resources_modes_and_manual_metadata_after_install() {
        let input = repo(&[
            ("skills/adhd/SKILL.md", SKILL, 0o644),
            ("skills/adhd/references/guide.md", b"context", 0o644),
            ("skills/adhd/assets/sample.bin", &[0, 128, 255], 0o600),
            ("skills/adhd/scripts/check.sh", b"exit 88", 0o4750),
            ("skills/other/SKILL.md", SKILL, 0o644),
        ]);
        let source = source("/blob/main/skills/adhd/SKILL.md");
        let (report, converted) = convert(&input, &source, SHA, Some(&["skills/adhd/SKILL.md".into()])).unwrap();
        assert_eq!(report.skills.len(), 1);
        let converted = converted.unwrap();
        assert_eq!(tar_read(&converted, "skills/adhd/SKILL.md").unwrap(), SKILL);
        assert_eq!(tar_read(&converted, "skills/adhd/assets/sample.bin").unwrap(), [0,128,255]);
        assert!(tar_read(&converted, "skills/other/SKILL.md").is_none());
        let home = tempfile::tempdir().unwrap();
        install_from_tarball(&report.name, &converted, "0.0.0", home.path()).unwrap();
        let found = installed_skills(home.path());
        assert_eq!(found.len(), 1);
        assert!(found[0].disable_model_invocation);
        assert_eq!(found[0].description, "Keep output actionable.");
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            let script = home.path().join("packages").join(&report.name).join("skills/adhd/scripts/check.sh");
            assert_eq!(std::fs::metadata(script).unwrap().permissions().mode() & 0o7777, 0o755);
        }
    }

    #[test]
    fn foreign_plugin_imports_only_selected_skill_folders() {
        let input = repo(&[
            (".claude-plugin/plugin.json", br#"{"name":"ponytail","skills":"./skills"}"#, 0o644),
            (".codex-plugin/plugin.json", b"{}", 0o644),
            ("package.json", br#"{"pi":{"skills":["./skills"],"extensions":["./pi/index.ts"]}}"#, 0o644),
            ("hooks/hooks.json", b"{}", 0o644),
            ("pi/index.ts", b"throw Error('never execute')", 0o644),
            ("skills/one/SKILL.md", SKILL, 0o644),
            ("skills/two/SKILL.md", SKILL, 0o644),
            ("skills/one/.support/SKILL.md", SKILL, 0o644),
        ]);
        let (report, converted) = convert(&input, &source(""), SHA, Some(&["skills/one/SKILL.md".into()])).unwrap();
        assert_eq!(report.kind, "skills");
        assert_eq!(report.skills.len(), 2); // nested resource SKILL.md is not another candidate
        assert!(report.unsupported.iter().any(|s| s.contains("Pi")));
        assert!(report.unsupported.iter().any(|s| s.contains("hooks")));
        let converted = converted.unwrap();
        let pkg = manifest(&converted);
        assert!(pkg.pointer("/fez/parts").is_none());
        assert_eq!(pkg.pointer("/fez/gitSource/selectedPaths").unwrap(), &serde_json::json!(["skills/one/SKILL.md"]));
        assert!(tar_read(&converted, "pi/index.ts").is_none());
        assert!(tar_read(&converted, "skills/two/SKILL.md").is_none());
        assert_eq!(tar_read(&converted, "skills/one/.support/SKILL.md").unwrap(), SKILL);
    }

    #[test]
    fn unknown_empty_and_out_of_scope_selections_fail() {
        let input = repo(&[("skills/one/SKILL.md", SKILL, 0o644), ("skills/two/SKILL.md", SKILL, 0o644)]);
        assert!(convert(&input, &source(""), SHA, Some(&[])).is_err());
        assert!(convert(&input, &source(""), SHA, Some(&["README.md".into()])).is_err());
        assert!(convert(&input, &source("/tree/main/skills/one"), SHA, Some(&["skills/two/SKILL.md".into()])).is_err());
    }

    #[test]
    fn native_package_manifest_wins_and_preserves_parts_permissions_background_and_skills() {
        let pkg = br#"{"name":"@fezchat/sample","version":"1.2.3","fez":{"parts":{"gui":"./dist/gui.js","background":true,"skill":{"command":"node","args":["dist/mcp.js"]}},"permissions":["read:agents"],"skills":{"dir":"./skills"}}}"#;
        let input = repo(&[("package.json", pkg, 0o644), ("dist/gui.js", b"gui", 0o644), ("dist/mcp.js", b"tool", 0o644), ("skills/one/SKILL.md", SKILL, 0o644)]);
        let (report, converted) = convert(&input, &source(""), SHA, None).unwrap();
        assert_eq!(report.kind, "fez-package");
        assert_eq!(report.permissions, ["read:agents"]);
        assert!(report.components.contains(&"background service".into()));
        let converted = converted.unwrap();
        assert_eq!(manifest(&converted).pointer("/fez/parts/gui").unwrap(), "dist/gui.js");
        let home = tempfile::tempdir().unwrap();
        let outcome = install_from_tarball(&report.name, &converted, "1.2.3", home.path()).unwrap();
        assert!(outcome.wants_background);
        assert_eq!(outcome.perms, ["read:agents"]);
        assert_eq!(installed_skills(home.path()).len(), 1);
        assert!(convert(&input, &source(""), SHA, Some(&["skills/one/SKILL.md".into()])).is_err());
        // An exact file is an explicit skill-only import, even in a native package.
        assert_eq!(convert(&input, &source("/blob/main/skills/one/SKILL.md"), SHA, None).unwrap().0.kind, "skills");
    }

    #[test]
    fn native_missing_outputs_unknown_parts_and_invalid_manifests_are_refused() {
        for fez in [
            serde_json::json!({"parts":{"gui":"dist/missing.js"}}),
            serde_json::json!({"parts":{"skill":{"command":"node","args":["dist/missing.js"]}}}),
            serde_json::json!({"parts":{"surprise":"dist/x.js"}}),
            serde_json::json!({"parts":{"skill":{"command":"node","args":"dist/x.js"}}}),
            serde_json::json!({"integrations":{"pi":{"extensions":"pi"}}}),
            serde_json::json!({"parts":{"background":true}}),
        ] {
            let pkg = serde_json::to_vec(&serde_json::json!({"name":"sample","fez":fez})).unwrap();
            let (report, tar) = convert(&repo(&[("package.json", &pkg, 0o644)]), &source(""), SHA, None).unwrap();
            assert!(!report.refused.is_empty());
            assert!(tar.is_none());
        }
        for pkg in [b"{".as_slice(), br#"{"name":"sample","fez":true}"#, br#"{"name":"@@bad/sample","fez":{}}"#] {
            assert!(convert(&repo(&[("package.json", pkg, 0o644), ("skills/one/SKILL.md", SKILL, 0o644)]), &source(""), SHA, None).is_err());
        }
    }

    #[test]
    fn a_native_package_in_a_repository_subdirectory_keeps_its_scope() {
        let input = repo(&[("README.md", b"ignore", 0o644), ("packages/demo/package.json", br#"{"name":"sample","fez":{"parts":{"gui":"dist/gui.js"}}}"#, 0o644), ("packages/demo/dist/gui.js", b"gui", 0o644)]);
        let (report, tar) = convert(&input, &source("/tree/main/packages/demo"), SHA, None).unwrap();
        assert_eq!(report.kind, "fez-package");
        let tar = tar.unwrap();
        assert_eq!(tar_read(&tar, "dist/gui.js").unwrap(), b"gui");
        assert!(tar_read(&tar, "README.md").is_none());
    }

    #[test]
    fn archive_links_duplicates_and_file_ancestors_are_refused() {
        let mut builder = tar::Builder::new(Vec::new());
        append(&mut builder, "skills/one/SKILL.md", SKILL, 0o644).unwrap();
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_size(0);
        header.set_mode(0o777);
        builder.append_link(&mut header, "package/skills/one/secret", "/etc/passwd").unwrap();
        let (report, tar) = convert(&builder.into_inner().unwrap(), &source(""), SHA, None).unwrap();
        assert!(tar.is_none());
        assert!(report.refused[0].contains("link"));
        for entries in [
            vec![("skills/one/SKILL.md", SKILL, 0o644), ("skills/one/SKILL.md", SKILL, 0o644)],
            vec![("skills/one", b"file".as_slice(), 0o644), ("skills/one/SKILL.md", SKILL, 0o644)],
        ] { assert!(convert(&repo(&entries), &source(""), SHA, None).is_err()); }
    }

    #[test]
    fn duplicate_normalized_persona_ids_are_refused() {
        let input = repo(&[("agents/a_b.md", SKILL, 0o644), ("agents/a-b.md", SKILL, 0o644)]);
        assert!(convert(&input, &source(""), SHA, None).is_err());
    }

    #[test]
    fn colliding_source_names_cannot_overwrite_another_repository() {
        let input = repo(&[("skills/one/SKILL.md", SKILL, 0o644)]);
        let a = parse_github_url("https://github.com/a-b/c").unwrap();
        let b = parse_github_url("https://github.com/a/b-c").unwrap();
        assert_eq!(a.package_name(), b.package_name()); // keep legacy names; enforce identity at replacement
        let old = manifest(&convert(&input, &a, SHA, None).unwrap().1.unwrap());
        let new = manifest(&convert(&input, &b, SHA, None).unwrap().1.unwrap());
        assert!(check_replacement(&new, Some(&old)).is_err());
        check_replacement(&old, Some(&old)).unwrap();
        let mut legacy = old.clone();
        legacy["fez"]["gitSource"].as_object_mut().unwrap().remove("path");
        check_replacement(&old, Some(&legacy)).unwrap();
    }
}
