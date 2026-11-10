# Lifesim

A deep, grounded, text-based life simulator: one person's life in the United States from birth to
death, then on through their children. Browser app in TypeScript with no backend.

**Status:** Milestone 1 of 7 — the engine core. A life can be played from birth to death; time,
aging and mortality work, and almost nothing else exists yet (no family, school, work or money).

- [Design document](docs/DESIGN.md) — what is being built and why.
- [Calibration](docs/CALIBRATION.md) — how the simulation compares with real US statistics so far.

## Running it

Requires Node 22 or later.

```sh
npm install
npm run dev        # play in the browser
npm test           # unit, property, determinism, golden-life and calibration smoke tests
npm run content    # compile and validate the content/ directory
npm run batch -- --lives 5000 --strategy persona    # simulate lives headlessly and compare with targets
npm run replay -- some-save.json                    # rebuild a save from its seed and choices
npm run build      # type-check and build the static site into dist/
```

Playing: **Enter** advances to the next birthday, **S** a season, **M** a month. **1–9** answer a
decision, **?** asks why the latest explainable thing happened, **/** searches the life log, and
**T R H L V** switch sections.

## How it is organized

| Path | What it is |
|------|------------|
| `src/engine/` | The headless simulation. Takes a state and a command, returns a new state. No DOM, clock or unseeded randomness. |
| `src/narrative/` | Turns the engine's structured facts into prose, and answers "Why?". |
| `src/content/` | Compiles and validates the authored data into one bundle. |
| `src/app/` | Hosts the engine in a Web Worker, autosaves, and defines what the interface may see. |
| `src/ui/` | The interface. It receives the player's view, never the raw state. |
| `src/tools/` | Batch simulator, AI players, content validator, replay. |
| `content/` | Authored data: events, processes, text, body curves, and the US country pack (life tables, names). |
| `tests/` | The test suite. |

Adding an event, a process or a piece of text means editing files under `content/` only.
