import { describe, expect, it } from 'vitest'
import {
  detectOptKeyword,
  isStopKeyword,
  normalizeKeywordText,
  STOP_KEYWORDS,
  START_KEYWORDS,
} from './stop'

describe('normalizeKeywordText', () => {
  it('folds case, accents and spacing', () => {
    expect(normalizeKeywordText('  Arrêt  ')).toBe('ARRET')
    expect(normalizeKeywordText('désinscrire')).toBe('DESINSCRIRE')
    expect(normalizeKeywordText('ＳＴＯＰ')).toBe('STOP') // full-width
    expect(normalizeKeywordText('a   b\t\nc')).toBe('A B C')
  })

  it('trims punctuation and emoji at the edges only', () => {
    expect(normalizeKeywordText('Stop !')).toBe('STOP')
    expect(normalizeKeywordText('...stop.')).toBe('STOP')
    expect(normalizeKeywordText('STOP 🛑')).toBe('STOP')
    expect(normalizeKeywordText('s.t.o.p')).toBe('S.T.O.P')
  })

  it('removes Arabic tatweel, harakat and invisible marks', () => {
    expect(normalizeKeywordText('تـوقـف')).toBe('توقف')
    expect(normalizeKeywordText('تَوَقَّفْ')).toBe('توقف')
    expect(normalizeKeywordText('‏توقف‏')).toBe('توقف')
  })
})

describe('detectOptKeyword — whole-message match only', () => {
  it.each([
    'STOP',
    'stop',
    'Stop',
    ' sToP ',
    'stop.',
    'STOP!!',
    'Arrêt',
    'ARRET',
    'arret',
    'stopper',
    'Désinscrire',
    'DESINSCRIRE',
    'unsubscribe',
    'UnSubscribe',
    'توقف',
    'ستوب',
    'تـوقـف',
  ])('%j → stop', (text) => {
    expect(detectOptKeyword(text)).toBe('stop')
    expect(isStopKeyword(text)).toBe(true)
  })

  it.each(['START', 'start', ' Start. '])('%j → start', (text) => {
    expect(detectOptKeyword(text)).toBe('start')
    expect(isStopKeyword(text)).toBe(false)
  })

  it.each([
    'stop les messages',
    'je veux stop',
    'ne pas stopper',
    'STOP STOP',
    'stopp',
    'sto p',
    'arrêtez',
    'bus stop',
    'nonstop',
    'merci, stop',
    'توقف عافاك',
    'start now',
    '',
    '   ',
    '!!!',
  ])('%j → null (sentence, variant or empty)', (text) => {
    expect(detectOptKeyword(text)).toBeNull()
  })

  it('handles non-strings and very long input', () => {
    expect(detectOptKeyword(null)).toBeNull()
    expect(detectOptKeyword(undefined)).toBeNull()
    expect(detectOptKeyword(' '.repeat(70) + 'STOP')).toBeNull()
  })

  it('exposes the contract keyword list', () => {
    expect(STOP_KEYWORDS).toEqual([
      'STOP',
      'ARRET',
      'STOPPER',
      'DESINSCRIRE',
      'UNSUBSCRIBE',
      'توقف',
      'ستوب',
    ])
    expect(START_KEYWORDS).toEqual(['START'])
  })
})
