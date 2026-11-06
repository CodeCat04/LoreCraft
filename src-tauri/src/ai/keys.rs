//! API keys, one per provider profile. They live in the OS credential store and are
//! read only here and by the HTTP layer. No function here is reachable from the UI in
//! a way that returns a key, and no error message contains one.

use std::collections::BTreeMap;
use std::sync::Mutex;

use crate::error::{AppError, AppResult};
use crate::paths::{self, Paths};

const SERVICE: &str = "com.codecat04.lorecraft";

fn account(profile_id: &str) -> String {
    format!("ai-profile:{profile_id}")
}

/// Tests must not touch the user's real credentials, so they get a file in their own
/// data folder. Production builds never take this path unless `LORECRAFT_E2E` is set.
fn uses_test_store() -> bool {
    cfg!(test) || paths::is_e2e()
}

// The test store is read-modify-write on one file.
static TEST_STORE_LOCK: Mutex<()> = Mutex::new(());

fn test_store_path(paths: &Paths) -> std::path::PathBuf {
    paths.root.join("test-api-keys.json")
}

fn read_test_store(paths: &Paths) -> BTreeMap<String, String> {
    std::fs::read(test_store_path(paths))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_test_store(paths: &Paths, store: &BTreeMap<String, String>) -> AppResult<()> {
    std::fs::write(test_store_path(paths), serde_json::to_vec(store)?)?;
    Ok(())
}

fn keyring_error(e: keyring::Error) -> AppError {
    // The keyring's own errors never include the secret, but they can include the
    // account name, which is harmless.
    AppError::new("KEY_STORE", format!("The system credential store failed: {e}"))
}

fn entry(service: &str, profile_id: &str) -> AppResult<keyring::Entry> {
    keyring::Entry::new(service, &account(profile_id)).map_err(keyring_error)
}

pub fn set(paths: &Paths, profile_id: &str, key: &str) -> AppResult<()> {
    let key = key.trim();
    if key.is_empty() {
        return Err(AppError::invalid("Enter a key, or use Remove to delete it."));
    }
    if uses_test_store() {
        let _guard = TEST_STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut store = read_test_store(paths);
        store.insert(account(profile_id), key.to_string());
        return write_test_store(paths, &store);
    }
    entry(SERVICE, profile_id)?
        .set_password(key)
        .map_err(keyring_error)
}

pub fn get(paths: &Paths, profile_id: &str) -> AppResult<Option<String>> {
    if uses_test_store() {
        let _guard = TEST_STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        return Ok(read_test_store(paths).get(&account(profile_id)).cloned());
    }
    match entry(SERVICE, profile_id)?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(keyring_error(e)),
    }
}

pub fn has(paths: &Paths, profile_id: &str) -> AppResult<bool> {
    Ok(get(paths, profile_id)?.is_some())
}

pub fn delete(paths: &Paths, profile_id: &str) -> AppResult<()> {
    if uses_test_store() {
        let _guard = TEST_STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut store = read_test_store(paths);
        store.remove(&account(profile_id));
        return write_test_store(paths, &store);
    }
    match entry(SERVICE, profile_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(keyring_error(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::TestDir;

    #[test]
    fn keys_round_trip_per_profile_and_stay_out_of_the_real_store() {
        let dir = TestDir::new();
        let paths = Paths::at(&dir.0);
        assert!(!has(&paths, "a").unwrap());
        set(&paths, "a", "  sk-secret-a ").unwrap();
        set(&paths, "b", "sk-secret-b").unwrap();
        assert_eq!(get(&paths, "a").unwrap().as_deref(), Some("sk-secret-a"));
        assert_eq!(get(&paths, "b").unwrap().as_deref(), Some("sk-secret-b"));
        delete(&paths, "a").unwrap();
        assert!(!has(&paths, "a").unwrap());
        assert!(has(&paths, "b").unwrap());
        // Deleting twice is fine.
        delete(&paths, "a").unwrap();
        assert!(dir.0.join("test-api-keys.json").exists());
    }

    #[test]
    fn an_empty_key_is_refused() {
        let dir = TestDir::new();
        let err = set(&Paths::at(&dir.0), "a", "   ").unwrap_err();
        assert_eq!(err.code, "INVALID");
    }

    /// Exercises the real OS store with a throwaway service name, created and removed
    /// here. It does not read or change any real LoreCraft credential. Run by hand:
    /// `cargo test real_credential_store -- --ignored`.
    #[test]
    #[ignore = "touches the OS credential store, with a throwaway entry"]
    fn real_credential_store_round_trips_a_throwaway_entry() {
        let service = format!("{SERVICE}.test-{}", crate::db::new_id());
        let entry = entry(&service, "throwaway").unwrap();
        entry.set_password("not-a-real-key").unwrap();
        let read = entry.get_password();
        let deleted = entry.delete_credential();
        assert_eq!(read.unwrap(), "not-a-real-key");
        deleted.unwrap();
        assert!(matches!(entry.get_password(), Err(keyring::Error::NoEntry)));
    }
}
