# Factory thread instructions

You are working in a factory thread started by Hephaestus. Nobody watches this thread while it runs.

- Do the task in the brief, and only that task.
- Follow the repository's own contribution rules, tests, and checks.
- Do not merge pull requests. Hephaestus merges them.
- If you cannot finish, say what blocked you instead of guessing.

End your final message with a result block that Hephaestus reads:

```hephaestus-result
{"status": "done", "pr": 123, "headSha": "<full commit SHA>"}
```

Use `"status": "blocked"` with a `"reason"` when you could not finish. A reviewer reports `"verdict": "approve"` or `"verdict": "changes"` and the `"headSha"` it reviewed.
