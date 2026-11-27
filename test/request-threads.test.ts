import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Fetch } from "../src/discord.js";
import { TaskStore, MERGE_CONFLICT_DETAIL } from "../src/factory/tasks.js";
import { RequestThreads, milestone, trackingLine } from "../src/request-threads.js";
import { openStore } from "../src/store.js";

const BOT = "111111111111111111";
const GUILD = "222222222222222222";
const CHANNEL = "333333333333333333";
const THREAD = "444444444444444444";
const OTHER = "555555555555555555";

let db: Database;
let tasks: TaskStore;
let posts: { chat: string; text: string; attachments: boolean }[];
let unreadable: Set<string>;
let failPosts: number;
let messages: Record<string, { id: string; content: string; author: { id: string } }[]>;
let evidence: { tree: string; files: { name: string; data: Buffer }[] } | undefined;
let refs: string[] = [];
let threads: RequestThreads;

const fetcher: Fetch = (url) => {
  const path = url.replace("https://discord.com/api/v10", "");
  let body: unknown;
  if (path === "/users/@me") body = { id: BOT };
  else if (path === `/channels/${CHANNEL}`) body = { guild_id: GUILD };
  else if (path === `/guilds/${GUILD}/threads/active`) {
    body = {
      threads: [
        { id: THREAD, parent_id: CHANNEL },
        { id: OTHER, parent_id: "999999999999999999" },
      ],
    };
  } else if (path.startsWith("/channels/")) {
    const id = path.split("/")[2] ?? "";
    const after = /after=(\d+)/.exec(path)?.[1];
    body = unreadable.has(id)
      ? undefined
      : (messages[id] ?? []).filter(
          (message) => after === undefined || BigInt(message.id) > BigInt(after),
        );
  }
  return Promise.resolve({
    ok: body !== undefined,
    status: 200,
    json: () => Promise.resolve(body),
  });
};

beforeEach(() => {
  db = openStore(":memory:");
  tasks = new TaskStore(db);
  posts = [];
  unreadable = new Set();
  failPosts = 0;
  messages = {};
  evidence = undefined;
  refs = [];
  threads = new RequestThreads({
    db,
    tasks,
    messaging: {
      credentials: () => ({ token: "token", request: CHANNEL }),
      sendTo: (_platform, chat, text, attachments) => {
        if (failPosts > 0) {
          failPosts -= 1;
          return Promise.reject(new Error("Discord is down"));
        }
        posts.push({ chat, text, attachments: attachments === true });
        return Promise.resolve();
      },
    },
    github: {
      evidence: (_repo, ref) => {
        refs.push(ref);
        return Promise.resolve(evidence);
      },
    },
    install: "0123abcd-ffff-4fff-8fff-ffffffffffff",
    dashboardUrl: () => "http://host:7700/",
    fetcher,
  });
});

afterEach(() => {
  db.close();
});

/** An issue Hephaestus tracks, and its task. */
function task(number = 7): number {
  db.prepare(
    `INSERT INTO issues (repo, number, title, author, provenance, filed_by, state, created_at, updated_at)
     VALUES ('octo/app', ?, 't', 'x', 'factory', 'communicator', 'admitted', 'x', 'x')`,
  ).run(number);
  return tasks.create({ repo: "octo/app", issueNumber: number, title: "Add a flag" }).id;
}

describe("RequestThreads", () => {
  it("follows a thread by the bot's tracking line, and posts each milestone there", async () => {
    const id = task();
    await threads.progress();
    messages[THREAD] = [
      { id: "1", content: "Could you add a flag?", author: { id: "777777777777777777" } },
      {
        id: "2",
        content: `Filed https://github.com/octo/app/issues/7\n${trackingLine("octo/app", 7)}`,
        author: { id: BOT },
      },
    ];
    await threads.link();
    tasks.transition(id, "Queued", "the lead queued the work");
    tasks.transition(id, "Implementing", "work started");
    tasks.update(id, { prNumber: 5 });
    tasks.transition(id, "Reviewing", "PR #5 at abc");
    tasks.transition(id, "Merging", "approved at abc");
    tasks.transition(id, "Validating", "merged PR #5 as def");
    tasks.transition(id, "Done", "checks passed on def");
    await threads.progress();

    expect(posts.map((post) => post.chat)).toEqual(Array<string>(6).fill(THREAD));
    expect(posts.some((post) => post.attachments)).toBe(false);
    expect(posts.map((post) => post.text)).toEqual([
      "Following octo/app#7: it is admitted and waiting to start. Progress shows up here.",
      "Work started.",
      "PR opened, now in review: https://github.com/octo/app/pull/5",
      "The review approved it.",
      "Merged. Checks are running on the default branch.",
      "Done: checks passed on the default branch.",
    ]);
    // Nothing is posted twice.
    await threads.progress();
    expect(posts).toHaveLength(6);
  });

  it("says a queued task waits for a free slot when it starts following it", async () => {
    const id = task();
    tasks.transition(id, "Queued", "the lead queued the work");
    await threads.progress();
    messages[THREAD] = [
      {
        id: "2",
        content: `Filed https://github.com/octo/app/issues/7\n${trackingLine("octo/app", 7)}`,
        author: { id: BOT },
      },
    ];
    await threads.link();
    await threads.progress();

    expect(posts.map((post) => post.text)).toEqual([
      "Following octo/app#7: it is queued and starts when a thread slot is free. Progress shows up here.",
    ]);
  });

  it("ignores a tracking line from anyone but the bot, and threads outside the request channel", async () => {
    task();
    messages[THREAD] = [
      { id: "1", content: trackingLine("octo/app", 7), author: { id: "777777777777777777" } },
    ];
    messages[OTHER] = [{ id: "2", content: trackingLine("octo/app", 7), author: { id: BOT } }];
    await threads.link();
    await threads.progress();
    expect(posts).toEqual([]);
  });

  it("attaches the engineer's evidence once when the PR opens", async () => {
    const id = task();
    await threads.progress();
    await threads.follow("octo/app", 7, { platform: "discord", chat: THREAD });
    evidence = {
      tree: "t1",
      files: [{ name: "../screen shot.png", data: Buffer.from("png") }],
    };
    tasks.transition(id, "Queued", "the lead queued the work");
    tasks.transition(id, "Implementing", "work started");
    tasks.update(id, { prNumber: 5 });
    tasks.transition(id, "Reviewing", "PR #5 at abc");
    await threads.progress();
    // Scoped to this install, so a reinstall's task 1 never reads the last install's evidence.
    expect(refs).toContain("hephaestus/evidence/0123abcd-task-1");
    const attached = posts.filter((post) => post.text.startsWith("Evidence:"));
    expect(attached).toHaveLength(1);
    expect(attached[0]?.attachments).toBe(true);
    expect(attached[0]?.text).toMatch(
      /^Evidence: __screen_shot\.png\nMEDIA:\/.+\/__screen_shot\.png$/,
    );

    tasks.transition(id, "Implementing", "the reviewer asked for changes");
    tasks.transition(id, "Reviewing", "PR #5 at abd");
    await threads.progress();
    expect(posts.filter((post) => post.text.startsWith("Evidence:"))).toHaveLength(1);
  });
});

describe("RequestThreads, under bad input", () => {
  it("follows every issue a request files, including one filed later", async () => {
    task(7);
    task(8);
    task(9);
    await threads.progress();
    messages[THREAD] = [
      {
        id: "10",
        content: `Filed two issues.\n**${trackingLine("octo/app", 7)}**\n\`${trackingLine("octo/app", 8)}\``,
        author: { id: BOT },
      },
    ];
    await threads.link();
    messages[THREAD].push({ id: "11", content: trackingLine("octo/app", 9), author: { id: BOT } });
    await threads.link();
    const rows = db.prepare("SELECT number FROM chat_threads ORDER BY number").all();
    expect(rows).toEqual([{ number: 7 }, { number: 8 }, { number: 9 }]);
  });

  it("ignores a tracking reference inside a sentence and an issue Hephaestus does not track", async () => {
    task(7);
    messages[THREAD] = [
      { id: "1", content: "I am not Tracking octo/app#7 here", author: { id: BOT } },
      { id: "2", content: trackingLine("other/repo", 99), author: { id: BOT } },
    ];
    await threads.link();
    expect(db.prepare("SELECT COUNT(*) AS n FROM chat_threads").get()).toEqual({ n: 0 });
  });

  it("reads a task's evidence where its engineer was told, including an older task-<id> name", async () => {
    const id = task();
    tasks.update(id, { branch: "factory/task-1-retry-9" });
    await threads.progress();
    await threads.follow("octo/app", 7, { platform: "discord", chat: THREAD });
    tasks.transition(id, "Queued", "the lead queued the work");
    tasks.transition(id, "Implementing", "work started");
    tasks.update(id, { prNumber: 5 });
    tasks.transition(id, "Reviewing", "PR #5 at abc");
    await threads.progress();

    expect(refs).toContain("hephaestus/evidence/task-1");
    expect(refs).not.toContain("hephaestus/evidence/0123abcd-task-1");
  });

  it("keeps posting milestones when evidence cannot be written, and goes past an unreadable thread", async () => {
    const id = task();
    await threads.progress();
    await threads.follow("octo/app", 7, { platform: "discord", chat: THREAD });
    // A name too long for the file system, as far as the folder is concerned, is cut short.
    evidence = { tree: "t1", files: [{ name: "x".repeat(400), data: Buffer.from("a") }] };
    tasks.transition(id, "Queued", "the lead queued the work");
    tasks.transition(id, "Implementing", "work started");
    tasks.update(id, { prNumber: 5 });
    tasks.transition(id, "Reviewing", "PR #5 at abc");
    tasks.transition(id, "Merging", "approved at abc");
    await threads.progress();
    await threads.progress();
    const texts = posts.map((post) => post.text.split("\n")[0]);
    expect(texts.filter((text) => text?.startsWith("PR opened"))).toHaveLength(1);
    expect(texts).toContain("The review approved it.");

    unreadable.add(THREAD);
    await expect(threads.link()).resolves.toBeUndefined();
  });

  it("posts the PR link when a policy needs no review", () => {
    const store = new TaskStore(openStore(":memory:"));
    const id = store.create({ repo: "octo/app", issueNumber: 7, title: "x" }).id;
    const merging = store.update(id, { prNumber: 5 });
    expect(
      milestone(
        {
          id: 1,
          taskId: id,
          at: "",
          kind: "stage:Merging",
          detail: "PR #5 at abc; the policy needs no review",
        },
        merging,
        "",
      ),
    ).toBe("PR opened; it merges once its checks pass: https://github.com/octo/app/pull/5");
  });
});

describe("milestone", () => {
  it("says the engineer is updating a PR that conflicts with its base", () => {
    const store = new TaskStore(openStore(":memory:"));
    const id = store.create({ repo: "octo/app", issueNumber: 7, title: "x" }).id;
    expect(
      milestone(
        { id: 1, taskId: id, at: "", kind: "stage:Implementing", detail: MERGE_CONFLICT_DETAIL },
        store.get(id),
        "",
      ),
    ).toBe("The PR conflicts with changes merged since it opened. The engineer is updating it.");
  });

  it("tells the owner when a task needs them, with a link, and skips lead escalations", () => {
    const store = new TaskStore(openStore(":memory:"));
    const id = store.create({ repo: "octo/app", issueNumber: 7, title: "x" }).id;
    const escalated = store.transition(id, "Escalated", "to the owner: approve the merge", {
      escalatedTo: "owner",
      reason: "the PR touches .github/workflows/ci.yml",
    });
    expect(
      milestone(
        {
          id: 1,
          taskId: id,
          at: "",
          kind: "stage:Escalated",
          detail: "to the owner: the PR touches .github/workflows/ci.yml",
        },
        escalated,
        "http://host:7700/",
      ),
    ).toBe(
      `This needs you: the PR touches .github/workflows/ci.yml.\nhttp://host:7700/work/${String(id)}`,
    );
    expect(
      milestone(
        { id: 2, taskId: id, at: "", kind: "stage:Escalated", detail: "to the lead: blocked" },
        escalated,
        "http://host:7700/",
      ),
    ).toBeUndefined();
    // The lead passing the task on to the owner reaches the thread too.
    expect(
      milestone(
        { id: 3, taskId: id, at: "", kind: "escalated:owner", detail: "CI is red!\n" },
        escalated,
        "http://host:7700/",
      ),
    ).toBe(`This needs you: CI is red.\nhttp://host:7700/work/${String(id)}`);
  });
});

describe("RequestThreads, linked late", () => {
  it("does not repeat in a milestone what the catch-up already said, and attaches waiting evidence", async () => {
    const id = task();
    await threads.progress();
    tasks.transition(id, "Queued", "the lead queued the work");
    tasks.transition(id, "Implementing", "work started");
    tasks.update(id, { prNumber: 5 });
    tasks.transition(id, "Reviewing", "PR #5 at abc");
    evidence = { tree: "t1", files: [{ name: "screen.png", data: Buffer.from("png") }] };
    // The thread links before the next progress pass has seen those events.
    await threads.follow("octo/app", 7, { platform: "discord", chat: THREAD });
    await threads.progress();
    expect(posts.map((post) => post.text.split("\n")[0])).toEqual([
      "Following octo/app#7: PR #5 is in review. Progress shows up here.",
      "Evidence: screen.png",
    ]);
    tasks.transition(id, "Merging", "approved at abc");
    await threads.progress();
    expect(posts.at(-1)?.text).toBe("The review approved it.");
  });

  it("posts every step of the window when the catch-up itself was not sent", async () => {
    const id = task();
    await threads.progress();
    tasks.transition(id, "Queued", "the lead queued the work");
    tasks.transition(id, "Implementing", "work started");
    failPosts = 1;
    await threads.follow("octo/app", 7, { platform: "discord", chat: THREAD });
    await threads.progress();
    expect(posts.map((post) => post.text)).toEqual(["Work started."]);
  });

  it("gives the reason and link of a task that needs the owner, and no evidence for one sent back", async () => {
    const id = task();
    await threads.progress();
    tasks.update(id, { prNumber: 5 });
    tasks.transition(id, "Queued", "the lead queued the work");
    tasks.transition(id, "Implementing", "work started");
    evidence = { tree: "t1", files: [{ name: "screen.png", data: Buffer.from("png") }] };
    await threads.follow("octo/app", 7, { platform: "discord", chat: THREAD });
    expect(posts.map((post) => post.text)).toEqual([
      "Following octo/app#7: the engineer is working on it. Progress shows up here.",
    ]);

    task(8);
    const other = tasks.list().find((item) => item.issueNumber === 8)?.id ?? 0;
    tasks.transition(other, "Escalated", "to the owner: pick", {
      escalatedTo: "owner",
      reason: "pick a database.",
    });
    await threads.follow("octo/app", 8, { platform: "discord", chat: OTHER });
    expect(posts.at(-1)?.text).toBe(
      `Following octo/app#8: it needs you: pick a database. http://host:7700/work/${String(other)} Progress shows up here.`,
    );
  });
});

describe("RequestThreads, catch-up text", () => {
  it("gives a stopped task's and a lead escalation's reason, a revert's PR, and keeps a long reason short", async () => {
    const texts: string[] = [];
    for (const [number, setup] of [
      [
        21,
        (id: number) => tasks.transition(id, "Abandoned", "x", { reason: "Is this still wanted?" }),
      ],
      [
        22,
        (id: number) =>
          tasks.transition(id, "Escalated", "to the lead: x", {
            escalatedTo: "lead",
            reason: "blocked on a key.",
          }),
      ],
      [
        23,
        (id: number) =>
          tasks.transition(id, "Escalated", "to the owner: x", {
            escalatedTo: "owner",
            reason: "y".repeat(400),
          }),
      ],
    ] as const) {
      setup(task(number));
      await threads.follow("octo/app", number, { platform: "discord", chat: THREAD });
      texts.push(posts.at(-1)?.text ?? "");
    }
    expect(texts[0]).toBe(
      "Following octo/app#21: it was stopped: Is this still wanted. Progress shows up here.",
    );
    expect(texts[1]).toBe(
      "Following octo/app#22: it is waiting for a decision: blocked on a key. Progress shows up here.",
    );
    expect(texts[2]).toMatch(
      /^Following octo\/app#23: it needs you: y{300} \(cut short; the task page has it all\)\. http:\/\/host:7700\/work\/\d+ Progress/,
    );

    const reverting = task(24);
    tasks.update(reverting, { revertPr: 12 });
    db.prepare("UPDATE tasks SET stage = 'Reverting' WHERE id = ?").run(reverting);
    await threads.follow("octo/app", 24, { platform: "discord", chat: THREAD });
    expect(posts.at(-1)?.text).toContain("being reverted with PR #12.");
  });
});

describe("RequestThreads, an updated PR", () => {
  it("says a PR back in review is updated or the same, a new PR is opened, and links each event's own PR", async () => {
    const id = task();
    const other = task(8);
    await threads.progress();
    await threads.follow("octo/app", 7, { platform: "discord", chat: THREAD });
    // Another task's PR #5 does not count for this one.
    tasks.transition(other, "Queued", "the lead queued the work");
    tasks.transition(other, "Implementing", "work started");
    tasks.transition(other, "Reviewing", "PR #5 at aaa");
    tasks.transition(id, "Queued", "the lead queued the work");
    tasks.transition(id, "Implementing", "work started");
    tasks.update(id, { prNumber: 55 });
    tasks.transition(id, "Reviewing", "PR #55 at abc");
    tasks.update(id, { prNumber: 5 });
    tasks.transition(id, "Implementing", "the lead restarted the work");
    tasks.transition(id, "Reviewing", "PR #5 at abc");
    tasks.transition(id, "Implementing", "the reviewer asked for changes");
    tasks.transition(id, "Reviewing", "PR #5 at abd");
    tasks.transition(id, "Implementing", "the lead restarted the work");
    tasks.transition(id, "Reviewing", "PR #5 at abd");
    tasks.transition(id, "Implementing", MERGE_CONFLICT_DETAIL);
    tasks.transition(id, "Merging", "PR #5 at abe; the policy needs no review");
    tasks.transition(id, "Implementing", MERGE_CONFLICT_DETAIL);
    tasks.transition(id, "Merging", "PR #5 at abf; the policy needs no review");
    tasks.transition(id, "Implementing", "the lead restarted the work");
    tasks.transition(id, "Merging", "PR #5 at abf; the policy needs no review");
    await threads.progress();
    expect(
      posts.map((post) => post.text).filter((text) => /review|merges once/.test(text)),
    ).toEqual([
      "PR opened, now in review: https://github.com/octo/app/pull/55",
      "PR opened, now in review: https://github.com/octo/app/pull/5",
      "The review asked for changes. The engineer is on them.",
      "The PR is updated and back in review: https://github.com/octo/app/pull/5",
      "The PR is back in review: https://github.com/octo/app/pull/5",
      "The PR is updated; it merges once its checks pass: https://github.com/octo/app/pull/5",
      "The PR is updated; it merges once its checks pass: https://github.com/octo/app/pull/5",
      "The PR merges once its checks pass: https://github.com/octo/app/pull/5",
    ]);
  });

  it("posts a revert once, linking the revert PR its event names", async () => {
    const id = task();
    await threads.progress();
    await threads.follow("octo/app", 7, { platform: "discord", chat: THREAD });
    db.prepare("UPDATE tasks SET stage = 'Validating', revert_pr = 20 WHERE id = ?").run(id);
    tasks.transition(id, "Reverting", "checks failed on m1 (ci); opened revert PR #12");
    tasks.transition(id, "Escalated", "to the owner: approve the revert merge", {
      escalatedTo: "owner",
      reason: "approve the revert merge",
    });
    tasks.transition(id, "Reverting", "the owner approved the merge", {
      reason: null,
      escalatedTo: null,
    });
    tasks.transition(id, "Escalated", "to the owner: the revert has not merged after an hour", {
      escalatedTo: "owner",
    });
    tasks.transition(id, "Reverting", "revert PR #12 merged on GitHub");
    // The task's reason by the time the pass runs is a later one; the escalation keeps its own.
    tasks.update(id, { reason: "yes, carry on" });
    await threads.progress();
    const texts = posts.map((post) => post.text);
    expect(texts.filter((text) => text.includes("being reverted"))).toEqual([
      "Checks failed on the default branch after the merge, so it is being reverted with https://github.com/octo/app/pull/12.",
    ]);
    expect(texts.find((text) => text.startsWith("This needs you"))).toMatch(
      /^This needs you: approve the revert merge\./,
    );
  });
});
