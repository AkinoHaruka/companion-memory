/**
 * Evidence admissibility tests.
 *
 * One group per invariant, so a regression names the rule it broke:
 *   I1 — assistant evidence never supports an inference about the user
 *   I8 — `inference_allowed` gates the predicate
 *   I5 — an inference with no live support collapses
 *
 * Fixtures are built inline and kept minimal on purpose. Every field a rule
 * could accidentally consult — `importance`, `provenance.confidence`,
 * `semanticRole` — is present with a value that would *change the answer* if
 * the rule read it by mistake, so a wrong implementation fails an assertion
 * instead of passing by luck.
 */

import { describe, expect, it } from "vitest";

import { MISC_PREDICATE } from "../domain/predicate-keys.js";
import { inferenceAllowedFor, requireSpec } from "../domain/predicates.js";
import type {
  Claim,
  Episode,
  EvidenceRef,
  RelationshipScope,
  Speaker,
} from "../domain/types.js";
import {
  isCollapsed,
  liveCounterEvidence,
  liveEvidence,
  maySupportUserInference,
  verifyInferenceEvidence,
  type EvidenceResolution,
} from "./evidence.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SCOPE: RelationshipScope = {
  serviceId: "svc.test",
  ownerUserId: "user.test",
  companionProfileId: "companion.test",
};

const T0 = "2024-01-01T00:00:00.000Z";

/** A `Claim` with every required field and nothing else. */
function makeClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: "claim-1",
    scope: SCOPE,
    predicate: "identity.occupation",
    value: "designer",
    validFrom: T0,
    status: "active",
    sourceRefs: [],
    // Deliberately confident: if any rule consulted provenance, a 0.99 would
    // be the value that unlocks it.
    provenance: { confidence: 0.99, createdAt: T0 },
    importance: 0.9,
    recallCount: 3,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

/** An `Episode` with every required field and nothing else. */
function makeEpisode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: "episode-1",
    scope: SCOPE,
    occurredFrom: T0,
    narrative: "user: I'm moving to Lisbon.\ncompanion: That is a big change.",
    participants: [{ role: "user" }, { role: "companion" }],
    sourceRefs: [],
    status: "active",
    importance: 0.5,
    recallCount: 0,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

/**
 * Refs always carry a realistic `semanticRole`, including for assistant
 * speakers: the point of I1 is that `assistant_action` is not a loophole, and
 * a fixture that omitted the role would not test that.
 */
function refTo(
  sourceType: EvidenceRef["sourceType"],
  sourceId: string,
  speaker: Speaker = "user",
): EvidenceRef {
  return {
    sourceType,
    sourceId,
    speaker,
    semanticRole: speaker === "assistant" ? "assistant_action" : "user_assertion",
  };
}

const claimRef = (id: string, speaker: Speaker = "user"): EvidenceRef =>
  refTo("claim", id, speaker);
const episodeRef = (id: string, speaker: Speaker = "user"): EvidenceRef =>
  refTo("episode", id, speaker);
const messageRef = (id: string, speaker: Speaker = "user"): EvidenceRef =>
  refTo("message", id, speaker);

function resolution(
  options: {
    claims?: readonly Claim[];
    episodes?: readonly Episode[];
    suppressed?: readonly string[];
  } = {},
): EvidenceResolution {
  return {
    claims: new Map((options.claims ?? []).map((claim) => [claim.id, claim])),
    episodes: new Map((options.episodes ?? []).map((episode) => [episode.id, episode])),
    suppressed: new Set(options.suppressed ?? []),
  };
}

// ---------------------------------------------------------------------------
// I1 — assistant evidence never supports an inference about the user
// ---------------------------------------------------------------------------

describe("I1 — the assistant's own speech is not evidence about the user", () => {
  it("refuses an assistant ref even when its claim is strongly inference-allowed", () => {
    const claim = makeClaim({ id: "c-occupation", predicate: "identity.occupation" });
    // The registry genuinely allows inference here, so the refusal below can
    // only be coming from the speaker rule.
    expect(requireSpec(claim.predicate).inference_allowed).toBe(true);
    expect(claim.provenance.confidence).toBeGreaterThan(0.9);

    const assistant = claimRef(claim.id, "assistant");
    expect(assistant.semanticRole).toBe("assistant_action");

    const res = resolution({ claims: [claim] });
    expect(maySupportUserInference(assistant, res)).toEqual({
      code: "assistant_speaker",
      ref: assistant,
    });

    // Same claim, same confidence, user speaker: admissible.
    expect(maySupportUserInference(claimRef(claim.id, "user"), res)).toBeNull();
  });

  it("has no exemption by source layer", () => {
    const res = resolution({
      claims: [makeClaim({ id: "c1" })],
      episodes: [makeEpisode({ id: "e1" })],
    });

    for (const ref of [
      claimRef("c1", "assistant"),
      episodeRef("e1", "assistant"),
      messageRef("m1", "assistant"),
    ]) {
      expect(maySupportUserInference(ref, res)).toEqual({ code: "assistant_speaker", ref });
    }
  });

  it("refuses an assistant ref even when its record cannot be found", () => {
    const ref = claimRef("missing", "assistant");
    // Speaker first, resolution second: a dangling assistant ref is still
    // assistant speech, and the gate reports the stronger reason.
    expect(maySupportUserInference(ref, resolution({ suppressed: ["missing"] }))).toEqual({
      code: "assistant_speaker",
      ref,
    });
  });
});

// ---------------------------------------------------------------------------
// I8 — inference_allowed gates the predicate
// ---------------------------------------------------------------------------

describe("I8 — the predicate decides whether it may feed an inference", () => {
  it("names a boundary claim as a constraint, not as evidence", () => {
    const claim = makeClaim({
      id: "c-boundary",
      predicate: "boundary.topic_avoid",
      value: "do not bring up the divorce",
    });
    const ref = claimRef(claim.id);

    // The registry also forbids it — but the boundary diagnosis is the one a
    // reviewer needs, so it must win over the generic disallow.
    expect(inferenceAllowedFor(claim.predicate)).toBe(false);
    expect(maySupportUserInference(ref, resolution({ claims: [claim] }))).toEqual({
      code: "boundary_is_constraint",
      ref,
      predicate: "boundary.topic_avoid",
    });
  });

  it("treats every boundary predicate as a constraint", () => {
    const predicates = [
      "boundary.prohibition",
      "boundary.safety_limit",
      "boundary.privacy_rule",
      "boundary.refusal",
      "boundary.topic_avoid",
      "boundary.soft_preference",
    ];

    for (const predicate of predicates) {
      const claim = makeClaim({ id: `c-${predicate}`, predicate });
      const ref = claimRef(claim.id);
      expect(maySupportUserInference(ref, resolution({ claims: [claim] }))).toEqual({
        code: "boundary_is_constraint",
        ref,
        predicate,
      });
    }
  });

  it("refuses the misc escape hatch", () => {
    const claim = makeClaim({ id: "c-misc", predicate: MISC_PREDICATE, value: "something odd" });
    const ref = claimRef(claim.id);
    expect(maySupportUserInference(ref, resolution({ claims: [claim] }))).toEqual({
      code: "inference_disallowed",
      ref,
      predicate: MISC_PREDICATE,
    });
  });

  it("refuses a predicate whose registry row forbids inference", () => {
    const claim = makeClaim({ id: "c-age", predicate: "identity.age", value: 1988 });
    const ref = claimRef(claim.id);
    expect(inferenceAllowedFor(claim.predicate)).toBe(false);
    expect(maySupportUserInference(ref, resolution({ claims: [claim] }))).toEqual({
      code: "inference_disallowed",
      ref,
      predicate: "identity.age",
    });
  });

  it("admits a claim under an inference-allowed predicate", () => {
    const claim = makeClaim({ id: "c-occupation", predicate: "identity.occupation" });
    expect(inferenceAllowedFor(claim.predicate)).toBe(true);
    expect(maySupportUserInference(claimRef(claim.id), resolution({ claims: [claim] }))).toBeNull();
  });

  it("fails closed on a predicate the registry does not know", () => {
    const claim = makeClaim({ id: "c-unknown", predicate: "vibes.unregistered" });
    const ref = claimRef(claim.id);
    expect(maySupportUserInference(ref, resolution({ claims: [claim] }))).toEqual({
      code: "inference_disallowed",
      ref,
      predicate: "vibes.unregistered",
    });
  });

  it("has no predicate to check for episode and message refs", () => {
    const res = resolution({ episodes: [makeEpisode({ id: "e1" })] });
    expect(maySupportUserInference(episodeRef("e1"), res)).toBeNull();
    expect(maySupportUserInference(messageRef("m1"), res)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Resolution failures
// ---------------------------------------------------------------------------

describe("resolution failures", () => {
  it("reports unknown_source for a claim id that is not in the map", () => {
    const ref = claimRef("never-written");
    expect(maySupportUserInference(ref, resolution())).toEqual({ code: "unknown_source", ref });
  });

  it("reports source_type_mismatch when the id is known under another layer", () => {
    const ref = claimRef("shared-id");
    const res = resolution({ episodes: [makeEpisode({ id: "shared-id" })] });
    expect(maySupportUserInference(ref, res)).toEqual({
      code: "source_type_mismatch",
      ref,
      expected: "claim",
    });

    const reverse = episodeRef("only-a-claim");
    const reverseRes = resolution({ claims: [makeClaim({ id: "only-a-claim" })] });
    expect(maySupportUserInference(reverse, reverseRes)).toEqual({
      code: "source_type_mismatch",
      ref: reverse,
      expected: "episode",
    });
  });

  it("reports suppressed_source for a live record the user asked to forget", () => {
    const claim = makeClaim({ id: "c-forgotten" });
    const ref = claimRef(claim.id);
    expect(
      maySupportUserInference(ref, resolution({ claims: [claim], suppressed: [claim.id] })),
    ).toEqual({ code: "suppressed_source", ref });
  });

  it("reports unknown_source ahead of suppressed_source for an absent record", () => {
    const ref = claimRef("gone");
    // The id is in the suppression set but the claim map has nothing to
    // suppress; the report must not credit suppression with the work.
    expect(maySupportUserInference(ref, resolution({ suppressed: ["gone"] }))).toEqual({
      code: "unknown_source",
      ref,
    });
  });
});

// ---------------------------------------------------------------------------
// verifyInferenceEvidence — the audit
// ---------------------------------------------------------------------------

describe("verifyInferenceEvidence", () => {
  it("passes a support set with nothing wrong with it", () => {
    const claim = makeClaim({ id: "c-occupation", predicate: "identity.occupation" });
    const episode = makeEpisode({ id: "e1" });
    const res = resolution({ claims: [claim], episodes: [episode] });

    const result = verifyInferenceEvidence([claimRef(claim.id), episodeRef(episode.id)], res);
    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("returns all violations for a support set with two different problems", () => {
    const occupation = makeClaim({ id: "c-occupation", predicate: "identity.occupation" });
    const boundary = makeClaim({ id: "c-boundary", predicate: "boundary.topic_avoid" });
    const res = resolution({ claims: [occupation, boundary] });

    const result = verifyInferenceEvidence(
      [claimRef(occupation.id), claimRef(occupation.id, "assistant"), claimRef(boundary.id)],
      res,
    );

    expect(result.valid).toBe(false);
    expect(result.violations.map((violation) => violation.code)).toEqual([
      "assistant_speaker",
      "boundary_is_constraint",
    ]);
    expect(result.violations.map((violation) => violation.ref.sourceId)).toEqual([
      occupation.id,
      boundary.id,
    ]);
  });

  it("keeps scanning after the first bad ref", () => {
    const res = resolution();
    const result = verifyInferenceEvidence(
      [claimRef("missing-1"), messageRef("m1"), claimRef("missing-2")],
      res,
    );
    expect(result.violations.map((violation) => violation.code)).toEqual([
      "unknown_source",
      "unknown_source",
    ]);
    expect(result.violations[0]?.ref.sourceId).toBe("missing-1");
    expect(result.violations[1]?.ref.sourceId).toBe("missing-2");
  });

  it("reports every rule one ref breaks, where the gate reports only the first", () => {
    const boundary = makeClaim({ id: "c-boundary", predicate: "boundary.topic_avoid" });
    const ref = claimRef(boundary.id, "assistant");
    const res = resolution({ claims: [boundary] });

    // Assistant speech about a boundary is two distinct failures and the audit
    // must say so; the write-path gate stays cheap and stops at the first.
    expect(verifyInferenceEvidence([ref], res).violations.map((violation) => violation.code)).toEqual(
      ["assistant_speaker", "boundary_is_constraint"],
    );
    expect(maySupportUserInference(ref, res)).toEqual({ code: "assistant_speaker", ref });
  });

  it("treats an empty support set as valid for the audit and collapsed for I5", () => {
    const res = resolution();
    // "Nothing is wrong with nothing" — validity is a property of the refs
    // present. Whether an inference with no support may exist at all is I5's
    // question, and it is answered by `isCollapsed`, not here.
    expect(verifyInferenceEvidence([], res)).toEqual({ valid: true, violations: [] });
    expect(isCollapsed([], res)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// I5 — an unsupported inference collapses
// ---------------------------------------------------------------------------

describe("I5 — an inference with no live support collapses", () => {
  it("collapses with an empty support set", () => {
    expect(isCollapsed([], resolution())).toBe(true);
  });

  it("collapses when every support ref is suppressed", () => {
    const claims = [
      makeClaim({ id: "c1" }),
      makeClaim({ id: "c2", predicate: "identity.role", value: "mentor" }),
      makeClaim({ id: "c3", predicate: "goal.aspiration", value: "write a novel" }),
    ];
    const support = claims.map((claim) => claimRef(claim.id));
    const res = resolution({ claims, suppressed: ["c1", "c2", "c3"] });

    expect(isCollapsed(support, res)).toBe(true);
  });

  it("collapses when every support ref is unresolvable", () => {
    const support = [claimRef("missing-1"), episodeRef("missing-2")];
    expect(isCollapsed(support, resolution())).toBe(true);
  });

  it("stays live while at least one support ref survives", () => {
    const claims = [
      makeClaim({ id: "c1" }),
      makeClaim({ id: "c2", predicate: "identity.role", value: "mentor" }),
    ];
    const support = [claimRef("c1"), claimRef("c2")];
    const res = resolution({ claims, suppressed: ["c1"] });

    expect(isCollapsed(support, res)).toBe(false);
  });

  it("stays live on a support ref that is admissible but not yet resolvable", () => {
    // A message ref resolves by construction: the host owns the message log.
    // Only the suppression set can retire it.
    expect(isCollapsed([messageRef("m1")], resolution())).toBe(false);
    expect(isCollapsed([messageRef("m1")], resolution({ suppressed: ["m1"] }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Liveness filters
// ---------------------------------------------------------------------------

describe("liveEvidence", () => {
  it("drops suppressed and unresolvable refs but keeps the rest", () => {
    const claims = [
      makeClaim({ id: "c1" }),
      makeClaim({ id: "c2", predicate: "identity.role", value: "mentor" }),
      makeClaim({ id: "c-boundary", predicate: "boundary.topic_avoid" }),
    ];
    const episodes = [makeEpisode({ id: "e1" })];
    const res = resolution({ claims, episodes, suppressed: ["c2", "m1"] });

    const live = liveEvidence(
      [
        claimRef("c1"),
        claimRef("c2"),
        claimRef("c-boundary"),
        episodeRef("e1"),
        claimRef("missing-claim"),
        episodeRef("missing-episode"),
        messageRef("m1"),
      ],
      res,
    );

    // Liveness is a resolution filter, not an admissibility filter: the
    // boundary claim survives here and is refused by the gate instead.
    expect(live.map((ref) => `${ref.sourceType}:${ref.sourceId}`)).toEqual([
      "claim:c1",
      "claim:c-boundary",
      "episode:e1",
    ]);
  });

  it("returns an empty list rather than throwing on a fully suppressed set", () => {
    const claims = [makeClaim({ id: "c1" })];
    expect(liveEvidence([claimRef("c1")], resolution({ claims, suppressed: ["c1"] }))).toEqual([]);
    expect(liveEvidence([], resolution())).toEqual([]);
  });
});

describe("liveCounterEvidence", () => {
  it("keeps a live user-speaker ref and drops a suppressed one", () => {
    const claims = [
      makeClaim({ id: "c1" }),
      makeClaim({ id: "c2", predicate: "identity.role", value: "mentor" }),
    ];
    const kept = claimRef("c1");
    const dropped = claimRef("c2");
    const res = resolution({ claims, suppressed: ["c2"] });

    expect(liveCounterEvidence([kept, dropped], res)).toEqual([kept]);
  });

  it("keeps counter-evidence the support rules would refuse", () => {
    // A boundary claim cannot support a belief, but it can contradict one —
    // "I never work weekends" is exactly what a counter-example looks like.
    const boundary = makeClaim({ id: "c-boundary", predicate: "boundary.topic_avoid" });
    const counter = [claimRef(boundary.id)];
    const res = resolution({ claims: [boundary] });

    expect(liveCounterEvidence(counter, res)).toEqual(counter);
    expect(maySupportUserInference(counter[0]!, res)).toEqual({
      code: "boundary_is_constraint",
      ref: counter[0],
      predicate: "boundary.topic_avoid",
    });
  });

  it("drops an unresolvable counter-example", () => {
    expect(liveCounterEvidence([claimRef("missing")], resolution())).toEqual([]);
  });
});
