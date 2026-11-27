import type { Intake } from "../factory/intake.js";

/** Where one issue's admission stands: under way, or ended in a failure the owner has not retried. */
export type AdmissionState = "admitting" | "failed";

/** How long the Admit request waits for the admission before it answers and lets it finish in the background. */
export const ADMIT_WAIT_MS = 500;

/** How often a page that shows an admission under way fetches itself again. */
export const ADMITTING_RELOAD_SECONDS = 2;

function key(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${String(number)}`;
}

/**
 * Runs the owner's admissions in the background. Admitting reads the issue on
 * GitHub, waits its turn behind intake polls, and creates the Hermes task,
 * which together can take seconds; the Admit request answers before that and
 * the pages show the issue as admitting. A second Admit while one runs joins
 * it. A failure is logged and kept until the owner admits again, so the page
 * can say so without anyone awaiting it.
 */
export class BackgroundAdmissions {
  private readonly states = new Map<string, AdmissionState>();
  private readonly running = new Map<string, Promise<boolean>>();

  constructor(private readonly intake: Pick<Intake, "approve">) {}

  /** Starts the admission unless it already runs; resolves true once it succeeded, false once it failed. */
  start(repo: string, number: number): Promise<boolean> {
    const id = key(repo, number);
    const current = this.running.get(id);
    if (current !== undefined) return current;
    this.states.set(id, "admitting");
    const run = this.intake.approve(repo, number).then(
      () => {
        this.states.delete(id);
        return true;
      },
      (error: unknown) => {
        console.error(`Admitting ${repo}#${String(number)} failed`, error);
        this.states.set(id, "failed");
        return false;
      },
    );
    const tracked = run.finally(() => this.running.delete(id));
    this.running.set(id, tracked);
    return tracked;
  }

  state(repo: string, number: number): AdmissionState | undefined {
    return this.states.get(key(repo, number));
  }

  /** Drops a failure the owner has already been told about. */
  forget(repo: string, number: number): void {
    const id = key(repo, number);
    if (!this.running.has(id)) this.states.delete(id);
  }

  /** Whether any admission runs now, so a page that shows one keeps itself current. */
  busy(): boolean {
    return this.running.size > 0;
  }

  /** Resolves once no admission runs; for tests. */
  async settled(): Promise<void> {
    while (this.running.size > 0) await Promise.all(this.running.values());
  }
}

const shared = new WeakMap<object, BackgroundAdmissions>();

/** The one set of background admissions for this intake, shared by the Admit route and every page that lists issues. */
export function admissionsFor(intake: Pick<Intake, "approve">): BackgroundAdmissions {
  let admissions = shared.get(intake);
  if (admissions === undefined) {
    admissions = new BackgroundAdmissions(intake);
    shared.set(intake, admissions);
  }
  return admissions;
}
