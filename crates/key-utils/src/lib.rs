pub mod serialization;

// use near_sdk::CurveType;
// use thiserror::Error;
// use threshold_signatures::{frost_ed25519, frost_secp256k1};

// /// Errors that can occur during public key conversion operations
// #[derive(Debug, Error)]
// pub enum PublicKeyConversionError {
//     #[error("Invalid curve type: expected {expected:?}, got {actual:?}")]
//     InvalidCurveType {
//         expected: CurveType,
//         actual: CurveType,
//     },

//     #[error("Invalid key size: expected {expected} bytes, got {actual} bytes")]
//     InvalidKeySize { expected: usize, actual: usize },

//     #[error("Invalid uncompressed point prefix: expected 0x04, got {0:#x}")]
//     InvalidUncompressedPointPrefix(u8),

//     #[error("Failed to create NEAR SDK public key: {0}")]
//     NearSdkCreationFailed(String),

//     #[error("Failed to deserialize key: {0}")]
//     DeserializationFailed(String),

//     #[error("Failed to serialize key: {0}")]
//     SerializationFailed(String),

//     #[error("Invalid encoded point: {0}")]
//     InvalidEncodedPoint(String),

//     #[error("Failed to convert encoded point to affine point")]
//     AffinePointConversionFailed,
// }

// /// Helper functions to convert back and forth foreign public key types
// /// to [`near_sdk::PublicKey`]
// pub trait PublicKeyConversion: Sized {
//     fn to_near_sdk_public_key(&self) -> Result<near_sdk::PublicKey, PublicKeyConversionError>;
//     fn from_near_sdk_public_key(
//         public_key: &near_sdk::PublicKey,
//     ) -> Result<Self, PublicKeyConversionError>;
// }

// /// Extension trait for near_sdk::PublicKey to extract key bytes
// pub trait NearSdkPublicKeyExt {
//     fn key_bytes<const N: usize>(&self) -> Result<[u8; N], PublicKeyConversionError>;
// }

// impl NearSdkPublicKeyExt for near_sdk::PublicKey {
//     fn key_bytes<const N: usize>(&self) -> Result<[u8; N], PublicKeyConversionError> {
//         let bytes = self.as_bytes();
//         // Skip first byte as it represents the curve type
//         let key_data = &bytes[1..];

//         key_data
//             .try_into()
//             .map_err(|_| PublicKeyConversionError::InvalidKeySize {
//                 expected: N,
//                 actual: key_data.len(),
//             })
//     }
// }

// // FROST SECP256K1 implementation
// impl PublicKeyConversion for frost_secp256k1::VerifyingKey {
//     fn to_near_sdk_public_key(&self) -> Result<near_sdk::PublicKey, PublicKeyConversionError> {
//         use k256::elliptic_curve::sec1::ToEncodedPoint;

//         let bytes = self.to_element().to_encoded_point(false).to_bytes();

//         if bytes[0] != 0x04 {
//             return Err(PublicKeyConversionError::InvalidUncompressedPointPrefix(
//                 bytes[0],
//             ));
//         }

//         near_sdk::PublicKey::from_parts(CurveType::SECP256K1, bytes[1..65].to_vec())
//             .map_err(|e| PublicKeyConversionError::NearSdkCreationFailed(e.to_string()))
//     }

//     fn from_near_sdk_public_key(
//         public_key: &near_sdk::PublicKey,
//     ) -> Result<Self, PublicKeyConversionError> {
//         use k256::elliptic_curve::sec1::FromEncodedPoint;
//         use k256::{AffinePoint, EncodedPoint};

//         if public_key.curve_type() != CurveType::SECP256K1 {
//             return Err(PublicKeyConversionError::InvalidCurveType {
//                 expected: CurveType::SECP256K1,
//                 actual: public_key.curve_type(),
//             });
//         }

//         let key_data: [u8; 64] = public_key.key_bytes()?;

//         // Reconstruct uncompressed point with 0x04 prefix
//         let mut bytes = [0u8; 65];
//         bytes[0] = 0x04;
//         bytes[1..65].copy_from_slice(&key_data);

//         let encoded_point = EncodedPoint::from_bytes(bytes)
//             .map_err(|e| PublicKeyConversionError::InvalidEncodedPoint(e.to_string()))?;

//         let affine_point = AffinePoint::from_encoded_point(&encoded_point)
//             .into_option()
//             .ok_or(PublicKeyConversionError::AffinePointConversionFailed)?;

//         Ok(Self::new(affine_point.into()))
//     }
// }

// impl PublicKeyConversion for frost_ed25519::VerifyingKey {
//     fn to_near_sdk_public_key(&self) -> Result<near_sdk::PublicKey, PublicKeyConversionError> {
//         let data = self
//             .serialize()
//             .map_err(|e| PublicKeyConversionError::SerializationFailed(e.to_string()))?;

//         let data: [u8; 32] =
//             data.try_into()
//                 .map_err(|data: Vec<u8>| PublicKeyConversionError::InvalidKeySize {
//                     expected: 32,
//                     actual: data.len(),
//                 })?;

//         near_sdk::PublicKey::from_parts(CurveType::ED25519, data.to_vec())
//             .map_err(|e| PublicKeyConversionError::NearSdkCreationFailed(e.to_string()))
//     }

//     fn from_near_sdk_public_key(
//         public_key: &near_sdk::PublicKey,
//     ) -> Result<Self, PublicKeyConversionError> {
//         if public_key.curve_type() != CurveType::ED25519 {
//             return Err(PublicKeyConversionError::InvalidCurveType {
//                 expected: CurveType::ED25519,
//                 actual: public_key.curve_type(),
//             });
//         }

//         let key_data: [u8; 32] = public_key.key_bytes()?;

//         Self::deserialize(&key_data)
//             .map_err(|e| PublicKeyConversionError::DeserializationFailed(e.to_string()))
//     }
// }

// impl PublicKeyConversion for ed25519_dalek::VerifyingKey {
//     fn to_near_sdk_public_key(&self) -> Result<near_sdk::PublicKey, PublicKeyConversionError> {
//         near_sdk::PublicKey::from_parts(CurveType::ED25519, self.to_bytes().to_vec())
//             .map_err(|e| PublicKeyConversionError::NearSdkCreationFailed(e.to_string()))
//     }

//     fn from_near_sdk_public_key(
//         public_key: &near_sdk::PublicKey,
//     ) -> Result<Self, PublicKeyConversionError> {
//         if public_key.curve_type() != CurveType::ED25519 {
//             return Err(PublicKeyConversionError::InvalidCurveType {
//                 expected: CurveType::ED25519,
//                 actual: public_key.curve_type(),
//             });
//         }

//         let key_data: [u8; 32] = public_key.key_bytes()?;

//         Self::from_bytes(&key_data)
//             .map_err(|e| PublicKeyConversionError::DeserializationFailed(e.to_string()))
//     }
// }

// #[cfg(test)]
// mod test {
//     // mod ecdsa {
//     use super::*;
//     use threshold_signatures::frost_secp256k1::VerifyingKey;

//     #[test]
//     fn check_pubkey_conversion_to_sdk() -> anyhow::Result<()> {
//         use crate::tests::TestGenerators;
//         let x = TestGenerators::new(4, 3)
//             .make_eddsa_keygens()
//             .values()
//             .next()
//             .unwrap()
//             .clone();
//         x.public_key.to_near_sdk_public_key()?;
//         Ok(())
//     }

//     #[test]
//     fn check_pubkey_conversion_from_sdk() -> anyhow::Result<()> {
//         use std::str::FromStr;
//         let near_sdk =
//             near_sdk::PublicKey::from_str("ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp")?;
//         let _ = VerifyingKey::from_near_sdk_public_key(&near_sdk)?;
//         Ok(())
//     }
//     // }
// }
