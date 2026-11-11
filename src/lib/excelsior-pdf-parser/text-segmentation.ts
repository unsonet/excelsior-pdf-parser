import { filterBlocks } from "./filter-blocks";
import { isVisibleVector } from "./pdf-vector-utils";
import { getVisibleAdvance } from "./text-chars";
import { getTextContentItemId, getItemRight, isHorizontalText } from "./text-geometry";

/** Removes spaces between CJK characters (pdfjs 6.x artifact) */
export function normalizeCJKText(str: string): string {
    if (!str) return str;
    // Remove the space/tab/non-breaking space if it is between two CJK characters
    return str
        .replace(
            /([ \t\u00A0])(?=[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF\uFF00-\uFFEF\u3000-\u303F])/g,
            ''
        )
        .replace(
            /([\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF\uFF00-\uFFEF\u3000-\u303F])([ \t\u00A0])(?=[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF\uFF00-\uFFEF\u3000-\u303F])/g,
            '$1'
        );
}

// ============================================================
// FUNCTIONS OF SEGMENTATION preliminaryItem BASED ON GLYPH GEOMETRY
// ============================================================

export function segmentPreliminaryItem(item: any): any[] {
    if (!item?.chars?.length) return [item];
    const glyphs = item.chars.filter((ch: any) =>
        ch && typeof ch === 'object' && typeof ch.unicode === 'string' && ch.x !== undefined
    );
    if (glyphs.length <= 1) return [item];
    const threshold = Math.max(item.height * 0.6, 2);
    // FIX: a run of plain single spaces (total ≈ 0.5em for 2 spaces) must NOT
    // act as a cell gap — that regressed twotables_1.pdf (wrong line break after
    // "outbreak." and a stray space inside "done."). Only a genuinely wide
    // space run (> 1.5em, same heuristic as wideWordSpacing) separates cells.
    const spaceRunThreshold = Math.max(item.height * 1.5, 6);
    const isSpace = (glyph: any) => !glyph.unicode.trim();
    const segments: any[] = [];
    let currentGlyphs: any[] = [glyphs[0]];
    let currentStartX = glyphs[0].x;
    let lastEndX = glyphs[0].x + getVisibleAdvance(glyphs[0], item.height);
    let spaceRunCount = isSpace(glyphs[0]) ? 1 : 0;
    let spaceRunWidth = isSpace(glyphs[0]) ? glyphs[0].charWidth || 0 : 0;

    for (let i = 1; i < glyphs.length; i++) {
        const g = glyphs[i];
        const gap = g.x - lastEndX;
        const hasTextBeforeRun = currentGlyphs.length > spaceRunCount
            && currentGlyphs.slice(0, currentGlyphs.length - spaceRunCount).some((ch: any) => !isSpace(ch));
        const isCellGapBySpaces = !isSpace(g)
            && spaceRunCount >= 2
            && spaceRunWidth >= spaceRunThreshold
            && hasTextBeforeRun;
        if (isCellGapBySpaces || gap > threshold) {
            const body = isCellGapBySpaces ? currentGlyphs.slice(0, currentGlyphs.length - spaceRunCount) : currentGlyphs;
            segments.push(buildSegment(item, body, currentStartX));
            currentGlyphs = [g];
            currentStartX = g.x;
            spaceRunCount = 0;
            spaceRunWidth = 0;
        } else {
            currentGlyphs.push(g);
        }
        lastEndX = g.x + getVisibleAdvance(g, item.height);
        if (isSpace(g)) {
            spaceRunCount++;
            spaceRunWidth += g.charWidth || 0;
        } else {
            spaceRunCount = 0;
            spaceRunWidth = 0;
        }
    }
    if (currentGlyphs.length) {
        segments.push(buildSegment(item, currentGlyphs, currentStartX));
    }
    return segments.length > 0 ? segments : [item];
}

// Splits the fragments of a single element in pdf.js into cells: on a single line, with a spacing of at least 0.5 times the font height.
export function splitFragmentsIntoCells(fragments: any[]): any[][] {
    if (fragments.length < 2) {
        return [fragments];
    }
    const [a, b] = fragments[0].transform;
    const length = Math.hypot(a, b) || 1;
    const ux = a / length;
    const uy = b / length;
    const along = (item: any) => item.transform[4] * ux + item.transform[5] * uy;
    const across = (item: any) => -item.transform[4] * uy + item.transform[5] * ux;

    const runs: any[][] = [[fragments[0]]];
    for (let i = 1; i < fragments.length; i++) {
        const previous = fragments[i - 1];
        const current = fragments[i];
        const height = Math.max(previous.height || 0, current.height || 0, 1);
        const sameLine = Math.abs(across(current) - across(previous)) < height * 0.5;
        const gap = along(current) - (along(previous) + (previous.width || 0));

        if (sameLine && gap >= Math.max(height * 0.5, 2)) {
            runs.push([current]);
        } else {
            runs[runs.length - 1].push(current);
        }
    }
    return runs;
}

export function buildSegment(baseItem: any, glyphs: any[], startX: number): any {
    const lastGlyph = glyphs[glyphs.length - 1];
    const endX = lastGlyph.x + getVisibleAdvance(lastGlyph, baseItem.height);
    const width = Math.max(0, endX - startX);
    const str = glyphs.map((g: any) => g.unicode).join('');

    // startX/endX are measured along the glyph accumulation axis — handleCharsArgs
    // always writes the distance traveled to the `x` field, as if
    // the reading direction were always the device’s X-axis. For
    // horizontal text, this is true, but for rotated text (matrix
    // of the form [0,s,-s,0]), the actual reading direction is a different axis.
    // Previously, the offset was unconditionally written to transform[4], which is why
    // different “words” in a single rotated line received the SAME
    // X value instead of the same Y value (this is exactly why the subtitles
    // “1975-79”/“1988-90”/“2011-12” and the line numbers in rotated.pdf were broken).
    // We project the offset onto the element’s actual reading direction.
    const [ba, bb] = baseItem.transform;
    const readingLength = Math.hypot(ba, bb) || 1;
    const readingUnit = [ba / readingLength, bb / readingLength];
    const offset = startX - (baseItem.transform[4] ?? 0);

    return {
        ...baseItem,
        str,
        chars: glyphs,
        width,
        transform: [
            baseItem.transform[0],
            baseItem.transform[1],
            baseItem.transform[2],
            baseItem.transform[3],
            baseItem.transform[4] + offset * readingUnit[0],
            baseItem.transform[5] + offset * readingUnit[1]
        ]
    };
}



export function isSegmentContainedByRelatedItem(
    segment: any,
    relatedItem: any
): boolean {
    if (
        !segment?.transform ||
        !relatedItem?.transform
    ) {
        return false;
    }

    const tolerance = Math.max(
        segment.height * 0.5,
        1
    );

    const segmentLeft =
        segment.transform[4];

    const segmentRight =
        segmentLeft + segment.width;

    const relatedLeft =
        relatedItem.transform[4];

    const relatedRight =
        relatedLeft + relatedItem.width;

    const segmentTop =
        Math.min(
            segment.transform[5],
            segment.transform[5] +
            segment.height
        );

    const segmentBottom =
        Math.max(
            segment.transform[5],
            segment.transform[5] +
            segment.height
        );

    const relatedTop =
        Math.min(
            relatedItem.transform[5],
            relatedItem.transform[5] +
            relatedItem.height
        );

    const relatedBottom =
        Math.max(
            relatedItem.transform[5],
            relatedItem.transform[5] +
            relatedItem.height
        );

    return (
        segmentLeft >=
        relatedLeft - tolerance &&
        segmentRight <=
        relatedRight + tolerance &&
        segmentTop >=
        relatedTop - tolerance &&
        segmentBottom <=
        relatedBottom + tolerance
    );
}


export function findRelatedTextContentSpan(
    segment: any,
    relatedItems: any[]
) {
    if (
        !segment?.str ||
        !relatedItems?.length
    ) {
        return undefined;
    }

    const items = relatedItems
        .filter(item => item?.transform)
        .slice()
        .sort((a, b) => {
            const yDiff =
                b.transform[5] - a.transform[5];

            if (Math.abs(yDiff) > 0.5) {
                return yDiff;
            }

            return (
                a.transform[4] -
                b.transform[4]
            );
        });

    if (!items.length) {
        return undefined;
    }

    const normalize = (value: any) =>
        normalizeCJKText(
            String(value || '')
        )
            .replace(/\s+/g, '')
            .trim();

    const segmentNormalized =
        normalize(segment.str);

    if (!segmentNormalized) {
        return undefined;
    }

    function createSpan(
        spanItems: any[]
    ) {
        const first = spanItems[0];
        const last =
            spanItems[spanItems.length - 1];

        const x1 = Math.min(
            ...spanItems.map(item =>
                item.transform[4]
            )
        );

        const x2 = Math.max(
            ...spanItems.map(item =>
                item.transform[4] +
                item.width
            )
        );

        const y1 = Math.min(
            ...spanItems.map(item =>
                item.transform[5]
            )
        );

        const y2 = Math.max(
            ...spanItems.map(item =>
                item.transform[5] +
                item.height
            )
        );

        return {
            ...first,

            str: spanItems
                .map(item => item.str || '')
                .join(''),

            width: x2 - x1,

            height: Math.max(
                y2 - y1,
                segment.height || 0
            ),

            transform: [
                first.transform[0],
                first.transform[1],
                first.transform[2],
                first.transform[3],
                x1,
                y1,
            ],

            hasEOL:
                last?.hasEOL || false,

            hasEOT:
                last?.hasEOT || false,

            relatedItems: spanItems,

            relatedItemIds:
                spanItems.map(item =>
                    getTextContentItemId(item)
                ),

            isRelatedTextContentSpan: true,
        };
    }

    /*
     * First, we look for an exact match:
     * segment
     *     ==
     * combined related elements
     */
    for (
        let start = 0;
        start < items.length;
        start++
    ) {
        let accumulated = '';

        for (
            let end = start;
            end < items.length;
            end++
        ) {
            const current = items[end];

            /*
             * Don't mix different lines.
             *
             * For a single line, baseline should be
             * practically the same.
             */
            if (
                end > start &&
                Math.abs(
                    current.transform[5] -
                    items[start].transform[5]
                ) > 0.75
            ) {
                break;
            }

            accumulated +=
                current.str || '';

            const normalized =
                normalize(accumulated);

            if (normalized === segmentNormalized) {
                return createSpan(
                    items.slice(start, end + 1)
                );
            }

            /*
             * Further on, it’s definitely more segment,
             * so continuing is pointless.
             */
            if (
                !segmentNormalized.startsWith(
                    normalized
                ) &&
                !normalized.startsWith(
                    segmentNormalized
                )
            ) {
                break;
            }
        }
    }

    return undefined;
}

export function findBestRelatedTextContentItem(segment: any, relatedItems: any[]): any {
    if (!relatedItems?.length) return undefined;
    if (relatedItems.length === 1 && !relatedItems[0]) return undefined;

    const segX1 = segment.transform[4];
    const segX2 = segX1 + segment.width;
    const segY1 = segment.transform[5];
    const segY2 = segY1 + segment.height;
    const segCenterX = (segX1 + segX2) / 2;
    const segCenterY = (segY1 + segY2) / 2;

    let bestMatch: any = undefined;
    let bestScore = -Infinity;
    const adjacencyThreshold = Math.max(segment.height * 0.5, 1);

    for (const related of relatedItems) {
        if (!related) continue;
        const relX1 = related.transform[4];
        const relX2 = relX1 + related.width;
        const relY1 = related.transform[5];
        const relY2 = relY1 + related.height;

        // Intersection along X and Y
        const xOverlap = Math.max(0, Math.min(segX2, relX2) - Math.max(segX1, relX1));
        const yOverlap = Math.max(0, Math.min(segY2, relY2) - Math.max(segY1, relY1));

        if (xOverlap > 0 && yOverlap > 0) {
            const score = xOverlap * yOverlap;
            if (score > bestScore) {
                bestScore = score;
                bestMatch = related;
            }
        } else if (yOverlap > 0) {
            // Adjacency along X (small gap = virtual intersection)
            const xGap = Math.min(Math.abs(segX1 - relX2), Math.abs(relX1 - segX2));
            if (xGap <= adjacencyThreshold) {
                const virtualOverlap = adjacencyThreshold - xGap;
                const score = virtualOverlap * yOverlap;
                if (score > bestScore) {
                    bestScore = score;
                    bestMatch = related;
                }
            }
        } else if (bestScore <= 0) {
            // Fallback: the closest one in terms of center.
            const dist = Math.sqrt(
                Math.pow(segCenterX - (relX1 + relX2) / 2, 2) +
                Math.pow(segCenterY - (relY1 + relY2) / 2, 2)
            );
            const fallbackScore = -dist;
            if (fallbackScore > bestScore) {
                bestScore = fallbackScore;
                bestMatch = related;
            }
        }
    }
    return bestMatch;
}


export function attachToContinuation(target: any, flushed: any): void {
    const isGlyph = (glyph: any) => glyph && typeof glyph === 'object' && typeof glyph.unicode === 'string';
    const lastGlyph = [...flushed.chars].reverse().find(isGlyph);
    const firstGlyph = target.chars.find(isGlyph);
    const right = getItemRight(flushed);
    const gap = target.transform[4] - right;
    const needsSpace = !!lastGlyph?.unicode.trim() &&
        !!firstGlyph?.unicode.trim() &&
        gap >= Math.max((flushed.height || 0) * 0.15, 0.5);

    const spaceGlyph = {
        originalCharCode: 32,
        fontChar: ' ',
        unicode: ' ',
        accent: null,
        width: 250,
        isSpace: true,
        isInFont: true,
        isLineBreak: false,
        x: right,
        y: flushed.transform[5],
        charWidth: Math.max(gap, 0)
    };

    target.chars = [...flushed.chars, ...(needsSpace ? [spaceGlyph] : []), ...target.chars];
    target.str = `${flushed.str}${needsSpace ? ' ' : ''}${target.str}`;
    target.width = Math.max(getItemRight(target), right) - flushed.transform[4];
    target.transform = [
        target.transform[0],
        target.transform[1],
        target.transform[2],
        target.transform[3],
        flushed.transform[4],
        target.transform[5]
    ];
}

// Original behaviour, kept for rotated text: fragments of a rotated (multi-line) header lie
// at different transform[5] values along the reading direction, so the whole bucket is
// one text item.
export function mergeCachedBucketAsWhole(cachedItems: any[]): any {
    const mergedStr = cachedItems
        .map(item => item?.str || '')
        .filter(part => part.trim().length)
        .join(' ');

    const mergedChars = cachedItems.reduce(
        (chars, item) => chars.concat(item?.chars || []),
        []
    );

    const first = cachedItems[0];
    const last = cachedItems[cachedItems.length - 1];

    return {
        ...first,
        str: mergedStr,
        chars: mergedChars,
        hasEOT: true,
        hasEOL: last?.hasEOL || false,
        width: Math.max(...cachedItems.map(item => item?.width || 0)),
        height: Math.max(...cachedItems.map(item => item?.height || 0)),
        transform: [
            first.transform[0],
            first.transform[1],
            first.transform[2],
            first.transform[3],
            Math.min(...cachedItems.map(item => item.transform[4])),
            Math.min(...cachedItems.map(item => item.transform[5]))
        ]
    };
}

// From elements that overlap (same line, same font size, overlap >= 60%
// of the width of the narrower one), it keeps only one—the best one.
export function removeOverlaidDuplicateItems(items: any[]): any[] {
    const OVERLAP_RATIO = 0.6;
    let loggedRemovals = 0;
    const compact = (value: any): string => String(value || '').replace(/\s+/g, '');

    const isSpacedGarbage = (value: any): boolean => {
        const tokens = String(value || '').trim().split(/\s+/).filter(Boolean);
        return tokens.length >= 4 && tokens.filter(token => token.length === 1).length >= tokens.length * 0.7;
    };

    const getInfo = (item: any, index: number): any => {
        if (!item?.transform || item.imageName || !isHorizontalText(item)) {
            return null;
        }
        const text = String(item.str || '').trim();
        if (!text || /\n/.test(text)) {
            return null;
        }
        const glyphs = (item.chars || []).filter(
            (glyph: any) =>
                glyph &&
                typeof glyph === 'object' &&
                typeof glyph.unicode === 'string' &&
                glyph.unicode.trim() &&
                Number.isFinite(glyph.x) &&
                Number.isFinite(glyph.charWidth)
        );
        const left = glyphs.length ? Math.min(...glyphs.map((glyph: any) => glyph.x)) : item.transform[4];
        const right = glyphs.length
            ? Math.max(...glyphs.map((glyph: any) => glyph.x + glyph.charWidth))
            : item.transform[4] + (item.width || 0);
        return {
            item,
            index,
            left,
            right,
            boxLeft: item.transform[4],
            boxRight: item.transform[4] + (item.width || 0),
            compactText: compact(text),
            baseline: item.transform[5],
            height: Math.max(Math.abs(item.transform[3]) || item.height || 1, 1)
        };
    };

    const overlapRatio = (aLeft: number, aRight: number, bLeft: number, bRight: number): number => {
        const narrower = Math.min(aRight - aLeft, bRight - bLeft);
        return narrower > 0 ? (Math.min(aRight, bRight) - Math.max(aLeft, bLeft)) / narrower : 0;
    };

    const isSubsequence = (needle: string, haystack: string): boolean => {
        const wanted = Array.from(needle.toLocaleLowerCase());
        if (!wanted.length) {
            return true;
        }
        let position = 0;
        for (const character of Array.from(haystack.toLocaleLowerCase())) {
            if (character === wanted[position]) {
                position++;
                if (position === wanted.length) {
                    return true;
                }
            }
        }
        return false;
    };

    // A duplicate is the same text, possibly with some characters missing. Different texts with overlapping frames
    // (index strings, superscript characters) are not considered duplicates.
    const isSameTextLayer = (a: any, b: any): boolean => {
        const [shorter, longer] = a.compactText.length <= b.compactText.length ? [a, b] : [b, a];
        return isSubsequence(shorter.compactText, longer.compactText);
    };

    // A fragment of the OCR layer: its text is part of a longer element's text,
    // and it lies within that element's bounding box. The bounding box is more reliable than glyph positions.
    const isFragmentOf = (piece: any, whole: any): boolean =>
        piece.compactText.length < whole.compactText.length &&
        whole.compactText.includes(piece.compactText) &&
        overlapRatio(piece.boxLeft, piece.boxRight, whole.boxLeft, whole.boxRight) >= OVERLAP_RATIO;

    const isOverlay = (a: any, b: any): boolean => {
        if (Math.abs(a.baseline - b.baseline) > Math.max(Math.min(a.height, b.height) * 0.3, 0.5)) {
            return false;
        }
        if (Math.abs(a.height - b.height) > Math.max(a.height, b.height) * 0.2) {
            return false;
        }

        if (!isSameTextLayer(a, b)) {
            return false;
        }
        return (
            overlapRatio(a.left, a.right, b.left, b.right) >= OVERLAP_RATIO ||
            isFragmentOf(a, b) ||
            isFragmentOf(b, a)
        );
    };

    // true, если a лучше b
    const isBetter = (a: any, b: any): boolean => {
        const garbageA = isSpacedGarbage(a.item.str);
        const garbageB = isSpacedGarbage(b.item.str);
        if (garbageA !== garbageB) {
            return garbageB;
        }
        const visibleA = !!a.item.textColor;
        const visibleB = !!b.item.textColor;
        if (visibleA !== visibleB) {
            return visibleA;
        }
        // Text completeness: “$731” is better than “$31”, “K2-1901” is better than ‘K21901’, “1.9” is better than “1 9”
        const compactDifference = a.compactText.length - b.compactText.length;
        if (compactDifference !== 0) {
            return compactDifference > 0;
        }
        // “19RA02 §” is better than “19RA02§”
        const rawDifference = String(a.item.str || '').trim().length - String(b.item.str || '').trim().length;
        if (rawDifference !== 0) {
            return rawDifference > 0;
        }
        return a.index < b.index;
    };

    const infos = items
        .map(getInfo)
        .filter(Boolean)
        .sort((a: any, b: any) => a.baseline - b.baseline);
    const maxShift = Math.max(0.5, ...infos.map((info: any) => info.height * 0.3));
    const removed = new Set<number>();

    for (let i = 0; i < infos.length; i++) {
        if (removed.has(infos[i].index)) {
            continue;
        }
        for (let j = i + 1; j < infos.length; j++) {
            if (infos[j].baseline - infos[i].baseline > maxShift) {
                break;
            }
            if (removed.has(infos[j].index) || !isOverlay(infos[i], infos[j])) {
                continue;
            }
            const loser = isBetter(infos[i], infos[j]) ? infos[j] : infos[i];
            removed.add(loser.index);

            if (loser === infos[i]) {
                break;
            }
        }
    }

    if (!removed.size) {
        return items;
    }

    const result: any[] = [];
    items.forEach((item: any, index: number) => {
        if (!removed.has(index)) {
            result.push(item);
            return;
        }
        // The end of the cell has been removed—the cell border should remain on the previous element
        if (item.hasEOT && result.length) {
            result[result.length - 1].hasEOT = true;
        }
    });
    return result;
}


// Do all overlapping elements appear on the same text line with the same font size?
// This is not a watermark, but an overlay of a duplicate text layer (OCR + original).
export function isOverlayOnSameTextLine(item: any, others: any[]): boolean {
    if (!item?.transform || item.imageName || !isHorizontalText(item)) {
        return false;
    }
    const height = Math.max(Math.abs(item.transform[3]) || item.height || 1, 1);
    const baselineTolerance = Math.max(height * 0.3, 0.5);
    return others.every((other: any) => {
        if (!other?.transform || other.imageName || !isHorizontalText(other)) {
            return false;
        }
        const otherHeight = Math.max(Math.abs(other.transform[3]) || other.height || 1, 1);
        return (
            Math.abs(other.transform[5] - item.transform[5]) <= baselineTolerance &&
            Math.abs(otherHeight - height) <= Math.max(height, otherHeight) * 0.15
        );
    });
}

export function getMergedCoordinatePaddingObj(lastItem, newItem, gridItemsType) {
    if (!Array.isArray(lastItem) && !lastItem?.transform) {
        lastItem = newItem;
    }
    let lastItemArray = Array.isArray(lastItem) ? lastItem : [lastItem];
    let newItemArray = Array.isArray(newItem) ? newItem : [newItem];
    let mergedCoordinatePaddingObj = gridItemsType == 'cols' ? {
        'x': getCoordinateFromObj(lastItemArray).x[0] < getCoordinateFromObj(newItemArray).x[0] ? [
            Math.max(...lastItemArray.map(item => item.transform[4] + item.width)),
            Math.min(...newItemArray.map(item => item.transform[4]))
        ] : [
            Math.max(...newItemArray.map(item => item.transform[4] + item.width)),
            Math.min(...lastItemArray.map(item => item.transform[4]))
        ],
        'y': [
            Math.min(...lastItemArray.map(item => item.transform[5]), ...newItemArray.map(item => item.transform[5])),
            Math.max(...lastItemArray.map(item => item.transform[5] + item.height), ...newItemArray.map(item => item.transform[5] + item.height))
        ]
    } : {
        'x': [
            Math.min(...lastItemArray.map(item => item.transform[4]), ...newItemArray.map(item => item.transform[4])),
            Math.max(...lastItemArray.map(item => item.transform[4] + item.width), ...newItemArray.map(item => item.transform[4] + item.width))
        ],
        'y': getCoordinateFromObj(lastItemArray).y[0] < getCoordinateFromObj(newItemArray).y[0] ? [
            Math.max(...lastItemArray.map(item => item.transform[5] + item.height)),
            Math.min(...newItemArray.map(item => item.transform[5]))
        ] : [
            Math.max(...newItemArray.map(item => item.transform[5] + item.height)),
            Math.min(...lastItemArray.map(item => item.transform[5]))
        ]
    };
    return mergedCoordinatePaddingObj;
}

export function getCoordinateFromObj(obj) {
    let array = Array.isArray(obj) ? obj : [obj];
    return {
        x: [
            Math.min(...array.map(item => item.transform[4])),
            Math.max(...array.map(item => item.transform[4] + item.width))
        ],
        y: [
            Math.min(...array.map(item => item.transform[5])),
            Math.max(...array.map(item => item.transform[5] + item.height))
        ]
    }
}

export function intersectsEdges(options) {
    let { first, second, targetGrids, edges, tolerance = 0 } = options || {};
    return targetGrids.some(key => {
        if (first.length && second.length) {
            let paddingObj = getMergedCoordinatePaddingObj(first, second, key);

            // We expand paddingObj by the tolerance to catch edges at the boundary.
            let expandedPadding = {
                x: [paddingObj.x[0] - tolerance, paddingObj.x[1] + tolerance],
                y: [paddingObj.y[0] - tolerance, paddingObj.y[1] + tolerance]
            };

            let visibleEdges = edges.filter(item => isVisibleVector(item));
            return filterBlocks(visibleEdges, { ...expandedPadding, strictIntersecting: false })
                .filter(item => !paddingObj.x.includes(item.x) && !paddingObj.y.includes(item.y))
                .length;
        } else {
            return false;
        }
    });
}
