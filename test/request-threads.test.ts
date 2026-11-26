import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Fetch } from "../src/discord.js";
import { CardStore } from "../src/factory/cards.js";
import { RequestThreads, milestone, trackingLine } from "../src/request-threads.js";
import { openStore } from "../src/store.js";

const BOT = "111111111111111111";
const GUILD = "222222222222222222";
const CHANNEL = "333333333333333333";
const THREAD = "444444444444444444";
const OTHER = "555555555555555555";

let db: Database;
let cards: CardStore;
let posts: { chat: string; text: string }[];
let messages: Record<string, { id: string; content: string; author: { id: string } }[]>;
let evidence: { commit: string; files: { name: string; data: Buffer }[] } | undefined;
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
    body = messages[path.split("/")[2] ?? ""] ?? [];
  }
  return Promise.resolve({
    ok: body !== undefined,
    status: 200,
    json: () => Promise.resolve(body),
  });
};

beforeEach(() => {
  db = openStore(":memory:");
  cards = new CardStore(db);
  posts = [];
  messages = {};
  evidence = undefined;
  threads = new RequestThreads({
    db,
    cards,
    messaging: {
      credentials: () => ({ token: "token", home: CHANNEL }),
      sendTo: (_platform, chat, text, attachments) => {
        posts.push({ chat, text });
        if (text.includes("MEDIA:") && attachments !== true)
          throw new Error("media without consent");
        return Promise.resolve();
      },
    },
    github: { evidence: () => Promise.resolve(evidence) },
    dashboardUrl: () => "http://host:7700/",
    fetcher,
  });
});

afterEach(() => {
  db.close();
});

function card(): number {
  return cards.create({ repo: "octo/app", issueNumber: 7, title: "Add a flag" }).id;
}

describe("RequestThreads", () => {
  it("follows a thread by the bot's tracking line, and posts each milestone there", async () => {
    const id = card();
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
    cards.transition(id, "Implementing", "work started");
    cards.update(id, { prNumber: 5 });
    cards.transition(id, "Reviewing", "PR #5 at abc");
    cards.transition(id, "Merging", "approved at abc");
    cards.transition(id, "Validating", "merged PR #5 as def");
    cards.transition(id, "Done", "checks passed on def");
    await threads.progress();

    expect(posts.map((post) => post.chat)).toEqual(Array<string>(6).fill(THREAD));
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

  it("ignores a tracking line from anyone but the bot, and threads outside the request channel", async () => {
    card();
    messages[THREAD] = [
      { id: "1", content: trackingLine("octo/app", 7), author: { id: "777777777777777777" } },
    ];
    messages[OTHER] = [{ id: "2", content: trackingLine("octo/app", 7), author: { id: BOT } }];
    await threads.link();
    await threads.progress();
    expect(posts).toEqual([]);
  });

  it("attaches the engineer's evidence once when the PR opens", async () => {
    const id = card();
    await threads.progress();
    await threads.follow("octo/app", 7, { platform: "discord", chat: THREAD });
    evidence = {
      commit: "c1",
      files: [{ name: "../screen shot.png", data: Buffer.from("png") }],
    };
    cards.transition(id, "Implementing", "work started");
    cards.update(id, { prNumber: 5 });
    cards.transition(id, "Reviewing", "PR #5 at abc");
    await threads.progress();
    const attached = posts.filter((post) => post.text.startsWith("Evidence:"));
    expect(attached).toHaveLength(1);
    expect(attached[0]?.text).toMatch(
      /^Evidence: __screen_shot\.png\nMEDIA:\/.+\/__screen_shot\.png$/,
    );

    cards.transition(id, "Implementing", "the reviewer asked for changes");
    cards.transition(id, "Reviewing", "PR #5 at abd");
    await threads.progress();
    expect(posts.filter((post) => post.text.startsWith("Evidence:"))).toHaveLength(1);
  });
});

describe("milestone", () => {
  it("tells the owner when a card needs them, with a link, and skips lead escalations", () => {
    const store = new CardStore(openStore(":memory:"));
    const id = store.create({ repo: "octo/app", issueNumber: 7, title: "x" }).id;
    const escalated = store.transition(id, "Escalated", "to the owner: approve the merge", {
      escalatedTo: "owner",
      reason: "the PR touches .github/workflows/ci.yml",
    });
    expect(
      milestone(
        { id: 1, cardId: id, at: "", kind: "stage:Escalated", detail: "to the owner: approve" },
        escalated,
        "http://host:7700/",
      ),
    ).toBe(
      `This needs you: the PR touches .github/workflows/ci.yml\nhttp://host:7700/work/${String(id)}`,
    );
    expect(
      milestone(
        { id: 2, cardId: id, at: "", kind: "stage:Escalated", detail: "to the lead: blocked" },
        escalated,
        "http://host:7700/",
      ),
    ).toBeUndefined();
  });
});
