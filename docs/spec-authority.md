# Normative document authority

This package has been audited against several documents written at different times for different purposes. They are not
peers. When two disagree the higher row wins, and only the top two rows are requirement sources.

| Rank | Document | Role |
|---|---|---|
| 1 | [v3.1-decision-semantics.md](v3.1-decision-semantics.md) and later explicit rulings | Latest semantic revision; overrides the V3 specification wherever they disagree |
| 2 | Riko Memory V3 Master Specification | The main specification; its Must statements are the acceptance baseline |
| 3 | Riko Memory Execution Contract v2 | Absorbed into V3 Part II; historical reference that adds no requirements |
| 4 | Riko Memory Final Architecture Implementation Plan | Historical design material |
| 5 | GPT-5.6 Sol initial concept document | Exploration and decision input, not an acceptance specification |

Two further documents describe and record the implementation, and are deliberately not requirement sources:

| Document | Role |
|---|---|
| [README.md](../README.md) and README.zh.md | Current implementation description. It states what the runtime does; it creates no requirement, and it must not claim coverage that the evidence does not back. |
| [memory-v3-progress.md](memory-v3-progress.md) | Evidence ledger. It records which requirements have executed evidence. |

## What counts as a requirement

Only the top two ranks produce requirements. Inside them the level is the language level of the individual statement, not
the chapter it sits in.

- **Must** statements are tracked to a runtime implementation and an executed test. These include the V3 system
  invariants, the write-loop and read-loop boundaries, the evidence/candidate/canonical/observation layering, the
  temporal and canonical semantics, Resident correctness, query-time recall wiring, recall eligibility, the mention gate,
  the separation of memory data from instructions, activation-versus-truth, the suppress/forget/purge distinction, scope
  and secret isolation, derived-index rebuild and invalidation semantics, migration safety, V3 Part II, and each phase's
  required tests and exit gates.
- **Conditional** capabilities — embedding provider, vector index, graph, observation, purge — become requirements the
  moment a phase claims them implemented. While one is deferred the only obligation is that its status reads
  `deferred` and that the README does not claim it.
- **Exploratory** material is not a requirement. Recommendation-flavoured text — suggested constants, initial latency
  targets, illustrative TypeScript field names, RRF constants, Resident budget percentages, benchmark targets,
  commit-splitting advice — is reference design. An implementation that departs from a suggested value and passes its
  evaluation is not in breach.

The V3 Part III prompts translate Parts I and II into working instructions for a coding agent. They add no requirement: a
rule that appears only in a prompt is execution guidance.

The appendices carry mixed weight. The companion-evaluation scenarios that state required behaviour are normative; the
metric categories in the metrics appendix are normative while their target values are not; the open-source references,
interface listings, trace examples, commit strategy and project-plan material are not.

## Status vocabulary

`verified` alone is too coarse. Each requirement records the strongest state its evidence supports.

| State | Meaning |
|---|---|
| `deferred` | Not implemented, and not claimed by the README |
| `implemented_unverified` | Code exists; no executed test establishes the behaviour |
| `verified_contract` | Unit or integration tests establish the component behaviour |
| `verified_e2e` | A real Loader or end-to-end test establishes the delivered behaviour |
| `validated_empirically` | A real provider or model measurement establishes the effect |

Evidence is graded the same way — `static`, `unit`, `integration`, `loader_e2e`, `empirical`, `chaos` — and each
requirement declares the minimum grade it accepts. A cheaper test cannot stand in for a stronger claim.
