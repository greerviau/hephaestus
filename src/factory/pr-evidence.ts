import { createHash } from "node:crypto";
import type { GitHub } from "./github.js";

/** A screenshot on a PR. `key` names it in the dashboard's address for it. */
export interface EvidenceImage {
  key: string;
  src: string;
  alt: string;
}

/** A link on a PR to evidence that is not an image, such as a log or a CI run. */
export interface EvidenceLink {
  href: string;
  label: string;
}

export interface Evidence {
  images: EvidenceImage[];
  links: EvidenceLink[];
}

export interface EvidenceImageData {
  contentType: string;
  data: Buffer;
}

export type Download = (url: string) => Promise<Response>;

/** How long a PR's evidence is kept before it is read again. GitHub's signed image addresses last five minutes. */
export const EVIDENCE_TTL_MS = 60_000;
/** The largest image the dashboard serves. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
/** How many PRs' evidence is kept at once. */
const MAX_CACHED = 50;
const MAX_LABEL = 60;

/** File types a link to counts as evidence: logs, test output, recordings, reports. */
const EVIDENCE_EXTENSIONS = /\.(?:txt|log|out|json|xml|csv|html?|har|mp4|webm|mov|gif|pdf|zip)$/i;

/**
 * Hosts an image is downloaded from without a login. GitHub proxies outside
 * images through camo, so a PR cannot make the host fetch from anywhere else.
 */
const DOWNLOAD_HOSTS = new Set([
  "private-user-images.githubusercontent.com",
  "user-images.githubusercontent.com",
  "camo.githubusercontent.com",
  "objects.githubusercontent.com",
]);

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39);/gi, (whole, name: string) => {
    const lower = name.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(Number(lower.slice(1)));
    return (
      ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[lower] ??
      whole
    );
  });
}

function attribute(tag: string, name: string): string | undefined {
  const found = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  return found === null ? undefined : decode(found[1] ?? found[2] ?? "");
}

function https(value: string | undefined): URL | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

/** The signature in a signed address changes on every read; the image it names does not. */
function imageKey(url: URL): string {
  const stable =
    url.hostname === "private-user-images.githubusercontent.com"
      ? `${url.origin}${url.pathname}`
      : url.href;
  return createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

function fileName(url: URL): string {
  return decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? url.hostname);
}

function isEvidenceLink(url: URL): boolean {
  if (url.hostname === "gist.github.com") return true;
  if (url.hostname === "github.com") {
    if (/^\/[^/]+\/[^/]+\/actions\/runs\/\d+/.test(url.pathname)) return true;
    if (url.pathname.startsWith("/user-attachments/files/")) return true;
  }
  return EVIDENCE_EXTENSIONS.test(url.pathname);
}

function short(text: string): string {
  return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 3)}...` : text;
}

/**
 * The screenshots and evidence links in a PR's body and comments, as GitHub
 * renders them. A link counts when it points at a CI run, a gist, an uploaded
 * file, or a file such as a log, so issue references and mentions do not.
 */
export function extractEvidence(htmls: readonly string[]): Evidence {
  const images: EvidenceImage[] = [];
  const links: EvidenceLink[] = [];
  const seen = new Set<string>();
  for (const html of htmls) {
    for (const [tag] of html.matchAll(/<img\b[^>]*>/gi)) {
      if (/\bemoji\b/i.test(attribute(tag, "class") ?? "")) continue;
      const url = https(attribute(tag, "src"));
      if (url === undefined) continue;
      const key = imageKey(url);
      if (seen.has(key)) continue;
      seen.add(key);
      images.push({ key, src: url.href, alt: (attribute(tag, "alt") ?? "").trim() });
    }
    for (const [tag] of html.matchAll(/<video\b[^>]*>/gi)) {
      const url = https(attribute(tag, "src"));
      if (url === undefined || seen.has(url.href)) continue;
      seen.add(url.href);
      links.push({ href: url.href, label: short(`Recording ${fileName(url)}`) });
    }
    for (const [, open = "", inner = ""] of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      // A link around an image is the image's full-size link, listed with the image.
      if (/<img\b/i.test(inner)) continue;
      const url = https(attribute(open, "href"));
      if (url === undefined || !isEvidenceLink(url) || seen.has(url.href)) continue;
      seen.add(url.href);
      const text = decode(inner.replace(/<[^>]*>/g, ""))
        .replace(/\s+/g, " ")
        .trim();
      links.push({ href: url.href, label: short(text === "" ? fileName(url) : text) });
    }
  }
  return { images, links };
}

/** The image type the bytes start with. The name and header a server gives are not trusted. */
function sniff(data: Buffer): string | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (
    data.subarray(0, 4).toString("latin1") === "RIFF" &&
    data.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "image/webp";
  return undefined;
}

/** `owner/name`, ref, and path of a file in a repo that an image address names, or undefined. */
function repoFile(url: URL): { repo: string; ref: string; path: string } | undefined {
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (url.hostname === "github.com" && (parts[2] === "blob" || parts[2] === "raw")) {
    const [owner, name, , ref, ...path] = parts;
    if (owner && name && ref && path.length > 0)
      return { repo: `${owner}/${name}`, ref, path: path.join("/") };
  }
  if (url.hostname === "raw.githubusercontent.com") {
    const [owner, name, ref, ...path] = parts;
    if (owner && name && ref && path.length > 0)
      return { repo: `${owner}/${name}`, ref, path: path.join("/") };
  }
  return undefined;
}

const defaultDownload: Download = (url) =>
  fetch(url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });

export interface PullRequestEvidenceOptions {
  github: Pick<GitHub, "pullRequestHtml" | "fileAt">;
  download?: Download;
  now?: () => number;
}

/**
 * Reads the evidence on a task's PR for the task page, and fetches its images
 * for the dashboard to serve: the page allows images only from itself, and a
 * private repo's images need the host's gh login or GitHub's signed address.
 */
export class PullRequestEvidence {
  private readonly cache = new Map<string, { at: number; read: Promise<Evidence> }>();
  private readonly download: Download;
  private readonly now: () => number;

  constructor(private readonly options: PullRequestEvidenceOptions) {
    this.download = options.download ?? defaultDownload;
    this.now = options.now ?? Date.now;
  }

  /** The PR's evidence, read again when `fresh` or when the kept copy is a minute old. */
  list(repo: string, number: number, fresh = false): Promise<Evidence> {
    const id = `${repo}#${String(number)}`;
    const kept = this.cache.get(id);
    if (!fresh && kept !== undefined && this.now() - kept.at < EVIDENCE_TTL_MS) return kept.read;
    const read = this.options.github.pullRequestHtml(repo, number).then(extractEvidence);
    this.cache.delete(id);
    this.cache.set(id, { at: this.now(), read });
    read.catch(() => {
      if (this.cache.get(id)?.read === read) this.cache.delete(id);
    });
    if (this.cache.size > MAX_CACHED) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return read;
  }

  /** The image `key` names on the PR, or undefined when it is not there or cannot be fetched as an image. */
  async image(repo: string, number: number, key: string): Promise<EvidenceImageData | undefined> {
    const found = (await this.list(repo, number)).images.find((image) => image.key === key);
    if (found === undefined) return undefined;
    const url = new URL(found.src);
    let data: Buffer | undefined;
    try {
      const file = repoFile(url);
      if (file !== undefined) {
        // The gh login reaches only the PR's own repo, whatever a comment links to.
        if (file.repo.toLowerCase() !== repo.toLowerCase()) return undefined;
        data = await this.options.github.fileAt(repo, file.ref, file.path, MAX_IMAGE_BYTES);
      } else if (
        DOWNLOAD_HOSTS.has(url.hostname) ||
        (url.hostname === "github.com" && url.pathname.startsWith("/user-attachments/assets/"))
      ) {
        const response = await this.download(url.href);
        if (!response.ok) return undefined;
        if (Number(response.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) return undefined;
        data = Buffer.from(await response.arrayBuffer());
      }
    } catch (error) {
      console.error(`Fetching an evidence image for ${repo}#${String(number)} failed`, error);
      return undefined;
    }
    if (data === undefined || data.length > MAX_IMAGE_BYTES) return undefined;
    const contentType = sniff(data);
    return contentType === undefined ? undefined : { contentType, data };
  }
}
