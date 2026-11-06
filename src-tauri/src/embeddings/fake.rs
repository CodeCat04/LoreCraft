//! A deterministic stand-in for a model, available only to tests. It maps words to a few
//! concepts and hashes those, so two texts with no words in common can still be close.

use sha2::{Digest, Sha256};

use super::{normalize, Provider};
use crate::error::{AppError, AppResult};

const DIMENSIONS: usize = 64;
pub const MODEL: &str = "fake:concepts";

const STOP_WORDS: [&str; 12] = ["the", "a", "an", "at", "of", "in", "on", "to", "and", "was", "is", "her"];

fn concept(word: &str) -> &str {
    match word {
        "knight" | "guarded" | "guard" | "sentry" | "watched" => "guard",
        "gate" | "door" | "entrance" | "portal" => "door",
        "northern" | "north" | "boreal" => "north",
        "sea" | "ocean" | "waves" | "tide" | "shore" => "sea",
        "fire" | "flame" | "ember" | "burned" => "fire",
        other => other,
    }
}

pub struct FakeProvider {
    pub cloud: bool,
    pub model: String,
}

impl FakeProvider {
    pub fn vector(text: &str) -> Vec<f32> {
        let mut vector = vec![0.0_f32; DIMENSIONS];
        for word in text.split(|c: char| !c.is_alphanumeric()) {
            let word = word.to_lowercase();
            if word.is_empty() || STOP_WORDS.contains(&word.as_str()) {
                continue;
            }
            let digest = Sha256::digest(concept(&word).as_bytes());
            vector[digest[0] as usize % DIMENSIONS] += if digest[1] & 1 == 0 { 1.0 } else { -1.0 };
        }
        normalize(&mut vector);
        vector
    }
}

impl Provider for FakeProvider {
    fn model_id(&self) -> String {
        self.model.clone()
    }

    fn is_cloud(&self) -> bool {
        self.cloud
    }

    fn batch_size(&self) -> usize {
        4
    }

    fn embed(&self, texts: &[String]) -> AppResult<Vec<Vec<f32>>> {
        if texts.iter().any(|t| t.contains("__fail__")) {
            return Err(AppError::new("SERVER_DOWN", "The fake model was told to fail."));
        }
        Ok(texts.iter().map(|t| Self::vector(t)).collect())
    }
}
