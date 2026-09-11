//! Companion memory kernel.
//!
//! Pure decision logic shared by every host adapter. No I/O, no LLM, no host
//! imports, and no ambient time — callers pass `now` in. See DESIGN.md §0.1 and
//! §8 for why this boundary is load-bearing: it is what makes the kernel
//! exhaustively testable, and it is why the TypeScript host adapter can be
//! replaced without touching a rule.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod domain;
pub mod rules;
