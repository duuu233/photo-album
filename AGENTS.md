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

# 测试

`tests/` 下是**纯 node 脚本**：没有构建步骤、没有依赖、没有 runner 配置。

```bash
node tests/<名字>.test.js                                            # 跑一个
for f in tests/*.test.js; do node "$f" || echo "FAILED: $f"; done    # 跑全量
```

全量几秒钟跑完。**跑全部，不要只跑「看起来和这次改动有关」的那几条。**

## 动过任何 `.wxss` / `.wxml`，就跑一遍全量

有相当一批用例是**版式回归**：它们把样式和模板当文本读，断言的是**选择器名和声明本身**
（`tests/token-page-layout.test.js`、`tests/gallery-layout.test.js`、
`tests/bind-device-list-layout.test.js` 等）。删掉、改名或合并一条规则就会让它们变红——
**哪怕页面本身渲染得完全正常**，而且别的地方一句都不会报，因为这类用例存在的理由正是
「改坏了不报错、只有肉眼能看出来」的那种缺陷。

这已经实打实花过时间：有一次提交把选中态角标的规则合并进了基础规则，只跑了看起来相关的
那一条用例。`tests/token-page-layout.test.js` 因此**红了 9 天**（2026-09-08 → 2026-09-17），
期间没有任何东西提示过。

## 用例红了，先判断是哪一边过期，再动手

- **规则是有意删掉 / 改名 / 合并的** → 把用例的查询挪到那条声明**现在所在的位置**，
  保住它原本守的判据，并在用例里写明为什么挪。**不要削弱、更不要删掉断言。**
- **规则是误删的** → 修样式，用例别动。

**任何情况下都不许靠删断言让它变绿**：每一条断言都对应一个已经上线过一次的缺陷。
