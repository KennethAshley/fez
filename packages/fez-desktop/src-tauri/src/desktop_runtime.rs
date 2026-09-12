//! The desktop owns local processes; protocol and scheduled work remain TypeScript.
use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

static OWNER_LOCK: Mutex<Option<File>> = Mutex::new(None);
static GROUPS: Mutex<Option<HashSet<u32>>> = Mutex::new(None);
static WORKER: Mutex<Option<Worker>> = Mutex::new(None);
static RESTORED: AtomicBool = AtomicBool::new(false);
static STOPPING: AtomicBool = AtomicBool::new(false);
static SHUTDOWN_DONE: AtomicBool = AtomicBool::new(false);
static QUIT_APPROVED: AtomicBool = AtomicBool::new(false);
const LABEL: &str = "com.fez.sentinel";

pub(crate) fn check_running() -> Result<(), String> {
    if STOPPING.load(Ordering::SeqCst) { Err("Fez is quitting; local work has stopped".into()) } else { Ok(()) }
}

fn executable_path(pid: u32) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        let len = unsafe { libc::proc_pidpath(pid as i32, buf.as_mut_ptr().cast(), buf.len() as u32) };
        if len > 0 {
            let raw = String::from_utf8_lossy(&buf[..len as usize]);
            return Some(PathBuf::from(raw.trim_end_matches('\0')));
        }
    }
    #[cfg(target_os = "linux")]
    { return std::fs::read_link(format!("/proc/{pid}/exe")).ok(); }
    #[allow(unreachable_code)]
    None
}

pub(crate) fn process_start(pid: u32) -> Option<String> {
    #[cfg(target_os = "macos")]
    unsafe {
        let mut info: libc::proc_bsdinfo = std::mem::zeroed();
        let size = std::mem::size_of::<libc::proc_bsdinfo>();
        if libc::proc_pidinfo(pid as i32, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size as i32) == size as i32 {
            return (info.pbi_status != libc::SZOMB).then(|| format!("{}:{}", info.pbi_start_tvsec, info.pbi_start_tvusec));
        }
    }
    #[cfg(target_os = "linux")]
    {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let fields = stat.rsplit_once(')')?.1;
        if fields.split_whitespace().next() == Some("Z") { return None; }
        let ticks = fields.split_whitespace().nth(19)?;
        let boot = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
        return Some(format!("{}:{ticks}", boot.trim()));
    }
    #[allow(unreachable_code)]
    None
}

/// Read only for verification, never log or persist another process's environment.
pub(crate) fn legacy_persona_matches(pid: u32, persona: &str) -> bool {
    let expected = format!("FEZ_AGENT_PERSONA={persona}");
    #[cfg(target_os = "macos")]
    unsafe {
        let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as i32];
        let mut limit_mib = [libc::CTL_KERN, libc::KERN_ARGMAX];
        let mut limit: libc::c_int = 0;
        let mut limit_size = std::mem::size_of_val(&limit);
        if libc::sysctl(limit_mib.as_mut_ptr(), 2, (&mut limit as *mut libc::c_int).cast(), &mut limit_size, std::ptr::null_mut(), 0) != 0 || limit <= 0 { return false; }
        let mut bytes = vec![0u8; limit as usize];
        let mut size = bytes.len();
        if libc::sysctl(mib.as_mut_ptr(), 3, bytes.as_mut_ptr().cast(), &mut size, std::ptr::null_mut(), 0) != 0 || size < 4 {
            return false;
        }
        bytes.truncate(size);
        let argc = i32::from_ne_bytes(bytes[..4].try_into().unwrap());
        if argc < 0 || argc as usize > size { return false; }
        let mut pos = 4;
        while pos < size && bytes[pos] != 0 { pos += 1; } // executable path
        while pos < size && bytes[pos] == 0 { pos += 1; } // alignment padding
        for _ in 0..argc {
            while pos < size && bytes[pos] != 0 { pos += 1; }
            pos = pos.saturating_add(1);
        }
        return bytes.get(pos..).is_some_and(|env| env.split(|b| *b == 0).any(|entry| entry == expected.as_bytes()));
    }
    #[cfg(target_os = "linux")]
    { return std::fs::read(format!("/proc/{pid}/environ")).ok().is_some_and(|env| env.split(|b| *b == 0).any(|entry| entry == expected.as_bytes())); }
    #[allow(unreachable_code)]
    false
}

pub(crate) fn row_alive(row: &crate::SpawnedAgent) -> bool {
    if !crate::pid_runs_bin(row.pid, &row.bin) { return false; }
    match &row.process_start {
        Some(start) => process_start(row.pid).as_ref() == Some(start),
        None if row.bin == "fez-agent" => legacy_persona_matches(row.pid, &row.persona),
        // Earlier extension rows recorded wall-clock spawn seconds. Only an exact
        // kernel-start second match can upgrade that less precise receipt.
        #[cfg(target_os = "macos")]
        None => row.spawned_at.is_some_and(|recorded| process_start(row.pid)
            .and_then(|start| start.split(':').next()?.parse::<u64>().ok()) == Some(recorded)),
        #[cfg(not(target_os = "macos"))]
        None => false,
    }
}

pub(crate) fn unresolved_legacy_extension(row: &crate::SpawnedAgent) -> bool {
    row.bin != "fez-agent" && row.process_start.is_none() && crate::pid_runs_bin(row.pid, &row.bin) && !row_alive(row)
}
pub(crate) fn reject_unresolved_legacy(rows: &[crate::SpawnedAgent]) -> Result<(), String> {
    if let Some(row) = rows.iter().find(|r| unresolved_legacy_extension(r)) {
        return Err(format!("{} ({}) is still running with an old, unverified process receipt. Stop that old process manually before starting or quitting desktop local work; its saved record was preserved.", row.persona, row.bin));
    }
    Ok(())
}
fn upgrade_legacy_receipts() -> Result<(), String> {
    let mut rows = crate::load_agents_registry();
    reject_unresolved_legacy(&rows)?;
    let mut changed = false;
    for row in &mut rows {
        if row.process_start.is_none() && row_alive(row) {
            row.process_start = process_start(row.pid);
            changed = true;
        }
    }
    if changed { crate::save_agents_registry(&rows)?; }
    Ok(())
}

/// Kernel executable identity where available; interpreter scripts require the exact script argument.
pub(crate) fn pid_runs_path(pid: u32, path: &Path) -> bool {
    if !crate::raw_pid_alive(pid) || process_start(pid).is_none() { return false; }
    let expected = path.canonicalize().unwrap_or_else(|_| path.to_owned());
    if executable_path(pid).is_some_and(|actual| actual.canonicalize().unwrap_or(actual) == expected) { return true; }
    let Ok(out) = Command::new("/bin/ps").args(["-p", &pid.to_string(), "-o", "command="]).output() else { return false; };
    let command = String::from_utf8_lossy(&out.stdout);
    let mut words = command.split_whitespace();
    let Some(program) = words.next() else { return false; };
    let interpreter = Path::new(program).file_name().and_then(|s| s.to_str());
    matches!(interpreter, Some("node" | "bun")) && words.next().is_some_and(|script|
        Path::new(script).canonicalize().unwrap_or_else(|_| PathBuf::from(script)) == expected)
}

/// Legacy bodies share a shell/service group. Snapshot their descendants and verify
/// executable identities before individual signals; never kill the inherited group.
fn legacy_descendants(pid: u32) -> Result<Vec<(u32, PathBuf, String)>, String> {
    let out = Command::new("/bin/ps").args(["-axo", "pid=,ppid="]).output()
        .map_err(|e| format!("Inspect legacy agent descendants: {e}"))?;
    if !out.status.success() { return Err("Could not inspect legacy agent descendants; no process was signalled".into()); }
    let raw = String::from_utf8_lossy(&out.stdout);
    let edges: Vec<(u32, u32)> = raw.lines().filter_map(|line| {
        let mut words = line.split_whitespace();
        Some((words.next()?.parse().ok()?, words.next()?.parse().ok()?))
    }).collect();
    let mut descendants = HashSet::from([pid]);
    loop {
        let before = descendants.len();
        for (child, parent) in &edges { if descendants.contains(parent) { descendants.insert(*child); } }
        if descendants.len() == before { break; }
    }
    descendants.remove(&pid);
    Ok(descendants.into_iter().filter_map(|pid| Some((pid, executable_path(pid)?, process_start(pid)?))).collect())
}
fn signal_descendants(descendants: &[(u32, PathBuf, String)], sig: i32) {
    for (pid, path, started) in descendants {
        if process_start(*pid).as_ref() == Some(started) && pid_runs_path(*pid, path) { signal(*pid, false, sig); }
    }
}

fn write_receipt(home: &Path) -> Result<(), String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let receipt = serde_json::json!({ "pid": std::process::id(), "executable": executable });
    std::fs::write(home.join("desktop-runtime.json"), serde_json::to_vec(&receipt).unwrap())
        .map_err(|e| format!("record desktop ownership: {e}"))
}

pub(crate) fn claim() -> Result<(), String> {
    let home = crate::fez_home()?;
    std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    let file = OpenOptions::new().create(true).truncate(false).write(true)
        .open(home.join("desktop-runtime.lock")).map_err(|e| e.to_string())?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err("Fez is already running. Open the existing app from its tray icon.".into());
    }
    if let Ok(raw) = std::fs::read(home.join("desktop-runtime.json")) {
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&raw) {
            if let (Some(pid), Some(path)) = (v["pid"].as_u64().and_then(|p| u32::try_from(p).ok()), v["executable"].as_str()) {
                if pid != std::process::id() && pid_runs_path(pid, Path::new(path)) {
                    return Err("Another Fez desktop owns local work. Quit that app before opening this one.".into());
                }
            }
        }
    }
    write_receipt(&home)?;
    *OWNER_LOCK.lock().unwrap_or_else(|p| p.into_inner()) = Some(file);
    Ok(())
}

pub(crate) fn track_group(pid: u32) {
    GROUPS.lock().unwrap_or_else(|p| p.into_inner()).get_or_insert_with(Default::default).insert(pid);
}
fn signal(pid: u32, group: bool, signal: i32) -> bool {
    pid > 1 && unsafe { libc::kill(if group { -(pid as i32) } else { pid as i32 }, signal) == 0 }
}
fn group_alive(pid: u32) -> bool { signal(pid, true, 0) }
fn owned_group(pid: u32) -> bool {
    GROUPS.lock().unwrap_or_else(|p| p.into_inner()).as_ref().is_some_and(|groups| groups.contains(&pid))
}
pub(crate) fn forget_group(pid: u32) {
    if let Some(groups) = GROUPS.lock().unwrap_or_else(|p| p.into_inner()).as_mut() { groups.remove(&pid); }
}
fn expected_stop(pid: u32) {
    crate::EXPECTED_STOPS.lock().unwrap_or_else(|p| p.into_inner())
        .get_or_insert_with(Default::default).insert(pid);
}

pub(crate) fn stop_process(row: &crate::SpawnedAgent) -> Result<bool, String> {
    if !row_alive(row) { return Ok(false); }
    let (pid, bin) = (row.pid, row.bin.as_str());
    let group = owned_group(pid);
    let descendants = if group { vec![] } else { legacy_descendants(pid)? };
    expected_stop(pid);
    signal_descendants(&descendants, libc::SIGTERM);
    if !signal(pid, group, libc::SIGTERM) && crate::raw_pid_alive(pid) {
        return Err(format!("Could not stop {bin} (pid {pid}); it is still running"));
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline && if group { group_alive(pid) } else { row_alive(row) } {
        std::thread::sleep(Duration::from_millis(25));
    }
    // Old receipts authorize individual signals only, rechecked before escalation.
    if group { signal(pid, true, libc::SIGKILL); } else if row_alive(row) { signal(pid, false, libc::SIGKILL); }
    signal_descendants(&descendants, libc::SIGKILL);
    forget_group(pid);
    Ok(true)
}

/// A failed leader must not leave its harness descendants behind.
pub(crate) fn finish_group(pid: u32) {
    if owned_group(pid) {
        signal(pid, true, libc::SIGTERM);
        signal(pid, true, libc::SIGKILL);
        forget_group(pid);
    }
}

struct Worker {
    child: Child,
    control: Option<ChildStdin>,
    lines: mpsc::Receiver<String>,
    fingerprint: String,
}
impl Worker {
    fn prepare(home: &Path, owner: &str, relays: &str, extensions: Option<&[String]>, fingerprint: String) -> Result<Self, String> {
        std::fs::create_dir_all(home.join("logs")).map_err(|e| e.to_string())?;
        let log = OpenOptions::new().create(true).append(true).open(home.join("logs/desktop-background.log"))
            .map_err(|e| e.to_string())?;
        let mut command = Command::new(home.join("bin/fez-background"));
        command.env("PATH", crate::subprocess_path_env())
            .env("FEZ_DESKTOP_PARENT_PID", std::process::id().to_string())
            .env("FEZ_DESKTOP_OWNER", owner).env("FEZ_RELAY", relays)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(log).process_group(0);
        if let Some(names) = extensions { command.env("FEZ_BACKGROUND_EXTENSIONS", names.join(",")); }
        else { command.env_remove("FEZ_BACKGROUND_EXTENSIONS"); }
        let mut child = command.spawn().map_err(|e| format!("Start bundled background runtime: {e}. Relaunch Fez after the bundled runtime finishes installing."))?;
        track_group(child.id());
        let stdout = child.stdout.take().unwrap();
        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(line).is_err() { break; }
            }
        });
        let control = child.stdin.take();
        let mut worker = Self { child, control, lines, fingerprint };
        if let Err(e) = worker.await_line("FEZ_BACKGROUND_READY", Duration::from_secs(40)) {
            worker.stop();
            return Err(e);
        }
        Ok(worker)
    }
    fn await_line(&mut self, wanted: &str, timeout: Duration) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
            check_running()?;
            match self.lines.recv_timeout(remaining.min(Duration::from_millis(100))) {
                Ok(line) if line == wanted => return Ok(()),
                Ok(_) | Err(mpsc::RecvTimeoutError::Timeout) => {},
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            if crate::bounded_command::has_exited(self.child.id())? { break; }
        }
        Err(format!("Background integrations did not report {wanted}. Check ~/.fez/logs/desktop-background.log; local startup is paused."))
    }
    fn activate(&mut self) -> Result<(), String> {
        self.control.as_mut().ok_or("Background control pipe closed")?.write_all(b"start\n")
            .map_err(|e| format!("Activate background integrations: {e}"))?;
        self.await_line("FEZ_BACKGROUND_STARTED", Duration::from_secs(10))
    }
    fn alive(&mut self) -> bool { matches!(crate::bounded_command::has_exited(self.child.id()), Ok(false)) }
    fn stop(&mut self) {
        self.control.take();
        let pid = self.child.id();
        signal(pid, true, libc::SIGTERM);
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if crate::bounded_command::has_exited(pid).unwrap_or(true) { break; }
            std::thread::sleep(Duration::from_millis(25));
        }
        signal(pid, true, libc::SIGKILL);
        let _ = self.child.wait();
        forget_group(pid);
    }
}

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct BackgroundSelection { extensions: Option<Vec<String>> }

/// Only the exact service generated by `fez sentinel-install` is eligible.
fn sentinel_arguments(value: &serde_json::Value) -> Result<Option<Vec<String>>, String> {
    if value["Label"].as_str() != Some(LABEL) { return Err("Legacy sentinel plist has an unexpected Label; stop it manually before using desktop integrations".into()); }
    let args = value["ProgramArguments"].as_array().ok_or("Legacy sentinel plist has no ProgramArguments")?
        .iter().map(|s| s.as_str().ok_or("Legacy sentinel arguments must be strings")).collect::<Result<Vec<_>, _>>()?;
    if value["Program"].as_str().is_some_and(|program| args.first().copied() != Some(program)) {
        return Err("Legacy sentinel Program differs from its arguments; stop it manually before migrating".into());
    }
    let file = |s: &str| Path::new(s).file_name().and_then(|s| s.to_str()).unwrap_or("").to_owned();
    let offset = match args.as_slice() {
        [program, ..] if file(program) == "fez-sentinel" => 1,
        [program, "sentinel", ..] if file(program) == "fez" => 2,
        [runtime, cli, "sentinel", ..] if matches!(file(runtime).as_str(), "node" | "bun") && file(cli) == "cli.js" => 3,
        _ => return Err("Unrecognized sentinel ProgramArguments; stop that service manually before using desktop integrations".into()),
    };
    let mut extensions = None;
    let mut i = offset;
    while i < args.len() {
        match args.get(i..i + 2) {
            Some(["--extensions", names]) if extensions.is_none() => {
                let names: Vec<String> = names.split(',').map(str::to_owned).collect();
                if names.iter().any(|s| s.is_empty() || !s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')) {
                    return Err("Legacy sentinel extension restriction is invalid".into());
                }
                extensions = Some(names);
            },
            Some(["--relay" | "-r", _]) => {},
            _ => return Err("Unrecognized legacy sentinel options; stop it manually before using desktop integrations".into()),
        }
        i += 2;
    }
    Ok(extensions)
}

fn check_legacy_relay(value: &serde_json::Value, relays: &str) -> Result<(), String> {
    let args = value["ProgramArguments"].as_array().cloned().unwrap_or_default();
    let pin = args.windows(2).filter(|a| matches!(a[0].as_str(), Some("--relay" | "-r")))
        .last().and_then(|a| a[1].as_str()).or_else(|| value["EnvironmentVariables"]["FEZ_RELAY"].as_str());
    let normalize = |s: &str| s.split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned).collect::<Vec<_>>();
    if pin.is_some_and(|pin| normalize(pin) != normalize(relays)) {
        return Err("The legacy sentinel is pinned to another relay. Align its relay with the desktop workspace or stop it manually before migrating; no service was changed.".into());
    }
    Ok(())
}

struct Migration {
    plist: PathBuf,
    backup: PathBuf,
    selection: BackgroundSelection,
    loaded: bool,
    stopped: bool,
}
fn launchctl(args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("/bin/launchctl").args(args).output().map_err(|e| format!("launchctl: {e}"))
}
fn domain() -> String { format!("gui/{}", unsafe { libc::getuid() }) }

impl Migration {
    fn inspect(home: &Path, relays: &str) -> Result<Option<Self>, String> {
        let plist = home.parent().ok_or("Missing home directory")?.join("Library/LaunchAgents/com.fez.sentinel.plist");
        let active = crate::pid_alive(&home.join("sentinel.pid"));
        #[cfg(not(target_os = "macos"))]
        {
            if active.is_some() { return Err("A headless sentinel is running. Stop it before starting desktop integrations.".into()); }
            return Ok(None);
        }
        #[cfg(target_os = "macos")]
        {
            let service = launchctl(&["print", &format!("{}/{LABEL}", domain())])?;
            let loaded = service.status.success();
            if !plist.exists() {
                if active.is_some() || loaded { return Err("A headless sentinel is running outside the recognized launchd install. Stop it before starting desktop integrations.".into()); }
                return Ok(None);
            }
            let out = Command::new("/usr/bin/plutil").args(["-convert", "json", "-o", "-"]).arg(&plist).output().map_err(|e| e.to_string())?;
            if !out.status.success() { return Err("Could not inspect legacy sentinel plist; no service was changed".into()); }
            let value = serde_json::from_slice(&out.stdout).map_err(|e| format!("Legacy sentinel plist: {e}"))?;
            let selection = BackgroundSelection { extensions: sentinel_arguments(&value)? };
            check_legacy_relay(&value, relays)?;
            if loaded {
                let text = String::from_utf8_lossy(&service.stdout);
                let arguments: Vec<_> = text.lines().skip_while(|line| line.trim() != "arguments = {")
                    .skip(1).take_while(|line| line.trim() != "}").map(str::trim).collect();
                let expected: Vec<_> = value["ProgramArguments"].as_array().unwrap().iter().filter_map(|v| v.as_str()).collect();
                if arguments != expected { return Err("The loaded sentinel differs from its plist. Stop it manually before migrating; no service was changed.".into()); }
            }
            if let Some(pid) = active {
                let service_text = String::from_utf8_lossy(&service.stdout);
                let service_pid = service_text.lines().find_map(|line| line.trim().strip_prefix("pid = ").and_then(|p| p.parse::<u32>().ok()));
                if !loaded || service_pid != Some(pid) {
                    return Err("A foreground or unrecognized sentinel is running. Stop it before starting desktop integrations; no process was signalled.".into());
                }
            }
            let backup = home.join("desktop-sentinel.plist");
            if backup.exists() && std::fs::read(&backup).ok() != std::fs::read(&plist).ok() {
                return Err("A different sentinel migration backup already exists at ~/.fez/desktop-sentinel.plist. Resolve that backup before migrating again.".into());
            }
            Ok(Some(Self { plist, backup, selection, loaded, stopped: false }))
        }
    }
    fn stop(&mut self) -> Result<(), String> {
        std::fs::copy(&self.plist, &self.backup).map_err(|e| format!("Back up sentinel before migration: {e}"))?;
        if self.loaded {
            let out = launchctl(&["bootout", &domain(), self.plist.to_str().ok_or("Invalid plist path")?])?;
            if !out.status.success() { return Err("Could not stop recognized launchd sentinel; its configuration and backup were preserved".into()); }
            self.stopped = true;
        }
        Ok(())
    }
    fn commit(&self, home: &Path) -> Result<(), String> {
        std::fs::write(home.join("desktop-background.json"), serde_json::to_vec_pretty(&self.selection).unwrap())
            .map_err(|e| format!("Preserve sentinel extension selection: {e}"))?;
        std::fs::remove_file(&self.plist).map_err(|e| format!("Disable sentinel login startup: {e}"))
    }
    fn rollback(&mut self, home: &Path) -> Result<(), String> {
        self.rollback_with(home, |args| launchctl(args).map(|out| out.status.success()))
    }
    fn rollback_with(&mut self, home: &Path, bootstrap: impl FnOnce(&[&str]) -> Result<bool, String>) -> Result<(), String> {
        if !self.stopped { return Ok(()); }
        // A restored headless runtime must be allowed to reclaim background ownership.
        let _ = std::fs::remove_file(home.join("desktop-runtime.json"));
        std::fs::copy(&self.backup, &self.plist).map_err(|e| e.to_string())?;
        let success = bootstrap(&["bootstrap", &domain(), self.plist.to_str().ok_or("Invalid plist path")?])?;
        if !success { return Err("Legacy sentinel rollback failed; restore it from ~/.fez/desktop-sentinel.plist with launchctl bootstrap".into()); }
        self.stopped = false;
        Ok(())
    }
}

#[derive(serde::Serialize)]
pub(crate) struct RuntimeStatus { background: bool, restored: usize }

#[tauri::command]
pub(crate) async fn start_desktop_runtime(owner: String, relays: String) -> Result<RuntimeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || start(owner, relays)).await.map_err(|e| e.to_string())?
}

pub(crate) fn start(owner: String, relays: String) -> Result<RuntimeStatus, String> {
    let _guard = crate::AGENTS_REGISTRY_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    check_running()?;
    if owner.len() != 64 || !owner.chars().all(|c| c.is_ascii_hexdigit()) { return Err("Desktop runtime needs the local owner's public key".into()); }
    let home = crate::fez_home()?;
    upgrade_legacy_receipts()?;
    let mut current = WORKER.lock().unwrap_or_else(|p| p.into_inner());
    let settings = crate::settings_value();
    let effective_relays = settings["relays"].as_array().map(|values| values.iter().filter_map(|v| v.as_str()).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(","))
        .filter(|s| !s.is_empty()).unwrap_or_else(|| settings["relay"].as_str().filter(|s| !s.is_empty()).unwrap_or("wss://relay.fez.chat").to_owned());
    let mut migration = Migration::inspect(&home, &effective_relays)?;
    let selection = if let Some(migration) = &migration { BackgroundSelection { extensions: migration.selection.extensions.clone() } }
        else {
            match std::fs::read(home.join("desktop-background.json")) {
                Ok(raw) => serde_json::from_slice::<BackgroundSelection>(&raw).map_err(|e| format!("Read preserved background selection: {e}"))?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => BackgroundSelection::default(),
                Err(e) => return Err(format!("Read preserved background selection: {e}")),
            }
        };
    let enabled = selection.extensions.clone().unwrap_or_else(|| settings["backgroundExtensions"].as_array()
        .map(|names| names.iter().filter_map(|n| n.as_str().map(str::to_owned)).collect()).unwrap_or_default());
    let files: Vec<_> = enabled.iter().flat_map(|name| [home.join("extensions").join(format!("{name}.js")), home.join("extensions").join(format!("{name}.mjs")), home.join("extensions").join(format!("{name}.ts")), home.join("packages").join(name).join("package.json")])
        .chain([home.join("bin/.pi-agent-version"), home.join("bin/fez-background")])
        .map(|path| { let meta = std::fs::metadata(&path).ok();
            (path, meta.as_ref().map(|m| m.len()), meta.and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos().to_string()))
        }).collect();
    let fingerprint = serde_json::json!({
        "owner": owner, "relays": effective_relays,
        "backgroundExtensions": settings["backgroundExtensions"],
        "extensionPermissions": settings["extensionPermissions"],
        "selection": selection, "files": files,
    }).to_string();
    let reuse = migration.is_none() && current.as_mut().is_some_and(|w| w.fingerprint == fingerprint && w.alive());
    if !reuse {
        write_receipt(&home)?;
        let mut worker = match Worker::prepare(&home, &owner, &effective_relays, selection.extensions.as_deref(), fingerprint) {
            Ok(worker) => worker,
            Err(error) => {
                if migration.is_some() && current.is_none() { let _ = std::fs::remove_file(home.join("desktop-runtime.json")); }
                return Err(error);
            }
        };
        // Readiness proves key/relay/grants work before touching the old service.
        let handoff = (|| {
            if let Some(migration) = migration.as_mut() { migration.stop()?; }
            if let Some(mut old) = current.take() { old.stop(); }
            worker.activate()?;
            if let Some(migration) = &migration { migration.commit(&home)?; }
            Ok::<(), String>(())
        })();
        if let Err(error) = handoff {
            worker.stop();
            if let Some(migration) = migration.as_mut() {
                migration.rollback(&home).map_err(|rollback| format!("{error}; {rollback}"))?;
            }
            return Err(error);
        }
        *current = Some(worker);
    }
    let restored = if RESTORED.load(Ordering::SeqCst) { 0 } else {
        let restored = restore_agents(&home, &owner, if relays.is_empty() { &effective_relays } else { &relays })?;
        RESTORED.store(true, Ordering::SeqCst);
        restored
    };
    Ok(RuntimeStatus { background: true, restored })
}

fn restore_agents(home: &Path, owner: &str, relays: &str) -> Result<usize, String> {
    adopt_legacy_agents(home, owner, relays)?;
    let mut restored = 0;
    let mut failures = vec![];
    for row in crate::load_agents_registry().into_iter().filter(|r| r.bin == "fez-agent") {
        let was_alive = row_alive(&row);
        let persona = row.persona.clone();
        match crate::spawn_agent_locked(row.persona, row.channels, row.owner.unwrap_or_else(|| owner.to_owned()),
            row.relays.unwrap_or_else(|| relays.to_owned()), row.repo, row.line, false) {
            Ok(_) => if !was_alive { restored += 1; },
            Err(error) => failures.push(format!("{persona}: {error}")),
        }
    }
    if !failures.is_empty() { return Err(format!("Some local agents could not be restored: {}", failures.join("; "))); }
    Ok(restored)
}

fn adopt_legacy_agents(home: &Path, owner: &str, relays: &str) -> Result<(), String> {
    let mut rows = crate::load_agents_registry();
    let legacy: serde_json::Value = std::fs::read(home.join("herdr-tabs.json")).ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok()).unwrap_or_default();
    if let Ok(entries) = std::fs::read_dir(home.join("agents")) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("pid") { continue; }
            let Some(persona) = path.file_stem().and_then(|s| s.to_str()) else { continue; };
            let Some(pid) = crate::sentinel_agent_pid(persona) else { continue; };
            if rows.iter().any(|r| r.persona == persona && r.bin == "fez-agent") { continue; }
            let prior = legacy.as_array().and_then(|rows| rows.iter().find(|r| r["persona"] == persona));
            let channels = prior.and_then(|r| r["channels"].as_array()).map(|channels|
                channels.iter().filter_map(|c| c.as_str().map(str::to_owned)).collect()).unwrap_or_default();
            let work = |field: &str| prior.and_then(|r| r["work"][field].as_str()).filter(|s| crate::safe_work(s)).map(str::to_owned);
            rows.push(crate::SpawnedAgent { persona: persona.into(), channels, repo: work("repo"), line: work("line"), pid,
                bin: crate::default_bin(), spawned_at: None, process_start: process_start(pid), owner: Some(owner.into()), relays: Some(relays.into()) });
        }
    }
    crate::save_agents_registry(&rows)
}

pub(crate) fn show(app: &tauri::AppHandle) {
    if let Some(window) = app.get_window("main") { let _ = window.show(); let _ = window.unminimize(); let _ = window.set_focus(); }
}
pub(crate) fn quit_requested(app: &tauri::AppHandle, api: &tauri::ExitRequestApi) {
    if prevent_quit(app) { api.prevent_exit(); }
}

fn prevent_quit(app: &tauri::AppHandle) -> bool {
    if QUIT_APPROVED.load(Ordering::SeqCst) { return false; }
    let working = match crate::AGENTS_REGISTRY_LOCK.try_lock() {
        Ok(_guard) => WORKER.lock().unwrap_or_else(|p| p.into_inner()).as_mut().is_some_and(Worker::alive)
            || GROUPS.lock().unwrap_or_else(|p| p.into_inner()).as_ref().is_some_and(|groups| !groups.is_empty())
            || crate::load_agents_registry().iter().any(|r| row_alive(r) || unresolved_legacy_extension(r)),
        Err(_) => true, // Startup/replacement is in flight; confirm before interrupting it.
    };
    if working { show(app); let _ = app.emit("fez-quit-requested", ()); }
    working
}

// Tao forwards applicationWillTerminate but not applicationShouldTerminate.
// Handle the latter on its existing delegate so Cmd+Q, the app menu and Dock
// Quit all use the same confirmation as the tray, without replacing the delegate.
#[cfg(target_os = "macos")]
pub(crate) mod macos_quit {
    use objc2::{class, ffi, msg_send, sel, runtime::{AnyClass, AnyObject, Imp, Sel}};

    unsafe extern "C-unwind" fn should_terminate(_: &AnyObject, _: Sel, _: *mut AnyObject) -> usize {
        let app = crate::APP_HANDLE.lock().unwrap_or_else(|p| p.into_inner()).clone();
        // NSTerminateCancel = 0, NSTerminateNow = 1. No handle means startup
        // has not completed, so do not allow an unconfirmed termination yet.
        usize::from(app.is_some_and(|app| !super::prevent_quit(&app)))
    }

    fn install_on(class: &AnyClass) -> Result<(), String> {
        let selector = sel!(applicationShouldTerminate:);
        if class.instance_method(selector).is_some() {
            return Err("The macOS app delegate already handles Quit; refusing to replace its handler".into());
        }
        // SAFETY: AppKit's method takes (self, selector, NSApplication*) and
        // returns NSUInteger. Both supported macOS targets are 64-bit (Q).
        let added = unsafe {
            let implementation = std::mem::transmute::<
                unsafe extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> usize, Imp
            >(should_terminate);
            ffi::class_addMethod((class as *const AnyClass).cast_mut(), selector, implementation, c"Q@:@".as_ptr())
        };
        if added.as_bool() { Ok(()) } else { Err("Couldn't install macOS Quit confirmation".into()) }
    }

    /// Called on the main thread after Tao has installed its application delegate.
    pub(crate) fn install() -> Result<(), String> {
        unsafe {
            let application: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            let delegate: *mut AnyObject = msg_send![application, delegate];
            let delegate = delegate.as_ref().ok_or("macOS application delegate is missing")?;
            install_on(delegate.class())
        }
    }

    #[test]
    fn native_quit_dispatches_to_our_handler_without_replacing_existing_methods() {
        use objc2::{msg_send, rc::Retained, runtime::ClassBuilder};
        let class = ClassBuilder::new(c"FezQuitDelegateTest", class!(NSObject)).unwrap().register();
        install_on(class).unwrap();
        assert!(install_on(class).is_err());
        unsafe {
            let delegate: Retained<AnyObject> = msg_send![class, new];
            let reply: usize = msg_send![&*delegate, applicationShouldTerminate: std::ptr::null_mut::<AnyObject>()];
            assert_eq!(reply, 0, "Quit must be cancelled before the app handle is ready");
        }
    }
}

#[tauri::command]
pub(crate) fn confirm_desktop_quit(app: tauri::AppHandle) -> Result<(), String> {
    let rows = crate::load_agents_registry();
    reject_unresolved_legacy(&rows)?;
    for row in rows.iter().filter(|r| row_alive(r) && !owned_group(r.pid)) { legacy_descendants(row.pid)?; }
    STOPPING.store(true, Ordering::SeqCst);
    QUIT_APPROVED.store(true, Ordering::SeqCst);
    app.exit(0);
    Ok(())
}

pub(crate) fn shutdown() {
    STOPPING.store(true, Ordering::SeqCst);
    let _guard = crate::AGENTS_REGISTRY_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    if SHUTDOWN_DONE.swap(true, Ordering::SeqCst) { return; }
    if let Some(mut worker) = WORKER.lock().unwrap_or_else(|p| p.into_inner()).take() { worker.stop(); }
    let rows = crate::load_agents_registry();
    let groups = GROUPS.lock().unwrap_or_else(|p| p.into_inner()).clone().unwrap_or_default();
    for pid in &groups { signal(*pid, true, libc::SIGTERM); }
    let descendants: Vec<_> = rows.iter().filter(|r| !owned_group(r.pid) && row_alive(r))
        .flat_map(|r| legacy_descendants(r.pid).unwrap_or_else(|e| { eprintln!("{e}"); vec![] })).collect();
    signal_descendants(&descendants, libc::SIGTERM);
    // Signal every owned body together so shutdown stays bounded as the fleet grows.
    for row in &rows {
        if row_alive(row) {
            expected_stop(row.pid); signal(row.pid, owned_group(row.pid), libc::SIGTERM);
        }
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline && (groups.iter().any(|pid| group_alive(*pid))
        || rows.iter().any(|r| !owned_group(r.pid) && row_alive(r))) {
        std::thread::sleep(Duration::from_millis(25));
    }
    for row in &rows {
        if owned_group(row.pid) { signal(row.pid, true, libc::SIGKILL); forget_group(row.pid); }
        else if row_alive(row) { signal(row.pid, false, libc::SIGKILL); }
    }
    for pid in groups { signal(pid, true, libc::SIGKILL); forget_group(pid); }
    signal_descendants(&descendants, libc::SIGKILL);
    // Keep intent rows for restoration, and leave local relay / remote agents alone.
    if let Ok(home) = crate::fez_home() { let _ = std::fs::remove_file(home.join("desktop-runtime.json")); }
    OWNER_LOCK.lock().unwrap_or_else(|p| p.into_inner()).take();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_requires_recognized_service_and_preserves_restrictions() {
        let value = serde_json::json!({ "Label": LABEL, "ProgramArguments": ["/opt/node/bin/node", "/opt/fez/dist/cli.js", "sentinel", "--extensions", "slack,github"] });
        assert_eq!(sentinel_arguments(&value).unwrap(), Some(vec!["slack".into(), "github".into()]));
        let bad = serde_json::json!({ "Label": LABEL, "ProgramArguments": ["/bin/sh", "-c", "fez sentinel"] });
        assert!(sentinel_arguments(&bad).is_err());
        let wrong_label = serde_json::json!({ "Label": "another-service", "ProgramArguments": ["/bin/fez-sentinel"] });
        assert!(sentinel_arguments(&wrong_label).is_err());
        let pinned = serde_json::json!({ "EnvironmentVariables": { "FEZ_RELAY": "wss://one" }, "ProgramArguments": ["/bin/fez-sentinel"] });
        assert!(check_legacy_relay(&pinned, "wss://two").is_err());
        assert!(check_legacy_relay(&pinned, "wss://one").is_ok());
        let flag = serde_json::json!({ "ProgramArguments": ["/bin/fez-sentinel", "--relay", "wss://one"] });
        assert!(check_legacy_relay(&flag, "wss://two").is_err());
    }

    #[test]
    fn failed_handoff_restores_the_backup_and_releases_headless_ownership() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let mut migration = Migration { plist: home.join("service.plist"), backup: home.join("backup.plist"),
            selection: BackgroundSelection { extensions: Some(vec!["slack".into()]) }, loaded: true, stopped: true };
        std::fs::write(&migration.backup, b"original service").unwrap();
        std::fs::write(home.join("desktop-runtime.json"), b"owned").unwrap();
        migration.rollback_with(home, |args| {
            assert_eq!(args[0], "bootstrap");
            assert_eq!(std::fs::read(args[2]).unwrap(), b"original service");
            assert!(!home.join("desktop-runtime.json").exists());
            Ok(true)
        }).unwrap();
        assert!(!migration.stopped);
        assert_eq!(migration.selection.extensions.unwrap(), vec!["slack"]);
    }

    #[test]
    fn real_process_lifecycle_in_an_isolated_home() {
        let temp = tempfile::tempdir().unwrap();
        let bin = temp.path().join(".fez/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let source = temp.path().join("body.c");
        std::fs::write(&source, r#"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  alarm(45);
  if (strstr(argv[0], "fez-background")) {
    char line[64]; puts("FEZ_BACKGROUND_READY"); fflush(stdout);
    if (!fgets(line, sizeof(line), stdin)) return 0;
    if (getenv("FEZ_TEST_FAIL_START")) return 1;
    if (strcmp(line, "start\n")) return 2;
    puts("FEZ_BACKGROUND_STARTED"); fflush(stdout);
    while (fgets(line, sizeof(line), stdin)) {}
    return 0;
  }
  pid_t child = fork();
  if (!child) { alarm(45); for (;;) pause(); }
  const char *dir = getenv("FEZ_TEST_CHILD_DIR"), *persona = getenv("FEZ_AGENT_PERSONA");
  if (dir && persona) {
    char file[4096]; snprintf(file, sizeof(file), "%s/%s", dir, persona);
    FILE *out = fopen(file, "w"); if (out) { fprintf(out, "%d", child); fclose(out); }
  }
  for (;;) pause();
}
"#).unwrap();
        let out = Command::new("/usr/bin/cc").arg(&source).arg("-o").arg(bin.join("fez-agent")).output().unwrap();
        assert!(out.status.success(), "compile isolated body: {}", String::from_utf8_lossy(&out.stderr));
        std::fs::copy(bin.join("fez-agent"), bin.join("fez-background")).unwrap();
        std::fs::copy(bin.join("fez-agent"), bin.join("fez-test-extension")).unwrap();
        let out = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "desktop_runtime::tests::lifecycle_fixture", "--nocapture"])
            .env("HOME", temp.path()).env("FEZ_NATIVE_LIFECYCLE_FIXTURE", "1")
            .env("FEZ_TEST_CHILD_DIR", temp.path()).env("RUST_BACKTRACE", "1").output().unwrap();
        assert!(out.status.success(), "isolated lifecycle failed:\n{}\n{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    }

    #[test]
    fn lifecycle_fixture() {
        if std::env::var("FEZ_NATIVE_LIFECYCLE_FIXTURE").as_deref() != Ok("1") { return; }
        struct Cleanup;
        impl Drop for Cleanup { fn drop(&mut self) { shutdown(); } }
        let _cleanup = Cleanup;
        claim().unwrap();
        assert!(claim().is_err(), "a second desktop must not take ownership");
        let home = crate::fez_home().unwrap();
        let owner = "a".repeat(64);
        let row: crate::SpawnedAgent = serde_json::from_value(serde_json::json!({
            "persona": "scout", "channels": ["general", "dev"], "repo": "acme/repo", "line": "feature/one", "pid": 42,
        })).unwrap();
        crate::save_agents_registry(&[row]).unwrap();
        {
            let _guard = crate::AGENTS_REGISTRY_LOCK.lock().unwrap();
            assert_eq!(restore_agents(&home, &owner, "wss://relay.example").unwrap(), 1);
        }
        let first = crate::load_agents_registry().remove(0);
        let first_child = child_pid("scout");
        assert!(crate::pid_runs_bin(first.pid, "fez-agent"));
        assert!(!crate::pid_runs_bin(first.pid, "agent"), "a suffix must never confer PID ownership");
        assert_eq!(first.channels, vec!["general", "dev"]);
        assert_eq!(first.repo.as_deref(), Some("acme/repo"));
        assert_eq!(first.line.as_deref(), Some("feature/one"));
        let mut stale_same_binary = first.clone();
        stale_same_binary.process_start = Some("another process start".into());
        assert!(!stop_process(&stale_same_binary).unwrap(), "same executable with another start receipt must not be signalled");
        stale_same_binary.process_start = None;
        stale_same_binary.persona = "quill".into();
        assert!(!row_alive(&stale_same_binary), "legacy same-binary receipt must match the actual persona");
        assert!(legacy_persona_matches(first.pid, "scout"));
        let spawn = |manual| crate::spawn_agent_locked("scout".into(), first.channels.clone(), owner.clone(), "wss://relay.example".into(), first.repo.clone(), first.line.clone(), manual);
        let second = {
            let _guard = crate::AGENTS_REGISTRY_LOCK.lock().unwrap();
            assert_eq!(spawn(false).unwrap(), first.pid, "automatic startup must reuse the live body");
            let second = spawn(true).unwrap();
            assert_ne!(second, first.pid);
            second
        };
        wait_dead(first.pid, &home.join("bin/fez-agent"));
        wait_dead(first_child, &home.join("bin/fez-agent"));
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(crate::agent_last_exit("scout".into(), "fez-agent".into()), None, "old reaper must not publish a replacement failure");
        let extension = {
            let _guard = crate::AGENTS_REGISTRY_LOCK.lock().unwrap();
            crate::spawn_tracked_process("scout".into(), "fez-test-extension", vec![], vec![], None, None).unwrap()
        };
        assert_eq!(crate::load_agents_registry().len(), 2, "same persona in another bin is independent");
        let originals = crate::load_agents_registry();
        let mut legacy_rows = originals.clone();
        let old_extension = legacy_rows.iter_mut().find(|r| r.bin == "fez-test-extension").unwrap();
        old_extension.process_start = None;
        old_extension.spawned_at = Some(0);
        crate::save_agents_registry(&legacy_rows).unwrap();
        assert!(crate::kill_agent("scout".into(), Some("fez-test-extension".into())).is_err());
        assert!(upgrade_legacy_receipts().is_err(), "unverified old extension must block migration, not duplicate");
        assert_eq!(crate::load_agents_registry().len(), 2, "unverified old extension intent must survive");
        #[cfg(target_os = "macos")]
        {
            let old_extension = legacy_rows.iter_mut().find(|r| r.bin == "fez-test-extension").unwrap();
            old_extension.spawned_at = process_start(extension).and_then(|start| start.split(':').next()?.parse().ok());
            crate::save_agents_registry(&legacy_rows).unwrap();
            upgrade_legacy_receipts().unwrap();
            assert!(crate::load_agents_registry().iter().all(|r| r.process_start.is_some()));
        }
        crate::save_agents_registry(&originals).unwrap();
        assert!(crate::kill_agent("scout".into(), Some("fez-agent".into())).unwrap());
        assert!(crate::pid_runs_bin(extension, "fez-test-extension"));
        wait_dead(second, &home.join("bin/fez-agent"));
        assert_eq!(crate::load_agents_registry().len(), 1, "explicit Stop removes restoration intent");

        // A stale receipt must not signal the innocent process wearing its PID.
        let mut innocent = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let stale: crate::SpawnedAgent = serde_json::from_value(serde_json::json!({ "persona": "stale", "channels": [], "pid": innocent.id() })).unwrap();
        assert!(!stop_process(&stale).unwrap());
        assert!(pid_runs_path(innocent.id(), Path::new("/bin/sleep")));

        // Old bodies share the surrounding group; adopt and stop only their verified tree.
        let mut legacy = Command::new(home.join("bin/fez-agent")).env("FEZ_AGENT_PERSONA", "legacy").stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let legacy_child = child_pid("legacy");
        std::fs::create_dir_all(home.join("agents")).unwrap();
        std::fs::write(home.join("agents/legacy.pid"), legacy.id().to_string()).unwrap();
        std::fs::write(home.join("herdr-tabs.json"), br#"[{"persona":"legacy","channels":["ops"],"work":{"repo":"org/old","line":"main"}}]"#).unwrap();
        adopt_legacy_agents(&home, &owner, "wss://relay.example").unwrap();
        let adopted = crate::load_agents_registry().into_iter().find(|r| r.persona == "legacy").unwrap();
        assert_eq!(adopted.repo.as_deref(), Some("org/old"));
        assert_eq!(adopted.channels, vec!["ops"]);
        crate::kill_agent("legacy".into(), None).unwrap();
        let _ = legacy.wait();
        wait_dead(legacy_child, &home.join("bin/fez-agent"));
        assert!(pid_runs_path(innocent.id(), Path::new("/bin/sleep")), "legacy cleanup must not signal the shared group");
        let _ = innocent.kill(); let _ = innocent.wait();

        let mut worker = Worker::prepare(&home, &owner, "wss://relay.example", None, "configuration".into()).unwrap();
        assert!(worker.alive());
        worker.activate().unwrap();
        let worker_pid = worker.child.id();
        *WORKER.lock().unwrap() = Some(worker);
        shutdown();
        wait_dead(extension, &home.join("bin/fez-test-extension"));
        wait_dead(worker_pid, &home.join("bin/fez-background"));
        assert!(!home.join("desktop-runtime.json").exists());
        assert_eq!(crate::load_agents_registry().len(), 1, "Quit must preserve remaining intent rows");
        assert!(crate::spawn_agent_locked("scout".into(), vec![], owner, "wss://relay.example".into(), None, None, false).is_err(), "shutdown closes the spawn boundary");
    }

    fn child_pid(persona: &str) -> u32 {
        let path = PathBuf::from(std::env::var("FEZ_TEST_CHILD_DIR").unwrap()).join(persona);
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(pid) = std::fs::read_to_string(&path).ok().and_then(|s| s.parse().ok()) { return pid; }
            assert!(Instant::now() < deadline, "child did not start");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn wait_dead(pid: u32, path: &Path) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while pid_runs_path(pid, path) {
            assert!(Instant::now() < deadline, "process {pid} is still running");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
