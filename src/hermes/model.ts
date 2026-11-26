/**
 * The default model a Hermes config.yaml names, or undefined when it names
 * none. Hermes takes the model from `model.default`, from its alias
 * `model.model`, or from a plain `model: <name>`. This reads just those keys,
 * tolerating comments, quotes, and CRLF line endings; it is not a YAML parser.
 */
export function hermesModel(text: string): string | undefined {
  return hermesModelSettings(text).model;
}

/** The model and provider a Hermes config.yaml names, each undefined when it names none. */
export function hermesModelSettings(text: string): { model?: string; provider?: string } {
  const block = hermesModelBlock(text);
  const model = block.default ?? block.model;
  return {
    ...(model === undefined ? {} : { model }),
    ...(block.provider === undefined ? {} : { provider: block.provider }),
  };
}

/**
 * Every scalar key in the `model:` block, such as default, provider,
 * base_url, api_key, and api_mode; a plain `model: <name>` reads as default.
 */
export function hermesModelBlock(text: string): Record<string, string> {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((line) => /^["']?model["']?[ \t]*:/.test(line));
  if (start === -1) return {};
  const inline = scalar(lines[start]?.replace(/^["']?model["']?[ \t]*:/, "") ?? "");
  if (inline !== undefined) return { default: inline };
  const found: Record<string, string> = {};
  let indent: number | undefined;
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const depth = line.length - line.trimStart().length;
    // The block ends at the next top-level key.
    if (depth === 0) break;
    indent ??= depth;
    // Only the block's own keys count, not keys nested deeper inside it.
    if (depth !== indent) continue;
    const match = /^\s*["']?([A-Za-z0-9_]+)["']?[ \t]*:(.*)$/.exec(line);
    if (match?.[1] === undefined) continue;
    const value = scalar(match[2] ?? "");
    if (value !== undefined) found[match[1]] ??= value;
  }
  return found;
}

/** A YAML scalar value, or undefined when it is empty, null, or a block opener. */
function scalar(raw: string): string | undefined {
  let value = raw.trim();
  if (value.startsWith('"') || value.startsWith("'")) {
    const quote = value[0] ?? "";
    const end = value.indexOf(quote, 1);
    value = end === -1 ? value.slice(1) : value.slice(1, end);
  } else {
    value = value.replace(/\s+#.*$/, "").trim();
  }
  if (
    value === "" ||
    value.startsWith("#") ||
    value === "~" ||
    value === "null" ||
    value === "|" ||
    value === ">"
  ) {
    return undefined;
  }
  return value;
}
