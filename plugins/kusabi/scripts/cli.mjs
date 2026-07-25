// CLI argument parsing, model resolution, and deny-tools helpers.
// Pure functions — no I/O, no imports from kusabi-companion.mjs.

export const WRITE_TOOL_NAMES = ["bash", "edit", "write", "patch", "task"];

export function implementDenyTools() {
  return Object.fromEntries(
    [...WRITE_TOOL_NAMES, "sunaba_copy_project", "sunaba_copy_file"].map((t) => [t, false]),
  );
}

export function reviewDenyTools() {
  return Object.fromEntries(
    [...WRITE_TOOL_NAMES, "sunaba_copy_project", "sunaba_copy_file", "sunaba_sandbox_issue_write", "sunaba_sandbox_pr_review_write"].map((t) => [t, false]),
  );
}

export function parseArgs(argv) {
  const flags = {};
  const rest = [];
  let literal = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (literal) {
      rest.push(arg);
    } else if (arg === "--") {
      literal = true;
    } else if (
      arg === "--auto" || arg === "--read-only" || arg === "--resume-last" ||
      arg === "--wait" || arg === "--background" || arg === "--keep-serve" || arg === "--help" || arg === "-h" ||
      arg === "--tools"
    ) {
      const key = arg.startsWith("--")
        ? arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
        : arg.slice(1);
      flags[key] = true;
    } else if (arg === "--base" || arg === "--model" || arg === "--agent" || arg === "--session" || arg === "--timeout" || arg === "--deny" || arg === "--watchdog" || arg === "--phase" || arg === "--container" || arg === "--prior" || arg === "--max-rounds" || arg === "--brief-file" || arg === "--last" || arg === "--quote") {
      const flagName = arg.slice(2);
      const val = argv[++i];
      if (val === undefined || (typeof val === "string" && val.startsWith("--"))) {
        throw new Error(`${arg} requires a value`);
      }
      flags[flagName] = val;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown flag: ${arg}`);
    } else {
      rest.push(arg);
    }
  }
  return { flags, text: rest.join(" ").trim() };
}

export function parseModel(value) {
  if (!value) return undefined;
  const idx = value.indexOf("/");
  if (idx < 0) throw new Error(`--model expects provider/model, got: ${value}`);
  const providerID = value.slice(0, idx);
  let modelID = value.slice(idx + 1);
  let variant;
  const vi = modelID.indexOf(":");
  if (vi >= 0) {
    variant = modelID.slice(vi + 1);
    modelID = modelID.slice(0, vi);
    if (!variant) throw new Error(`empty variant in model entry: ${value}`);
  }
  return { providerID, modelID, ...(variant ? { variant } : {}) };
}

export const BUILTIN_DEFAULT_CHAIN = [
  "opencode/deepseek-v4-flash-free",
  "opencode-go/deepseek-v4-flash",
  "opencode-go/deepseek-v4-pro",
];

export function resolveModel({ flag, phase, config }) {
  // Determine the full ordered chain
  let chain;
  if (config?.models?.chain) {
    chain = [...config.models.chain];
  } else {
    chain = [...BUILTIN_DEFAULT_CHAIN];
  }

  // If we have an explicit --model flag, use it directly
  if (flag) {
    return { model: parseModel(flag), chain };
  }

  // Per-phase override
  if (phase && config?.models?.phases?.[phase]) {
    const phaseChain = config.models.phases[phase];
    const first = phaseChain[0];
    if (first) {
      return { model: parseModel(first), chain: phaseChain };
    }
  }

  // Global chain first entry
  const firstGlobal = chain[0];
  if (firstGlobal) {
    return { model: parseModel(firstGlobal), chain };
  }

  // No model resolved
  return { model: undefined, chain };
}
