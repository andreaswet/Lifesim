# Calibration

How the simulation compares with real statistics for the United States. One row per target: its
source, the pinned value, what the simulation produces, and the tolerance. Deliberate deviations
are listed with their reasons.

**As of Milestone 1.** Only mortality and one illness exist, so this document is short. The full
list of targets is in [DESIGN.md §13](DESIGN.md#13-calibration-targets); each joins this document
when the system that produces it is built.

## How to reproduce

```sh
npm run batch -- --lives 100000 --seed cal-m1 --strategy persona --no-text
```

The result depends only on the seed, the strategy, the number of lives and the content; life *i*
always has seed `cal-m1-i`. Lives in a batch are never protected in early childhood (see
Deviations). The numbers below are from that command at content hash `a01d6f4a0c07e173`, except the
flu rate, which was re-measured on 20,000 lives after its constant was tuned.

## Mortality

Source for every row: NCHS, *United States Life Tables, 2023* (National Vital Statistics Reports
vol. 74 no. 6), Table 2 (males) and Table 3 (females). The annual probabilities of death for ages
0–99 in `content/countries/us/demographics/life-table.csv` are copied from those tables.

Mortality is an **input** in this milestone: the engine draws death directly from the table, so
the comparison checks the engine and the data, with a tolerance of about 3% (in practice, sampling
error).

| Metric | Published | Simulated (100,000 lives) | Verdict |
|--------|-----------|---------------------------|---------|
| Life expectancy at birth, male | 75.82 | 75.94 ± 0.08 | within sampling error |
| Life expectancy at birth, female | 81.08 | 81.16 ± 0.07 | within sampling error |
| Life expectancy at birth, both | 78.42 | 78.50 | within 0.1% |
| Infant mortality per 1,000 births | 5.6 | 5.4 | within sampling error (±0.24) |
| Boys among births | 51.1% | 51.0% | within sampling error |

Survival from birth, simulated / table:

| To age | Male | Female |
|--------|------|--------|
| 1 | 99.4% / 99.4% | 99.5% / 99.5% |
| 20 | 98.8% / 98.7% | 99.1% / 99.1% |
| 40 | 94.9% / 94.7% | 97.5% / 97.3% |
| 65 | 79.3% / 79.0% | 87.5% / 87.4% |
| 85 | 36.0% / 35.8% | 49.7% / 49.7% |
| 100 | 1.1% / 1.1% | 2.9% / 2.8% |

Two stronger checks sit behind these numbers:

- **Exact, not statistical.** A unit test computes, for 150 seeds, the month in which the life
  table and the seed say the person dies, and requires the engine to end each life in exactly that
  month.
- **The data reproduces the publication.** Life expectancy computed directly from the stored table
  (with the open-interval rule below) is 75.81 and 81.07, against the published 75.82 and 81.08.

### A note on batch size

Life expectancy from a batch has a standard error of about 17 years ÷ √(lives per sex). With 10,000
lives per sex that is ±0.18 years, and a batch will sometimes land two or three standard errors
out. One did during this milestone: the first 20,000 lives of seed `m1` gave men 75.24 (0.57 below
the table), while the next 20,000 gave 76.10. Before accepting that as noise I checked the random
generator directly:

- 1.5 million lives of mortality alone, in ten groups, landed between 0.04 below and 0.11 above
  the table, with no pattern by sex or seed;
- 100 million draws from the mortality stream had the right frequency below every threshold from
  0.0003 to 0.1, to within 0.05%.

Use at least 100,000 lives when a mortality difference of a tenth of a year matters.

## Illness

| Metric | Target | Source | Simulated | Verdict |
|--------|--------|--------|-----------|---------|
| Symptomatic influenza per person per year | 0.080 | Tokars, Olsen & Reed 2018, *Clinical Infectious Diseases* | 0.0804 | within 1% |

The flu is the first event to use the named-factor hazard model (design §3.2): a base rate, a
seasonal factor, and a normalization constant that keeps the population on the base rate. The
constant was first computed analytically (2.318), which left the simulated rate 1.5% low because
of the months in which a second flu cannot start; it was then set from the batch result (2.283).
This is the procedure every later hazard will follow.

Not yet modeled: variation in flu risk by age, vaccination, and any effect of the flu on mortality.

## Causal checks

| Check | Expected | Simulated | Verdict |
|-------|----------|-----------|---------|
| More activity, more fitness at 60 | ordered | cardio stock 0.37 sedentary, 0.47 light, 0.56 moderate, 0.67 active | as expected |
| Same seed lived actively and sedentary | identical luck, different body | death month and every flu identical; fitness differs | as expected |
| Lifestyle and length of life | none **yet** | none | Milestone 5 |

The last row is the important caveat of this milestone: how the character lives does not yet
change when they die. The "Why?" on a death says so in the game.

## Deliberate deviations

| Deviation | Reason |
|-----------|--------|
| In interactive play, the player character's own death draws are skipped before age 5. | About 0.7% of US children die before five. A life that ends in the first minute is realistic but is not a game. Batch runs never do this, so every number in this document includes those deaths. |
| Deaths are spread evenly over each year of age. | In reality most infant deaths come in the first weeks. The effect on life expectancy is about 0.002 years. |
| From age 100 the annual probability of death is constant (0.398 for men, 0.362 for women), and nobody lives past 120. | The published table ends with "100 and older" and a life expectancy (2.01 and 2.26 years). The constant reproduces that expectancy. |
| Birth months are uniform. | Real births are mildly seasonal. Nothing yet depends on it. |

## Checks on the game itself

From a 4,000-life batch with text (`--seed m1text --strategy mixed`).

| Check | Target (design §9, §13.4) | Milestone 1 | Comment |
|-------|---------------------------|-------------|---------|
| Invariants broken | none | none | Checked every ten years of every life and at death. |
| Decisions opened per year | within the pacing budget | 0.00–0.11 by life stage | Far below budget: there is little to decide yet. |
| Significant feed items by source | player ≥ 50%, NPC ≈ 25%, structural ≈ 15%, chance ≤ 10% | player 36%, structural 56%, chance 8% | Off target, as expected: with no family, school or work, birthdays and life-stage markers dominate. |
| Feed lines per life | — | 112 | About 1.4 a year. The three-hour life needs several times this. |
| Lives in which some text variant appears more than twice | none | 99% | Missed, as expected: 176 text variants cannot cover 80 year summaries without repeating. The worst single sentence appears up to 14 times in one life. Back-to-back repeats are prevented. |
| Computing time per simulated year | under 20 ms in Node | 0.14 ms | 100,000 lives take under five minutes on four cores. |
| Time for one year in the browser | under 150 ms | about 40 ms per advance, including rendering and autosave | Measured in headless Chromium on a desktop-class machine, not on a phone. |
| Same save in browser and Node | identical | identical | A save written by the browser replays exactly with `npm run replay`. |

## Not yet calibrated

Everything else in DESIGN.md §13. The values listed there for life expectancy and infant mortality
have now been checked against the source tables; the rest are still written from memory and will
be pinned as their data files are created.
