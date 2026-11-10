# Calibration

How the simulation compares with real statistics for the United States. One row per target: its
source, the pinned value, what the simulation produces, and a verdict. Deliberate deviations are
listed with their reasons.

**As of Milestone 2:** mortality, one illness, families and schooling. The full list of targets is
in [DESIGN.md §13](DESIGN.md#13-calibration-targets); each joins this document when the system that
produces it is built.

## How to reproduce

```sh
npm run batch -- --lives 20000 --seed cal-m2 --strategy persona --no-text
```

The result depends only on the seed, the strategy, the number of lives and the content; life *i*
always has seed `cal-m2-i`. Lives in a batch are never protected in early childhood (see
Deviations). Unless a row says otherwise, the numbers below are from that command at content hash
`b3cecb6bb93d146b`.

The players are **persona** players: each acts as its own drawn temperament would, and takes the
choices that are the player's alone (leaving school, enrolling later) at the same rates as the
people the player does not control. So the statistics describe the simulated population, not a
strategy.

## How sure the sources are

| Marked | Meaning |
|--------|---------|
| **file** | The figure was read from the publisher's own table, downloaded during this work. |
| **memory** | The figure was written from memory of the cited publication and still needs pinning. |

Read from file so far: NCHS life tables 2023; Census state populations 2023; NCES Digest 2023
tables 104.20 (attainment), 219.46 (graduation), 302.10 (enrollment), 326.10 (completion) and
331.30 (net price).

## Mortality

Source: NCHS, *United States Life Tables, 2023* (NVSR vol. 74 no. 6), Tables 2 and 3 (**file**).
Mortality is still an input: the engine draws death directly from the table, and how a person
lives does not yet change it. Unchanged since Milestone 1.

| Metric | Published | Simulated, 100,000 lives (M1) | Simulated, 20,000 lives (M2) |
|--------|-----------|-------------------------------|------------------------------|
| Life expectancy at birth, male | 75.82 | 75.94 ± 0.08 | 75.48 ± 0.18 |
| Life expectancy at birth, female | 81.08 | 81.16 ± 0.07 | 80.80 ± 0.16 |
| Infant mortality per 1,000 births | 5.6 | 5.4 | 6.9 |
| Survival to 65, male / female | 79.0% / 87.4% | 79.3% / 87.5% | 78.7% / 87.3% |

The Milestone 2 batch is a little low on both sexes. I checked that this is the draw of seeds and
not the new systems: the life table applied on its own to the same 20,000 seeds gives exactly
75.48 and 80.80, and to the next 200,000 gives 75.80 and 81.02. A unit test also requires the
engine to end each of 150 lives in exactly the month the table and the seed dictate. Use 100,000
lives when a tenth of a year matters.

## Illness

| Metric | Target | Source | Simulated | Verdict |
|--------|--------|--------|-----------|---------|
| Symptomatic influenza per person per year | 0.080 | Tokars, Olsen & Reed 2018 (memory) | 0.0797 | within 1% |

## Families

| Metric | Target | Source | Simulated | Verdict |
|--------|--------|--------|-----------|---------|
| Births to married / cohabiting / lone mothers | 60% / 24% / 16% | NCHS births 2022; NSFG (memory) | 62% / 22% / 16% | close |
| Children under 18 living with both parents | about 65% | Census CPS 2023 (memory) | 63.1% | close |
| Brothers and sisters, counted from the child | about 1.8 | Derived from completed family sizes (memory) | 1.74 | close |
| Median household income of families with a newborn | — | no target pinned yet | $80,300 | not checked |

The simulation has no step-parents, so "both parents" means the child's own two. The Census figure
of 71% counts any two parents; 65% is the share with two married parents, the closest published
match. Household income comes from the stub earnings model and has no pinned target; it will be
checked against Census income tables when Milestone 3 replaces the stub.

## Schooling

| Metric | Target | Source | Simulated | Verdict |
|--------|--------|--------|-----------|---------|
| Mean high-school GPA | 3.0–3.1 | NAEP High School Transcript Study 2019 (memory) | 3.04 | within |
| Graduate high school with their class | 86–87% | NCES Digest 2023, Table 219.46 (file) | 86.0% | within |
| Completed high school, ages 25–29 | 94.3% | NCES Digest 2023, Table 104.20 (file) | 94.6% at 27 | within |
| SAT total among takers, mean (sd) | 1028 (about 215) | College Board 2023 (memory) | 1030 (212) | within |
| Enrolled in college the autumn after graduating | 62.0% | NCES Digest 2023, Table 302.10 (file) | 63.3% | within |
| … at a two-year college | 16.9% | same | 18.0% | close |
| … at a four-year college | 45.1% | same | 45.3% | within |
| Ever enrolled by the mid-twenties | about 84% | NCES ELS:2002 (memory) | 81.1% by 27 | close |
| Associate degree or higher, ages 25–29 | 49.7% | NCES Digest 2023, Table 104.20 (file) | 47.7% at 27 | close |
| Bachelor's or higher, ages 25–29 | 40.5% | same | 37.9% at 27 | 6% low |
| … men / women | 35.9% / 45.2% | same | 35.0% / 40.8% | gap too small |
| Four-year entrants holding a degree six years on | about 70% | National Student Clearinghouse (memory) | 69.8% | within |
| Two-year entrants: associate / transferred / bachelor's | about 30% / 33% / 16% | NCES 326.20; NSC (memory) | 39% / 29% / 18% | associates high |
| Bachelor's graduates who borrowed | about half | College Board, Trends in Student Aid (memory) | 48.9% | within |
| Their average debt | about $29,000 | same | $23,600 | low, see below |

Net prices by family income are taken directly from NCES Digest 2023, Table 331.30 (file), for
public two-year, public four-year and private nonprofit colleges; the two selective private tiers
are from memory.

## Causal checks

| Check | Expected | Simulated | Verdict |
|-------|----------|-----------|---------|
| Bachelor's degree by family income quarter, poorest first | about 15 / 28 / 45 / 62% (Pell Institute, memory) | 20 / 29 / 40 / 62% | gradient right; poorest quarter high |
| Enrolled right away, by income quarter | rising steeply | 38 / 54 / 71 / 87% | as expected |
| Achievement gap, 90th vs 10th percentile of family income | 1.0–1.25 SD (Reardon 2011) | 1.30 SD | slightly wide |
| Parent–child schooling correlation | 0.46 (Hertz et al. 2007) | 0.43 | within |
| Poorer children do worse on average, with wide variation | yes | one in five from the poorest quarter earns a bachelor's; nearly four in ten from the richest do not | as intended |
| Effort pays slowly | yes | same child, eight to fifteen: working hard instead of the minimum gains between 0.3 and 3 grade levels; one year gains under half a grade | as intended |
| More activity, more fitness at 60 | ordered | 0.37 / 0.47 / 0.56 / 0.67 | as expected |
| Lifestyle and length of life | none **yet** | none | Milestone 5 |

The achievement gap is measured as Reardon measures it: the correlation between eighth-grade
achievement and the rank of family income, times the 2.56 standard deviations between the 90th and
10th percentiles.

## Known shortfalls

| Shortfall | Why | Plan |
|-----------|-----|------|
| The gender gap in degrees is about 6 points; the real gap is 9. | One mechanism is modeled: girls' greater engagement with schoolwork, at its measured size. No further modifier was added, by design decision Q2. | Revisit when personality differences and the labor market exist. |
| Bachelor's degrees at 27 are 2.6 points low. | The target is for ages 25–29 and includes adults educated abroad; the simulation measures at 27 and has no immigration. | Accept. |
| Average student debt is about $5,000 low. | Only federal loans exist. The published figure includes private loans. | Private and parent loans arrive with the money system in Milestone 3. |
| Too many community-college entrants finish an associate degree. | Part-time study and work are only roughly modeled. | Revisit with work in Milestone 3. |
| The poorest quarter earn somewhat too many bachelor's degrees. | Probably the same cause: the cost of college bites through unmet need, and most of what makes a poor student leave is in the labor market. | Revisit in Milestone 3. |
| Race and ethnicity are not modeled. | Design decision Q1 is accepted but not yet implemented. | Start of Milestone 3. |

## Deliberate deviations

| Deviation | Reason |
|-----------|--------|
| In interactive play, the player character's own death draws are skipped before age 5. | About 0.7% of US children die before five. A life that ends in the first minute is realistic but is not a game. Batch runs never do this. |
| Deaths are spread evenly over each year of age. | Most infant deaths really come in the first weeks. The effect on life expectancy is about 0.002 years. |
| From age 100 the annual probability of death is constant, and nobody lives past 120. | The published table ends with "100 and older" and a life expectancy; the constant reproduces it. |
| Birth months are uniform, and where a child is born follows state population rather than state births. | Nothing yet depends on the difference. |
| Parents do not re-partner; nobody moves house; grown children stay in the parental household. | Partnerships beyond the parents' arrive in Milestone 4, housing in Milestone 3. |
| College completion is calibrated to a degree from any college, not from the first one attended. | Nobody in the simulation moves between four-year colleges, so the first-college figure (64.6%, NCES 326.10) has no counterpart. |
| Parents' earnings are a stand-in. | Replaced by occupations and employers in Milestone 3. |

## Checks on the game itself

From a 3,000-life batch with text (`--seed m2text --strategy mixed`).

| Check | Target (design §9, §13.4) | Milestone 1 | Milestone 2 | Comment |
|-------|---------------------------|-------------|-------------|---------|
| Invariants broken | none | none | none | Now includes: no parent under 13 at a child's birth; the dead belong to no household or partnership; school status and records agree. |
| Significant feed items by source | player ≥ 50%, NPC ≈ 25%, structural ≈ 15%, chance ≤ 10% | 36 / 0 / 56 / 8 | player 37%, NPC 22%, structural 38%, chance 4% | Family events brought the NPC share to target. Structural is still high and player low, because birthdays and school milestones outnumber things the player does. |
| Decisions opened per year | within the pacing budget | 0.00–0.11 | 0.46 in adolescence, 0.23 in early adulthood, about 0.1 elsewhere | Under budget everywhere. |
| Feed lines per life | — | 112 | 169 | Childhood and school years now read as a story; adult years are still nearly empty. |
| Lives in which some text variant appears more than twice | none | 99% | 99% | Still missed. The repeats are almost all year-summary sentences for quiet adult years, which will stop being quiet. |
| Computing time per simulated year | under 20 ms in Node | 0.14 ms | 0.9 ms | A family of five or six is simulated each month. 20,000 lives take six minutes on four cores. |
| Time for one year in the browser | under 150 ms | about 40 ms | not re-measured | Played through to 27 in headless Chromium with no errors. |

## Not yet calibrated

Everything else in DESIGN.md §13. Values there marked from memory are pinned as their data files
are created.
