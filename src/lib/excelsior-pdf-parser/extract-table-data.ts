import { checkRectangleRanges, deepSet, findMod, isSequentialIndexRow, uniqueArr } from "@unsonet/js-utils";
import { isFillBandRemnant, isVisibleVector } from "./pdf-vector-utils";
import { LEADER_TRAILING_RUN } from "../constants";
import { isBorderAbsorbedByFills } from "./pdf-operator-utils";

export function extractTableData(options) {
    let { verticles, horizons, coordinates, merges = {}, mergeAlias = {}, headerRows = {}, edges, tableGroup, pageGroup, lineMaxWidth, rectangles = [] } = options;
    // Sorting by requirements
    verticles = verticles.sort((a, b) => a.x - b.x);
    horizons = horizons.sort((a, b) => b.y - a.y); // Inverted y-axis
    // One visual line: baseline values within the margin of error (112.974 vs. 112.975).
    const SAME_BASELINE_TOLERANCE = 0.25;

    const sortedByY = [...coordinates].sort((a, b) => b.y - a.y);
    const visualLines: any[][] = [];

    for (const item of sortedByY) {
        const currentLine = visualLines[visualLines.length - 1];
        if (currentLine && Math.abs(currentLine[0].y - item.y) <= SAME_BASELINE_TOLERANCE) {
            currentLine.push(item);
        } else {
            visualLines.push([item]);
        }
    }

    coordinates = visualLines.flatMap(line => line.sort((a, b) => a.x - b.x));

    // Superscripts: a small raised block glued to the right edge of a bigger block
    // ("24.91" + raised "2"). It belongs to the same cell and must follow the host
    // text instead of being placed before it (which gives "224.91").
    const normalTextHeight = +findMod(coordinates.map(item => item.height)) || 0;
    const superscriptBlocks = new Set<any>();
    const superscriptsByHost = new Map<any, any[]>();

    if (normalTextHeight > 0) {
        coordinates.forEach(candidate => {
            if (!candidate?.str?.trim() || !(candidate.height < normalTextHeight * 0.75)) {
                return;
            }

            const gapLimit = Math.max(candidate.height * 0.75, 1);

            const host = coordinates.find(other => {
                if (other === candidate || !other?.str?.trim()) {
                    return false;
                }

                if (!(other.height >= candidate.height * 1.25)) {
                    return false;
                }

                const raised = candidate.y - other.y;
                const hostRight = other.x + other.width;

                return raised > 0.5
                    && raised <= other.height * 0.7
                    && Math.abs(candidate.x - hostRight) <= gapLimit;
            });

            if (host) {
                superscriptBlocks.add(candidate);
                superscriptsByHost.set(host, [...(superscriptsByHost.get(host) || []), candidate]);
            }
        });
    }

    const rowsCount = horizons.length - 1;
    const colsCount = verticles.length - 1;
    const table = {
        array: Array.from({ length: rowsCount }, () => [...Array(colsCount)].map(i => ({ str: "" }))),
        html: null,
        json: null,
    }
    const tablePos = Array.from({ length: rowsCount }, () => Array(colsCount).fill(null));
    // Columns where text PHYSICALLY lies. The text of a merged cell is stored in the merge root,
    // which may be a narrow pad column; that must not keep the pad column visible.
    const physicalTextColumns = new Set<number>();

    // ===== DIAGNOSTICS: try-catch with precise location =====
    try {
        const tableTop = horizons[0].y;
        const tableBottom = horizons[horizons.length - 1].y;
        const isInsideTableVertically = (value: number) => value <= tableTop && value > tableBottom;
        for (const item of coordinates) {
            if (superscriptBlocks.has(item)) {
                continue;
            }
            const y = item.transform[5];
            // A block can start with a whitespace glyph standing far left of the first letter
            // (" Total": the space is at x=501.6, the word at x=535.2). Place the block by the
            // left edge of its VISIBLE text, otherwise it falls into the previous column.
            const transform = item.transform;
            const isHorizontal =
                Math.abs(transform[1]) <= Math.abs(transform[0]) * 0.2 &&
                Math.abs(transform[2]) <= Math.abs(transform[3]) * 0.2;
            const visibleGlyphXs = isHorizontal
                ? (item.chars || [])
                    .filter(
                        (glyph: any) =>
                            glyph &&
                            typeof glyph === 'object' &&
                            typeof glyph.unicode === 'string' &&
                            glyph.unicode.trim() &&
                            Number.isFinite(glyph.x),
                    )
                    .map((glyph: any) => glyph.x)
                : [];
            const x = visibleGlyphXs.length ? Math.min(...visibleGlyphXs) : transform[4];
            // Looking for the column
            // Column boundaries are averaged values of several actual lines and may be
            // shifted by ~1pt from the actual line. Text that starts slightly to the left of the border
            // (zero padding; for example, a caption in a 46.6-point box with a 47.5-point border)
            // is assigned to the right-hand column. Set this to 0 to disable it.
            const columnSnapTolerance = 1.5;

            let col = -1;
            for (let i = 0; i < verticles.length - 1; i++) {
                if (x >= verticles[i].x && x < verticles[i + 1].x) {
                    const hasNextColumn = i + 1 < verticles.length - 1;
                    const isJustBeforeNextBorder = verticles[i + 1].x - x <= columnSnapTolerance;

                    col = hasNextColumn && isJustBeforeNextBorder ? i + 1 : i;
                    break;
                }
            }

            // Fallback: the text origin is outside the grid, but most of its
            // horizontal extent belongs to a column.
            if (col === -1 && Number.isFinite(x)) {
                const itemWidth = Number(item?.width);

                if (Number.isFinite(itemWidth) && itemWidth > 0) {
                    const itemLeft = Math.min(x, x + itemWidth);
                    const itemRight = Math.max(x, x + itemWidth);
                    const itemExtent = itemRight - itemLeft;

                    let bestCol = -1;
                    let bestOverlap = 0;

                    for (let i = 0; i < verticles.length - 1; i++) {
                        const overlap = Math.max(
                            0,
                            Math.min(itemRight, verticles[i + 1].x) -
                            Math.max(itemLeft, verticles[i].x)
                        );

                        if (overlap > bestOverlap) {
                            bestOverlap = overlap;
                            bestCol = i;
                        }
                    }

                    // Require most of the text extent to belong to one column.
                    if (bestCol !== -1 && bestOverlap / itemExtent >= 0.5) {
                        col = bestCol;
                    }
                }
            }

            if (col === -1) {
                continue;
            }

            // Looking for the row
            let row = -1;

            const lastRowIndex = horizons.length - 2;
            const lastRowBottomTolerance = 0.5;

            for (let i = 0; i < horizons.length - 1; i++) {
                const bottomBoundary = horizons[i + 1].y;

                const lowerLimit = i === lastRowIndex
                    ? bottomBoundary - lastRowBottomTolerance
                    : bottomBoundary;

                if (y <= horizons[i].y && y > lowerLimit) {
                    row = i;
                    break;
                }
            }
            if (row === -1) {
                continue;
            }

            // Follow alias chains to the visible root cell, so that text is never
            // stored in a hidden alias cell.
            physicalTextColumns.add(col);
            let aliasCellKey = `${row}-${col}`;
            for (let guard = 0; mergeAlias[aliasCellKey] && guard < 32; guard++) {
                aliasCellKey = mergeAlias[aliasCellKey];
            }
            const rootMatch = /^(-?\d+)-(-?\d+)$/.exec(aliasCellKey);
            if (rootMatch) {
                row = Number(rootMatch[1]);
                col = Number(rootMatch[2]);
            }

            // Protection from going abroad
            if (row < 0 || row >= rowsCount || col < 0 || col >= colsCount || !table.array[row] || !table.array[row][col]) {
                continue;
            }

            // Add text to the table
            const cell = table.array[row][col];
            const previousY = tablePos[row][col];
            if (previousY !== null && Math.abs(previousY - y) > 5) {
                cell['str'] += '\n';
            } else if (
                previousY !== null &&
                cell['str'] &&
                !/\s$/.test(cell['str']) &&
                !/^\s/.test(item?.str || '')
            ) {
                // two separate blocks on one line in one cell: keep them apart
                cell['str'] += ' ';
            }
            tablePos[row][col] = y;
            cell['str'] += item?.str || '';


            const attachedSuperscripts = superscriptsByHost.get(item);

            if (attachedSuperscripts?.length) {
                const cell = table.array[row][col];

                attachedSuperscripts.forEach(superscript => {
                    const start = cell['str'].length;

                    cell['str'] += (superscript?.str || '').trim();
                    (cell['sup'] = cell['sup'] || []).push([start, cell['str'].length]);
                });
            }
            if (item.fillColor) {
                table.array[row][col]['fillColor'] = item.fillColor;
            }
            if (item.textColor) {
                table.array[row][col]['textColor'] = item.textColor;
            }

            // Fallback for cell fill color:
            // when the coordinate itself has no fillColor,
            // find the rectangle matching the actual cell boundaries.
            if (table.array[row][col]['fillColor'] == null) {
                const mergeKey = `${row}-${col}`;
                const mergeInfo = merges[mergeKey];

                const rowSpan = mergeInfo?.height || 1;
                const colSpan = mergeInfo?.width || 1;

                const left = verticles[col]?.x;
                const right = verticles[col + colSpan]?.x;
                const top = horizons[row]?.y;
                const bottom = horizons[row + rowSpan]?.y;

                if (
                    Number.isFinite(left) &&
                    Number.isFinite(right) &&
                    Number.isFinite(top) &&
                    Number.isFinite(bottom)
                ) {
                    const cellX1 = Math.min(left, right);
                    const cellX2 = Math.max(left, right);
                    const cellY1 = Math.min(top, bottom);
                    const cellY2 = Math.max(top, bottom);

                    const tolerance = Math.max(
                        1,
                        tableGroup?.borderSize || 0.57
                    );

                    const cellArea =
                        (cellX2 - cellX1) * (cellY2 - cellY1);

                    const fillRectangle = (rectangles || [])
                        .map(rectangle => {
                            const fillColor =
                                rectangle?.fillColor ??
                                (Array.isArray(rectangle?.fillRGBColor)
                                    ? `rgb(${rectangle.fillRGBColor.join(',')})`
                                    : null);

                            if (!fillColor) {
                                return null;
                            }

                            const x1 = Number(rectangle?.x ?? rectangle?.transform?.[4]);
                            const y1 = Number(rectangle?.y ?? rectangle?.transform?.[5]);
                            const width = Math.abs(Number(rectangle?.width) || 0);
                            const height = Math.abs(Number(rectangle?.height) || 0);

                            if (
                                !Number.isFinite(x1) ||
                                !Number.isFinite(y1) ||
                                width <= 0 ||
                                height <= 0 ||
                                cellArea <= 0
                            ) {
                                return null;
                            }

                            const overlapWidth = Math.max(
                                0,
                                Math.min(cellX2, x1 + width) - Math.max(cellX1, x1)
                            );

                            const overlapHeight = Math.max(
                                0,
                                Math.min(cellY2, y1 + height) - Math.max(cellY1, y1)
                            );

                            const coverage =
                                overlapWidth * overlapHeight / cellArea;

                            return { fillColor, coverage };
                        })
                        .filter(
                            (candidate): candidate is {
                                fillColor: string;
                                coverage: number;
                            } => candidate !== null && candidate.coverage >= 0.75
                        )
                        .sort((a, b) => b.coverage - a.coverage)[0];



                    if (fillRectangle) {
                        table.array[row][col]['fillColor'] = //old:fillRectangle.fillColor;
                            fillRectangle.fillColor ??
                            (
                                Array.isArray(fillRectangle.fillRGBColor)
                                    ? `rgb(${fillRectangle.fillRGBColor.join(',')})`
                                    : null
                            );
                    }
                }
            }

        }
    } catch (err) {
        throw err;
    }

    // A cell without its own fill inherits the fill of the rectangle
    // that completely encloses it (header background: fill + stroke path).
    {
        const filledRectangles = tableGroup?.filledRectangles || [];
        const containTolerance = lineMaxWidth / 2;

        if (filledRectangles.length) {
            for (let r = 0; r < rowsCount; r++) {
                for (let c = 0; c < colsCount; c++) {
                    const key = `${r}-${c}`;
                    if (mergeAlias[key]) {
                        continue;
                    }

                    const cell = table.array[r]?.[c];
                    if (!cell || cell['fillColor'] != null) {
                        continue;
                    }

                    const mergeInfo = merges[key];
                    const rowSpan = mergeInfo?.height || 1;
                    const colSpan = mergeInfo?.width || 1;

                    const left = verticles[c]?.x;
                    const right = verticles[c + colSpan]?.x;
                    const top = horizons[r]?.y;
                    const bottom = horizons[r + rowSpan]?.y;

                    if (![left, right, top, bottom].every(Number.isFinite)) {
                        continue;
                    }

                    const cellX1 = Math.min(left, right);
                    const cellX2 = Math.max(left, right);
                    const cellY1 = Math.min(top, bottom);
                    const cellY2 = Math.max(top, bottom);

                    // The last rectangle drawn (the top one) wins
                    let container = null;
                    for (const rect of filledRectangles) {
                        const isInside =
                            cellX1 >= rect.x - containTolerance &&
                            cellX2 <= rect.x + rect.width + containTolerance &&
                            cellY1 >= rect.y - containTolerance &&
                            cellY2 <= rect.y + rect.height + containTolerance;

                        if (isInside) {
                            container = rect;
                        }
                    }

                    if (container) {
                        cell['fillColor'] = container.fillColor;
                    }
                }
            }
        }
    }

    // Cells without a text based fill: empty cells and cells whose text sticks out of the
    // filled rectangle (computed from the page rectangles in the first pass)
    const cellFills = tableGroup?.cellFills || {};

    for (let r = 0; r < rowsCount; r++) {
        for (let c = 0; c < colsCount; c++) {
            const cell = table.array[r]?.[c];
            const fill = cellFills[`${r}-${c}`];

            if (cell && cell['fillColor'] == null && fill) {
                cell['fillColor'] = fill;
            }
        }
    }

    // We consider only the sequence of ranges starting at the top of the table to be headers.
    // False “headers” in the middle of the table should not cause the first N rows to be converted to <th>.
    const topHeaderRowCount = (() => {
        const tolerance = lineMaxWidth;

        // Grouped ("47,824,589") or decimal ("12.5") numbers: a row mostly made of them is data.
        const isNumericLike = (text: string) =>
            /^[-+]?\d{1,3}(?:[,\s]\d{3})+(?:\.\d+)?$|^[-+]?\d+[.,]\d+$/.test(text.trim());
        const isDataRow = (blocks: any[]) => {
            const texts = (blocks || [])
                .map(block => String(block?.str || '').trim())
                .filter(Boolean);
            return texts.length > 0 && texts.filter(isNumericLike).length * 2 > texts.length;
        };

        const ranges = Object.keys(headerRows)
            .map(key => {
                const match = /^(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)$/.exec(key);
                if (!match) {
                    return null;
                }
                const first = Number(match[1]);
                const second = Number(match[2]);
                return {
                    top: Math.max(first, second),
                    bottom: Math.min(first, second),
                    blocks: headerRows[key],
                };
            })
            .filter(Boolean)
            .sort((a, b) => b.top - a.top);

        let chainEdge = horizons[0]?.y;
        let count = 0;
        for (const range of ranges) {
            if (!Number.isFinite(chainEdge) || Math.abs(range.top - chainEdge) > tolerance) {
                break;
            }
            if (isDataRow(range.blocks)) {
                break;
            }
            chainEdge = range.bottom;
            count++;
        }

        // `count` is the number of header RANGES, measured on group rows. The grid can have fewer
        // rows than that: horizon clustering merges boundaries closer than lineMaxWidth.
        // Never report more header rows than the grid rows that start above the end of the chain.
        const gridRowsInChain = horizons
            .slice(0, -1)
            .filter((horizon: any) => horizon.y > chainEdge + tolerance).length;

        return Math.min(count, gridRowsInChain);
    })();

    const COLLAPSE_GUTTER_COLUMNS = true;
    const modalTextHeight = +findMod(coordinates.map(item => item.height)) || 0;
    const gutterColumns = new Set<number>();
    if (COLLAPSE_GUTTER_COLUMNS && modalTextHeight > 0) {
        for (let c = 1; c < colsCount - 1; c++) {
            const width = verticles[c + 1].x - verticles[c].x;
            const isEmpty = !physicalTextColumns.has(c); //old:table.array.every(row => !(row[c]?.str || '').trim());
            // Without any rules or fills an empty column is only an artefact of the column borders.
            const isTextOnlyTable =
                !(tableGroup?.edgesRows || []).length && !(tableGroup?.rectanglesRows || []).length;

            if (isEmpty && (width <= modalTextHeight * 1.2 || isTextOnlyTable)) {
                gutterColumns.add(c);
            }
        }
    }

    // Generate HTML table
    table.html = (() => {
        try {
            const headerRowCount = topHeaderRowCount; //Object.keys(headerRows).length;

            const bandRectangles = uniqueArr(
                [...(tableGroup?.rectangles || []), ...(pageGroup?.rectangles || [])].filter(
                    (rect: any) => rect?.fillColor && isVisibleVector(rect) && rect.width > 0 && rect.height > 0
                ),
                ['x', 'y', 'width', 'height']
            );
            const isBorderCarrier = (item: any): boolean =>
                isVisibleVector(item) && !item['_isFakeLine'] && !isFillBandRemnant(item, bandRectangles);

            // --- EDGES LOGIC ---

            // We collect ALL visible real lines: group + page lines (in case of a split)
            let groupEdges = [
                ...(edges || []),
                ...(tableGroup?.rectanglesEdges || [])
            ].filter(isBorderCarrier);

            // Bounding box of the current table — protection from neighboring tables/graphs
            let tableBBox = {
                x: [Math.min(...tableGroup.cols), Math.max(...tableGroup.cols)],
                y: [Math.min(...tableGroup.rows), Math.max(...tableGroup.rows)]
            };

            // Fallback lines from the page, but only those that intersect with this table
            let pageEdgesFiltered = [];
            if (pageGroup) {
                let candidates = [
                    ...(pageGroup.edges || []),
                    ...(pageGroup.rectanglesEdges || [])
                ].filter(isBorderCarrier);

                pageEdgesFiltered = candidates.filter(item => {
                    let res: any = checkRectangleRanges(
                        item,
                        tableBBox,
                        { axis: ['x', 'y'], strict: false, strictIntersecting: true }
                    );
                    return res.isIntersecting;
                });
            }

            let allEdges = uniqueArr([...groupEdges, ...pageEdgesFiltered], ['x', 'y', 'width', 'height']);
            let hasAnyBorders = groupEdges.length > 0 || pageEdgesFiltered.length > 0;

            // Thin fill stripes (rendering artifacts over lines, thickness ~0.03)
            // should not be taken into account when selecting the modal table frame color —
            // otherwise, the white “covers” of the cells override the actual border color.
            const minCarrierThickness = 0.1;
            let tableBorderColor = hasAnyBorders ? findMod(
                allEdges
                    .filter(item => Math.min(item.width, item.height) >= minCarrierThickness)
                    .map(item => item.strokeColor || item.fillColor)
                    .filter(Boolean)
            ) : null;

            // Adaptive tolerance: the thinner the real boundaries, the more accurate the matching
            let borderSize = tableGroup?.borderSize || 0.57;
            let tolerance = Math.max(lineMaxWidth * 2, borderSize * 4, 2);

            const THIN_EDGE_THICKNESS = 0.3; // тот же порог, что и в collectBorderColors
            const thinEdgeTolerance = Math.max(borderSize * 3, 1.5);

            const horizontalAxes: number[] = horizons.map((horizon: any) => horizon.y);
            const verticalAxes: number[] = verticles.map((vertical: any) => vertical.x);

            // An edge refers only to the nearest grid line. Otherwise, for lines that are closer to each other
            // than the tolerance, a single edge would fall on two boundaries at once.
            function isNearestGridAxis(edgeAxis: number, lineAxis: number, axes: number[]): boolean {
                const distance = Math.abs(edgeAxis - lineAxis);
                return axes.every((axis: number) => Math.abs(edgeAxis - axis) >= distance - 1e-6);
            }
            const borderAxisTolerance = Math.max(
                1.5,
                Math.min(borderSize * 3, 2)
            );



            const LINE_PATTERN_MIN_COVERAGE = 0.75;
            const borderCandidatesCache: Record<string, Array<[string, number]>> = {};

            // Colours of visible rules lying on an ideal segment, ordered by covered length.
            function collectBorderColors(
                idealLine: any,
                pool: any[],
                isHorizontalIdeal: boolean,
                idealLength: number
            ): Array<[string, number]> {
                const overlapByColor: Record<string, number> = {};

                // A line that merely touches a segment with its edge (0.24pt from the adjacent column) is not considered its boundary.
                // The threshold is applied to each line separately: the sum of multiple touches exceeded it
                const minimalOverlap = Math.min(idealLength * 0.05, 1);

                for (const edge of pool) {
                    const edgeColor = edge.isLinePath ? edge.strokeColor : edge.strokeColor || edge.fillColor;
                    if (!edgeColor) continue;

                    const isHorizontalEdge = edge.height < lineMaxWidth && edge.width > lineMaxWidth;
                    const isVerticalEdge = edge.width < lineMaxWidth && edge.height > lineMaxWidth;
                    if (isHorizontalIdeal ? !isHorizontalEdge : !isVerticalEdge) continue;

                    const lineAxis = isHorizontalIdeal ? idealLine.y1 : idealLine.x1;
                    const edgeCenter = isHorizontalIdeal ? edge.y + edge.height / 2 : edge.x + edge.width / 2;
                    const axisMatch =
                        Math.abs((isHorizontalIdeal ? edge.y : edge.x) - lineAxis) <= tolerance &&
                        isNearestGridAxis(edgeCenter, lineAxis, isHorizontalIdeal ? horizontalAxes : verticalAxes);
                    if (!axisMatch) continue;

                    const overlap = isHorizontalIdeal
                        ? Math.min(edge.x + edge.width, Math.max(idealLine.x1, idealLine.x2)) -
                        Math.max(edge.x, Math.min(idealLine.x1, idealLine.x2))
                        : Math.min(edge.y + edge.height, Math.max(idealLine.y1, idealLine.y2)) -
                        Math.max(edge.y, Math.min(idealLine.y1, idealLine.y2));
                    if (!(overlap > 0)) continue;
                    if (overlap < minimalOverlap) continue; // NEW

                    // Zero-thickness fills are artefacts; a stroked hairline is a real rule.
                    const thickness = isHorizontalIdeal ? edge.height : edge.width;
                    const isHairlineStroke = thickness === 0 && !!edge.strokeColor;
                    if (thickness > 0.3 || isHairlineStroke) {
                        overlapByColor[edgeColor] = (overlapByColor[edgeColor] || 0) + overlap;
                    }
                }

                return Object.entries(overlapByColor)
                    .filter(([, overlap]) => overlap >= minimalOverlap)
                    .sort((first, second) => second[1] - first[1]);
            }

            // A rule that only ends next to the segment is not its border: require that
            // it really covers a part of the segment.
            function hasRuleNearSegment(idealLine: any, isHorizontalIdeal: boolean, idealLength: number): boolean {
                let coverage = 0;
                const minimalOverlap = Math.min(idealLength * 0.05, 1);
                allEdges.forEach(edge => {
                    const isHorizontalEdge = edge.height < lineMaxWidth && edge.width > lineMaxWidth;
                    const isVerticalEdge = edge.width < lineMaxWidth && edge.height > lineMaxWidth;
                    if (isHorizontalIdeal ? !isHorizontalEdge : !isVerticalEdge) return;

                    const lineAxis = isHorizontalIdeal ? idealLine.y1 : idealLine.x1;
                    const edgeAxis = isHorizontalIdeal ? edge.y : edge.x;
                    const edgeCenter = isHorizontalIdeal ? edge.y + edge.height / 2 : edge.x + edge.width / 2;
                    const recordedThickness = isHorizontalIdeal ? edge.height : edge.width;

                    // Fill without outline with a thin specified thickness—weak indication of a line:
                    // We accept it only if it lies exactly on the grid line.
                    const allowedOffset = !edge.strokeColor && recordedThickness <= THIN_EDGE_THICKNESS ? thinEdgeTolerance : tolerance;

                    const axisMatch =
                        Math.abs(edgeAxis - lineAxis) <= allowedOffset &&
                        isNearestGridAxis(edgeCenter, lineAxis, isHorizontalIdeal ? horizontalAxes : verticalAxes);

                    if (!axisMatch) return;


                    const from = isHorizontalIdeal ? Math.min(idealLine.x1, idealLine.x2) : Math.min(idealLine.y1, idealLine.y2);
                    const to = isHorizontalIdeal ? Math.max(idealLine.x1, idealLine.x2) : Math.max(idealLine.y1, idealLine.y2);
                    const start = isHorizontalIdeal ? edge.x : edge.y;
                    const end = start + (isHorizontalIdeal ? edge.width : edge.height);

                    const overlap = Math.max(0, Math.min(end, to) - Math.max(start, from));
                    if (overlap >= minimalOverlap) {
                        coverage += overlap;
                    }
                });
                return coverage >= idealLength * 0.25;
            }

            function explainSegment(idealLine: any, isHorizontalIdeal: boolean) {
                return allEdges
                    .filter(edge => {
                        const isHorizontalEdge = edge.height < lineMaxWidth && edge.width > lineMaxWidth;
                        const isVerticalEdge = edge.width < lineMaxWidth && edge.height > lineMaxWidth;
                        if (isHorizontalIdeal ? !isHorizontalEdge : !isVerticalEdge) return false;

                        const offset = isHorizontalIdeal ? Math.abs(edge.y - idealLine.y1) : Math.abs(edge.x - idealLine.x1);
                        return offset <= tolerance;
                    })
                    .map(edge => ({
                        axisOffset: +(isHorizontalIdeal ? Math.abs(edge.y - idealLine.y1) : Math.abs(edge.x - idealLine.x1)).toFixed(2),
                        from: +(isHorizontalIdeal ? edge.x : edge.y).toFixed(2),
                        length: +(isHorizontalIdeal ? edge.width : edge.height).toFixed(2),
                        thickness: +(isHorizontalIdeal ? edge.height : edge.width).toFixed(2),
                        color: edge.strokeColor || edge.fillColor || null,
                    }));
            }

            function getSegmentColorCandidates(idealLine: any, isHorizontalIdeal: boolean): Array<[string, number]> {
                const cacheKey = `${isHorizontalIdeal ? 'h' : 'v'}:${idealLine.x1.toFixed(2)},${idealLine.y1.toFixed(2)},${idealLine.x2.toFixed(2)},${idealLine.y2.toFixed(2)}`;
                if (borderCandidatesCache[cacheKey]) {
                    return borderCandidatesCache[cacheKey];
                }

                const idealLength = isHorizontalIdeal
                    ? Math.abs(idealLine.x2 - idealLine.x1)
                    : Math.abs(idealLine.y2 - idealLine.y1);
                let candidates: Array<[string, number]> = [];

                if (idealLength > 0) {
                    candidates = collectBorderColors(idealLine, groupEdges, isHorizontalIdeal, idealLength);
                    if (!candidates.length && pageEdgesFiltered.length > 0) {
                        candidates = collectBorderColors(idealLine, pageEdgesFiltered, isHorizontalIdeal, idealLength);
                    }
                    if (
                        !candidates.length &&
                        hasAnyBorders &&
                        tableBorderColor &&
                        hasRuleNearSegment(idealLine, isHorizontalIdeal, idealLength)
                    ) {
                        candidates = [[tableBorderColor, idealLength]];
                    }
                }

                borderCandidatesCache[cacheKey] = candidates;
                return candidates;
            }

            // Fill of a grid cell (merged cells resolve to their root).
            // Outside the table, and cells without fill, are the page itself.
            function getCellFillAt(row: number, col: number): string | null {
                if (row < 0 || col < 0 || row >= rowsCount || col >= colsCount) {
                    return null;
                }
                const rootKey = mergeAlias[`${row}-${col}`] || `${row}-${col}`;
                const [rootRow, rootCol] = rootKey.split('-').map(Number);
                return table.array[rootRow]?.[rootCol]?.['fillColor'] ?? null;
            }

            // One colour per slot of a grid line. A slot is the stretch of the line
            // between two neighbouring cells; the fills of both are known.
            function planGridLine(isHorizontalLine: boolean, lineIndex: number): Array<string | null> {
                const axis = isHorizontalLine ? horizons[lineIndex].y : verticles[lineIndex].x;
                const slots: Array<{ from: number; to: number; fills: Array<string | null> }> = [];

                if (isHorizontalLine) {
                    for (let col = 0; col < colsCount; col++) {
                        const centerX = (verticles[col].x + verticles[col + 1].x) / 2;
                        slots.push({
                            from: verticles[col].x,
                            to: verticles[col + 1].x,
                            fills: [
                                ...getSideFills(
                                    lineIndex - 1,
                                    col,
                                    centerX,
                                    axis + outsideProbeOffset,
                                    true,
                                    axis
                                ),
                                ...getSideFills(
                                    lineIndex,
                                    col,
                                    centerX,
                                    axis - outsideProbeOffset,
                                    true,
                                    axis
                                )
                            ]
                        });
                    }
                } else {
                    for (let row = 0; row < rowsCount; row++) {
                        const centerY = (horizons[row].y + horizons[row + 1].y) / 2;
                        slots.push({
                            from: horizons[row + 1].y,
                            to: horizons[row].y,
                            fills: [
                                ...getSideFills(
                                    row,
                                    lineIndex - 1,
                                    axis - outsideProbeOffset,
                                    centerY,
                                    false,
                                    axis
                                ),
                                ...getSideFills(
                                    row,
                                    lineIndex,
                                    axis + outsideProbeOffset,
                                    centerY,
                                    false,
                                    axis
                                )
                            ]
                        });
                    }
                }

                // A genuine border is the first candidate colour that is not just the
                // edge of a neighbouring fill.

                const genuine = slots.map(slot => {
                    const idealLine = isHorizontalLine
                        ? { x1: slot.from, y1: axis, x2: slot.to, y2: axis }
                        : { x1: axis, y1: slot.from, x2: axis, y2: slot.to };

                    const candidates = getSegmentColorCandidates(idealLine, isHorizontalLine).filter(
                        ([color]) => !isBorderAbsorbedByFills(color, slot.fills),
                    );

                    // A color that matches the fill of one of the adjacent cells is the edge of that fill itself
                    // (legend below the table), not the table border; it is used only if there are no other candidates
                    const ownBorder = candidates.find(([color]) => !slot.fills.some(fill => fill && fill === color));
                    const candidate = ownBorder || candidates[0];

                    return candidate ? candidate[0] : null;
                });

                const lengthOf = (slot: { from: number; to: number }) => Math.max(0, slot.to - slot.from);
                const totalLength = slots.reduce((sum, slot) => sum + lengthOf(slot), 0);
                const weights: Record<string, number> = {};
                genuine.forEach((color, index) => {
                    if (color) weights[color] = (weights[color] || 0) + lengthOf(slots[index]);
                });
                const coveredLength = Object.values(weights).reduce((sum, value) => sum + value, 0);

                if (coveredLength === 0) {
                    return genuine;
                }
                // The line clearly has a rule: bridge holes in the middle of it, so that cells that lost
                // their share of the rule do not produce 1px shifts. The line is never extended beyond
                // its first and last genuine segment: a boundary that is absent at the end of a line
                // (e.g. in the last row of a table) is really absent.
                if (coveredLength >= totalLength * LINE_PATTERN_MIN_COVERAGE) {//!BUGFIX row_span.pdf footer border-color
                    const dominant = Object.entries(weights).sort((a, b) => b[1] - a[1])[0][0];
                    const firstGenuine = genuine.findIndex(color => color !== null);
                    const lastGenuine =
                        genuine.length - 1 - [...genuine].reverse().findIndex(color => color !== null);

                    return genuine.map((color, index) =>
                        color !== null
                            ? color
                            : index > firstGenuine && index < lastGenuine
                                ? dominant
                                : null
                    );
                }

                return genuine;
            }

            function pickSideColor(colors: Array<string | null>): string | null {
                if (!colors?.length) {
                    return null;
                }
                const weights: Record<string, number> = {};
                colors.forEach(color => {
                    if (color) weights[color] = (weights[color] || 0) + 1;
                });
                const best = Object.entries(weights).sort((a, b) => b[1] - a[1])[0];
                return best ? best[0] : null;
            }

            // Filled rectangles that lie right beyond the table (a footer, a title band, ...).
            // They were cut off from the table, but their outline is painted in their fill colour
            // and must not become the colour of the table border.
            const outsideFillRects = (pageGroup?.rectangles || []).filter(
                (rect: any) => rect?.fillColor && Number(rect.width) > 0 && Number(rect.height) > 0
            );
            const outsideProbeOffset = Math.max((tableGroup?.borderSize || 0.57) * 3, 2);

            function getFillsAtPoint(
                x: number,
                y: number,
                isHorizontalLine: boolean,
                axis: number
            ): Array<string | null> {
                // The direction of the outer side relative to the line.
                const side = Math.sign((isHorizontalLine ? y : x) - axis);

                if (!side) {
                    return [null];
                }

                // A fill can adjoin a line within the thickness of its outline.
                // This has nothing to do with the distance by which the probe point is offset.
                const fillContactTolerance = Math.max(
                    Number(tableGroup?.borderSize) || 0.57,
                    0.5
                );

                const along = isHorizontalLine ? x : y;

                const fills = outsideFillRects
                    .filter((rect: any) => {
                        if (!rect?.fillColor) {
                            return false;
                        }

                        const rectAlongStart = isHorizontalLine
                            ? Math.min(rect.x, rect.x + rect.width)
                            : Math.min(rect.y, rect.y + rect.height);

                        const rectAlongEnd = isHorizontalLine
                            ? Math.max(rect.x, rect.x + rect.width)
                            : Math.max(rect.y, rect.y + rect.height);

                        // The projection of a point on a line must fall within the rectangle.
                        if (along < rectAlongStart || along > rectAlongEnd) {
                            return false;
                        }

                        const rectNormalStart = isHorizontalLine
                            ? Math.min(rect.y, rect.y + rect.height)
                            : Math.min(rect.x, rect.x + rect.width);

                        const rectNormalEnd = isHorizontalLine
                            ? Math.max(rect.y, rect.y + rect.height)
                            : Math.max(rect.x, rect.x + rect.width);

                        // The rectangle must be on the correct side of the line
                        // or cross it.
                        const hasAreaOnSide =
                            side > 0
                                ? rectNormalEnd >= axis
                                : rectNormalStart <= axis;

                        if (!hasAreaOnSide) {
                            return false;
                        }

                        // The distance from the line to the nearest edge of the rectangle.
                        // If the rectangle intersects the line, the distance is zero.
                        const distance =
                            side > 0
                                ? Math.max(0, rectNormalStart - axis)
                                : Math.max(0, axis - rectNormalEnd);

                        return distance <= fillContactTolerance;
                    })
                    .map((rect: any) => rect.fillColor as string);

                return fills.length ? fills : [null];
            }

            // Fill(s) of one side of a grid line: the cell inside the table, or whatever
            // is painted at the probe point when the side lies beyond the table.
            function getSideFills(
                row: number,
                col: number,
                probeX: number,
                probeY: number,
                isHorizontalLine: boolean,
                axis: number
            ): Array<string | null> {
                const inside =
                    row >= 0 &&
                    col >= 0 &&
                    row < rowsCount &&
                    col < colsCount;

                return inside
                    ? [getCellFillAt(row, col)]
                    : getFillsAtPoint(probeX, probeY, isHorizontalLine, axis);
            }



            const horizontalPlan = horizons.map((_: any, index: number) => planGridLine(true, index));
            const verticalPlan = verticles.map((_: any, index: number) => planGridLine(false, index));
            // --- END EDGES LOGIC ---

            let html = `<table style="border-collapse:collapse;">` + '\n';
            html += '<thead>\n';

            for (let r = 0; r < table.array.length; r++) {
                if (!table.array[r]) {
                    continue;
                }
                let tagName = r < headerRowCount ? 'th' : 'td';
                if (r === headerRowCount) {
                    html += '</thead>\n<tbody>\n';
                }
                html += `<tr>\n`;

                for (let c = 0; c < table.array[r].length; c++) {
                    const r_c = `${r}-${c}`;
                    if (mergeAlias[r_c]) continue;

                    if (!table.array[r][c]) {
                        continue;
                    }

                    const spanWidth = merges[r_c]?.width || 1;
                    let visibleSpan = spanWidth;
                    for (let k = c; k < c + spanWidth; k++) {
                        if (gutterColumns.has(k)) {
                            visibleSpan--;
                        }
                    }
                    if (visibleSpan <= 0) {
                        continue;
                    }

                    let fillColor = table.array[r][c]['fillColor'];
                    let textColor = table.array[r][c]['textColor'];
                    // Defining the colors of the 4 sides of the cell
                    let cellBorders = { top: null, right: null, bottom: null, left: null };

                    const mergeInfo = merges[r_c];
                    const rowSpan = mergeInfo ? mergeInfo.height : 1;
                    const colSpan = mergeInfo ? mergeInfo.width : 1;

                    cellBorders.top = pickSideColor(horizontalPlan[r]?.slice(c, c + colSpan));
                    cellBorders.bottom = pickSideColor(horizontalPlan[r + rowSpan]?.slice(c, c + colSpan));
                    cellBorders.left = pickSideColor(verticalPlan[c]?.slice(r, r + rowSpan));
                    cellBorders.right = pickSideColor(verticalPlan[c + colSpan]?.slice(r, r + rowSpan));
                    let borderStyle = '';
                    if (cellBorders.top) borderStyle += `border-top: 1px solid ${cellBorders.top};`;
                    if (cellBorders.right) borderStyle += `border-right: 1px solid ${cellBorders.right};`;
                    if (cellBorders.bottom) borderStyle += `border-bottom: 1px solid ${cellBorders.bottom};`;
                    if (cellBorders.left) borderStyle += `border-left: 1px solid ${cellBorders.left};`;

                    if (textColor) {
                        borderStyle += `color: ${textColor};`;
                    }

                    const cellData = table.array[r][c];
                    const lineBreaksToHtml = (text: string) => text.replace(/\n/gim, '<br>');
                    const text = cellData['str'] || ' ';
                    let safeStr = lineBreaksToHtml(text);

                    if (cellData['sup']?.length) {
                        let html = '';
                        let position = 0;

                        cellData['sup'].forEach(([start, end]) => {
                            html += lineBreaksToHtml(text.slice(position, start))
                                + '<sup>' + text.slice(start, end) + '</sup>';
                            position = end;
                        });

                        safeStr = html + lineBreaksToHtml(text.slice(position));
                    }
                    let cell = `<${tagName} style="${borderStyle}${fillColor ? ` background-color: ${fillColor};` : ''}"`;

                    // if (merges[r_c]) {
                    //   if (merges[r_c].width > 1) cell += ` colspan="${merges[r_c].width}"`;
                    //   if (merges[r_c].height > 1) cell += ` rowspan="${merges[r_c].height}"`;
                    // }

                    if (visibleSpan > 1) {
                        cell += ` colspan="${visibleSpan}"`;
                    }
                    if ((merges[r_c]?.height || 1) > 1) {
                        cell += ` rowspan="${merges[r_c].height}"`;
                    }

                    cell += `>${safeStr}</${tagName}>\n`;
                    html += cell;
                }
                html += '</tr>\n';
            }
            html += '</tbody>\n</table>';
            return html;
        } catch (err) {
            throw err;
        }
    })();

    // Generate JSON table
    table.json = (() => {
        try {
            const headerRowCount = topHeaderRowCount;//Object.keys(headerRows).length;
            let headerRowsKeys = Object.keys(tableGroup.headerRows).sort((a: any, b: any) => b - a);
            let clonedArray = JSON.parse(JSON.stringify(table.array));

            // Protected formatHeader
            let formatHeader = (str) => {
                if (str === undefined || str === null) return '';
                return String(str).replace(/\n/gim, ' ').trim();
            };

            // Process merged cells (clones content in merged cells)
            Object.keys(merges).forEach((key) => {
                const { row, col, arr } = merges[key];
                if (!clonedArray[row] || !clonedArray[row][col]) {
                    return;
                }
                const mainContent = clonedArray[row][col]['str'] || '';
                arr.forEach((cellKey) => {
                    const [mergeRow, mergeCol] = cellKey.split("-").map(Number);
                    if (clonedArray[mergeRow] && clonedArray[mergeRow][mergeCol]) {
                        clonedArray[mergeRow][mergeCol]['str'] = mainContent;
                    } else {
                    }
                });
            });

            const PATH_SEP = '>';
            const PATH_SPLIT_RE = /[^>]+/g;

            function generateHeaderPaths(headers) {
                // If no header rows were found at all (headerRowCount === 0),
                // headers[0] does not exist—previously, this would cause the entire
                // extractTableData() function to crash. Instead of crashing, we simply do not construct the
                // header paths; the code below is now capable of handling an empty headerPaths
                // (`!headerPaths[colIndex]`—it won’t crash; it just won’t set
                // a value for that column).
                if (!headers.length || !headers[0]?.length) {
                    return [];
                }

                let paths = [];
                for (let i = 0; i < headers[0].length; i++) {
                    let path = formatHeader(headers[0][i]?.str);
                    for (let j = 1; j < headers.length; j++) {
                        let currentHeader = formatHeader(headers[j][i]?.str);
                        let prevHeader = formatHeader(headers[j - 1][i]?.str);
                        if (currentHeader && currentHeader !== prevHeader) {
                            path += `${PATH_SEP}${currentHeader}`;
                        }
                    }
                    paths.push(path);
                }
                return paths;
            }


            // A numbering row labels the columns for the reader, it must not leak into the keys
            const headerRowsForPaths = clonedArray
                .slice(0, topHeaderRowCount) //.slice(0, headerRowsKeys.length)
                .filter(row => !isSequentialIndexRow(
                    row.map(cell => (cell?.str || '').trim()).filter(Boolean)
                ));

            let headerPaths = generateHeaderPaths(headerRowsForPaths);

            let jsonData = clonedArray.slice(headerRowCount).map((row, rowIdx) => {
                let obj = {};
                row.forEach((col, colIndex) => {
                    if (!headerPaths[colIndex]) {
                        return;
                    }
                    let str = row[colIndex]?.str
                        ?.trim()
                        ?.replace(LEADER_TRAILING_RUN, '') || '';
                    if (str) {
                        deepSet(obj, headerPaths[colIndex], str, {
                            create: true,
                            separator: PATH_SEP,
                            customSplitRegExp: PATH_SPLIT_RE
                        });
                    }
                });
                return obj;
            });
            return jsonData;
        } catch (err) {
            throw err;
        }
    })();

    return {
        table,
        width: colsCount,
        height: rowsCount
    };
}
