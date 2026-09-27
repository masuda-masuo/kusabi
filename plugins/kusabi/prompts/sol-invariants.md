1. INV1 — No duplicated source of truth: docstrings, descriptions, schemas, constants or config copied instead of referenced.
2. INV2 — No access to a dependency's private internals (_-prefixed attributes of third-party objects) as a compatibility shim.
3. INV3 — No weakened tests: removed or loosened assertions, added skips, or tests changed to fit the implementation without a stated forced reason.
4. INV4 — No new silent fallback that hides a failure (a green result built by swallowing an error).
5. INV5 — Changes stay inside the declared deliverables; nothing out of scope rides along.
