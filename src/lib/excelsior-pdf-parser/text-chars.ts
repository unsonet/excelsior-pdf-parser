import { findMod, getSplitEdgeRange } from "@unsonet/js-utils";
import { isLeaderGlyph } from "../constants";

export function updateChars(options) {
    let { item, lineBreakNeeded, spaceNeeded, fontSpaceWidth } = options;
    if (!item) return;
    lineBreakNeeded = item['chars']?.[item['chars'].length - 1]?.isLineBreak ? false : lineBreakNeeded;
    item['chars'] = [
        ...(spaceNeeded ? [
            {
                originalCharCode: 32,
                fontChar: " ",
                unicode: " ",
                accent: null,
                width: fontSpaceWidth || ((findMod(item['chars'].reduce((prev, cur) => {
                    if (cur.width) {
                        prev.push(cur?.width);
                    }
                    return prev;
                }, [])) || 0) / 2),
                isSpace: true,
                isInFont: true,
                isLineBreak: false,
            },
            ...(item['chars'] || [])
        ] : (item['chars'] || [])),
        ...(lineBreakNeeded ? [
            {
                originalCharCode: 10,
                fontChar: "\n",
                unicode: "\n",
                accent: null,
                width: 0,
                isSpace: false,
                isInFont: true,
                isLineBreak: true,
            }
        ] : [])
    ];

    item['str'] = (spaceNeeded ? ' ' : '') + (item['str'] || '') + (lineBreakNeeded ? "\n" : '');
}

export function removeLineBreak(lastItem) {
    if (lastItem) {
        if (lastItem?.['chars']?.length) {
            if (
                lastItem['chars'][lastItem['chars'].length - 1]?.isLineBreak &&
                (lastItem['templateStr'] ? lastItem['templateStr'][lastItem['templateStr'].length - 1] == '\n' : true)
            ) {//remove unnecessary line break in the texts
                lastItem['chars'].splice(-1);
                lastItem['str'] = lastItem['str'] ? lastItem['str'].substring(0, lastItem['str'].length - 1) : '';
                if (lastItem['templateStr']) {
                    lastItem['templateStr'] = lastItem['templateStr']?.substring(0, lastItem['templateStr'].length - 1) || '';
                }
                return true;
            }
        }
    }
    return false;
}

export function clearChars(options) {
    let { chars, fullClear, clearStart, clearEnd } = options;
    let conditionFn = glyph => glyph && (typeof glyph == 'object') && (fullClear ? !glyph.isSpace && glyph?.unicode?.trim() : true);
    if (clearStart || clearEnd) {
        let start, end;
        if (clearStart) {
            start = getSplitEdgeRange({
                arr: chars,
                getLast: false,
                splitConditionFn: conditionFn,
                ignoreFirstSplitItem: false,
                includeLastSplitItem: false,
                includeFirstSplitItem: false,
            });
        }
        if (clearEnd) {
            end = getSplitEdgeRange({
                arr: chars,
                getLast: true,
                splitConditionFn: conditionFn,
                ignoreFirstSplitItem: false,
                includeLastSplitItem: false,
                includeFirstSplitItem: false,
            });
        }

        return chars.slice(clearStart ? start.index : 0, clearEnd ? end.index + 1 : undefined);
    } else {
        return chars?.filter(conditionFn);
    }
}

export function isEmptyCoordinate(item) {
    return !(clearChars({ chars: item.chars, fullClear: true })?.length || item?.imageName)
}

export function clearEmptyCoordinateItems(array) {
    array = Array.isArray(array) ? array : [array];
    return array.filter(item => {
        return !isEmptyCoordinate(item);
    })
}

export function getSymbolsBetween(
    relatedStr: string,
    prevStr: string,
    curStr: string
): string {
    if (!relatedStr || !prevStr || !curStr) {
        return '';
    }

    const prevIndex = relatedStr.indexOf(prevStr);

    if (prevIndex === -1) {
        return '';
    }

    const prevEnd = prevIndex + prevStr.length;

    // Spaces at the boundaries of a preliminary fragment are not
    // necessarily present in the related text item.
    const curContent = curStr.trim();

    if (!curContent) {
        return '';
    }

    const curIndex = relatedStr.indexOf(curContent, prevEnd);

    if (curIndex === -1) {
        return '';
    }

    return relatedStr.slice(prevEnd, curIndex);
}

export function getBoundaryGlyph(chars: any[], fromEnd: boolean): any | null {
    const list = Array.isArray(chars) ? chars : [];
    const step = fromEnd ? -1 : 1;

    for (let index = fromEnd ? list.length - 1 : 0; index >= 0 && index < list.length; index += step) {
        if (list[index] && typeof list[index] === 'object') {
            return list[index]; // We skip the TJ numbers
        }
    }

    return null;
}

/**
 * There is a gap between two leader glyphs on the same line—return a space glyph with this geometry.
 * If the boundary is already a space or a line break, or if there is no gap, return null.
 */
export function createLeaderGapGlyph(previousChars: any[], nextChars: any[], fontHeight: number): any | null {
    const previous = getBoundaryGlyph(previousChars, true);
    const next = getBoundaryGlyph(nextChars, false);

    if (!isLeaderGlyph(previous) || !isLeaderGlyph(next)) return null;
    if (![previous.x, previous.charWidth, next.x].every(Number.isFinite)) return null;

    const height = Math.max(fontHeight || 0, 1);
    if (Number.isFinite(previous.y) && Number.isFinite(next.y) && Math.abs(previous.y - next.y) > height * 0.5) {
        return null;
    }

    const gap = next.x - (previous.x + previous.charWidth);
    if (gap < Math.max(Math.abs(previous.charWidth) * 0.5, 0.3)) return null;

    // A gap wider than the cell threshold is the cell boundary, not the leader
    if (gap > Math.max(height * 0.6, 2)) return null;

    return {
        originalCharCode: 32,
        fontChar: ' ',
        unicode: ' ',
        accent: null,
        width: gap / (height * 0.001),
        isSpace: false,
        isInFont: true,
        isLineBreak: false,
        x: previous.x + previous.charWidth,
        y: Number.isFinite(previous.y) ? previous.y : next.y,
        charWidth: gap,
        advanceWidth: gap,
        wordSpacingWidth: 0,
    };
}


// Advance of a glyph as it is seen on the page.
//  - Char spacing (Tc) is never part of it.
//  - A very wide word spacing (Tw >= 1.5 text heights) is not part of it either:
//    such a Tw pushes the next word into another table cell ("1." + Tw + "1967").
//    A small Tw (justified text) stays in the advance, so words are not split.
export function getVisibleAdvance(glyph: any, textHeight: number): number {
    const advance = (glyph.advanceWidth ?? glyph.charWidth) || textHeight * 0.5;
    const wordSpacingWidth = glyph.wordSpacingWidth || 0;
    const wideWordSpacing = Math.max(textHeight * 1.5, 6);
    if (wordSpacingWidth < wideWordSpacing) {
        return advance;
    }
    // Trim only the word-spacing part of a huge space advance; never let the
    // "visible" advance cross back before the glyph's own start (that would
    // inflate the next gap and split segments the old logic kept whole).
    const visible = advance - wordSpacingWidth;
    return visible > 0 ? visible : advance;
}