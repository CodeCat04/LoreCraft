//! The sentence encoder behind search by meaning: a BERT model such as all-MiniLM-L6-v2,
//! its tokenizer and the arithmetic to run it on a CPU.
//!
//! This is a crate of its own, with no dependencies, for one reason: it is only usable when
//! optimized. `Cargo.toml` compiles it at full optimization even in debug builds, which
//! takes seconds, while the app stays fast to rebuild. Everything here is plain Rust, so
//! there is no runtime to install and nothing that can fail to link.

mod bert;
mod tokenizer;

pub use bert::{score_all, Bert, Pooling, Tensor};
pub use tokenizer::Tokenizer;
