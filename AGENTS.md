# Project AI Instructions

## Project Context

This project is maintained across multiple development environments:

- Office computer
- Home computer
- Remote SSH servers

Git repository is the single source of truth.

Do not assume local machine state is shared between environments.

The project may be modified from different computers at different times.

Always consider synchronization and compatibility with other development environments.

---

# AI Working Principles

The AI assistant should act as a long-term project collaborator.

Before making changes:

1. Understand the existing implementation.
2. Check dependencies and impact.
3. Avoid unnecessary changes.
4. Preserve existing design decisions.

Prefer understanding before modifying.

---

# CodeGraph Usage

This project uses CodeGraph as the primary code intelligence system.

Use CodeGraph first when analyzing:

- project architecture
- module relationships
- dependencies
- function call chains
- class relationships
- impact of changes
- refactoring scope
- unfamiliar code

Do not rely only on text search when structural understanding is required.

Examples:

Use CodeGraph for questions like:

- "Who calls this function?"
- "What modules depend on this?"
- "What will be affected if this changes?"
- "Explain this subsystem architecture."

---

# CodeGraph Management

CodeGraph represents the current state of the codebase.

CodeGraph contains:

- project structure
- files
- symbols
- functions/classes
- dependencies
- callers/callees
- impact relationships

## Local Index Rules

The `.codegraph/` directory is a local generated index.

Rules:

- Never commit `.codegraph/` to Git.
- Each computer maintains its own CodeGraph index.
- The index can always be regenerated.
- Do not depend on another machine's `.codegraph/` data.

The project Git repository contains source and knowledge, not CodeGraph cache.

---

# CodeGraph Synchronization

After pulling code changes from Git:

Run:

```bash
codegraph sync
```

---

# Testing

The tests under `tests/` are plain Node scripts — no build step, no dependencies, no test
runner config:

```bash
node tests/<name>.test.js                                          # one file
for f in tests/*.test.js; do node "$f" || echo "FAILED: $f"; done  # the whole suite
```

The full suite finishes in seconds. Run all of it, not only the tests that look related to
what you changed.

## After touching any `.wxss` or `.wxml`, run the full suite

Several tests are layout regressions: they read the style and template files as text and assert
on **selector names and declarations** (`tests/token-page-layout.test.js`,
`tests/gallery-layout.test.js`, `tests/bind-device-list-layout.test.js`, and others). Deleting,
renaming or merging a rule breaks them even when the page itself renders correctly — and nothing
else will report it, because these tests exist precisely for the defects that only the eye can
catch.

This has already cost real time: a commit merged the selected-state badge rule into the base
rule and ran only the one test that looked related. `tests/token-page-layout.test.js` stayed red
for nine days (2026-09-08 → 2026-09-17), reported by nothing.

## When a layout test fails, decide which side is stale before editing either

- **The rule was intentionally removed, renamed or merged** → move the test's query to wherever
  the declaration now lives, keep the invariant it was guarding, and record in the test why it
  moved. Do not weaken or delete the assertion.
- **The rule went missing by accident** → fix the style, leave the test alone.

Never make a layout test pass by deleting the assertion: each one stands for a defect that
shipped once already.
