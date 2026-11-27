import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ATTACHMENT_BRANCH,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  attachmentInstructions,
  NotRegularError,
  openRegularFile,
  readAttachments,
  readBounded,
  storedAttachments,
  type Attachment,
} from "../../src/factory/attachments.js";
import { chatCacheDirs } from "../../src/hermes/cache.js";
import { NotAFactoryProjectError } from "../../src/factory/intake.js";
import { harness, type Harness } from "./harness.js";

let dir: string;
/** Where the chat gateway caches the files a requester sends: the only place attachments may come from. */
let cache: string;
/** A folder on the same host that is not the cache. */
let elsewhere: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "attachments-"));
  cache = join(dir, "cache");
  elsewhere = join(dir, "elsewhere");
  await mkdir(cache);
  await mkdir(elsewhere);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Bytes that are not valid text, so a lossy round trip would show. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80]);

async function file(name: string, data: Buffer = PNG, folder = cache): Promise<string> {
  const path = join(folder, name);
  await writeFile(path, data);
  return path;
}

function fileIssue(h: Harness, files: string[], title = "t", body = "b") {
  return h.intake.fileIssue("communicator", "octo/app", title, body, files, [cache]);
}

describe("file_issue attachments", () => {
  it("stores the file, links it in the issue, and keeps its bytes after the source is deleted", async () => {
    const h = harness();
    const source = await file("banner.png");
    const issue = await fileIssue(h, [source], "Use the banner", "Body");
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

  it("keeps the attachments of an issue whose filing reply was lost, once the poll finds it", async () => {
    const h = harness();
    h.github.createIssueLostReplies = 1;
    await expect(fileIssue(h, [await file("banner.png")], "Use the banner")).rejects.toThrow(
      /timed out/,
    );
    await h.intake.poll();
    expect(h.intake.issue("octo/app", 100)?.provenance).toBe("factory");
    expect(storedAttachments(h.db, "octo/app", 100)).toHaveLength(1);
  });

  it("links a file that is not an image without embedding it", async () => {
    const h = harness();
    const issue = await fileIssue(h, [await file("notes.pdf", Buffer.from("%PDF"))], "t", "");
    const body = h.github.issues.get(issue.number)?.body ?? "";
    expect(body.startsWith("## Attachments")).toBe(true);
    expect(body).toContain("[notes.pdf](");
    expect(body).not.toContain("![");
  });

  it("files the same file twice onto the same path and commit", async () => {
    const h = harness();
    const source = await file("banner.png");
    await fileIssue(h, [source], "a");
    await fileIssue(h, [source], "b");
    expect(h.github.stored.size).toBe(1);
    const [first, second] = [...h.github.issues.values()].map((issue) => issue.body);
    expect(first).toBe(second);
  });

  it("changes nothing for a call without attachments", async () => {
    const h = harness();
    const issue = await h.intake.fileIssue("communicator", "octo/app", "t", "Plain body");
    const empty = await h.intake.fileIssue(
      "communicator",
      "octo/app",
      "t",
      "Plain body",
      [],
      [cache],
    );
    expect(h.github.issues.get(issue.number)?.body).toBe("Plain body");
    expect(h.github.issues.get(empty.number)?.body).toBe("Plain body");
    expect(h.github.writes).toEqual(["issue", "issue"]);
    expect(h.github.stored.size).toBe(0);
  });

  it("refuses a missing file by name and files nothing", async () => {
    const h = harness();
    const good = await file("good.png");
    const missing = join(cache, "missing.png");
    await expect(fileIssue(h, [good, missing])).rejects.toThrow(
      `Attachment ${missing} does not exist`,
    );
    expect(h.github.writes).toEqual([]);
    expect(h.github.issues.size).toBe(0);
    expect(h.tasks.list()).toHaveLength(0);
  });

  it("refuses a file that cannot be read", async () => {
    // Root reads anything, so this case only holds for an ordinary user.
    if (process.getuid?.() === 0) return;
    const h = harness();
    const locked = await file("locked.png");
    await chmod(locked, 0o000);
    await expect(fileIssue(h, [locked])).rejects.toThrow(`Attachment ${locked} cannot be read`);
    expect(h.github.writes).toEqual([]);
  });

  it("refuses a directory, a relative path, and a URL", async () => {
    const h = harness();
    await mkdir(join(cache, "sub"));
    for (const [path, why] of [
      [join(cache, "sub"), "is not a regular file"],
      ["banner.png", "is not an absolute path"],
      ["https://example.com/banner.png", "is a URL"],
    ] as const) {
      await expect(fileIssue(h, [path])).rejects.toThrow(`Attachment ${path} ${why}`);
    }
    expect(h.github.writes).toEqual([]);
  });

  it("refuses a file over the size limit, and accepts one at it", async () => {
    const h = harness();
    const big = await file("big.bin", Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));
    await expect(fileIssue(h, [big])).rejects.toThrow(
      `Attachment ${big} is ${String(MAX_ATTACHMENT_BYTES + 1)} bytes, over the limit of ${String(MAX_ATTACHMENT_BYTES)} bytes`,
    );
    expect(h.github.writes).toEqual([]);
    const exact = await file("exact.bin", Buffer.alloc(MAX_ATTACHMENT_BYTES));
    await fileIssue(h, [exact]);
    expect(h.github.writes).toEqual(["store", "issue"]);
  });

  it("refuses a file that grows past the limit after it was checked, reading no further than the limit", async () => {
    const h = harness();
    const grows = await file("grows.bin", Buffer.alloc(MAX_ATTACHMENT_BYTES - 10));
    await expect(
      readAttachments([grows], [cache], async (path) => {
        await appendFile(path, Buffer.alloc(1024));
      }),
    ).rejects.toThrow(
      `Attachment ${grows} is over the limit of ${String(MAX_ATTACHMENT_BYTES)} bytes`,
    );
    // Through filing, an oversize file leaves nothing on GitHub.
    const big = await file("big2.bin", Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));
    await expect(fileIssue(h, [big])).rejects.toThrow("over the limit");
    expect(h.github.writes).toEqual([]);
    expect(h.github.issues.size).toBe(0);
  });

  it("reads no more than one byte past the limit from a file that never ends", async () => {
    let requested = 0;
    let returned = 0;
    const endless = {
      read(buffer: Buffer, _offset: number, length: number): Promise<{ bytesRead: number }> {
        requested += length;
        returned += length;
        buffer.fill(1, 0, length);
        return Promise.resolve({ bytesRead: length });
      },
    };
    expect(await readBounded(endless, 100_000)).toBeUndefined();
    expect(returned).toBe(100_001);
    expect(requested).toBe(100_001);
  });

  it("reads a file exactly at the limit byte for byte", async () => {
    const data = Buffer.alloc(MAX_ATTACHMENT_BYTES);
    for (let i = 0; i < data.length; i += 4099) data[i] = i % 251;
    const [stored] = await readAttachments([await file("exact.bin", data)], [cache]);
    expect(stored?.data.equals(data)).toBe(true);
    expect(stored?.sha256).toBe(createHash("sha256").update(data).digest("hex"));
  });

  it("refuses more files than one call takes", async () => {
    const paths = await Promise.all(
      Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => file(`f${String(i)}.txt`)),
    );
    await expect(readAttachments(paths, [cache])).rejects.toThrow("Too many attachments");
    expect(await readAttachments(paths.slice(0, MAX_ATTACHMENTS), [cache])).toHaveLength(
      MAX_ATTACHMENTS,
    );
  });

  it("files no issue when the upload fails, and files nothing for a non-factory repo", async () => {
    const h = harness();
    const source = await file("banner.png");
    h.github.storeFailures = 1;
    await expect(fileIssue(h, [source])).rejects.toThrow(`could not write to ${ATTACHMENT_BRANCH}`);
    expect(h.github.issues.size).toBe(0);
    await expect(
      h.intake.fileIssue("communicator", "octo/other", "t", "b", [source], [cache]),
    ).rejects.toThrow(NotAFactoryProjectError);
    expect(h.github.writes).toEqual([]);
  });

  it("names a file safely for the URL", async () => {
    const [stored] = await readAttachments([await file("my banner (1).png")], [cache]);
    expect(stored?.name).toBe("my_banner__1_.png");
    const [dots] = await readAttachments([await file("...")], [cache]);
    expect(dots?.name).toBe("attachment");
  });
});

describe("which files can be attached", () => {
  const secret = Buffer.from("-----BEGIN PRIVATE KEY-----");

  it("refuses a readable file outside the chat cache, with no GitHub write", async () => {
    const h = harness();
    const outside = await file("id_rsa", secret, elsewhere);
    await expect(fileIssue(h, [outside])).rejects.toThrow(
      `Attachment ${outside} is not in the chat attachment cache`,
    );
    // Not even a file that does not exist says whether it does.
    const absent = join(elsewhere, "absent");
    await expect(fileIssue(h, [absent])).rejects.toThrow("is not in the chat attachment cache");
    // A path that climbs out of the cache by name.
    const climbing = join(cache, "..", "elsewhere", "id_rsa");
    await expect(fileIssue(h, [climbing])).rejects.toThrow("is not in the chat attachment cache");
    expect(h.github.writes).toEqual([]);
    expect(h.github.stored.size).toBe(0);
    expect(h.github.issues.size).toBe(0);
  });

  it("refuses a link in the cache to a file outside it", async () => {
    const h = harness();
    const outside = await file("id_rsa", secret, elsewhere);
    const link = join(cache, "banner.png");
    await symlink(outside, link);
    await expect(fileIssue(h, [link])).rejects.toThrow(`Attachment ${link} is a symbolic link`);
    expect(h.github.writes).toEqual([]);
  });

  it("refuses a link in the cache to a file inside it", async () => {
    const h = harness();
    const target = await file("real.png");
    const link = join(cache, "link.png");
    await symlink(target, link);
    await expect(fileIssue(h, [link])).rejects.toThrow(`Attachment ${link} is a symbolic link`);
    expect(h.github.writes).toEqual([]);
  });

  it("refuses a file reached through a linked folder that leaves the cache", async () => {
    const h = harness();
    await file("id_rsa", secret, elsewhere);
    await symlink(elsewhere, join(cache, "folder"));
    const through = join(cache, "folder", "id_rsa");
    await expect(fileIssue(h, [through])).rejects.toThrow(
      `Attachment ${through} is a symbolic link`,
    );
    expect(h.github.writes).toEqual([]);
  });

  it("refuses a file reached through a linked folder whose target stays inside the cache", async () => {
    const h = harness();
    await mkdir(join(cache, "real"));
    await file("a.png", PNG, join(cache, "real"));
    await symlink(join(cache, "real"), join(cache, "alias"));
    const through = join(cache, "alias", "a.png");
    await expect(fileIssue(h, [through])).rejects.toThrow(
      `Attachment ${through} is a symbolic link`,
    );
    expect(h.github.writes).toEqual([]);
    // The same file by its own path is fine.
    await fileIssue(h, [join(cache, "real", "a.png")]);
    expect(h.github.writes).toEqual(["store", "issue"]);
  });

  it("refuses a named pipe at once instead of waiting for a writer", async () => {
    const h = harness();
    const pipe = join(cache, "pipe.png");
    execFileSync("mkfifo", [pipe]);
    // A read that waited for a writer would never return, and would hold up every later filing.
    await expect(fileIssue(h, [pipe])).rejects.toThrow(`Attachment ${pipe} is not a regular file`);
    // A pipe put in place after the path was checked reaches the open, which must not wait either.
    await expect(openRegularFile(pipe)).rejects.toBeInstanceOf(NotRegularError);
    const plain = await openRegularFile(await file("plain.png"));
    expect((await plain.readFile()).equals(PNG)).toBe(true);
    await plain.close();
    expect(h.github.writes).toEqual([]);
    const after = await fileIssue(h, [await file("ok.png")]);
    expect(after.state).toBe("admitted");
  });

  it("takes files from the media folders of a Hermes profile, current and legacy", async () => {
    const h = harness();
    const home = join(dir, "profile");
    const layout: [string, string][] = [
      ["cache/images", "new.png"],
      ["image_cache", "legacy.png"],
      ["document_cache", "legacy.pdf"],
      ["cache/documents", "new.pdf"],
    ];
    const paths: string[] = [];
    for (const [folder, name] of layout) {
      await mkdir(join(home, folder), { recursive: true });
      paths.push(await file(name, Buffer.from(name), join(home, folder)));
    }
    const issue = await h.intake.fileIssue(
      "communicator",
      "octo/app",
      "t",
      "b",
      paths,
      chatCacheDirs(home),
    );
    const body = h.github.issues.get(issue.number)?.body ?? "";
    for (const [, name] of layout) expect(body).toContain(`[${name}](`);
    // The rest of the profile's home is not a media cache.
    await writeFile(join(home, "config.yaml"), "model: x\n");
    await writeFile(join(home, ".env"), "KEY=secret\n");
    for (const name of ["config.yaml", ".env"]) {
      await expect(
        h.intake.fileIssue(
          "communicator",
          "octo/app",
          "t",
          "b",
          [join(home, name)],
          chatCacheDirs(home),
        ),
      ).rejects.toThrow("is not in the chat attachment cache");
    }
  });

  it("accepts a file in a folder inside the cache, and a cache reached through a link", async () => {
    const h = harness();
    await mkdir(join(cache, "images"));
    const nested = await file("a.png", PNG, join(cache, "images"));
    await fileIssue(h, [nested]);
    const viaLink = join(dir, "cache-link");
    await symlink(cache, viaLink);
    const linked = await h.intake.fileIssue(
      "communicator",
      "octo/app",
      "t",
      "b",
      [nested],
      [viaLink],
    );
    expect(linked.state).toBe("admitted");
  });

  it("refuses every attachment when the role has no cache", async () => {
    const h = harness();
    const source = await file("banner.png");
    await expect(
      h.intake.fileIssue("communicator", "octo/app", "t", "b", [source], []),
    ).rejects.toThrow("is not in the chat attachment cache");
    await expect(
      h.intake.fileIssue(
        "communicator",
        "octo/app",
        "t",
        "b",
        [source],
        [join(dir, "no-such-cache")],
      ),
    ).rejects.toThrow("is not in the chat attachment cache");
    expect(h.github.writes).toEqual([]);
  });
});

function git(cwd: string, ...args: string[]): Buffer {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      cwd,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    },
  );
}

describe("attachment instructions for the worker", () => {
  it("lets a worker in a separate checkout fetch the file and commit its exact bytes", async () => {
    const h = harness();
    // The repo on GitHub, and the clone the API's commits are made in.
    const origin = join(dir, "origin.git");
    const api = join(dir, "api");
    git(dir, "init", "--bare", "-b", "main", origin);
    git(dir, "clone", origin, api);
    await writeFile(join(api, "README.md"), "# app\n");
    git(api, "add", ".");
    git(api, "commit", "-m", "init");
    git(api, "push", "origin", "HEAD:main");
    // The worker's clone, made before the file was attached, so it has nothing of it.
    const worker = join(dir, "worker");
    git(dir, "clone", origin, worker);
    // What the contents API does: a commit on the attachments branch, made from the default branch.
    h.github.storeAttachments = async (_repo: string, files: readonly Attachment[]) => {
      git(api, "fetch", "origin");
      git(api, "checkout", "-B", ATTACHMENT_BRANCH, "origin/main");
      const commits: string[] = [];
      for (const attachment of files) {
        await mkdir(dirname(join(api, attachment.path)), { recursive: true });
        await writeFile(join(api, attachment.path), attachment.data);
        git(api, "add", attachment.path);
        git(api, "commit", "-m", `Attach ${attachment.name}`);
        commits.push(git(api, "rev-parse", "HEAD").toString().trim());
      }
      git(api, "push", "origin", ATTACHMENT_BRANCH);
      return commits;
    };

    const source = await file("banner.png");
    const issue = await fileIssue(h, [source], "Use the banner", "Add it to the README");
    // The communicator's cache is pruned.
    await rm(source);
    await rm(cache, { recursive: true });
    await h.pipeline.queue(issue.taskId ?? 0, "Put the banner on the README.");

    // The worker has only its own clone and the first message of its thread.
    const message = h.t3.launches[0]?.message ?? "";
    const [ref] = storedAttachments(h.db, "octo/app", issue.number);
    expect(ref).toBeDefined();
    expect(message).toContain(`${ref?.path ?? ""} at commit ${ref?.commit ?? ""}`);
    expect(() => git(worker, "cat-file", "-e", `${ref?.commit ?? ""}^{commit}`)).toThrow();

    // The commands the message gives, with its placeholders filled in.
    const fetch = /`(git fetch origin [^`]+)`/.exec(message)?.[1];
    const show = /`(git show <commit>:<path> > <destination>)`/.exec(message)?.[1];
    expect(fetch).toBe(`git fetch origin ${ATTACHMENT_BRANCH}`);
    expect(show).toBeDefined();
    const sh = (command: string): void => {
      execFileSync("sh", ["-c", command], { cwd: worker });
    };
    sh(fetch ?? "false");
    sh(
      (show ?? "false")
        .replace("<commit>", ref?.commit ?? "")
        .replace("<path>", ref?.path ?? "")
        .replace("<destination>", "assets/banner.png")
        .replace(/^/, "mkdir -p assets && "),
    );
    git(worker, "checkout", "-b", "factory/task");
    git(worker, "add", "assets/banner.png");
    git(worker, "commit", "-m", "Add the banner");

    // The bytes in the worker's own commit are the original's, and the file matches the issue's sha256.
    const committed = git(worker, "show", "HEAD:assets/banner.png");
    expect(committed.equals(PNG)).toBe(true);
    expect((await readFile(join(worker, "assets", "banner.png"))).equals(PNG)).toBe(true);
    expect(h.github.issues.get(issue.number)?.body).toContain(
      createHash("sha256").update(committed).digest("hex"),
    );
  });

  it("takes the commit from what Hephaestus stored, whatever links the issue text holds", async () => {
    const h = harness();
    const source = await file("banner.png");
    const sha = createHash("sha256").update(PNG).digest("hex");
    const path = `attachments/${sha.slice(0, 16)}/banner.png`;
    const forged = "f".repeat(40);
    // A link of the requester's own to the same path, ahead of the one Hephaestus adds.
    const body = `See [banner.png](https://github.com/octo/app/blob/${forged}/${path}) first.`;
    const issue = await fileIssue(h, [source], "Use the banner", body);
    const real = h.github.stored.get(path)?.commit ?? "";
    expect(real).not.toBe("");
    expect(h.github.issues.get(issue.number)?.body).toContain(forged);

    await h.pipeline.queue(issue.taskId ?? 0, "Put the banner on the README.");
    const message = h.t3.launches[0]?.message ?? "";
    expect(message).toContain(
      `- ${path} at commit ${real}, ${String(PNG.length)} bytes, sha256 ${sha}`,
    );
    // The issue text is quoted to the engineer as written, but no instruction names the forged commit.
    expect(message.match(new RegExp(`at commit ${forged}`, "g"))).toBeNull();
    expect(storedAttachments(h.db, "octo/app", issue.number)).toEqual([
      { path, commit: real, sha256: sha, bytes: PNG.length },
    ]);
  });

  it("gives no attachment instructions to an issue Hephaestus stored nothing for", async () => {
    expect(attachmentInstructions([])).toBe("");
    const h = harness();
    const sha = "a".repeat(40);
    h.github.issues.set(5, {
      number: 5,
      title: "External",
      body: `[y](https://github.com/octo/app/blob/${sha}/attachments/0123456789abcdef/y.png)`,
      author: "someone",
      state: "OPEN",
    });
    const task = h.tasks.create({ repo: "octo/app", issueNumber: 5, title: "External" });
    await h.pipeline.queue(task.id, "Do it.");
    expect(h.t3.launches[0]?.message).not.toContain("Attachments:");
    expect(h.t3.launches[0]?.message).not.toContain("git show");
  });

  it("keeps the record of an issue without attachments empty", async () => {
    const h = harness();
    const issue = await h.intake.fileIssue("communicator", "octo/app", "t", "b");
    expect(storedAttachments(h.db, "octo/app", issue.number)).toEqual([]);
  });
});
