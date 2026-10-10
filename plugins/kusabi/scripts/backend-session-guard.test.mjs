import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { assertSessionResumable } from "./backend-session-guard.mjs";

describe("assertSessionResumable (Spec 1 shared guard)", () => {
  const backends = ["claude", "agy", "codex"];
  const UUID = "123e4567-e89b-12d3-a456-426614174000";

  for (const backend of backends) {
    describe(`backend: ${backend}`, () => {
      const detail = `A ${backend} session id is passed only when a ${backend} job recorded it.`;
      const tail = `a session id that a ${backend} job on this directory recorded`;

      it("returns cleanly when session is missing or not a non-empty string", () => {
        assert.doesNotThrow(() => assertSessionResumable(undefined, { backend }));
        assert.doesNotThrow(() => assertSessionResumable(null, { backend }));
        assert.doesNotThrow(() => assertSessionResumable("", { backend }));
        assert.doesNotThrow(() => assertSessionResumable(12345, { backend }));
        assert.doesNotThrow(() => assertSessionResumable(false, { backend }));
        assert.doesNotThrow(() => assertSessionResumable({}, { backend }));
      });

      it("rejects opencode ses_* session ids on shape, even when provenance matches", () => {
        const expectedError =
          `opencode session ses_abc123 cannot be resumed on the ${backend} backend — ` +
          `ses_* session ids belong to opencode; run the command without --backend ${backend} ` +
          "(or drop --session / --resume-last)";

        assert.throws(
          () => assertSessionResumable("ses_abc123", { backend, provenance: backend, detail, tail }),
          (err) => {
            assert.equal(err.message, expectedError);
            return true;
          }
        );
        assert.throws(
          () => assertSessionResumable("ses_abc123", { backend, provenance: null, detail, tail }),
          (err) => {
            assert.equal(err.message, expectedError);
            return true;
          }
        );
      });

      it("returns cleanly when provenance matches backend", () => {
        assert.doesNotThrow(() =>
          assertSessionResumable(UUID, {
            backend,
            provenance: backend,
            detail,
            tail,
          })
        );
      });

      it("rejects an unproven session with no kusabi job record", () => {
        const expectedError =
          `session ${UUID} cannot be resumed on the ${backend} backend — ` +
          "no kusabi job record reports it, so its backend cannot be established. " +
          `${detail} Drop --session / --resume-last, or pass ${tail}`;

        assert.throws(
          () => assertSessionResumable(UUID, { backend, provenance: null, detail, tail }),
          (err) => {
            assert.equal(err.message, expectedError);
            return true;
          }
        );
        assert.throws(
          () => assertSessionResumable(UUID, { backend, provenance: undefined, detail, tail }),
          (err) => {
            assert.equal(err.message, expectedError);
            return true;
          }
        );
      });

      it("rejects a session attributed to another backend, naming both", () => {
        const otherBackend = backend === "claude" ? "codex" : "claude";
        const expectedError =
          `session ${UUID} cannot be resumed on the ${backend} backend — ` +
          `the job store attributes it to the ${otherBackend} backend. ` +
          `${detail} Drop --session / --resume-last, or pass ${tail}`;

        assert.throws(
          () => assertSessionResumable(UUID, { backend, provenance: otherBackend, detail, tail }),
          (err) => {
            assert.equal(err.message, expectedError);
            return true;
          }
        );
      });
    });
  }
});
