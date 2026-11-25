export const PRESET_NAMES = ["yolo", "standard", "strict"] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

export interface PolicySettings {
  /** Hephaestus merges a PR itself once the gates pass. */
  autoMerge: boolean;
  /** An approving review from a different provider on the head commit is required. */
  requireReview: boolean;
  /** Every merge waits for the owner. */
  ownerApprovesEveryMerge: boolean;
  /** A PR touching a matching path needs the owner before it merges. */
  escalationPaths: string[];
  maxReviewRounds: number;
  /** Open factory-filed issues awaiting work; more wait for the owner. */
  openIssueCap: number;
  /** Hephaestus reverts a factory merge whose checks fail on the default branch. */
  autoRevert: boolean;
  /** A PR may merge with no checks at all, for a repo without CI. */
  allowNoChecks: boolean;
}

export const POLICY_SETTING_NAMES = [
  "autoMerge",
  "requireReview",
  "ownerApprovesEveryMerge",
  "escalationPaths",
  "maxReviewRounds",
  "openIssueCap",
  "autoRevert",
  "allowNoChecks",
] as const satisfies readonly (keyof PolicySettings)[];

export interface Policy {
  preset: PresetName;
  overrides: Partial<PolicySettings>;
}

const COMMON = {
  maxReviewRounds: 2,
  openIssueCap: 5,
  autoRevert: true,
  allowNoChecks: false,
} as const;

export const PRESETS: Record<PresetName, PolicySettings> = {
  yolo: {
    ...COMMON,
    autoMerge: true,
    requireReview: false,
    ownerApprovesEveryMerge: false,
    escalationPaths: [],
  },
  standard: {
    ...COMMON,
    autoMerge: true,
    requireReview: true,
    ownerApprovesEveryMerge: false,
    escalationPaths: [".github/workflows/**"],
  },
  strict: {
    ...COMMON,
    autoMerge: false,
    requireReview: true,
    ownerApprovesEveryMerge: true,
    escalationPaths: [".github/workflows/**"],
  },
};

/** The preset's settings with the project's overrides applied on top. */
export function resolvePolicy(policy: Policy): PolicySettings {
  return { ...structuredClone(PRESETS[policy.preset]), ...structuredClone(policy.overrides) };
}
