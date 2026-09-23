//! A process-owned idle-sleep assertion; extension policies stay independent.
//!
//! macOS holds an IOKit assertion, Linux a logind inhibitor lock. Both are
//! owned by this process: the OS releases them if Fez exits or crashes, so a
//! lost process can never leave the machine awake.
use std::{fs, path::PathBuf};
#[cfg(target_os = "macos")]
use std::{ffi::{c_char, c_void}, ptr};

#[cfg(target_os = "macos")]
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFStringCreateWithCString(allocator: *const c_void, text: *const c_char, encoding: u32) -> *const c_void;
    fn CFRelease(value: *const c_void);
}

#[cfg(target_os = "macos")]
#[link(name = "IOKit", kind = "framework")]
extern "C" {
    fn IOPMAssertionCreateWithName(kind: *const c_void, level: u32, name: *const c_void, id: *mut u32) -> i32;
    fn IOPMAssertionRelease(id: u32) -> i32;
}

#[cfg(target_os = "macos")]
struct Assertion(u32);

#[cfg(target_os = "macos")]
impl Assertion {
    fn new() -> Result<Self, String> {
        // These owned CF strings are valid for the call and released on every path.
        // The OS also releases the assertion if Fez exits or crashes.
        unsafe {
            let kind = CFStringCreateWithCString(ptr::null(), c"PreventUserIdleSystemSleep".as_ptr(), 0x08000100);
            let name = CFStringCreateWithCString(ptr::null(), c"Fez Always On".as_ptr(), 0x08000100);
            let mut id = 0;
            let result = if kind.is_null() || name.is_null() {
                Err("Could not allocate the Always On sleep assertion".into())
            } else {
                let status = IOPMAssertionCreateWithName(kind, 255, name, &mut id);
                if status == 0 { Ok(Self(id)) }
                else { Err(format!("macOS could not enable Always On ({status:#x})")) }
            };
            if !kind.is_null() { CFRelease(kind); }
            if !name.is_null() { CFRelease(name); }
            result
        }
    }
}

#[cfg(target_os = "macos")]
impl Drop for Assertion {
    fn drop(&mut self) {
        // This ID belongs to this process and is released exactly once.
        unsafe { IOPMAssertionRelease(self.0); }
    }
}

/// logind's equivalent of the IOKit assertion: a `block` inhibitor on `idle`,
/// which stops the idle timer without touching the display's own blanking —
/// the same scope as PreventUserIdleSystemSleep.
///
/// The lock lives as long as the process holding it, so `systemd-inhibit`
/// runs `cat` on a pipe we keep open. Fez exiting or crashing closes the
/// pipe, `cat` reads EOF and exits, and logind drops the lock. No stray
/// process can outlive us still holding the machine awake.
#[cfg(target_os = "linux")]
struct Assertion(std::process::Child);

#[cfg(target_os = "linux")]
impl Assertion {
    fn new() -> Result<Self, String> {
        use std::process::{Command, Stdio};
        let mut child = Command::new("systemd-inhibit")
            .args(["--what=idle", "--who=Fez", "--why=Fez Always On", "--mode=block", "cat"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound =>
                    "Always On needs systemd-inhibit, which this system does not provide".to_string(),
                _ => format!("Could not enable Always On: {e}"),
            })?;
        // systemd-inhibit takes the lock BEFORE it execs `cat`, so a refusal
        // (no logind session, no seat, policy) shows up as an immediate exit.
        // Nothing else reports it: a spawn that succeeded tells us only that
        // the binary ran. Give it a moment, then believe a live child.
        std::thread::sleep(std::time::Duration::from_millis(250));
        if let Ok(Some(status)) = child.try_wait() {
            let mut reason = String::new();
            if let Some(mut err) = child.stderr.take() {
                use std::io::Read as _;
                let _ = err.read_to_string(&mut reason);
            }
            let reason = reason.trim();
            return Err(if reason.is_empty() { format!("logind refused the Always On lock ({status})") }
                       else { format!("logind refused the Always On lock: {reason}") });
        }
        Ok(Self(child))
    }
}

#[cfg(target_os = "linux")]
impl Drop for Assertion {
    fn drop(&mut self) {
        // Closing the pipe is the ordinary release; the kill covers a `cat`
        // that somehow outlives its EOF. The wait reaps it either way, so a
        // toggled-off assertion leaves no zombie behind in the tray process.
        drop(self.0.stdin.take());
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

pub(crate) struct AlwaysOn {
    preference: PathBuf,
    assertion: Option<Assertion>,
}

impl AlwaysOn {
    pub(crate) fn new(preference: PathBuf) -> Self { Self { preference, assertion: None } }
    pub(crate) fn enabled(&self) -> bool { self.assertion.is_some() }

    pub(crate) fn restore(&mut self) -> Result<(), String> {
        let enabled = match fs::read_to_string(&self.preference) {
            Ok(raw) => match raw.trim() {
                "true" => true,
                "false" => false,
                _ => return Err("Saved Always On preference is invalid; toggle it to save a new choice".into()),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(e) => return Err(format!("Could not read Always On preference: {e}")),
        };
        self.assertion = if enabled { Some(Assertion::new()?) } else { None };
        Ok(())
    }

    pub(crate) fn set_enabled(&mut self, enabled: bool) -> Result<(), String> {
        if enabled == self.enabled() { return Ok(()); }
        let assertion = if enabled { Some(Assertion::new()?) } else { None };
        // Keep this local preference separate from shared extension grants/settings.
        // A failed save drops a new assertion and retains the previous state.
        fs::write(&self.preference, if enabled { "true" } else { "false" })
            .map_err(|e| format!("Could not save Always On preference: {e}"))?;
        self.assertion = assertion;
        Ok(())
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::{fs, process::Command, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};

    fn assertions() -> Vec<String> {
        let output = Command::new("/usr/bin/pmset").args(["-g", "assertions"]).output().unwrap();
        assert!(output.status.success());
        String::from_utf8(output.stdout).unwrap().lines()
            .filter(|line| line.contains(&format!("pid {}(", std::process::id())) && line.contains("Fez Always On"))
            .map(str::to_owned).collect()
    }

    fn expect_assertions(count: usize) {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let rows = assertions();
            if rows.len() == count {
                assert!(rows.iter().all(|row| row.contains("PreventUserIdleSystemSleep")), "must let the display sleep: {rows:?}");
                return;
            }
            assert!(Instant::now() < deadline, "expected {count} idle-sleep assertions, got {rows:?}");
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    #[test]
    fn remembers_choice_without_leaking_or_duplicating_sleep_assertions() {
        let root = std::env::temp_dir().join(format!("fez-always-on-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir(&root).unwrap();
        let preference = root.join("desktop-always-on");
        let mut state = AlwaysOn::new(preference.clone());
        state.restore().unwrap();
        assert!(!state.enabled());
        assert!(!preference.exists(), "default off needs no saved preference");
        expect_assertions(0);

        state.set_enabled(true).unwrap();
        expect_assertions(1);
        assert!(state.enabled());
        assert_eq!(fs::read_to_string(&preference).unwrap(), "true");
        state.set_enabled(true).unwrap();
        expect_assertions(1);
        drop(state);
        expect_assertions(0);

        let mut state = AlwaysOn::new(preference.clone());
        state.restore().unwrap();
        expect_assertions(1);
        state.set_enabled(false).unwrap();
        assert!(!state.enabled());
        expect_assertions(0);
        drop(state);
        let mut state = AlwaysOn::new(preference.clone());
        state.restore().unwrap();
        assert!(!state.enabled());
        expect_assertions(0);

        // Failed persistence must roll back a new assertion, or retain an existing one.
        fs::remove_file(&preference).unwrap();
        fs::create_dir(&preference).unwrap();
        assert!(state.set_enabled(true).is_err());
        assert!(!state.enabled());
        expect_assertions(0);
        fs::remove_dir(&preference).unwrap();
        state.set_enabled(true).unwrap();
        fs::remove_file(&preference).unwrap();
        fs::create_dir(&preference).unwrap();
        assert!(state.set_enabled(false).is_err());
        assert!(state.enabled());
        expect_assertions(1);
        drop(state);
        expect_assertions(0);
        fs::remove_dir(&preference).unwrap();

        fs::write(&preference, "broken").unwrap();
        let mut state = AlwaysOn::new(preference);
        assert!(state.restore().is_err());
        assert!(!state.enabled());
        expect_assertions(0);
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(all(test, target_os = "linux"))]
mod linux_tests {
    use super::*;
    use std::{fs, process::Command, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};

    /// Our own inhibitor rows, as logind reports them. The Why string is the
    /// identity here: the PID in the listing is systemd-inhibit's, not ours.
    fn locks() -> Vec<String> {
        let output = Command::new("systemd-inhibit").arg("--list").output().unwrap();
        assert!(output.status.success(), "systemd-inhibit --list failed");
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter(|line| line.contains("Fez Always On"))
            .map(str::to_owned)
            .collect()
    }

    fn expect_locks(count: usize) {
        // logind registers and drops asynchronously; poll rather than guess.
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let rows = locks();
            if rows.len() == count {
                assert!(rows.iter().all(|row| row.contains("idle")), "must let the display sleep: {rows:?}");
                return;
            }
            assert!(Instant::now() < deadline, "expected {count} idle inhibitors, got {rows:?}");
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    #[test]
    fn remembers_choice_without_leaking_or_duplicating_idle_inhibitors() {
        // A build host without a logind session cannot take a lock at all.
        // Say so and stop, rather than failing on the environment.
        if let Err(error) = Assertion::new() {
            eprintln!("skipping: this machine cannot hold an inhibitor ({error})");
            return;
        }
        expect_locks(0);

        let root = std::env::temp_dir().join(format!("fez-always-on-{}-{}", std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir(&root).unwrap();
        let preference = root.join("desktop-always-on");
        let mut state = AlwaysOn::new(preference.clone());
        state.restore().unwrap();
        assert!(!state.enabled());
        assert!(!preference.exists(), "default off needs no saved preference");
        expect_locks(0);

        state.set_enabled(true).unwrap();
        expect_locks(1);
        assert!(state.enabled());
        assert_eq!(fs::read_to_string(&preference).unwrap(), "true");
        state.set_enabled(true).unwrap();
        expect_locks(1);
        drop(state);
        expect_locks(0);

        let mut state = AlwaysOn::new(preference.clone());
        state.restore().unwrap();
        expect_locks(1);
        state.set_enabled(false).unwrap();
        assert!(!state.enabled());
        expect_locks(0);
        drop(state);
        let mut state = AlwaysOn::new(preference.clone());
        state.restore().unwrap();
        assert!(!state.enabled());
        expect_locks(0);

        // Failed persistence must roll back a new lock, or retain an existing one.
        fs::remove_file(&preference).unwrap();
        fs::create_dir(&preference).unwrap();
        assert!(state.set_enabled(true).is_err());
        assert!(!state.enabled());
        expect_locks(0);
        fs::remove_dir(&preference).unwrap();
        state.set_enabled(true).unwrap();
        fs::remove_file(&preference).unwrap();
        fs::create_dir(&preference).unwrap();
        assert!(state.set_enabled(false).is_err());
        assert!(state.enabled());
        expect_locks(1);
        drop(state);
        expect_locks(0);
        fs::remove_dir(&preference).unwrap();

        fs::write(&preference, "broken").unwrap();
        let mut state = AlwaysOn::new(preference);
        assert!(state.restore().is_err());
        assert!(!state.enabled());
        expect_locks(0);
        fs::remove_dir_all(root).unwrap();
    }
}
