//! Convert a GitHub repo tarball (as fetched from the codeload tarball URL)
//! into an npm-shaped tarball the existing installer
//! (`package_install::install_from_tarball`) can consume unmodified — a
//! synthesized `package.json` declaring a `persona-pack`, plus one
//! `personas/<id>.md` per discovered skill/agent. Never installs code: any
//! `.js/.ts/.mjs/.cjs/.sh/.py/.rb/.ps1` file or `hooks/` dir anywhere in the
//! repo refuses the whole conversion — no partial installs of a repo we
//! haven't vetted.

#[derive(serde::Serialize, Clone)]
pub(crate) struct InspectReport {
    pub name: String,               // "gh-dietrichgebert-ponytail"
    pub personas: Vec<PersonaFound>, // what will install
    pub ignored: Vec<String>,       // non-md paths, listed on the card
    pub refused: Vec<String>,       // offending paths; non-empty = refused
}

#[derive(serde::Serialize, Clone)]
pub(crate) struct PersonaFound {
    pub id: String,          // persona file stem, e.g. "ponytail"
    pub description: String, // from SKILL.md frontmatter, may be ""
}

/// One discovered skill/agent file, before frontmatter is parsed out.
struct RawSkill {
    id: String,
    body: String,
}

/// `id` normalization: lowercase, chars outside `[a-z0-9-]` → `-` — matches
/// `package_install::tar_list_md`'s lowercasing, so a persona this module
/// emits round-trips through the same install path unchanged.
fn normalize_id(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' { c } else { '-' })
        .collect()
}

/// Split `---\n...\n---\n<body>` frontmatter off a skill file. No YAML
/// dependency — this module only ever needs `description`, read by line
/// prefix. Returns (description, body); an absent description is "". A file
/// with no `---\n` opener has no frontmatter at all — the whole file is the
/// body.
fn split_frontmatter(content: &str) -> (String, String) {
    let Some(after_open) = content.strip_prefix("---\n") else {
        return (String::new(), content.to_string());
    };
    // The closing delimiter is a line that is exactly "---" — find it as
    // "\n---\n" (or an empty frontmatter block, where it's the very first
    // thing after the opener).
    let close = after_open.find("\n---\n").map(|i| (i, i + 5)).or_else(|| {
        after_open.starts_with("---\n").then_some((0, 4))
    });
    let Some((fm_end, body_start)) = close else {
        // No closing "---" found — treat the whole thing as body.
        return (String::new(), content.to_string());
    };
    let frontmatter = &after_open[..fm_end];
    let body = &after_open[body_start..];
    let mut description = String::new();
    for line in frontmatter.lines() {
        let trimmed = line.trim();
        if let Some(v) = trimmed.strip_prefix("description:") {
            description = unquote(v);
        }
    }
    (description, body.to_string())
}

fn unquote(s: &str) -> String {
    let s = s.trim();
    if (s.starts_with('"') && s.ends_with('"') && s.len() >= 2)
        || (s.starts_with('\'') && s.ends_with('\'') && s.len() >= 2)
    {
        s[1..s.len() - 1].to_string()
    } else {
        s.to_string()
    }
}

const CODE_EXTENSIONS: &[&str] = &["js", "ts", "mjs", "cjs", "sh", "py", "rb", "ps1"];

fn is_refused_path(path: &str) -> bool {
    let ext_hit = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| CODE_EXTENSIONS.iter().any(|c| c.eq_ignore_ascii_case(e)));
    let hooks_hit = std::path::Path::new(path)
        .components()
        .any(|c| c.as_os_str().eq_ignore_ascii_case("hooks"));
    let mcp_hit = std::path::Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case("mcp.json") || n.eq_ignore_ascii_case(".mcp.json"));
    ext_hit || hooks_hit || mcp_hit
}

/// Scan a GitHub tarball (tar bytes, root prefix "<repo>-<ref>/") and, if
/// clean, build an npm-shaped tarball ("package/..." prefix) containing
/// personas/<id>.md files + a synthesized package.json.
/// Ok((report, Some(npm_tar))) = installable; Ok((report, None)) = refused
/// (report.refused names why); Err = malformed archive / nothing recognized.
pub(crate) fn convert(
    tar_bytes: &[u8],
    owner: &str,
    repo: &str,
    url: &str,
    sha: &str,
) -> Result<(InspectReport, Option<Vec<u8>>), String> {
    let mut archive = tar::Archive::new(tar_bytes);
    let entries = archive.entries().map_err(|e| format!("bad tarball: {e}"))?;

    let repo_id = normalize_id(repo);
    let mut skills: Vec<RawSkill> = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();
    let mut ignored: Vec<String> = Vec::new();
    let mut refused: Vec<String> = Vec::new();
    let mut ignored_overflow = 0usize;
    let mut refused_overflow = 0usize;

    for entry in entries {
        let mut entry = entry.map_err(|e| format!("bad tarball entry: {e}"))?;
        let raw_path = entry.path().map_err(|e| format!("bad tarball entry path: {e}"))?.into_owned();
        let raw_path_str = raw_path.to_string_lossy().to_string();
        // Strip the root "<repo>-<ref>/" component; entries without a "/"
        // are the root dir itself — skip.
        let Some(slash) = raw_path_str.find('/') else { continue };
        let stripped = &raw_path_str[slash + 1..];
        if stripped.is_empty() {
            continue;
        }
        // Directory entries (and anything else non-regular, e.g. symlinks)
        // carry no content of their own — every real file already gets its
        // own entry, so a bare "src/" or "hooks/" dir entry must not compete
        // for the ignored/refused lists (tar_list_md in package_install.rs
        // sidesteps this the same way, via its own filename filter).
        if !entry.header().entry_type().is_file() {
            continue;
        }

        if is_refused_path(stripped) {
            if refused.len() < 20 {
                refused.push(stripped.to_string());
            } else {
                refused_overflow += 1;
            }
            continue;
        }

        let mut matched_id: Option<String> = None;
        if let Some(name) = stripped.strip_suffix("/SKILL.md").and_then(|p| p.strip_prefix("skills/")) {
            matched_id = Some(normalize_id(name));
        } else if let Some(name) = stripped.strip_suffix("/SKILL.md").and_then(|p| p.strip_prefix(".claude/skills/")) {
            matched_id = Some(normalize_id(name));
        } else if stripped == "SKILL.md" {
            matched_id = Some(repo_id.clone());
        } else if let Some(name) = stripped.strip_prefix("agents/").and_then(|p| p.strip_suffix(".md")) {
            if !name.contains('/') {
                matched_id = Some(normalize_id(name));
            }
        }

        if let Some(id) = matched_id {
            if seen_ids.contains(&id) {
                continue; // first hit per id wins
            }
            let mut buf = String::new();
            if std::io::Read::read_to_string(&mut entry, &mut buf).is_err() {
                continue;
            }
            seen_ids.insert(id.clone());
            skills.push(RawSkill { id, body: buf });
            continue;
        }

        if ignored.len() < 20 {
            ignored.push(stripped.to_string());
        } else {
            ignored_overflow += 1;
        }
    }
    if ignored_overflow > 0 {
        ignored.push(format!("… and {ignored_overflow} more"));
    }
    if refused_overflow > 0 {
        refused.push(format!("… and {refused_overflow} more"));
    }

    if skills.is_empty() {
        return Err(format!("no skills or personas found in {owner}/{repo}"));
    }

    let mut personas: Vec<PersonaFound> = Vec::new();
    let mut persona_files: Vec<(String, String)> = Vec::new(); // (id, generated content)
    let short_sha = &sha[..sha.len().min(7)];
    for skill in &skills {
        let (description, body) = split_frontmatter(&skill.body);
        personas.push(PersonaFound { id: skill.id.clone(), description: description.clone() });
        // The generated file always carries a description — fall back to
        // "ported from <owner>/<repo>" here, but leave the report's own
        // `description` as the raw parsed value (may be "") for the card.
        let file_description =
            if description.is_empty() { format!("ported from {owner}/{repo}") } else { description };
        let content = format!(
            "---\nharness: claude-code\ndescription: {file_description}\n---\n\n> Ported from {url} ({short_sha}) by fez install-from-chat.\n> This file is yours: edit or delete it at ~/.fez/personas/{id}.md.\n> Reinstalling never overwrites your edits.\n\n{body}",
            id = skill.id,
        );
        persona_files.push((skill.id.clone(), content));
    }

    let name = format!("gh-{}-{}", normalize_id(owner), normalize_id(repo));
    let report = InspectReport { name: name.clone(), personas, ignored, refused: refused.clone() };

    if !refused.is_empty() {
        return Ok((report, None));
    }

    let pkg = serde_json::json!({
        "name": name,
        "version": format!("0.0.0-{short_sha}"),
        "fez": {
            "type": "persona-pack",
            "permissions": ["personas"],
            "personas": { "dir": "personas" },
            "gitSource": { "url": url, "sha": sha },
        },
    });
    let pkg_bytes = serde_json::to_vec_pretty(&pkg).map_err(|e| e.to_string())?;

    let mut builder = tar::Builder::new(Vec::new());
    append_tar_entry(&mut builder, "package/package.json", &pkg_bytes)?;
    for (id, content) in &persona_files {
        append_tar_entry(&mut builder, &format!("package/personas/{id}.md"), content.as_bytes())?;
    }
    let npm_tar = builder.into_inner().map_err(|e| e.to_string())?;

    Ok((report, Some(npm_tar)))
}

fn append_tar_entry(builder: &mut tar::Builder<Vec<u8>>, path: &str, data: &[u8]) -> Result<(), String> {
    let mut header = tar::Header::new_gnu();
    header.set_size(data.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    builder.append_data(&mut header, path, data).map_err(|e| e.to_string())
}

fn is_valid_gh_segment(s: &str) -> bool {
    !s.is_empty()
        && s != ".."
        && s != "."
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

/// Accepts "github.com/o/r", "https://github.com/o/r", optional "#ref".
/// Returns (owner, repo, Option<ref>). No regex crate needed — split on '#',
/// strip the scheme and "github.com/" prefixes, then split on '/'.
pub(crate) fn parse_github_url(url: &str) -> Result<(String, String, Option<String>), String> {
    let (path, want_ref) = match url.split_once('#') {
        Some((p, r)) => (p, Some(r.to_string())),
        None => (url, None),
    };
    let path = path.strip_prefix("https://").or_else(|| path.strip_prefix("http://")).unwrap_or(path);
    let path = path.strip_prefix("github.com/").ok_or_else(|| "only github.com URLs are supported".to_string())?;

    let mut parts = path.split('/');
    let owner = parts.next().unwrap_or("");
    let repo = parts.next().unwrap_or("");
    if parts.next().is_some() {
        return Err(format!("expected owner/repo, got extra path segments in {url}"));
    }
    let repo = repo.strip_suffix(".git").unwrap_or(repo);

    if !is_valid_gh_segment(owner) || !is_valid_gh_segment(repo) {
        return Err(format!("not a valid github owner/repo: {url}"));
    }
    if let Some(r) = &want_ref {
        // A ref can contain slashes (e.g. "feature/branch-name"), but every
        // component must still be a valid segment — otherwise something like
        // "../../evil" becomes a path-traversing GET when `fetch` interpolates
        // it into the GitHub commits API URL.
        if r.is_empty() || !r.split('/').all(is_valid_gh_segment) {
            return Err(format!("not a valid ref in {url}"));
        }
    }

    Ok((owner.to_string(), repo.to_string(), want_ref))
}

/// Fetch a GitHub repo's tarball pinned to a resolved commit sha, so
/// `inspect_git_package` and `install_git_package` see identical bytes.
/// Returns (tar bytes, sha). GitHub's API 403s any request without a
/// User-Agent header.
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

    let commit_url = format!("https://api.github.com/repos/{owner}/{repo}/commits/{ghref}");
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

    fn gh_tar(files: &[(&str, &str)]) -> Vec<u8> {
        let mut b = tar::Builder::new(Vec::new());
        for (path, content) in files {
            let mut h = tar::Header::new_gnu();
            h.set_size(content.len() as u64);
            h.set_mode(0o644);
            h.set_cksum();
            b.append_data(&mut h, format!("ponytail-main/{path}"), content.as_bytes()).unwrap();
        }
        b.into_inner().unwrap()
    }

    const SKILL: &str = "---\nname: ponytail\ndescription: lazy senior dev\n---\n\nBe lazy.\n";

    #[test]
    fn a_clean_plugin_converts_to_a_persona_pack() {
        let tar = gh_tar(&[
            ("skills/ponytail/SKILL.md", SKILL),
            ("skills/review/SKILL.md", "No frontmatter body.\n"),
            ("README.md", "readme"),
            ("LICENSE", "mit"),
        ]);
        let (report, npm) = convert(&tar, "DietrichGebert", "ponytail", "https://github.com/DietrichGebert/ponytail", "abcdef1234567890").unwrap();
        assert!(report.refused.is_empty());
        assert_eq!(report.name, "gh-dietrichgebert-ponytail");
        let ids: Vec<_> = report.personas.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, vec!["ponytail", "review"]);
        assert_eq!(report.personas[0].description, "lazy senior dev");
        let npm = npm.expect("clean repo must produce a tarball");
        let pkg = crate::package_install::tar_read(&npm, "package.json").unwrap();
        let pkg: serde_json::Value = serde_json::from_slice(&pkg).unwrap();
        assert_eq!(pkg.pointer("/fez/type").unwrap(), "persona-pack");
        assert_eq!(pkg.pointer("/fez/gitSource/sha").unwrap(), "abcdef1234567890");
        let persona = String::from_utf8(crate::package_install::tar_read(&npm, "personas/ponytail.md").unwrap()).unwrap();
        assert!(persona.starts_with("---\nharness: claude-code\n"));
        assert!(persona.contains("Ported from https://github.com/DietrichGebert/ponytail (abcdef1)"));
        assert!(persona.contains("Be lazy."));
        assert!(!persona.contains("name: ponytail"), "skill frontmatter must not leak into the body");
    }

    #[test]
    fn any_code_file_refuses_the_whole_repo() {
        let tar = gh_tar(&[
            ("skills/ponytail/SKILL.md", SKILL),
            ("hooks/evil.js", "x"),
            ("scripts/setup.sh", "x"),
        ]);
        let (report, npm) = convert(&tar, "a", "b", "u", "s").unwrap();
        assert!(npm.is_none());
        assert_eq!(report.refused.len(), 2);
        assert!(report.refused.iter().any(|p| p.contains("evil.js")));
    }

    #[test]
    fn mcp_json_anywhere_refuses() {
        let tar = gh_tar(&[
            ("skills/ponytail/SKILL.md", SKILL),
            ("mcp.json", "{}"),
            ("nested/.mcp.json", "{}"),
        ]);
        let (report, npm) = convert(&tar, "a", "b", "u", "s").unwrap();
        assert!(npm.is_none());
        assert_eq!(report.refused.len(), 2);
    }

    #[test]
    fn bare_skill_and_agents_layouts_are_recognized() {
        let tar = gh_tar(&[("SKILL.md", SKILL), ("agents/critic.md", "You are a critic.\n")]);
        let (report, npm) = convert(&tar, "o", "ponytail", "u", "s").unwrap();
        let ids: Vec<_> = report.personas.iter().map(|p| p.id.as_str()).collect();
        assert!(ids.contains(&"ponytail") && ids.contains(&"critic"));
        assert!(npm.is_some());
    }

    #[test]
    fn directory_entries_are_neither_ignored_nor_refused() {
        let mut b = tar::Builder::new(Vec::new());
        let mut h = tar::Header::new_gnu();
        h.set_size(SKILL.len() as u64);
        h.set_mode(0o644);
        h.set_cksum();
        b.append_data(&mut h, "ponytail-main/skills/ponytail/SKILL.md", SKILL.as_bytes()).unwrap();
        let mut dir_h = tar::Header::new_gnu();
        dir_h.set_entry_type(tar::EntryType::Directory);
        dir_h.set_size(0);
        dir_h.set_mode(0o755);
        dir_h.set_cksum();
        b.append_data(&mut dir_h, "ponytail-main/src/", &[][..]).unwrap();
        let tar = b.into_inner().unwrap();

        let (report, npm) = convert(&tar, "o", "ponytail", "u", "s").unwrap();
        assert!(npm.is_some());
        assert!(report.refused.iter().all(|p| !p.contains("src")), "a bare dir entry must not land in refused: {:?}", report.refused);
        assert!(report.ignored.iter().all(|p| !p.contains("src")), "a bare dir entry must not land in ignored: {:?}", report.ignored);
    }

    #[test]
    fn a_repo_with_nothing_recognizable_errs() {
        let tar = gh_tar(&[("README.md", "hi")]);
        assert!(convert(&tar, "o", "r", "u", "s").is_err());
    }

    #[test]
    fn github_urls_parse_and_bad_ones_refuse() {
        assert_eq!(parse_github_url("https://github.com/A-b/c.d#v1").unwrap(),
            ("A-b".into(), "c.d".into(), Some("v1".into())));
        assert_eq!(parse_github_url("github.com/o/r.git").unwrap(), ("o".into(), "r".into(), None));
        for bad in ["gitlab.com/o/r", "github.com/o", "github.com/o/r/extra", "github.com/../r", ""] {
            assert!(parse_github_url(bad).is_err(), "{bad} should refuse");
        }
    }

    #[test]
    fn ref_charset_is_validated_per_path_segment() {
        // A ref that path-traverses via "../.." must not reach `fetch`'s
        // commits API interpolation.
        assert!(parse_github_url("github.com/o/r#../../evil").is_err());
        // A ref with a slash (branch names commonly have one) still parses —
        // each component just has to be a valid segment on its own.
        assert_eq!(
            parse_github_url("github.com/o/r#feature/branch-name").unwrap(),
            ("o".into(), "r".into(), Some("feature/branch-name".into()))
        );
        // A 40-hex sha is a single valid segment.
        let sha = "a".repeat(40);
        assert_eq!(
            parse_github_url(&format!("github.com/o/r#{sha}")).unwrap(),
            ("o".into(), "r".into(), Some(sha))
        );
    }

    #[test]
    fn converted_pack_installs_through_the_real_installer() {
        let tar = gh_tar(&[("skills/ponytail/SKILL.md", SKILL)]);
        let (_, npm) = convert(&tar, "o", "ponytail", "u", "abcdef1234").unwrap();
        let home = tempfile::tempdir().unwrap();
        let outcome = crate::package_install::install_from_tarball("gh-o-ponytail", &npm.unwrap(), "0.0.0-abcdef1", home.path()).unwrap();
        assert!(outcome.installed.iter().any(|l| l.contains("persona @ponytail")));
        assert!(home.path().join("personas/ponytail.md").exists());
    }
}
