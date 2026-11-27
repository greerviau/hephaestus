import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

/** The branch in the target repo that holds every attachment; nothing else is committed to it. */
export const ATTACHMENT_BRANCH = "hephaestus/attachments";
/** The largest file one attachment may be. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** The most attachments one `file_issue` call may carry. */
export const MAX_ATTACHMENTS = 10;

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

/** A file the request carried that cannot be attached; the message names it. */
export class AttachmentError extends Error {}

/** Git's identity for a file's bytes: the blob id GitHub shows, so stored content can be compared without downloading it. */
export function blobSha(data: Buffer): string {
  return createHash("sha1")
    .update(`blob ${String(data.length)}\0`)
    .update(data)
    .digest("hex");
}

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

/** The path is open, but it is not a regular file. */
export class NotRegularError extends Error {}

/**
 * Opens a file for reading without following a link at its end and without
 * waiting for a writer, which a pipe would make the open do forever, and
 * closes it again unless it is a regular file. The check is on the open
 * descriptor, so it holds however the path changed since it was looked at.
 */
export async function openRegularFile(path: string): Promise<FileHandle> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new NotRegularError(`${path} is not a regular file`);
  } catch (error) {
    await handle.close();
    throw error;
  }
  return handle;
}

const CHUNK_BYTES = 64 * 1024;

/**
 * Reads a file to its end from an open descriptor, or returns undefined once it
 * has more than `limit` bytes. A file can grow after it was checked, so the
 * size seen earlier says nothing here: no more than `limit + 1` bytes are ever
 * read or held, however much the file holds.
 */
export async function readBounded(
  handle: {
    read(buffer: Buffer, offset: number, length: number): Promise<{ bytesRead: number }>;
  },
  limit: number,
): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= limit) {
    const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, limit + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length);
    if (bytesRead === 0) return Buffer.concat(chunks, total);
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  return undefined;
}

/**
 * Reads and checks every attachment before anything is written to GitHub.
 * Each must be an absolute path to a regular file inside one of `roots`, the
 * calling role's Hermes media cache folders, where the chat gateway puts the
 * files a requester sends; no other file on the host can be attached. No
 * symbolic link is followed: the path is walked one name at a time from the
 * cache folder, and a link as the file or as any folder on the way is refused,
 * even when it points inside the cache. The file is opened without blocking,
 * so a pipe or device cannot stall the call, and it must be a regular file
 * within the size limit. The first bad one fails the whole call, by name.
 */
export async function readAttachments(
  files: readonly string[],
  roots: readonly string[],
  /** Runs once a file has passed its checks and before it is read; tests use it to change the file there. */
  afterCheck?: (path: string) => void | Promise<void>,
): Promise<Attachment[]> {
  if (files.length > MAX_ATTACHMENTS) {
    throw new AttachmentError(
      `Too many attachments: ${String(files.length)}. A call takes at most ${String(MAX_ATTACHMENTS)}.`,
    );
  }
  // A folder that does not exist holds nothing. The root itself is the operator's, so it may be a link.
  const folders: { named: string; real: string }[] = [];
  for (const root of roots) {
    try {
      folders.push({ named: resolve(root), real: await realpath(root) });
    } catch {
      // Not there.
    }
  }
  const result: Attachment[] = [];
  for (const file of files) {
    const fail = (why: string): AttachmentError =>
      new AttachmentError(`Attachment ${file} ${why}. No issue was filed.`);
    if (/^https?:\/\//i.test(file)) throw fail("is a URL; only local file paths are supported");
    if (!isAbsolute(file)) throw fail("is not an absolute path");
    // By name first, so a path elsewhere on the host is refused without being looked at.
    const path = resolve(file);
    let folder: { real: string; rel: string } | undefined;
    for (const candidate of folders) {
      for (const base of [candidate.named, candidate.real]) {
        if (folder === undefined && within(base, path)) {
          folder = { real: candidate.real, rel: relative(base, path) };
        }
      }
    }
    if (folder === undefined)
      throw fail("is not in the chat attachment cache, so it cannot be attached");
    if (folder.rel === "") throw fail("is not a regular file");
    const names = folder.rel.split(sep);
    let current = folder.real;
    let seen;
    for (const [index, name] of names.entries()) {
      current = join(current, name);
      try {
        seen = await lstat(current);
      } catch (error) {
        const code = (error as { code?: string }).code;
        throw fail(code === "ENOENT" || code === "ENOTDIR" ? "does not exist" : "cannot be read");
      }
      if (seen.isSymbolicLink()) throw fail("is a symbolic link, or is reached through one");
      const last = index === names.length - 1;
      if (last ? !seen.isFile() : !seen.isDirectory()) {
        throw fail(last ? "is not a regular file" : "does not exist");
      }
    }
    let data: Buffer;
    let handle;
    try {
      handle = await openRegularFile(current);
    } catch (error) {
      if (error instanceof NotRegularError) throw fail("is not a regular file");
      const code = (error as { code?: string }).code;
      throw fail(code === "ELOOP" ? "is a symbolic link" : "cannot be read");
    }
    try {
      const info = await handle.stat();
      // The file opened is the one checked, and where the open landed is inside the cache.
      if (seen === undefined || info.ino !== seen.ino || info.dev !== seen.dev) {
        throw fail("changed while it was read");
      }
      const landed = await realpath(`/proc/self/fd/${String(handle.fd)}`).catch(() => undefined);
      if (landed !== undefined && !within(folder.real, landed)) {
        throw fail("is not in the chat attachment cache, so it cannot be attached");
      }
      if (info.size > MAX_ATTACHMENT_BYTES) {
        throw fail(
          `is ${String(info.size)} bytes, over the limit of ${String(MAX_ATTACHMENT_BYTES)} bytes`,
        );
      }
      await afterCheck?.(current);
      // From the descriptor that was checked, and never more than one byte past the limit.
      const read = await readBounded(handle, MAX_ATTACHMENT_BYTES);
      if (read === undefined) {
        throw fail(`is over the limit of ${String(MAX_ATTACHMENT_BYTES)} bytes`);
      }
      data = read;
    } catch (error) {
      if (error instanceof AttachmentError) throw error;
      throw fail("cannot be read");
    } finally {
      await handle.close();
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
