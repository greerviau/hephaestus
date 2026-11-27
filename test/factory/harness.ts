import type { Database } from "better-sqlite3";
import type { FactoryConfig } from "../../src/config/document.js";
import { CardStore } from "../../src/factory/cards.js";
import {
  AlreadyMergedError,
  OPEN_ISSUES_LIMIT,
  type CheckState,
  type CheckSummary,
  type Issue,
  type MergeState,
  type PullRequest,
} from "../../src/factory/github.js";
import { Intake } from "../../src/factory/intake.js";
import { Pipeline } from "../../src/factory/pipeline.js";
import { openStore } from "../../src/store.js";
import type { LaunchOptions, T3Adapter } from "../../src/t3/adapter.js";
import { T3ToolError } from "../../src/t3/connection.js";
import { ThreadEvents } from "../../src/t3/events.js";
import { FactoryThreads } from "../../src/t3/threads.js";
import type { WorkerManager } from "../../src/workers/manager.js";
import { sampleConfig } from "../config/fixtures.js";

export const SHA = "1".repeat(40);
export const SHA2 = "2".repeat(40);
export const MERGE = "9".repeat(40);

export class FakeGitHub {
  issues = new Map<number, Issue>();
  prs = new Map<number, PullRequest>();
  commits = new Map<string, CheckSummary>();
  merged: number[] = [];
  reverted: number[] = [];
  reopened: number[] = [];
  nextIssue = 100;

  createIssue(_repo: string, title: string, body: string): Promise<number> {
    const number = this.nextIssue++;
    this.issues.set(number, { number, title, body, author: "owner", state: "OPEN" });
    return Promise.resolve(number);
  }
  /** Like gh: the newest open issues, at most the limit. */
  openIssues(): Promise<Issue[]> {
    return Promise.resolve(
      [...this.issues.values()]
        .filter((issue) => issue.state === "OPEN")
        .sort((a, b) => b.number - a.number)
        .slice(0, OPEN_ISSUES_LIMIT),
    );
  }
  issue(_repo: string, number: number): Promise<Issue> {
    const issue = this.issues.get(number);
    return issue === undefined ? Promise.reject(new Error("no issue")) : Promise.resolve(issue);
  }
  /** Reopens that fail before one goes through. */
  reopenFailures = 0;
  reopenIssue(_repo: string, number: number): Promise<void> {
    if (this.reopenFailures > 0) {
      this.reopenFailures -= 1;
      return Promise.reject(new Error("GitHub is down"));
    }
    this.reopened.push(number);
    return Promise.resolve();
  }
  defaultBranch(): Promise<string> {
    return Promise.resolve("main");
  }
  pullRequest(_repo: string, number: number): Promise<PullRequest> {
    const pr = this.prs.get(number);
    return pr === undefined
      ? Promise.reject(new Error(`no PR ${String(number)}`))
      : Promise.resolve({ ...pr });
  }
  mergeState(_repo: string, number: number): Promise<MergeState> {
    const pr = this.prs.get(number);
    if (pr === undefined) return Promise.reject(new Error(`no PR ${String(number)}`));
    return Promise.resolve({
      number: pr.number,
      state: pr.state,
      headSha: pr.headSha,
      mergeSha: pr.mergeSha,
    });
  }
  merge(_repo: string, number: number, headSha: string): Promise<string> {
    const pr = this.prs.get(number);
    if (pr?.state === "MERGED") return Promise.reject(new AlreadyMergedError(number, pr.mergeSha));
    if (pr === undefined || pr.headSha !== headSha) return Promise.reject(new Error("head moved"));
    this.merged.push(number);
    pr.state = "MERGED";
    pr.mergeSha = number === 9 ? "8".repeat(40) : MERGE;
    this.ownMerges.add(pr.mergeSha);
    return Promise.resolve(pr.mergeSha);
  }
  /** Merge commits this fake made, which carry Hephaestus's marker. */
  ownMerges = new Set<string>();
  mergedWith(_repo: string, mergeSha: string): Promise<boolean | undefined> {
    return Promise.resolve(this.ownMerges.has(mergeSha));
  }
  commitChecks(_repo: string, sha: string): Promise<CheckSummary> {
    return Promise.resolve(this.commits.get(sha) ?? checks("pending"));
  }
  revertPullRequest(_repo: string, number: number): Promise<number> {
    this.reverted.push(number);
    this.prs.set(9, pr(9, SHA2, { headBranch: "revert-5" }));
    return Promise.resolve(9);
  }
}

export function pr(
  number: number,
  headSha: string,
  fields: Partial<PullRequest> = {},
): PullRequest {
  return {
    number,
    url: `https://github.com/octo/app/pull/${String(number)}`,
    state: "OPEN",
    headSha,
    headBranch: "factory/0123abcd-card-1",
    baseBranch: "main",
    fromFork: false,
    mergeSha: null,
    mergeable: "MERGEABLE",
    files: ["src/app.ts"],
    filesComplete: true,
    checks: "success",
    failedChecks: [],
    checkNames: ["ci"],
    ...fields,
  };
}

export class FakeT3 {
  launches: LaunchOptions[] = [];
  sends: { threadId: string; message: string }[] = [];
  launchThread(
    options: LaunchOptions,
  ): Promise<{ threadId: string; runId: null; projectId: string }> {
    this.launches.push(options);
    return Promise.resolve({
      threadId: `t${String(this.launches.length)}`,
      runId: null,
      projectId: "proj",
    });
  }
  settled: string[] = [];
  settle(_environmentId: string, threadId: string): Promise<void> {
    this.settled.push(threadId);
    return Promise.resolve();
  }
  send(_environmentId: string, threadId: string, message: string): Promise<void> {
    this.sends.push({ threadId, message });
    return Promise.resolve();
  }
  /** What T3 reports for each thread; a thread not listed failed in run r1 and is not snoozed. */
  states = new Map<
    string,
    { status: string; latestRunId: string | null; snoozedUntil: string | null }
  >();
  /** Reads of T3's thread state that fail before one goes through. */
  stateFailures = 0;
  /** Threads T3 no longer has. */
  gone = new Set<string>();
  threadState(
    _environmentId: string,
    threadId: string,
  ): Promise<{ status: string; latestRunId: string | null; snoozedUntil: string | null }> {
    if (this.stateFailures > 0) {
      this.stateFailures -= 1;
      return Promise.reject(new Error("the worker is offline"));
    }
    if (this.gone.has(threadId)) {
      return Promise.reject(new T3ToolError("t3_thread_read", "thread_not_found", "no thread"));
    }
    return Promise.resolve(
      this.states.get(threadId) ?? { status: "failed", latestRunId: "r1", snoozedUntil: null },
    );
  }
  cloneProject(): Promise<string> {
    return Promise.resolve("proj");
  }
  projects(): Promise<{ projectId: string; workspaceRoot: string }[]> {
    return Promise.resolve([]);
  }
}

export interface Harness {
  db: Database;
  cards: CardStore;
  events: ThreadEvents;
  github: FakeGitHub;
  t3: FakeT3;
  intake: Intake;
  pipeline: Pipeline;
  config: FactoryConfig;
  ready: { environmentId: string; label: string; home: string | null }[];
  setClock(ms: number): void;
  /** Ends a thread with a final assistant message. */
  finish(threadId: string, text: string, status?: string): void;
  /** Ends a thread on the provider's usage limit, as T3 reports it: failed, with an error item. */
  limit(threadId: string, text?: string): void;
}

export function harness(configure: (config: FactoryConfig) => void = () => undefined): Harness {
  let clock = Date.parse("2026-11-25T12:00:00Z");
  const now = (): Date => new Date(clock);
  const db = openStore(":memory:");
  const cards = new CardStore(db, now);
  const events = new ThreadEvents(db, now);
  const github = new FakeGitHub();
  const t3 = new FakeT3();
  const config = sampleConfig();
  config.factory.autoStartMinutes = 0;
  configure(config);
  const ready = [{ environmentId: "w1", label: "w1", home: "/home/w" }];
  const workers = {
    readyWorkers: () => ready,
    worker: (environmentId: string) =>
      ready.find((worker) => worker.environmentId === environmentId),
  } as unknown as Pick<WorkerManager, "readyWorkers" | "worker">;
  const threads = new FactoryThreads(t3 as unknown as T3Adapter, events);
  const intake = new Intake({ db, cards, github, config: () => config, now });
  const pipeline = new Pipeline({
    db,
    cards,
    github,
    workers,
    t3: t3,
    threads,
    events,
    config: () => ({ id: 3, document: config }),
    install: "0123abcd-ffff-4fff-8fff-ffffffffffff",
    now,
    checksSettleMs: 0,
  });
  let item = 0;
  return {
    db,
    cards,
    events,
    github,
    t3,
    intake,
    pipeline,
    config,
    ready,
    setClock: (ms) => {
      clock = ms;
    },
    finish: (threadId, text, status = "completed") => {
      const launch = t3.launches.find((_, index) => `t${String(index + 1)}` === threadId);
      const environmentId = launch?.environmentId ?? "w1";
      item += 1;
      events.upsertItems(environmentId, threadId, [
        {
          itemId: `final-${String(item)}`,
          position: item,
          type: "assistant_message",
          status: "completed",
          text,
        },
      ]);
      events.setStatus(environmentId, threadId, status);
    },
    limit: (threadId, text = "You've hit your usage limit. Try again at 4:27 PM.") => {
      item += 1;
      events.upsertItems("w1", threadId, [
        {
          itemId: `error-${String(item)}`,
          position: item,
          type: "error",
          status: "failed",
          text,
        },
      ]);
      events.setStatus("w1", threadId, "failed");
    },
  };
}

export function implementResult(prNumber: number, headSha: string): string {
  return `Opened the PR.\n\n\`\`\`hephaestus-result\n{"status": "done", "pr": ${String(prNumber)}, "headSha": "${headSha}"}\n\`\`\``;
}

export function reviewResult(
  verdict: "approve" | "changes",
  headSha: string,
  findings = "",
): string {
  return `\`\`\`hephaestus-result\n${JSON.stringify({ verdict, headSha, findings })}\n\`\`\``;
}

/** A check summary: `names` ran, and every one finished unless the state is pending or none. */
export function checks(
  state: CheckState,
  names = state === "none" ? [] : ["ci"],
  failed: string[] = [],
): CheckSummary {
  return { state, failed, names, finished: state === "pending" ? [] : names };
}
