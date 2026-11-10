/**
 * Facts the engine itself emits, with the data fields each carries. Content-defined facts declare
 * their own fields; the validator uses both lists to check that text never refers to a field its
 * fact does not provide.
 */
export const ENGINE_FACTS: Record<string, string[]> = {
  birth: ['month', 'year', 'day', 'sex'],
  death: ['age', 'cause'],
  obituary: ['age', 'cause'],
  year_summary: ['age', 'year', 'stage', 'trend', 'cause', 'illnesses', 'choices', 'quiet', 'highlight', 'phrase'],
  band_changed: ['descriptor', 'from', 'to', 'direction'],
  activity_changed: ['from', 'to', 'direction'],
  decision_opened: ['event', 'decision', 'optional'],
  decision_made: ['event', 'option', 'choice', 'lapsed'],
}

/** Engine facts that the narrator assembles from several texts instead of one template. */
export const COMPOSED_FACTS = new Set(['year_summary', 'obituary', 'decision_opened'])

/** Text ids the narrator fetches by name. The validator requires each to exist. */
export const REQUIRED_TEXT_IDS = [
  'summary.quiet',
  'summary.trend_up',
  'summary.trend_down',
  'summary.growing',
  'summary.illness',
  'summary.highlight',
  'obituary.opening',
  'obituary.activity',
  'why.base',
  'why.death',
  'why.death_table_only',
  'why.more',
  'why.less',
  'why.hidden',
]
