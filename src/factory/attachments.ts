import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

/** The branch in the target repo that holds every attachment; nothing else is committed to it. */
export const ATTACHMENT_BRANCH = "hephaestus/attachments";
/** The largest file one attachment may be. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** The most attachments one `file_issue` call may carry. */
export const MAX_ATTACHMENTS = 10;

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

/** A file the request carried that cannot be attached; the message names it. */
export class AttachmentError extends Error {}

export interface Attachment {
  /** The file's name as stored: the original with characters that need escaping in a URL replaced. */
  name: string;
  /** Where it lives on the attachments branch. The content hash in it makes a repeat upload land on the same path. */
  path: string;
  data: Buffer;
  sha256: string;
}

/** A stored attachment: its file and the commit that holds it. */
export interface StoredAttachment {
  attachment: Attachment;
  commit: string;
}

function storedName(file: string): string {
  const name = basename(file)
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(-100);
  // A name of dots or nothing would read as a directory.
  return /^\.*$/.test(name) ? "attachment" : name;
}

/** Whether `path` is `root` or inside it, by name alone. */
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Reads and checks every attachment before anything is written to GitHub.
 * Each must be an absolute path to a regular file inside `root`, the calling
 * role's Hermes cache, where the chat gateway puts the files a requester
 * sends; no other file on the host can be attached. A symbolic link is
 * refused, whether it is the file or a folder on the way to it, so a link
 * cannot lead out of the cache. The file is also within the size limit. The
 * first bad one fails the whole call, by name.
 */
export async function readAttachments(
  files: readonly string[],
  root: string | undefined,
): Promise<Attachment[]> {
  if (files.length > MAX_ATTACHMENTS) {
    throw new AttachmentError(
      `Too many attachments: ${String(files.length)}. A call takes at most ${String(MAX_ATTACHMENTS)}.`,
    );
  }
  let realRoot: string | undefined;
  try {
    if (root !== undefined) realRoot = await realpath(root);
  } catch {
    // The cache does not exist yet, so nothing can be in it.
  }
  const result: Attachment[] = [];
  for (const file of files) {
    const fail = (why: string): AttachmentError =>
      new AttachmentError(`Attachment ${file} ${why}. No issue was filed.`);
    if (/^https?:\/\//i.test(file)) throw fail("is a URL; only local file paths are supported");
    if (!isAbsolute(file)) throw fail("is not an absolute path");
    const outside = fail("is not in the chat attachment cache, so it cannot be attached");
    // By name first, so a path elsewhere on the host is refused without being looked at.
    const path = resolve(file);
    if (root === undefined || realRoot === undefined) throw outside;
    if (!within(resolve(root), path) && !within(realRoot, path)) throw outside;
    try {
      if (!within(realRoot, await realpath(path))) throw outside;
    } catch (error) {
      if (error === outside) throw error;
      const code = (error as { code?: string }).code;
      throw fail(code === "ENOENT" || code === "ENOTDIR" ? "does not exist" : "cannot be read");
    }
    let data: Buffer;
    let handle;
    try {
      // O_NOFOLLOW refuses a link as the file itself, and the open and the read share one file.
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      const code = (error as { code?: string }).code;
      throw fail(code === "ELOOP" ? "is a symbolic link" : "cannot be read");
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw fail("is not a regular file");
      if (info.size > MAX_ATTACHMENT_BYTES) {
        throw fail(
          `is ${String(info.size)} bytes, over the limit of ${String(MAX_ATTACHMENT_BYTES)} bytes`,
        );
      }
      data = await handle.readFile();
    } catch (error) {
      if (error instanceof AttachmentError) throw error;
      throw fail("cannot be read");
    } finally {
      await handle.close();
    }
    // The file may have grown between the check and the read.
    if (data.length > MAX_ATTACHMENT_BYTES) {
      throw fail(
        `is ${String(data.length)} bytes, over the limit of ${String(MAX_ATTACHMENT_BYTES)} bytes`,
      );
    }
    const sha256 = createHash("sha256").update(data).digest("hex");
    const name = storedName(file);
    result.push({ name, path: `attachments/${sha256.slice(0, 16)}/${name}`, data, sha256 });
  }
  return result;
}

function permalink(repo: string, stored: StoredAttachment): string {
  return `https://github.com/${repo}/blob/${stored.commit}/${stored.attachment.path}`;
}

/** The text an issue body gains: a stable link to each attachment, and a preview of each image. */
export function attachmentsSection(repo: string, stored: readonly StoredAttachment[]): string {
  const lines = [
    "## Attachments",
    "",
    `Files that came with the request, kept on the \`${ATTACHMENT_BRANCH}\` branch.`,
    "",
  ];
  for (const item of stored) {
    const { attachment } = item;
    const link = permalink(repo, item);
    lines.push(
      `- [${attachment.name}](${link}) - ${String(attachment.data.length)} bytes, sha256 \`${attachment.sha256}\``,
    );
    const extension = attachment.name.split(".").pop()?.toLowerCase() ?? "";
    if (IMAGE_EXTENSIONS.has(extension)) {
      lines.push("", `  ![${attachment.name}](${link}?raw=true)`);
    }
  }
  return lines.join("\n");
}

export function withAttachments(
  repo: string,
  body: string,
  stored: readonly StoredAttachment[],
): string {
  if (stored.length === 0) return body;
  const section = attachmentsSection(repo, stored);
  return body === "" ? section : `${body}\n\n${section}`;
}

export interface AttachmentRef {
  commit: string;
  path: string;
}

/** The attachments an issue body links, in order, each once. */
export function attachmentRefs(repo: string, body: string): AttachmentRef[] {
  const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `\\]\\(https://github\\.com/${escaped}/blob/([0-9a-f]{40})/(attachments/[0-9a-f]{16}/[A-Za-z0-9._-]+)\\)`,
    "gi",
  );
  const seen = new Set<string>();
  const refs: AttachmentRef[] = [];
  for (const match of body.matchAll(pattern)) {
    const [, commit, path] = match;
    if (commit === undefined || path === undefined || seen.has(path)) continue;
    seen.add(path);
    refs.push({ commit, path });
  }
  return refs;
}

/** What the engineer is told about an issue's attachments; empty when it has none. */
export function attachmentInstructions(repo: string, body: string): string {
  const refs = attachmentRefs(repo, body);
  if (refs.length === 0) return "";
  const list = refs.map((ref) => `- ${ref.path} at commit ${ref.commit}`).join("\n");
  return `

Attachments: the issue lists files that came with the request. Hephaestus stored them on the \`${ATTACHMENT_BRANCH}\` branch of origin, and these are their paths:

${list}

To get one, run \`git fetch origin ${ATTACHMENT_BRANCH}\`, then \`git show <commit>:<path> > <destination>\`, which writes the exact bytes. The issue gives each file's sha256 to check against. Commit the files into your branch where the task says. Do not push to \`${ATTACHMENT_BRANCH}\`.`;
}
