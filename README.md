# Lifesim

A deep, grounded, text-based life simulator: one person's life in the United States from birth to
death, then on through their children. Browser app in TypeScript with no backend.

**Status:** Milestone 3 of 7. A life can be played from birth to death: you are born into a
family drawn from US birth data, grow up in it, go through school and college, and then earn a
living. There are about fifty occupations with pay ladders, fictional employers that can get into
trouble, job searches, reviews, layoffs and retirement; money in double-entry accounts, with
federal and state tax, benefits, rent or a mortgage, credit, student loans and savings; and an
economy with recessions, inflation and markets. Friends and partners do not exist yet.

- [Design document](docs/DESIGN.md) — what is being built and why.
- [Calibration](docs/CALIBRATION.md) — how the simulation compares with real US statistics so far.

## Playing it

The latest version on `main` is published at <https://andreaswet.github.io/Lifesim/> by the
Deploy workflow, which runs the tests and builds the site on every push to `main`. Everything
runs in the browser; lives are saved in the browser's own storage and nowhere else.

## Running it

Requires Node 22 or later.

```sh
npm install
npm run dev        # play in the browser
npm test           # unit, property, determinism, golden-life and calibration smoke tests
npm run content    # compile and validate the content/ directory
npm run batch -- --lives 5000 --strategy persona    # simulate lives headlessly and compare with targets
npm run batch -- --lives 8000 --no-text --write-norms   # re-norm school achievement after changing the learning model
npm run replay -- some-save.json                    # rebuild a save from its seed and choices
npm run build      # type-check and build the static site into dist/
```

Playing: **Enter** advances to the next birthday, **S** a season, **M** a month. **1–9** answer a
decision, **?** asks why the latest explainable thing happened, **/** searches the life log, and
**T F C W P R H L V** switch sections (Story, Family, School, Work, Money, Routine, Health, Life
log, Saves). Amounts are in the dollars of the day; the Money section can show them in 2026
dollars.

## How it is organized

| Path | What it is |
|------|------------|
| `src/engine/` | The headless simulation. Takes a state and a command, returns a new state. No DOM, clock or unseeded randomness. |
| `src/narrative/` | Turns the engine's structured facts into prose, and answers "Why?". |
| `src/content/` | Compiles and validates the authored data into one bundle. |
| `src/app/` | Hosts the engine in a Web Worker, autosaves, and defines what the interface may see. |
| `src/ui/` | The interface. It receives the player's view, never the raw state. |
| `src/tools/` | Batch simulator, AI players, content validator, replay. |
| `content/` | Authored data: events, processes, text, body curves, and the US country pack (life tables, family and birth data, the school system, states, the economy, occupations and the labor market, federal tax and Social Security, household money and housing). |
| `tests/` | The test suite. |

Adding an event, a process or a piece of text means editing files under `content/` only.
