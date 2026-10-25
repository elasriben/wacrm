/**
 * OraLink — explainable lead scoring (CONTRACTS §5 « scoring »). PURE: no I/O.
 *
 *   scoreLead(answers, rules) → { score, reasons }
 *
 * `answers` is a flat record built from what the native features already
 * capture: flow variables (`collect_input` → flow_runs.vars) and the
 * contact's tag NAMES under the key `tags` (button / list choices are
 * recorded by `set_tag` nodes). See buildAnswers().
 *
 * `rules` is the JSON in oralink/crm/scoring/<compte>.json. Every matched
 * rule contributes `points` (may be negative) and one reason
 * `{ rule, points, valeur }`. The total is clamped to 0–100 and rounded.
 * `valeur` never copies free text: `present` reports `true`, `contains`
 * on a string reports the matched term; `equals` / `in` report the answer
 * (bounded by the rule's own values) and `gte` / `lte` the parsed number.
 * Rules are evaluated in file order; reasons keep that order.
 */

export type ScoringOp = 'equals' | 'in' | 'contains' | 'present' | 'absent' | 'gte' | 'lte'

export interface ScoringRule {
  id: string
  description?: string
  /** Key in `answers` (`tags` for tag names). */
  field: string
  op: ScoringOp
  /** equals / contains / gte / lte. */
  value?: string | number
  /** in. */
  values?: Array<string | number>
  /** Integer, -100…100. */
  points: number
}

export interface ScoringRules {
  account: string
  version: string
  rules: ScoringRule[]
  [extra: string]: unknown
}

export type AnswerValue = string | number | boolean | null | undefined | Array<string | number>
export type Answers = Record<string, AnswerValue>

export interface ScoreReason {
  rule: string
  points: number
  valeur: string | number | boolean | Array<string | number> | null
}

export interface ScoreResult {
  score: number
  reasons: ScoreReason[]
}

const OPS: readonly ScoringOp[] = ['equals', 'in', 'contains', 'present', 'absent', 'gte', 'lte']

/** Case-, accent- and spacing-insensitive form used for every comparison. */
export function foldText(v: string | number | boolean): string {
  return String(v)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim()
}

function toNumber(v: AnswerValue): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const m = v.match(/-?\d+(?:[.,]\d+)?/)
  if (!m) return null
  const n = Number(m[0].replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

function isPresent(v: AnswerValue): boolean {
  if (v === null || v === undefined) return false
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'string') return v.trim().length > 0
  return true
}

/** Returns the `valeur` to report when the rule matches, or undefined. */
function evaluate(rule: ScoringRule, answer: AnswerValue): ScoreReason['valeur'] | undefined {
  switch (rule.op) {
    case 'present':
      // Data minimisation (loi 09-08): the reason records THAT the answer
      // exists, never the free text itself (an e-mail, a name, a note…).
      return isPresent(answer) ? true : undefined
    case 'absent':
      return isPresent(answer) ? undefined : null
    case 'equals': {
      if (!isPresent(answer) || Array.isArray(answer) || rule.value === undefined) return undefined
      return foldText(answer as string | number | boolean) === foldText(rule.value)
        ? (answer as string | number | boolean)
        : undefined
    }
    case 'in': {
      if (!isPresent(answer) || !rule.values) return undefined
      const allowed = new Set(rule.values.map(foldText))
      if (Array.isArray(answer)) {
        const hit = answer.find((a) => allowed.has(foldText(a)))
        return hit === undefined ? undefined : hit
      }
      return allowed.has(foldText(answer as string | number | boolean))
        ? (answer as string | number | boolean)
        : undefined
    }
    case 'contains': {
      if (!isPresent(answer) || rule.value === undefined) return undefined
      const needle = foldText(rule.value)
      if (Array.isArray(answer)) {
        const hit = answer.find((a) => foldText(a) === needle)
        return hit === undefined ? undefined : hit
      }
      // Report the matched term, not the whole free-text answer (minimisation).
      return foldText(answer as string | number | boolean).includes(needle)
        ? rule.value
        : undefined
    }
    case 'gte':
    case 'lte': {
      const n = toNumber(answer)
      const limit = typeof rule.value === 'number' ? rule.value : toNumber(rule.value)
      if (n === null || limit === null) return undefined
      return (rule.op === 'gte' ? n >= limit : n <= limit) ? n : undefined
    }
  }
}

export function scoreLead(answers: Answers, rules: ScoringRules): ScoreResult {
  const reasons: ScoreReason[] = []
  let total = 0
  for (const rule of rules.rules) {
    // Own keys only: a rule on "__proto__" / "constructor" must not read
    // Object.prototype and count as "present".
    const answer = Object.prototype.hasOwnProperty.call(answers, rule.field)
      ? answers[rule.field]
      : undefined
    const valeur = evaluate(rule, answer)
    if (valeur === undefined) continue
    total += rule.points
    reasons.push({ rule: rule.id, points: rule.points, valeur })
  }
  const score = Math.min(100, Math.max(0, Math.round(total)))
  return { score, reasons }
}

/** Static checks for a rules file. Empty array = valid. */
export function validateScoringRules(input: unknown): string[] {
  const errors: string[] = []
  if (!input || typeof input !== 'object') return ['rules must be an object']
  const r = input as Partial<ScoringRules>
  if (typeof r.account !== 'string' || !r.account) errors.push('account is required')
  if (typeof r.version !== 'string' || !r.version || r.version.length > 64) {
    errors.push('version is required (≤ 64 chars, stored in lead_scores.rules_version)')
  }
  if (!Array.isArray(r.rules)) return [...errors, 'rules must be an array']
  const seen = new Set<string>()
  r.rules.forEach((rule, i) => {
    const where = `rules[${i}]`
    if (!rule || typeof rule !== 'object') {
      errors.push(`${where} must be an object`)
      return
    }
    if (typeof rule.id !== 'string' || !rule.id) errors.push(`${where}.id is required`)
    else if (seen.has(rule.id)) errors.push(`${where}.id duplicated: ${rule.id}`)
    else seen.add(rule.id)
    if (typeof rule.field !== 'string' || !rule.field) errors.push(`${where}.field is required`)
    if (!OPS.includes(rule.op)) errors.push(`${where}.op invalid: ${String(rule.op)}`)
    if (!Number.isInteger(rule.points) || rule.points < -100 || rule.points > 100) {
      errors.push(`${where}.points must be an integer in -100…100`)
    }
    if (rule.op === 'in' && (!Array.isArray(rule.values) || rule.values.length === 0)) {
      errors.push(`${where}.values required for op "in"`)
    }
    if (['equals', 'contains', 'gte', 'lte'].includes(rule.op) && rule.value === undefined) {
      errors.push(`${where}.value required for op "${rule.op}"`)
    }
    if ((rule.op === 'gte' || rule.op === 'lte') && toNumber(rule.value as AnswerValue) === null) {
      errors.push(`${where}.value must be numeric for op "${rule.op}"`)
    }
  })
  return errors
}

/**
 * Build `answers` from native data: flow variables (flow_runs.vars) plus the
 * contact's tag names. Non-scalar vars are dropped.
 */
export function buildAnswers(input: {
  vars?: Record<string, unknown> | null
  tags?: readonly string[] | null
}): Answers {
  const answers: Answers = {}
  for (const [k, v] of Object.entries(input.vars ?? {})) {
    if (k === 'tags') continue
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') answers[k] = v
  }
  answers.tags = [...(input.tags ?? [])]
  return answers
}
