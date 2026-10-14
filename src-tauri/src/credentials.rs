//! API keys live in the operating system's credential store, never an app JSON file.
use keyring::{Entry, Error};
use std::collections::BTreeMap;
use std::sync::Mutex;

static VAULT_LOCK: Mutex<()> = Mutex::new(());
pub const PROVIDERS: [&str; 3] = ["zernio", "elevenlabs", "youtube"];

fn entry(service: &str, provider: &str) -> Result<Entry, String> {
    if !PROVIDERS.contains(&provider) {
        return Err("Unknown credential provider".into());
    }
    Entry::new(service, provider).map_err(|_| "Could not open the system credential store".into())
}

pub fn read(service: &str) -> Result<BTreeMap<String, String>, String> {
    let _lock = VAULT_LOCK.lock().map_err(|_| "Credential store unavailable")?;
    let mut keys = BTreeMap::new();
    for provider in PROVIDERS {
        let value = match entry(service, provider)?.get_password() {
            Ok(value) => value,
            Err(Error::NoEntry) => String::new(),
            Err(_) => return Err("Could not read the system credential store. Unlock it and retry.".into()),
        };
        keys.insert(provider.into(), value);
    }
    Ok(keys)
}

fn write_entry(entry: Entry, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        match entry.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(_) => Err("Could not remove the stored API key".into()),
        }
    } else {
        entry.set_password(value.trim()).map_err(|_| "Could not save the API key in the system credential store".into())
    }
}

pub fn write(service: &str, provider: &str, value: &str) -> Result<(), String> {
    let _lock = VAULT_LOCK.lock().map_err(|_| "Credential store unavailable")?;
    write_entry(entry(service, provider)?, value)
}

pub fn clear(service: &str) -> Result<(), String> {
    let _lock = VAULT_LOCK.lock().map_err(|_| "Credential store unavailable")?;
    for provider in PROVIDERS {
        write_entry(entry(service, provider)?, "")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_arbitrary_credential_names() {
        assert!(entry("test", "other-app-password").is_err());
    }

    #[test]
    fn mock_store_roundtrip_and_deletion() {
        let credential = keyring::mock::MockCredential::default();
        let entry = Entry::new_with_credential(Box::new(credential));
        entry.set_password("test-only-secret").unwrap();
        assert_eq!(entry.get_password().unwrap(), "test-only-secret");
        write_entry(entry, "").unwrap();
    }
}
