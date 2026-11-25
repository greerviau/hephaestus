import { readFileSync, renameSync, writeFileSync } from "node:fs";

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Named secrets in a JSON file readable only by the owner. Config versions refer to them by name. */
export class SecretsFile {
  constructor(private readonly path: string) {}

  get(name: string): string | undefined {
    const secrets = this.read();
    return Object.hasOwn(secrets, name) ? secrets[name] : undefined;
  }

  names(): string[] {
    return Object.keys(this.read()).sort();
  }

  set(name: string, value: string): void {
    if (!NAME.test(name)) throw new Error(`Invalid secret name: ${name}`);
    this.write({ ...this.read(), [name]: value });
  }

  delete(name: string): void {
    const secrets = this.read();
    Reflect.deleteProperty(secrets, name);
    this.write(secrets);
  }

  private read(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, string>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private write(secrets: Record<string, string>): void {
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
