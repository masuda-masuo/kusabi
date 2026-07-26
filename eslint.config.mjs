// Flat config for the kusabi companion scripts.
//
// The rule set is deliberately narrow: this repository wants the classes of
// defect you cannot notice by reading (unused bindings, undefined references,
// unreachable code), not a house style.  Add a rule when something actually
// slips through, not because a preset contains it.
//
// Rules considered and rejected -- recorded so the measurement does not have
// to be repeated every time this file is touched:
//
//   `@eslint/js` (`js.configs.recommended`)
//       Cannot be used.  This repo has no dependencies and no node_modules,
//       so importing it fails with ERR_MODULE_NOT_FOUND.  Keeping the config
//       dependency-free is worth more than the preset; the rules below are
//       the subset of `recommended` that pays for itself here.
//
//   `require-atomic-updates`
//       16 findings, all false.  Every one is `obj.prop = <value computed
//       after an await>` where obj is a single-owner local (`roundRecord` in
//       chain-phases.mjs, `job` and `sessionID` in prompt-execution.mjs).
//       The rule's true-positive shape needs two tasks sharing one object,
//       which cannot happen while a chain runs its jobs sequentially.
//       Worth revisiting if rounds are ever genuinely parallelised.
//
//   Formatting rules / Prettier
//       Different purpose.  Out of scope by decision in #103.
//
// Globals are declared by hand for the same dependency-free reason (the
// `globals` package is not installed).  Add names as the scripts use them.

export default [
  {
    files: ["plugins/kusabi/scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        process: "readonly", console: "readonly", URL: "readonly",
        URLSearchParams: "readonly", setTimeout: "readonly", clearTimeout: "readonly",
        setInterval: "readonly", clearInterval: "readonly", queueMicrotask: "readonly",
        fetch: "readonly", Buffer: "readonly", AbortController: "readonly",
        AbortSignal: "readonly", TextEncoder: "readonly", TextDecoder: "readonly",
        structuredClone: "readonly", globalThis: "readonly", performance: "readonly",
      },
    },
    rules: {
      "no-unused-vars": "error",
      "no-undef": "error",
      "no-unreachable": "error",
      "no-dupe-keys": "error",
      "no-dupe-args": "error",
      "no-dupe-class-members": "error",
      "no-dupe-else-if": "error",
      "no-const-assign": "error",
      "no-func-assign": "error",
      "no-import-assign": "error",
      "no-self-assign": "error",
      "no-unsafe-negation": "error",
      "no-unsafe-optional-chaining": "error",
      "no-constant-condition": "error",
      "no-fallthrough": "error",
      "no-cond-assign": "error",
      "no-empty": "error",
      "no-sparse-arrays": "error",
      "use-isnan": "error",
      "valid-typeof": "error",
    },
  },
];
