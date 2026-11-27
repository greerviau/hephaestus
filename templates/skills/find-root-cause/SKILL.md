---
name: find-root-cause
description: Use in a factory implement thread when a bug, a crash, wrong output, or a failing or flaky test has a cause you have not confirmed yet.
---

# find-root-cause

Confirm the cause of a failure before you change any code to fix it. Nobody can answer questions in a factory thread, so everything you need comes from the issue, the repository, and what you run.

## Procedure

1. Reproduce. Build the smallest reliable reproduction that drives the real entry point the way the issue describes. When it does not reproduce, try the environment, inputs, and versions the issue names. When it still does not, stop: end the thread blocked, with what you tried and what detail is missing. Do not guess at a fix.
2. Characterize. For a failure that comes and goes, run it a fixed number of times and record how often it fails. Change one factor at a time: seed, test order, environment, base branch against your branch.
3. Narrow. Read the failing path. Bisect history with `git bisect run` when the failure is a regression, and bisect inputs when it depends on data. Add temporary logging when reading is not enough. List the candidate causes, and for each one the observation that would rule it out.
4. Confirm. The cause is confirmed when the reproduction fails because of it and removing it makes the reproduction pass. A cause no observation tells apart from the others is still a guess: keep narrowing.
5. Fix. The reproduction becomes the regression test, which fails before the fix and passes after (see `test-first`). Remove the temporary logging.

When a fix does not make the reproduction pass, the cause was wrong. Write down the assumption the fix rested on, add it to the candidates, and run the observation that rules it in or out before you write another fix.

A flaky test is a defect. Do not retry it until it passes, and do not skip it unless the cause is outside the code under test; then say so in the PR body.

In the PR body, state the symptom, the cause, the evidence that confirms it, and the regression test. Defects you found along the way go under "Found, not fixed".
