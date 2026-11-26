import type { FactoryConfig } from "../config/document.js";
import type { ConfigStore } from "../config/store.js";

/** Publishes a version and deploys it to every worker. */
export type Deploy = (id: number) => Promise<{ hermesError?: string }>;

export type Published =
  | { state: "draft"; id: number }
  | { state: "deployed"; id: number; hermesError?: string }
  | { state: "approved"; id: number }
  | { state: "deploy-failed"; id: number };

/**
 * Creates a version from `document` built on `parentId`, then approves and
 * deploys it unless the owner keeps it as a draft. A document the config
 * rejects throws ConfigValidationError before anything is saved.
 */
export async function publishVersion(options: {
  store: ConfigStore;
  deploy: Deploy | undefined;
  document: FactoryConfig;
  message: string;
  parentId: number | undefined;
  deployNow: boolean;
}): Promise<Published> {
  const version = options.store.createVersion({
    document: options.document,
    author: "owner",
    message: options.message,
    ...(options.parentId === undefined ? {} : { parentId: options.parentId }),
  });
  if (!options.deployNow) return { state: "draft", id: version.id };
  options.store.approve(version.id);
  if (options.deploy === undefined) return { state: "approved", id: version.id };
  try {
    const { hermesError } = await options.deploy(version.id);
    return {
      state: "deployed",
      id: version.id,
      ...(hermesError === undefined ? {} : { hermesError }),
    };
  } catch (error) {
    console.error(`Deploying version ${String(version.id)} failed`, error);
    return { state: "deploy-failed", id: version.id };
  }
}
