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
/// dependency — this module only ever needs two fields (`name`,
/// `description`), read by line prefix. Returns (name, description, body);
/// absent fields are "". A file with no `---\n` opener has no frontmatter at
/// all — the whole file is the body.
fn split_frontmatter(content: &str) -> (String, String, String) {
    let Some(after_open) = content.strip_prefix("---\n") else {
        return (String::new(), String::new(), content.to_string());
    };
    // The closing delimiter is a line that is exactly "---" — find it as
    // "\n---\n" (or an empty frontmatter block, where it's the very first
    // thing after the opener).
    let close = after_open.find("\n---\n").map(|i| (i, i + 5)).or_else(|| {
        after_open.starts_with("---\n").then_some((0, 4))
    });
    let Some((fm_end, body_start)) = close else {
        // No closing "---" found — treat the whole thing as body.
        return (String::new(), String::new(), content.to_string());
    };
    let frontmatter = &after_open[..fm_end];
    let body = &after_open[body_start..];
    let mut name = String::new();
    let mut description = String::new();
    for line in frontmatter.lines() {
        let trimmed = line.trim();
        if let Some(v) = trimmed.strip_prefix("name:") {
            name = unquote(v);
        } else if let Some(v) = trimmed.strip_prefix("description:") {
            description = unquote(v);
        }
    }
    (name, description, body.to_string())
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
    let hooks_hit = std::path::Path::new(path).components().any(|c| c.as_os_str() == "hooks");
    ext_hit || hooks_hit
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

        if is_refused_path(stripped) {
            refused.push(stripped.to_string());
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

    if skills.is_empty() {
        return Err(format!("no skills or personas found in {owner}/{repo}"));
    }

    let mut personas: Vec<PersonaFound> = Vec::new();
    let mut persona_files: Vec<(String, String)> = Vec::new(); // (id, generated content)
    let short_sha = &sha[..sha.len().min(7)];
    for skill in &skills {
        let (_name, description, body) = split_frontmatter(&skill.body);
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
    fn bare_skill_and_agents_layouts_are_recognized() {
        let tar = gh_tar(&[("SKILL.md", SKILL), ("agents/critic.md", "You are a critic.\n")]);
        let (report, npm) = convert(&tar, "o", "ponytail", "u", "s").unwrap();
        let ids: Vec<_> = report.personas.iter().map(|p| p.id.as_str()).collect();
        assert!(ids.contains(&"ponytail") && ids.contains(&"critic"));
        assert!(npm.is_some());
    }

    #[test]
    fn a_repo_with_nothing_recognizable_errs() {
        let tar = gh_tar(&[("README.md", "hi")]);
        assert!(convert(&tar, "o", "r", "u", "s").is_err());
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
