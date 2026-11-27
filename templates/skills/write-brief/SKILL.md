---
name: write-brief
description: Use when starting or restarting a factory task with start_work, to write the brief the engineer works from.
---

# write-brief

The engineer reads the issue and your brief, and nothing else. A good brief saves a review round; a vague one costs one.

## Before you start a task

- Read the issue and its acceptance criteria. When the criteria cannot be checked, or the issue leaves a decision only the owner can make, escalate instead of starting.
- Read `list_tasks`. Do not start a task that depends on one that is escalated or stuck, and do not start two tasks that change the same code side by side.

## The brief

Keep it short, about 100 to 200 words:

- The goal in one sentence, in your words.
- Where the change goes: the files, modules, or entry points you expect it to touch, when you know them.
- What to test: the behaviors the acceptance criteria name, and the edge cases the engineer is likely to miss.
- Constraints: what must not change, such as a public interface, a data format, or a behavior other tasks rely on.
- What is out of scope, when a nearby change is tempting.

Do not restate the issue, and do not prescribe the implementation line by line.

## Restarting a task

Read its threads first. Say what went wrong last time in one sentence, and what to do differently: a sharper scope, a missing constraint, or the review finding the engineer did not fix. The engineer continues the same branch and PR.
