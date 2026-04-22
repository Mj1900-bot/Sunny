//! PTY (pseudoterminal) management — real shell per terminal panel.
//!
//! Frontend opens a session with `pty_open`, writes bytes with `pty_write`,
//! receives output via `sunny://pty/<id>` events, resizes with `pty_resize`,
//! closes with `pty_close`.
//!
//! `open` is **idempotent**: if a session with the given id already exists
//! it is killed and replaced before the new one is created. This matters in
//! React dev mode where `StrictMode` double-mounts components; without it
//! the first mount leaks an orphan shell that lingers until the app exits.

use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

#[cfg(unix)]
use std::os::unix::io::RawFd;

pub struct PtyHandle {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    // Keep the child around so we can kill it on close. Without this the
    // child keeps running after we drop the master on macOS (the PTY hangup
    // is only delivered once the slave closes, which can race with us).
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

impl Drop for PtyHandle {
    fn drop(&mut self) {
        // Best-effort — the child may already be gone.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub struct PtyRegistry {
    sessions: Mutex<HashMap<String, Arc<Mutex<PtyHandle>>>>,
}

/// Upper bound on simultaneous open PTY sessions. The frontend can open
/// arbitrarily many distinct IDs otherwise — each session costs one
/// shell process, one reader thread, one kernel PTY slot, and counts
/// against the uid process table. 16 is plenty for four terminal panels
/// per page across four pages (which the HUD does not actually support)
/// while keeping a runaway agent from opening a thousand.
pub const MAX_PTY_SESSIONS: usize = 16;

impl PtyRegistry {
    pub fn new() -> Self {
        Self { sessions: Mutex::new(HashMap::new()) }
    }
}

#[derive(Serialize, Clone)]
pub struct PtyOutput {
    pub id: String,
    pub data: String,
}

pub fn open(
    registry: &PtyRegistry,
    app: AppHandle,
    id: String,
    cols: u16,
    rows: u16,
    shell: Option<String>,
) -> Result<(), String> {
    // Idempotent: if a session already exists under this id, drop it (which
    // kills the child via the `Drop` impl) before we create a replacement.
    // At the same time, enforce the session-count cap. The cap is checked
    // AFTER the idempotent remove so opening the same id repeatedly
    // (React StrictMode double-mount, user re-clicking a stale tab) can't
    // trip the cap on its own.
    {
        let mut sessions = registry.sessions.lock().unwrap();
        if let Some(existing) = sessions.remove(&id) {
            drop(existing);
        }
        if sessions.len() >= MAX_PTY_SESSIONS {
            return Err(format!(
                "pty session cap reached: {} open (max {MAX_PTY_SESSIONS}). \
                 Close an existing terminal before opening another.",
                sessions.len()
            ));
        }
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("openpty: {e}"))?;

    // `libc::openpty()` is called internally with NULL for the initial
    // termios struct. When the parent process has no controlling tty
    // (which is always true for a macOS GUI app launched from Finder),
    // the resulting pty comes up with UNDEFINED default termios. In
    // practice on macOS that leaves ICANON + ECHOE off, which means:
    //   · Backspace (0x7F) echoes as literal "^?" instead of erasing.
    //   · Enter never flushes a line into the shell's read loop.
    //   · Any tool that opens the tty before it sets raw mode itself
    //     (short-lived helpers, sudo prompts, anything pre-ZLE) misbehaves.
    //
    // Fix: after openpty, write a canonical "sane interactive tty"
    // termios onto the master fd, matching what `stty sane` would
    // produce in Terminal.app. The child shell inherits this when it
    // takes over the slave, and ZLE / rustyline / readline all start
    // from a known-good baseline.
    #[cfg(unix)]
    if let Some(fd) = pair.master.as_raw_fd() {
        unsafe { set_sane_termios(fd) };
    }

    let shell_bin = shell.unwrap_or_else(|| {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
    });

    let mut cmd = CommandBuilder::new(&shell_bin);
    // Login shell so the user's `.zprofile` / `.bash_profile` runs and
    // tools installed via brew / nvm / pyenv end up on PATH. Interactive
    // flag so `.zshrc` / `.bashrc` also runs (prompt, aliases, completions).
    cmd.arg("-l");
    cmd.arg("-i");

    // Inherit PATH and friends from the Tauri process. On macOS GUI apps
    // launched from Finder get a very short PATH (`/usr/bin:/bin:/usr/sbin:/sbin`);
    // the login shell will extend it via path_helper and the user's profile.
    // We still set TERM explicitly so xterm.js gets proper ANSI rendering.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if std::env::var("LANG").is_err() {
        cmd.env("LANG", "en_US.UTF-8");
    }

    if let Some(home) = dirs::home_dir() {
        cmd.cwd(home);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("spawn: {e}"))?;
    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| format!("writer: {e}"))?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| format!("reader: {e}"))?;

    let handle = Arc::new(Mutex::new(PtyHandle {
        writer,
        master: pair.master,
        child,
    }));
    registry.sessions.lock().unwrap().insert(id.clone(), handle);

    let id_clone = id.clone();
    let app_clone = app.clone();
    std::thread::spawn(move || {
        // Coalesce small reads into ~16ms windows so a firehose command
        // (log stream, yes, etc.) doesn't flood IPC with thousands of
        // events, but flush immediately when the pending buffer gets
        // big so interactive latency stays snappy.
        //
        // UTF-8 boundary handling: a single 8KB read can land mid-codepoint
        // (a 4-byte emoji split across reads). We keep an unvalidated
        // carry-over byte buffer and only emit whole-codepoint prefixes,
        // holding back at most 3 trailing bytes until they can be
        // completed. This replaces the previous `from_utf8_lossy` which
        // silently corrupted multibyte output at read boundaries.
        let event = format!("sunny://pty/{id_clone}");
        let closed_event = format!("sunny://pty/{id_clone}/closed");
        let mut buf = [0u8; 16 * 1024];
        let mut carry: Vec<u8> = Vec::with_capacity(8);
        let mut pending = String::with_capacity(8 * 1024);
        let mut last_flush = std::time::Instant::now();
        const FLUSH_INTERVAL: std::time::Duration = std::time::Duration::from_millis(8);
        const MAX_PENDING_BYTES: usize = 128 * 1024;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    carry.extend_from_slice(&buf[..n]);
                    let valid_up_to = match std::str::from_utf8(&carry) {
                        Ok(_) => carry.len(),
                        Err(err) => err.valid_up_to(),
                    };
                    if valid_up_to > 0 {
                        // SAFETY: `valid_up_to` is the length of the valid
                        // UTF-8 prefix as reported by `from_utf8`.
                        let decoded = unsafe {
                            std::str::from_utf8_unchecked(&carry[..valid_up_to])
                        };
                        pending.push_str(decoded);
                        carry.drain(..valid_up_to);
                    }
                    // Safety valve: if the carry ever grows larger than a
                    // plausible max codepoint (4 bytes), something is
                    // genuinely garbled — drop the prefix and keep going
                    // so one bad byte can't stall the stream forever.
                    if carry.len() > 8 {
                        pending.push('\u{FFFD}');
                        carry.clear();
                    }
                    if pending.len() >= MAX_PENDING_BYTES
                        || last_flush.elapsed() >= FLUSH_INTERVAL
                    {
                        let _ = app_clone.emit(
                            &event,
                            PtyOutput { id: id_clone.clone(), data: std::mem::take(&mut pending) },
                        );
                        last_flush = std::time::Instant::now();
                    }
                }
                Err(_) => break,
            }
        }
        if !pending.is_empty() {
            let _ = app_clone.emit(
                &event,
                PtyOutput { id: id_clone.clone(), data: pending },
            );
        }
        let _ = app_clone.emit(&closed_event, &id_clone);
    });

    Ok(())
}

pub fn write(registry: &PtyRegistry, id: &str, data: &[u8]) -> Result<(), String> {
    let sessions = registry.sessions.lock().unwrap();
    let handle = sessions.get(id).ok_or("unknown pty")?.clone();
    drop(sessions);
    let mut h = handle.lock().unwrap();
    h.writer.write_all(data).map_err(|e| format!("write: {e}"))?;
    h.writer.flush().ok();
    Ok(())
}

pub fn resize(registry: &PtyRegistry, id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = registry.sessions.lock().unwrap();
    let handle = sessions.get(id).ok_or("unknown pty")?.clone();
    drop(sessions);
    let h = handle.lock().unwrap();
    h.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("resize: {e}"))?;
    Ok(())
}

pub fn close(registry: &PtyRegistry, id: &str) {
    // Dropping the Arc triggers `PtyHandle::drop`, which kills the child.
    registry.sessions.lock().unwrap().remove(id);
}

// ---------------------------------------------------------------------------
// Termios bootstrap.
//
// Writes a standard "sane" interactive tty configuration onto the pty.
// Matches the output of `stty sane` on macOS so everything downstream
// (zsh ZLE, bash readline, sudo, password prompts, `claude`, vim, etc.)
// starts from the same known-good baseline the user gets in Terminal.app.
// ---------------------------------------------------------------------------

#[cfg(unix)]
unsafe fn set_sane_termios(fd: RawFd) {
    let mut t: libc::termios = std::mem::zeroed();
    if libc::tcgetattr(fd, &mut t) != 0 {
        // If we can't read the current state we also can't write a new one
        // reliably — skip and hope the shell fixes it up via ZLE.
        return;
    }

    // Input: CR -> NL, allow XON/XOFF flow control, beep on line overflow,
    // BRKINT so Ctrl-C-equivalent break conditions raise SIGINT, IUTF8 so
    // multibyte-aware erase works when the user is typing non-ASCII.
    t.c_iflag = libc::BRKINT | libc::ICRNL | libc::IXON | libc::IMAXBEL | libc::IUTF8;

    // Output: post-process output, translate NL -> CRLF for the render.
    t.c_oflag = libc::OPOST | libc::ONLCR;

    // Control: 8-bit chars, enable receiver, hang-up on close.
    t.c_cflag = libc::CREAD | libc::CS8 | libc::HUPCL;

    // Local flags — the crucial one. ICANON is line-buffered mode
    // (Enter flushes the line), ECHO*/ECHOE/ECHOK/ECHOKE/ECHOCTL give
    // readable line editing, ISIG routes Ctrl-C/Z/\\ to signals, IEXTEN
    // enables Ctrl-V / Ctrl-O for literal escape / flush.
    t.c_lflag = libc::ECHO
        | libc::ECHOE
        | libc::ECHOK
        | libc::ECHOKE
        | libc::ECHOCTL
        | libc::ICANON
        | libc::IEXTEN
        | libc::ISIG;

    // Control chars. These are the POSIX/macOS defaults; writing them
    // explicitly means we don't trust whatever garbage came back from
    // `tcgetattr` on an uninitialized pty.
    t.c_cc[libc::VEOF] = 0x04; // Ctrl-D
    t.c_cc[libc::VINTR] = 0x03; // Ctrl-C
    t.c_cc[libc::VQUIT] = 0x1c; // Ctrl-\
    t.c_cc[libc::VERASE] = 0x7f; // Delete/Backspace key
    t.c_cc[libc::VKILL] = 0x15; // Ctrl-U
    t.c_cc[libc::VSUSP] = 0x1a; // Ctrl-Z
    t.c_cc[libc::VSTART] = 0x11; // Ctrl-Q
    t.c_cc[libc::VSTOP] = 0x13; // Ctrl-S
    t.c_cc[libc::VMIN] = 1;
    t.c_cc[libc::VTIME] = 0;

    // VWERASE / VLNEXT / VREPRINT / VDISCARD are present on every libc
    // target we care about (macOS, Linux, BSD), so no cfg-gate needed.
    t.c_cc[libc::VWERASE] = 0x17; // Ctrl-W
    t.c_cc[libc::VLNEXT] = 0x16; // Ctrl-V
    t.c_cc[libc::VREPRINT] = 0x12; // Ctrl-R
    t.c_cc[libc::VDISCARD] = 0x0f; // Ctrl-O

    // Speed — PTYs don't actually have a baud rate but tools like `stty`
    // read it back and some programs refuse to run if it's 0.
    libc::cfsetispeed(&mut t, libc::B38400);
    libc::cfsetospeed(&mut t, libc::B38400);

    let _ = libc::tcsetattr(fd, libc::TCSANOW, &t);
}
