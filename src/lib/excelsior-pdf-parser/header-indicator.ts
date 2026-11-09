import { caseIndependentCompare } from '@unsonet/js-utils';
import { headerIndicatorWords } from '../constants';

/**
 * "Does this cell text look like a table header word?" (Name, Total, Sl. No. ...)
 *
 * Moved out of determineHeaderRows, which called it for every text block of
 * every row range and built a fresh RegExp for every keyword each time.
 * The logic is unchanged; regexes are compiled once per keyword and answers are
 * memoised per text (the keyword list is a constant).
 */

const MAX_CACHED_TEXTS = 5000;

const WORD_SPLITTER = /(?=\p{Lu})|-| |_|\./gum;
const NOT_A_WORD = /^[^\p{L}\d]$/ui;

let keywords: string[] | null = null;
const regExpByKeyword = new Map<string, RegExp>();
const answerByText = new Map<string, boolean>();

function splitWords(text: string): string[] {
  return text
    .split(WORD_SPLITTER)
    .filter(item => item && !NOT_A_WORD.test(item))
    .map(item => item.toLowerCase());
}

function getKeywords(): string[] {
  if (!keywords) {
    const groups = headerIndicatorWords as unknown as Record<string, string[]>;
    keywords = Object.keys(groups).reduce<string[]>((all, group) => [...all, ...groups[group]], []);
  }
  return keywords;
}

function getKeywordRegExp(keyword: string): RegExp {
  let regExp = regExpByKeyword.get(keyword);
  if (!regExp) {
    //regular expression that finds strings containing the keyword, but only if there is a single word before or after it, or if the keyword stands alone.
    regExp = new RegExp(
      `^(?:(?<![\\p{L}\\p{N}_])(?:(?:\\p{L}|\\p{N})+\\s+)?(?:${splitWords(keyword).join(' ')})(?:\\s+(?:\\p{L}|\\p{N})+)?(?![\\p{L}\\p{N}_]))$`,
      'ui'
    );
    regExpByKeyword.set(keyword, regExp);
  }
  return regExp;
}

export function isHeaderIndicator(text: string | null | undefined): boolean {
  const normalized = text?.trim() || '';
  const cached = answerByText.get(normalized);
  if (cached !== undefined) {
    return cached;
  }

  let parsed: string | null = null;
  const answer = getKeywords().some(keyword => {
    if (caseIndependentCompare(keyword, normalized)) {
      return true;
    }
    parsed ??= splitWords(normalized).join(' ');
    return getKeywordRegExp(keyword).test(parsed);
  });

  if (answerByText.size >= MAX_CACHED_TEXTS) {
    answerByText.clear();
  }
  answerByText.set(normalized, answer);
  return answer;
}
