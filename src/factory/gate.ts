import type { PolicySettings } from "../config/policy.js";
import type { CheckState } from "./github.js";

export interface ImplementResult {
  status: "done" | "blocked";
  pr?: number;
  headSha?: string;
  reason?: string;
}

export interface ReviewResult {
  verdict: "approve" | "changes";
  headSha: string;
  findings: string;
}

const SHA = /^[0-9a-f]{40}$/;

/** The JSON in the last ```hephaestus-result block of a message, or undefined. */
function lastBlock(text: string): Record<string, unknown> | undefined {
  const blocks = [...text.matchAll(/```hephaestus-result\s*\n([\s\S]*?)```/g)];
  const body = blocks.at(-1)?.[1];
  if (body === undefined) return undefined;
  try {
    const value = JSON.parse(body) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** An implement thread's result. A malformed block counts as no result. */
export function parseImplementResult(text: string): ImplementResult | undefined {
  const block = lastBlock(text);
  if (block === undefined) return undefined;
  if (block.status === "blocked") {
    return {
      status: "blocked",
      reason: typeof block.reason === "string" ? block.reason : "no reason given",
    };
  }
  if (block.status !== "done") return undefined;
  if (!Number.isInteger(block.pr) || (block.pr as number) <= 0) return undefined;
  if (typeof block.headSha !== "string" || !SHA.test(block.headSha)) return undefined;
  return { status: "done", pr: block.pr as number, headSha: block.headSha };
}

/** A review thread's verdict. A malformed block counts as no result. */
export function parseReviewResult(text: string): ReviewResult | undefined {
  const block = lastBlock(text);
  if (block === undefined) return undefined;
  if (block.verdict !== "approve" && block.verdict !== "changes") return undefined;
  if (typeof block.headSha !== "string" || !SHA.test(block.headSha)) return undefined;
  const findings = typeof block.findings === "string" ? block.findings : "";
  return { verdict: block.verdict, headSha: block.headSha, findings };
}

/**
 * Whether `path` matches a glob: `**` matches any run of path segments, `*`
 * anything within one segment, and `?` one character. A pattern without a
 * slash also matches the file name anywhere.
 */
export function matchesGlob(pattern: string, path: string): boolean {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] ?? "";
    if (char === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") {
        i++;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const expression = new RegExp(`^${source}$`);
  if (expression.test(path)) return true;
  return !pattern.includes("/") && expression.test(path.split("/").at(-1) ?? "");
}

export interface GateInput {
  policy: PolicySettings;
  checks: CheckState;
  failedChecks: string[];
  files: string[];
  /** Every check on the head, as `check:<name>` or `status:<context>`. */
  checkIds?: string[];
  /** False when the file list is incomplete; the escalation paths then cannot be checked. */
  filesComplete?: boolean;
  /** A review thread approved this exact head commit. */
  approvedAtHead: boolean;
  /** The owner approved this exact head commit on the dashboard. */
  ownerApprovedAtHead: boolean;
}

export type GateDecision =
  | { action: "merge" }
  | { action: "wait"; reason: string }
  | { action: "escalate"; to: "lead" | "owner"; reason: string };

/**
 * How each reason the gate gives for an escalation that follows the checks
 * starts. The gate reaches these only once the head commit's checks passed,
 * or none ran in a project whose policy allows that, so a page can tell from
 * a stored reason that the checks no longer hold the merge back.
 */
export const PAST_CHECKS = {
  noReview: "no approving review for the head commit",
  filesIncomplete: "the PR changes more files than GitHub lists",
  escalationPath: "the PR touches an escalation path",
  ownerApproves: "the policy has the owner approve every merge",
  noAutoMerge: "the policy does not allow auto-merge",
} as const;

/** Decides, in code, whether Hephaestus may merge a PR now. */
export function decideMerge(input: GateInput): GateDecision {
  const { policy } = input;
  if (input.checks === "pending") return { action: "wait", reason: "checks are running" };
  if (input.checks === "none" && !policy.allowNoChecks) {
    return { action: "wait", reason: "no checks have run on the head commit yet" };
  }
  const ids = input.checkIds ?? [];
  // A bare name means a check run; `status:<context>` names a commit status.
  const absent = policy.requiredChecks.filter(
    (name) => !ids.includes(name.includes(":") ? name : `check:${name}`),
  );
  if (input.checks !== "failure" && absent.length > 0) {
    return { action: "wait", reason: `required checks have not run: ${absent.join(", ")}` };
  }
  if (input.checks === "failure") {
    return {
      action: "escalate",
      to: "lead",
      reason: `checks failed on the head commit: ${input.failedChecks.join(", ") || "unknown"}`,
    };
  }
  if (policy.requireReview && !input.approvedAtHead) {
    return {
      action: "escalate",
      to: "lead",
      reason: PAST_CHECKS.noReview,
    };
  }
  if (input.ownerApprovedAtHead) return { action: "merge" };
  if (input.filesComplete === false) {
    return {
      action: "escalate",
      to: "owner",
      reason: `${PAST_CHECKS.filesIncomplete}, so its escalation paths cannot be checked`,
    };
  }
  const touched = input.files.filter((file) =>
    policy.escalationPaths.some((pattern) => matchesGlob(pattern, file)),
  );
  if (touched.length > 0) {
    return {
      action: "escalate",
      to: "owner",
      reason: `${PAST_CHECKS.escalationPath}: ${touched.join(", ")}`,
    };
  }
  if (policy.ownerApprovesEveryMerge) {
    return {
      action: "escalate",
      to: "owner",
      reason: PAST_CHECKS.ownerApproves,
    };
  }
  if (!policy.autoMerge) {
    return { action: "escalate", to: "owner", reason: PAST_CHECKS.noAutoMerge };
  }
  return { action: "merge" };
}
