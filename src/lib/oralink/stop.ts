/**
 * OraLink — STOP / START keyword detection (CONTRACTS §5 « STOP »).
 *
 * A message is an opt-out only when its WHOLE content, once normalised,
 * is one of the keywords. "STOP" or " stop. " match; "stop les messages"
 * or "je ne veux pas stopper" do not — a sentence that merely contains
 * the word is a conversation, not an instruction.
 *
 * Normalisation (applied to both the message and the keyword list):
 *   - Unicode NFKD, then combining marks removed: accents (É → E),
 *     Arabic harakat / hamza marks, full-width letters folded;
 *   - Arabic tatweel (ـ) and zero-width / bidi control characters removed;
 *   - upper-cased;
 *   - punctuation and symbols (., !, ?, emoji…) trimmed at both ends only;
 *   - runs of whitespace collapsed to one space, then trimmed.
 *
 * ❓ The Arabic / darija entries are a PROPOSAL and must be validated by a
 * native speaker before production (COORDINATION « Décisions humaines »).
 * START is likewise ❓ (CONTRACTS §5 « Réabonnement »).
 */

/** Opt-out keywords. Contract list (CONTRACTS §5). */
export const STOP_KEYWORDS: readonly string[] = [
  'STOP',
  'ARRET',
  'STOPPER',
  'DESINSCRIRE',
  'UNSUBSCRIBE',
  // ❓ à valider par un locuteur natif
  'توقف',
  // ❓ à valider par un locuteur natif
  'ستوب',
]

/** Re-subscribe keywords. ❓ START only, pending human decision. */
export const START_KEYWORDS: readonly string[] = ['START']

const COMBINING_MARKS = /\p{M}+/gu
// Tatweel, zero-width space/joiners, LRM/RLM, bidi embeddings/isolates, BOM.
const INVISIBLES = /[ـ​-‏‪-‮⁦-⁩﻿]/g
const EDGE_PUNCT = /^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu
const WHITESPACE = /\s+/gu

export function normalizeKeywordText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .replace(INVISIBLES, '')
    .toUpperCase()
    .replace(EDGE_PUNCT, '')
    .replace(WHITESPACE, ' ')
    .trim()
}

const STOP_SET = new Set(STOP_KEYWORDS.map(normalizeKeywordText))
const START_SET = new Set(START_KEYWORDS.map(normalizeKeywordText))

/** Longest keyword is short; anything longer is a sentence. Cheap early exit. */
const MAX_KEYWORD_INPUT = 64

export type OptKeyword = 'stop' | 'start'

/**
 * Returns 'stop' / 'start' when the entire text is an opt-out / opt-in
 * keyword, otherwise null. Pure; safe on any string.
 */
export function detectOptKeyword(text: string | null | undefined): OptKeyword | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_KEYWORD_INPUT) {
    return null
  }
  const normalized = normalizeKeywordText(text)
  if (!normalized) return null
  if (STOP_SET.has(normalized)) return 'stop'
  if (START_SET.has(normalized)) return 'start'
  return null
}

export function isStopKeyword(text: string | null | undefined): boolean {
  return detectOptKeyword(text) === 'stop'
}
