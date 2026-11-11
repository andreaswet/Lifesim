# Calibration

How the simulation compares with real statistics for the United States. One row per target: its
source, the pinned value, what the simulation produces, and a verdict. Deliberate deviations are
listed with their reasons.

**As of Milestone 3:** mortality, one illness, families, schooling, the economy, work and pay,
household money, wealth and housing. The full list of targets is in
[DESIGN.md §13](DESIGN.md#13-calibration-targets); each joins this document when the system that
produces it is built.

## How to reproduce

```sh
npm run batch -- --lives 5000 --seed cal-m3 --strategy persona --no-text
```

The result depends only on the seed, the strategy, the number of lives and the content; life *i*
always has seed `cal-m3-i`. Lives in a batch are never protected in early childhood (see
Deviations). Unless a row says otherwise, the numbers below are from that command at content hash
`@@HASH@@`. It takes about five minutes on four cores.

The players are **persona** players: each acts as its own drawn temperament would, and takes the
choices that are the player's alone (leaving school, enrolling later, moving out, buying a home,
quitting, stepping out of work, retiring) at the same rates as the people the player does not
control. So the statistics describe the simulated population, not a strategy.

**How a cohort is compared with a cross-section.** The simulation follows one cohort, born in
2026, through a future whose institutions and real price levels are frozen (design decisions Q5,
Q7). Pooling every year of every life gives a stationary population, which is what the work,
income and wealth rows below compare with today's cross-section. Money is in 2026 dollars: the
batch tool divides each amount by the price level of its year.

**One household, one adult.** The player has no partner until Milestone 4, so every household the
player heads lives on one income, while about half of real households are married couples with
two. Measures of whole households (household income, poverty, homeownership, rent) are expected
to fall short until then, and are marked so. Measures of people (pay, unemployment, employment)
are not affected.

## How sure the sources are

| Marked | Meaning |
|--------|---------|
| **file** | The figure was read from the publisher's own table, downloaded during this work. |
| **memory** | The figure was written from memory of the cited publication and still needs pinning. |

Read from file so far: NCHS life tables 2023; Census state populations 2023; NCES Digest 2023
tables 104.20 (attainment), 219.46 (graduation), 302.10 (enrollment), 326.10 (completion) and
331.30 (net price).

**Everything added in Milestone 3 is from memory:** the occupation catalog (BLS OEWS May 2023,
CPS 2023), the labor-market rates, the state columns in `places/states.csv`, the 2025 federal tax
parameters (IRS Rev. Proc. 2024-40), the Social Security formula, SNAP, health premiums, housing
and credit figures, the Survey of Consumer Finances wealth figures, and the economy's regime
values. The tax and Social Security formulas are checked in tests against worked examples; the
figures they use still need pinning against the publications.

## Mortality

Source: NCHS, *United States Life Tables, 2023* (NVSR vol. 74 no. 6), Tables 2 and 3 (**file**).
Mortality is still an input: the engine draws death directly from the table, and how a person
lives does not yet change it.

| Metric | Published | 100,000 lives (M1) | 20,000 lives (M2) | 5,000 lives (M3) |
|--------|-----------|--------------------|-------------------|------------------|
| Life expectancy at birth, male | 75.82 | 75.94 ± 0.08 | 75.48 ± 0.18 | 76.07 ± 0.35 |
| Life expectancy at birth, female | 81.08 | 81.16 ± 0.07 | 80.80 ± 0.16 | 80.78 ± 0.32 |
| Infant mortality per 1,000 births | 5.6 | 5.4 | 6.9 | 6.0 |
| Survival to 65, male / female | 79.0% / 87.4% | 79.3% / 87.5% | 78.7% / 87.3% | 80.1% / 87.1% |

Every Milestone 3 figure is within sampling error of the table. Because draws are keyed, the new
systems do not move anybody's death: the golden lives die in the same month as before.

## Illness

| Metric | Target | Source | Simulated | Verdict |
|--------|--------|--------|-----------|---------|
| Symptomatic influenza per person per year | 0.080 | Tokars, Olsen & Reed 2018 (memory) | 0.0798 | within 1% |

## The economy

From 400 simulated economies of 80 years each, the economy alone (it does not depend on anybody's
choices). Returns are real, after inflation, as yearly log changes.

| Metric | Target | Source | Simulated | Verdict |
|--------|--------|--------|-----------|---------|
| Years between recessions | about 6 | NBER business cycle dates, 1945–2020 (memory) | 6.5 | within |
| Length of a recession | about 10 months | same | 10.8 | within |
| Unemployment rate, long-run mean | 5.5–6% | BLS CPS 1948–2024 (memory) | 5.8% | within |
| Unemployment, range | 3.5% to 10%+ | same | 4.2% to 10.9% | close; no very low years |
| Inflation, mean / spread of yearly rates | 2–3%, with spikes | BLS CPI-U (memory) | 2.7% / 1.3 points | within |
| Stocks, real return / yearly volatility | 6.5–7% / about 17% | Shiller; Dimson, Marsh & Staunton (memory) | 6.4% / 18% | within |
| Bonds, real return | about 2% | same | 2.0% | within |
| House prices, real growth | about 0–1% a year | Shiller; FHFA (memory) | 0.3% | within |
| Real wages over a life | no drift (by design) | design decision Q7 | −3% over 80 years | within |

## Families

| Metric | Target | Source | Simulated | Verdict |
|--------|--------|--------|-----------|---------|
| Births to married / cohabiting / lone mothers | 60% / 24% / 16% | NCHS births 2022; NSFG (memory) | 61% / 23% / 16% | within |
| Children under 18 living with both parents | about 65% | Census CPS 2023 (memory) | 61.8% | close |
| Brothers and sisters, counted from the child | about 1.8 | Derived from completed family sizes (memory) | 1.78 | within |

The simulation has no step-parents, so "both parents" means the child's own two. The Census figure
of 71% counts any two parents; 65% is the share with two married parents, the closest published
match. Parents now separate a little more often than in Milestone 2 because spells of unemployment,
which raise the risk, come from the labor market.

## Schooling

| Metric | Target | Source | Simulated | Verdict |
|--------|--------|--------|-----------|---------|
| Mean high-school GPA | 3.0–3.1 | NAEP High School Transcript Study 2019 (memory) | 3.02 | within |
| Graduate high school with their class | 86–87% | NCES Digest 2023, Table 219.46 (file) | 85.0% | close |
| Completed high school, ages 25–29 | 94.3% | NCES Digest 2023, Table 104.20 (file) | 94.5% at 27 | within |
| SAT total among takers, mean (sd) | 1028 (about 215) | College Board 2023 (memory) | 1014 (206) | within |
| Enrolled in college the autumn after graduating | 62.0% | NCES Digest 2023, Table 302.10 (file) | 63.3% | within |
| … at a two-year college | 16.9% | same | 18.5% | close |
| … at a four-year college | 45.1% | same | 44.8% | within |
| Ever enrolled by the mid-twenties | about 84% | NCES ELS:2002 (memory) | 82.8% by 27 | close |
| Associate degree or higher, ages 25–29 | 49.7% | NCES Digest 2023, Table 104.20 (file) | 48.0% at 27 | close |
| Bachelor's or higher, ages 25–29 | 40.5% | same | 38.0% at 27 | 6% low |
| … men / women | 35.9% / 45.2% | same | 36.0% / 40.1% | gap too small |
| Four-year entrants holding a degree six years on | about 70% | National Student Clearinghouse (memory) | 66.4% | close |
| Two-year entrants: associate / transferred / bachelor's | about 30% / 33% / 16% | NCES 326.20; NSC (memory) | 40% / 32% / 21% | associates high |
| Bachelor's graduates who borrowed | about half | College Board, Trends in Student Aid (memory) | 65% | high, see below |
| Their average debt | about $29,000 | same | $21,600 | low, see below |

A student's job now counts against their studies once it passes fifteen hours a week (Darolia
2014), which costs a few points of completion compared with Milestone 2. Net prices by family
income are taken directly from NCES Digest 2023, Table 331.30 (file), for public two-year, public
four-year and private nonprofit colleges; the two selective private tiers are from memory.

## Work and pay

People, not households. Pay is the median of full-time workers 25 and over, in 2026 dollars a week.

| Metric | Target | Source | Simulated | Verdict |
|--------|--------|--------|-----------|---------|
| Unemployment rate, 16 and over | 5.5–6% long-run | BLS 1948–2024 (memory) | 7.2% | high |
| … 25+, by schooling: none / HS / some college / associate / BA / graduate | 8.9 / 6.0 / 5.0 / 4.1 / 3.3 / 2.6 | BLS 2024 (6.2 / 4.2 / 3.5 / 2.9 / 2.3 / 1.8), scaled to the long-run mean | 9.7 / 7.3 / 5.8 / 5.2 / 4.5 / 2.9 | gradient right; 15–35% high |
| Employed, ages 25–54 | about 80% | BLS CPS 2024 (memory) | 82.2% | within |
| Median weekly pay, full-time, 25+ | about $1,200 | BLS CPS 2025 (memory) | $1,260 | within |
| … no diploma / HS / BA / graduate | $740 / $930 / $1,540 / about $1,900 | BLS, Education Pays 2024 (memory) | $653 / $843 / $1,605 / $2,024 | ends of the range low |
| Bachelor's pay over high school | about 65% | same | 90% | too wide |
| Women's median pay as a share of men's | 83% | BLS, Highlights of Women's Earnings 2023 (memory) | 90% | gap too small, see below |
| Median job tenure | 3.9 years | BLS, Employee Tenure 2024 (memory) | 3.3 | close |
| Jobs held from 18 to 56 | 12–13 | BLS NLSY79 (memory) | 9.7 | low |
| Median age at retirement | about 62–64 | Gallup; Center for Retirement Research (memory) | 64 | within |
| Uninsured, ages 18–64 | about 11% (19–64) | Census, Health Insurance Coverage 2024 (memory) | 12.7% | close |
| Layoffs preceded by a sign the character noticed | 80% or more | design §9.5 | 83.8% | within |

The BLS unemployment rates by schooling were measured in 2024, when the overall rate was 4.0%.
The simulated cohort lives through an average of all years, recessions included, so the targets
are scaled up by the ratio of the long-run mean to 2024 (5.7 / 4.0).

## Household income, wealth and housing

Households headed by the simulated person, pooled over every year of their adult life.

| Metric | Target | Source | Simulated | Verdict |
|--------|--------|--------|-----------|---------|
| Median household income | about $84,000 | Census CPS ASEC 2024 (memory) | $37,900 | low: one adult |
| People below the poverty line | about 11% | Census, official measure (memory) | 16.6% | high: one adult |
| Median household net worth | $193,000 | Federal Reserve SCF 2022 (memory) | $153,000 | close |
| … by age of head: under 35 / 35–44 / 45–54 / 55–64 / 65–74 / 75+ | $39k / 135k / 247k / 365k / 410k / 335k | same | $14k / 110k / 254k / 427k / 467k / 309k | within from 35 on; young low |
| Homeownership: all households / head under 35 | 65% / 38% | Census Housing Vacancy Survey 2024 (memory) | 40% / 16% | low: one adult |
| Young adults living with parents: 18–24 / 25–34 | 56% / 16% | Census CPS 2023 (memory) | 66% / 19% | high |
| Median rent paid | $1,400–1,500 | Census ACS 2023 (memory) | $1,061 | low: one adult |

## Groups (design decision Q1)

| Check | Expected | Simulated | Verdict |
|-------|----------|-----------|---------|
| Median net worth at 45–54, by group | white far above Black and Hispanic; SCF 2022 medians for all ages: white $285k, Black $45k, Hispanic $62k (memory) | white $295k, Black $198k, Hispanic $185k, Asian $313k | direction right, gaps far too small |
| Hiring callbacks for equally qualified applicants | white 36% above Black, 24% above Latino (Quillian et al. 2017) | applied as named factors; shown in "Why?" | as designed |
| Mortgage denials at the same finances | somewhat higher for Black, Hispanic and Asian applicants (Bhutta et al. 2022) | applied as a named factor | as designed |

## Causal checks

| Check | Expected | Simulated | Verdict |
|-------|----------|-----------|---------|
| Bachelor's degree by family income quarter, poorest first | about 15 / 28 / 45 / 62% (Pell Institute, memory) | 23 / 29 / 41 / 60% | gradient right; poorest quarter high |
| Enrolled right away, by income quarter | rising steeply | 46 / 52 / 67 / 85% | as expected |
| Achievement gap, 90th vs 10th percentile of family income | 1.0–1.25 SD (Reardon 2011) | 1.21 SD | within |
| Parent–child schooling correlation | 0.46 (Hertz et al. 2007) | 0.44 | within |
| Education and earnings | bachelor's premium about 65% (BLS) | 90% | right direction, too large |
| Parent–child income rank slope | 0.34 (Chetty et al. 2014) | 0.24 | too mobile, see below |
| Born in the bottom fifth, reaching the top fifth | 7.5% (same) | 11.3% | too mobile |
| Poorer children do worse on average, with wide variation | yes | one in four from the poorest quarter earns a bachelor's; four in ten from the richest do not | as intended |
| Effort pays slowly | yes | unchanged since Milestone 2 | as intended |
| More activity, more fitness at 60 | ordered | 0.37 / 0.47 / 0.56 / 0.67 | as expected |
| Lifestyle and length of life | none **yet** | none | Milestone 5 |

The achievement gap is measured as Reardon measures it: the correlation between eighth-grade
achievement and the rank of family income, times the 2.56 standard deviations between the 90th and
10th percentiles. The income rank slope is measured as Chetty et al. measure it: parents'
household income averaged over the childhood years, against the person's own income (with a
partner's, when there is one) at 30–34, each ranked within its generation.

## Known shortfalls

| Shortfall | Why | Plan |
|-----------|-----|------|
| Household income, poverty, homeownership and rent fall well short. | Every household the simulated person heads has one adult and one income; half of real households have two. | Partnerships arrive in Milestone 4. Re-measure then. |
| The gender pay gap is 10% rather than 17%. | Sorting into occupations, hours and spells out of work are modeled, as design decision Q2 requires; the largest mechanism, the fall in mothers' earnings after a first child (Kleven et al. 2019), needs children. | Milestone 4. No residual modifier unless the gap is still far off then. |
| Income mobility is too high (rank slope 0.24 against 0.34). | Family background reaches adult income through schooling, genes and a direct effect on pay. Missing: a partner's income, which raises the persistence of family income (Chadwick & Solon 2002), and networks and neighborhoods. | Re-measure after Milestone 4; referrals from the network arrive with it. |
| Wealth gaps between groups are far smaller than in life. | Starting wealth and homeownership differ by group, and two direct effects are modeled, but most of the real gap is built over generations through inheritance and homeownership, and a single generation of the simulation inherits little of it. | Revisit when continuing as a descendant exists (Milestone 7), and with the inheritance pass. |
| Unemployment is 15–35% above target at every level of schooling, and the bachelor's premium is too wide. | Spells out of work for people coming back from time at home count as unemployment, as the BLS counts them; lower-schooled workers spend more months out and on junior rungs. | Revisit with the full routine in Milestone 5, which changes who steps out and why. |
| Too many college graduates borrow, and they borrow too little each. | Parents' incomes now come from the labor market and are a little lower at birth than the Milestone 2 stand-in, so more students qualify for and take federal loans; few take private loans. | Revisit with family money in Milestone 4. |
| Young adults stay at home somewhat too long, and the young have too little wealth. | Leaving home needs a job and a landlord's yes; a young person on their own buys a home late. | Milestone 4 (moving in with a partner is the commonest way out). |
| Jobs held by 56 are low (9.7 against 12–13). | The survey counts very short and simultaneous jobs; the simulation holds one job at a time. | Accept for now. |
| The gender gap in degrees is about 4 points; the real gap is 9. | One mechanism is modeled: girls' greater engagement with schoolwork. No further modifier was added, by design decision Q2. | Revisit with personality development in Milestone 5. |
| Too many community-college entrants finish an associate degree. | Part-time study is only roughly modeled. | Revisit with the full routine in Milestone 5. |

## Deliberate deviations

| Deviation | Reason |
|-----------|--------|
| In interactive play, the player character's own death draws are skipped before age 5. | About 0.7% of US children die before five. A life that ends in the first minute is realistic but is not a game. Batch runs never do this. |
| Deaths are spread evenly over each year of age. | Most infant deaths really come in the first weeks. The effect on life expectancy is about 0.002 years. |
| From age 100 the annual probability of death is constant, and nobody lives past 120. | The published table ends with "100 and older" and a life expectancy; the constant reproduces it. |
| Birth months are uniform, and where a child is born follows state population rather than state births. | Nothing yet depends on the difference. |
| Parents do not re-partner, and nobody moves between states. | Partnerships beyond the parents' arrive in Milestone 4; moving between states and metros later. |
| College completion is calibrated to a degree from any college, not from the first one attended. | Nobody in the simulation moves between four-year colleges, so the first-college figure (64.6%, NCES 326.10) has no counterpart. |
| Real wages and real house prices have no long-run trend. | The cohort is compared with today's cross-section (design decision Q7). |
| Nobody is homeless: the floor after losing a home is a room in someone else's. | Homelessness needs the network of people who might take someone in, which arrives in Milestone 4. |
| Health costs are an average by kind of cover and age, with an average cost of care in old age. | Health arrives in Milestone 5. |
| A child of parents from different groups is counted in the "multiracial or another group" group. | One attribute per person; the alternative is a mixed-ancestry model the data do not support well. |

## Checks on the game itself

From a 3,000-life batch with text (`--seed m3text --strategy mixed`), except the browser row.

| Check | Target (design §9, §13.4) | Milestone 1 | Milestone 2 | Milestone 3 | Comment |
|-------|---------------------------|-------------|-------------|-------------|---------|
| Invariants broken | none | none | none | none | Now includes: all accounts sum to zero to the cent; no debt above zero or asset below it; nobody owns a home they do not live in; the dead hold no money, job or home; nobody works without the license their job needs. |
| Significant feed items by source | player ≥ 50%, NPC ≈ 25%, structural ≈ 15%, chance ≤ 10% | 36 / 0 / 56 / 8 | 37 / 22 / 38 / 4 | @@SOURCES@@ | Work and money are mostly the player's own doing. The NPC share falls because nobody but the family exists yet. |
| Decisions opened per year | within the pacing budget | 0.00–0.11 | 0.46 in adolescence, 0.23 in early adulthood, about 0.1 elsewhere | @@DECISIONS@@ | Job offers and the Social Security claim. Under budget everywhere. |
| Feed lines per life | — | 112 | 169 | @@LINES@@ | Adult years now read as a working life. |
| Lives in which some text variant appears more than twice | none | 99% | 99% | @@REPEATS@@ | Still missed: reviews, tax returns and year summaries recur every year of a long working life. More text is Milestone 6. |
| Computing time per simulated year | under 20 ms in Node | 0.14 ms | 0.9 ms | @@MS@@ | 5,000 lives take five minutes on four cores. |
| Time for one year in the browser | under 150 ms | about 40 ms | not re-measured | under 160 ms including an 80 ms pause per key press in the test | Played to 23 in headless Chromium with no errors; phone width has no horizontal scrolling. |

## Not yet calibrated

Everything else in DESIGN.md §13. Values there marked from memory are pinned as their data files
are created.
