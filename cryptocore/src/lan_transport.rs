//! Transport-agnostic LAN sync HTTP listener.
//!
//! Shared by the JNI (android) and napi (harmony) bridges. Owns the tiny_http
//! accept worker, the pending-response registry, and LAN IPv4 enumeration. The
//! "emit one request to the host language" step is injected by the caller, so
//! the same blocking transport drives both Kotlin (via JNI reverse callback)
//! and ArkTS (via napi ThreadsafeFunction).
//!
//! Request lifecycle:
//!   1. worker accepts an inbound HTTP request, assigns a `req_id`, stashes a
//!      response channel in the [`Pending`] map
//!   2. worker calls the injected `emit` closure → host language handler
//!   3. host computes a response and calls back into [`respond`]
//!   4. [`respond`] sends `(status, body)` over the channel, waking the worker
//!   5. worker writes the HTTP response
//!
//! Plaintext HTTP: on the LAN, PSK pairing + session AEAD provide
//! confidentiality, isomorphic with the desktop server. No TLS.
//!
//! Rust guideline compliant 2026-02-21
#![cfg(feature = "lan-server")]

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use tiny_http::{Header, Response, Server};

/// Maximum wait for the host language to compute a single response.
///
/// Must cover the worst-case on-device session-key derivation (noble/native
/// Argon2id with m=8MiB,t=2 can take several seconds) and align with the
/// client's 30s HTTP timeout. On timeout we reply 504 so the worker thread is
/// never wedged on a host that fails to respond.
pub const RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);

/// accept() poll interval.
///
/// [`stop`] flips `running` to false; the worker then exits within at most this
/// delay (we use `recv_timeout` rather than `unblock`, for a deterministic
/// shutdown path).
pub const ACCEPT_POLL: Duration = Duration::from_millis(400);

/// Per-request response channel: the worker waits on the receiver, [`respond`]
/// sends the `(HTTP status, body)` computed by the host language.
type Responder = Sender<(u16, Vec<u8>)>;

/// `req_id` → response channel. The worker inserts on each request; [`respond`]
/// removes and sends the host-computed `(status, body)`.
#[derive(Debug)]
pub struct Pending {
    next_id: AtomicU64,
    map: Mutex<HashMap<u64, Responder>>,
}

/// One inbound request, as handed to the host-language `emit` closure.
#[derive(Debug)]
pub struct Inbound<'a> {
    pub req_id: u64,
    pub method: &'a str,
    pub path: &'a str,
    pub body: &'a [u8],
}

/// A running listener.
///
/// The listening socket is kept alive by the `Arc<Server>` the worker owns;
/// joining the worker (in [`stop`]) drops that Arc and closes the socket, so we
/// do not store the `Server` here separately.
#[derive(Debug)]
pub struct Listener {
    pending: Arc<Pending>,
    running: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
    port: u16,
    hosts: Vec<String>,
}

impl Listener {
    /// OS-assigned port the listener bound to.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Routable LAN IPv4 addresses enumerated at bind time.
    pub fn hosts(&self) -> &[String] {
        &self.hosts
    }
}

/// Take a poison-tolerant lock guard.
///
/// Under `panic = "abort"` a mutex is never actually poisoned, so `into_inner`
/// is purely defensive recovery should the build profile ever change.
pub fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Enumerate routable LAN IPv4, skipping loopback and link-local (169.254/16).
///
/// Aligned with desktop `syncservice.go::detectLanHosts`.
pub fn enumerate_lan_ipv4() -> Vec<String> {
    let Ok(ifaces) = if_addrs::get_if_addrs() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for iface in ifaces {
        if iface.is_loopback() {
            continue;
        }
        if let std::net::IpAddr::V4(v4) = iface.ip() {
            if v4.is_link_local() {
                continue;
            }
            out.push(v4.to_string());
        }
    }
    out
}

/// Bind `0.0.0.0:0` and spawn the accept worker.
///
/// `emit` runs on the worker thread for each inbound request; it must trigger
/// the host-language handler and return `true` if the request was accepted (a
/// response will eventually arrive via [`respond`]), or `false` if the bridge
/// is unavailable (the worker then replies 500 immediately).
///
/// # Errors
///
/// Returns an `io::Error` if the socket cannot be bound or the worker thread
/// cannot be spawned.
pub fn start<E>(emit: E) -> std::io::Result<Listener>
where
    E: Fn(Inbound<'_>) -> bool + Send + 'static,
{
    let server = Arc::new(
        Server::http("0.0.0.0:0").map_err(|e| std::io::Error::other(e.to_string()))?,
    );
    let port = server.server_addr().to_ip().map_or(0, |addr| addr.port());
    let hosts = enumerate_lan_ipv4();

    let pending = Arc::new(Pending {
        next_id: AtomicU64::new(1),
        map: Mutex::new(HashMap::new()),
    });
    let running = Arc::new(AtomicBool::new(true));

    let w_server = Arc::clone(&server);
    let w_pending = Arc::clone(&pending);
    let w_running = Arc::clone(&running);
    let worker = thread::Builder::new()
        .name("zpass-sync-server".to_owned())
        .spawn(move || worker_loop(w_server, w_pending, w_running, emit))?;

    Ok(Listener {
        pending,
        running,
        worker: Some(worker),
        port,
        hosts,
    })
}

/// Single-worker accept loop.
///
/// The client request stream is inherently serial (pair → confirm → manifest →
/// fetch → push → report → poll), so one thread suffices; poll-resolutions is
/// always a short, immediately-returning request.
fn worker_loop<E>(
    server: Arc<Server>,
    pending: Arc<Pending>,
    running: Arc<AtomicBool>,
    emit: E,
) where
    E: Fn(Inbound<'_>) -> bool,
{
    while running.load(Ordering::Relaxed) {
        let mut request = match server.recv_timeout(ACCEPT_POLL) {
            Ok(Some(r)) => r,
            Ok(None) => continue, // timeout: recheck `running`
            Err(_) => break,
        };
        // Requests that arrive inside the shutdown window get 503.
        if !running.load(Ordering::Relaxed) {
            let _ = request.respond(Response::empty(503));
            break;
        }
        let method = request.method().to_string();
        let path = request.url().to_owned();
        let mut body = Vec::new();
        if request.as_reader().read_to_end(&mut body).is_err() {
            let _ = request.respond(Response::empty(400));
            continue;
        }
        let req_id = pending.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = channel::<(u16, Vec<u8>)>();
        lock(&pending.map).insert(req_id, tx);

        let accepted = emit(Inbound {
            req_id,
            method: &method,
            path: &path,
            body: &body,
        });
        if !accepted {
            lock(&pending.map).remove(&req_id);
            let _ = request.respond(Response::empty(500));
            continue;
        }
        match rx.recv_timeout(RESPONSE_TIMEOUT) {
            Ok((status, data)) => {
                let mut resp = Response::from_data(data).with_status_code(status);
                if let Ok(h) =
                    Header::from_bytes(&b"Content-Type"[..], &b"application/octet-stream"[..])
                {
                    resp.add_header(h);
                }
                let _ = request.respond(resp);
            }
            Err(_) => {
                lock(&pending.map).remove(&req_id);
                let _ = request.respond(Response::empty(504));
            }
        }
    }
}

/// Hand a host-computed response to the parked worker.
///
/// An unknown `req_id` (already timed out or the server already stopped) is
/// silently dropped.
pub fn respond(pending: &Pending, req_id: u64, status: u16, body: Vec<u8>) {
    let tx = lock(&pending.map).remove(&req_id);
    if let Some(tx) = tx {
        let _ = tx.send((status, body));
    }
}

/// Stop a listener. Idempotent at the call site (caller passes an owned handle).
///
/// Flips `running` to false, wakes every parked worker with a 503 so it can
/// finish promptly, joins the worker thread, then drops the last `Arc<Server>`
/// to close the listening socket.
pub fn stop(mut listener: Listener) {
    listener.running.store(false, Ordering::Relaxed);
    for (_, tx) in lock(&listener.pending.map).drain() {
        let _ = tx.send((503, Vec::new()));
    }
    if let Some(worker) = listener.worker.take() {
        let _ = worker.join();
    }
    // Dropping `listener` here releases the last Arc<Server>, closing the socket.
}

/// Borrow the pending-response registry (for [`respond`]).
pub fn pending(listener: &Listener) -> &Pending {
    &listener.pending
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read as _, Write as _};
    use std::net::TcpStream;

    /// Drive a full request → emit → respond → reply round trip with an
    /// in-process emit closure and a real TCP client. No napi/JNI involved.
    #[test]
    fn round_trip_emit_respond() {
        // emit() forwards (req_id, body) to the "host" side via a channel.
        let (emit_tx, emit_rx) = channel::<(u64, Vec<u8>)>();
        // Shared handle so the test thread can call respond() on the listener.
        let listener = Arc::new(Mutex::new(None::<Listener>));
        let listener_for_emit = Arc::clone(&listener);

        let started = start(move |inbound: Inbound<'_>| {
            let _ = emit_tx.send((inbound.req_id, inbound.body.to_vec()));
            // Spawn a responder that echoes the body back with 200.
            let listener_inner = Arc::clone(&listener_for_emit);
            let req_id = inbound.req_id;
            let body = inbound.body.to_vec();
            thread::spawn(move || {
                // Give the worker a beat to register the pending entry, then
                // respond. (start() returns the Listener after the worker is
                // spawned; the pending entry is inserted before emit() runs, so
                // it is already present here.)
                let guard = lock(&listener_inner);
                if let Some(l) = guard.as_ref() {
                    respond(pending(l), req_id, 200, body);
                }
            });
            true
        })
        .expect("bind listener");

        let port = started.port();
        *lock(&listener) = Some(started);

        // Connect and issue a minimal POST.
        let payload = b"hello-sync";
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        let req = format!(
            "POST /v1/sync/manifest HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            payload.len()
        );
        stream.write_all(req.as_bytes()).unwrap();
        stream.write_all(payload).unwrap();
        stream.flush().unwrap();

        let mut resp = String::new();
        stream.read_to_string(&mut resp).unwrap();
        assert!(resp.starts_with("HTTP/1.1 200"), "response was: {resp}");
        assert!(resp.ends_with("hello-sync"), "echo body missing: {resp}");

        // emit() was invoked exactly once with the right body.
        let (_, emitted) = emit_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(emitted, payload);

        let l = lock(&listener).take().unwrap();
        stop(l);
    }

    #[test]
    fn emit_false_yields_500() {
        let listener = start(|_inbound: Inbound<'_>| false).expect("bind");
        let port = listener.port();

        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        let req = "GET /v1/sync/manifest HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n";
        stream.write_all(req.as_bytes()).unwrap();
        stream.flush().unwrap();

        let mut resp = String::new();
        stream.read_to_string(&mut resp).unwrap();
        assert!(resp.starts_with("HTTP/1.1 500"), "response was: {resp}");

        stop(listener);
    }
}
