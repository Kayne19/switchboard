// Stamps the build with the commit it came from so the journal and /healthz
// can answer "is the running service the code I pushed?" without guessing from
// log wording or diffing the bytes the page serves.
//
// In order of preference:
// 1. SWITCHBOARD_GIT_SHA from the build environment. The homelab deploy builds
//    from `git archive <pin>`, a tree with no .git, and passes the pin in here.
//    That makes the name interface between the two repos (see AGENTS.md).
// 2. `git describe --always --dirty --abbrev=12` in a checkout.
// 3. "unknown".
const STAMP: &str = "SWITCHBOARD_GIT_SHA";

// A commit, tag, or describe output fits in this; anything longer is not one.
const MAX_STAMP_LEN: usize = 128;

fn main() {
    println!("cargo:rerun-if-env-changed={STAMP}");
    println!("cargo:rerun-if-changed=.git/HEAD");
    println!("cargo:rerun-if-changed=.git/refs/heads");
    // Re-describe whenever the binary's own source changes, so a local build
    // made from edited sources says -dirty rather than keeping the clean stamp
    // of the last build that happened to run this script.
    println!("cargo:rerun-if-changed=apps/backend/src");
    let sha = explicit_stamp()
        .or_else(git_describe)
        .unwrap_or_else(|| "unknown".to_owned());
    println!("cargo:rustc-env={STAMP}={sha}");
}

// An explicit stamp is trusted only as far as it looks like a ref name. It is
// written into a cargo directive line, so a stray newline would smuggle in a
// directive of its own; a malformed value is a broken deploy, and failing the
// build says so where falling back to "unknown" would hide it.
fn explicit_stamp() -> Option<String> {
    let raw = std::env::var_os(STAMP)?;
    let Some(raw) = raw.to_str() else {
        panic!("{STAMP} is not valid UTF-8; set it to the commit being built");
    };
    let value = raw.trim();
    if value.is_empty() {
        println!("cargo:warning={STAMP} is set but empty; stamping from git describe instead");
        return None;
    }
    let plausible = value.len() <= MAX_STAMP_LEN
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-+/".contains(&b));
    assert!(
        plausible,
        "{STAMP}={value:?} is not a commit or tag name; set it to the commit being built"
    );
    Some(value.to_owned())
}

fn git_describe() -> Option<String> {
    std::process::Command::new("git")
        .args(["describe", "--always", "--dirty", "--abbrev=12"])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_owned())
        .filter(|sha| !sha.is_empty())
}
