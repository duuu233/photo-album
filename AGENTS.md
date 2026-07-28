# Project AI Instructions

## Code Understanding

This project uses CodeGraph as the primary code intelligence system.

When analyzing:

- architecture
- dependencies
- call chains
- impact of changes
- refactoring scope

Use CodeGraph tools first instead of relying only on text search.

---

## Knowledge Management

This project maintains two layers of knowledge:

### Layer 1: CodeGraph (Current Code Knowledge)

CodeGraph represents:

- current project structure
- symbols
- functions/classes
- dependencies
- callers/callees
- impact analysis

Keep CodeGraph synchronized after meaningful code changes.

When code structure changes significantly:

- run codegraph sync
- verify affected relationships

---

### Layer 2: Markdown Documentation (Project Memory)

Markdown files represent:

- why decisions were made
- historical context
- architecture decisions
- optimization records
- trade-offs
- known issues
- future plans

Do not replace Markdown documentation with CodeGraph.

---

## Documentation Rules

When making code changes:

1. Before modifying complex code:
   - Use CodeGraph to understand dependencies and impact.

2. After completing changes:
   Decide whether documentation should be updated.

Update Markdown when changes involve:

- architecture changes
- new modules
- database changes
- API changes
- performance optimization
- security changes
- important bug fixes
- non-obvious design decisions

---

## Change Record Format

For important changes, create or update:

docs/changes/YYYY-MM-DD-{topic}.md

Include:

# Change Title

## Background

Why this change was needed.

## Problem

What problem existed.

## Solution

What was changed.

## Affected Areas

Files/modules affected.

## Technical Decisions

Why this approach was chosen.

## Risks

Potential side effects.

## Follow-up

Future improvements.

---

## Working Style

Before large changes:

1. Analyze using CodeGraph.
2. Explain affected components.
3. Propose a plan.

After changes:

1. Update CodeGraph index if needed.
2. Update Markdown knowledge if the change has long-term value.
3. Summarize what changed.
