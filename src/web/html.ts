const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes text for use in HTML content and attribute values. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

/** A complete HTML document. `title` is escaped; `body` must already be safe HTML. */
export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} - Hephaestus</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0; }
  header { display: flex; align-items: center; gap: 1rem; padding: 0.75rem 1rem; border-bottom: 1px solid #8884; }
  header nav { flex: 1; display: flex; gap: 1rem; }
  main { padding: 1rem; max-width: 72rem; }
  form.login { display: grid; gap: 0.5rem; max-width: 20rem; margin: 4rem auto; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 0.25rem 0.5rem; border-bottom: 1px solid #8884; vertical-align: top; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }
  textarea { width: 100%; min-height: 24rem; font-family: ui-monospace, monospace; }
  .actions { display: flex; gap: 0.5rem; margin: 1rem 0; }
  .error { color: #c33; }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

const NAV = [
  ["/", "Overview"],
  ["/environments", "Environments"],
  ["/settings", "Settings"],
] as const;

/** A signed-in page with the navigation bar. `body` must already be safe HTML. */
export function layout(title: string, body: string): string {
  const links = NAV.map(([href, label]) => `<a href="${href}">${label}</a>`).join("");
  return page(
    title,
    `<header>
  <strong>Hephaestus</strong>
  <nav>${links}</nav>
  <form method="post" action="/logout"><button type="submit">Sign out</button></form>
</header>
<main>
${body}
</main>`,
  );
}
