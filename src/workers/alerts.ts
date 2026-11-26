import type { ExtraAlert } from "../messaging.js";
import type { WorkerView } from "./manager.js";

export type WorkerAlertView = Pick<
  WorkerView,
  "environmentId" | "label" | "claude" | "codex" | "blocker" | "ownerStep"
>;

/**
 * The steps workers wait on the owner for, as chat alerts. A worker busy with
 * a step of Hephaestus's own, such as a deploy or a check, asks for nothing
 * and keeps what it last asked for, so the same ask is not sent again after
 * it. A ready worker clears it.
 */
export function workerAlerts(views: WorkerAlertView[]): ExtraAlert[] {
  return views.flatMap((view) => {
    const group = `worker-${view.environmentId}`;
    if (view.blocker === undefined) return [];
    // A sign-in the owner is doing shows as checking; the owner is already on it.
    if (!view.ownerStep || view.claude === "checking" || view.codex === "checking") {
      return [{ key: `${group}-busy`, text: "", group, quiet: true }];
    }
    return [{ key: `${group}-${view.blocker}`, text: `${view.label}: ${view.blocker}`, group }];
  });
}
