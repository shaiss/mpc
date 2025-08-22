use ed25519_dalek::SigningKey;
use thiserror::Error;

/// Constants for key serialization
const ED25519_PREFIX: &str = "ed25519:";
const ED25519_KEY_LENGTH: usize = 32;

/// Error type for key parsing
#[derive(Debug, Error)]
pub enum KeyError {
    #[error("Key must start with '{ED25519_PREFIX}'")]
    MissingPrefix,

    #[error("Invalid base58 encoding: {0}")]
    InvalidBase58(#[from] bs58::decode::Error),

    #[error("Invalid key length: expected {expected}, got {actual}")]
    InvalidLength { expected: usize, actual: usize },
}

/// Encode a signing key with the ed25519: prefix
pub fn encode_key(key: &SigningKey) -> String {
    format!(
        "{}{}",
        ED25519_PREFIX,
        bs58::encode(key.to_bytes()).into_string()
    )
}

/// Decode a signing key from a string with ed25519: prefix
pub fn decode_key(s: &str) -> Result<SigningKey, KeyError> {
    let key_str = s
        .strip_prefix(ED25519_PREFIX)
        .ok_or(KeyError::MissingPrefix)?;

    let key_bytes = bs58::decode(key_str)
        .into_vec()
        .map_err(KeyError::InvalidBase58)?;

    let key_array: [u8; ED25519_KEY_LENGTH] =
        key_bytes
            .try_into()
            .map_err(|v: Vec<u8>| KeyError::InvalidLength {
                expected: ED25519_KEY_LENGTH,
                actual: v.len(),
            })?;

    Ok(SigningKey::from_bytes(&key_array))
}

/// Serde module for single ed25519 keys
pub mod ed25519_key {
    use super::{decode_key, encode_key};
    use ed25519_dalek::SigningKey;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(key: &SigningKey, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&encode_key(key))
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<SigningKey, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        decode_key(&s).map_err(|e| serde::de::Error::custom(e.to_string()))
    }
}

/// Serde module for vectors of ed25519 keys
pub mod ed25519_key_vec {
    use super::{decode_key, encode_key};
    use ed25519_dalek::SigningKey;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S>(keys: &[SigningKey], serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let encoded_keys: Vec<String> = keys.iter().map(encode_key).collect();
        encoded_keys.serialize(serializer)
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Vec<SigningKey>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let strings = Vec::<String>::deserialize(deserializer)?;

        strings
            .into_iter()
            .map(|s| decode_key(&s).map_err(|e| serde::de::Error::custom(e.to_string())))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use assert_matches::assert_matches;
    use ed25519_dalek::SigningKey;
    use rand::rngs::OsRng;
    use serde::{Deserialize, Serialize};

    use crate::serialization::{KeyError, decode_key};

    #[test]
    fn test_key_encode_decode_roundtrip() {
        use super::{decode_key, encode_key};

        let key = SigningKey::generate(&mut OsRng);
        let encoded = encode_key(&key);
        let decoded = decode_key(&encoded).unwrap();

        assert_eq!(key.to_bytes(), decoded.to_bytes());
    }

    #[test]
    fn test_key_serialize_deserialize_roundtrip() {
        use super::ed25519_key;

        let key = SigningKey::generate(&mut OsRng);

        #[derive(Clone, Serialize, Deserialize)]
        struct KeyWrapper {
            #[serde(with = "ed25519_key")]
            key: SigningKey,
        }

        let key_wrapper = KeyWrapper { key };
        let key_wrapper_clone = key_wrapper.clone();

        let serialized = serde_json::to_string(&key_wrapper).unwrap();
        let deserialized: KeyWrapper = serde_json::from_str(&serialized).unwrap();

        // Verify the keys are identical
        assert_eq!(
            key_wrapper_clone.key.to_bytes(),
            deserialized.key.to_bytes()
        );
    }

    #[test]
    fn test_invalid_prefix() {
        let result = decode_key("invalid:key");
        assert_matches!(result, Err(KeyError::MissingPrefix));
    }

    #[test]
    fn test_invalid_base58() {
        let result = decode_key("ed25519:invalid!base58");
        assert_matches!(result, Err(KeyError::InvalidBase58(_)));
    }

    #[test]
    fn test_valid_base58() {
        let result = decode_key("ed25519:DXkVZkHd7WUUejCK7i74uAoZWy1w9AZqshhTHxhmqHuB");
        assert_matches!(result, Ok(_));
    }
}
