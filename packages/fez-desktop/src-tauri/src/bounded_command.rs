//! One-shot commands: bound execution, pipe capture, and retained output together.

use std::io::{ErrorKind, Read};
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

pub(crate) fn run(
    command: &mut Command,
    timeout: Duration,
    max_output: usize,
) -> Result<Output, String> {
    run_with_lifecycle(command, timeout, max_output, |_| {}, |_| ())
}

/// Hooks let the desktop register its group under the app's lifecycle lock.
/// The reap guard stays alive until the leader has been signalled and reaped.
pub(crate) fn run_with_lifecycle<G>(
    command: &mut Command, timeout: Duration, max_output: usize,
    spawned: impl FnOnce(u32), reaping: impl FnOnce(u32) -> G,
) -> Result<Output, String> {
    let deadline = Instant::now() + timeout;
    let mut child = command
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("couldn't start command: {e}"))?;
    spawned(child.id());
    let result = (|| {
        let mut stdout_pipe = child.stdout.take().ok_or("stdout pipe missing")?;
        let mut stderr_pipe = child.stderr.take().ok_or("stderr pipe missing")?;
        nonblocking(&stdout_pipe)?;
        nonblocking(&stderr_pipe)?;
        let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
        let (mut stdout_eof, mut stderr_eof) = (false, false);
        let mut remaining = max_output;
        let mut exited = false;
        let mut chunk = [0; 8192];
        loop {
            if Instant::now() >= deadline {
                return Err(format!(
                    "ran past the {}s deadline and was stopped", timeout.as_secs_f64()
                ));
            }
            let mut progressed = false;
            // One read per stream per iteration: a noisy stdout cannot starve
            // stderr or postpone the deadline check. No blocking drain threads.
            for (name, pipe, captured, eof) in [
                ("stdout", &mut stdout_pipe as &mut dyn Read, &mut stdout, &mut stdout_eof),
                ("stderr", &mut stderr_pipe as &mut dyn Read, &mut stderr, &mut stderr_eof),
            ] {
                if *eof {
                    continue;
                }
                match pipe.read(&mut chunk) {
                    Ok(0) => *eof = true,
                    Ok(n) => {
                        if n > remaining {
                            return Err(format!("combined stdout/stderr exceeded the {max_output}-byte output limit; command stopped"));
                        }
                        remaining -= n;
                        captured.extend_from_slice(&chunk[..n]);
                        progressed = true;
                    }
                    Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted) => {}
                    Err(e) => return Err(format!("couldn't read {name}: {e}")),
                }
            }
            if !exited {
                exited = has_exited(child.id())?;
            }
            if exited && stdout_eof && stderr_eof {
                return Ok((stdout, stderr));
            }
            if !progressed {
                std::thread::sleep(
                    Duration::from_millis(5).min(deadline.saturating_duration_since(Instant::now()))
                );
            }
        }
    })();

    // The command owns its process group, including inherited pipe writers.
    // Nonblocking reads also bound capture when a descendant leaves that group.
    // Keep the leader unreaped until AFTER signalling: otherwise its numeric
    // pid/group could be reused while we wait for inherited pipes to close.
    // SAFETY: process_group(0) created the group; WNOWAIT retains its leader.
    let _reap_guard = reaping(child.id());
    unsafe { libc::killpg(child.id() as libc::pid_t, libc::SIGKILL); }
    let _ = child.kill();
    let status = child.try_wait();
    if !matches!(&status, Ok(Some(_))) {
        // Reaping must not extend the caller's deadline if the OS delays exit.
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
    let (stdout, stderr) = result?;
    let status = status
        .map_err(|e| format!("couldn't reap command: {e}"))?
        .ok_or("command exit status unavailable")?;
    Ok(Output { status, stdout, stderr })
}

pub(crate) fn has_exited(pid: u32) -> Result<bool, String> {
    // SAFETY: info is writable, zeroed storage; this only observes our child's
    // exit. WNOHANG avoids blocking and WNOWAIT reserves the pid until cleanup.
    unsafe {
        let mut info: libc::siginfo_t = std::mem::zeroed();
        if libc::waitid(
            libc::P_PID, pid as libc::id_t, &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        ) < 0 {
            return Err(format!(
                "couldn't observe command exit: {}", std::io::Error::last_os_error()
            ));
        }
        Ok(info.si_pid() != 0)
    }
}

fn nonblocking(pipe: &impl AsRawFd) -> Result<(), String> {
    let fd = pipe.as_raw_fd();
    // SAFETY: the pipe owns this live fd; fcntl only reads/updates its flags.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        if flags < 0 || libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
            return Err(format!(
                "couldn't configure output pipe: {}", std::io::Error::last_os_error()
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    // Independent watchdog: a blocked read cannot also block its own assertion.
    fn checked(mut command: Command, timeout: Duration, cap: usize) -> Result<Output, String> {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || { let _ = tx.send(run(&mut command, timeout, cap)); });
        rx.recv_timeout(Duration::from_secs(4)).expect("bounded command hung")
    }

    fn shell(script: &str) -> Command {
        let mut command = Command::new("sh");
        command.args(["-c", script]);
        command
    }

    #[test]
    fn drains_both_streams_beyond_pipe_capacity() {
        let output = checked(shell("head -c 262144 /dev/zero & head -c 262144 /dev/zero >&2 & wait"), Duration::from_secs(2), 524288).unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, vec![0; 262144]);
        assert_eq!(output.stderr, vec![0; 262144]);
    }

    #[test]
    fn output_limit_is_combined_and_never_returns_partial_success() {
        let error = checked(shell("head -c 4096 /dev/zero; head -c 4096 /dev/zero >&2"), Duration::from_secs(2), 8191).unwrap_err();
        assert!(error.contains("output limit"), "{error}");
    }

    #[test]
    fn continuous_output_hits_the_limit_without_waiting_for_exit() {
        let error = checked(shell("exec yes"), Duration::from_secs(30), 32768).unwrap_err();
        assert!(error.contains("output limit"), "{error}");
    }

    #[test]
    fn deadline_still_applies_after_both_pipes_close() {
        let error = checked(shell("exec 1>&- 2>&-; exec sleep 30"), Duration::from_millis(100), 1024).unwrap_err();
        assert!(error.contains("deadline"), "{error}");
    }

    #[test]
    fn inherited_pipe_after_parent_exit_cannot_hold_up_return() {
        let error = checked(shell("sleep 30 & printf done"), Duration::from_millis(100), 1024).unwrap_err();
        assert!(error.contains("deadline"), "{error}");
    }

    #[test]
    fn reserves_the_exited_leader_until_pipe_cleanup() {
        let dir = tempfile::tempdir().unwrap();
        let pidfile = dir.path().join("pid");
        let mut command = shell("echo $$ > \"$1\"; sleep 30 & exit 0");
        command.arg("fixture").arg(&pidfile);
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || { let _ = tx.send(run(&mut command, Duration::from_secs(1), 1024)); });
        let deadline = Instant::now() + Duration::from_millis(500);
        let pid = loop {
            if let Some(pid) = std::fs::read_to_string(&pidfile).ok().and_then(|s| s.trim().parse::<u32>().ok()) {
                break pid;
            }
            assert!(Instant::now() < deadline, "fixture did not start");
            std::thread::sleep(Duration::from_millis(5));
        };
        // The runner polls every 5 ms. It must still own this exited child
        // while the descendant's pipe remains open, rather than freeing its pid.
        std::thread::sleep(Duration::from_millis(50));
        let still_owned = has_exited(pid);
        assert!(rx.recv_timeout(Duration::from_secs(3)).unwrap().unwrap_err().contains("deadline"));
        assert_eq!(still_owned, Ok(true));
    }

    #[test]
    fn timeout_kills_a_process_that_ignores_term() {
        let dir = tempfile::tempdir().unwrap();
        let pidfile = dir.path().join("pid");
        let mut command = shell("echo $$ > \"$1\"; trap '' TERM; exec sleep 30");
        command.arg("fixture").arg(&pidfile);
        let error = checked(command, Duration::from_millis(100), 1024).unwrap_err();
        assert!(error.contains("deadline"), "{error}");
        let pid: libc::pid_t = std::fs::read_to_string(pidfile).unwrap().trim().parse().unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        // SAFETY: signal 0 probes the pid without sending a signal.
        while unsafe { libc::kill(pid, 0) } == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "child survived timeout");
    }

    #[test]
    fn preserves_literal_arguments_exit_status_and_stdin_eof() {
        let mut command = shell("read ignored; printf '%s' \"$1\"; printf diagnostic >&2; exit 7");
        command.args(["fixture", "literal $(not-a-command); 'quoted'"]);
        let output = checked(command, Duration::from_secs(2), 1024).unwrap();
        assert_eq!(output.status.code(), Some(7));
        assert_eq!(output.stdout, b"literal $(not-a-command); 'quoted'");
        assert_eq!(output.stderr, b"diagnostic");
    }

    #[test]
    fn spawn_errors_are_explicit() {
        assert!(checked(Command::new("/nonexistent/fez-test-command"), Duration::from_secs(1), 1024).unwrap_err().contains("couldn't start"));
    }
}
