import { describe, expect, it } from "vitest";
import { GitHub } from "../../src/factory/github.js";
import { PullRequestEvidence, extractEvidence } from "../../src/factory/pr-evidence.js";
import type { CommandRun } from "../../src/workers/config-repo.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);

const BLOB = "https://github.com/octo/app/blob/9208c8e92b4140dfccb89b08cf65c41c47e70c6e";

/** A PR body as GitHub renders it in `body_html`, with the shapes agents attach. */
const BODY = `<p>Closes <a class="issue-link js-issue-link" href="https://github.com/octo/app/issues/7">#7</a>, thanks <a class="user-mention" href="https://github.com/someone">@someone</a> <g-emoji class="g-emoji" alias="tada"><img class="emoji" alt=":tada:" src="https://github.githubassets.com/images/icons/emoji/unicode/1f389.png"></g-emoji></p>
<h2>Screenshots</h2>
<p><a target="_blank" rel="noopener noreferrer" href="${BLOB}/models-desktop.png?raw=true"><img src="${BLOB}/models-desktop.png?raw=true" alt="Models &amp; tab" style="max-width: 100%;"></a></p>
<p><a target="_blank" rel="noopener noreferrer" href="https://private-user-images.githubusercontent.com/1/abc-def.png?jwt=one"><img src="https://private-user-images.githubusercontent.com/1/abc-def.png?jwt=one" alt="Mobile" style="max-width: 100%;"></a></p>
<p>Logs: <a href="https://github.com/octo/app/actions/runs/123">CI run</a>, <a href="${BLOB}/test-output.txt">test-output.txt</a>, <a href="https://example.com/docs">the docs</a></p>`;

describe("extractEvidence", () => {
  it("finds the screenshots and the log links in a PR body, and nothing else", () => {
    const found = extractEvidence([BODY]);

    expect(found.images.map(({ src, alt }) => ({ src, alt }))).toEqual([
      { src: `${BLOB}/models-desktop.png?raw=true`, alt: "Models & tab" },
      {
        src: "https://private-user-images.githubusercontent.com/1/abc-def.png?jwt=one",
        alt: "Mobile",
      },
    ]);
    expect(found.links).toEqual([
      { href: "https://github.com/octo/app/actions/runs/123", label: "CI run" },
      { href: `${BLOB}/test-output.txt`, label: "test-output.txt" },
    ]);
  });

  it("finds nothing in a PR with no evidence", () => {
    expect(extractEvidence(["<p>Closes #7. Tests pass.</p>", ""])).toEqual({
      images: [],
      links: [],
    });
    expect(extractEvidence([])).toEqual({ images: [], links: [] });
  });

  it("reads the comments too, and lists an image shown twice once", () => {
    const shot = `<img src="${BLOB}/a.png?raw=true" alt="a">`;
    const found = extractEvidence([shot, `<p>Again:</p>${shot}`]);
    expect(found.images).toHaveLength(1);
  });

  it("keeps an image's key when only its signature changes, so a cached thumbnail stays valid", () => {
    const first = extractEvidence([
      '<img src="https://private-user-images.githubusercontent.com/1/abc.png?jwt=one">',
    ]);
    const second = extractEvidence([
      '<img src="https://private-user-images.githubusercontent.com/1/abc.png?jwt=two">',
    ]);
    expect(first.images[0]?.key).toMatch(/^[0-9a-f]{16}$/);
    expect(second.images[0]?.key).toBe(first.images[0]?.key);
  });
});

/** A gh that answers the PR, its comments, and files in octo/app at one commit. */
function fakeGh(files: Record<string, Buffer>, calls: string[][] = []): CommandRun {
  return (_file, args) => {
    calls.push(args);
    const url = args.find((arg) => arg.startsWith("repos/")) ?? "";
    if (url === "repos/octo/app/pulls/5") return Promise.resolve(`${JSON.stringify(BODY)}\n`);
    if (url.startsWith("repos/octo/app/issues/5/comments")) {
      return Promise.resolve(`${JSON.stringify("<p>Looks good</p>")}\n`);
    }
    const contents = /^repos\/octo\/app\/contents\/(.+)\?ref=([0-9a-f]+)$/.exec(url);
    if (contents !== null) {
      const data = files[contents[1] ?? ""];
      return data === undefined
        ? Promise.reject(new Error("gh failed: Not Found (HTTP 404)"))
        : Promise.resolve(JSON.stringify({ sha: `sha-${contents[1] ?? ""}`, size: data.length }));
    }
    const blob = /^repos\/octo\/app\/git\/blobs\/sha-(.+)$/.exec(url);
    const data = files[blob?.[1] ?? ""];
    if (data !== undefined) {
      return Promise.resolve(
        JSON.stringify({ content: data.toString("base64"), encoding: "base64" }),
      );
    }
    return Promise.reject(new Error(`unexpected call: ${args.join(" ")}`));
  };
}

describe("PullRequestEvidence", () => {
  it("reads the PR body and its comments through gh, rendered so private images carry a signed address", async () => {
    const calls: string[][] = [];
    const evidence = new PullRequestEvidence({ github: new GitHub("gh", fakeGh({}, calls)) });

    const found = await evidence.list("octo/app", 5);

    expect(found.images).toHaveLength(2);
    expect(found.links).toHaveLength(2);
    for (const call of calls) expect(call).toContain("Accept: application/vnd.github.full+json");
  });

  it("reads a screenshot committed to a private repo with the host's gh login", async () => {
    const downloads: string[] = [];
    const evidence = new PullRequestEvidence({
      github: new GitHub("gh", fakeGh({ "models-desktop.png": PNG })),
      download: (url) => {
        downloads.push(url);
        return Promise.resolve(new Response(null, { status: 404 }));
      },
    });
    const [image] = (await evidence.list("octo/app", 5)).images;

    const found = await evidence.image("octo/app", 5, image?.key ?? "");

    expect(found).toEqual({ contentType: "image/png", data: PNG });
    expect(downloads).toEqual([]);
  });

  it("downloads a signed private upload without the gh login", async () => {
    const downloads: string[] = [];
    const evidence = new PullRequestEvidence({
      github: new GitHub("gh", fakeGh({})),
      download: (url) => {
        downloads.push(url);
        return Promise.resolve(new Response(JPEG, { headers: { "content-type": "image/jpeg" } }));
      },
    });
    const image = (await evidence.list("octo/app", 5)).images[1];

    expect(await evidence.image("octo/app", 5, image?.key ?? "")).toEqual({
      contentType: "image/jpeg",
      data: JPEG,
    });
    expect(downloads).toEqual([
      "https://private-user-images.githubusercontent.com/1/abc-def.png?jwt=one",
    ]);
  });

  it("refuses an image that is not one, an unknown key, and a host outside GitHub", async () => {
    const downloads: string[] = [];
    const html =
      '<img src="https://evil.example/x.png"><img src="https://camo.githubusercontent.com/a/b">';
    const evidence = new PullRequestEvidence({
      github: {
        pullRequestHtml: () => Promise.resolve([html]),
        fileAt: () => Promise.reject(new Error("no")),
      },
      download: (url) => {
        downloads.push(url);
        return Promise.resolve(
          new Response("<svg onload=alert(1)>", { headers: { "content-type": "image/svg+xml" } }),
        );
      },
    });
    const images = (await evidence.list("octo/app", 5)).images;

    expect(await evidence.image("octo/app", 5, images[0]?.key ?? "")).toBeUndefined();
    expect(await evidence.image("octo/app", 5, images[1]?.key ?? "")).toBeUndefined();
    expect(await evidence.image("octo/app", 5, "0000000000000000")).toBeUndefined();
    expect(downloads).toEqual(["https://camo.githubusercontent.com/a/b"]);
  });

  it("reads the PR once a minute however often the page reloads, unless asked to read again", async () => {
    let reads = 0;
    let now = 0;
    const evidence = new PullRequestEvidence({
      github: {
        pullRequestHtml: () => {
          reads += 1;
          return Promise.resolve([""]);
        },
        fileAt: () => Promise.reject(new Error("no")),
      },
      now: () => now,
    });

    await Promise.all([evidence.list("octo/app", 5), evidence.list("octo/app", 5)]);
    now = 59_000;
    await evidence.list("octo/app", 5);
    expect(reads).toBe(1);
    await evidence.list("octo/app", 5, true);
    expect(reads).toBe(2);
    now = 200_000;
    await evidence.list("octo/app", 5);
    expect(reads).toBe(3);
  });
});
