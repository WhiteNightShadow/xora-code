import type {
  PolicyContext,
  PolicyDecision,
  PolicyEvaluation,
  PolicyRule,
  PolicyRuleMatch,
  PolicySubject,
} from "./dto.js";

const EFFECT_PRECEDENCE: Record<PolicyDecision, number> = {
  allow: 1,
  ask: 2,
  deny: 3,
};

function escapeRegex(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

/**
 * Small, deterministic glob matcher. `*` does not cross `/`; `**` does.
 * Matching is case-sensitive so policy behavior does not vary by host OS.
 */
export function matchesGlob(value: string, glob: string): boolean {
  let expression = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index]!;
    if (character === "*") {
      if (glob[index + 1] === "*") {
        if (glob[index + 2] === "/") {
          // A globstar directory also matches zero directories.
          expression += "(?:.*/)?";
          index += 2;
        } else {
          expression += ".*";
          index += 1;
        }
      } else {
        expression += "[^/]*";
      }
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += escapeRegex(character);
    }
  }
  expression += "$";
  return new RegExp(expression, "u").test(value.replaceAll("\\", "/"));
}

function matchesAny(value: string | undefined, patterns: string[] | undefined): boolean {
  if (!patterns) return true;
  if (value === undefined) return false;
  return patterns.some((pattern) => matchesGlob(value, pattern));
}

function includesAny<T extends string>(value: T | undefined, choices: T[] | undefined): boolean {
  if (!choices) return true;
  return value !== undefined && choices.includes(value);
}

function commandText(subject: PolicySubject): string | undefined {
  if (!subject.command) return undefined;
  // This is a stable policy representation, not a shell command to execute.
  return [subject.command.program, ...subject.command.args].join(" ");
}

function ruleMatches(
  match: PolicyRuleMatch,
  subject: PolicySubject,
  context: PolicyContext,
): boolean {
  return (
    includesAny(subject.operation, match.operations) &&
    includesAny(subject.toolKind, match.toolKinds) &&
    matchesAny(subject.toolName, match.toolNames) &&
    matchesAny(subject.path?.replaceAll("\\", "/"), match.pathGlobs) &&
    matchesAny(commandText(subject), match.commandGlobs) &&
    matchesAny(subject.mcpServer, match.mcpServers) &&
    matchesAny(subject.networkHost, match.networkHosts) &&
    includesAny(subject.risk, match.risks) &&
    matchesAny(context.workspaceRoot?.replaceAll("\\", "/"), match.workspaceGlobs) &&
    includesAny(context.sessionId, match.sessionIds) &&
    includesAny(context.providerProfileId, match.providerProfileIds)
  );
}

export interface PolicyEngineOptions {
  defaultDecision?: PolicyDecision;
}

/** Pure policy evaluation shared by all agent runtimes. */
export class PolicyEngine {
  readonly #rules: readonly PolicyRule[];
  readonly #defaultDecision: PolicyDecision;

  constructor(rules: readonly PolicyRule[], options: PolicyEngineOptions = {}) {
    const ids = new Set<string>();
    for (const rule of rules) {
      if (!rule.id || ids.has(rule.id)) {
        throw new Error(`Policy rule ids must be unique and non-empty: ${rule.id}`);
      }
      ids.add(rule.id);
    }
    this.#rules = rules.map((rule) => ({ ...rule, match: { ...rule.match } }));
    this.#defaultDecision = options.defaultDecision ?? "ask";
  }

  evaluate(subject: PolicySubject, context: PolicyContext = {}): PolicyEvaluation {
    const matched = this.#rules.filter(
      (rule) => rule.enabled !== false && ruleMatches(rule.match, subject, context),
    );

    if (matched.length === 0) {
      return {
        decision: this.#defaultDecision,
        matchedRuleIds: [],
        reason: `No rule matched; using default ${this.#defaultDecision}.`,
      };
    }

    const strongest = Math.max(...matched.map((rule) => EFFECT_PRECEDENCE[rule.effect]));
    const decidingRules = matched.filter(
      (rule) => EFFECT_PRECEDENCE[rule.effect] === strongest,
    );
    const decision = decidingRules[0]!.effect;
    const explicitReasons = decidingRules.flatMap((rule) => (rule.reason ? [rule.reason] : []));

    return {
      decision,
      matchedRuleIds: matched.map((rule) => rule.id),
      reason:
        explicitReasons.join("; ") ||
        `Matched ${decidingRules.map((rule) => rule.id).join(", ")}; ${decision} takes precedence.`,
    };
  }
}
