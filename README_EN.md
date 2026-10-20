<h1 align="center">mathmodel-studio</h1>

---

<p align="center"><b>A desktop agent for mathematical modeling contests · human-in-the-loop modeling workbench</b></p>

<p align="center">
  Problem in, paper out — but every judgement call stays yours to make:<br>
  <b>which model, why that model, which gate passed, and which sentence lost the points</b> — all visible, askable, reversible.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/skills-7-7B5FD6?style=flat" alt="skills">
  <img src="https://img.shields.io/badge/license-Apache--2.0-1A6FC4?style=flat" alt="license">
  <img src="https://img.shields.io/badge/Python-3.12+-2E9E44?style=flat" alt="Python">
  <img src="https://img.shields.io/badge/desktop-Electron-2B4C7E?style=flat" alt="desktop">
</p>

<p align="center">
  <a href="README.md">简体中文</a> &nbsp;·&nbsp; <b>English</b>
</p>

---

> **Anything a machine can verify goes to a gate. Anything that needs judgement goes to a human — with the decision point rendered as UI.**
> `mathmodel-studio` takes the contract-driven skill set of [mathmodel-kit](https://github.com/Escap1ng/mathmodel-kit) (publication-grade figures, typesetting rules, de-AI checks, structure audit and scoring) and puts it inside a local desktop program: bring your own model, keep your data on your machine, audit every step.

**Status: M1 skills landed.** All seven skills are vendored verbatim from upstream v2.0.1 (version and commit recorded in [`skills/VENDOR.md`](skills/VENDOR.md)), and every registry entry is now `vendored`.
Without any model access you can list the templates and render a real figure: `npm run mms -- templates`, `npm run mms -- invoke figure paired-raincloud`.
**It cannot model yet** — LLM access lands at M2, the model-choice card and the explain drawer at M3, the full typesetting chain at M5. Milestones: [PLAN.md](PLAN.md) §7.
Picking this up or auditing it? Start with [docs/HANDOFF.md](docs/HANDOFF.md): which claims are proven, which are not, and the traps this round already paid for.

## Quick start

```bash
# Install (mainland networks: read docs/env-setup.md first — direct npm and github.com are both unreliable)
npm install
python -m pip install -r requirements.txt -i https://registry.npmmirror.com/pypi/simple/

# Open the skeleton window
npm run dev

# No model needed: list the 25 templates and render one figure (PNG/PDF/SVG)
npm run mms -- templates
npm run mms -- invoke figure paired-raincloud

# Run every local gate: registry + skills spec + negative coverage + typecheck + build + dist smoke + contracts + CLI
npm run gate
```

A green `npm run gate` means the scaffold is self-consistent. It needs neither network nor a display.

## What this is

A program that runs on your machine — not a button that claims to generate a paper in one sentence.

- **Phase rail**: upstream `mathmodel-core` runs phases 0–6 (environment preflight → problem analysis → workspace layout → algorithm selection → implementation → paper output → scoring), here as a track that shows where the agent is blocked.
- **Six decision points**: missing-dependency confirmation, problem & attachment confirmation, **model-choice card**, **explain-in-place**, figure rework, and scoring-round release. Pauses are durable — close the window and it is still waiting where it stopped.
- **Traceability**: every number in the paper links back to the script that produced it and that run's output.
- **Gates**: figure capacity, chapter structure, lexical and structural AI traces, invisible characters, and the five-dimension score (pass at ≥85, circuit-breaker at 3 rounds) are decided by scripts, not by eyes.

## Skills

[`skills/manifest.json`](skills/manifest.json) is the single source of truth; the row count below and the badge count above are enforced equal by CI. `vendored` means the skill content is copied verbatim into this repository; the upstream version and commit are recorded in [`skills/VENDOR.md`](skills/VENDOR.md).

| Skill | Responsibility | Status |
| --- | --- | --- |
| [`mathmodel-core`](skills/mathmodel-core/) | Orchestration and routing across phases 0–6 | vendored |
| [`mathmodel-methods`](skills/mathmodel-methods/) | Method library and selection: problem-family index, rationale, verification | vendored |
| [`mathmodel-paper`](skills/mathmodel-paper/) | Writing and typesetting: rules, LaTeX skeleton, Word output, references | vendored |
| [`mathmodel-figure`](skills/mathmodel-figure/) | Data figures: matplotlib template library + Nature drawing standard | vendored |
| [`mathmodel-diagram`](skills/mathmodel-diagram/) | Academic diagrams: JSON-driven layout templates + faithful replication | vendored |
| [`mathmodel-deai`](skills/mathmodel-deai/) | De-AI and delivery checks: lexical, structural and character-level gates | vendored |
| [`mathmodel-score`](skills/mathmodel-score/) | Structure audit and scoring: chapter gate + 100-point rubric | vendored |

Skill content comes from [mathmodel-kit](https://github.com/Escap1ng/mathmodel-kit) v2.0.1 (Apache-2.0); import rules and re-sync history live in [`skills/VENDOR.md`](skills/VENDOR.md). The runtime only ever calls skill scripts via subprocess and reads their exit codes, so each skill remains independently loadable by hosts such as Claude Code.

## Gates already implemented

Every gate ships with negative coverage — a checker that only ever returns zero is not evidence.

| Gate | Criterion | Negative control |
| --- | --- | --- |
| G1 registry consistency | `skills/manifest.json` ↔ `skills/` dirs ↔ contract vocabularies ↔ both READMEs' skill tables and badges | 8 seeded breakages, each must turn red (`npm run check:registry:negative`) |
| G8 skills spec | every vendored `SKILL.md` stays a valid Agent Skills entry: parseable frontmatter, `name` matching the directory, non-empty `description` within 1024 chars, no repository-private fields; no placeholders and no directory deeper than upstream's 3 levels | six seeded breakages built from the real `SKILL.md` files (missing entry, renamed skill, empty description, injected `ui` field, leftover placeholder, over-deep tree), each must turn red (`npm run check:skills:negative`) |
| G2 contract validation | registry validated against JSON Schema Draft 2020-12; degrades with a printed note when `jsonschema` is absent | two deliberately invalid registries must be rejected |
| G2b version parity | `VERSION` / `package.json` / `pyproject.toml` / `mms/__init__.py` must agree | any missing or differing value fails |
| G3 CLI contract | exit codes `0 ok / 1 validation failed / 2 usage or environment` each reachable; since M1 it really calls the upstream renderer and independently verifies that PNG/PDF/SVG all exist and are non-empty | out-of-vocabulary value → 1, invalid JSON → 1, empty `MMS_HOME` → 2, unknown subcommand/template → 2, renderer "success" with no artifacts → 1 |
| G6 desktop scaffold | typecheck + build + the bundle must actually contain this project's CJK copy and design-token names | any failed assertion exits 1 |
| G7 real launch | `require`s the production entry `out/main/index.js` so window options, preload, IPC registration and navigation guards all come from that file, then asserts: built artifact loaded, content size 1440x900, non-white pixel ratio >= 1% from BGRA, status-bar version served by the main process, 7 phase rows / 6 tabs / send button disabled as a matter of fact, and clicking a swatch really swaps `--accent`, and CJK text renders as real glyphs rather than tofu (ink-density of 国 versus an empty box □) | a blank screenshot cannot clear the pixel threshold; the earlier self-built-window version was caught faking it (`app:meta` → No handler), and so was a screenshot made entirely of tofu boxes |

| G6b result audit | Reads `screenshots/window-smoke.json` and **recomputes the readings** rather than trusting the flag: content size, non-white pixel ratio, an assertion-count floor, and self-reported counts versus the detail list | ships `--selftest` with 8 synthetic results, proving "ok=true but the reading is wrong" is still rejected (`scripts/check-window-smoke.mjs`) |

CI repairs Electron's SUID sandbox helper (root:4755) before launching, so preload and IPC are verified under the production `sandbox: true` rather than bypassed with `--no-sandbox`.
Why a separate auditor exists: CI once printed "10/12 passed" while the job stayed green — `app.exit(1)` was preempted by the production entry's `window-all-closed → app.quit()`. The verdict no longer hangs on Electron's exit-code plumbing.
**Still uncovered**: anything needing a runtime handshake (only possible from M2 onward) and active probing of CSP violations.

CLI flags, exit codes, registry fields and artifact paths are **Stable**; `--json` field order and error wording are **Experimental**; geometry constants inside scripts are **Internal**.

**Execution state, stated plainly**: for M1, G1 (9 negative controls), G8 (6 negative controls), G2 (both modes), G3 (13 assertions including a real render and the "fake success" control), the G6b selftest, typecheck, build and the G6 dist smoke all pass locally in `npm run gate`. CI on the same commit (run `39398588127`) is green in all three jobs: both gate jobs run the G3 real render on ubuntu and windows, and the window smoke passes 15/15 on ubuntu with an independent audit (non-white pixels 2.79%). Windows still does not launch a window, so that claim is outside CI. The earlier rounds of G7, including what they got wrong, are kept in `CHANGELOG.md` rather than deleted.

## Dependencies

| Purpose | Requirement | Note |
| --- | --- | --- |
| Shell | Electron, electron-vite, React, TypeScript | see `package.json` |
| Runtime | Python 3.12+ (registry gates run on the standard library alone) | `jsonschema>=4.20` optional; validation degrades without it |
| Typesetting (M5) | xelatex (TeX Live or MiKTeX), pandoc | system-level installs, not pip; the preflight phase only gives guidance |
| Figures (M1) | matplotlib, numpy, seaborn | vendored with the skills; lower bounds live in `requirements.txt`, installed via a mirror |

Packaging shape is decided: **a portable Python runtime is bundled** (`uv` + python-build-standalone), so users never install Python. How TeX and pandoc are handled is settled at M5.

## Positioning and compliance

This project assists modeling work **that you have already done**: typesetting, publication-grade figures, pre-delivery self-audit, and method-selection discussion. It does not think for you and does not promise an award. The bundled scoring and structure checks default to the Chinese national contest rubric (aligned to the 2026 format rules) and can be switched to MCM/ICM; the de-AI checks remove template phrasing and invisible characters and **never present unperformed work as performed** — fabricating results, references or data is a hard red line inherited from the skill rules. Follow your own contest's rules on generative tools.

## License

[Apache-2.0](LICENSE). Copyright and license of the skill content are retained from upstream [mathmodel-kit](https://github.com/Escap1ng/mathmodel-kit).
