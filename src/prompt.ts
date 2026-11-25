import { createInterface } from "node:readline";

/**
 * Reads one line as a password. On a terminal it prompts without echo;
 * otherwise it reads the first line of stdin, so scripts can pipe it in.
 */
export async function readPassword(prompt: string): Promise<string> {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) {
    const lines = createInterface({ input: stdin, crlfDelay: Infinity });
    for await (const line of lines) {
      lines.close();
      return line;
    }
    throw new Error("No password on stdin.");
  }
  stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  try {
    return await new Promise<string>((resolve, reject) => {
      let password = "";
      const onData = (chunk: string): void => {
        for (const char of chunk) {
          if (char === "\r" || char === "\n") {
            stdin.off("data", onData);
            stderr.write("\n");
            resolve(password);
            return;
          }
          if (char === "\u0003") {
            stdin.off("data", onData);
            reject(new Error("Cancelled."));
            return;
          }
          if (char === "\u007f" || char === "\b") password = password.slice(0, -1);
          else password += char;
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}
