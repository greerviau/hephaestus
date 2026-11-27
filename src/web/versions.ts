import type { FactoryConfig } from "../config/document.js";
import type { ConfigStore } from "../config/store.js";
import type { BackgroundDeploys } from "./deploys.js";

/** Publishes a version and deploys it to every worker. */
export type Deploy = (id: number) => Promise<{ hermesError?: string }>;

export type Published =
  | { state: "draft"; id: number }
  | { state: "approved"; id: number }
  | { state: "deploying"; id: number };

/**
 * Creates a version from `document` built on `parentId`, then approves it and
 * starts its deploy in the background unless the owner keeps it as a draft.
 * It answers without waiting for the deploy; the sidebar shows how it ends. A
 * document the config rejects throws ConfigValidationError before anything is saved.
 */
export function publishVersion(options: {
  store: ConfigStore;
  deploys: BackgroundDeploys | undefined;
  document: FactoryConfig;
  message: string;
  parentId: number | undefined;
  deployNow: boolean;
}): Published {
  const version = options.store.createVersion({
    document: options.document,
    author: "owner",
    message: options.message,
    ...(options.parentId === undefined ? {} : { parentId: options.parentId }),
  });
  if (!options.deployNow) return { state: "draft", id: version.id };
  options.store.approve(version.id);
  if (options.deploys === undefined) return { state: "approved", id: version.id };
  options.deploys.start(version.id);
  return { state: "deploying", id: version.id };
}

/** What approving a version came to. */
export type Approval = "deploying" | "approved" | "already-deployed";

/**
 * Approves a draft and starts its deploy in the background. Approving again is
 * harmless: a version already approved has its deploy started again, which
 * joins one under way and retries one that failed, and a deployed version is
 * left as it is. Throws when the version is rejected or superseded.
 */
export function approveVersion(
  store: ConfigStore,
  deploys: BackgroundDeploys | undefined,
  id: number,
): Approval {
  const { state } = store.get(id);
  if (state === "deployed") return "already-deployed";
  if (state === "draft") store.approve(id);
  else if (state !== "approved") {
    throw new Error(`Version ${String(id)} is ${state}; only a draft can be approved.`);
  }
  if (deploys === undefined) return "approved";
  deploys.start(id);
  return "deploying";
}

/**
 * Starts the background deploy of an approved or deployed version. Checks
 * first what a deploy would refuse, so a stale version gets its reason now.
 */
export function deployVersion(store: ConfigStore, deploys: BackgroundDeploys, id: number): void {
  const { state } = store.get(id);
  if (state === "approved") store.assertDeployable(id);
  else if (state !== "deployed") {
    throw new Error(`Version ${String(id)} is ${state}; approve it first.`);
  }
  deploys.start(id);
}
