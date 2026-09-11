//! Rules that decide what may be written, surfaced and believed.
//!
//! These are the kernel's logic. Each module owns one decision and is pure:
//! no I/O, no model, no ambient time.

pub mod record_identity;
