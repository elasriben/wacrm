// WhatsApp interactive-message limits enforced by the gateway BEFORE anything is forwarded to SendZen.
//
// Source: Meta Cloud API documentation (interactive reply buttons / list messages). The same numbers
// are already enforced by waCRM (src/lib/whatsapp/meta-api.ts INTERACTIVE_LIMITS); the gateway checks
// them again because (1) it must never forward a payload WhatsApp is known to refuse, and (2) how
// SendZen reports such a refusal is NOT yet known (TEST-PLAN T-S3/T-S4). Lengths are counted in
// Unicode code points (WhatsApp counts characters); waCRM counts UTF-16 units, which is stricter, so
// anything waCRM lets through passes here.
//
// Only the two interactive sub-types the contract allows (CONTRACTS §7) are accepted: `button` (reply
// buttons) and `list`. Any other sub-type (cta_url, flow, product, location_request…) is unverified
// through SendZen and is refused with 501 by the caller.
export const LIMITS = Object.freeze({
  maxButtons: 3,
  buttonIdMax: 256,
  buttonTitleMax: 20,
  listButtonMax: 20,
  maxSections: 10,
  maxRowsTotal: 10,
  sectionTitleMax: 24,
  rowIdMax: 200,
  rowTitleMax: 24,
  rowDescriptionMax: 72,
  bodyMax: 1024,
  headerTextMax: 60,
  footerMax: 60,
})

export const SUPPORTED_INTERACTIVE = Object.freeze(['button', 'list'])

const len = (s) => [...s].length
const isStr = (s) => typeof s === 'string'
const nonEmpty = (s) => isStr(s) && s.trim().length > 0

/**
 * Validate a Meta-shaped `interactive` object.
 * @returns {{ ok: true } | { ok: false, unsupported?: true, reason: string }}
 */
export function validateInteractive(interactive) {
  if (!interactive || typeof interactive !== 'object' || Array.isArray(interactive)) return fail('interactive object is required')
  const { type } = interactive
  if (!SUPPORTED_INTERACTIVE.includes(type)) return { ok: false, unsupported: true, reason: `interactive type "${type}" is not enabled on this gateway (allowed: ${SUPPORTED_INTERACTIVE.join(', ')})` }

  if (!nonEmpty(interactive.body?.text)) return fail('body.text is required')
  if (len(interactive.body.text) > LIMITS.bodyMax) return fail(`body.text exceeds ${LIMITS.bodyMax} characters`)
  if (interactive.header !== undefined) {
    // Media headers (image/video/document) are valid WhatsApp but unverified through SendZen: 501.
    if (interactive.header?.type !== 'text') return { ok: false, unsupported: true, reason: 'only a text header is enabled on this gateway (media headers are not verified through SendZen)' }
    if (!nonEmpty(interactive.header.text)) return fail('header.text is required when a header is present')
    if (len(interactive.header.text) > LIMITS.headerTextMax) return fail(`header.text exceeds ${LIMITS.headerTextMax} characters`)
  }
  if (interactive.footer !== undefined) {
    if (!nonEmpty(interactive.footer?.text)) return fail('footer.text is required when a footer is present')
    if (len(interactive.footer.text) > LIMITS.footerMax) return fail(`footer.text exceeds ${LIMITS.footerMax} characters`)
  }

  const action = interactive.action
  if (!action || typeof action !== 'object') return fail('action is required')

  if (type === 'button') {
    const buttons = action.buttons
    if (!Array.isArray(buttons) || buttons.length < 1 || buttons.length > LIMITS.maxButtons) return fail(`between 1 and ${LIMITS.maxButtons} buttons are required (got ${Array.isArray(buttons) ? buttons.length : 0})`)
    const ids = new Set()
    for (const [i, b] of buttons.entries()) {
      if (b?.type !== 'reply') return fail(`button ${i + 1}: only "reply" buttons are supported`)
      const { id, title } = b.reply ?? {}
      if (!nonEmpty(id)) return fail(`button ${i + 1}: reply.id is required`)
      if (len(id) > LIMITS.buttonIdMax) return fail(`button ${i + 1}: reply.id exceeds ${LIMITS.buttonIdMax} characters`)
      if (ids.has(id)) return fail(`button ${i + 1}: duplicate reply.id`)
      ids.add(id)
      if (!nonEmpty(title)) return fail(`button ${i + 1}: reply.title is required`)
      if (len(title) > LIMITS.buttonTitleMax) return fail(`button ${i + 1}: reply.title exceeds ${LIMITS.buttonTitleMax} characters`)
    }
    return { ok: true }
  }

  // list
  if (!nonEmpty(action.button)) return fail('action.button (list button label) is required')
  if (len(action.button) > LIMITS.listButtonMax) return fail(`action.button exceeds ${LIMITS.listButtonMax} characters`)
  const sections = action.sections
  if (!Array.isArray(sections) || sections.length < 1 || sections.length > LIMITS.maxSections) return fail(`between 1 and ${LIMITS.maxSections} sections are required`)
  let total = 0
  const ids = new Set()
  for (const [s, section] of sections.entries()) {
    if (section?.title !== undefined) {
      if (!nonEmpty(section.title)) return fail(`section ${s + 1}: title must not be empty`)
      if (len(section.title) > LIMITS.sectionTitleMax) return fail(`section ${s + 1}: title exceeds ${LIMITS.sectionTitleMax} characters`)
    } else if (sections.length > 1) {
      return fail(`section ${s + 1}: a title is required when there are several sections`)
    }
    if (!Array.isArray(section?.rows) || section.rows.length < 1) return fail(`section ${s + 1}: at least one row is required`)
    for (const [r, row] of section.rows.entries()) {
      total += 1
      const where = `section ${s + 1} row ${r + 1}`
      if (!nonEmpty(row?.id)) return fail(`${where}: id is required`)
      if (len(row.id) > LIMITS.rowIdMax) return fail(`${where}: id exceeds ${LIMITS.rowIdMax} characters`)
      if (ids.has(row.id)) return fail(`${where}: duplicate row id`)
      ids.add(row.id)
      if (!nonEmpty(row.title)) return fail(`${where}: title is required`)
      if (len(row.title) > LIMITS.rowTitleMax) return fail(`${where}: title exceeds ${LIMITS.rowTitleMax} characters`)
      if (row.description !== undefined && (!isStr(row.description) || len(row.description) > LIMITS.rowDescriptionMax)) return fail(`${where}: description exceeds ${LIMITS.rowDescriptionMax} characters`)
    }
  }
  if (total > LIMITS.maxRowsTotal) return fail(`at most ${LIMITS.maxRowsTotal} rows in total are allowed (got ${total})`)
  return { ok: true }
}

function fail(reason) { return { ok: false, reason } }
