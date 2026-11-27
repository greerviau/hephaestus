---
name: resolve-conflicts
description: Use in a factory implement thread when the PR conflicts with its base branch, or when a merge or rebase stops on conflicts.
---

# resolve-conflicts

Bring the base branch into the PR's branch so both changes keep working. Never pick a side because its markers come first, and never call the conflict resolved until the repository's checks pass on the result.

## Procedure

1. Fetch origin and see where you are: `git status`, `git log --oneline --decorate -10`, and the conflicted paths from `git diff --name-only --diff-filter=U`. Use the method the message asks for. When it leaves the choice to you, merge `origin/<base>` into the branch, since the PR is already under review. Do not switch methods once conflicts appear.
2. For each conflict, find out why each side changed. Read the code around it, then the history:

   ```bash
   git log --oneline --left-right --merge -- <path>
   git show <commit> -- <path>
   ```

   Read the PR or issue behind the base branch's change with `gh pr view` or `gh issue view` when the commit names one. In a rebase, `ours` and `theirs` are swapped from what you might expect.

3. Resolve each hunk by behavior. Say what each side adds, removes, or changes before you edit. Keep both when they do different things. When they cannot both hold, keep what the base branch now requires and adapt your change to it, and say so in your final message. Keep ordering, validation, error handling, generated files, and public interfaces intact. Add no new behavior to make a hunk compile.
4. Check the result before you commit:

   ```bash
   git diff --check
   git grep -n -E '^(<{7}|={7}|>{7})( |$)' -- . ':!*.lock'
   ```

   Read each resolved file whole, not only the former hunks. Regenerate generated files and lockfiles with the repository's own tools instead of editing their conflicts by hand.

5. Run every check the repository runs, including the whole test suite. When one fails, compare with the base branch to see whether the merge caused it, and fix only what the merge caused.
6. Finish the operation with `git merge --continue` or `git rebase --continue`. Never use `--skip`, which drops a commit, or `--abort` to give up quietly; when a conflict cannot be resolved, end blocked with the reason.
7. Push the same branch. After a rebase, push with `--force-with-lease`. End with the result block and the new head commit.
