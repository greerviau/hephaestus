---
name: test-first
description: Use in a factory implement thread before changing any code behavior, including features and bug fixes, even when the issue does not ask for tests.
---

# test-first

Write the failing test before the code, for every behavior the task changes. Writing the code first and the test after is not test-first, and you never report it as test-first.

## Loop

1. Read the issue and the brief, and list each behavior they ask for. Each one gets its own test. Stay inside that list: a change the issue does not ask for goes in the PR body under "Found, not fixed", not in the code.
2. Pick the seam. Prefer an end-to-end test that drives the real entry point a user or caller hits (the CLI, the endpoint, the public function), not a private helper, whenever one is feasible. Write a narrower unit test only when an end-to-end test cannot reach the behavior or would be impractical, such as a rare error path that needs a fault the whole path cannot produce, and say why in the PR body.
3. When the repository has no harness for that seam, build it first, in its own commit.
4. Red. Write one test and run it. Confirm it fails because the behavior is missing, not because of an import error, a typo, or a missing fixture. Copy the test name and the failure message into your notes for the PR.
5. Green. Write the least code that makes it pass.
6. Refactor while every test stays green. Delete code, tests, config, and docs the change makes dead.
7. Repeat for the next behavior.

A bug fix starts from a test that reproduces the bug: it fails before the fix and passes after. Use the `find-root-cause` skill when the cause is not known.

## Check each test

- Break the behavior on purpose (return a wrong value, skip a side effect, do it twice) and rerun the test. It must fail. Then undo the break.
- Restructure the code behind the test without changing what it does. The test must still pass. A test that breaks on a refactor tests the implementation, not the behavior.
- Expected values come from the issue or the domain, never from running the code under test.
- Fake only an external system the test cannot run, such as a third-party API, and only where the code already puts a boundary in front of it. When the code calls one directly, add that boundary as part of the change, so production uses the real client and the test a fake.
- No unseeded randomness, real clocks, sleeps, test order dependence, or real network calls.

## Keep only tests worth having

Do not add redundant, trivial, or low-value tests. Leave out:

- a test that covers what another test, new or existing, already covers,
- a test that restates the implementation, such as one that asserts the code calls what it calls, or that copies the code's own logic to compute the expected value,
- a test of a getter, a constructor, plain wiring, or a mock, which checks the test setup rather than the behavior.

Before you push, read every test your change adds and remove each one of these. One test per behavior that would fail if the behavior broke is the goal, not a count of tests.

Documentation, comments, formatting, and renames that existing tests cover need no new test. A dependency upgrade rests on the existing suite.

## Before you push

Run every check the repository runs: find them in CI workflows, package scripts, the README, or CONTRIBUTING. Run the whole test suite, not only the tests near the change. Fix every failure your change causes. A failure that also happens on the base branch is not yours: leave it, and say so in the PR body.

## The PR body

- What changed, grouped by behavior, and the closing reference to the issue.
- Each red run: the test name and its failure message before the fix.
- Each check you ran, with its command and result. A check you skipped or ran only in part is listed as skipped or partial. Never report a check you did not run.
- "Found, not fixed": defects outside the task that you saw, each with file:line.
