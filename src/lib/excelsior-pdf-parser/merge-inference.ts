// A header label that stands in a lower header row, while the cells above it are empty and no
// rule separates them in this column, belongs to one cell spanning the header rows

import { uniqueArr } from "@unsonet/js-utils";
import { isVisibleVector, hasVectorColor } from "./pdf-vector-utils";

// ("Indicators", "Offense charged").
export function inferHeaderRowSpans(options: {
    tableGroup: any;
    verticles: any[];
    horizons: any[];
    merges: Record<string, any>;
    mergeAlias: Record<string, string>;
    lineMaxWidth: number;
}) {
    const { tableGroup, verticles, horizons, merges, mergeAlias, lineMaxWidth } = options;
    const rowsCount = horizons.length - 1;
    const colsCount = verticles.length - 1;
    if (!tableGroup?.headerRows || rowsCount < 2 || colsCount < 1) {
        return;
    }

    // Number of header rows at the top of the table (the same chain as topHeaderRowCount).
    const ranges = Object.keys(tableGroup.headerRows)
        .map(key => key.split('-').map(Number))
        .filter(range => range.length === 2 && range.every(Number.isFinite))
        .map(([first, second]) => ({ top: Math.max(first, second), bottom: Math.min(first, second) }))
        .sort((a, b) => b.top - a.top);
    let chainEdge = horizons[0].y;
    let headerRowCount = 0;
    for (const range of ranges) {
        if (Math.abs(range.top - chainEdge) > lineMaxWidth) break;
        chainEdge = range.bottom;
        headerRowCount++;
    }
    headerRowCount = Math.min(headerRowCount, rowsCount);
    if (headerRowCount < 2) {
        return;
    }

    const findColumn = (x: number): number => {
        for (let col = 0; col < colsCount; col++) {
            if (x >= verticles[col].x && x < verticles[col + 1].x) return col;
        }
        return -1;
    };
    const findRow = (y: number): number => {
        for (let row = 0; row < rowsCount; row++) {
            if (y <= horizons[row].y && y > horizons[row + 1].y) return row;
        }
        return -1;
    };

    const occupied = new Set<string>();
    (tableGroup.coordinates || []).forEach((block: any) => {
        if (!block?.str?.trim()) return;
        const row = findRow(Number(block?.transform?.[5] ?? block.y));
        const col = findColumn(Number(block?.transform?.[4] ?? block.x));
        if (row >= 0 && col >= 0) occupied.add(`${row}-${col}`);
    });

    const realRules = (tableGroup.edges || []).filter(
        (edge: any) =>
            isVisibleVector(edge) &&
            !edge['_isFakeLine'] &&
            edge.height < lineMaxWidth &&
            edge.width > lineMaxWidth
    );
    const hasRuleAt = (y: number, col: number): boolean => {
        const left = verticles[col].x;
        const right = verticles[col + 1].x;
        let covered = 0;
        realRules.forEach((edge: any) => {
            if (Math.abs(edge.y + edge.height / 2 - y) > Math.max(lineMaxWidth * 0.5, 1.5)) return;
            covered += Math.max(0, Math.min(edge.x + edge.width, right) - Math.max(edge.x, left));
        });
        return covered >= (right - left) * 0.5;
    };

    for (let col = 0; col < colsCount; col++) {
        let textRow = -1;
        for (let row = 0; row < headerRowCount; row++) {
            if (occupied.has(`${row}-${col}`)) {
                textRow = row;
                break;
            }
        }
        if (textRow < 1) continue;

        // The rows above the label must be free and not separated from it by a rule.
        let free = true;
        for (let row = 0; row <= textRow && free; row++) {
            const key = `${row}-${col}`;
            if (merges[key] || mergeAlias[key]) free = false;
            if (row > 0 && hasRuleAt(horizons[row].y, col)) free = false;
        }
        if (!free) continue;

        const rootKey = `0-${col}`;
        const arr: string[] = [];
        for (let row = 0; row <= textRow; row++) arr.push(`${row}-${col}`);
        merges[rootKey] = {
            row: 0,
            col,
            arr,
            widthArr: [rootKey],
            heightArr: arr,
            width: 1,
            height: textRow + 1
        };
        arr.forEach(cellKey => {
            if (cellKey !== rootKey) mergeAlias[cellKey] = rootKey;
        });
    }
}

/**
* Spanning header cells ("Revenue" over two sub-columns, "States-A" over two header rows) are
* normally recovered from the grid lines. When the lines survive, the cells stay unmerged and an
* empty cell remains next to the text. This step derives the spans from the text itself and
* only touches cells that the matrix left unmerged.
*   colspan: the VISIBLE text crosses a column boundary and the cells it covers are empty
*            and not separated by a real vertical rule;
*   rowspan: the cell below a header cell is empty and no real horizontal rule separates them.
*/
export function inferHeaderSpansFromText(options: {
    tableGroup: any;
    verticles: any[];
    horizons: any[];
    merges: Record<string, any>;
    mergeAlias: Record<string, string>;
    lineMaxWidth: number;
}): void {
    const { tableGroup, verticles, horizons, merges, mergeAlias, lineMaxWidth } = options;
    const rowsCount = horizons.length - 1;
    const colsCount = verticles.length - 1;

    if (!tableGroup?.headerRows || rowsCount < 2 || colsCount < 2) {
        return;
    }

    const minRuleThickness = 3;
    const tolerance = 1.5;
    const tableWidth = verticles[colsCount].x - verticles[0].x;

    const isNumericLike = (text: string) =>
        /^[-+]?\d{1,3}(?:[,\s]\d{3})+(?:.\d+)?$|^[-+]?\d+[.,]\d+$/.test(text.trim());
    const isDataRow = (blocks: any[]) => {
        const texts = (blocks || []).map((b: any) => String(b?.str || '').trim()).filter(Boolean);
        return texts.length > 0 && texts.filter(isNumericLike).length * 2 > texts.length;
    };

    const ranges = Object.keys(tableGroup.headerRows)
        .map((key) => {
            const match = /^(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)$/.exec(key);
            if (!match) return null;
            const first = Number(match[1]);
            const second = Number(match[2]);
            return {
                top: Math.max(first, second),
                bottom: Math.min(first, second),
                blocks: tableGroup.headerRows[key],
            };
        })
        .filter(Boolean)
        .sort((a: any, b: any) => b.top - a.top);

    if (!ranges.length) {
        //no parseable ranges
        return;
    }

    // The anchor of the chain is the top of the FIRST range, not horizons[0].y:
    // headerRows could have been calculated based on a grid different from the final one (trim passes,
    // removeFillPadColumns), so horizons[0] does not necessarily coincide with the top of the header.
    const firstTop = ranges[0].top;
    let chainEdge = firstTop;
    let rangeCount = 0;
    for (const range of ranges as any[]) {
        if (isDataRow(range.blocks)) break;
        if (rangeCount > 0 && Math.abs(range.top - chainEdge) > lineMaxWidth) break;
        chainEdge = range.bottom;
        rangeCount++;
    }
    if (!rangeCount) {
        //all leading ranges look like data rows
        return;
    }

    // Number of header rows—based on the geometry: grid lines intersecting [chainEdge, firstTop].
    const headerRowCount = horizons.slice(0, -1).filter(
        (h: any, i: number) =>
            h.y > chainEdge + lineMaxWidth && horizons[i + 1].y <= firstTop + lineMaxWidth
    ).length;
    if (!headerRowCount) {
        //no grid rows intersect the header span
        return;
    }

    const findColumn = (x: number): number => {
        for (let col = 0; col < colsCount; col++) {
            if (x >= verticles[col].x && x < verticles[col + 1].x) return col;
        }
        return -1;
    };
    const findRow = (y: number): number => {
        for (let row = 0; row < rowsCount; row++) {
            if (y <= horizons[row].y && y > horizons[row + 1].y) return row;
        }
        return -1;
    };
    const getVisibleExtent = (block: any) => {
        const glyphs = (block.chars || []).filter(
            (glyph: any) =>
                glyph &&
                typeof glyph === 'object' &&
                typeof glyph.unicode === 'string' &&
                glyph.unicode.trim() &&
                Number.isFinite(glyph.x) &&
                Number.isFinite(glyph.charWidth)
        );
        if (!glyphs.length) return { left: block.x, right: block.x + block.width };
        return {
            left: Math.min(...glyphs.map((g: any) => g.x)),
            right: Math.max(...glyphs.map((g: any) => g.x + g.charWidth)),
        };
    };

    // Actual color rules—one segment per header cell.
    const rules = (tableGroup.edges || [])
        .filter(
            (edge: any) =>
                hasVectorColor(edge) &&
                !edge._isFakeLine &&
                edge.height < minRuleThickness &&
                edge.width > lineMaxWidth
        )
        .map((edge: any) => ({ y: edge.y + edge.height / 2, from: edge.x, to: edge.x + edge.width }));

    const horizontalRuleCoverage = (boundaryY: number, left: number, right: number): number => {
        let covered = 0;
        rules.forEach((rule: any) => {
            if (Math.abs(rule.y - boundaryY) > tolerance) return;
            covered += Math.max(0, Math.min(rule.to, right) - Math.max(rule.from, left));
        });
        return covered / Math.max(right - left, 1);
    };

    const textBlocks = (tableGroup.coordinates || [])
        .filter((block: any) => block?.str?.trim() && Number.isFinite(block.y))
        .map((block: any) => {
            const extent = getVisibleExtent(block);
            const colFrom = findColumn(extent.left + 0.01);
            const colTo = findColumn(extent.right - 0.5);
            return {
                text: String(block.str).trim().slice(0, 24),
                row: findRow(Number(block.y)),
                colFrom,
                colTo: colTo >= 0 ? colTo : colFrom,
                right: extent.right,
                left: extent.left,
            };
        })
        .filter((info: any) => info.row >= 0 && info.row < headerRowCount && info.colFrom >= 0);

    const rootOf = (key: string) => mergeAlias[key] || key;
    const textRoots = new Set<string>(
        textBlocks.map((info: any) => rootOf(`${info.row}-${info.colFrom}`))
    );
    const isFree = (key: string) => !mergeAlias[key] && !merges[key] && !textRoots.has(key);

    const createMerge = (rowStart: number, rowEnd: number, colStart: number, colEnd: number) => {
        const rootKey = `${rowStart}-${colStart}`;
        if (merges[rootKey] || mergeAlias[rootKey]) return false;
        const arr: string[] = [];
        for (let row = rowStart; row < rowEnd; row++) {
            for (let col = colStart; col < colEnd; col++) {
                const key = `${row}-${col}`;
                if (mergeAlias[key] || (merges[key] && key !== rootKey)) return false;
                arr.push(key);
            }
        }
        const widthArr: string[] = [];
        for (let col = colStart; col < colEnd; col++) widthArr.push(`${rowStart}-${col}`);
        const heightArr: string[] = [];
        for (let row = rowStart; row < rowEnd; row++) heightArr.push(`${row}-${colStart}`);
        merges[rootKey] = {
            row: rowStart, col: colStart, arr, widthArr, heightArr,
            width: colEnd - colStart, height: rowEnd - rowStart,
        };
        arr.forEach((key) => { if (key !== rootKey) mergeAlias[key] = rootKey; });
        return true;
    };

    const created: Array<{ root: string; rows: number; cols: number; kind: string }> = [];
    const candidates: any[] = [];

    // Colspan
    const seen = new Set<string>();
    textBlocks.forEach((info: any) => {
        const rootKey = `${info.row}-${info.colFrom}`;
        if (seen.has(rootKey)) return;
        seen.add(rootKey);
        if (mergeAlias[rootKey] || (merges[rootKey]?.width || 1) > 1) {
            candidates.push({ cell: rootKey, text: info.text, result: 'already merged' });
            return;
        }
        // [FIX 3] Полноширинный блок (title/caption) не объединяем.
        if (info.right - verticles[info.colFrom].x >= tableWidth * 0.9) {
            candidates.push({ cell: rootKey, text: info.text, result: 'full-width block, skipped' });
            return;
        }

        const cellLeft = verticles[info.colFrom].x;
        const rowTopY = horizons[info.row].y;
        const segment = rules.find(
            (rule: any) =>
                Math.abs(rule.y - rowTopY) <= tolerance &&
                Math.abs(rule.from - cellLeft) <= tolerance &&
                rule.to - rule.from < tableWidth * 0.9
        );
        let ruleEndCol = info.colFrom;
        if (segment) {
            for (let col = info.colFrom + 1; col < colsCount; col++) {
                if (verticles[col + 1].x <= segment.to + tolerance) ruleEndCol = col;
                else break;
            }
        }
        const textEndCol = info.right - verticles[info.colTo].x >= 1.5 ? info.colTo : info.colFrom;
        const endCol = Math.max(ruleEndCol, textEndCol);

        const entry: any = {
            cell: rootKey, text: info.text, colFrom: info.colFrom,
            ruleEndCol, textEndCol, textRight: +info.right.toFixed(2),
            segment: segment ? [+segment.from.toFixed(2), +segment.to.toFixed(2)] : null,
        };
        if (endCol <= info.colFrom) {
            candidates.push({ ...entry, result: 'single column' });
            return;
        }
        for (let col = info.colFrom + 1; col <= endCol; col++) {
            if (!isFree(`${info.row}-${col}`)) {
                candidates.push({ ...entry, result: `blocked by ${info.row}-${col}` });
                return;
            }
        }
        if (createMerge(info.row, info.row + 1, info.colFrom, endCol + 1)) {
            created.push({ root: rootKey, rows: 1, cols: endCol - info.colFrom + 1, kind: 'colspan' });
            candidates.push({ ...entry, result: 'colspan created' });
        } else {
            candidates.push({ ...entry, result: 'createMerge refused' });
        }
    });

    // Rowspan — can EXTEND existing merge matrices downward.
    // Without this, “Capital” (691.08) and the phantom row 700.2 would remain outside,
    // and the rowspan of the header cells would be one row shorter.
    Array.from(textRoots).forEach((key) => {
        const [row, col] = key.split('-').map(Number);
        if (!(row >= 0 && row < headerRowCount - 1)) return;
        if (mergeAlias[key]) return;
        const existing = merges[key];
        const width = existing?.width || 1;
        const currentEnd = row + (existing?.height || 1);
        let endRow = currentEnd;
        while (endRow < headerRowCount) {
            let free = true;
            for (let c = col; c < col + width; c++) free = free && isFree(`${endRow}-${c}`);
            if (
                !free ||
                horizontalRuleCoverage(horizons[endRow].y, verticles[col].x, verticles[col + width].x) >= 0.5
            ) {
                break;
            }
            endRow++;
        }
        if (endRow <= currentEnd) return;
        if (existing) {
            for (let r = currentEnd; r < endRow; r++) {
                for (let c = col; c < col + width; c++) {
                    const cellKey = `${r}-${c}`;
                    existing.arr.push(cellKey);
                    mergeAlias[cellKey] = key;
                }
                existing.heightArr.push(`${r}-${col}`);
            }
            existing.height = endRow - row;
            created.push({ root: key, rows: existing.height, cols: width, kind: 'rowspan-extended' });
        } else if (createMerge(row, endRow, col, col + width)) {
            created.push({ root: key, rows: endRow - row, cols: width, kind: 'rowspan' });
        }
    });

}

export function inferMergesFromFillRectangles(options: {
    tableGroup: any;
    pageGroup: any;
    verticles: any[];
    horizons: any[];
    merges: Record<string, any>;
    mergeAlias: Record<string, string>;
    lineMaxWidth: number;
}) {
    const {
        tableGroup,
        pageGroup,
        verticles,
        horizons,
        merges,
        mergeAlias,
        lineMaxWidth,
    } = options;

    if (
        !tableGroup ||
        !verticles?.length ||
        !horizons?.length
    ) {
        return;
    }

    const borderSize = tableGroup.borderSize || 0.57;
    const tolerance = Math.max(1, borderSize * 3);

    const rectangles = uniqueArr(
        [
            ...(tableGroup.rectangles || []),
            ...(pageGroup?.rectangles || []),
        ]
            .filter((rect: any) =>
                rect &&
                rect.fillColor &&
                isVisibleVector(rect) &&
                Number(rect.width) > 0 &&
                Number(rect.height) > 0
            ),
        ['x', 'y', 'width', 'height']
    );

    if (!rectangles.length) {
        return;
    }

    const realEdges = uniqueArr(
        [
            ...(tableGroup.edges || []),
            ...(pageGroup?.edges || []),
        ].filter((edge: any) =>
            edge &&
            isVisibleVector(edge) &&
            !edge._isFakeLine
        ),
        ['x', 'y', 'width', 'height']
    );

    const coordinates = (tableGroup.coordinates || [])
        .filter((item: any) =>
            item &&
            (
                item.str?.trim() ||
                item.imageName
            )
        );

    function getVerticalCoordinate(index: number) {
        return Number(verticles[index]?.x);
    }

    function getHorizontalCoordinate(index: number) {
        return Number(horizons[index]?.y);
    }

    function normalizeRect(rect: any) {
        return {
            x1: Math.min(
                Number(rect.x),
                Number(rect.x) + Number(rect.width)
            ),
            x2: Math.max(
                Number(rect.x),
                Number(rect.x) + Number(rect.width)
            ),
            y1: Math.min(
                Number(rect.y),
                Number(rect.y) + Number(rect.height)
            ),
            y2: Math.max(
                Number(rect.y),
                Number(rect.y) + Number(rect.height)
            ),
        };
    }

    /**
     * verticles/horizons contain objects:
     *
     * verticles -> { x, lines }
     * horizons  -> { y, lines }
     *
     * Therefore, we intentionally compare the coordinate
     * with the .x/.y property here.
     */
    function findGridIndex(
        grid: any[],
        value: number,
        axis: 'x' | 'y'
    ) {
        let result = -1;
        let minDistance = Infinity;

        for (let index = 0; index < grid.length; index++) {
            const gridValue = Number(
                axis === 'x'
                    ? grid[index]?.x
                    : grid[index]?.y
            );

            if (!Number.isFinite(gridValue)) {
                continue;
            }

            const distance = Math.abs(
                gridValue - value
            );

            if (distance < minDistance) {
                minDistance = distance;
                result = index;
            }
        }

        return minDistance <= tolerance
            ? result
            : -1;
    }

    function getRectGridSpan(rect: any) {
        const normalized = normalizeRect(rect);

        const colStartIndex = findGridIndex(
            verticles,
            normalized.x1,
            'x'
        );

        const colEndIndex = findGridIndex(
            verticles,
            normalized.x2,
            'x'
        );

        const rowStartIndex = findGridIndex(
            horizons,
            normalized.y1,
            'y'
        );

        const rowEndIndex = findGridIndex(
            horizons,
            normalized.y2,
            'y'
        );

        if (
            colStartIndex === -1 ||
            colEndIndex === -1 ||
            rowStartIndex === -1 ||
            rowEndIndex === -1
        ) {
            return null;
        }

        return {
            x1: normalized.x1,
            x2: normalized.x2,
            y1: normalized.y1,
            y2: normalized.y2,

            colStart: Math.min(
                colStartIndex,
                colEndIndex
            ),

            colEnd: Math.max(
                colStartIndex,
                colEndIndex
            ),

            rowStart: Math.min(
                rowStartIndex,
                rowEndIndex
            ),

            rowEnd: Math.max(
                rowStartIndex,
                rowEndIndex
            ),
        };
    }

    function getCellBounds(
        row: number,
        col: number
    ) {
        if (
            row < 0 ||
            col < 0 ||
            row >= horizons.length - 1 ||
            col >= verticles.length - 1
        ) {
            return null;
        }

        const x1 = getVerticalCoordinate(col);
        const x2 = getVerticalCoordinate(col + 1);

        const y1 = getHorizontalCoordinate(row);
        const y2 = getHorizontalCoordinate(row + 1);

        if (
            !Number.isFinite(x1) ||
            !Number.isFinite(x2) ||
            !Number.isFinite(y1) ||
            !Number.isFinite(y2)
        ) {
            return null;
        }

        return {
            x1: Math.min(x1, x2),
            x2: Math.max(x1, x2),
            y1: Math.min(y1, y2),
            y2: Math.max(y1, y2),
        };
    }

    function findCoordinateCell(coordinate: any) {
        const coordinateX1 = Number(coordinate.x);
        const coordinateX2 =
            coordinateX1 + Number(coordinate.width);

        const coordinateY1 = Number(coordinate.y);
        const coordinateY2 =
            coordinateY1 + Number(coordinate.height);

        const centerX =
            (coordinateX1 + coordinateX2) / 2;

        const centerY =
            (coordinateY1 + coordinateY2) / 2;

        let bestCell: {
            row: number;
            col: number;
            overlap: number;
        } | null = null;

        for (
            let row = 0;
            row < horizons.length - 1;
            row++
        ) {
            for (
                let col = 0;
                col < verticles.length - 1;
                col++
            ) {
                const cell = getCellBounds(row, col);

                if (!cell) {
                    continue;
                }

                const overlapX = Math.max(
                    0,
                    Math.min(cell.x2, coordinateX2) -
                    Math.max(cell.x1, coordinateX1)
                );

                const overlapY = Math.max(
                    0,
                    Math.min(cell.y2, coordinateY2) -
                    Math.max(cell.y1, coordinateY1)
                );

                const overlap =
                    overlapX * overlapY;

                if (overlap > 0) {
                    if (
                        !bestCell ||
                        overlap > bestCell.overlap
                    ) {
                        bestCell = {
                            row,
                            col,
                            overlap,
                        };
                    }
                }

                if (
                    centerX >= cell.x1 - tolerance &&
                    centerX <= cell.x2 + tolerance &&
                    centerY >= cell.y1 - tolerance &&
                    centerY <= cell.y2 + tolerance
                ) {
                    if (!bestCell) {
                        bestCell = {
                            row,
                            col,
                            overlap: 0,
                        };
                    }
                }
            }
        }

        return bestCell
            ? {
                row: bestCell.row,
                col: bestCell.col,
            }
            : null;
    }

    function getOccupiedCells(span: any) {
        if (!span) {
            return [];
        }

        const cells = new Map<
            string,
            { row: number; col: number }
        >();

        coordinates.forEach((coordinate: any) => {
            const cell =
                findCoordinateCell(coordinate);

            if (!cell) {
                return;
            }

            if (
                cell.row < span.rowStart ||
                cell.row >= span.rowEnd ||
                cell.col < span.colStart ||
                cell.col >= span.colEnd
            ) {
                return;
            }

            cells.set(
                `${cell.row}-${cell.col}`,
                cell
            );
        });

        return [...cells.values()];
    }

    function hasHorizontalEdge(
        y: number,
        x1: number,
        x2: number
    ) {
        const requiredOverlap = Math.max(
            lineMaxWidth,
            (x2 - x1) * 0.5
        );

        return realEdges.some((edge: any) => {
            const isHorizontal =
                edge.height < lineMaxWidth &&
                edge.width > lineMaxWidth;

            if (!isHorizontal) {
                return false;
            }

            if (
                Math.abs(edge.y - y) >
                tolerance
            ) {
                return false;
            }

            const overlap = Math.max(
                0,
                Math.min(
                    edge.x + edge.width,
                    x2
                ) -
                Math.max(
                    edge.x,
                    x1
                )
            );

            return overlap >= requiredOverlap;
        });
    }

    function hasVerticalEdge(
        x: number,
        y1: number,
        y2: number
    ) {
        const requiredOverlap = Math.max(
            lineMaxWidth,
            (y2 - y1) * 0.5
        );

        return realEdges.some((edge: any) => {
            const isVertical =
                edge.width < lineMaxWidth &&
                edge.height > lineMaxWidth;

            if (!isVertical) {
                return false;
            }

            if (
                Math.abs(edge.x - x) >
                tolerance
            ) {
                return false;
            }

            const overlap = Math.max(
                0,
                Math.min(
                    edge.y + edge.height,
                    y2
                ) -
                Math.max(
                    edge.y,
                    y1
                )
            );

            return overlap >= requiredOverlap;
        });
    }

    function hasMergeConflict(
        rowStart: number,
        rowEnd: number,
        colStart: number,
        colEnd: number
    ) {
        for (
            let row = rowStart;
            row < rowEnd;
            row++
        ) {
            for (
                let col = colStart;
                col < colEnd;
                col++
            ) {
                const key = `${row}-${col}`;

                if (mergeAlias[key]) {
                    return true;
                }

                if (
                    merges[key] &&
                    key !== `${rowStart}-${colStart}`
                ) {
                    return true;
                }
            }
        }

        return false;
    }

    function createMerge(
        rowStart: number,
        rowEnd: number,
        colStart: number,
        colEnd: number
    ) {
        const rootKey =
            `${rowStart}-${colStart}`;

        if (
            merges[rootKey] ||
            mergeAlias[rootKey]
        ) {
            return false;
        }

        if (
            hasMergeConflict(
                rowStart,
                rowEnd,
                colStart,
                colEnd
            )
        ) {
            return false;
        }

        const arr: string[] = [];
        const widthArr: string[] = [];
        const heightArr: string[] = [];

        for (
            let row = rowStart;
            row < rowEnd;
            row++
        ) {
            for (
                let col = colStart;
                col < colEnd;
                col++
            ) {
                arr.push(`${row}-${col}`);
            }
        }

        for (
            let col = colStart;
            col < colEnd;
            col++
        ) {
            widthArr.push(
                `${rowStart}-${col}`
            );
        }

        for (
            let row = rowStart;
            row < rowEnd;
            row++
        ) {
            heightArr.push(
                `${row}-${colStart}`
            );
        }

        merges[rootKey] = {
            row: rowStart,
            col: colStart,
            arr: uniqueArr(arr),
            widthArr: uniqueArr(widthArr),
            heightArr: uniqueArr(heightArr),
            width: colEnd - colStart,
            height: rowEnd - rowStart,
        };

        arr.forEach(cellKey => {
            if (cellKey !== rootKey) {
                mergeAlias[cellKey] =
                    rootKey;
            }
        });

        return true;
    }

    for (const rectangle of rectangles) {
        const span = getRectGridSpan(rectangle);

        if (!span) {
            continue;
        }

        const rowSpan = span.rowEnd - span.rowStart;
        const colSpan = span.colEnd - span.colStart;



        if (
            rowSpan <= 1 &&
            colSpan <= 1
        ) {
            continue;
        }

        const occupiedCells =
            getOccupiedCells(span);

        /*
       * The merged rectangle must have one anchor-content.
       * This cuts off the usual large background rectangles.
       */
        if (
            occupiedCells.length !== 1
        ) {
            continue;
        }

        const anchor = occupiedCells[0];

        // if (
        //   anchor.row !== span.rowStart ||
        //   anchor.col !== span.colStart
        // ) {
        //   continue;
        // }

        // The label may sit anywhere inside the filled cell (e.g. in the lower row of a
        // two-row header cell); it is still one merged cell. Tall fills are ignored
        // so that a background rectangle cannot swallow a whole column.
        if (rowSpan > 3) {
            continue;
        }


        //Check the actual internal horizontal boundaries.
        let hasInternalHorizontalEdge = false;

        for (
            let row = span.rowStart + 1;
            row < span.rowEnd;
            row++
        ) {
            const y = getHorizontalCoordinate(row);

            if (
                hasHorizontalEdge(
                    y,
                    span.x1,
                    span.x2
                )
            ) {
                hasInternalHorizontalEdge = true;
                break;
            }
        }

        if (hasInternalHorizontalEdge) {
            continue;
        }

        // Check the actual internal vertical boundaries.
        let hasInternalVerticalEdge = false;

        for (
            let col = span.colStart + 1;
            col < span.colEnd;
            col++
        ) {
            const x = getVerticalCoordinate(col);

            if (
                hasVerticalEdge(
                    x,
                    span.y1,
                    span.y2
                )
            ) {
                hasInternalVerticalEdge = true;
                break;
            }
        }

        if (hasInternalVerticalEdge) {
            continue;
        }

        const created =
            createMerge(
                span.rowStart,
                span.rowEnd,
                span.colStart,
                span.colEnd
            );

    }
}

export function validateColumnMerges(options: {
    merges: Record<string, any>;
    mergeAlias: Record<string, string>;
    verticles: any[];
    horizons: any[];
    coordinates: any[];
}) {
    const { merges, mergeAlias, verticles, coordinates } = options;
    const sortedV = [...verticles].sort((a, b) => a.x - b.x);
    const colBounds = (colIndex: number) => [sortedV[colIndex]?.x, sortedV[colIndex + 1]?.x];
    const ySorted = [...options.horizons].sort((a, b) => b.y - a.y);

    // Visible horizontal extent of a text block: from its first to the end of its last
    // visible glyph. block.width may include trailing word spacing, which makes a value
    // like "7.0" look as if it stretches into the neighbouring column.
    const getVisibleExtent = (block: any): { left: number; right: number } => {
        const glyphs = (block.chars || []).filter(
            (glyph: any) =>
                glyph &&
                typeof glyph === 'object' &&
                typeof glyph.unicode === 'string' &&
                glyph.unicode.trim() &&
                Number.isFinite(glyph.x) &&
                Number.isFinite(glyph.charWidth)
        );
        if (!glyphs.length) {
            return { left: block.x, right: block.x + block.width };
        }
        return {
            left: Math.min(...glyphs.map((glyph: any) => glyph.x)),
            right: Math.max(...glyphs.map((glyph: any) => glyph.x + glyph.charWidth))
        };
    };

    Object.keys(merges).forEach(rootKey => {
        const merge = merges[rootKey];
        if (merge.width <= 1) return;

        const colFrom = merge.col;
        const colTo = merge.col + merge.width;
        const xFrom = sortedV[colFrom]?.x;
        const xTo = sortedV[colTo]?.x;
        if (!Number.isFinite(xFrom) || !Number.isFinite(xTo)) return;

        const rowFrom = merge.row;
        const rowTo = merge.row + merge.height;
        const yTop = ySorted[rowFrom]?.y;
        const yBottom = ySorted[rowTo]?.y;
        if (!Number.isFinite(yTop) || !Number.isFinite(yBottom)) return;

        const itemsInSpan = (coordinates || []).filter(item => {
            if (!item?.str?.trim()) return false;
            const { left, right } = getVisibleExtent(item);
            return (
                left >= xFrom - 1 &&
                right <= xTo + 1 &&
                item.y <= yTop + 1 &&
                item.y > yBottom - 1
            );
        });
        if (itemsInSpan.length < 2) return;

        const subColumnsUsed = new Set<number>();
        let anyItemSpansMultipleColumns = false;

        itemsInSpan.forEach(item => {
            const { left: itemLeft, right: itemRight } = getVisibleExtent(item);
            const itemWidth = itemRight - itemLeft;
            const touchedCols: number[] = [];

            for (let c = colFrom; c < colTo; c++) {
                const [cxFrom, cxTo] = colBounds(c);
                const overlap = Math.min(itemRight, cxTo) - Math.max(itemLeft, cxFrom);
                if (overlap > Math.min(itemWidth, cxTo - cxFrom) * 0.5) {
                    touchedCols.push(c);
                }
            }

            if (touchedCols.length > 1) anyItemSpansMultipleColumns = true;
            touchedCols.forEach(c => subColumnsUsed.add(c));
        });

        if (!anyItemSpansMultipleColumns && subColumnsUsed.size > 1) {

            delete merges[rootKey];
            (merge.arr || []).forEach((cellKey: string) => {
                if (mergeAlias[cellKey] === rootKey) delete mergeAlias[cellKey];
            });

            if (merge.height > 1) {
                for (let c = colFrom; c < colTo; c++) {
                    const newRootKey = `${rowFrom}-${c}`;
                    const arr: string[] = [];
                    for (let r = rowFrom; r < rowTo; r++) arr.push(`${r}-${c}`);
                    merges[newRootKey] = {
                        row: rowFrom,
                        col: c,
                        arr,
                        widthArr: [newRootKey],
                        heightArr: arr,
                        width: 1,
                        height: merge.height
                    };
                    arr.forEach(cellKey => {
                        if (cellKey !== newRootKey) mergeAlias[cellKey] = newRootKey;
                    });
                }
            }
        }
    });

    return { merges, mergeAlias };
}

// Creates merges from a matrix: adjacent cells are merged if there is no line between them.
// Returns null if any group of cells is not a rectangle.
export function buildMergesFromMatrix(
    matrix: number[][],
    rowsCount: number,
    colsCount: number
): Record<string, any> | null {
    const parent = Array.from({ length: rowsCount * colsCount }, (_, index) => index);
    const cellId = (row: number, col: number) => row * colsCount + col;

    const find = (id: number): number => {
        while (parent[id] !== id) {
            parent[id] = parent[parent[id]];
            id = parent[id];
        }
        return id;
    };

    const union = (first: number, second: number) => {
        const firstRoot = find(first);
        const secondRoot = find(second);
        if (firstRoot !== secondRoot) {
            parent[Math.max(firstRoot, secondRoot)] = Math.min(firstRoot, secondRoot);
        }
    };

    for (let row = 0; row < rowsCount; row++) {
        for (let col = 0; col < colsCount; col++) {
            // right boundary: matrix[2*row+1][2*(col+1)]
            if (col + 1 < colsCount && !matrix[2 * row + 1][2 * (col + 1)]) {
                union(cellId(row, col), cellId(row, col + 1));
            }
            // bottom boundary: matrix[2*(row+1)][2*col+1]
            if (row + 1 < rowsCount && !matrix[2 * (row + 1)][2 * col + 1]) {
                union(cellId(row, col), cellId(row + 1, col));
            }
        }
    }

    const groups: Record<number, number[][]> = {};
    for (let row = 0; row < rowsCount; row++) {
        for (let col = 0; col < colsCount; col++) {
            const root = find(cellId(row, col));
            (groups[root] = groups[root] || []).push([row, col]);
        }
    }

    const merges: Record<string, any> = {};

    for (const cells of Object.values(groups)) {
        if (cells.length < 2) {
            continue;
        }

        const rowStart = Math.min(...cells.map((cell) => cell[0]));
        const rowEnd = Math.max(...cells.map((cell) => cell[0]));
        const colStart = Math.min(...cells.map((cell) => cell[1]));
        const colEnd = Math.max(...cells.map((cell) => cell[1]));

        const height = rowEnd - rowStart + 1;
        const width = colEnd - colStart + 1;

        // Non-rectangular areas cannot be combined
        if (height * width !== cells.length) {
            return null;
        }

        const arr: string[] = [];
        for (let row = rowStart; row <= rowEnd; row++) {
            for (let col = colStart; col <= colEnd; col++) {
                arr.push(`${row}-${col}`);
            }
        }

        const widthArr: string[] = [];
        for (let col = colStart; col <= colEnd; col++) {
            widthArr.push(`${rowStart}-${col}`);
        }

        const heightArr: string[] = [];
        for (let row = rowStart; row <= rowEnd; row++) {
            heightArr.push(`${row}-${colStart}`);
        }

        merges[`${rowStart}-${colStart}`] = {
            row: rowStart,
            col: colStart,
            arr,
            widthArr,
            heightArr,
            width,
            height,
        };
    }

    return merges;
}

export function areCellsAdjacent(cell1, cell2) {
    const [row1, col1] = cell1;
    const [row2, col2] = cell2;
    let h, v;
    // Check if the cells are identical
    if (col1 === col2 && row1 === row2) {
        h = true;
        v = true;
    }
    // Check if the cells are horizontally or vertically adjacent
    if (Math.abs(row1 - row2) === 1 && col1 === col2) {
        h = true;
    }
    if (Math.abs(col1 - col2) === 1 && row1 === row2) {
        v = true;
    }
    // Check if the cells are diagonally adjacent to each other
    // if (Math.abs(row1 - row2) === 1 && Math.abs(col1 - col2) === 1) {
    //     return true;
    // }

    return [h, v];
}