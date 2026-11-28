/**
 * Read-only project context for the chat agent: each factory project's README and the docs it
 * keeps under docs/, read from GitHub's default branch. The source can only read, so nothing here
 * can change a repo or run its code.
 */
export interface ProjectDocsSource {
  /** The README on the default branch, or undefined when the repo has none. */
  readme(repo: string): Promise<string | undefined>;
  /** Paths of the files directly under docs/ on the default branch; empty when there is no docs/. */
  docs(repo: string): Promise<string[]>;
  /** One file's text on the default branch, or undefined when it does not exist. */
  file(repo: string, path: string): Promise<string | undefined>;
}

/** The most README text one project gives, so a long README cannot crowd out the conversation. */
export const MAX_README_CHARS = 16_000;
/** The most text one doc gives. */
export const MAX_DOC_CHARS = 24_000;
/** The most docs listed for one project. */
export const MAX_DOCS_LISTED = 50;
/** The most README text all projects give together; each project gets an equal share. */
export const MAX_TOTAL_CHARS = 48_000;
/**
 * How long a project's README and docs list are reused. Each read after this comes from the
 * default branch again, so a merged change reaches the chat agent within this time.
 */
export const CONTEXT_TTL_MS = 10 * 60_000;

/** Docs the chat agent can read: Markdown and plain text, which carry the project's own words. */
const DOC_FILE = /\.(md|markdown|mdx|txt|rst)$/i;

export interface ProjectSummary {
  repo: string;
  /** The README's text, cut to fit; null when the repo has none or it could not be read. */
  readme: string | null;
  readme_truncated: boolean;
  /** Docs under docs/ that `doc` can read. */
  docs: string[];
  /** Why the context could not be read, when it could not. */
  error?: string;
}

export interface ProjectDoc {
  repo: string;
  path: string;
  text: string;
  truncated: boolean;
}

function cut(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return {
    text: `${text.slice(0, limit)}\n[cut: the rest is longer than ${String(limit)} characters]`,
    truncated: true,
  };
}

function reason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
}

interface Cached {
  at: number;
  readme: string | undefined;
  docs: string[];
}

export class ProjectContext {
  private readonly cache = new Map<string, Cached>();
  private readonly now: () => number;

  constructor(
    private readonly source: ProjectDocsSource,
    /** The deployed config's project repos. */
    private readonly projects: () => string[],
    now?: () => number,
  ) {
    this.now = now ?? Date.now;
  }

  /** The config's own spelling of a factory project, or an error naming a repo that is not one. */
  private project(repo: string): string {
    const found = this.projects().find((name) => name.toLowerCase() === repo.toLowerCase());
    if (found === undefined) throw new Error(`${repo} is not a factory project.`);
    return found;
  }

  private async read(repo: string): Promise<Cached> {
    const cached = this.cache.get(repo);
    if (cached !== undefined && this.now() - cached.at < CONTEXT_TTL_MS) return cached;
    const [readme, docs] = await Promise.all([this.source.readme(repo), this.source.docs(repo)]);
    const fresh = {
      at: this.now(),
      readme,
      docs: docs
        .filter((path) => DOC_FILE.test(path))
        .sort()
        .slice(0, MAX_DOCS_LISTED),
    };
    this.cache.set(repo, fresh);
    return fresh;
  }

  /**
   * Every factory project's README and docs list, or one project's. A project whose context
   * cannot be read is listed with the reason, and the others are still given.
   */
  async summaries(repo?: string): Promise<ProjectSummary[]> {
    const repos = repo === undefined ? this.projects() : [this.project(repo)];
    const share = Math.min(
      MAX_README_CHARS,
      Math.floor(MAX_TOTAL_CHARS / Math.max(1, repos.length)),
    );
    return Promise.all(
      repos.map(async (name): Promise<ProjectSummary> => {
        try {
          const { readme, docs } = await this.read(name);
          const text = readme === undefined ? undefined : cut(readme, share);
          return {
            repo: name,
            readme: text?.text ?? null,
            readme_truncated: text?.truncated ?? false,
            docs,
          };
        } catch (error) {
          return {
            repo: name,
            readme: null,
            readme_truncated: false,
            docs: [],
            error: `Could not read the project's README or docs from GitHub: ${reason(error)}`,
          };
        }
      }),
    );
  }

  /** One doc that the project's docs list names, read from the default branch. */
  async doc(repo: string, path: string): Promise<ProjectDoc> {
    const name = this.project(repo);
    const { docs } = await this.read(name);
    if (!docs.includes(path)) {
      throw new Error(
        `${path} is not one of ${name}'s docs. Pass a path from the project's docs list.`,
      );
    }
    const text = await this.source.file(name, path);
    if (text === undefined) throw new Error(`${path} no longer exists in ${name}.`);
    return { repo: name, path, ...cut(text, MAX_DOC_CHARS) };
  }
}
