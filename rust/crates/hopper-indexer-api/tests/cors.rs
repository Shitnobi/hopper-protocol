//! The browser read policy on the public API: `*` by default (the
//! inscription viewer and a hosted PWA read it from another origin), an
//! explicit allowlist when the operator sets `HOPPER_CORS_ORIGINS`, and
//! none of it on admin/metrics.
//!
//! These are the rules as middleware sees them (no sockets), because that
//! is what a browser checks: the header value, `Vary`, and the preflight.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{HeaderMap, Request, StatusCode};
use axum::Router;
use hopper_indexer::state_machine::{Indexer, IndexerConfig};
use hopper_indexer_api::{app_with_cors, ApiState, CorsPolicy};
use tower::ServiceExt;

fn state() -> Arc<ApiState> {
    Arc::new(ApiState::new(Indexer::new(IndexerConfig::default())))
}

async fn send(
    app: &Router,
    method: &str,
    uri: &str,
    headers: &[(&str, &str)],
) -> (StatusCode, HeaderMap) {
    let mut request = Request::builder().method(method).uri(uri);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    (response.status(), response.headers().clone())
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

#[tokio::test]
async fn wildcard_answers_every_origin() {
    let app = app_with_cors(state(), CorsPolicy::wildcard());
    let (code, headers) = send(
        &app,
        "GET",
        "/v1/status",
        &[("origin", "https://user.github.io")],
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(header(&headers, "access-control-allow-origin"), Some("*"));
    assert!(
        header(&headers, "vary").is_none(),
        "`*` does not depend on the request"
    );
}

#[tokio::test]
async fn allowlist_echoes_the_matching_origin_and_varies() {
    let app = app_with_cors(
        state(),
        CorsPolicy::allow(["https://user.github.io", "https://box.example.com/"]),
    );
    let (code, headers) = send(
        &app,
        "GET",
        "/v1/status",
        &[("origin", "https://user.github.io")],
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(
        header(&headers, "access-control-allow-origin"),
        Some("https://user.github.io")
    );
    assert!(
        header(&headers, "vary").is_some_and(|v| v.to_ascii_lowercase().contains("origin")),
        "a narrowed policy must vary on origin"
    );

    // Trailing slash in the configured value is normalised away.
    let (_, headers) = send(
        &app,
        "GET",
        "/v1/status",
        &[("origin", "https://box.example.com")],
    )
    .await;
    assert_eq!(
        header(&headers, "access-control-allow-origin"),
        Some("https://box.example.com")
    );
}

#[tokio::test]
async fn allowlist_sends_nothing_to_other_origins() {
    let app = app_with_cors(state(), CorsPolicy::allow(["https://user.github.io"]));
    let (code, headers) = send(
        &app,
        "GET",
        "/v1/status",
        &[("origin", "https://bob.github.io")],
    )
    .await;
    // The data is still served (non-browser clients get it); the browser
    // blocks the *read* because there is no allow-origin header.
    assert_eq!(code, StatusCode::OK);
    assert!(header(&headers, "access-control-allow-origin").is_none());

    // A subdomain is a different origin, and so is a prefix trick.
    let (_, headers) = send(
        &app,
        "GET",
        "/v1/status",
        &[("origin", "https://user.github.io.evil.example")],
    )
    .await;
    assert!(header(&headers, "access-control-allow-origin").is_none());
}

#[tokio::test]
async fn preflight_is_answered_with_the_private_network_grant() {
    let app = app_with_cors(state(), CorsPolicy::allow(["https://user.github.io"]));
    let (code, headers) = send(
        &app,
        "OPTIONS",
        "/v1/status",
        &[
            ("origin", "https://user.github.io"),
            ("access-control-request-method", "GET"),
            ("access-control-request-headers", "accept"),
            ("access-control-request-private-network", "true"),
        ],
    )
    .await;
    assert_eq!(code, StatusCode::NO_CONTENT);
    assert_eq!(
        header(&headers, "access-control-allow-origin"),
        Some("https://user.github.io")
    );
    assert_eq!(
        header(&headers, "access-control-allow-methods"),
        Some("GET, OPTIONS")
    );
    // Echoed, not invented: the browser asked for `accept`.
    assert_eq!(
        header(&headers, "access-control-allow-headers"),
        Some("accept")
    );
    // The PNA grant: without this Chrome refuses to send the GET to a
    // LAN or Tailscale address.
    assert_eq!(
        header(&headers, "access-control-allow-private-network"),
        Some("true")
    );
    assert!(header(&headers, "access-control-max-age").is_some());
}

#[tokio::test]
async fn preflight_from_an_unknown_origin_grants_nothing() {
    let app = app_with_cors(state(), CorsPolicy::allow(["https://user.github.io"]));
    let (code, headers) = send(
        &app,
        "OPTIONS",
        "/v1/status",
        &[
            ("origin", "https://bob.github.io"),
            ("access-control-request-method", "GET"),
            ("access-control-request-private-network", "true"),
        ],
    )
    .await;
    assert_eq!(code, StatusCode::NO_CONTENT);
    assert!(header(&headers, "access-control-allow-origin").is_none());
    assert!(header(&headers, "access-control-allow-private-network").is_none());
}

#[tokio::test]
async fn admin_and_operational_routes_never_take_cors() {
    let app = app_with_cors(state(), CorsPolicy::wildcard());
    for (method, uri) in [
        ("POST", "/v1/admin/block"),
        ("GET", "/healthz"),
        ("GET", "/readyz"),
        ("GET", "/metrics"),
    ] {
        let (_, headers) = send(&app, method, uri, &[("origin", "https://user.github.io")]).await;
        assert!(
            header(&headers, "access-control-allow-origin").is_none(),
            "{method} {uri} must not be readable from a page"
        );
    }
}

#[test]
fn policy_parsing_is_forgiving_but_exact() {
    // An empty setting has not narrowed anything.
    assert_eq!(CorsPolicy::allow(["", "  "]), CorsPolicy::wildcard());
    let policy = CorsPolicy::allow([" https://user.github.io/ "]);
    assert_eq!(
        policy.allow_origin(Some("https://user.github.io")),
        Some("https://user.github.io".to_string())
    );
    assert_eq!(
        policy.allow_origin(Some("https://user.github.io:443")),
        None
    );
    assert_eq!(policy.allow_origin(None), None);
    // `*` answers even a request with no Origin at all (curl, probes).
    assert_eq!(
        CorsPolicy::wildcard().allow_origin(None),
        Some("*".to_string())
    );
}
