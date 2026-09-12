//! A process-owned macOS idle-sleep assertion; extension policies stay independent.
use std::{ffi::{c_char, c_void}, fs, path::PathBuf, ptr};

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFStringCreateWithCString(allocator: *const c_void, text: *const c_char, encoding: u32) -> *const c_void;
    fn CFRelease(value: *const c_void);
}

#[link(name = "IOKit", kind = "framework")]
extern "C" {
    fn IOPMAssertionCreateWithName(kind: *const c_void, level: u32, name: *const c_void, id: *mut u32) -> i32;
    fn IOPMAssertionRelease(id: u32) -> i32;
}

struct Assertion(u32);

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

impl Drop for Assertion {
    fn drop(&mut self) {
        // This ID belongs to this process and is released exactly once.
        unsafe { IOPMAssertionRelease(self.0); }
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

#[cfg(test)]
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
