/// Explicit provider selection. A configured key must never opt local jobs into cloud use.
pub fn helper_args(provider: Option<&str>, key: Option<&str>, require_key: bool) -> Result<Vec<String>, String> {
    let provider = provider.unwrap_or("local");
    if !["local", "elevenlabs"].contains(&provider) {
        return Err("Choose Local Whisper or ElevenLabs API in Settings → Engine".into());
    }
    let mut args = vec!["--engine".into(), provider.into()];
    if provider == "elevenlabs" {
        if let Some(key) = key.map(str::trim).filter(|key| !key.is_empty()) {
            args.extend(["--elevenlabs-key".into(), key.into()]);
        } else if require_key {
            return Err("ElevenLabs is selected. Save a key with Speech-to-Text access in Settings → API keys.".into());
        }
    }
    Ok(args)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_is_the_default_even_with_a_cloud_key() {
        assert_eq!(helper_args(None, Some("secret"), true).unwrap(), ["--engine", "local"]);
        assert_eq!(helper_args(Some("local"), Some("secret"), true).unwrap(), ["--engine", "local"]);
    }
    #[test]
    fn cloud_requires_an_explicit_choice_and_key() {
        assert_eq!(helper_args(Some("elevenlabs"), Some(" key "), true).unwrap(),
                   ["--engine", "elevenlabs", "--elevenlabs-key", "key"]);
        assert!(helper_args(Some("elevenlabs"), None, true).unwrap_err().contains("Settings"));
        assert!(helper_args(Some("elevenlabs"), None, false).is_ok());
        assert!(helper_args(Some("auto"), Some("key"), false).is_err());
    }
}
