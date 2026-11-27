---
name: review-pr
description: Use in a factory review thread to review a pull request at one head commit and decide whether to approve it or ask for changes.
---

# review-pr

Review the change at the head commit you were given, prove what you find, and give a verdict the factory can act on. You never push, comment on GitHub, approve on GitHub, or merge.

## Procedure

1. Scope. Check out the head commit, find the base with `git merge-base origin/<base> HEAD`, and read the whole diff. Read the issue and number its acceptance criteria. A revert PR is judged only on whether it cleanly undoes its merge.
2. Correctness. Read each changed function and its callers. Follow data that crosses a boundary: stored fields, API responses, config keys, file formats, other code that reads the same data. Look for missed cases, broken callers, and errors that pass silently.
3. Prove each finding. Run something against the real code that shows it: a failing test, a short script, or command output. Write scratch files outside the checkout, such as in a temporary directory. A finding you could not prove is marked unproven.
4. Tests.
   - Run the repository's checks: lint, type check, the whole test suite, and the build, as CI runs them.
   - Each behavior the PR adds or changes has a test. Run each new test against the base commit, in a separate worktree (`git worktree add --detach "$(mktemp -d)/base" <base>`, with the new test files copied in): it must fail there on an assertion. A test that only errors there, on an import or a missing function the PR adds, proves nothing either way; the next check decides it.
   - Break the behavior each new test claims to cover in a scratch worktree of the head, and rerun the test: it must fail. A test that still passes proves nothing.
   - Look for unseeded randomness, real clocks, order dependence, and real network calls in new tests.
5. Scope and design. Check each acceptance criterion against the diff and the tests. Flag requirements the PR misses, changes the issue did not ask for, code the change made dead but left in, and a new mechanism next to an existing one that does the same job. A test harness the change needed, dead code it removed, and docs the repository requires are part of the work, not extra scope.

## Verdict

Ask for changes only for what must change before merge:

- a correctness bug,
- an unmet acceptance criterion,
- a behavior change without a test that fails without it,
- a failing check the PR causes,
- scope the issue did not ask for.

Style preferences and optional improvements do not block. Leave them out, since every round of changes costs a full implement run. Approve when nothing blocks.

Write each finding as one or two sentences: file:line, what is wrong, the concrete input or state that shows it, the fix, and the command that proves it, or the word unproven. Number the findings, most severe first. Add no summary of the diff and no list of checks that passed.

The findings go to the engineer inside the result block's JSON string, so keep them plain: no code fences, no pasted output. Put command output in your message above the result block instead.

A failure that also happens on the base commit is not the PR's fault: mention it after the findings as outside the PR, and do not block on it.
