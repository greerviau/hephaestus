---
name: write-issue
description: Use when turning a request into GitHub issues for a factory project, before calling file_issue.
---

# write-issue

An issue is the whole specification a factory engineer gets, and a reviewer checks the PR against it. Nobody can ask you a follow-up once work starts, so the issue says everything that matters.

## Before you write

- Ask the requester when the goal, the scope, or who it is for is unclear. Do not guess.
- Check `get_status` and `list_cards` for work that already covers the request, and say so instead of filing a second issue.
- Split the request into issues that each deliver one thing a user can see or a test can check, and that can merge on their own. When one depends on another, file the first one first and name it in the second.

## The issue

Title: a plain sentence naming the problem or the change, such as "Export fails when a name contains a comma". No type prefixes or tags.

Body, about 200 words and rarely over 400:

- `## Problem`: what is wrong or wanted, and who it affects.
- `## Reproduction`, for a bug: the smallest steps, what was expected, and what happened instead.
- `## Proposed approach`, only when a direction is already known: one or two sentences.
- `## Acceptance criteria`: a numbered list of what must be true to close the issue. Each criterion can be checked by a test or a command; "works correctly" cannot. Include the error and edge cases that matter. Number them so a review can say "criterion 3 is unmet".
- `## Out of scope`, when a nearby change is likely to be mistaken as part of the work.

Leave out guesses about the cause and anything a reviewer could not check.
