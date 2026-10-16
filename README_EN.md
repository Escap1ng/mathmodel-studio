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

**Status: M0 scaffold.** The three-pane shell, the skill registry with its JSON Schema contracts, and four gates (G1 registry consistency · G2 contracts and version parity · G3 CLI exit codes · G6 dist smoke, each with negative coverage) are in place.
**It cannot model yet** — LLM access lands at M2, the model-choice card and the explain drawer at M3, the full typesetting chain at M5. Milestones: [PLAN.md](PLAN.md) §7.

## Quick start

```bash
# Install (mainland networks: read docs/env-setup.md first — direct npm and github.com are both unreliable)
npm install

# Open the skeleton window
npm run dev

# Run every local gate: registry consistency + negative coverage + typecheck + build + dist smoke + contracts + CLI exit codes
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

[`skills/manifest.json`](skills/manifest.json) is the single source of truth; the row count below and the badge count above are enforced equal by CI. `planned` means the skill is registered and its directory is reserved, but its content has not been vendored into this repository yet (that is M1).

| Skill | Responsibility | Status |
| --- | --- | --- |
| [`mathmodel-core`](skills/mathmodel-core/) | Orchestration and routing across phases 0–6 | planned |
| [`mathmodel-methods`](skills/mathmodel-methods/) | Method library and selection: problem-family index, rationale, verification | planned |
| [`mathmodel-paper`](skills/mathmodel-paper/) | Writing and typesetting: rules, LaTeX skeleton, Word output, references | planned |
| [`mathmodel-figure`](skills/mathmodel-figure/) | Data figures: matplotlib template library + Nature drawing standard | planned |
| [`mathmodel-diagram`](skills/mathmodel-diagram/) | Academic diagrams: JSON-driven layout templates + faithful replication | planned |
| [`mathmodel-deai`](skills/mathmodel-deai/) | De-AI and delivery checks: lexical, structural and character-level gates | planned |
| [`mathmodel-score`](skills/mathmodel-score/) | Structure audit and scoring: chapter gate + 100-point rubric | planned |

Skill content comes from [mathmodel-kit](https://github.com/Escap1ng/mathmodel-kit) v2.0.1 (Apache-2.0); import rules and re-sync history live in [`skills/VENDOR.md`](skills/VENDOR.md). The runtime only ever calls skill scripts via subprocess and reads their exit codes, so each skill remains independently loadable by hosts such as Claude Code.

## Gates already implemented

Every gate ships with negative coverage — a checker that only ever returns zero is not evidence.

| Gate | Criterion | Negative control |
| --- | --- | --- |
| G1 registry consistency | `skills/manifest.json` ↔ `skills/` dirs ↔ contract vocabularies ↔ both READMEs' skill tables and badges | 8 seeded breakages, each must turn red (`npm run check:registry:negative`) |
| G2 contract validation | registry validated against JSON Schema Draft 2020-12; degrades with a printed note when `jsonschema` is absent | two deliberately invalid registries must be rejected |
| G2b version parity | `VERSION` / `package.json` / `pyproject.toml` / `mms/__init__.py` must agree | any missing or differing value fails |
| G3 CLI contract | exit codes `0 ok / 1 validation failed / 2 usage or environment` each reachable | out-of-vocabulary value → 1, invalid JSON → 1, empty `MMS_HOME` → 2, unknown subcommand → 2 |
| G6 desktop scaffold | typecheck + build + the bundle must actually contain this project's CJK copy and design-token names | any failed assertion exits 1 |
| G7 real launch | under xvfb: title and 1440x900 content size, non-white pixel ratio >= 1% computed from BGRA, IPC round-trip writes the app version into the status bar, 7 phase rows / 6 tabs / send button disabled as a matter of fact, and clicking a swatch really swaps `--accent` | a blank screenshot cannot clear the pixel threshold; runs as an independent job (`tests/window-smoke.cjs`) |

G7 repairs Electron's SUID sandbox helper first and then launches under `sandbox: true`, so the preload and the IPC round-trip are verified *inside* the sandbox rather than bypassed with `--no-sandbox`.
**Still uncovered**: the window options and navigation guards in `src/main/index.ts` itself — the smoke script builds its own window around the built output, and that path needs a real-launch test once M2 gives the runtime a handshake to wait on. The CSP also remains static configuration only.

CLI flags, exit codes, registry fields and artifact paths are **Stable**; `--json` field order and error wording are **Experimental**; geometry constants inside scripts are **Internal**.

**Execution state, stated plainly**: G1 (with its 9 negative controls), G2 (both full and degraded modes) and G3 were run green locally; G1, G2, G3 and G6 are green in CI on the ubuntu + windows matrix. G7 was written this round and has not been executed even once yet — the script exists, but it has not been proven to run.

## Dependencies

| Purpose | Requirement | Note |
| --- | --- | --- |
| Shell | Electron, electron-vite, React, TypeScript | see `package.json` |
| Runtime | Python 3.12+ (M0 gates run on the standard library alone) | `jsonschema>=4.20` optional; validation degrades without it |
| Typesetting (M5) | xelatex (TeX Live or MiKTeX), pandoc | system-level installs, not pip; the preflight phase only gives guidance |
| Figures (M1) | matplotlib, numpy, seaborn | added when the skills are vendored |

Packaging shape is decided: **a portable Python runtime is bundled** (`uv` + python-build-standalone), so users never install Python. How TeX and pandoc are handled is settled at M5.

## Positioning and compliance

This project assists modeling work **that you have already done**: typesetting, publication-grade figures, pre-delivery self-audit, and method-selection discussion. It does not think for you and does not promise an award. The bundled scoring and structure checks default to the Chinese national contest rubric (aligned to the 2026 format rules) and can be switched to MCM/ICM; the de-AI checks remove template phrasing and invisible characters and **never present unperformed work as performed** — fabricating results, references or data is a hard red line inherited from the skill rules. Follow your own contest's rules on generative tools.

## License

[Apache-2.0](LICENSE). Copyright and license of the skill content are retained from upstream [mathmodel-kit](https://github.com/Escap1ng/mathmodel-kit).
