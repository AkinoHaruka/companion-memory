//! Domain vocabulary and the types the rules operate on.
//!
//! See DESIGN.md §3. `predicate_keys` owns which predicate keys exist;
//! `predicates` owns what each one means; `types` owns the record model.

pub mod predicate_keys;
pub mod predicates;
pub mod types;
