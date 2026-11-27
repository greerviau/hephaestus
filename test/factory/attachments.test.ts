import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ATTACHMENT_BRANCH,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  attachmentInstructions,
  attachmentRefs,
  readAttachments,
} from "../../src/factory/attachments.js";
import { NotAFactoryProjectError } from "../../src/factory/intake.js";
import { harness } from "./harness.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "attachments-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Bytes that are not valid text, so a lossy round trip would show. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80]);

async function file(name: string, data: Buffer = PNG): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, data);
  return path;
}

describe("file_issue attachments", () => {
  it("stores the file, links it in the issue, and keeps its bytes after the source is deleted", async () => {
    const h = harness();
    const source = await file("banner.png");
    const issue = await h.intake.fileIssue("planner", "octo/app", "Use the banner", "Body", [
      source,
    ]);
    await rm(source);

    const sha = createHash("sha256").update(PNG).digest("hex");
    const path = `attachments/${sha.slice(0, 16)}/banner.png`;
    const stored = h.github.stored.get(path);
    const commit = stored?.commit ?? "";
    expect(stored?.data.equals(PNG)).toBe(true);
    const body = h.github.issues.get(issue.number)?.body ?? "";
    expect(body.startsWith("Body\n\n## Attachments")).toBe(true);
    expect(body).toContain(`[banner.png](https://github.com/octo/app/blob/${commit}/${path})`);
    // An image is embedded so it renders on the issue page.
    expect(body).toContain(
      `![banner.png](https://github.com/octo/app/blob/${commit}/${path}?raw=true)`,
    );
    expect(body).toContain(`${String(PNG.length)} bytes, sha256 \`${sha}\``);
    expect(h.github.writes).toEqual(["store", "issue"]);
  });

  it("links a file that is not an image without embedding it", async () => {
    const h = harness();
    const source = await file("notes.pdf", Buffer.from("%PDF"));
    const issue = await h.intake.fileIssue("planner", "octo/app", "t", "", [source]);
    const body = h.github.issues.get(issue.number)?.body ?? "";
    expect(body.startsWith("## Attachments")).toBe(true);
    expect(body).toContain("[notes.pdf](");
    expect(body).not.toContain("![");
  });

  it("files the same file twice onto the same path and commit", async () => {
    const h = harness();
    const source = await file("banner.png");
    await h.intake.fileIssue("planner", "octo/app", "a", "", [source]);
    await h.intake.fileIssue("planner", "octo/app", "b", "", [source]);
    expect(h.github.stored.size).toBe(1);
    const [first, second] = [...h.github.issues.values()].map((issue) => issue.body);
    expect(first).toBe(second);
  });

  it("changes nothing for a call without attachments", async () => {
    const h = harness();
    const issue = await h.intake.fileIssue("planner", "octo/app", "t", "Plain body");
    const empty = await h.intake.fileIssue("planner", "octo/app", "t", "Plain body", []);
    expect(h.github.issues.get(issue.number)?.body).toBe("Plain body");
    expect(h.github.issues.get(empty.number)?.body).toBe("Plain body");
    expect(h.github.writes).toEqual(["issue", "issue"]);
    expect(h.github.stored.size).toBe(0);
  });

  it("refuses a missing file by name and files nothing", async () => {
    const h = harness();
    const good = await file("good.png");
    const missing = join(dir, "missing.png");
    await expect(
      h.intake.fileIssue("planner", "octo/app", "t", "b", [good, missing]),
    ).rejects.toThrow(`Attachment ${missing} does not exist`);
    expect(h.github.writes).toEqual([]);
    expect(h.github.issues.size).toBe(0);
    expect(h.cards.list()).toHaveLength(0);
  });

  it("refuses a file that cannot be read", async () => {
    const h = harness();
    const locked = await file("locked.png");
    await chmod(locked, 0o000);
    // Root reads anything, so this case only holds for an ordinary user.
    if (process.getuid?.() === 0) return;
    await expect(h.intake.fileIssue("planner", "octo/app", "t", "b", [locked])).rejects.toThrow(
      `Attachment ${locked} cannot be read`,
    );
    expect(h.github.writes).toEqual([]);
  });

  it("refuses a directory, a relative path, and a URL", async () => {
    const h = harness();
    await mkdir(join(dir, "sub"));
    await symlink(join(dir, "sub"), join(dir, "link"));
    for (const [path, why] of [
      [join(dir, "sub"), "is not a regular file"],
      [join(dir, "link"), "is not a regular file"],
      ["banner.png", "is not an absolute path"],
      ["https://example.com/banner.png", "is a URL"],
    ] as const) {
      await expect(h.intake.fileIssue("planner", "octo/app", "t", "b", [path])).rejects.toThrow(
        `Attachment ${path} ${why}`,
      );
    }
    expect(h.github.writes).toEqual([]);
  });

  it("refuses a file over the size limit, and accepts one at it", async () => {
    const h = harness();
    const big = await file("big.bin", Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));
    await expect(h.intake.fileIssue("planner", "octo/app", "t", "b", [big])).rejects.toThrow(
      `Attachment ${big} is ${String(MAX_ATTACHMENT_BYTES + 1)} bytes, over the limit of ${String(MAX_ATTACHMENT_BYTES)} bytes`,
    );
    expect(h.github.writes).toEqual([]);
    const exact = await file("exact.bin", Buffer.alloc(MAX_ATTACHMENT_BYTES));
    await h.intake.fileIssue("planner", "octo/app", "t", "b", [exact]);
    expect(h.github.writes).toEqual(["store", "issue"]);
  });

  it("refuses more files than one call takes", async () => {
    const paths = await Promise.all(
      Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => file(`f${String(i)}.txt`)),
    );
    await expect(readAttachments(paths)).rejects.toThrow("Too many attachments");
    expect(await readAttachments(paths.slice(0, MAX_ATTACHMENTS))).toHaveLength(MAX_ATTACHMENTS);
  });

  it("files no issue when the upload fails, and files nothing for a non-factory repo", async () => {
    const h = harness();
    const source = await file("banner.png");
    h.github.storeFailures = 1;
    await expect(h.intake.fileIssue("planner", "octo/app", "t", "b", [source])).rejects.toThrow(
      `could not write to ${ATTACHMENT_BRANCH}`,
    );
    expect(h.github.issues.size).toBe(0);
    await expect(h.intake.fileIssue("planner", "octo/other", "t", "b", [source])).rejects.toThrow(
      NotAFactoryProjectError,
    );
    expect(h.github.writes).toEqual([]);
  });

  it("names a file safely for the URL", async () => {
    const [stored] = await readAttachments([await file("my banner (1).png")]);
    expect(stored?.name).toBe("my_banner__1_.png");
    const [dots] = await readAttachments([await file("...")]);
    expect(dots?.name).toBe("attachment");
  });
});

describe("attachment instructions for the worker", () => {
  it("tells the engineer where each file is, and the bytes match the original", async () => {
    const h = harness();
    const source = await file("banner.png");
    const issue = await h.intake.fileIssue("planner", "octo/app", "Use the banner", "Add it", [
      source,
    ]);
    await rm(source);
    await h.pipeline.startWork(issue.cardId ?? 0, "Put the banner on the README.");

    const message = h.t3.launches[0]?.message ?? "";
    const [ref] = attachmentRefs("octo/app", h.github.issues.get(issue.number)?.body ?? "");
    expect(ref).toBeDefined();
    expect(message).toContain(`${ref?.path ?? ""} at commit ${ref?.commit ?? ""}`);
    expect(message).toContain(`git fetch origin ${ATTACHMENT_BRANCH}`);
    expect(message).toContain("git show <commit>:<path>");
    // What the engineer would fetch is what the planner had.
    expect(h.github.stored.get(ref?.path ?? "")?.data.equals(PNG)).toBe(true);
  });

  it("adds nothing to an issue without attachments", () => {
    expect(attachmentInstructions("octo/app", "Plain text")).toBe("");
    // A link that is not on the attachments branch, or from another repo, is not one.
    const sha = "a".repeat(40);
    expect(
      attachmentRefs(
        "octo/app",
        `[x](https://github.com/octo/app/blob/${sha}/README.md) [y](https://github.com/evil/app/blob/${sha}/attachments/0123456789abcdef/y.png)`,
      ),
    ).toEqual([]);
  });
});
