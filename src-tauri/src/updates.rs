//! Asks GitHub whether a newer release exists. Nothing is downloaded or installed: the
//! writer reads the notes and follows a link to the release page.
//!
//! This is the only network call the app makes on its own account. It runs when someone
//! asks, or at startup if they turned that on. See docs/RELEASING.md.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::logs;
use crate::paths;

const LATEST_RELEASE_API: &str = "https://api.github.com/repos/CodeCat04/LoreCraft/releases/latest";
pub const RELEASES_PAGE: &str = "https://github.com/CodeCat04/LoreCraft/releases";
/// GitHub refuses requests without one. It names the app and nothing about the person.
const USER_AGENT: &str = "LoreCraft";
const TIMEOUT: Duration = Duration::from_secs(15);
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
const MAX_NOTES_CHARS: usize = 20_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    /// This is the newest version, or newer.
    Current,
    Available,
    /// A 404: no release has been published, or the repository is private.
    NoReleases,
    /// GitHub could not be reached.
    Offline,
    RateLimited,
    /// GitHub answered, but not with something usable.
    Failed,
}

impl Status {
    fn name(self) -> &'static str {
        match self {
            Status::Current => "current",
            Status::Available => "available",
            Status::NoReleases => "noReleases",
            Status::Offline => "offline",
            Status::RateLimited => "rateLimited",
            Status::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub status: Status,
    pub current: String,
    pub latest: Option<String>,
    /// As written on GitHub, in Markdown. Untrusted, so the UI renders it safely.
    pub notes: Option<String>,
    pub url: String,
    pub published_at: Option<String>,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    body: Option<String>,
    html_url: Option<String>,
    published_at: Option<String>,
}

fn parse_version(text: &str) -> Option<semver::Version> {
    semver::Version::parse(text.trim().trim_start_matches(['v', 'V'])).ok()
}

/// True when `latest` is a later version than `current`. Build metadata does not count.
fn is_newer(latest: &semver::Version, current: &semver::Version) -> bool {
    let key = |v: &semver::Version| (v.major, v.minor, v.patch, v.pre.clone());
    key(latest) > key(current)
}

/// The API's link is only followed if it stays on this project's release pages.
fn release_page(url: Option<&str>) -> String {
    match url {
        Some(url) if url.starts_with(&format!("{RELEASES_PAGE}/")) => url.to_string(),
        _ => RELEASES_PAGE.to_string(),
    }
}

/// Only the test harness can point this elsewhere, and it never reaches GitHub.
fn api_url() -> String {
    if paths::is_e2e() {
        return std::env::var("LORECRAFT_UPDATE_URL").unwrap_or_else(|_| "http://127.0.0.1:9/".to_string());
    }
    LATEST_RELEASE_API.to_string()
}

async fn read_body(mut response: reqwest::Response) -> Result<Vec<u8>, Status> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Status::Offline)? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_BODY_BYTES {
            return Err(Status::Failed);
        }
    }
    Ok(body)
}

async fn ask(url: &str, current: &str) -> UpdateCheck {
    let outcome = |status: Status| UpdateCheck {
        status,
        current: current.to_string(),
        latest: None,
        notes: None,
        url: RELEASES_PAGE.to_string(),
        published_at: None,
    };
    let mut client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(10))
        .timeout(TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(3));
    if paths::is_e2e() {
        client = client.no_proxy();
    }
    let Ok(client) = client.build() else {
        return outcome(Status::Failed);
    };
    let sent = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await;
    let Ok(response) = sent else {
        return outcome(Status::Offline);
    };
    let code = response.status().as_u16();
    match code {
        200 => {}
        404 => return outcome(Status::NoReleases),
        403 | 429 => return outcome(Status::RateLimited),
        _ => return outcome(Status::Failed),
    }
    let body = match read_body(response).await {
        Ok(body) => body,
        Err(status) => return outcome(status),
    };
    let Ok(release) = serde_json::from_slice::<Release>(&body) else {
        return outcome(Status::Failed);
    };
    let Some(latest) = parse_version(&release.tag_name) else {
        return outcome(Status::Failed);
    };
    let newer = parse_version(current).is_some_and(|mine| is_newer(&latest, &mine));
    UpdateCheck {
        status: if newer { Status::Available } else { Status::Current },
        current: current.to_string(),
        latest: Some(latest.to_string()),
        notes: release.body.map(|text| text.chars().take(MAX_NOTES_CHARS).collect()),
        url: release_page(release.html_url.as_deref()),
        published_at: release.published_at,
    }
}

/// Never fails: every way this can go wrong is one of the statuses, and the UI words them.
pub fn check() -> UpdateCheck {
    let result = tauri::async_runtime::block_on(ask(&api_url(), env!("CARGO_PKG_VERSION")));
    logs::info("update.check", &[("status", result.status.name())]);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::transport::tests::{json_reply, serve};
    use std::net::TcpListener;

    fn run(url: &str, current: &str) -> UpdateCheck {
        tauri::async_runtime::block_on(ask(url, current))
    }

    fn release_json(tag: &str) -> String {
        serde_json::json!({
            "tag_name": tag,
            "name": "A release",
            "body": "## Changes\n- Better",
            "html_url": format!("{RELEASES_PAGE}/tag/{tag}"),
            "published_at": "2026-11-05T10:00:00Z",
            "draft": false,
        })
        .to_string()
    }

    #[test]
    fn versions_compare_as_versions_and_not_as_text() {
        let newer = |latest: &str, current: &str| is_newer(&parse_version(latest).unwrap(), &parse_version(current).unwrap());
        assert!(newer("v0.10.0", "0.9.0"));
        assert!(newer("1.0.0", "1.0.0-beta.2"));
        assert!(newer("1.0.0-beta.10", "1.0.0-beta.2"));
        assert!(!newer("v1.0.0", "1.0.0"));
        assert!(!newer("1.0.0-rc.1", "1.0.0"));
        assert!(!newer("1.0.0+build5", "1.0.0"), "build metadata does not make a new version");
        assert!(parse_version("nightly").is_none());
    }

    #[test]
    fn a_newer_release_comes_back_with_its_notes_and_page() {
        let server = serve(vec![json_reply("200 OK", "", &release_json("v9.1.0"))]);
        let result = run(&server.url, "0.1.0");
        assert_eq!(result.status, Status::Available);
        assert_eq!(result.latest.as_deref(), Some("9.1.0"));
        assert_eq!(result.notes.as_deref(), Some("## Changes\n- Better"));
        assert_eq!(result.url, format!("{RELEASES_PAGE}/tag/v9.1.0"));
    }

    #[test]
    fn the_request_names_the_app_and_nothing_else() {
        let server = serve(vec![json_reply("200 OK", "", &release_json("v0.1.0"))]);
        let result = run(&server.url, "0.1.0");
        assert_eq!(result.status, Status::Current);
        let seen = server.requests.lock().unwrap();
        let lower = seen[0].to_ascii_lowercase();
        let agent = lower.lines().find_map(|l| l.strip_prefix("user-agent: ")).unwrap().trim();
        assert_eq!(agent, "lorecraft");
        for private in ["authorization", "cookie"] {
            assert!(!lower.contains(private), "{private} was sent");
        }
    }

    #[test]
    fn a_missing_or_private_repository_is_not_an_error() {
        let server = serve(vec![json_reply("404 Not Found", "", "{\"message\":\"Not Found\"}")]);
        assert_eq!(run(&server.url, "0.1.0").status, Status::NoReleases);
    }

    #[test]
    fn nothing_listening_means_offline() {
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        assert_eq!(run(&format!("http://127.0.0.1:{port}/"), "0.1.0").status, Status::Offline);
    }

    #[test]
    fn other_answers_have_their_own_statuses() {
        let server = serve(vec![
            json_reply("403 Forbidden", "", "{\"message\":\"API rate limit exceeded\"}"),
            json_reply("500 Internal Server Error", "", "{}"),
            json_reply("200 OK", "", "not json"),
            json_reply("200 OK", "", &release_json("nightly")),
        ]);
        assert_eq!(run(&server.url, "0.1.0").status, Status::RateLimited);
        assert_eq!(run(&server.url, "0.1.0").status, Status::Failed);
        assert_eq!(run(&server.url, "0.1.0").status, Status::Failed);
        assert_eq!(run(&server.url, "0.1.0").status, Status::Failed);
    }

    #[test]
    fn a_release_page_link_must_stay_on_this_project() {
        assert_eq!(release_page(Some(&format!("{RELEASES_PAGE}/tag/v1.0.0"))), format!("{RELEASES_PAGE}/tag/v1.0.0"));
        assert_eq!(release_page(Some("https://example.com/malware")), RELEASES_PAGE);
        assert_eq!(release_page(Some("https://github.com/CodeCat04/LoreCraft/releases-evil/x")), RELEASES_PAGE);
        assert_eq!(release_page(None), RELEASES_PAGE);
    }
}
