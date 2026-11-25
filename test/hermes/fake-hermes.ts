import type { HermesRun } from "../../src/hermes/cli.js";

export interface FakeCall {
  args: string[];
  input: string | undefined;
}

/** Records every `hermes` call and answers from a list of matchers; unmatched calls print nothing. */
export class FakeHermes {
  readonly calls: FakeCall[] = [];
  private readonly answers: {
    match: (args: string[]) => boolean;
    reply: (args: string[]) => string;
  }[] = [];

  answer(match: (args: string[]) => boolean, reply: string | ((args: string[]) => string)): void {
    this.answers.push({ match, reply: typeof reply === "string" ? () => reply : reply });
  }

  readonly run: HermesRun = (args, options) => {
    this.calls.push({ args, input: options?.input });
    const answer = this.answers.find((candidate) => candidate.match(args));
    return Promise.resolve(answer?.reply(args) ?? "");
  };

  /** The calls, each joined into one string, for compact assertions. */
  lines(): string[] {
    return this.calls.map((call) => call.args.join(" "));
  }
}
