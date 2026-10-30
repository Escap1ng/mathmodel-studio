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

**Status: M3 orchestration loop.** Paste a problem and the state machine stops at **K2 problem/attachment confirmation**; confirming yields three **K3 model-choice cards** with reroll and an **in-place explanation drawer** (opening it does not clear the pending choice), and selecting one moves the rail into phase four. Phase states, pending cards and messages live in local SQLite, so **the decision survives a runtime restart**.
The M3 candidates come from a built-in method-family library selected by problem keywords, **not from a model**; model-driven selection lands in M4. Provider access, streaming, tool cards and the `safeStorage` boundary carry over from M2; without a key, run with `MMS_FAKE_PROVIDER=1` — see [docs/providers.md](docs/providers.md).
**It still cannot solve a problem** — code implementation, figure rework, typesetting and scoring are M4/M5. Milestones: [PLAN.md](PLAN.md) §7.
Picking this up or auditing it? Start with [docs/HANDOFF.md](docs/HANDOFF.md): which claims are proven, which are not, and the traps this round already paid for.

## Quick start

```bash
# Install (mainland networks: read docs/env-setup.md first — direct npm and github.com are both unreliable)
npm install
python -m pip install -r requirements.txt -i https://registry.npmmirror.com/pypi/simple/

# Open the window. Without a key, prefix MMS_FAKE_PROVIDER=1 for the offline demo.
npm run dev

# No model needed: list the 25 templates and render one figure (PNG/PDF/SVG)
npm run mms -- templates
npm run mms -- invoke figure paired-raincloud

# Run every local gate: registry + skills spec + negative coverage + typecheck + build + dist smoke + contracts + CLI + channel + offline provider
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
| G4 event stream | one-line JSON handshake; Bearer token plus a loopback Host/Origin allow-list; nine SSE event types validated against a contract; `Last-Event-ID` replay; cancellation must end with `done.reason=cancelled`; M3 adds the K2/K3 pause-and-resume flow and pending state recoverable from a **fresh server process** (46 assertions) | ten malformed events must each be rejected; missing token, wrong Host, or resuming without a pending decision is refused (`python runtime/selfcheck_channel.py --selftest`) |
| G5 provider offline contract | a local fake OpenAI endpoint exercises 429 backoff, `reasoning_content` separation, split `tool_calls` assembly, reasoning stripped from history, and keys only in the Authorization header | a key sentinel must never appear in the event stream or stderr; the fake provider must be refused when `MMS_FAKE_PROVIDER` is off |
| G6 desktop scaffold | typecheck + build + the bundle must actually contain this project's CJK copy and design-token names | any failed assertion exits 1 |
| G7 real launch | `require`s the production entry `out/main/index.js` so window options, preload, IPC and the runtime child all come from that file, then asserts: built artifact loaded, content size 1440x900, non-white pixels >= 1% from BGRA, IPC round-trip, settings never echo the key and the sentinel key is stored only as ciphertext, CJK renders as real glyphs; M3 adds K2→K3→explain drawer→reroll→choose→phase four and **a K3 card still present after the runtime is killed and relaunched**; the M2 free-chat tool card remains as a regression (43 assertions) | a blank screenshot, a self-built window, tofu glyphs and deleting a required assertion while padding the count have all been caught (`tests/window-smoke.cjs`) |
| G6b result audit | reads `screenshots/window-smoke.json` and **recomputes the readings**: content size, non-white pixel ratio, assertion floor, presence of key assertions, and self-reported counts versus the detail list | ships `--selftest` with 10 synthetic results, proving "ok=true but the reading is wrong" and "delete a key assertion, pad the count" are still rejected |

CI repairs Electron's SUID sandbox helper (root:4755) before launching, so preload and IPC are verified under the production `sandbox: true` rather than bypassed with `--no-sandbox`.
Why a separate auditor exists: CI once printed "10/12 passed" while the job stayed green — `app.exit(1)` was preempted by the production entry's `window-all-closed → app.quit()`. The verdict no longer hangs on Electron's exit-code plumbing.
**Still uncovered**: a real networked DeepSeek/Kimi conversation (this repository has no key and should not), launching a window on Windows in CI, and active probing of CSP violations.

CLI flags, exit codes, registry fields and artifact paths are **Stable**; `--json` field order and error wording are **Experimental**; geometry constants inside scripts are **Internal**.

**Execution state, stated plainly**: for M3, the local `npm run gate` is green — G1 (9 negative controls), G8 (6 negative controls), G2 (both modes), G3 (13 assertions), G4 (46 channel assertions including cross-process recovery), the event-contract selftest (10/10), the G6b selftest (12/12), typecheck, build and the G6 dist smoke. G7 passes 43/43 on local Windows with an independent audit (content size 1440x900, non-white pixels 2.37%); the K3 card and explain drawer are captured in `screenshots/decision.png` and `screenshots/drawer.png`. The 0.3.0 CI run `40982728779` is green in all three jobs: G4's 46 assertions on both ubuntu and windows, and the ubuntu window smoke at 42/42 (3.15% non-white), covering K2→K3→explain→restart-recovery→reroll→choose, with the `safeStorage` refusal branch still exercised. The 0.3.1 run `41000678500` is green as well, with the ubuntu window smoke at 43/43 (3.12% non-white) and an empty application menu on Linux. The M1/M2 history and its traps remain in `CHANGELOG.md`.

## Dependencies

| Purpose | Requirement | Note |
| --- | --- | --- |
| Shell | Electron, electron-vite, React, TypeScript | see `package.json` |
| Runtime | Python 3.12+ (the channel server, SSE and provider client are standard-library only) | `jsonschema>=4.20` optional; validation degrades without it |
| Models | DeepSeek / Kimi / any OpenAI-compatible endpoint (BYOK) | see [docs/providers.md](docs/providers.md); keys are encrypted by the main process via `safeStorage` |
| Typesetting (M5) | xelatex (TeX Live or MiKTeX), pandoc | system-level installs, not pip; the preflight phase only gives guidance |
| Figures (M1) | matplotlib, numpy, seaborn | vendored with the skills; lower bounds live in `requirements.txt`, installed via a mirror |

Packaging shape is decided: **a portable Python runtime is bundled** (`uv` + python-build-standalone), so users never install Python. How TeX and pandoc are handled is settled at M5.

## Positioning and compliance

This project assists modeling work **that you have already done**: typesetting, publication-grade figures, pre-delivery self-audit, and method-selection discussion. It does not think for you and does not promise an award. The bundled scoring and structure checks default to the Chinese national contest rubric (aligned to the 2026 format rules) and can be switched to MCM/ICM; the de-AI checks remove template phrasing and invisible characters and **never present unperformed work as performed** — fabricating results, references or data is a hard red line inherited from the skill rules. Follow your own contest's rules on generative tools.

## License

[Apache-2.0](LICENSE). Copyright and license of the skill content are retained from upstream [mathmodel-kit](https://github.com/Escap1ng/mathmodel-kit).
