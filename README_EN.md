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

**Status: M5 typesetting chain.** The M3 orchestration loop still stops at **K2**, yields three **K3 model-choice cards** with reroll, and opens an **in-place explanation drawer** without clearing the pending choice; pending cards survive a runtime restart. M4's bench is intact: render, switch theme, compare, roll back; five score dimensions with deduction targets. M5 turns the **paper** tab into a real pipeline: **xelatex twice → pandoc to DOCX → Word restyle → de-AI phrasing / structural metrics / chapter structure gates**, with a pdf.js page preview; the gate strip now has four rows: figure, score, chapter, paper. The right pane defaults to 38% of the window (460–1100px); the workspace boundary and the top edge of the composer are draggable, double-click resets, and the left rail is fixed at 240px. The boundary highlight is a beam that fades out from the pointer toward both ends, and the composer edge shows a short centered line with tapered ends. The chat empty state is a large drop zone: files can be dropped anywhere in the column; on send the main process extracts their text (pdfjs for PDFs, direct reads for text/CSV with row × column counts) and hands it to the model, while the bubble only shows attachment chips. A new **files** tab lists the workspace and switches directories; the default workspace is a `赛题` folder on the Desktop, created on first launch.
The paper tab's **Build** is a workbench action: **the phase machine does not mark phase five passed because a build succeeded**, and it does not write prose for you. It compiles the bundled demo at `runtime/src/mms/paper_sample/paper.tex` (about 7 pages), not an automatic answer to a real problem. Provider access, streaming, tool cards and the `safeStorage` boundary carry over from M2; without a key, run with `MMS_FAKE_PROVIDER=1` — see [docs/providers.md](docs/providers.md).
Milestones: [PLAN.md](PLAN.md) §7; packaging, portable Python and the first release are M6.
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

# Run every local gate: registry + skills spec + negative coverage + typecheck + build + dist smoke + contracts + CLI + channel + workbench + paper
npm run gate
```

A green `npm run gate` means the scaffold is self-consistent. It needs neither network nor a display. The paper self-check does need `xelatex` and `pandoc` on the machine (see Dependencies). The composer has two modes: **modeling** sends a problem into the state machine and stops at decision cards; **chat** keeps the M2 free-form stream with tool cards. The left rail is also the conversation list: modeling and chat sessions can be created, switched, deleted individually or cleared in one step; chat sessions live locally and modeling sessions come from SQLite. The chat header shows the active conversation and context usage. The right pane renders figures, switches themes and rolls back; the score tab opens deduction targets in the text; the paper tab builds the demo, runs three gates and previews the PDF; the files tab lists the workspace and can switch it. It collapses to a 56px icon rail; expanded tabs are grouped as Output / Review / Material and the gate summary moves into the pane header. Model settings ship DeepSeek, Qwen, Kimi, GLM and an OpenAI-format endpoint, each with a 200k / 400k / 1m context budget and medium / high / max thinking depth. Screenshots: `screenshots/decision.png`, `screenshots/figure.png`, `screenshots/score.png`, `screenshots/paper.png`, `screenshots/dropzone.png`, `screenshots/files.png` (generated locally, not committed).

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
| G4 event stream | one-line JSON handshake; Bearer token plus a loopback Host/Origin allow-list; nine SSE event types validated against a contract; `Last-Event-ID` replay; cancellation must end with `done.reason=cancelled`; M3 adds the K2/K3 pause-and-resume flow and pending state recoverable from a **fresh server process**; 0.6.0 adds thinking depth in the request body, the off switch, and context-budget trimming (52 assertions) | ten malformed events must each be rejected; missing token, wrong Host, or resuming without a pending decision is refused (`python runtime/selfcheck_channel.py --selftest`) |
| G5 provider offline contract | a local fake OpenAI endpoint exercises 429 backoff, `reasoning_content` separation, split `tool_calls` assembly, reasoning stripped from history, and keys only in the Authorization header | a key sentinel must never appear in the event stream or stderr; the fake provider must be refused when `MMS_FAKE_PROVIDER` is off |
| G6 desktop scaffold | typecheck + build + the bundle must actually contain this project's CJK copy and design-token names | any failed assertion exits 1 |
| G9 workbench | render two real versions (nature → studio-ink), compare and roll back, reject unknown template/theme/version without adding a version; three score rounds, deduction targets, chapter sample and veto example (13 assertions) | unknown template/theme/version are negative controls; requires matplotlib (installed in the gates job) |
| G10 paper typesetting | really runs xelatex twice → pandoc → Word restyle: PDF/DOCX magic and size, six steps, three gates, persisted state; a missing pandoc is refused; a bad paper still yields a PDF but the gates go red; broken TeX exits 1; a missing source exits 2 (10 assertions) | four negative controls (missing tools, bad paper, broken TeX, missing source); skipping requires `MMS_PAPER_SKIP=1` and prints that G10 was not verified (`runtime/selfcheck_paper.py`) |
| G7 real launch | `require`s the production entry `out/main/index.js` so window options, preload, IPC and the runtime child all come from that file, then asserts: built artifact loaded, content size 1440x900, non-white pixels >= 1% from BGRA, IPC round-trip, settings never echo the key and the sentinel key is stored only as ciphertext, CJK renders as real glyphs; M3 adds K2→K3→explain drawer→reroll→choose→phase four and restart recovery; M4 adds first render, theme re-render with a side-by-side diff, rollback, five score dimensions/86, deduction target, round-three breaker, veto and the gate strip; M5 adds the paper build, PDF/DOCX, three gates and the pdf.js preview; M5.1 adds the wide-screen pane ratio, two-column paper/score tabs on a wide pane, the center/right splitter, a fixed left rail, the draggable composer edge with a hollow capsule handle, and a pointer-following highlight beam; M5.2 adds the attachment drop zone (box and centered plus, drag highlight, a CDP-injected real drop that lands and is removed, readable rejections) plus the workspace files tab and default workspace path; M5.3 adds attachment text extraction (PDF/CSV with shape), attachments sent with the message, restoration of chips after a reload and K2 attachment listing; 0.5.3 moves the action row out of the input card and pins it below, drops the always-on attach button, and stages pasted screenshots through the main process, with assertions for all three; 0.6.0 adds multi-conversation history and clearing, five provider presets with context/thinking selectors, and the collapsible grouped workspace (97 assertions); the M2 free-chat tool card remains as a regression (97 assertions) | a blank screenshot, a self-built window, tofu glyphs and deleting a required assertion while padding the count have all been caught (`tests/window-smoke.cjs`) |
| G6b result audit | reads `screenshots/window-smoke.json` and **recomputes the readings**: content size, non-white pixel ratio, assertion floor, presence of 30 key assertions, and self-reported counts versus the detail list | ships `--selftest` with 12 synthetic results, proving "ok=true but the reading is wrong" and "delete a key assertion, pad the count" are still rejected |

CI repairs Electron's SUID sandbox helper (root:4755) before launching, so preload and IPC are verified under the production `sandbox: true` rather than bypassed with `--no-sandbox`.
Why a separate auditor exists: CI once printed "10/12 passed" while the job stayed green — `app.exit(1)` was preempted by the production entry's `window-all-closed → app.quit()`. The verdict no longer hangs on Electron's exit-code plumbing.
**Still uncovered**: a real networked DeepSeek/Kimi conversation (this repository has no key and should not), launching a window on Windows in CI, and active probing of CSP violations.

CLI flags, exit codes, registry fields and artifact paths are **Stable**; `--json` field order and error wording are **Experimental**; geometry constants inside scripts are **Internal**.

**Execution state, stated plainly**: for M5, the local `npm run gate` is green — G1 (9 negative controls), G8 (6 negative controls), G2 (both modes), G3 (13 assertions), G4 (52 channel assertions including cross-process recovery, thinking depth and context trimming), the event-contract selftest (10/10), G9 (13 workbench assertions), G10 (10 paper assertions), the G6b selftest (12/12), typecheck, build and the G6 dist smoke. G7 passes 97 assertions on local Windows with an independent audit; the model cards, figure bench, score card, paper tab, drop zone, files tab and attachment bubble are captured in `screenshots/decision.png`, `screenshots/figure.png`, `screenshots/score.png`, `screenshots/paper.png`, `screenshots/dropzone.png`, `screenshots/files.png` and `screenshots/attachments.png`. **The 0.6.0 UI batch has not run in CI yet**; the local 97-assertion G7 run and the G6b audit are the current evidence. The M5 CI run `41017241564` is green in all three jobs: ubuntu real launch 57/57 at 1440x900 with 2.96% non-white pixels, G6b audit agrees, G10 10/10, G9 13/13, G6 14/14; the Windows G10 run is explicitly skipped and marked unverified. The 0.5.2 run `41065088121` is green in all three jobs as well: ubuntu real launch 78/78 with 3.81% non-white pixels, G6b audit agrees, G4 47/47, G9 13/13 and G3 13/13 on both platforms, G10 10/10 on ubuntu; the Windows G10 run stays explicitly skipped and marked unverified. The M4 run `41008695577` is green in all three jobs: ubuntu real launch 53/53 with 3.98% non-white pixels. The 0.3.0/0.3.1 runs `40982728779` and `41000678500` are likewise green in all three jobs. The M1/M2 history and its traps remain in `CHANGELOG.md`.

## Dependencies

| Purpose | Requirement | Note |
| --- | --- | --- |
| Shell | Electron, electron-vite, React, TypeScript | see `package.json` |
| Runtime | Python 3.12+ (the channel server, SSE and provider client are standard-library only) | `jsonschema>=4.20` optional; validation degrades without it |
| Models | DeepSeek / Qwen / Kimi / GLM / any OpenAI-format endpoint (BYOK) | see [docs/providers.md](docs/providers.md); keys are encrypted by the main process via `safeStorage` |
| Typesetting (M5) | xelatex (TeX Live or MiKTeX), pandoc, python-docx | system-level installs, not pip; pandoc may live on PATH, behind `MMS_PANDOC`, or at `%LOCALAPPDATA%\mms-tools\pandoc.exe`. Missing tools are listed explicitly; nothing is installed silently |
| Figures (M1) | matplotlib, numpy, seaborn | vendored with the skills; lower bounds live in `requirements.txt`, installed via a mirror |
| Paper preview (M5) | pdfjs-dist | installed by `npm install`; the worker is bundled into `out/renderer/assets`, so it needs no network at runtime |

Packaging shape is decided: **a portable Python runtime is bundled** (`uv` + python-build-standalone), so users never install Python. How TeX and pandoc ship (require a local install / bundle Tectonic / support both) is still open; M5 only does detection and explicit refusal, and M6 decides.

## Positioning and compliance

This project assists modeling work **that you have already done**: typesetting, publication-grade figures, pre-delivery self-audit, and method-selection discussion. It does not think for you and does not promise an award. The bundled scoring and structure checks default to the Chinese national contest rubric (aligned to the 2026 format rules) and can be switched to MCM/ICM; the de-AI checks remove template phrasing and invisible characters and **never present unperformed work as performed** — fabricating results, references or data is a hard red line inherited from the skill rules. Follow your own contest's rules on generative tools.

## License

[Apache-2.0](LICENSE). Copyright and license of the skill content are retained from upstream [mathmodel-kit](https://github.com/Escap1ng/mathmodel-kit).
