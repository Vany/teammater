//! Everything about deciding what's allowed: the static-file path guard and
//! the `/obs` bus token. Split out of `main.rs`, which used to accumulate
//! every concern with no other obvious home — this one has no dependency on
//! `AppState`, so it stands alone.

use axum::{
    extract::Request,
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};
use rand::RngCore;
use std::{fmt::Write as _, path::Path};
use tracing::{error, info, warn};

/// Lives beside the TLS material: `server/certs/` is gitignored AND blocked by
/// `deny_sensitive_paths`, so the token is neither committed nor servable.
pub const BUS_TOKEN_PATH: &str = "server/certs/bus_token.txt";

/// Load the `/obs` bus token, generating one on first run.
///
/// Stable across restarts so a phone that scanned the QR code once keeps
/// working. Derived from the OS RNG via rand, hex-encoded.
pub fn load_or_create_bus_token() -> String {
    if let Ok(existing) = std::fs::read_to_string(BUS_TOKEN_PATH) {
        let trimmed = existing.trim().to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }

    let mut bytes = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let token = bytes.iter().fold(String::with_capacity(bytes.len() * 2), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    });

    if let Some(dir) = Path::new(BUS_TOKEN_PATH).parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    match std::fs::write(BUS_TOKEN_PATH, &token) {
        Ok(()) => info!("🔑 Generated new /obs bus token at {BUS_TOKEN_PATH}"),
        // Non-fatal on purpose: an in-memory token still secures this run, it
        // just means phones must re-scan after a restart. Failing to start the
        // whole server over this would be worse.
        Err(e) => error!("⚠️ Could not persist bus token ({e}) — using in-memory token"),
    }
    token
}

/// Reject requests for anything under the project root that is not a web asset.
///
/// Static serving is rooted at "." for convenience, which also exposes secrets
/// that live there. Deny by SHAPE rather than by listing filenames, so a new
/// secret does not silently become public the day it is added:
///   - any path segment starting with '.'  → dotfiles (.mcp.json, .env, .git)
///     and, as a free side effect, ".." traversal segments
///   - anything under /server              → TLS keys in certs/, sources, target/
///
/// Runs as a layer over the whole router, but every real route is matched
/// before the `ServeDir` fallback and none of them live under those prefixes.
pub fn is_sensitive_path(path: &str) -> bool {
    // Strip ALL leading slashes FIRST, mirroring tower-http 0.6.8's own
    // ServeDir::build_and_validate_path (serve_dir/mod.rs) exactly:
    // `requested_path.trim_start_matches('/')`, done before it percent-decodes.
    // `//server/certs/key.pem` has no segment starting with '.' and does not
    // start with "/server/" (two leading slashes, not one) — this guard let it
    // through — but ServeDir strips BOTH leading slashes the same way and
    // resolves it to ./server/certs/key.pem regardless. Verified live: a raw
    // `GET //server/certs/key.pem` returned 200 before this fix. Matching
    // tower-http's own normalization, rather than special-casing "exactly two
    // slashes", is what keeps this guard's view of "the path" from being able
    // to diverge from what ServeDir actually resolves — for any number of
    // leading slashes, not just two.
    let path = path.trim_start_matches('/');

    // Compare the DECODED path. The first version of this guard checked the raw
    // URI, but ServeDir percent-decodes each segment before hitting the disk —
    // so `/%2Emcp.json` and `/%73erver/certs/key.pem` sailed past it and served
    // the MCP token and the TLS private key anyway. Verified against the
    // running server: 200 with real content, while the undecoded spellings
    // correctly 404'd.
    //
    // Decode repeatedly until stable so a double-encoded `/%252Emcp.json`
    // cannot slip through either. Bounded, because a decode loop on attacker
    // input must terminate.
    let mut decoded = path.to_owned();
    for _ in 0..4 {
        let next = percent_encoding::percent_decode_str(&decoded)
            .decode_utf8_lossy()
            .into_owned();
        if next == decoded {
            break;
        }
        decoded = next;
    }

    // Compare case-INSENSITIVELY. This machine's filesystem (macOS APFS,
    // default config) is case-insensitive but case-PRESERVING, so
    // /SERVER/certs/key.pem resolves to the same file as
    // /server/certs/key.pem even though the two strings are not equal —
    // the exact-case check below let it through. Verified live: both
    // returned 200 before this fix. The dotfile check was accidentally
    // immune (it only tests for a literal '.', whose case never varies),
    // which is exactly why this went unnoticed the first two times.
    let decoded = decoded.to_lowercase();
    let hidden = decoded.split('/').any(|seg| seg.starts_with('.'));
    // No leading slash here — it was stripped above, matching tower-http.
    let server_dir = decoded == "server" || decoded.starts_with("server/");
    hidden || server_dir
}

pub async fn deny_sensitive_paths(req: Request, next: Next) -> Response {
    let path = req.uri().path();
    if is_sensitive_path(path) {
        warn!("🔒 Blocked request for sensitive path: {path}");
        // 404, not 403: a 403 confirms the file is there.
        return StatusCode::NOT_FOUND.into_response();
    }
    next.run(req).await
}

#[cfg(test)]
mod path_guard_tests {
    use super::is_sensitive_path;

    #[test]
    fn blocks_the_secrets_that_were_actually_reachable() {
        // Both of these returned 200 with real content before the guard.
        assert!(is_sensitive_path("/.mcp.json"));
        assert!(is_sensitive_path("/server/certs/key.pem"));
    }

    #[test]
    fn blocks_dotfiles_and_traversal_anywhere_in_the_path() {
        assert!(is_sensitive_path("/.env"));
        assert!(is_sensitive_path("/.git/config"));
        assert!(is_sensitive_path("/modules/../.mcp.json"));
        assert!(is_sensitive_path("/mp3/.hidden/x.mp3"));
    }

    #[test]
    fn blocks_the_whole_server_subtree() {
        assert!(is_sensitive_path("/server"));
        assert!(is_sensitive_path("/server/src/main.rs"));
        assert!(is_sensitive_path("/server/target/release/teammater-server"));
    }

    #[test]
    fn still_serves_the_actual_web_assets() {
        for ok in [
            "/",
            "/index.html",
            "/obs.html",
            "/mobile.html",
            "/index.js",
            "/modules/llm/module.js",
            "/mp3/startup.mp3",
            "/api/health",
        ] {
            assert!(!is_sensitive_path(ok), "{ok} must stay reachable");
        }
    }

    #[test]
    fn blocks_percent_encoded_spellings_of_the_same_paths() {
        // These returned 200 with the real MCP token and TLS key against the
        // running server while the guard compared the RAW path.
        assert!(is_sensitive_path("/%2Emcp.json"));
        assert!(is_sensitive_path("/%73erver/certs/key.pem"));
        assert!(is_sensitive_path("/%73erver/certs/bus_token.txt"));
        assert!(is_sensitive_path("/%2E%67it/config"));
    }

    #[test]
    fn blocks_double_encoded_spellings() {
        assert!(is_sensitive_path("/%252Emcp.json"));
        assert!(is_sensitive_path("/%2573erver/certs/key.pem"));
    }

    #[test]
    fn does_not_block_names_merely_containing_a_dot() {
        // Only a segment STARTING with '.' is hidden; extensions are fine.
        assert!(!is_sensitive_path("/teammater.js"));
        assert!(!is_sensitive_path("/server-status.html"));
    }

    #[test]
    fn blocks_case_variant_spellings_of_the_same_paths() {
        // These returned 200 with the real TLS private key against the running
        // server: this filesystem is case-insensitive (macOS APFS default), so
        // the exact-case string comparison this guard used to do let them serve.
        assert!(is_sensitive_path("/SERVER/certs/key.pem"));
        assert!(is_sensitive_path("/SeRvEr/certs/key.pem"));
        assert!(is_sensitive_path("/.MCP.JSON"));
        assert!(is_sensitive_path("/.Mcp.Json"));
        // Case variance combined with percent-encoding, since both bypasses
        // were found independently and either could reappear alone.
        assert!(is_sensitive_path("/%53ERVER/certs/key.pem"));
    }

    #[test]
    fn blocks_extra_leading_slashes() {
        // GET //server/certs/key.pem returned 200 against the running server
        // before this fix: no segment starts with '.', and "//server/..."
        // does not start with the literal "/server/" this guard checked for
        // (two leading slashes, not one) — but tower-http's ServeDir strips
        // ALL leading slashes the same way before resolving the file, so it
        // served the real key regardless. Any number of extra slashes must
        // collapse the same way this guard's own normalization does, not
        // just exactly two.
        assert!(is_sensitive_path("//server/certs/key.pem"));
        assert!(is_sensitive_path("///server/certs/key.pem"));
        assert!(is_sensitive_path("//.mcp.json"));
        // Combined with case variance and percent-encoding, since all three
        // bypasses were found independently.
        assert!(is_sensitive_path("//SERVER/certs/key.pem"));
        assert!(is_sensitive_path("//%73erver/certs/key.pem"));
    }
}
