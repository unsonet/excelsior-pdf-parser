import { findMod, findAverage, uniqueArr } from "@unsonet/js-utils";
import { LEADER_CHARS, LINE_MAX_WIDTH } from "../constants";
import { getCoveredLength } from "./geometry-utils";
import { addToGridList } from "./group-lists";
import { determineHeaderRows } from "./header-rows";
import { calculateToleranceValue } from "./pdf-grid-utils";
import { isVisibleVector, isSameFillColor } from "./pdf-vector-utils";

/**
 * A title row ("Table: 5 Public Health Outlay ...") is a single line of text whose
 * blocks together cross EVERY interior column boundary, i.e. the row has no cell
 * structure at all (the grid merges it into one full-width cell). Such a row is a
 * caption of the table, not a part of it, even when it is drawn as a coloured bar.
 */
export function trimFullWidthTitleRow(group: any, lineMaxWidth: number): any {
    if (!group?.rows?.length || !group?.cols?.length || group.rows.length < 5 || group.cols.length < 4) {
        return group;
    }

    const rowsDesc = [...group.rows].sort((a, b) => b - a);
    const rowTop = rowsDesc[0];
    const rowBottom = rowsDesc[1];

    const textBlocks = (group.coordinates || []).filter(
        (block: any) =>
            block?.str?.trim() && [block.x, block.y, block.width, block.height].every(Number.isFinite),
    );
    const titleBlocks = textBlocks.filter((block: any) => block.y <= rowTop + 0.5 && block.y > rowBottom);
    if (!titleBlocks.length) {
        return group;
    }

    // 1. One line of text.
    const baseline = titleBlocks[0].y;
    if (titleBlocks.some((block: any) => Math.abs(block.y - baseline) > 1)) {
        return group;
    }

    // 2. A real body (several lines) exists below the row.
    const bodyLines = new Set(
        textBlocks.filter((block: any) => block.y <= rowBottom).map((block: any) => Math.round(block.y)),
    );
    if (bodyLines.size < 3) {
        return group;
    }

    // 3. The text crosses every interior column boundary.
    const margin = Math.max(lineMaxWidth * 0.1, 0.3);
    const colsAsc = [...group.cols].sort((a, b) => a - b);
    // Boundaries within a pad width (~5 pt) of the outer edges are shading pads / frame, not columns.
    const outerPad = lineMaxWidth * 1.3;
    const interiorCols = colsAsc.filter(
        x => x - colsAsc[0] > outerPad && colsAsc[colsAsc.length - 1] - x > outerPad,
    );
    const isCrossed = (x: number) =>
        titleBlocks.some((block: any) => block.x + margin < x && x < block.x + block.width - margin);
    if (!interiorCols.every(isCrossed)) {
        return group;
    }

    const newTop = rowBottom;
    const isBelowNewTop = (item: any) => item.y + (item.height || 0) / 2 <= newTop;

    group.rows = group.rows.filter((y: number) => y <= newTop + 1e-6);
    group.coordinates = (group.coordinates || []).filter((block: any) => !titleBlocks.includes(block));
    group.edges = (group.edges || []).filter(isBelowNewTop);
    group.rectangles = (group.rectangles || []).filter(isBelowNewTop);
    group.rectanglesEdges = (group.rectanglesEdges || []).filter(isBelowNewTop);
    ['edgesRows', 'rectanglesRows', 'synthesizedRows'].forEach(key => {
        if (Array.isArray(group[key])) {
            group[key] = group[key].filter((y: number) => y <= newTop + 0.5);
        }
    });
    group.y = [Math.min(...group.rows), Math.max(...group.rows)];
    group.headerRows = determineHeaderRows({
        coordinates: group.coordinates || [],
        edges: group.edges || [],
        rectangles: group.rectangles || [],
        rows: [...group.rows],
        cols: group.cols || [],
        lineMaxWidth,
        separatorRows: group.synthesizedRows || [],
    });

    return group;
}

/**
 * Some producers draw cell shading line by line: every text line of a cell gets its own
 * rectangle, plus narrow (~5 pt) "pad" rectangles on its sides. The seams between such
 * pieces are not cell borders. A row boundary is a shading seam when
 *   - no real (visible, thin) horizontal rule lies on it,
 *   - same-coloured pieces touch each other there and at least one of them is a pad,
 *   - it is not the only boundary separating two text blocks of one column.
 * Seam rows are dropped so one visual row stays one grid row.
 */
export function removeFillSeamRows(group: any, lineMaxWidth: number): any {
    if (!group?.rows?.length || group.rows.length < 5) {
        return group;
    }

    const tolerance = 1.5;
    const minPieceThickness = 3; // thinner fills are rules, not shading
    const maxPadSize = lineMaxWidth * 1.3; // pads are ~5 pt wide

    const fillPieces = [
        ...(group.rectangles || []),
        ...(group.edges || []).filter(
            (edge: any) =>
                edge?.fillColor && !edge._isFakeLine && Math.min(edge.width, edge.height) >= minPieceThickness,
        ),
    ].filter(
        (piece: any) => piece?.fillColor && isVisibleVector(piece) && piece.width > 0 && piece.height > 0,
    );
    if (!fillPieces.length) {
        return group;
    }

    const ruleCenters: number[] = (group.edges || [])
        .filter(
            (edge: any) =>
                isVisibleVector(edge) &&
                !edge._isFakeLine &&
                edge.height < minPieceThickness &&
                edge.width > lineMaxWidth,
        )
        .map((edge: any) => edge.y + edge.height / 2);

    const textBlocks = (group.coordinates || []).filter(
        (block: any) =>
            block?.str?.trim() && [block.x, block.y, block.width, block.height].every(Number.isFinite),
    );
    const rowsAsc = [...group.rows].sort((a, b) => a - b);

    const hasRuleAt = (y: number) => ruleCenters.some(center => Math.abs(center - y) <= tolerance);

    const isPad = (piece: any) => Math.min(piece.width, piece.height) <= maxPadSize;

    // Middle pieces of a cell are not narrow themselves, but they are flanked by pads.
    const hasPadNeighbour = (piece: any) =>
        fillPieces.some(
            (other: any) =>
                other !== piece &&
                isPad(other) &&
                isSameFillColor(other, piece) &&
                (Math.abs(other.x + other.width - piece.x) <= 0.3 ||
                    Math.abs(piece.x + piece.width - other.x) <= 0.3) &&
                Math.min(other.y + other.height, piece.y + piece.height) - Math.max(other.y, piece.y) > 0,
        );

    const hasShadingSeamAt = (y: number) => {
        const above = fillPieces.filter(
            (piece: any) => Math.abs(piece.y - y) <= tolerance && piece.y + piece.height > y + tolerance,
        );
        const below = fillPieces.filter(
            (piece: any) =>
                Math.abs(piece.y + piece.height - y) <= tolerance && piece.y < y - tolerance,
        );
        const touching = above.some((first: any) =>
            below.some(
                (second: any) =>
                    isSameFillColor(first, second) &&
                    Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x) > 0,
            ),
        );
        if (!touching) {
            return false;
        }
        return [...above, ...below].some((piece: any) => isPad(piece) || hasPadNeighbour(piece));
    };

    // y is the only boundary between two vertically adjacent text blocks of one column?
    const separatesText = (y: number) => {
        const above = textBlocks.filter((block: any) => block.y >= y - tolerance);
        const below = textBlocks.filter((block: any) => block.y + block.height <= y + tolerance);
        return above.some((upper: any) =>
            below.some((lower: any) => {
                const overlap =
                    Math.min(upper.x + upper.width, lower.x + lower.width) - Math.max(upper.x, lower.x);
                if (overlap <= 0) {
                    return false;
                }
                const from = lower.y + lower.height - tolerance;
                const to = upper.y + tolerance;
                return !rowsAsc.some(row => Math.abs(row - y) > tolerance && row >= from && row <= to);
            }),
        );
    };

    const seamRows = rowsAsc
        .slice(1, -1) // never touch the outer boundaries
        .filter(y => !hasRuleAt(y) && hasShadingSeamAt(y) && !separatesText(y));
    if (!seamRows.length) {
        return group;
    }

    const isSeamValue = (value: number) => seamRows.some(y => Math.abs(y - value) <= tolerance);
    group.rows = group.rows.filter((y: number) => !seamRows.includes(y));
    ['edgesRows', 'rectanglesRows', 'synthesizedRows'].forEach(key => {
        if (Array.isArray(group[key])) {
            group[key] = group[key].filter((y: number) => !isSeamValue(y));
        }
    });
    group.y = [Math.min(...group.rows), Math.max(...group.rows)];
    group.headerRows = determineHeaderRows({
        coordinates: group.coordinates || [],
        edges: group.edges || [],
        rectangles: group.rectangles || [],
        rows: [...group.rows],
        cols: group.cols || [],
        lineMaxWidth,
        separatorRows: group.synthesizedRows || [],
    });
    return group;
}

/**
* Per-line cell shading is drawn as a wide piece plus narrow (~5 pt) pads on its sides.
* The OUTER side of a pad lies on the real column boundary (it coincides with an end of a
* visible rule, i.e. with `edgesCols`); the INNER side is only a shading seam and must not
* become a column boundary.
*/
export function removeFillPadColumns(group: any, lineMaxWidth: number): any {
    if (!group?.cols?.length || group.cols.length < 5) {
        return group;
    }

    const minPieceThickness = 3;
    const maxPadSize = lineMaxWidth * 1.3;
    const sideTolerance = 0.8;
    const strokeTolerance = 1.5;

    const realCols: number[] = group.edgesCols || [];
    if (!realCols.length) {
        return group;
    }
    const isNearRealCol = (x: number) => realCols.some(real => Math.abs(real - x) <= strokeTolerance);

    const fillPieces = [
        ...(group.rectangles || []),
        ...(group.edges || []).filter(
            (edge: any) =>
                edge?.fillColor && !edge._isFakeLine && Math.min(edge.width, edge.height) >= minPieceThickness,
        ),
    ].filter(
        (piece: any) => piece?.fillColor && isVisibleVector(piece) && piece.width > 0 && piece.height > 0,
    );
    if (!fillPieces.length) {
        return group;
    }

    const innerSides: number[] = [];
    fillPieces.forEach((pad: any) => {
        const isVerticalPad =
            pad.width >= minPieceThickness && pad.width <= maxPadSize && pad.height >= pad.width * 1.5;
        if (!isVerticalPad) {
            return;
        }
        fillPieces.forEach((main: any) => {
            if (main === pad || main.width <= maxPadSize || !isSameFillColor(main, pad)) {
                return;
            }
            const overlapY = Math.min(pad.y + pad.height, main.y + main.height) - Math.max(pad.y, main.y);
            if (overlapY <= 0) {
                return;
            }
            const mainOnRight = Math.abs(main.x - (pad.x + pad.width)) <= 0.3;
            const mainOnLeft = Math.abs(main.x + main.width - pad.x) <= 0.3;
            if (mainOnRight && isNearRealCol(pad.x)) {
                innerSides.push(pad.x + pad.width);
            }
            if (mainOnLeft && isNearRealCol(pad.x + pad.width)) {
                innerSides.push(pad.x);
            }
        });
    });
    if (!innerSides.length) {
        return group;
    }

    const colsAsc = [...group.cols].sort((a, b) => a - b);
    const removable = colsAsc
        .slice(1, -1) // never touch the outer boundaries
        .filter(x => !isNearRealCol(x) && innerSides.some(side => Math.abs(side - x) <= sideTolerance));
    if (!removable.length) {
        return group;
    }

    group.cols = group.cols.filter((x: number) => !removable.includes(x));
    if (Array.isArray(group.rectanglesCols)) {
        group.rectanglesCols = group.rectanglesCols.filter(
            (x: number) => !removable.some(removed => Math.abs(removed - x) <= sideTolerance),
        );
    }
    group.headerRows = determineHeaderRows({
        coordinates: group.coordinates || [],
        edges: group.edges || [],
        rectangles: group.rectangles || [],
        rows: [...(group.rows || [])],
        cols: group.cols || [],
        lineMaxWidth,
        separatorRows: group.synthesizedRows || [],
    });
    return group;
}

/**
* Text-only table (no visible rules, no fills). A band between two row boundaries that is
* thinner than a text line and holds no text is a gap, not a row: e.g. the white space between
* a multi-line header and the first body line. The text of a multi-line cell stands on the
* UPPER boundary of such a gap (its lowest baseline) and is assigned to the band below, so the
* header splits into two rows. Removing the upper boundary attaches the gap to the band above.
*/
export function absorbThinEmptyBands(group: any, lineMaxWidth: number): any {
    if (!group?.rows?.length || group.rows.length < 5) {
        return group;
    }
    // Rules or fills exist: the boundaries are drawn, leave them alone.
    if ((group.edgesRows || []).length || (group.rectanglesRows || []).length) {
        return group;
    }

    const textBlocks = (group.coordinates || []).filter(
        (block: any) =>
            block?.str?.trim() && Number.isFinite(block.y) && Number.isFinite(block.height),
    );
    const modalTextHeight = +findMod(textBlocks.map((block: any) => block.height)) || 0;
    if (!(modalTextHeight > 0)) {
        return group;
    }

    const tolerance = Math.max(lineMaxWidth * 0.2, 0.6);
    const rowsDesc = [...group.rows].sort((a, b) => b - a);
    const removed: number[] = [];

    // Interior bands only: the first and the last band are never touched.
    for (let index = 1; index < rowsDesc.length - 2; index++) {
        const upper = rowsDesc[index];
        const lower = rowsDesc[index + 1];
        if (upper - lower >= modalTextHeight * 0.9) {
            continue;
        }
        const hasText = textBlocks.some((block: any) => {
            const overlap = Math.min(block.y + block.height, upper) - Math.max(block.y, lower);
            return overlap > tolerance;
        });
        if (!hasText) {
            removed.push(upper);
        }
    }
    if (!removed.length) {
        return group;
    }

    group.rows = group.rows.filter((y: number) => !removed.includes(y));
    group.y = [Math.min(...group.rows), Math.max(...group.rows)];
    group.headerRows = determineHeaderRows({
        coordinates: group.coordinates || [],
        edges: group.edges || [],
        rectangles: group.rectangles || [],
        rows: [...group.rows],
        cols: group.cols || [],
        lineMaxWidth,
        separatorRows: group.synthesizedRows || [],
    });
    return group;
}

export function trimUnsupportedTrailingRows(group, lineMaxWidth) {
    if (!group.rows?.length || !group.cols?.length || group.rows.length < 4) return group;

    let sortedRows = [...group.rows].sort((a, b) => b - a);
    let sortedCols = [...group.cols].sort((a, b) => a - b);
    let fullColsCount = sortedCols.length - 1;
    let realEdges = (group.edges || []).filter(e => isVisibleVector(e) && !e['_isFakeLine']);

    function analyzeRange(topY, bottomY) {
        let edgesInRange = realEdges.filter(e => e.y <= topY + 1 && e.y >= bottomY - 1);
        let textBlocks = (group.coordinates || []).filter(c => c?.str?.trim() && c.y <= topY + 1 && c.y > bottomY - 1);
        let usedCols = new Set<number>();

        textBlocks.forEach(tb => {
            for (let ci = 0; ci < sortedCols.length - 1; ci++) {
                if (tb.x >= sortedCols[ci] - 1 && tb.x + tb.width <= sortedCols[ci + 1] + 1) usedCols.add(ci);
            }
        });

        // A column without its own text in this narrow Y-band may still
        // be effectively occupied—for example, a rowspan cell whose text
        // is anchored higher up, within a taller combined area that
        // only partially overlaps this specific row (exactly the case
        // of “Pellentesque” in fpdf_example-1.pdf). If a column lies entirely
        // between two actual vertical edges, each of which
        // extends to the FULL height of that row, this is direct structural
        // proof that a cell is present here—regardless of where
        // its text physically begins.
        const fullHeightEdgeXs = [...new Set(
            realEdges
                .filter(e => {
                    const isVertical = e.width < lineMaxWidth * 2 && e.height > lineMaxWidth;
                    if (!isVertical) return false;
                    const edgeTop = e.y + e.height;
                    const edgeBottom = e.y;
                    return edgeTop >= topY - 1 && edgeBottom <= bottomY + 1;
                })
                .map(e => e.x)
        )].sort((a: any, b: any) => a - b);

        for (let fi = 0; fi < fullHeightEdgeXs.length - 1; fi++) {
            const left: any = fullHeightEdgeXs[fi];
            const right: any = fullHeightEdgeXs[fi + 1];
            for (let ci = 0; ci < sortedCols.length - 1; ci++) {
                if (sortedCols[ci] >= left - 1 && sortedCols[ci + 1] <= right + 1) {
                    usedCols.add(ci);
                }
            }
        }

        return { edgesInRange, usedCols, textBlocks };
    }

    // we check from the end of the group to the beginning: the string is considered
    // "unsupported" if there are no real edges next to it at all,
    // or a narrow slice of columns was used (< 60% of the full set) —
    // this is exactly the signature of your two PDFs (empty edges on the left / only
    // right columns)
    let cutIndex = -1;
    for (let i = 0; i < sortedRows.length - 1; i++) {
        let { edgesInRange, usedCols, textBlocks } = analyzeRange(sortedRows[i], sortedRows[i + 1]);
        if (!textBlocks.length) continue;
        let hasWideTextCoverage = fullColsCount > 0 && usedCols.size >= fullColsCount * 0.6;
        let unsupported =
            !hasWideTextCoverage &&
            (
                edgesInRange.length === 0 ||
                (usedCols.size > 0 && usedCols.size < fullColsCount * 0.6)
            );
        if (!unsupported) { cutIndex = -1; continue; }
        if (cutIndex === -1) cutIndex = i;
    }

    // cutIndex now points to the FIRST line of the longest
    // unanchored tail, if it extends to the end of the group
    if (cutIndex === -1) return group;
    let tailIsUnbroken = true;
    for (let j = cutIndex; j < sortedRows.length - 1; j++) {
        let { edgesInRange, usedCols, textBlocks } = analyzeRange(sortedRows[j], sortedRows[j + 1]);
        if (!textBlocks.length) continue;
        let hasWideTextCoverage = fullColsCount > 0 && usedCols.size >= fullColsCount * 0.6;
        let unsupported =
            //!hasWideTextCoverage &&
            (
                edgesInRange.length === 0 ||
                (usedCols.size > 0 && usedCols.size < fullColsCount * 0.6)
            );
        if (!unsupported) { tailIsUnbroken = false; break; }
    }
    if (!tailIsUnbroken || cutIndex < 2) return group; // we don’t cut if it’s not the tail or almost the entire table

    let cutoffY = sortedRows[cutIndex];
    group.rows = group.rows.filter(y => y >= cutoffY);
    group.coordinates = (group.coordinates || []).filter(c => c.y >= cutoffY - 1);
    group.edges = (group.edges || []).filter(e => e.y >= cutoffY - 1);
    group.rectangles = (group.rectangles || []).filter(r => r.y >= cutoffY - 1);

    group.headerRows = determineHeaderRows({
        coordinates: group.coordinates || [],
        edges: group.edges || [],
        rectangles: group.rectangles || [],
        rows: group.rows || [],
        cols: group.cols || [],
        lineMaxWidth,
    });
    return group;
}


export function extendGroupTopBorder(group, pageGroup, lineMaxWidth) {
    if (!pageGroup || !group.rows?.length || !group.cols?.length) return group;

    let currentTop = Math.max(...group.rows);
    let groupXMin = Math.min(...group.cols);
    let groupXMax = Math.max(...group.cols);
    let groupWidth = groupXMax - groupXMin;
    let borderSize = group.borderSize || 0.57;
    let edgeTolerance = Math.max(1, borderSize * 3);

    // the search window is tied to the PROPER row step of this particular table,             
    // not to an arbitrary constant or the entire page.
    let sortedRows = [...group.rows].sort((a, b) => a - b);
    let rowGaps = sortedRows.slice(1).map((y, i) => y - sortedRows[i]).filter(g => g > 0);
    let modalRowHeight = +findMod(rowGaps) || findAverage(rowGaps) || 20;
    let searchLimit = currentTop + modalRowHeight * 1.5;

    let candidates = (pageGroup.edges || [])
        .filter(e => isVisibleVector(e))
        .filter(e => e.height < lineMaxWidth && e.width > lineMaxWidth)
        .filter(e => e.y > currentTop + 0.5 && e.y <= searchLimit);

    if (!candidates.length) return group;

    let byY: Record<string, any[]> = {};
    candidates.forEach(e => {
        let existingKey = Object.keys(byY).find(k => Math.abs(+k - e.y) < 1);
        let key = existingKey ?? String(e.y);
        byY[key] = byY[key] || [];
        byY[key].push(e);
    });

    // structural proof: this table ITSELF (according to its
    // own extreme X — left/right column) must physically
    // something to be close to candidate Y. Someone else's random line is further away
    // on a page , the X will almost never match the borders exactly
    // of this table.
    let hasOwnBoundaryEvidence = (y: number) => {
        return (pageGroup.edges || []).some(e =>
            isVisibleVector(e) &&
            (Math.abs(e.x - groupXMin) <= edgeTolerance || Math.abs(e.x - groupXMax) <= edgeTolerance) &&
            y >= e.y - edgeTolerance && y <= e.y + (e.height || 0) + edgeTolerance
        );
    };

    let bestY = null;
    Object.keys(byY).forEach(yKey => {
        let y = +yKey;
        let covered = byY[yKey].reduce((sum, s) => sum + s.width, 0);
        let wideEnough = covered >= groupWidth * 0.85;
        if (wideEnough && hasOwnBoundaryEvidence(y)) {
            if (bestY === null || y < bestY) bestY = y;
        }
    });
    if (bestY === null) return group;

    let newCoordinates = (pageGroup.coordinates || []).filter(c =>
        c.y > currentTop && c.y <= bestY &&
        c.x >= groupXMin - 1 && c.x <= groupXMax + 1
    );
    // There is no text in THIS table at all below the line — probably,
    // this is not its boundary; we refuse to expand it.
    if (!newCoordinates.length) return group;

    group.rows = addToGridList(group.rows, bestY);//old:[...new Set([...group.rows, bestY])].sort((a, b) => a - b);
    group.edgesRows = addToGridList(group.edgesRows, bestY);//old:[...new Set([...(group.edgesRows || []), bestY])].sort((a, b) => a - b);
    group.y = [Math.min(...group.y, bestY), Math.max(...group.y, bestY)];

    let newEdges = (pageGroup.edges || []).filter(e => e.y > currentTop && e.y <= bestY);
    group.edges = uniqueArr([...(group.edges || []), ...newEdges], ['x', 'y', 'width', 'height']);

    let newRectangles = (pageGroup.rectangles || []).filter(r =>
        r.y >= currentTop - 1 && (r.y + r.height) <= bestY + 1 &&
        r.x >= groupXMin - 1 && (r.x + r.width) <= groupXMax + 1
    );
    group.rectangles = uniqueArr([...(group.rectangles || []), ...newRectangles], ['x', 'y', 'width', 'height']);

    group.coordinates = uniqueArr([...(group.coordinates || []), ...newCoordinates], ['x', 'y', 'width', 'height']);

    group.headerRows = determineHeaderRows({
        coordinates: group.coordinates || [],
        edges: group.edges || [],
        rectangles: group.rectangles || [],
        rows: group.rows || [],
        lineMaxWidth: lineMaxWidth,
    });

    return group;
}


/**
* A totals row ("ALL INDIA") drawn with its own rules can lie further from the
* table than the clustering tolerance, so it never joins the table group (and a
* group without a header is discarded). This looks for such a row below the
* table in the page-level group and attaches it when it really continues the
* table: it is bounded by full-width horizontal rules, its text occupies the
* same columns as the body and has the same value kinds.
*/
export function extendGroupBottomRow(group, pageGroup, lineMaxWidth) {
    if (!pageGroup || !group?.rows?.length || !group?.cols?.length || group.cols.length < 3) {
        return group;
    }

    // Only for tables that are drawn with horizontal rules
    if (!(group.edgesRows || []).length) {
        return group;
    }

    const cols = [...group.cols].sort((a, b) => a - b);
    const columnCount = cols.length - 1;
    const tableLeft = cols[0];
    const tableRight = cols[cols.length - 1];
    const tableWidth = tableRight - tableLeft;

    const groupBlocks = (group.coordinates || []).filter(
        block => block?.str?.trim() && Number.isFinite(block.y)
    );

    if (groupBlocks.length < 4 || tableWidth <= 0) {
        return group;
    }

    const modalTextHeight = +findMod(groupBlocks.map(block => block.height)) || 1;
    const tableBottomText = Math.min(...groupBlocks.map(block => block.y));

    // Full-width horizontal rules of the page, clustered by position
    const lineClusters: Array<{ y: number; center: number; covered: number; edges: any[] }> = [];

    uniqueArr(
        (pageGroup.edges || []).filter(
            edge => isVisibleVector(edge)
                && edge.height < lineMaxWidth
                && edge.width > lineMaxWidth
        ),
        ['x', 'y', 'width', 'height']
    ).forEach(edge => {
        const overlap = Math.max(
            0,
            Math.min(edge.x + edge.width, tableRight) - Math.max(edge.x, tableLeft)
        );

        if (overlap <= 0) {
            return;
        }

        const center = edge.y + edge.height / 2;
        let cluster = lineClusters.find(item => Math.abs(item.center - center) <= 1.5);

        if (!cluster) {
            cluster = { y: edge.y, center, covered: 0, edges: [] };
            lineClusters.push(cluster);
        }

        cluster.y = Math.min(cluster.y, edge.y);
        cluster.covered += overlap;
        cluster.edges.push(edge);
    });

    const fullLines = lineClusters
        .filter(cluster =>
            cluster.covered / tableWidth >= 0.85
            && cluster.center < tableBottomText - 0.5
        )
        .sort((a, b) => b.center - a.center);

    const maxGap = modalTextHeight * 2;
    const maxRowHeight = modalTextHeight * 4;
    const topLine = fullLines[0];

    if (!topLine || tableBottomText - topLine.center > maxGap) {
        return group;
    }

    const bottomLine = fullLines.find(cluster =>
        cluster.center < topLine.center - 0.5
        && topLine.center - cluster.center <= maxRowHeight
    );

    const bandTop = topLine.center;
    const bandBottom = bottomLine ? bottomLine.center : topLine.center - modalTextHeight * 2;

    const knownIndexes = new Set(groupBlocks.map(block => block.index));

    // Same convention as extractTableData(): baseline <= top && baseline > bottom
    const rowBlocks = (pageGroup.coordinates || []).filter(block => {
        if (!block?.str?.trim() || knownIndexes.has(block.index)) {
            return false;
        }

        const center = block.x + (block.width || 0) / 2;

        return block.y <= bandTop
            && block.y > bandBottom
            && center >= tableLeft - 1
            && center <= tableRight + 1;
    });

    const getColumn = (block: any): number => {
        const center = block.x + (block.width || 0) / 2;

        for (let column = 0; column < columnCount; column++) {
            if (center >= cols[column] && center < cols[column + 1]) {
                return column;
            }
        }

        return -1;
    };

    const isPlaceholder = (block: any): boolean =>
        /^(?:[-\u2013\u2014\u2212]|n\.?a\.?|\.\.)$/i.test(block.str.trim());

    const getKind = (block: any): string =>
        /^[-+\u2212]?\d[\d.,\s]*%?$/.test(block.str.trim()) ? 'number' : 'text';

    const bodyKindCounts: Array<Record<string, number>> =
        Array.from({ length: columnCount }, () => ({}));

    groupBlocks.forEach(block => {
        const column = getColumn(block);

        if (column >= 0 && !isPlaceholder(block)) {
            const kind = getKind(block);
            bodyKindCounts[column][kind] = (bodyKindCounts[column][kind] || 0) + 1;
        }
    });

    const bodyKinds = bodyKindCounts.map(counts => {
        const kinds = Object.keys(counts);

        return kinds.length
            ? kinds.reduce((best, kind) => counts[kind] > counts[best] ? kind : best)
            : null;
    });

    const occupiedBodyColumns = bodyKinds.filter(Boolean).length;
    const rowBlocksInGrid = rowBlocks.filter(block => getColumn(block) >= 0);
    const rowColumns = new Set(rowBlocksInGrid.map(getColumn));

    const comparableBlocks = rowBlocksInGrid.filter(block => !isPlaceholder(block));

    const kindRatio = comparableBlocks.length
        ? comparableBlocks.filter(
            block => bodyKinds[getColumn(block)] === getKind(block)
        ).length / comparableBlocks.length
        : 0;

    const accepted =
        rowBlocksInGrid.length > 0
        && rowColumns.size >= Math.max(2, Math.ceil(occupiedBodyColumns * 0.7))
        && kindRatio >= 0.8;

    if (!accepted) {
        return group;
    }

    const newRows = [
        topLine.y,
        bottomLine
            ? bottomLine.y
            : Math.min(...rowBlocksInGrid.map(block => block.y)) - modalTextHeight * 0.5,
    ];

    group.rows = addToGridList(group.rows, newRows);//old:[...new Set([...group.rows, ...newRows])].sort((a, b) => a - b);
    group.edgesRows = addToGridList(group.edgesRows, [topLine.y, ...(bottomLine ? [bottomLine.y] : [])]);//old:[...new Set([...(group.edgesRows || []),topLine.y,...(bottomLine ? [bottomLine.y] : [])])].sort((a, b) => a - b);
    group.edges = uniqueArr(
        [...(group.edges || []), ...topLine.edges, ...(bottomLine ? bottomLine.edges : [])],
        ['x', 'y', 'width', 'height']
    );
    group.coordinates = uniqueArr(
        [...(group.coordinates || []), ...rowBlocksInGrid],
        ['x', 'y', 'width', 'height']
    );
    group.y = [Math.min(...group.rows), Math.max(...group.rows)];

    return group;
}


/**
* For tables whose row structure comes ONLY from filled bands (no stroked
* lines), the area above the topmost band edge has no geometric evidence:
* its rows can only be derived from the text itself.
*
*  1. A lone text block separated from the rest by a clearly visible gap is
*     a caption (page title), not a table row -> cut it off.
*  2. Text bands separated by a full-width vertical gap are different rows
*     (typically: header row vs. first unbanded data row) -> add a row
*     boundary in the middle of that gap.
*/
export function refineTextOnlyTopRows(group, lineMaxWidth) {
    if (!group?.rows?.length || !group?.cols?.length || group.cols.length < 3) {
        return group;
    }

    const hasStrokedRows = (group.edgesRows || []).length > 0;
    const bandRows: number[] = group.rectanglesRows || [];

    if (hasStrokedRows || bandRows.length < 4) {
        return group;
    }

    const topBandRow = Math.max(...bandRows);

    const openAreaBlocks = (group.coordinates || []).filter(block =>
        block?.str?.trim() &&
        Number.isFinite(block.y) &&
        Number.isFinite(block.height) &&
        block.y >= topBandRow - 0.5
    );

    if (openAreaBlocks.length < 2) {
        return group;
    }

    const modalTextHeight =
        +findMod((group.coordinates || []).map(block => block.height)) || 1;

    // Group the blocks of the open area into vertical text bands
    const bandMergeTolerance = 0.25;
    const bands: Array<{ bottom: number; top: number; blocks: any[] }> = [];

    [...openAreaBlocks]
        .sort((a, b) => a.y - b.y)
        .forEach(block => {
            const bottom = block.y;
            const top = block.y + block.height;
            const lastBand = bands[bands.length - 1];

            if (lastBand && bottom <= lastBand.top + bandMergeTolerance) {
                lastBand.top = Math.max(lastBand.top, top);
                lastBand.blocks.push(block);
            } else {
                bands.push({ bottom, top, blocks: [block] });
            }
        });

    // 1. Caption trimming (top band = last one, bands are sorted bottom-up)
    const headerBlockIndexes = new Set(
        (Object.values(group.headerRows || {}) as any[][])
            .flat()
            .map(block => block?.index)
    );
    const captionBlocks = new Set<any>();

    while (bands.length > 1) {
        const upper = bands[bands.length - 1];
        const lower = bands[bands.length - 2];
        const gap = upper.bottom - lower.top;

        const upperHasNoHeaderBlocks = upper.blocks.every(
            block => !headerBlockIndexes.has(block.index),
        );

        // Original rule: a lone block above a multi-block band is a caption.
        const isLoneCaption = upper.blocks.length === 1;

        // Page title made of several blocks (left / centre / right) standing above an
        // already confirmed header band. A centred multi-line title overlaps the other
        // blocks vertically, so they all end up in ONE band and the "lone block" rule
        // above never fires. The title band is sparser than the header band below it
        // and contains no header blocks.
        const isTitleAboveConfirmedHeader =
            upper.blocks.length > 1 &&
            upper.blocks.length < lower.blocks.length &&
            lower.blocks.every(block => headerBlockIndexes.has(block.index));

        const isCaption =
            (isLoneCaption || isTitleAboveConfirmedHeader) &&
            lower.blocks.length >= 2 &&
            gap >= modalTextHeight * 0.75 &&
            upperHasNoHeaderBlocks;

        if (!isCaption) {
            break;
        }

        upper.blocks.forEach(block => captionBlocks.add(block));
        bands.pop();
    }

    // 2. Row boundaries between text bands separated by a full-width gap
    const minGap = Math.max(group.borderSize || 0.57, 1);
    const synthesizedRows: number[] = [];

    for (let i = 0; i < bands.length - 1; i++) {
        const lower = bands[i];
        const upper = bands[i + 1];
        const gap = upper.bottom - lower.top;

        if (gap < minGap || lower.blocks.length < 2 || upper.blocks.length < 2) {
            continue;
        }

        const alreadySeparated = group.rows.some(
            y => y >= lower.top - 0.5 && y <= upper.bottom + 0.5
        );

        if (!alreadySeparated) {
            synthesizedRows.push(lower.top + gap / 2);
        }
    }

    if (!captionBlocks.size && !synthesizedRows.length) {
        return group;
    }

    if (captionBlocks.size) {
        const keptTop = bands[bands.length - 1].top;
        const existingTopRow = group.rows.find(y => Math.abs(y - keptTop) < 0.5);
        const topRow = existingTopRow !== undefined ? existingTopRow : keptTop;

        group.rows = addToGridList(group.rows.filter(y => y <= topRow + 1e-6), topRow);//old:[...new Set([...group.rows.filter(y => y <= topRow + 1e-6), topRow])];
        group.coordinates = (group.coordinates || []).filter(
            block => !captionBlocks.has(block)
        );
    }

    group.rows = addToGridList(group.rows, synthesizedRows)//old:[...new Set([...group.rows, ...synthesizedRows])].sort((a, b) => a - b);
    group.synthesizedRows = [...(group.synthesizedRows || []), ...synthesizedRows];
    group.y = [Math.min(...group.rows), Math.max(...group.rows)];

    group.headerRows = determineHeaderRows({
        coordinates: group.coordinates || [],
        edges: group.edges || [],
        rectangles: group.rectangles || [],
        rows: [...group.rows],
        cols: group.cols || [],
        lineMaxWidth,
        separatorRows: group.synthesizedRows || [],
    });

    return group;
}


/**
* Between two real rules the table has no row separators, so the row grid is
* derived from raw text borders (baseline and top of every text line). Every
* text line then gets TWO borders, which yields an empty row between each pair
* of data rows. When such empty, unbacked, text-height rows are found, the rows
* between the rules are rebuilt: one boundary in the middle of every gap
* between consecutive text lines.
*/
export function rebuildUnseparatedRows(group, lineMaxWidth) {
    if (!group?.rows?.length || group.rows.length < 6) {
        return group;
    }

    const assured = [...new Set([
        ...(group.edgesRows || []),
        ...(group.rectanglesRows || []),
    ])].sort((a, b) => b - a);

    if (assured.length < 2) {
        return group;
    }

    const blocks = (group.coordinates || []).filter(
        block => block?.str?.trim() && Number.isFinite(block.y)
    );

    if (blocks.length < 4) {
        return group;
    }

    const isAssured = (y: number) => assured.some(value => Math.abs(value - y) <= 0.01);
    const modalTextHeight = +findMod(blocks.map(block => block.height)) || 1;
    const rowsDesc = [...group.rows].sort((a, b) => b - a);

    // Same convention as extractTableData(): baseline <= top && baseline > bottom
    const hasText = (top: number, bottom: number) =>
        blocks.some(block => block.y <= top && block.y > bottom);

    // Interior rows that are empty, as tall as a text line and not backed by a rule,
    // between two rows that contain text
    const tinyEmptyRows: Array<[number, number]> = [];

    for (let i = 1; i < rowsDesc.length - 2; i++) {
        const top = rowsDesc[i];
        const bottom = rowsDesc[i + 1];

        if (isAssured(top) || isAssured(bottom)) {
            continue;
        }

        if (
            top - bottom <= modalTextHeight * 1.2
            && !hasText(top, bottom)
            && hasText(rowsDesc[i - 1], top)
            && hasText(bottom, rowsDesc[i + 2])
        ) {
            tinyEmptyRows.push([top, bottom]);
        }
    }

    const interiorRows = rowsDesc.length - 3;

    if (tinyEmptyRows.length < 3 || tinyEmptyRows.length < interiorRows * 0.25) {
        return group;
    }

    // Anchors: real rules, plus the lowest row if it lies below the last rule
    const anchors = [...assured];
    const lowestRow = rowsDesc[rowsDesc.length - 1];

    if (lowestRow < anchors[anchors.length - 1] - 0.01) {
        anchors.push(lowestRow);
    }

    let rows = [...rowsDesc];
    const midpoints: number[] = [];

    for (let index = 0; index < anchors.length - 1; index++) {
        const top = anchors[index];
        const bottom = anchors[index + 1];

        const hasGapRows = tinyEmptyRows.some(
            ([gapTop, gapBottom]) => gapTop <= top + 0.01 && gapBottom >= bottom - 0.01
        );

        if (!hasGapRows) {
            continue;
        }

        // Text bands inside the interval (union of the vertical extents of blocks)
        const bands: Array<{ bottom: number; top: number }> = [];

        blocks
            .filter(block => block.y <= top && block.y > bottom)
            .sort((first, second) => first.y - second.y)
            .forEach(block => {
                const last = bands[bands.length - 1];
                const blockTop = block.y + block.height;

                if (last && block.y <= last.top + 0.25) {
                    last.top = Math.max(last.top, blockTop);
                } else {
                    bands.push({ bottom: block.y, top: blockTop });
                }
            });

        if (bands.length < 2) {
            continue;
        }

        const intervalMidpoints = bands
            .slice(1)
            .map((band, bandIndex) => (bands[bandIndex].top + band.bottom) / 2);

        rows = rows.filter(y => !(y < top - 0.01 && y > bottom + 0.01));
        rows.push(...intervalMidpoints);
        midpoints.push(...intervalMidpoints);
    }

    if (!midpoints.length) {
        return group;
    }

    group.rows = [...new Set(rows)].sort((a, b) => a - b);
    // Boundaries without a drawn rule must survive generateVirtualEdges()
    group.synthesizedRows = [...(group.synthesizedRows || []), ...midpoints];
    group.y = [Math.min(...group.rows), Math.max(...group.rows)];

    return group;
}

/**
 * A group without a detected header must show real table structure: a ruled grid
 * (3+ visible rules in one direction) or filled bands (3+ band borders).
 * A text box inside a decorative frame or a filled rectangle is not a table.
 */
export function isTableGroup(group: any, lineMaxWidth: number): boolean {
    if (Object.keys(group?.headerRows || {}).length) {
        return true;
    }

    // Number of distinct positions (rules closer than 2 pt are one rule)
    const countDistinct = (values: number[]): number => {
        let count = 0;
        let previous = -Infinity;

        [...values].sort((a, b) => a - b).forEach(value => {
            if (value - previous > 2) {
                count++;
            }

            previous = value;
        });

        return count;
    };

    const rules = (group?.edges || []).filter(
        (edge: any) => isVisibleVector(edge) && !edge['_isFakeLine']
    );

    const horizontal = countDistinct(
        rules
            .filter((edge: any) => edge.height < lineMaxWidth && edge.width > lineMaxWidth)
            .map((edge: any) => edge.y + edge.height / 2)
    );

    const vertical = countDistinct(
        rules
            .filter((edge: any) => edge.width < lineMaxWidth && edge.height > lineMaxWidth)
            .map((edge: any) => edge.x + edge.width / 2)
    );

    return horizontal >= 3
        || vertical >= 3
        || (group?.rectanglesRows || []).length >= 3;
}

/**
 * Horizontal extent of a ruled table: the widest span shared by at least three
 * visible horizontal rules. A rule drawn once (an accent line under the table)
 * and invisible clip edges do not count. Returns null when the rules do not
 * give one unambiguous extent (e.g. two tables side by side).
 */
export function getRuleExtent(
    group: any,
    lineMaxWidth: number
): { left: number; right: number } | null {
    const tolerance = 1.5;

    const horizontals = (group?.edges || []).filter((edge: any) =>
        isVisibleVector(edge)
        && !edge['_isFakeLine']
        && edge.height < lineMaxWidth
        && edge.width > lineMaxWidth
    );

    // One entry per rule: segments of the same rule are united
    const rules: Array<{ y: number; left: number; right: number }> = [];

    horizontals.forEach((edge: any) => {
        const y = edge.y + edge.height / 2;
        const rule = rules.find(item => Math.abs(item.y - y) <= tolerance);

        if (rule) {
            rule.left = Math.min(rule.left, edge.x);
            rule.right = Math.max(rule.right, edge.x + edge.width);
        } else {
            rules.push({ y, left: edge.x, right: edge.x + edge.width });
        }
    });

    const supported = rules.filter(rule =>
        rules.filter(other =>
            Math.abs(other.left - rule.left) <= tolerance
            && Math.abs(other.right - rule.right) <= tolerance
        ).length >= 3
    );

    if (!supported.length) {
        return null;
    }

    const widest = supported.reduce((best, rule) =>
        rule.right - rule.left > best.right - best.left ? rule : best
    );

    // Every well supported extent must lie inside the widest one,
    // otherwise these are separate tables and nothing can be cut
    const unambiguous = supported.every(rule =>
        rule.left >= widest.left - tolerance && rule.right <= widest.right + tolerance
    );

    return unambiguous ? { left: widest.left, right: widest.right } : null;
}

/**
* Horizontal extent of a table that is closed by drawn rules: the outermost
* horizontal rules end exactly on vertical rules at both sides. Returns null
* for tables that are not closed (borderless, horizontal rules only...), so
* text beside such a table is never treated as "outside".
*/
export function getRuledBoxExtent(group: any, lineMaxWidth: number): { left: number; right: number } | null {
    const visibleEdges = (group?.edges || []).filter(
        (edge: any) => isVisibleVector(edge) && !edge['_isFakeLine']
    );

    const horizontals = visibleEdges.filter(
        (edge: any) => edge.height < lineMaxWidth && edge.width > lineMaxWidth
    );

    const verticals = visibleEdges.filter(
        (edge: any) => edge.width < lineMaxWidth && edge.height > lineMaxWidth
    );

    if (horizontals.length < 2 || verticals.length < 2) {
        return null;
    }

    const left = Math.min(...horizontals.map((edge: any) => edge.x));
    const right = Math.max(...horizontals.map((edge: any) => edge.x + edge.width));
    const tolerance = 1.5;

    const hasVerticalRuleAt = (x: number) => verticals.some((edge: any) =>
        Math.abs(edge.x - x) <= tolerance
        || Math.abs(edge.x + edge.width - x) <= tolerance
    );

    return hasVerticalRuleAt(left) && hasVerticalRuleAt(right) ? { left, right } : null;
}

/**
 * Text that lies inside the box of a table belongs to that table. Splitting a
 * group by rows and columns can leave pieces of the same table as separate
 * fragments, or lose them when a fragment has no header and is discarded.
 * This drops the fragments whose text lies completely inside a bigger group
 * and gives that group every unclaimed text block that lies inside its box.
 */
export function absorbEnclosedBlocks(tableGroups: any[], pageGroup: any): any[] {
    if (!tableGroups.length || !pageGroup?.coordinates?.length) {
        return tableGroups;
    }

    const tolerance = 2;

    const getBox = (group: any) =>
        group?.x?.length === 2 && group?.y?.length === 2
            ? { left: group.x[0], right: group.x[1], bottom: group.y[0], top: group.y[1] }
            : null;

    const getArea = (box: any) => (box.right - box.left) * (box.top - box.bottom);

    const isCenterInside = (block: any, box: any): boolean => {
        const centerX = block.x + (block.width || 0) / 2;
        const centerY = block.y + (block.height || 0) / 2;

        return centerX >= box.left - tolerance
            && centerX <= box.right + tolerance
            && centerY >= box.bottom - tolerance
            && centerY <= box.top + tolerance;
    };

    const boxes = tableGroups.map(getBox);

    const isFragment = tableGroups.map((group, index) => {
        const box = boxes[index];
        const blocks = (group.coordinates || []).filter(block => block?.str?.trim());

        if (!box || !blocks.length) {
            return false;
        }

        return tableGroups.some((other, otherIndex) => {
            const otherBox = boxes[otherIndex];

            return otherIndex !== index
                && !!otherBox
                && getArea(otherBox) > getArea(box)
                && blocks.every(block => isCenterInside(block, otherBox));
        });
    });

    const groups = tableGroups.filter((_, index) => !isFragment[index]);
    const claimed = new Set<number>();

    groups.forEach(group =>
        (group.coordinates || []).forEach(block => claimed.add(block.index))
    );

    groups.forEach(group => {
        const box = getBox(group);

        if (!box) {
            return;
        }

        const additions = pageGroup.coordinates.filter(block =>
            block?.str?.trim()
            && !claimed.has(block.index)
            && isCenterInside(block, box)
        );

        if (!additions.length) {
            return;
        }

        additions.forEach(block => claimed.add(block.index));
        group.coordinates = [...(group.coordinates || []), ...additions];

    });

    return groups;
}

/**
* splitGroups() cuts a group at every gap row without text. A single row that
* follows such a gap (a totals row such as "ALL INDIA") ends up in a range of
* two values, and ranges of two values are discarded as noise.
*
* A short tail is attached back to the preceding range when it is a real
* continuation of the same table:
*   - it is close to the table (gap <= text line tolerance),
*   - its text occupies (nearly) the same columns as the table body,
*   - its values have the same kind (number / text) as the body column,
*   - if the table is drawn with horizontal lines, such lines span the
*     table width next to the tail.
*/
export function rescueContinuationRanges(options: {
    rowsRanges: number[][];
    group: any;
    globalGroup: any;
}): number[][] {
    const { rowsRanges, group, globalGroup } = options;
    const lineMaxWidth = LINE_MAX_WIDTH;
    const cols = [...(group.cols || [])].sort((a, b) => a - b);
    const columnCount = cols.length - 1;

    if (rowsRanges.length < 2 || columnCount < 2) {
        return rowsRanges;
    }

    const textBlocks = (group.coordinates || []).filter(
        block => block?.str?.trim() && Number.isFinite(block.y)
    );

    const getColumn = (block: any): number => {
        const center = block.x + (block.width || 0) / 2;

        for (let column = 0; column < columnCount; column++) {
            if (center >= cols[column] && center < cols[column + 1]) {
                return column;
            }
        }

        return -1;
    };

    const getKind = (block: any): string =>
        /^[-+\u2212]?\d[\d.,\s]*%?$/.test(block.str.trim()) ? 'number' : 'text';

    // Same convention as extractTableData(): baseline <= top && baseline > bottom
    const getBlocksBetween = (top: number, bottom: number) =>
        textBlocks.filter(block => block.y <= top && block.y > bottom);

    const tableLeft = cols[0];
    const tableRight = cols[cols.length - 1];
    const tableWidth = tableRight - tableLeft;

    const isHorizontalLine = (edge: any) =>
        isVisibleVector(edge) && edge.height < lineMaxWidth && edge.width > lineMaxWidth;

    const groupHasLines = (group.edges || []).some(isHorizontalLine);

    const horizontalLines = uniqueArr(
        [...(group.edges || []), ...(globalGroup?.edges || [])].filter(isHorizontalLine),
        ['x', 'y', 'width', 'height']
    );

    const getLineCoverage = (boundaries: number[]): number => {
        let covered = 0;

        horizontalLines.forEach(edge => {
            const center = edge.y + edge.height / 2;

            if (!boundaries.some(boundary => Math.abs(boundary - center) <= 1.5)) {
                return;
            }

            covered += Math.max(
                0,
                Math.min(edge.x + edge.width, tableRight) - Math.max(edge.x, tableLeft)
            );
        });

        return tableWidth > 0 ? covered / tableWidth : 0;
    };

    const rawTolerance = calculateToleranceValue(group.coordinates || []);
    const tolerance = Number.isFinite(rawTolerance) ? rawTolerance : 0;

    const isContinuation = (previous: number[], tail: number[]): boolean => {
        const bodyTop = previous[0];
        const bodyBottom = previous[previous.length - 1];
        const tailTop = tail[0];
        const tailBottom = tail[tail.length - 1];

        const round = (values: number[]) => values.map(value => +value.toFixed(2));

        if (Math.abs(tailTop - bodyBottom) > 1e-6 || tail.length < 2) {
            return false;
        }

        // Gap between the body and the first boundary of the tail
        const gap = tail.length >= 3 ? bodyBottom - tail[1] : 0;

        const tailBlocks = getBlocksBetween(tailTop, tailBottom)
            .filter(block => getColumn(block) >= 0);

        const bodyKindCounts: Array<Record<string, number>> =
            Array.from({ length: columnCount }, () => ({}));

        getBlocksBetween(bodyTop, bodyBottom).forEach(block => {
            const column = getColumn(block);

            if (column >= 0) {
                const kind = getKind(block);
                bodyKindCounts[column][kind] = (bodyKindCounts[column][kind] || 0) + 1;
            }
        });

        const bodyKinds = bodyKindCounts.map(counts => {
            const kinds = Object.keys(counts);

            return kinds.length
                ? kinds.reduce((best, kind) => counts[kind] > counts[best] ? kind : best)
                : null;
        });

        const occupiedBodyColumns = bodyKinds.filter(Boolean).length;
        const tailColumns = new Set(tailBlocks.map(getColumn));

        const kindRatio = tailBlocks.length
            ? tailBlocks.filter(block => bodyKinds[getColumn(block)] === getKind(block)).length
            / tailBlocks.length
            : 0;

        const lineCoverage = getLineCoverage(tail);

        const accepted =
            tailBlocks.length > 0
            && gap <= tolerance
            && tailColumns.size >= Math.max(2, Math.ceil(occupiedBodyColumns * 0.7))
            && kindRatio >= 0.8
            && (!groupHasLines || lineCoverage >= 0.85);

        return accepted;
    };

    const result: number[][] = [];

    for (let index = 0; index < rowsRanges.length;) {
        const range = rowsRanges[index];

        if (range.length > 2) {
            result.push([...range]);
            index++;
            continue;
        }

        // Collect consecutive short ranges: a gap row and the row after it
        const chain: number[][] = [];

        while (index < rowsRanges.length && rowsRanges[index].length <= 2) {
            chain.push(rowsRanges[index]);
            index++;
        }

        const previous = result[result.length - 1];
        const tail = [...new Set(chain.flat())].sort((a, b) => b - a);

        if (previous && previous.length > 2 && tail.length && isContinuation(previous, tail)) {
            const previousBottom = previous[previous.length - 1];
            previous.push(...tail.filter(value => value < previousBottom - 1e-6));
        } else {
            result.push(...chain);
        }
    }

    return result;
}

export function constrainGroupToRuledFrame(group: any): any {
    if (!group?.edges?.length || !group?.rows?.length) {
        return group;
    }
    const lineMaxWidth = LINE_MAX_WIDTH;
    // Reuse previously detected bounds if the group passes through
    // another stage of table-group processing.
    let frameBounds = group.ruledFrameBounds;

    if (!frameBounds) {
        const frame = getRuledBoxExtent(group, lineMaxWidth);

        if (!frame) {
            return group;
        }

        const frameWidth = frame.right - frame.left;

        if (!(frameWidth > 0)) {
            return group;
        }

        const borderSize = group.borderSize || 0.57;
        const lineTolerance = Math.max(
            1.5,
            Math.min(borderSize * 3, 3)
        );

        const horizontalRules = group.edges.filter(
            (edge: any) =>
                isVisibleVector(edge) &&
                !edge._isFakeLine &&
                edge.height < lineMaxWidth &&
                edge.width > lineMaxWidth
        );

        const clusters: Array<{
            axisY: number;
            rowCoordinates: number[];
            intervals: Array<[number, number]>;
        }> = [];

        for (const edge of horizontalRules) {
            const axisY = edge.y + edge.height / 2;
            const start = Math.max(frame.left, edge.x);
            const end = Math.min(
                frame.right,
                edge.x + edge.width
            );

            if (!(end > start)) {
                continue;
            }

            let cluster = clusters.find(
                candidate =>
                    Math.abs(candidate.axisY - axisY) <= lineTolerance
            );

            if (!cluster) {
                cluster = {
                    axisY,
                    rowCoordinates: [],
                    intervals: []
                };

                clusters.push(cluster);
            }

            cluster.rowCoordinates.push(edge.y);
            cluster.intervals.push([start, end]);
        }

        function getCoveredWidth(
            intervals: Array<[number, number]>
        ): number {
            const sorted = [...intervals].sort(
                (a, b) => a[0] - b[0]
            );

            if (!sorted.length) {
                return 0;
            }

            let covered = 0;
            let [start, end] = sorted[0];

            for (let index = 1; index < sorted.length; index++) {
                const [nextStart, nextEnd] = sorted[index];

                if (nextStart <= end) {
                    end = Math.max(end, nextEnd);
                } else {
                    covered += end - start;
                    start = nextStart;
                    end = nextEnd;
                }
            }

            return covered + end - start;
        }

        const frameRules = clusters.filter(
            cluster =>
                getCoveredWidth(cluster.intervals) >=
                frameWidth * 0.6
        );

        // A closed frame must provide evidence for both its upper
        // and lower boundaries.
        if (frameRules.length < 2) {
            return group;
        }

        function getMedian(values: number[]): number {
            const sorted = [...values].sort((a, b) => a - b);
            return sorted[Math.floor(sorted.length / 2)];
        }

        const ruleRows = frameRules.map(cluster =>
            getMedian(cluster.rowCoordinates)
        );

        const top = Math.max(...ruleRows);
        const bottom = Math.min(...ruleRows);

        if (!(top > bottom)) {
            return group;
        }

        frameBounds = {
            left: frame.left,
            right: frame.right,
            top,
            bottom,
            tolerance: lineTolerance
        };

        group.ruledFrameBounds = frameBounds;
    }

    const { left, right, top, bottom, tolerance } = frameBounds;

    const textBlocks = (group.coordinates || []).filter(
        (block: any) => block?.str?.trim() && Number.isFinite(block.y)
    );

    // Text outside the frame is a caption only if every text band there holds
    // a single block. A band with several blocks is a table row (e.g. a header
    // drawn above the first rule) and must stay in the grid.
    const hasOnlyCaptions = (blocks: any[]): boolean => {
        const bands: any[][] = [];
        [...blocks]
            .sort((a, b) => a.y - b.y)
            .forEach(block => {
                const band = bands.find(
                    candidate =>
                        Math.abs(candidate[0].y - block.y) <= Math.max((block.height || 0) * 0.5, 1)
                );
                if (band) {
                    band.push(block);
                } else {
                    bands.push([block]);
                }
            });
        return bands.every(band => band.length === 1);
    };

    const clipTop = hasOnlyCaptions(textBlocks.filter((block: any) => block.y >= top + tolerance));
    const clipBottom = hasOnlyCaptions(
        textBlocks.filter((block: any) => block.y + (block.height || 0) <= bottom - tolerance)
    );
    const upperLimit = clipTop ? top + tolerance : Infinity;
    const lowerLimit = clipBottom ? bottom - tolerance : -Infinity;
    const isInside = (value: number): boolean =>
        Number.isFinite(value) && value >= lowerLimit && value <= upperLimit;

    // Only derived grid geometry is touched. group.coordinates stays intact:
    // text outside the grid is simply not assigned to any cell later on.
    const constrainRows = (values: number[] = [], ensureBounds = false): number[] => {
        const kept = values.filter(isInside).map(value => {
            if (clipTop && Math.abs(value - top) <= tolerance) return top;
            if (clipBottom && Math.abs(value - bottom) <= tolerance) return bottom;
            return value;
        });
        if (ensureBounds) {
            if (clipTop) kept.push(top);
            if (clipBottom) kept.push(bottom);
        }
        return [...new Set(kept)].sort((a, b) => a - b);
    };

    group.rows = constrainRows(group.rows, true);
    group.assuredRows = constrainRows(group.assuredRows);
    group.edgesRows = constrainRows(group.edgesRows);
    group.rectanglesRows = constrainRows(group.rectanglesRows);
    group.synthesizedRows = constrainRows(group.synthesizedRows);
    group.x = [left, right];
    group.y = [Math.min(...group.rows), Math.max(...group.rows)];

    const originalHeaderRows = group.headerRows || {};
    const keptHeaderRows = Object.fromEntries(
        Object.entries(originalHeaderRows).filter(([key]) =>
            key.split('-').map(Number).every(isInside)
        )
    );
    const lostAllHeaders =
        Object.keys(originalHeaderRows).length > 0 && Object.keys(keptHeaderRows).length === 0;

    group.headerRows = lostAllHeaders
        ? determineHeaderRows({
            coordinates: group.coordinates || [],
            edges: group.edges || [],
            rectangles: group.rectangles || [],
            rows: [...group.rows],
            cols: group.cols || [],
            lineMaxWidth,
            separatorRows: group.synthesizedRows
        })
        : keptHeaderRows;

    return group;
}

// Rows that end with a run of filler characters ("........") are followed by
// a virtual row boundary. The boundary spans from the label to the last value
// that stands on the same baseline.
// Rows with a run of filler characters ("........") are separate rows.
// A virtual boundary is placed:
//  1. below every line that ends with a leader followed by data;
//  2. between neighbouring data lines (label + values) of one run of lines,
//     if that run contains at least one leader line. This keeps lines that
//     are too long to carry dots ("...and sought advice/treatment")
//     separate from the dotted lines around them.
export function applyLeaderRowBoundaries(group: any): any {
    if (!group?.rows?.length || !group?.coordinates?.length) {
        return group;
    }

    const LEADER_RUN = new RegExp(`(${LEADER_CHARS})(?:\\s?\\1){4,}`, 'u');
    const LEADER_THEN_CONTENT = new RegExp(
        `(${LEADER_CHARS})(?:\\s?\\1){4,}\\s*[\\p{L}\\p{N}]`,
        'u'
    );
    const lineMaxWidth = LINE_MAX_WIDTH;
    const textBlocks = group.coordinates.filter(
        (block: any) =>
            block?.str?.trim() &&
            [block.x, block.y, block.width, block.height].every(Number.isFinite)
    );
    if (!textBlocks.some((block: any) => LEADER_RUN.test(block.str))) {
        return group;
    }

    // Footnote marks (superscripts) belong to their host line and
    // must not form lines of their own.
    const modalHeight = +findMod(textBlocks.map((block: any) => block.height)) || 0;
    const mainBlocks = textBlocks.filter(
        (block: any) => !(modalHeight > 0 && block.height < modalHeight * 0.75)
    );

    // 1. Visual lines, top to bottom.
    const lines: any[] = [];
    [...mainBlocks]
        .sort((a, b) => b.y - a.y)
        .forEach(block => {
            const last = lines[lines.length - 1];
            if (last && Math.abs(last.baseline - block.y) <= Math.max(block.height * 0.6, 1.5)) {
                last.blocks.push(block);
            } else {
                lines.push({ baseline: block.y, blocks: [block] });
            }
        });

    lines.forEach(line => {
        const blocks = line.blocks;
        line.top = Math.max(...blocks.map((block: any) => block.y + block.height));
        line.bottom = Math.min(...blocks.map((block: any) => block.y));
        line.x1 = Math.min(...blocks.map((block: any) => block.x));
        line.x2 = Math.max(...blocks.map((block: any) => block.x + block.width));
        line.height = Math.max(...blocks.map((block: any) => block.height));

        // The line ends a row if a leader is followed by data.
        line.endsWithLeader = blocks.some((block: any) => {
            if (!LEADER_RUN.test(block.str)) {
                return false;
            }
            const gap = Math.max(block.height * 0.5, 2);
            return (
                LEADER_THEN_CONTENT.test(block.str) ||
                blocks.some((other: any) => other !== block && other.x >= block.x + block.width - gap)
            );
        });
        line.isData = blocks.length >= 2 || line.endsWithLeader;
    });

    // Lines of the header are never split into rows here. //!Bug in district_health.pdf (wrong merged cells)
    // const headerLevels = Object.keys(group.headerRows || {})
    //   .flatMap(key => key.split('-').map(Number))
    //   .filter(Number.isFinite);
    // if (headerLevels.length) {
    //   const headerBottom = Math.min(...headerLevels);
    //   lines.forEach(line => {
    //     if (line.baseline >= headerBottom - 0.5) {
    //       line.endsWithLeader = false;
    //       line.isData = false;
    //     }
    //   });
    // }

    // 2. Runs of consecutive data lines; a run matters only if it holds a leader line.
    const chainHasLeader: boolean[] = [];
    let chainId = -1;
    lines.forEach((line, index) => {
        const previous = lines[index - 1];
        const gap = previous ? previous.bottom - line.top : Infinity;
        const continues =
            !!previous &&
            previous.isData &&
            line.isData &&
            gap <= Math.max(previous.height, line.height) * 2;

        if (!continues) {
            chainId++;
            chainHasLeader[chainId] = false;
        }
        line.chain = chainId;
        if (line.endsWithLeader) {
            chainHasLeader[chainId] = true;
        }
    });

    // 3. Boundaries between neighbouring lines.
    const rows: number[] = [...group.rows].sort((a, b) => a - b);
    const boundaries = new Map<string, { y: number; x1: number; x2: number }>();
    const synthesized: number[] = [];

    for (let index = 0; index < lines.length - 1; index++) {
        const upper = lines[index];
        const lower = lines[index + 1];

        const splitsAfterLeader = upper.endsWithLeader;
        const splitsDataLines =
            upper.isData &&
            lower.isData &&
            upper.chain === lower.chain &&
            chainHasLeader[upper.chain];
        if (!splitsAfterLeader && !splitsDataLines) {
            continue;
        }

        // Existing row boundaries between the two lines.
        const slack = upper.height * 0.25;
        let separators = rows.filter(y => y < upper.bottom - 0.01 && y > lower.top - slack);

        if (!separators.length) {
            if (upper.bottom - lower.bottom < 1) {
                continue;
            }
            // Lines of a compact table (pitch ≈ font size) have almost no gap between them.
            const gap = upper.bottom - lower.top;
            const y =
                gap >= 0.2
                    ? (upper.bottom + lower.top) / 2
                    : upper.bottom - (upper.bottom - lower.bottom) * 0.3;
            synthesized.push(y);
            separators = [y];
        }

        const x1 = Math.min(upper.x1, lower.x1);
        const x2 = Math.max(upper.x2, lower.x2);
        separators.forEach(y => boundaries.set(y.toFixed(2), { y, x1, x2 }));
    }

    const result = [...boundaries.values()];
    if (!result.length) {
        return group;
    }

    if (synthesized.length) {
        group.rows = addToGridList(group.rows, synthesized);//old:[...new Set([...group.rows, ...synthesized])].sort((a, b) => a - b);
        group.synthesizedRows = [...(group.synthesizedRows || []), ...synthesized];
        group.y = [
            Math.min(...(group.y || []), ...synthesized),
            Math.max(...(group.y || []), ...synthesized)
        ];
        group.headerRows = determineHeaderRows({
            coordinates: group.coordinates || [],
            edges: group.edges || [],
            rectangles: group.rectangles || [],
            rows: [...group.rows],
            cols: group.cols || [],
            lineMaxWidth,
            separatorRows: group.synthesizedRows
        });
    }

    group.leaderBoundaries = result;

    return group;
}

// A ruled frame is a run of long horizontal rules that belong to one table: neighbouring
// rules that are bridged by a vertical rule. A frame with at least one bridge is "proven".
// Rules that are not connected belong to different tables.
export function detectRuleFrames(
    pageEdges: any[]
): Array<{ top: number; bottom: number; proven: boolean }> {
    const axisTolerance = 1.5;
    const lineMaxWidth = LINE_MAX_WIDTH;
    const visible = (pageEdges || []).filter(
        edge => isVisibleVector(edge) && !edge['_isFakeLine']
    );
    const horizontals = visible.filter(
        edge => edge.height < lineMaxWidth && edge.width > lineMaxWidth
    );
    const verticals = visible.filter(
        edge => edge.width < lineMaxWidth && edge.height > lineMaxWidth
    );
    if (horizontals.length < 2 || !verticals.length) {
        return [];
    }

    // All segments lying on one axis form one rule.
    const rules: Array<{ y: number; left: number; right: number; covered: number }> = [];
    horizontals.forEach(edge => {
        const y = edge.y + edge.height / 2;
        let rule = rules.find(candidate => Math.abs(candidate.y - y) <= axisTolerance);
        if (!rule) {
            rule = { y, left: edge.x, right: edge.x + edge.width, covered: 0 };
            rules.push(rule);
        }
        rule.left = Math.min(rule.left, edge.x);
        rule.right = Math.max(rule.right, edge.x + edge.width);
        rule.covered += edge.width;
    });

    const widest = Math.max(...rules.map(rule => rule.right - rule.left));
    const longRules = rules
        .filter(rule => {
            const extent = rule.right - rule.left;
            return extent >= widest * 0.5 && Math.min(1, rule.covered / extent) >= 0.8;
        })
        .sort((a, b) => b.y - a.y);
    if (longRules.length < 2) {
        return [];
    }

    // Does a vertical rule run (almost) all the way between two horizontal rules?
    const isBridged = (upper: number, lower: number, left: number, right: number): boolean => {
        const gap = upper - lower;
        const lines: Array<{ x: number; intervals: Array<[number, number]> }> = [];
        verticals.forEach(edge => {
            const x = edge.x + edge.width / 2;
            const from = Math.max(edge.y, lower);
            const to = Math.min(edge.y + edge.height, upper);
            if (!(to > from) || x < left - axisTolerance || x > right + axisTolerance) {
                return;
            }
            let line = lines.find(candidate => Math.abs(candidate.x - x) <= axisTolerance);
            if (!line) {
                line = { x, intervals: [] };
                lines.push(line);
            }
            line.intervals.push([from, to]);
        });
        return lines.some(line => getCoveredLength(line.intervals) >= gap * 0.8);
    };

    const frames: Array<{ top: number; bottom: number; proven: boolean }> = [];
    let frame = {
        top: longRules[0].y,
        bottom: longRules[0].y,
        left: longRules[0].left,
        right: longRules[0].right,
        proven: false
    };

    for (let index = 1; index < longRules.length; index++) {
        const rule = longRules[index];
        const left = Math.min(frame.left, rule.left);
        const right = Math.max(frame.right, rule.right);
        const bridged = isBridged(frame.bottom, rule.y, left, right);
        const adjacent = frame.bottom - rule.y <= 3;

        if (bridged || adjacent) {
            frame.bottom = rule.y;
            frame.left = left;
            frame.right = right;
            frame.proven = frame.proven || bridged;
        } else {
            if (frame.top > frame.bottom) frames.push(frame);
            frame = { top: rule.y, bottom: rule.y, left: rule.left, right: rule.right, proven: false };
        }
    }
    if (frame.top > frame.bottom) frames.push(frame);

    return frames;
}

// Bands between two proven frames: titles, headnotes, footnotes. They are not a table.
export function getGapBandsBetweenRuledTables(
    pageEdges: any[]
): Array<{ top: number; bottom: number }> {
    const frames = detectRuleFrames(pageEdges).filter(frame => frame.proven);
    const bands: Array<{ top: number; bottom: number }> = [];
    for (let index = 1; index < frames.length; index++) {
        bands.push({ top: frames[index - 1].bottom, bottom: frames[index].top });
    }
    return bands;
}