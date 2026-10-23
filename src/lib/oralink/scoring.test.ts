import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildAnswers,
  foldText,
  scoreLead,
  validateScoringRules,
  type ScoringRules,
} from './scoring'

const RULES: ScoringRules = {
  account: 'test',
  version: 'test-1',
  rules: [
    { id: 'fleet', field: 'tags', op: 'contains', value: 'tz:type:flotte', points: 30 },
    { id: 'city_known', field: 'ville', op: 'in', values: ['Casablanca', 'Aïn Sebaâ'], points: 20 },
    { id: 'vehicles_2plus', field: 'nb_vehicules', op: 'gte', value: 2, points: 15 },
    { id: 'vehicles_small', field: 'nb_vehicules', op: 'lte', value: 1, points: 5 },
    { id: 'callback', field: 'tags', op: 'contains', value: 'rappel', points: 10 },
    { id: 'no_city', field: 'ville', op: 'absent', points: -10 },
    { id: 'has_email', field: 'email', op: 'present', points: 5 },
    { id: 'segment_riad', field: 'segment', op: 'equals', value: 'riad', points: 25 },
    { id: 'notes_urgent', field: 'notes', op: 'contains', value: 'urgent', points: 10 },
  ],
}

describe('scoreLead', () => {
  it('sums matched rules and explains each one, in rule order', () => {
    const r = scoreLead(
      { tags: ['src:OL-TZ-BF1', 'tz:type:flotte', 'rappel'], ville: 'casablanca ', nb_vehicules: '3 camions' },
      RULES,
    )
    expect(r.score).toBe(75)
    expect(r.reasons).toEqual([
      { rule: 'fleet', points: 30, valeur: 'tz:type:flotte' },
      { rule: 'city_known', points: 20, valeur: 'casablanca ' },
      { rule: 'vehicles_2plus', points: 15, valeur: 3 },
      { rule: 'callback', points: 10, valeur: 'rappel' },
    ])
  })

  it('is accent- and case-insensitive', () => {
    const r = scoreLead({ ville: 'AIN SEBAA', segment: 'RIAD' }, RULES)
    expect(r.reasons.map((x) => x.rule)).toEqual(['city_known', 'segment_riad'])
    expect(foldText('Aïn  Sebaâ')).toBe('ain sebaa')
  })

  it('applies negative points and clamps to 0', () => {
    const r = scoreLead({}, RULES)
    expect(r.reasons).toEqual([{ rule: 'no_city', points: -10, valeur: null }])
    expect(r.score).toBe(0)
  })

  it('clamps to 100', () => {
    const rules: ScoringRules = {
      account: 't',
      version: 'v',
      rules: [
        { id: 'a', field: 'x', op: 'present', points: 80 },
        { id: 'b', field: 'y', op: 'present', points: 80 },
      ],
    }
    expect(scoreLead({ x: '1', y: '1' }, rules).score).toBe(100)
  })

  it('treats empty strings / arrays as absent and ignores non-numeric for gte', () => {
    const r = scoreLead({ ville: '   ', email: '', nb_vehicules: 'beaucoup', tags: [] }, RULES)
    expect(r.reasons.map((x) => x.rule)).toEqual(['no_city'])
  })

  it('contains on a string is a substring match; on an array an exact element match', () => {
    expect(scoreLead({ notes: 'Très URGENT svp' }, RULES).reasons.map((x) => x.rule)).toContain('notes_urgent')
    expect(scoreLead({ tags: ['tz:type:flotte-xl'] }, RULES).reasons.map((x) => x.rule)).not.toContain('fleet')
  })

  it('never copies free text into reasons (present → true, contains → matched term)', () => {
    const r = scoreLead({ email: 'lead@example.test', notes: 'Très URGENT, rappeler Mme X' }, RULES)
    expect(r.reasons).toEqual(
      expect.arrayContaining([
        { rule: 'has_email', points: 5, valeur: true },
        { rule: 'notes_urgent', points: 10, valeur: 'urgent' },
      ]),
    )
    expect(JSON.stringify(r.reasons)).not.toMatch(/example\.test|Mme X/)
  })

  it('ignores inherited keys such as __proto__ / constructor', () => {
    const rules: ScoringRules = {
      account: 't',
      version: 'v',
      rules: [
        { id: 'p', field: '__proto__', op: 'present', points: 50 },
        { id: 'c', field: 'constructor', op: 'present', points: 50 },
      ],
    }
    expect(scoreLead({}, rules)).toEqual({ score: 0, reasons: [] })
  })

  it('lte matches small numbers, decimal comma accepted', () => {
    expect(scoreLead({ nb_vehicules: '1,0' }, RULES).reasons.map((x) => x.rule)).toContain('vehicles_small')
  })

  it('is pure: same input, same output, inputs untouched', () => {
    const answers = { tags: ['rappel'], ville: 'Casablanca' }
    const snapshot = JSON.stringify({ answers, RULES })
    expect(scoreLead(answers, RULES)).toEqual(scoreLead(answers, RULES))
    expect(JSON.stringify({ answers, RULES })).toBe(snapshot)
  })
})

describe('validateScoringRules', () => {
  it('accepts the test rules', () => {
    expect(validateScoringRules(RULES)).toEqual([])
  })

  it('reports structural errors', () => {
    const errors = validateScoringRules({
      account: '',
      version: 'x'.repeat(65),
      rules: [
        { id: 'a', field: 'f', op: 'nope', points: 1 },
        { id: 'a', field: 'f', op: 'in', points: 1.5 },
        { id: 'b', field: '', op: 'gte', value: 'abc', points: 200 },
        { id: 'c', field: 'f', op: 'equals', points: 1 },
      ],
    })
    expect(errors).toEqual(
      expect.arrayContaining([
        'account is required',
        expect.stringMatching(/^version/),
        'rules[0].op invalid: nope',
        'rules[1].id duplicated: a',
        'rules[1].points must be an integer in -100…100',
        'rules[1].values required for op "in"',
        'rules[2].field is required',
        'rules[2].value must be numeric for op "gte"',
        'rules[2].points must be an integer in -100…100',
        'rules[3].value required for op "equals"',
      ]),
    )
    expect(validateScoringRules(null)).toEqual(['rules must be an object'])
  })
})

describe('buildAnswers', () => {
  it('merges scalar flow vars with tag names', () => {
    expect(
      buildAnswers({ vars: { ville: 'Casa', n: 2, ok: true, nested: { a: 1 }, tags: 'spoof' }, tags: ['rappel'] }),
    ).toEqual({ ville: 'Casa', n: 2, ok: true, tags: ['rappel'] })
    expect(buildAnswers({})).toEqual({ tags: [] })
  })
})

describe('shipped rule files (oralink/crm/scoring/*.json)', () => {
  const dir = join(__dirname, '..', '..', '..', 'oralink', 'crm', 'scoring')
  const files = (() => {
    try {
      return readdirSync(dir).filter((f) => f.endsWith('.json'))
    } catch {
      return []
    }
  })()

  it.skipIf(files.length === 0)('every rules file validates', () => {
    for (const f of files) {
      const json = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      expect({ file: f, errors: validateScoringRules(json) }).toEqual({ file: f, errors: [] })
    }
  })
})
