// import * as Fs from 'fs';
// import * as Path from 'path';
// import { fileURLToPath } from 'url';
// import { dirname } from 'path';
import { getTextDirection, getMergedArray, uniqueArr, checkRectangleRanges, removeByIndexes, getSplitEdgeRange, getOnePercentOfAbsoluteDifference, typeValue, sortArrayOfObjects, stringifyPseudoJson } from '@unsonet/js-utils'
import { buildDebugReport, DebugOptions } from '../pdftrace-debug-kit/pdf-debug';
import { headerIndicatorWords as _headerIndicatorWords, OPS as _OPS, isLeaderGlyph, isLeaderOnlyText, LINE_MAX_WIDTH, materializeLeaderGaps } from '../constants';
import {
  applyTransformFn,
  extractArrayLike,
  extractClosedSubpathRectangles,
  getDeviceBBox,
  normalizeColorArgs,
  normalizeFontArgs,
  normalizeGenericColorArgs,
  normalizeGlyphUnicode,
  normalizeNumericArgs,
  normalizeShowTextArgs,
  transformFn,
} from './pdf-operator-utils';
import {
  hasVectorColor,
  isEdgeFilledEvenOdd,
  isSameFillColor,
  isStrictlyContained,
  isVisibleVector,
} from './pdf-vector-utils';
import {
  calculateToleranceValue,
  getAverageBorderSize,
  mergeCoordinates,
} from './pdf-grid-utils';
import { filterBlocks } from './filter-blocks';
import { createRangeIndex, getBoxRange, getTextYRange } from './range-index';
import { DEBUG_LOG, verifySameResult } from './pdf-log';
import { addToBlockList, addToGridList } from './group-lists';
import { resolvePagesToProcess, yieldToMain } from './page-utils';
import { boxesIntersect, isRectangleWithinBox, getVisibleGlyphEdge, getCoveredLength } from './geometry-utils';
import { clearChars, getSymbolsBetween, updateChars, createLeaderGapGlyph, clearEmptyCoordinateItems, removeLineBreak, isEmptyCoordinate } from './text-chars';
import { getItemRight, isRotatedTextItem, isRotatedText, isOnSameTextLine, getTextContentItemId, isSameFont, normalizeRotatedAnchor, isHorizontalText, getTextAnchor, getTextLineDistance } from './text-geometry';
import { mergeCachedBucketAsWhole, attachToContinuation, normalizeCJKText, findRelatedTextContentSpan, findBestRelatedTextContentItem, isSegmentContainedByRelatedItem, splitFragmentsIntoCells, intersectsEdges, getCoordinateFromObj, getMergedCoordinatePaddingObj, isOverlayOnSameTextLine, removeOverlaidDuplicateItems, segmentPreliminaryItem } from './text-segmentation';
import { isCaptionBlock, determineHeaderRows } from './header-rows';
import { getGapBandsBetweenRuledTables, absorbEnclosedBlocks, constrainGroupToRuledFrame, extendGroupTopBorder, extendGroupBottomRow, trimFullWidthTitleRow, removeFillSeamRows, removeFillPadColumns, absorbThinEmptyBands, refineTextOnlyTopRows, rebuildUnseparatedRows, applyLeaderRowBoundaries, isTableGroup, rescueContinuationRanges, getRuledBoxExtent, getRuleExtent, trimUnsupportedTrailingRows } from './table-group-postprocess';
import { getHandledGridItems } from './grid-items';
import { inferTextAlignedGrid } from './text-aligned-grid';
import { compositeCellColors, computeCellFills } from './cell-fills';
import { createLinesFromRectangle, generateVirtualEdges } from './virtual-edges';
import { areCellsAdjacent, buildMergesFromMatrix, inferMergesFromFillRectangles, inferHeaderRowSpans, inferHeaderSpansFromText, validateColumnMerges } from './merge-inference';
import { extractTableData } from './extract-table-data';
// const __filename = fileURLToPath(import.meta.url);
// const __dirname = dirname(__filename);
export function init({
  pdfjs,
  workerSrc,
  standardFontDataUrl
}: {
  pdfjs: any,
  workerSrc?: any
  standardFontDataUrl?: any
}): any {

  //let version = 'v3.11.174'; 

  //let pdfjs = await import(`pdfjs-dist/legacy/build/pdf.min.mjs`);//old (local): await import(`./pdf.js/${version}/build/pdf.mjs`);
  //let pdfjsWorker = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs');
  //var modulePath = __dirname.substring(0, __dirname.lastIndexOf("/"));
  //pdfjs.workerSrc = modulePath + '/pdfjs-dist/build/pdf.worker.js';
  //pdfjs.cMapUrl = modulePath + '/pdfjs-dist/cmaps/';

  if (workerSrc !== undefined) {
    pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;//`pdfjs-dist/legacy/build/pdf.worker.mjs`;;
  }
  pdfjs = {
    ...pdfjs,
    ...(workerSrc !== undefined ? { workerSrc: pdfjs.GlobalWorkerOptions.workerSrc } : {}),// `pdfjs-dist/legacy/build/pdf.worker.mjs`,
    cMapUrl: 'cmaps/',
    cMapPacked: true,
  };


  function extractor(extractorOptions: { doc, onProgress?, pages?: number[] | { from?: number; to?: number }, debugOptions?: DebugOptions }) {
    const { doc, onProgress, pages, debugOptions } = extractorOptions || {};
    const debugEnabled = typeof debugOptions?.onReport === 'function';
    var numPages = doc.numPages;
    var result: { pageTables: Array<any>, numPages: number, currentPage: number } = { pageTables: [], numPages: numPages, currentPage: 0, };
    var lineMaxWidth = LINE_MAX_WIDTH;


    // === CJK normalization utilities ===
    const CJK_REGEX = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF\uFF00-\uFFEF]/;

    /** Checks if a single character is CJK/fullwidth */
    function isCJKChar(ch: string): boolean {
      return CJK_REGEX.test(ch);
    }



    var pagesToProcess = resolvePagesToProcess(numPages, pages);
    const ADVANCE_TEXT_POSITION_AFTER_SHOW = true;
    var loadPage = function (pageNum) {
      return doc.getPage(pageNum).then(async function (page) {
        const _defaultTransformMatrix = [1, 0, 0, 1, 0, 0];
        const _fontIdentityMatrix = [0.001, 0, 0, 0.001, 0, 0];
        const debugTrace: Record<string, any> | undefined = debugEnabled
          ? {
            pageNumber: pageNum,
            pdfjsOps: pdfjs.OPS,
            lineMaxWidth,
            options: debugOptions,
            cleanupRoots: [] as unknown[],
          }
          : undefined;
        var transformMatrix = JSON.parse(JSON.stringify(_defaultTransformMatrix));
        var textMatrix = JSON.parse(JSON.stringify(_defaultTransformMatrix));
        var transformStack = [];
        var clipBoxStack: Array<number[] | null> = [];
        var clippedAwayCount = 0;
        let pageTextContent = await page.getTextContent();
        let pageViewport = page.getViewport({ scale: 1 });
        let pageWidth = pageViewport.width;
        let pageHeight = pageViewport.height;

        if (debugTrace) {
          debugTrace.pageSize = {
            width: pageViewport.width,
            height: pageViewport.height,
            rotation: pageViewport.rotation,
          };

          debugTrace.pdfjsItems = pageTextContent.items.map((item: any) => item ? ({
            str: item.str,
            transform: item.transform ? Array.from(item.transform) : item.transform,
            width: item.width,
            height: item.height,
            fontName: item.fontName,
            dir: item.dir,
            hasEOL: item.hasEOL,
          }) : item);
        }

        pageTextContent.items = pageTextContent.items.reduce((prev, cur, index) => {
          if (cur && typeof cur.str === 'string' && cur.str.trim()) {
            //cur.str = normalizeCJKText(cur.str);
            cur.index = prev.length;
            prev.push(cur);
          }
          return prev;
        }, []);

        const textItemsIndex = createRangeIndex(pageTextContent.items, (item: any) =>
          getTextYRange(item.transform, item.width, item.height)
        );

        function getRelatedTextContentItems(element: any, source: { transform: number[]; width: number; height: number }) {
          const isRelated = (item: any): boolean => {
            if (!item) return false;
            const candidateBox = getDeviceBBox(item.transform, item.width, item.height);
            return (
              checkRectangleRanges(element, candidateBox, { axis: ['x', 'y'], strict: false, strictIntersecting: false }) as Array<any>
            ).every(res => res.inRange);
          };

          const range = getTextYRange(source.transform, source.width, source.height);
          const candidates = range
            ? textItemsIndex.query(range[0], range[1]).map(i => pageTextContent.items[i])
            : pageTextContent.items;
          const related = candidates.filter(isRelated);
          verifySameResult('related text items', related, () => pageTextContent.items.filter(isRelated));
          return related;
        }







        return page.getOperatorList().then(async function (opList) {

          if (debugTrace) {
            debugTrace.opList = opList;
          }

          // Get rectangle first
          var edges = [];
          var tableContentItems = [];
          var tableContentItemsCache = {};
          var tableContentItemsCacheSource: Record<string, any> = {};
          var lastActiveCacheKey = null;

          if (debugTrace) {
            debugTrace.cleanupRoots.push(edges, tableContentItems, tableContentItemsCache);
          }

          // The item that starts exactly where the flushed text ends, on the same baseline.
          function findContinuationItem(flushed: any): any {
            const height = Math.max(flushed.height || 0, 1);
            const baselineTolerance = Math.max(height * 0.5, 1);
            const maxGap = Math.max(height * 0.75, 2);
            const right = getItemRight(flushed);
            let best: any = null;
            let bestGap = Infinity;

            for (const item of tableContentItems) {
              if (!item?.transform || item.imageName || !item.str?.trim() || !item.chars?.length) continue;
              if (Math.abs(item.transform[5] - flushed.transform[5]) > baselineTolerance) continue;

              const gap = item.transform[4] - right;
              if (gap < -height * 0.25 || gap > maxGap || gap >= bestGap) continue;
              if (hasVerticalSeparatorBetween(flushed, item)) continue;

              best = item;
              bestGap = gap;
            }
            return best;
          }

          // Fallback: if the showText chain (for example, a
          // multi-line rotated column header) fails to
          // match its “native” pdf.js text element,
          // the fragments get permanently stuck in the tableContentItemsCache and silently
          // disappear from the final table. Instead, we flush them—
          // even if they’re not perfectly concatenated, they’re better than being lost entirely;
          // the subsequent layout into cells in `extractTableData()` will still
          // concatenate the text within a single cell anyway.
          function flushStaleTableContentItemsCache() {
            for (const key of Object.keys(tableContentItemsCache)) {
              const cachedItems = (tableContentItemsCache[key] || []).filter(Boolean);
              const source = tableContentItemsCacheSource[key];
              delete tableContentItemsCache[key];
              delete tableContentItemsCacheSource[key];
              if (!cachedItems.length) continue;

              const isRotatedBucket = cachedItems.some(
                item => item?.transform && (isRotatedTextItem(item) || isRotatedText(item))
              );
              if (isRotatedBucket) {
                tableContentItems.push(mergeCachedBucketAsWhole(cachedItems));
                continue;
              }

              // Fragments with text define the line; whitespace-only fragments
              // (possibly attached from a neighbouring line) must not move it.
              const solidItems = cachedItems.filter(item => item.str?.trim());
              const candidates = solidItems.length ? solidItems : cachedItems;
              const reference = candidates[0];
              const referenceHeight = Math.max(reference.height || 0, 1);
              const baselineTolerance = Math.max(referenceHeight * 0.5, 1);

              // The pdf.js item this bucket was waiting for is the ground truth for the baseline.
              const sourceBaseline = Number(source?.transform?.[5]);
              const ownBaseline = reference.transform[5];
              const baselineDifference = Math.abs(sourceBaseline - ownBaseline);

              // The difference due to float noise (pdf.js rounds, while the interpreter stores float32) is the same
              // line: we keep our own baseline so that the entire visual string has the same y-coordinate.
              // Actual shifts (> 0.01) work as before.
              const baselineNoise = 0.01;
              const baseline =
                Number.isFinite(sourceBaseline) && baselineDifference > baselineNoise && baselineDifference <= referenceHeight * 3
                  ? sourceBaseline
                  : ownBaseline;

              const lineItems = candidates.filter(
                item => Math.abs(item.transform[5] - reference.transform[5]) <= baselineTolerance
              );
              const strayItems = candidates.filter(
                item => !lineItems.includes(item) && item.str?.trim()
              );

              const mergedChars = lineItems.reduce((chars, item) => chars.concat(item.chars || []), []);
              mergedChars.forEach((glyph: any) => {
                if (glyph && typeof glyph === 'object' && Number.isFinite(glyph.y)) {
                  glyph.y = baseline;
                }
              });

              const first = lineItems[0];
              const left = Math.min(...lineItems.map(item => item.transform[4]));
              const right = Math.max(...lineItems.map(getItemRight));
              const flushed = {
                ...first,
                str: lineItems
                  .map(item => item?.str || '')
                  .filter(part => part.trim().length)
                  .join(' '),
                chars: mergedChars,
                hasEOT: true,
                hasEOL: lineItems[lineItems.length - 1]?.hasEOL || false,
                // Marker: the item is appended to the END of tableContentItems, so its array
                // neighbours are not its real neighbours in the content stream.
                isStaleFlush: true,
                width: Math.max(0, right - left),
                height: Math.max(...lineItems.map(item => item?.height || 0)),
                transform: [
                  first.transform[0],
                  first.transform[1],
                  first.transform[2],
                  first.transform[3],
                  left,
                  baseline,
                ],
              };

              const continuation = findContinuationItem(flushed);

              if (continuation) {
                attachToContinuation(continuation, flushed);
              } else {
                tableContentItems.push(flushed);
              }
              strayItems.forEach(item => tableContentItems.push({
                ...item,
                hasEOT: true
              }));
            }
          }

          let current = {
            x: null,
            y: null,
            height: 0,
            width: 0,
            lineWidth: .567 / page.userUnit,//BUGFIX
            charSpacing: 0,
            wordSpacing: 0,
            strokeRGBColor: [0, 0, 0],
            fillRGBColor: [0, 0, 0],
            strokeAlpha: 1,
            fillAlpha: 1,
            textRenderingMode: 0,
            pathConstructed: false,
            vectorType: null,
            vectorCache: null,
            fontSpaceWidths: {},
            contentItem: {} as { [key: string]: any },
            fontDirection: null,
            fontName: null,
            fontSize: null,
            colorType: null,
            leading: 0, // string offset for T* in units of text space (= -TL)
            textRunAdvance: 0, // cumulative offset after Tj since the last position update
            clipBox: null as number[] | null,
            pendingClip: false
          };

          let rectangles = [];
          let rectanglesEdges = [];
          let filledRectangles = [];
          // Column boundaries determined by text alignment (tables without vertical lines)
          let pageColumnBorders: Array<{ x: number; yFrom: number; yTo: number }> = [];
          const EMPTY_CLIP: number[] = [Infinity, Infinity, -Infinity, -Infinity];
          const CLIP_TOLERANCE = 1;

          if (debugTrace) {
            debugTrace.cleanupRoots.push(rectangles, rectanglesEdges);
          }


          function intersectBoxes(first: number[], second: number[]): number[] {
            const box = [
              Math.max(first[0], second[0]),
              Math.max(first[1], second[1]),
              Math.min(first[2], second[2]),
              Math.min(first[3], second[3])
            ];
            return box[0] <= box[2] && box[1] <= box[3] ? box : EMPTY_CLIP;
          }



          function getTextColor() {
            const mode = Number(
              current.textRenderingMode ?? 0
            );

            const usesFill =
              mode === 0 ||
              mode === 2 ||
              mode === 4 ||
              mode === 6;

            const usesStroke =
              mode === 1 ||
              mode === 2 ||
              mode === 5 ||
              mode === 6;

            if (usesFill) {
              const color = getColor('fill');

              if (color) {
                return color;
              }
            }

            if (usesStroke) {
              const color = getColor('stroke');

              if (color) {
                return color;
              }
            }

            return null;
          }

          function getColor(colorType) {
            let alpha = current[`${colorType}Alpha`];
            let colorArray = alpha == 0 || !current[`${colorType}RGBColor`]?.length ? [] : [...current[`${colorType}RGBColor`], ...(alpha == 1 ? [] : [alpha])];
            if (colorArray.length) {
              let color = colorArray.length ? (colorArray.length > 3 ? 'rgba' : 'rgb') + `(${colorArray.toString()})` : null;
              return color;
            }
            return null;
          }

          function isDefaultTransformMatrix(transformMatrix) {
            return JSON.stringify(transformMatrix) == JSON.stringify(_defaultTransformMatrix);
          }

          function getPathPageBBox(bbox: number[], matrix: number[]): number[] | null {
            if (bbox.length < 4 || !bbox.slice(0, 4).every(Number.isFinite)) {
              return null;
            }
            const [x1, y1, x2, y2] = bbox;
            if (isDefaultTransformMatrix(matrix)) {
              return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
            }
            const corners = [
              applyTransformFn([x1, y1], matrix),
              applyTransformFn([x2, y1], matrix),
              applyTransformFn([x2, y2], matrix),
              applyTransformFn([x1, y2], matrix)
            ];
            const xs = corners.map((corner: number[]) => corner[0]);
            const ys = corners.map((corner: number[]) => corner[1]);
            return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
          }

          // Rectangular paths drawn with both fill and stroke (fillStroke / closeFillStroke).
          // They are not included in the rectangles (which are fill-only), so we copy them separately:
          // They are needed only to fill the cells in the output and do not affect the grid in any way.
          function collectFilledRectangles(
            ops: number[],
            coords: number[],
            fillColor: string | null,
            strokeColor: string | null
          ) {
            if (!fillColor) {
              return;
            }

            const coordCountFor = (op: number): number => {
              if (op === OPS.rectangle) return 4;
              if (op === OPS.moveTo || op === OPS.lineTo) return 2;
              if (op === OPS.curveTo) return 6;
              if (op === OPS.curveTo2 || op === OPS.curveTo3) return 4;
              return 0;
            };

            const extracted = extractClosedSubpathRectangles(ops, coords, OPS);
            let coordIdx = 0;

            for (const op of extracted.ops) {
              if (op !== OPS.rectangle) {
                coordIdx += coordCountFor(op);
                continue;
              }

              let rx = extracted.coords[coordIdx++];
              let ry = extracted.coords[coordIdx++];
              const rwidth = extracted.coords[coordIdx++];
              const rheight = extracted.coords[coordIdx++];

              let x2 = rx + rwidth;
              let y2 = ry + rheight;

              if (!isDefaultTransformMatrix(transformMatrix)) {
                [rx, ry] = applyTransformFn([rx, ry], transformMatrix);
                [x2, y2] = applyTransformFn([x2, y2], transformMatrix);
              }

              const x = Math.min(rx, x2);
              const y = Math.min(ry, y2);
              const width = Math.abs(x2 - rx);
              const height = Math.abs(y2 - ry);

              // Thin stripes are lines, not fills
              if (Math.min(width, height) < lineMaxWidth) {
                continue;
              }

              // We do not consider the background of the entire page to be a cell fill
              const isFullPageRect =
                Math.abs(width - pageWidth) < 1 &&
                Math.abs(height - pageHeight) < 1 &&
                Math.abs(x) < 1 &&
                Math.abs(y) < 1;
              if (isFullPageRect) {
                continue;
              }

              filledRectangles.push({ x, y, width, height, fillColor, strokeColor });
            }
          }

          // ===== END OF HELPERS =====

          // ===== BULLETPROOF OPS + getOperatorList =====
          const OPS = pdfjs?.OPS || _OPS;

          // Normalize to regular arrays (Node.js can return an Int32Array)
          const _fnArray = Array.from(opList.fnArray || []);
          const _argsArray = Array.from(opList.argsArray || []);

          let constructPathCount = 0;
          let rectOutsideLogged = 0;
          let outlineLogged = 0;

          const DEBUG_DUMP_CONTENT = true;
          if (DEBUG_DUMP_CONTENT) {
            let content = opList.fnArray
              .map(item => Object.keys(OPS).find(key => OPS[key] == item))
              .map((item, index) => {
                let args = opList.argsArray[index];
                let operation = item;
                if (operation == "showText") {
                  args = args.map(el => el.map(e => e.unicode).join('')).join('')
                }
                return [operation, args]
              });
            //let outputPath = Path.resolve('./tmp/page-items.json');
            //Fs.writeFileSync(outputPath, JSON.stringify(content), 'utf-8');
            console.log('CONTENT', content);
            // pairArraysToAlignedSegments([oldArr, newArr], { compareKeys: ['0'] }).map(item => {
            //   let isEq = JSON.stringify(item[0]?.[1]) == JSON.stringify(item[1]?.[1]);
            //   return [item[0]?.[0], ...(isEq ? [item[0][1]] : [item[0]?.[1], item[1]?.[1]])]
            // });
          }

          for (let i = 0; i < _fnArray.length; i++) {
            if (i > 0 && i % 500 === 0) {
              await yieldToMain();
            }
            const fn = _fnArray[i];
            const args: any = _argsArray[i];


            //debugging: Object.keys(OPS).find(item=>OPS[item] == opList.fnArray[33])
            //opList.fnArray.map(item=>Object.keys(OPS).find(key=>OPS[key] == item))
            if (fn === OPS.constructPath) {
              constructPathCount++;
              current['pathConstructed'] = true;

              let pathOps: number[] = [];
              let pathCoords: number[] = [];

              // Normalize args to an array (fake worker in Node.js likes Array-like objects)
              var normArgs = Array.isArray(args) ? args : extractArrayLike(args);

              // automatic detection of the constructPath format
              // Old format: normArgs = [opsArray, coordsArray]
              // New format: normArgs = [strokeFillOp<number>, pathSegments<Array|Array-like>, bbox<Object|Array-like>]
              var isNewFormat = typeof normArgs[0] === 'number';
              var paintType = isNewFormat ? normArgs[0] : null;
              const isPaintlessPath = isNewFormat && (
                paintType === OPS.clip ||
                paintType === OPS.eoClip ||
                paintType === OPS.endPath
              );
              let edgesStartIdx = edges.length;
              let rectsStartIdx = rectangles.length;

              if (debugTrace) {
                for (let edgeIndex = edgesStartIdx; edgeIndex < edges.length; edgeIndex++) {
                  edges[edgeIndex].__pdfTraceOpIndex = i;
                }
                for (let rectIndex = rectsStartIdx; rectIndex < rectangles.length; rectIndex++) {
                  rectangles[rectIndex].__pdfTraceOpIndex = i;
                }
              }

              if (isNewFormat) {
                // Automatic detection of the constructPath format
                // pdfjs 4.x: [paintType, segments, bbox] — segments contain new path codes 0-4
                // pdfjs 6.x: [paintType, ops, coords, bbox?] — ops contain old OPS codes (13,14,15,18,19...)
                var rawSecond = extractArrayLike(normArgs[1]);
                var rawThird = extractArrayLike(normArgs[2]);

                var isPdfjs6Format = (
                  rawSecond.length > 0 &&
                  rawSecond.every(v => typeof v === 'number') &&
                  rawThird.length > 0 &&
                  rawThird.every(v => typeof v === 'number') &&
                  rawSecond.some(v => v >= 13 && v <= 19) // old OPS: moveTo=13, lineTo=14, curveTo=15, closePath=18, rectangle=19
                );

                let bboxArr: number[] = []
                if (isPdfjs6Format) {
                  // pdfjs 6.x: [paintType, ops<number[]>, coords<number[]>, bbox?]
                  pathOps = rawSecond;
                  pathCoords = rawThird;
                  bboxArr = normArgs.length >= 4 ? extractArrayLike(normArgs[3]) : [];

                  if (bboxArr.length >= 4) {
                    var rx = bboxArr[0];
                    var ry = bboxArr[1];
                    var rwidth = bboxArr[2] - bboxArr[0];
                    var rheight = bboxArr[3] - bboxArr[1];
                    if (rwidth > 0 && rheight > 0) {
                      pathOps.push(OPS.rectangle);
                      pathCoords.push(rx, ry, rwidth, rheight);
                    }
                  }
                } else {
                  // ===== pdfjs 4.x: [paintType, segments, bbox] =====
                  var segments: any[] = [];
                  if (Array.isArray(normArgs[1])) {
                    segments = normArgs[1];
                  } else if (normArgs[1] && typeof normArgs[1] === 'object') {
                    var seg = extractArrayLike(normArgs[1]);
                    if (seg.length > 0 && typeof seg[0] === 'object') {
                      segments = seg;
                    } else if (seg.length > 0 && typeof seg[0] === 'number') {
                      // flat array [op, x, y, ...] inside args[1]
                      segments = [seg];
                    }
                  }

                  var pathData: number[] = [];
                  for (var s = 0; s < segments.length; s++) {
                    var segArr = extractArrayLike(segments[s]);
                    for (var k = 0; k < segArr.length; k++) {
                      pathData.push(segArr[k]);
                    }
                  }

                  // Mapping pdf.js DrawOPS → old OPS: 0=moveTo, 1=lineTo, 2=curveTo, 3=quadraticCurveTo, 4=closePath
                  var idx = 0;
                  while (idx < pathData.length) {
                    var newOp = pathData[idx++];
                    if (newOp === 0) {// moveTo
                      if (idx + 1 < pathData.length) {
                        pathOps.push(OPS.moveTo);
                        pathCoords.push(pathData[idx++], pathData[idx++]);
                      }
                    } else if (newOp === 1) {// lineTo
                      if (idx + 1 < pathData.length) {
                        pathOps.push(OPS.lineTo);
                        pathCoords.push(pathData[idx++], pathData[idx++]);
                      }
                    } else if (newOp === 2) {
                      // cubic curve — leave this as a real operation so that the current point moves to its end
                      if (idx + 5 < pathData.length) {
                        pathOps.push(OPS.curveTo);
                        pathCoords.push(
                          pathData[idx],
                          pathData[idx + 1],
                          pathData[idx + 2],
                          pathData[idx + 3],
                          pathData[idx + 4],
                          pathData[idx + 5]
                        );
                      }
                      idx += 6;// curveTo — skip (6 coordinates), the old loop can't
                    } else if (newOp === 3) {
                      // quadratic curve (x1, y1, x, y)
                      if (idx + 3 < pathData.length) {
                        pathOps.push(OPS.curveTo2);
                        pathCoords.push(pathData[idx], pathData[idx + 1], pathData[idx + 2], pathData[idx + 3]);
                      }
                      idx += 4;// quadraticCurveTo — skip (4 coordinates)
                    } else if (newOp === 4) {// closePath
                      pathOps.push(OPS.closePath);
                    }
                  }

                  // Restoring rectangle from bbox (args[2])
                  bboxArr = extractArrayLike(normArgs[2]);

                  if (isNewFormat && paintType != null && paintType !== OPS.endPath) {
                    const isFillOnlyPaint = paintType === OPS.fill || paintType === OPS.eoFill;
                    if (isFillOnlyPaint) {
                      const round = (value: any): any => (Number.isFinite(Number(value)) ? +Number(value).toFixed(2) : value);
                      const beforeOps = [...pathOps];
                      const beforeCoords = [...pathCoords];
                      // The cell background is often drawn using a single fill path consisting of dozens of sub‑rectangles;
                      // each represents the geometry of a separate cell (including merged rowspan/colspan). 
                      const extracted = extractClosedSubpathRectangles(pathOps, pathCoords, OPS);
                      pathOps = extracted.ops;
                      pathCoords = extracted.coords;
                    }
                  }

                  // minMax (bbox) — path metadata, not drawn geometry.
                  // Add only if the path itself did not provide any segments
                  // (for example, the path consisted only of skipped curves).
                  if (isNewFormat && bboxArr.length >= 4 && !pathOps.includes(OPS.rectangle) && !pathOps.includes(OPS.lineTo)) {
                    const rx = bboxArr[0];
                    const ry = bboxArr[1];
                    const rw = bboxArr[2] - bboxArr[0];
                    const rh = bboxArr[3] - bboxArr[1];
                    if (rw > 0 && rh > 0) {
                      pathOps.push(OPS.rectangle);
                      pathCoords.push(rx, ry, rw, rh);
                    }
                  }
                }
              } else {
                // Old format (pdfjs 3.x and below)
                pathOps = Array.isArray(normArgs[0]) ? normArgs[0] : extractArrayLike(normArgs[0]);
                pathCoords = Array.isArray(normArgs[1]) ? normArgs[1] : extractArrayLike(normArgs[1]);
              }

              //pdfjs 6.x: emulating the old rectangle behavior ---
              // In pdfjs 6.x, constructPath with paintType=fill sends the path as
              // moveTo + lineTo + closePath + bbox rectangle. lineTo generate
              // extra edges (3 pieces per element), which were not present in pdfjs 3.x.
              // If pathData describes a rectangle and there is a bbox rectangle,
              // replacing it with the old format [rectangle, closePath].
              if (isNewFormat && paintType != null && paintType !== OPS.endPath) {
                let hasRectFromBbox = pathOps.includes(OPS.rectangle);
                let hasLineTo = pathOps.includes(OPS.lineTo);
                if (hasRectFromBbox && hasLineTo) {
                  let rectCoords = pathCoords.slice(-4);
                  pathOps = [OPS.rectangle, OPS.closePath];
                  pathCoords = [...rectCoords];
                }
              }

              const moveCurrentPointTo = (pointX: number, pointY: number): void => {
                let x = pointX;
                let y = pointY;
                if (!isDefaultTransformMatrix(transformMatrix)) {
                  [x, y] = applyTransformFn([x, y], transformMatrix);
                }
                current['x'] = x;
                current['y'] = y;
                current['subpathHasCurve'] = true;
              };

              let coordIdx = 0;

              const pathBBoxSource = isPdfjs6Format ? normArgs[3] : normArgs[2];
              const pathBBox =
                isNewFormat && pathBBoxSource
                  ? getPathPageBBox(Array.from(extractArrayLike(pathBBoxSource)), transformMatrix)
                  : null;

              if (
                !isPaintlessPath &&
                pathBBox &&
                current.clipBox &&
                !boxesIntersect(pathBBox, current.clipBox, CLIP_TOLERANCE)
              ) {
                clippedAwayCount++;
                current.pendingClip = false;
                continue; // The active clip does not allow this path through: there is nothing to draw
              }

              // The path is drawn with a stroke -> the closing segment (closePath) is also visible
              const strokesPath =
                isNewFormat &&
                (paintType === OPS.stroke ||
                  paintType === OPS.closeStroke ||
                  paintType === OPS.fillStroke ||
                  paintType === OPS.eoFillStroke ||
                  paintType === OPS.closeFillStroke ||
                  paintType === OPS.closeEOFillStroke);

              const fillsPath = isNewFormat && (paintType === OPS.fill || paintType === OPS.eoFill);

              for (let j = 0; j < pathOps.length; j++) {
                const op = pathOps[j];
                if (op === OPS.rectangle) {
                  if (coordIdx + 3 >= pathCoords.length) break;
                  let rx = pathCoords[coordIdx++];
                  let ry = pathCoords[coordIdx++];
                  let rwidth = pathCoords[coordIdx++];
                  let rheight = pathCoords[coordIdx++];

                  let x2 = rx + rwidth;
                  let y2 = ry + rheight;
                  // Apply transform matrix to coordinates
                  if (!isDefaultTransformMatrix(transformMatrix)) {//BUGFIX earlier worked only for 07-multi-table, in 10-example the figures were shifted 
                    [rx, ry] = applyTransformFn([rx, ry], transformMatrix);
                    [x2, y2] = applyTransformFn([x2, y2], transformMatrix);
                  }
                  // CTM with reflection along Y (typical “inverted” cm) yields negative width/height
                  // We convert to the canonical bbox; otherwise, containment checks
                  // further down the pipeline silently discard such rectangles.
                  rwidth = Math.abs(x2 - rx);
                  rheight = Math.abs(y2 - ry);
                  rx = Math.min(rx, x2);
                  ry = Math.min(ry, y2);
                  let vector = { y: ry, x: rx, width: rwidth, height: rheight, transform: transformMatrix };

                  const bboxTolerance = Math.max(2, (current.lineWidth || 0) * 2);
                  if (pathBBox && !isRectangleWithinBox(rx, ry, rwidth, rheight, pathBBox, bboxTolerance)) {
                    if (rectOutsideLogged < 5) {
                      rectOutsideLogged++;
                      const round = (value: any): any => (Number.isFinite(Number(value)) ? +Number(value).toFixed(2) : value);
                    }
                    continue; // прямоугольник испорчен реконструкцией
                  }
                  // We skip the full‑size background rectangles/page cropping
                  let isFullPageRect =
                    Math.abs(rwidth - pageWidth) < 1 &&
                    Math.abs(rheight - pageHeight) < 1 &&
                    Math.abs(rx) < 1 &&
                    Math.abs(ry) < 1;

                  // A WHITE fill covering almost the whole page is a page background. The exact-size
                  // check above misses it when the background is drawn for another paper size
                  // (here 595.45 wide on a 612 wide page). Such a rectangle would otherwise glue
                  // the table to everything else on the page (headers, footers).
                  const fillRGB = current.fillRGBColor || [];
                  const isWhiteFill = fillRGB.length >= 3 && fillRGB.slice(0, 3).every(channel => channel >= 250);
                  const isFillOnly = isNewFormat && (paintType === OPS.fill || paintType === OPS.eoFill);
                  const coversMostOfPage =
                    rwidth >= pageWidth * 0.9 &&
                    rheight >= pageHeight * 0.9 &&
                    Math.abs(rx) <= pageWidth * 0.05 &&
                    Math.abs(ry) <= pageHeight * 0.05;

                  if (isFullPageRect || (coversMostOfPage && isFillOnly && isWhiteFill)) {
                    current['vectorCache'] = vector;
                    current['vectorType'] = 'rectangle';
                    continue;// do not add to rectangles / edges
                  }

                  let vectorType = Math.min(Math.abs(rwidth), Math.abs(rheight)) < lineMaxWidth ? 'edge' : 'rectangle';
                  let vectors = vectorType == 'rectangle' ? rectangles : edges;

                  if (!isPaintlessPath) {
                    if (vectorType == 'rectangle') {
                      //fake edges
                      let borderSize = getAverageBorderSize(edges || [], lineMaxWidth);
                      rectanglesEdges = uniqueArr(
                        [...(rectanglesEdges || []), ...createLinesFromRectangle(vector, borderSize)],
                        ['x', 'y', 'width', 'height']
                      );
                    }

                    vectors.push(vector);
                  }
                  current['vectorCache'] = vector;
                  current['vectorType'] = vectorType;
                } else if (op === OPS.moveTo) {
                  if (coordIdx + 1 >= pathCoords.length) break;
                  let mx = pathCoords[coordIdx++];
                  let my = pathCoords[coordIdx++];
                  if (!isDefaultTransformMatrix(transformMatrix)) {
                    [mx, my] = applyTransformFn([mx, my], transformMatrix);
                  }
                  let vector = { x: mx, y: my };
                  current['vectorCache'] = vector;
                  current['x'] = mx;
                  current['x'] = mx;
                  current['y'] = my;
                  current['subpathStartX'] = mx;
                  current['subpathStartY'] = my;
                  current['subpathHasCurve'] = false;
                } else if (op === OPS.lineTo) {
                  if (coordIdx + 1 >= pathCoords.length) break;
                  let lx = pathCoords[coordIdx++];
                  let ly = pathCoords[coordIdx++];

                  // Apply transform matrix to coordinates
                  if (!isDefaultTransformMatrix(transformMatrix)) {
                    [lx, ly] = applyTransformFn([lx, ly], transformMatrix);
                  }
                  let vector;
                  let lineWidth = current['lineWidth'];
                  if (current['x'] == lx) {
                    vector = { y: Math.min(ly, current['y']), x: lx - lineWidth / 2, width: lineWidth, height: Math.abs(ly - current['y']), transform: transformMatrix };
                  } else if (current['y'] == ly) {
                    vector = { x: Math.min(lx, current['x']), y: ly - lineWidth / 2, height: lineWidth, width: Math.abs(lx - current['x']), transform: transformMatrix };
                  } else {//BUGFIX?
                    vector = { x: Math.min(lx, current['x']), y: Math.min(ly, current['y']), height: Math.abs(ly - current['y']), width: Math.abs(lx - current['x']), transform: transformMatrix };
                  }

                  if (vector) {
                    // In the old format, stroke is a separate operation, so we remember the color immediately.
                    // In the new format, colors are applied centrally via paintType
                    if (!isNewFormat) {
                      let colorType = 'stroke';
                      let color = getColor(colorType);
                      if (color) {
                        Object.assign(vector, { [`${colorType}Color`]: color });
                      }
                    }

                    let isPageBoundary = false;
                    let tol = 1.0;

                    // A horizontal line at the top/bottom edge of the page
                    if (vector.height < lineMaxWidth && vector.width > pageWidth * 0.9) {
                      let centerY = vector.y + vector.height / 2;
                      if (Math.abs(centerY) < tol || Math.abs(centerY - pageHeight) < tol) {
                        isPageBoundary = true;
                      }
                    }
                    // A vertical line at the left/right edge of the page
                    if (vector.width < lineMaxWidth && vector.height > pageHeight * 0.9) {
                      let centerX = vector.x + vector.width / 2;
                      if (Math.abs(centerX) < tol || Math.abs(centerX - pageWidth) < tol) {
                        isPageBoundary = true;
                      }
                    }

                    // A diagonal segment whose bounding box is bigger than a line width in BOTH directions is not
                    // a table rule. It comes from curves / rounded corners (e.g. the drop shadow of a frame), and
                    // such a box can span half of the page and glue unrelated parts of it into one group.
                    const isDiagonal = current['x'] != lx && current['y'] != ly;
                    const isLargeDiagonal = isDiagonal && vector.width > lineMaxWidth && vector.height > lineMaxWidth;

                    if (!isPageBoundary && !isLargeDiagonal) {//&& !isPaintlessPath BUG sales_order.pdf 
                      edges.push(vector);
                    }
                    current['vectorType'] = 'edge';
                    current['x'] = lx;
                    current['y'] = ly;



                  } else {
                    //unexpected behavior
                  }


                } else if (op === OPS.curveTo) {
                  if (coordIdx + 5 >= pathCoords.length) break;
                  moveCurrentPointTo(pathCoords[coordIdx + 4], pathCoords[coordIdx + 5]);
                  coordIdx += 6;// skip the 6 coordinates of the Bezier curve
                } else if (op === OPS.curveTo2 || op === OPS.curveTo3) {
                  if (coordIdx + 3 >= pathCoords.length) break;
                  moveCurrentPointTo(pathCoords[coordIdx + 2], pathCoords[coordIdx + 3]);
                  coordIdx += 4;// skipping 4 coordinates
                } else if (op === OPS.closePath) {
                  // The closing segment of a subpath, drawn with a dashed line.
                  // Only horizontal/vertical segments; we leave fill-only paths untouched.
                  if (
                    (strokesPath || (fillsPath && current['subpathHasCurve'])) &&
                    Number.isFinite(current['subpathStartX']) &&
                    Number.isFinite(current['x'])
                  ) {
                    const startX = current['subpathStartX'];
                    const startY = current['subpathStartY'];
                    const lineWidth = current['lineWidth'];
                    let closingVector: any = null;

                    if (current['x'] == startX && current['y'] != startY) {
                      closingVector = {
                        y: Math.min(startY, current['y']),
                        x: startX - lineWidth / 2,
                        width: lineWidth,
                        height: Math.abs(startY - current['y']),
                        transform: transformMatrix,
                      };
                    } else if (current['y'] == startY && current['x'] != startX) {
                      closingVector = {
                        x: Math.min(startX, current['x']),
                        y: startY - lineWidth / 2,
                        height: lineWidth,
                        width: Math.abs(startX - current['x']),
                        transform: transformMatrix,
                      };
                    }

                    if (closingVector) {
                      // The same protection against lines at the edge of the page as in `lineTo`
                      const boundaryTolerance = 1.0;
                      let isPageBoundary = false;

                      if (closingVector.height < lineMaxWidth && closingVector.width > pageWidth * 0.9) {
                        const centerY = closingVector.y + closingVector.height / 2;
                        if (
                          Math.abs(centerY) < boundaryTolerance ||
                          Math.abs(centerY - pageHeight) < boundaryTolerance
                        ) {
                          isPageBoundary = true;
                        }
                      }
                      if (closingVector.width < lineMaxWidth && closingVector.height > pageHeight * 0.9) {
                        const centerX = closingVector.x + closingVector.width / 2;
                        if (
                          Math.abs(centerX) < boundaryTolerance ||
                          Math.abs(centerX - pageWidth) < boundaryTolerance
                        ) {
                          isPageBoundary = true;
                        }
                      }

                      if (!isPageBoundary) {
                        edges.push(closingVector);
                      }

                      current['x'] = startX;
                      current['y'] = startY;
                    }
                  }

                  current['vectorCache'] = null;
                }
              }



              // applying colors from paintType (pdfjs 4.x+) ---
              if (isNewFormat && paintType != null) {
                let shouldFill = (
                  paintType === OPS.fill ||
                  paintType === OPS.eoFill ||
                  paintType === OPS.fillStroke ||
                  paintType === OPS.eoFillStroke ||
                  paintType === OPS.closeFillStroke ||
                  paintType === OPS.closeEOFillStroke
                );
                let shouldStroke = (
                  paintType === OPS.stroke ||
                  paintType === OPS.closeStroke ||
                  paintType === OPS.fillStroke ||
                  paintType === OPS.eoFillStroke ||
                  paintType === OPS.closeFillStroke ||
                  paintType === OPS.closeEOFillStroke
                );

                if (shouldFill) {
                  let color = getColor('fill');
                  if (color) {
                    for (let vi = rectsStartIdx; vi < rectangles.length; vi++) {
                      rectangles[vi].fillColor = color;
                    }
                    for (let vi = edgesStartIdx; vi < edges.length; vi++) {
                      if (!edges[vi].fillColor) edges[vi].fillColor = color;
                    }
                  }
                }
                if (shouldStroke) {
                  let color = getColor('stroke');
                  if (color) {
                    for (let vi = edgesStartIdx; vi < edges.length; vi++) {
                      edges[vi].strokeColor = color;
                    }
                    for (let vi = rectsStartIdx; vi < rectangles.length; vi++) {
                      if (!rectangles[vi].strokeColor) rectangles[vi].strokeColor = color;
                    }
                  }
                }
                // Closed rectangular path with fill and stroke
                if (shouldFill && shouldStroke) {
                  collectFilledRectangles(
                    pathOps,
                    pathCoords,
                    getColor('fill'),
                    getColor('stroke')
                  );
                }
              }


              if (current.pendingClip) {
                if (pathBBox) {
                  current.clipBox = current.clipBox ? intersectBoxes(current.clipBox, pathBBox) : pathBBox;
                }
                current.pendingClip = false;
              }

            } else if (fn === OPS.save) {
              transformStack.push({
                transformMatrix: [...transformMatrix],
                fillRGBColor: [...(current.fillRGBColor || [])],
                strokeRGBColor: [...(current.strokeRGBColor || [])],
                fillAlpha: current.fillAlpha,
                strokeAlpha: current.strokeAlpha,
                lineWidth: current.lineWidth,
                colorType: current.colorType,
                // text state — a part of the graphics state; q/Q saves/restores it
                charSpacing: current.charSpacing,
                wordSpacing: current.wordSpacing,
                textRenderingMode: current.textRenderingMode,
                leading: current.leading,
                fontName: current.fontName,
                fontSize: current.fontSize,
                fontDirection: current.fontDirection,
                contentItem: JSON.parse(JSON.stringify(current.contentItem || {})),
                clipBox: current.clipBox ? [...current.clipBox] : null,
              });
              current['vectorType'] = null;
              current['vectorCache'] = null;
            } else if (fn === OPS.restore) {
              const savedState = transformStack.pop();
              if (savedState) {
                transformMatrix = [...savedState.transformMatrix];
                current.fillRGBColor = [...(savedState.fillRGBColor || [])];
                current.strokeRGBColor = [...(savedState.strokeRGBColor || [])];
                current.fillAlpha = savedState.fillAlpha;
                current.strokeAlpha = savedState.strokeAlpha;
                current.lineWidth = savedState.lineWidth;
                current.colorType = savedState.colorType;
                current.charSpacing = savedState.charSpacing;
                current.wordSpacing = savedState.wordSpacing;
                current.textRenderingMode = savedState.textRenderingMode;
                current.leading = savedState.leading;
                current.clipBox = savedState.clipBox;
                current.pendingClip = false;
                // We restore the font only if it had already been set at the time of `q`:
                // PDF, which (incorrectly) relies on Tf inside q..Q, will continue to work as before.
                if (savedState.fontName != null && savedState.fontSize != null) {
                  current.fontName = savedState.fontName;
                  current.fontSize = savedState.fontSize;
                  current.fontDirection = savedState.fontDirection;
                  if (savedState.contentItem?.transform) {
                    current.contentItem = savedState.contentItem;
                  }
                }
              }
              current['vectorType'] = null;
              current['vectorCache'] = null;
            } else if (fn === OPS.clip || fn === OPS.eoClip) {
              // pdf.js places the clip operation BEFORE constructPath, which completes it
              current.pendingClip = true;
            } else if (fn === OPS.paintFormXObjectBegin) {
              clipBoxStack.push(current.clipBox ? [...current.clipBox] : null);
            } else if (fn === OPS.paintFormXObjectEnd) {
              current.clipBox = clipBoxStack.length ? clipBoxStack.pop() ?? null : current.clipBox;
            } else if (fn === OPS.transform) {
              var normTransformArgs = normalizeNumericArgs(args);
              transformMatrix = transformFn(transformMatrix, normTransformArgs);
            } else if (fn === OPS.beginText) {
              // According to the PDF specification (ISO 32000, §9.4.1), at the beginning of each text
              // object (BT), the text matrix (Tm) must be reset to
              // one—regardless of what remains from the previous
              // text object. Previously, this statement was not processed at all,
              // so textMatrix simply inherited the value from the last
              // BT/ET on the page (which broke watermark.pdf, where the table appears in its own
              // BT immediately after the rotated/scaled watermark BT).
              //
              // IMPORTANT: We’re only modifying textMatrix here. current[‘pathConstructed’]
              // does not need to be added here—this variable has nothing to do with
              // the boundaries of text objects as specified in the spec, but is used in
              // showText by a separate narrow heuristic (suppressing hasEOT for
              // duplicate text between the same pair of elements).
              // Resetting it on every BT caused this heuristic to trigger almost
              // on every cell in files where each table cell has its own
              // separate BT without a vector-path inside (sales_order.pdf)—adjacent
              // cells in different columns began to be incorrectly merged with
              // each other.
              textMatrix = JSON.parse(JSON.stringify(_defaultTransformMatrix));
              current.textRunAdvance = 0; // NEW
              //current['pathConstructed'] = false;
            } else if (fn === OPS.setTextMatrix) {
              // This reset of the text matrix marks the natural end
              // of the previous string chain (a new Td block indicates that the previous
              // rotated/wrapped header has ended), so here
              // it is safe to flush everything that is stuck in the cache.
              //flushStaleTableContentItemsCache();

              let norm = normalizeNumericArgs(args);
              if (norm.length >= 6) {
                textMatrix = norm;

                // In PDF, textMatrix(Tm) sets the position/orientation without font size.
                // We combine Tm with the current fontSize so that the transform includes full scaling.
                let fs = current.fontSize || 1;
                current.contentItem.transform = [
                  norm[0] * fs, norm[1] * fs,
                  norm[2] * fs, norm[3] * fs,
                  norm[4], norm[5]
                ];

                current['pathConstructed'] = true;
                current.textRunAdvance = 0;
              }
            } else if (fn === OPS.stroke) {
              let vectorType = current['vectorType'];
              let vectors = vectorType == 'rectangle' ? rectangles : edges;
              let vector = vectors[vectors.length - 1];
              if (vector) {
                let colorType = 'stroke';
                let color = getColor(colorType);
                if (color) {
                  Object.assign(vector, { [`${colorType}Color`]: color });
                }
              }
            } else if (fn === OPS.fill) {
              let vectorType = current['vectorType'];
              let vectors = vectorType == 'rectangle' ? rectangles : edges;
              let vector = vectors[vectors.length - 1];

              if (vector) {
                let colorType = 'fill';
                let color = getColor(colorType);
                if (color) {
                  Object.assign(vector, { [`${colorType}Color`]: color });
                }
              }
            } else if (fn === OPS.setTextRenderingMode) {
              current.textRenderingMode =
                normalizeNumericArgs(args)[0] ?? 0;
            } else if (fn === OPS.setStrokeRGBColor) {
              current.strokeRGBColor = normalizeColorArgs(args);
              current.colorType = 'stroke';
            } else if (fn === OPS.setFillRGBColor) {
              current.fillRGBColor = normalizeColorArgs(args);
              current.colorType = 'fill';
            } else if (fn === OPS.setStrokeGray) {
              const color = normalizeGenericColorArgs(args);

              if (color.length === 3) {
                current.strokeRGBColor = color;
              }

              current.colorType = 'stroke';
            } else if (fn === OPS.setFillGray) {
              const color = normalizeGenericColorArgs(args);

              if (color.length === 3) {
                current.fillRGBColor = color;
              }

              current.colorType = 'fill';
            } else if (fn === OPS.setStrokeCMYKColor) {
              const color = normalizeGenericColorArgs(args);

              if (color.length === 3) {
                current.strokeRGBColor = color;
              }

              current.colorType = 'stroke';
            } else if (fn === OPS.setFillCMYKColor) {
              const color = normalizeGenericColorArgs(args);

              if (color.length === 3) {
                current.fillRGBColor = color;
              }

              current.colorType = 'fill';
            } else if (fn === OPS.setStrokeColor) {
              const color = normalizeGenericColorArgs(args);

              if (color.length === 3) {
                current.strokeRGBColor = color;
              }

              current.colorType = 'stroke';
            } else if (fn === OPS.setFillColor) {
              const color = normalizeGenericColorArgs(args);

              if (color.length === 3) {
                current.fillRGBColor = color;
              }

              current.colorType = 'fill';

            } else if (fn === OPS.setGState) {
              // pdf.js transmits args in different formats: [Map], [[name, {ca:0.2}]], [{ca:0.2}], etc.
              // Doing brute-force: recursively searching for ca/CA in ANY structure.
              function extractAlpha(val) {
                if (val == null || typeof val === 'number' || typeof val === 'boolean') return;
                if (typeof val === 'string') {
                  if (val === 'ca') lastKey = 'ca';
                  if (val === 'CA') lastKey = 'CA';
                  return;
                }
                if (val instanceof Map) {
                  val.forEach((v, k) => {
                    if (k === 'ca' || k === 'CA') {
                      let target = k === 'ca' ? 'fillAlpha' : 'strokeAlpha';
                      current[target] = v;
                    }
                  });
                  return;
                }
                if (Array.isArray(val)) {
                  val.forEach((item) => {
                    if (typeof item === 'string' && (item === 'ca' || item === 'CA')) {
                      lastKey = item;
                    } else if (lastKey != null && typeof item === 'number') {
                      let target = lastKey === 'ca' ? 'fillAlpha' : 'strokeAlpha';
                      current[target] = item;
                      lastKey = null;
                    } else {
                      extractAlpha(item);
                    }
                  });
                  return;
                }
                if (typeof val === 'object') {
                  for (let k in val) {
                    if (k === 'ca') current['fillAlpha'] = val[k];
                    if (k === 'CA') current['strokeAlpha'] = val[k];
                  }
                  return;
                }
              }
              let lastKey = null;
              args.forEach((arg) => extractAlpha(arg));
            } else if (fn === OPS.setLineWidth) {
              current['lineWidth'] = args[0];
            } else if (fn === OPS.eoFill) {
              let vectorType = current['vectorType'];
              let vectors = vectorType == 'rectangle' ? rectangles : edges;
              let vector = vectors[vectors.length - 1];
              let isFilled = isEdgeFilledEvenOdd(current.vectorCache, vector, edges);
              if (vector && isFilled) {
                let savedAlpha = vector._fillAlpha !== undefined ? vector._fillAlpha : current.fillAlpha;
                let originalAlpha = current.fillAlpha;
                current.fillAlpha = savedAlpha;
                let colorType = 'fill';
                let color = getColor(colorType);
                current.fillAlpha = originalAlpha;
                if (color) {
                  Object.assign(vector, { [`${colorType}Color`]: color });
                }
              }
            } else if (fn === OPS.paintImageXObject) {
              tableContentItems.push({ width: transformMatrix[0], height: transformMatrix[3], transform: transformMatrix, imageName: args[0], hasEOT: true });
            } else if (fn === OPS.setCharSpacing) {
              current.charSpacing = args[0];
            } else if (fn === OPS.setWordSpacing) {
              current.wordSpacing = args[0];
            } else if (fn === OPS.setFont) {
              //flushStaleTableContentItemsCache();

              let [fontName, fontSize] = normalizeFontArgs(args);

              // The old reset always constructed a transform from [fontSize, 0, 0, fontSize]
              // + a translation from CTM (transformMatrix)—that is, it discarded the scale
              // and rotation already contained in the current Tm (textMatrix). This
              // goes unnoticed almost everywhere, because it’s almost always followed by
              // a real `setTextMatrix` call, which recalculates everything from scratch.
              // But when a font change is accompanied only by `Td`/`TD` without a new `Tm`
              // (as in the bold final line “ODISHA,” which continues to
              // be rendered at the scale of the previous numeric line)—resetting to CTM
              // would reset the scale to 1, effectiveHeight would collapse to ~1, and the entire
              // glyph width distribution (including the spacing between numbers)
              // would break.
              //
              // We construct the transform from the textMatrix (as setTextMatrix itself does)
              // instead of using CTM—this preserves any current scale/rotation, and
              // the subsequent actual setTextMatrix call will, as before, completely
              // overwrite it.
              let contentItem = {
                height: fontSize,
                transform: [
                  textMatrix[0] * fontSize,
                  textMatrix[1] * fontSize,
                  textMatrix[2] * fontSize,
                  textMatrix[3] * fontSize,
                  textMatrix[4],
                  textMatrix[5]
                ],
                fontName: fontName
              };
              current.contentItem = contentItem;
              if (fontSize < 0) {
                fontSize = -fontSize;
                current.fontDirection = -1;
              } else {
                current.fontDirection = 1;
              }

              current.fontName = fontName;
              current.fontSize = fontSize;
            } else if (fn === OPS.setLeadingMoveText) {
              // TD: like Td, plus the leading
              current.textRunAdvance = 0;
              // TD should behave exactly like Td (moveText) in terms of positioning—
              // the only difference is that TD also sets the leading. The old code
              // simply overrode the tail of the textMatrix with raw operator deltas instead of
              // combining them with the current absolute text matrix. As a result,
              // the textMatrix became a hybrid: scale/rotation came from the last Tm,
              // while the offset was a tiny relative delta. Further on in `showText`, this
              // was multiplied by the (correct) `contentItem.transform` and produced wild
              // coordinates for any text passing through the TD chain
              // (wrapped/rotated multi-line headings—this is exactly that case).
              var normLeadArgs = normalizeNumericArgs(args);
              current.leading = normLeadArgs[1] ?? 0;

              let textMatrixChanged = true;//old:textMatrix.toString() != _defaultTransformMatrix.toString();//!BUG without OPS.beginText watermark.pdf (no table)
              if (textMatrixChanged) {
                textMatrix = [
                  ...textMatrix.slice(0, 4),
                  ...applyTransformFn(normLeadArgs, textMatrix)
                ];
              } else {
                textMatrix = [...textMatrix.slice(0, 4), ...normLeadArgs];
              }

              let contentItem = current.contentItem;
              Object.assign(contentItem, {
                transform: [
                  ...contentItem.transform.slice(0, 4),
                  ...(textMatrixChanged ? [textMatrix[4], textMatrix[5]] : normLeadArgs)
                ]
              });
            } else if (fn === OPS.moveText) {//BUG:|| OPS.setLeadingMoveText == fn
              // Td: Tlm = translate(tx, ty) × Tlm, also while textMatrix is still the identity
              current.textRunAdvance = 0;
              var normMoveArgs = normalizeNumericArgs(args);
              let textMatrixChanged = true;//old:textMatrix.toString() != _defaultTransformMatrix.toString();
              if (textMatrixChanged) {//BUGFIX?
                textMatrix = [...textMatrix.slice(0, 4), ...applyTransformFn(normMoveArgs, textMatrix)];
              }
              let contentItem = current.contentItem;
              Object.assign(contentItem, {
                transform: [...contentItem.transform.slice(0, 4), ...(textMatrixChanged ? [textMatrix[4], textMatrix[5]] : normMoveArgs)]
              });
            } else if (fn === OPS.setLeading) {
              // TL: pdf.js stores leading with a “downward shift” sign
              current.leading = -(normalizeNumericArgs(args)[0] ?? 0);

            } else if (fn === OPS.nextLine) {
              // T*: move down by the leading
              current.textRunAdvance = 0;
              // T* (as well as “line breaks” in ' and “ statements”): the same as TD(0, -TL),
              // but the leading value does not change.
              const lineShift = [0, current.leading || 0];
              let textMatrixChanged = true;//old:textMatrix.toString() != _defaultTransformMatrix.toString();

              if (textMatrixChanged) {
                textMatrix = [
                  ...textMatrix.slice(0, 4),
                  ...applyTransformFn(lineShift, textMatrix),
                ];
              }

              let contentItem = current.contentItem;
              Object.assign(contentItem, {
                transform: [
                  ...contentItem.transform.slice(0, 4),
                  ...(textMatrixChanged ? [textMatrix[4], textMatrix[5]] : lineShift),
                ],
              });
            } else if (OPS.showText === fn) {

              var fontName = current.fontName;
              var fontSize = current.fontSize;
              var charSpacing = current.charSpacing;
              var wordSpacing = current.wordSpacing;
              var fontDirection = current.fontDirection;

              var _widthAdvanceScale = fontSize * _fontIdentityMatrix[0];
              var _vertical = pageTextContent.styles[fontName]?.vertical || false; //BUG Sometimes fonts are missing
              var _spacingDir = _vertical ? 1 : -1;


              function handleCharsArgs(options) {
                let {
                  charsArr,
                  rangeArr,
                  x,
                  y,
                  setCoordinates,
                  setCharWidth,
                  pageTransform,
                  setPageGeometry,
                  wordSpacing = current.wordSpacing,
                  charSpacing = current.charSpacing,
                  spacingDir = _spacingDir,
                  fontSize = current.fontSize,

                } = options;
                x = x || 0;
                let currentX = x;
                let str;
                let charsRangesArrays = [[], [], []];
                let widthRangesArrays = [[], [], []];
                let fontSpaceWidths = {};

                let widthAdvanceScale = fontSize * _fontIdentityMatrix[0];

                let charsArrFiltered = charsArr.filter(item => item && typeof item == 'object');

                let widthsObj = charsArr.reduce((acc, glyph, glyphIndex) => {
                  let currentWidth = 0;

                  if (glyph && typeof glyph === 'object') {
                    let width = glyph.width;
                    let character = glyph.unicode;
                    let spacing = (glyph.isSpace ? wordSpacing : 0) + charSpacing;
                    let charWidth = width * widthAdvanceScale + spacing * fontDirection;

                    if (setCoordinates) {
                      if (x) {
                        glyph['x'] = currentX;
                      }
                      if (y) {
                        glyph['y'] = y;
                      }
                    }

                    if (setCharWidth) {
                      glyph['charWidth'] = charWidth;

                      // Visible advance of the glyph: without char spacing (Tc), with word spacing (Tw)
                      // A large Tc that pushes glyphs into different table cells must show up as a gap between them.
                      glyph['advanceWidth'] =
                        width * widthAdvanceScale + (glyph.isSpace ? wordSpacing : 0) * fontDirection;

                      // The word spacing alone (scaled like everything else), see getVisibleAdvance()
                      glyph['wordSpacingWidth'] = glyph.isSpace ? wordSpacing * fontDirection : 0;
                    }

                    if (setPageGeometry && Array.isArray(pageTransform) && pageTransform.length >= 6) {
                      const [a, b, , , e, f] = pageTransform;
                      const axisLength = Math.hypot(a, b) || 1;
                      const advance = currentX - x;

                      // Actual glyph origin in the PDF page frame. `glyph.x` is an advance
                      // coordinate; for rotated text it is not the page's X coordinate.
                      glyph._pageX = e + advance * a / axisLength;
                      glyph._pageY = f + advance * b / axisLength;
                    }

                    // Add the width of the current character to the current line
                    acc.currentLineWidth += charWidth;
                    currentX += charWidth;
                    currentWidth += charWidth;

                    // If the character is a line break, add the current width to the array and reset it
                    if (glyph.isLineBreak) {
                      acc.lineWidths.push(acc.currentLineWidth);
                      acc.currentLineWidth = 0; // Reset the width for a new line
                      currentX = x;
                    }

                    // Add a character to a string and a character array
                    str = (str || '') + character;

                    if (glyph.isSpace) {
                      fontSpaceWidths[fontName] = width;
                    }
                  } else if (typeof glyph === 'number') {
                    let spaceWidth = spacingDir * glyph * fontSize / 1000;
                    acc.currentLineWidth += spaceWidth;
                    currentX += spaceWidth;
                    currentWidth += spaceWidth;
                  }

                  let charRangeIndex = (() => {
                    if (
                      rangeArr?.length &&
                      !(
                        (glyph.isSpace || glyph.isLineBreak) &&
                        (charsArrFiltered[charsArrFiltered.length - 1] == glyph)
                      )//if the last element is a space, it is taken into account
                    ) {
                      let tolerance = 0.05;
                      let start = rangeArr[0];
                      let end = rangeArr[1] + tolerance;

                      let charRangeIndexes = {
                        0: currentX < start,
                        1: (currentX >= start) && (currentX <= end),
                        2: currentX > end,
                      };

                      return Object.keys(charRangeIndexes).find(
                        item => charRangeIndexes[item]
                      );
                    } else {
                      return 1;
                    }
                  })();

                  charsRangesArrays[charRangeIndex].push(glyph);
                  widthRangesArrays[charRangeIndex].push(currentWidth);

                  return acc;
                }, {
                  lineWidths: [],
                  currentLineWidth: 0
                });

                // After completion, add the last line if it is not empty
                if (widthsObj.currentLineWidth > 0) {
                  widthsObj.lineWidths.push(widthsObj.currentLineWidth);
                }

                // Total array of row widths
                let lineWidths = widthsObj.lineWidths;
                let maxlineWidth = Math.max(...lineWidths);
                let widthRanges: Array<number> = widthRangesArrays.map(item => item.reduce((acc, val) => acc + val, 0));

                return {
                  widthRanges,
                  lineWidths,
                  maxlineWidth,
                  str,
                  charsRangesArrays,
                  fontSpaceWidths
                }
              }

              function spaceNeeded(newItem, lastItem) {
                let startSpecialCharsRegExp = /[\[\(\<\‹\'\"\`\{\«\„\‘～]/i;
                let endSpecialCharsRegExp = /[\]\)\>\›\'\"\`\}\»\”\’～,:%]/i;
                let firstWordRegExp = /^[\p{L}\w]+/gu;

                let newItemChars = clearChars({ chars: newItem?.chars || [] });
                let lastItemChars = clearChars({ chars: lastItem?.chars || [] });

                // CJK/Fullwidth text never needs spaces between characters
                let lastChar = lastItemChars?.[lastItemChars.length - 1]?.unicode || '';
                let newChar = newItemChars?.[0]?.unicode || '';
                if (isCJKChar(lastChar) && isCJKChar(newChar)) {
                  return false;
                }

                return !newItemChars?.[0]?.isSpace &&
                  ((newItem?.str?.match(firstWordRegExp)?.[0]?.length || 0) > 1) &&
                  (
                    lastItem?.transform ?
                      !lastItem['hasEOL'] &&
                      !lastItem['hasEOT'] &&
                      !(
                        lastItemChars.length ? (
                          (lastItemChars[lastItemChars.length - 1]?.isSpace || !lastItemChars[lastItemChars.length - 1].unicode.trim()) ||
                          lastItemChars[lastItemChars.length - 1]?.isLineBreak
                        ) : false
                      ) &&
                      (() => {
                        let startCondition = (lastItemChars?.length ? startSpecialCharsRegExp.test(lastItemChars[lastItemChars.length - 1].unicode) : false);
                        let endCondition = (newItemChars?.length ? endSpecialCharsRegExp.test(newItemChars[0].unicode) : false);
                        return newItemChars?.length ?
                          (
                            lastItemChars?.length ? !(startCondition || endCondition) : !endCondition
                          ) :
                          lastItemChars?.length ? !startCondition : true;
                      })() :
                      false
                  );
              }

              function trimCoordinate(item) {
                if (!item || item.imageName || !item.chars?.length) return item;
                return trimTableContentItem(item, true, true);
              }



              function trimTableContentItem(item, clearStart = true, clearEnd = true) {
                item = { ...item }// old: item = JSON.parse(JSON.stringify(item));
                let chars = clearChars({
                  chars: item.chars,
                  fullClear: true,
                  clearStart,
                  clearEnd
                });
                chars = chars.length ? chars : item.chars;

                let fontSize = Math.abs(item.transform[3]) || item.height || 1;

                let handledValues = handleCharsArgs({
                  charsArr: chars,
                  x: item.transform[4],
                  fontSize: fontSize
                });

                Object.assign(item, {
                  str: item?.str?.trim(),
                  chars: chars,
                  width: Math.max(...handledValues.widthRanges),
                  transform: [
                    item.transform[0],
                    item.transform[1],
                    item.transform[2],
                    item.transform[3],
                    chars.find(item => item?.x)?.x || item.transform[4],
                    item.transform[5],
                  ],
                });
                return item;
              }

              let preliminaryItem = JSON.parse(JSON.stringify(current.contentItem));

              const textMatrixTail = textMatrix.slice(-2).toString();
              const contentItemTail = preliminaryItem.transform.slice(-2).toString();
              const tailsMatch = textMatrixTail === contentItemTail;

              let finalTransform = tailsMatch
                ? preliminaryItem.transform
                : transformFn(textMatrix, preliminaryItem.transform);

              // Text must be converted to page coordinates in the same way as lines and
              // rectangles (Trm = Tm × CTM). Previously, CTM was not
              // applied to text at all. In background_lines_2.pdf, the first page operation
              // `1 0 0 1 0 792 cm` shifts the entire coordinate system: lines and fills
              // (CTM applied) ended up at y ≈ 297–719, while text (CTM not applied)
              // at y≈-534...-31—they never overlapped.


              if (!isDefaultTransformMatrix(transformMatrix)) {
                finalTransform = transformFn(transformMatrix, finalTransform);
              }

              // The next Tj in the same text object begins where the previous one ended
              if (ADVANCE_TEXT_POSITION_AFTER_SHOW && current.textRunAdvance) {
                const readingLength = Math.hypot(finalTransform[0], finalTransform[1]) || 1;
                finalTransform = [
                  finalTransform[0],
                  finalTransform[1],
                  finalTransform[2],
                  finalTransform[3],
                  finalTransform[4] + (current.textRunAdvance * finalTransform[0]) / readingLength,
                  finalTransform[5] + (current.textRunAdvance * finalTransform[1]) / readingLength,
                ];
              }

              // pdfjs 6.x sometimes reports fontSize=1 while the actual scale is stored in textMatrix
              // matrixScaleY used to only look at finalTransform[3], which
              // for text rotated by 90° (a matrix of the form [0, s, -s, 0]),
              // is always equal to 0—which is why rotated text always fell short of
              // `fontSize` (often 1, while the actual scale of 11pt is stored in the matrix).
              let matrixScaleX = Math.hypot(finalTransform[0], finalTransform[1]);
              let matrixScaleY = Math.hypot(finalTransform[2], finalTransform[3]);
              let matrixScale = Math.max(matrixScaleX, matrixScaleY);

              let fontSizeIsNotSet =
                (fontSize <= 1 && matrixScale > 1.5) ||
                (matrixScale > fontSize * 1.5);

              let effectiveHeight = fontSizeIsNotSet ? matrixScale : fontSize;

              if (fontSizeIsNotSet) {
                _widthAdvanceScale = effectiveHeight * _fontIdentityMatrix[0];
                current.contentItem.height = effectiveHeight;

                // We scale the existing 2x2 portion of the matrix rather than blurring it
                // with a flat [h,0,0,h]—which would imperceptibly “straighten out” any
                // rotated text.
                if (matrixScale > 0) {
                  current.contentItem.transform[0] = (finalTransform[0] / matrixScale) * effectiveHeight;
                  current.contentItem.transform[1] = (finalTransform[1] / matrixScale) * effectiveHeight;
                  current.contentItem.transform[2] = (finalTransform[2] / matrixScale) * effectiveHeight;
                  current.contentItem.transform[3] = (finalTransform[3] / matrixScale) * effectiveHeight;
                }
              }

              Object.assign(preliminaryItem, {
                transform: finalTransform,
                height: effectiveHeight
              });

              let normalizedShowText = normalizeShowTextArgs(args);
              normalizedShowText = normalizeGlyphUnicode(normalizedShowText);
              // Tc and Tw are given in unscaled text space units. With a Tf size of 1 and the
              // scale carried by Tm (here 9) they must be scaled just like the font size.
              const spacingScale = fontSize > 0 ? effectiveHeight / fontSize : 1;

              normalizedShowText = materializeLeaderGaps(normalizedShowText, {//!Bug in column_span_2.pdf (wrong leader detect?)
                fontSize: effectiveHeight,
                charSpacing: charSpacing * spacingScale,
                fontDirection,
                vertical: _vertical,
              });

              let { widthRanges, str, charsRangesArrays, fontSpaceWidths } = handleCharsArgs({
                charsArr: JSON.parse(JSON.stringify(normalizedShowText)),//JSON.parse(JSON.stringify(args[0])), //clearChars({chars:args[0], fullClear:false, clearStart:true, clearEnd:false}),
                x: preliminaryItem.transform[4],
                y: preliminaryItem.transform[5],
                setCoordinates: true,
                setCharWidth: true,
                fontSize: effectiveHeight,
                charSpacing: charSpacing * spacingScale,
                wordSpacing: wordSpacing * spacingScale,
                pageTransform: preliminaryItem.transform,
                setPageGeometry: true,
              });
              fontSpaceWidths = Object.assign(current.fontSpaceWidths, fontSpaceWidths);

              if (ADVANCE_TEXT_POSITION_AFTER_SHOW && !_vertical && Number.isFinite(widthRanges[1])) {
                current.textRunAdvance += widthRanges[1];
              }

              //removeByIndexes(tableContentItems, [tableContentItems.length - 1]);

              current['str'] = str;

              Object.assign(preliminaryItem, {
                str: str,
                chars: charsRangesArrays.flat(),//need to update
                fontName: fontName,
                height: effectiveHeight,
                dir: ['rtl', 'ltr'][fontDirection] || getTextDirection(str),
                width: widthRanges[1],
                textColor: getTextColor(),

                //transform: (textMatrix.slice(-2).toString() == preliminaryItem.transform.slice(-2).toString()) ? preliminaryItem.transform : transformFn(textMatrix, preliminaryItem.transform),
                //hasEOL: hasEOL(str)//BUGFIX there are no line breaks in the text
              });

              if (debugTrace) {
                preliminaryItem.__pdfTraceOpIndex = i;
                preliminaryItem.__pdfTraceOpIndexes = [i];
              }

              let relatedTextContentItems = getRelatedTextContentItems(
                getDeviceBBox(preliminaryItem.transform, preliminaryItem.width, preliminaryItem.height),
                preliminaryItem
              ).filter(item => {
                if (!item) return false;

                //A candidate from another line is never a pair (vertical fonts and rotated text—as before)
                if (!_vertical && !isOnSameTextLine(item, preliminaryItem)) {
                  return false;
                }

                // 1. String matching
                let parseStr = (str) => {
                  return str ? [...(str.match(/\p{L}+|\p{N}+|\w|\W/gmu) || [])] : [];
                };
                let [str1, str2] = [item?.str || '', str || ''];
                let hasStrOverlap = parseStr(str1).some(i => str2.includes(i)) || parseStr(str2).some(i => str1.includes(i));
                if (hasStrOverlap) return true;

                // 2. Geometric adjacency: the element is in contact or has a gap of up to 2*fontSize.
                let itemRight = item.transform[4] + item.width;
                let itemLeft = item.transform[4];
                let prelimRight = preliminaryItem.transform[4] + preliminaryItem.width;
                let prelimLeft = preliminaryItem.transform[4];
                let gapThreshold = Math.max(preliminaryItem.height * 2, 3);

                let xAdjacent = (itemRight >= prelimLeft - gapThreshold && itemRight <= prelimLeft + gapThreshold) ||
                  (itemLeft >= prelimRight - gapThreshold && itemLeft <= prelimRight + gapThreshold) ||
                  (itemLeft <= prelimRight && itemRight >= prelimLeft); // intersection

                let sameY = Math.abs(item.transform[5] - preliminaryItem.transform[5]) < preliminaryItem.height * 1.5;

                let hasMainStrOverlap = parseStr(str1).some(i => preliminaryItem.str.includes(i)) || parseStr(preliminaryItem.str).some(i => str1.includes(i));

                return xAdjacent && sameY && hasMainStrOverlap;
              });
              relatedTextContentItems = relatedTextContentItems.length ? relatedTextContentItems : [undefined];




              // ============================================================
              // MAIN CYCLE BY SEGMENTS
              // ============================================================
              const segments = segmentPreliminaryItem(preliminaryItem);

              for (let segIndex = 0; segIndex < segments.length; segIndex++) {
                const segment = segments[segIndex];
                const segmentStr = segment.str || '';
                const normSegmentStr = normalizeCJKText(segmentStr);
                const normSegmentStrTrimmed = normSegmentStr.trim();

                let relatedTextContentSpan =
                  findRelatedTextContentSpan(
                    segment,
                    relatedTextContentItems
                  );

                let relatedTextContentItem =
                  relatedTextContentSpan ||
                  findBestRelatedTextContentItem(
                    segment,
                    relatedTextContentItems
                  );
                if (!relatedTextContentItem && relatedTextContentItems.length === 1 && !relatedTextContentItems[0]) {
                  relatedTextContentItem = undefined;
                }

                let relatedTextContentId =
                  relatedTextContentItem?.isRelatedTextContentSpan
                    ? relatedTextContentItem.relatedItemIds.join('|')
                    : getTextContentItemId(
                      relatedTextContentItem
                    );
                let skippedLastTextContentItem = false;
                let normRelatedStr = normalizeCJKText(relatedTextContentItem?.str || '');
                let normStr = normSegmentStr;
                let normStrCompare = normSegmentStrTrimmed;
                let identicalToRelated = normRelatedStr == normStrCompare;
                let similarToRelated = normRelatedStr.trim() == normStrCompare;

                let reachedEnd = (() => {
                  if (relatedTextContentItem ? normRelatedStr : false) {
                    let subStrIndex = normRelatedStr.indexOf(normStrCompare);
                    skippedLastTextContentItem = (subStrIndex != -1) && (subStrIndex != 0) && !tableContentItemsCache[relatedTextContentId]?.length;
                    let reachedSubStrEnd = (subStrIndex + normStrCompare.length) == normRelatedStr.length;
                    if (
                      (
                        (segment.transform[4] <= (relatedTextContentItem.transform[4] + relatedTextContentItem.width)) &&
                        ((segment.transform[4] + segment.width) >= (relatedTextContentItem.transform[4] + relatedTextContentItem.width))
                      ) || reachedSubStrEnd
                    ) {
                      return true;
                    } else {
                      return false;
                    }
                  } else {
                    return false;
                  }
                })();

                // if (skippedLastTextContentItem) {
                //     let removedIndexes = [];
                //     let removedItems = [];
                //     let subStrIndexHistory = [];
                //     for (let index = lastItemIndex; index >= 0; index--) {
                //         let item = tableContentItems?.[index];
                //         let subStrIndex = relatedTextContentItem.str.trim().indexOf(item?.str);
                //         let isUnexpectedIndex = subStrIndexHistory.length ? subStrIndexHistory.every(i => subStrIndex < i) : false;
                //         if (subStrIndex == -1 || isUnexpectedIndex) {
                //             break;
                //         } else {
                //             removedIndexes.unshift(index);
                //             removedItems.unshift(item);
                //             subStrIndexHistory.push(subStrIndex);
                //         }
                //     }
                //     removeByIndexes(tableContentItems, removedIndexes);
                //     tableContentItemsCache[relatedTextContentId] = [...removedItems, ...(tableContentItemsCache[relatedTextContentId] || [])];
                // }

                //update indexes
                let newItemIndex;
                // (()=>{
                //     let newIndex = tableContentItems.findLastIndex(item=>getTextContentItemId(item) == relatedTextContentId);
                //     return newIndex == -1 ? tableContentItems.length - 1 : newIndex;
                // })();
                let newItem;
                let lastItemIndex = tableContentItems.length - 1;
                let lastItem = tableContentItems?.[lastItemIndex] || {};
                let reservedLastItemEOT = null;

                if (relatedTextContentItem && !similarToRelated && reachedEnd) {

                  let intersectLast = (checkRectangleRanges(preliminaryItem, lastItem, {
                    axis: ['x', 'y']
                  }) as Array<any>).every(item => item.inRange);
                  let currentCacheItems = segment?.str?.includes(relatedTextContentItem?.str) ||
                    (
                      intersectLast &&
                      !tableContentItemsCache[relatedTextContentId]
                    ) ? [segment] : [...(tableContentItemsCache[relatedTextContentId] || []), segment];

                  const mergeFragments = (fragments: any[]) => {
                    return fragments.reduce((prev, cur) => {
                      let newPrev;
                      // Get the actual scale from the `transform` property (using `fontSize` as a fallback).
                      // 1) Height: use `cur.height` instead of `fontSize` (=1)
                      // Previously: let curEffectiveHeight = Math.abs(cur.transform[3]) || fontSize;
                      let curEffectiveHeight = Math.abs(cur.transform[3]) || cur.height || fontSize;

                      if (prev?.str) {
                        let symbolsBetween = getSymbolsBetween(
                          relatedTextContentItem.str,
                          prev.str,
                          cur.str
                        );
                        updateChars({
                          item: cur,
                          spaceNeeded: symbolsBetween ? spaceNeeded(cur, prev) : false,
                          fontSpaceWidth: fontSpaceWidths[fontName]
                        });
                        updateChars({
                          item: prev,
                          lineBreakNeeded: prev.transform[5] != cur.transform[5],
                          fontSpaceWidth: fontSpaceWidths[fontName]
                        });
                      }

                      /*
                      * Preliminary glyph geometry is the primary source of truth.
                      *
                      * A textContentItem may correspond to only a fragment of the
                      * preliminary item in N:N matching, therefore its horizontal
                      * range must not be used to clip glyphs unless the relationship
                      * range must not be used to clip glyphs unless the relationship
                      * is unambiguously 1:1.
                      */
                      const useRelatedRange =
                        relatedTextContentItems.length === 1 &&
                        isSegmentContainedByRelatedItem(
                          cur,
                          relatedTextContentItem
                        );

                      let {
                        str,
                        charsRangesArrays
                      } = handleCharsArgs({
                        charsArr: cur.chars,
                        x: cur.transform[4],
                        rangeArr: useRelatedRange
                          ? [
                            relatedTextContentItem.transform[4],
                            relatedTextContentItem.transform[4] +
                            relatedTextContentItem.width
                          ]
                          : undefined,
                        fontSize: curEffectiveHeight
                      });

                      const normalizeText = (value: string) =>
                        (value || '').replace(/\s+/g, ' ').trim();

                      const range1Str = charsRangesArrays[1]
                        ?.map(g => g?.unicode || '')
                        .join('');

                      const range2Str = charsRangesArrays[2]
                        ?.map(g => g?.unicode || '')
                        .join('');

                      const recoverRange2 =
                        useRelatedRange &&
                        !!range2Str &&
                        normalizeText(`${range1Str}${range2Str}`) ===
                        normalizeText(cur.str) &&
                        normalizeText(cur.str) ===
                        normalizeText(relatedTextContentItem.str);

                      // the gap between leader segments (tail points) — a geometric gap
                      const leaderGapGlyph = createLeaderGapGlyph(prev?.['chars'], charsRangesArrays[1], curEffectiveHeight);

                      let chars = [
                        ...(prev?.['chars'] || []),
                        ...(leaderGapGlyph ? [leaderGapGlyph] : []),
                        ...charsRangesArrays[1],
                        ...(recoverRange2 ? charsRangesArrays[2] : []),
                      ];
                      let handledValues = handleCharsArgs({
                        charsArr: chars,
                        fontSize: curEffectiveHeight
                      });

                      chars = clearChars({
                        chars: handledValues.charsRangesArrays[1],
                        fullClear: false,
                        clearStart: true
                      });

                      let mergedChars = handledValues.charsRangesArrays.flat();

                      let actualRight = Math.max(
                        ...mergedChars
                          .filter(char => char && typeof char === 'object' && Number.isFinite(char.x))
                          .map(char => char.x + (char.charWidth || 0))
                      );

                      let actualLeft = Math.min(
                        ...mergedChars
                          .filter(char => char && typeof char === 'object' && Number.isFinite(char.x))
                          .map(char => char.x)
                      );

                      let hasRealPrev = !!prev?.str;
                      let prevTransform = hasRealPrev ? prev.transform : _defaultTransformMatrix;

                      // chars[0].x is the accumulated distance along the READING DIRECTION
                      // (handleCharsArgs always writes it to the `x` field, regardless of
                      // which device axis it actually corresponds to). The old code definitely wrote
                      // this value to transform[4] (X)—which is correct for horizontal
                      // text, but for rotated text, the actual reading direction is on a different
                      // axis. We project the offset onto the actual direction, taking it from
                      // cur.transform (the same matrix already used in readingUnit
                      // elsewhere in the file). We change the behavior ONLY when the text is actually
                      // rotated—for horizontal text, the formula remains exactly
                      // the same, so as not to alter the already-verified path.
                      let firstMergedChar = mergedChars[0];
                      let [readA, readB] = cur.transform;
                      let readingLength = Math.hypot(readA, readB) || 1;
                      let readingUnit = [readA / readingLength, readB / readingLength];
                      let isRotatedReading = Math.abs(readingUnit[1]) > 0.5;

                      let mergedAnchorX, mergedAnchorY;
                      let rotatedWidth: number | null = null;
                      // if (isRotatedReading && firstMergedChar && typeof firstMergedChar.x === 'number') {
                      //   let offset = firstMergedChar.x - cur.transform[4];
                      //   mergedAnchorX = cur.transform[4] + offset * readingUnit[0];
                      //   mergedAnchorY = cur.transform[5] + offset * readingUnit[1];
                      // } 
                      if (isRotatedReading) {
                        // position on the reading axis = projection of the fragment's origin onto the reading direction
                        const readingPosition = (matrix: number[]) =>
                          matrix[4] * readingUnit[0] + matrix[5] * readingUnit[1];

                        const curStart = readingPosition(cur.transform);
                        const prevStart = hasRealPrev ? readingPosition(prevTransform) : curStart;

                        // start of the concatenated element = start of the EARLIEST fragment
                        const anchorSource = hasRealPrev && prevStart <= curStart ? prevTransform : cur.transform;
                        mergedAnchorX = anchorSource[4];
                        mergedAnchorY = anchorSource[5];

                        const start = Math.min(prevStart, curStart);
                        const end = Math.max(
                          hasRealPrev ? prevStart + (prev.width || 0) : -Infinity,
                          curStart + (cur.width || 0)
                        );
                        rotatedWidth = end - start;
                      } else {
                        mergedAnchorX = firstMergedChar?.x || (hasRealPrev ? Math.min(prevTransform[4], cur.transform[4]) : cur.transform[4]);
                        mergedAnchorY = hasRealPrev ? Math.max(prevTransform[5], cur.transform[5]) : cur.transform[5];
                      }

                      newPrev = mergedChars.length ? {
                        str: handledValues?.str,
                        chars: mergedChars,
                        fontName: fontName,
                        textColor: prev?.textColor || cur?.textColor || null,
                        height: Math.max(
                          hasRealPrev ? (Math.abs(prevTransform[3]) || prev.height || curEffectiveHeight) : curEffectiveHeight,
                          Math.abs(cur.transform[3]) || cur.height || curEffectiveHeight,
                        ),
                        dir: ['rtl', 'ltr'][fontDirection] || getTextDirection(handledValues.str),
                        width: rotatedWidth !== null
                          ? rotatedWidth
                          : (Number.isFinite(actualRight) && Number.isFinite(actualLeft)
                            ? actualRight - actualLeft
                            : Math.max(...handledValues.widthRanges)),
                        transform: [
                          hasRealPrev ? Math.max(prevTransform[0], cur.transform[0]) : cur.transform[0],
                          hasRealPrev ? Math.max(prevTransform[1], cur.transform[1]) : cur.transform[1],
                          hasRealPrev ? Math.max(prevTransform[2], cur.transform[2]) : cur.transform[2],
                          hasRealPrev ? Math.max(prevTransform[3], cur.transform[3]) : cur.transform[3],
                          mergedAnchorX,
                          mergedAnchorY,
                        ],
                      } : null;
                      // } else {
                      //     newPrev = cur;
                      // }
                      return newPrev;
                    }, null);
                  }


                  const cellRuns = splitFragmentsIntoCells(currentCacheItems);

                  // All cells except the last one are complete
                  cellRuns.slice(0, -1).forEach((run) => {
                    const cellItem = mergeFragments(run);
                    if (cellItem) {
                      cellItem['hasEOT'] = true;
                      cellItem['hasEOL'] = false;
                      cellItem['altStr'] = relatedTextContentItem?.str;
                      tableContentItems.push(cellItem);
                    }
                  });

                  newItem = mergeFragments(cellRuns[cellRuns.length - 1]);



                } else {
                  newItem = segment;
                }

                if (newItem) {
                  newItem['altStr'] = relatedTextContentItem?.str;
                }

                // A fragment that does not match a native pdf.js text element
                // (for example, a standalone ligature like “ﬁ,” drawn with a DIFFERENT
                // built-in font right in the middle of a word) used to always be pushed
                // into `tableContentItems` immediately—bypassing the queue, even if at that
                // moment another, earlier fragment of the SAME word was still patiently
                // waiting for its continuation in `tableContentItemsCache`. Because of this,
                // the order of characters in the resulting line could become jumbled (“ﬁ Surplus/De
                // cit“ instead of ”Surplus/Deﬁ cit"). If there is currently
                // an unfinished “pending” fragment on the same line (the same
                // Y-coordinate with a small margin of error)—we append the new fragment
                // there, instead of forcing it to the front of its queue.
                if (newItem && !relatedTextContentItem && lastActiveCacheKey) {
                  const pendingBucket = tableContentItemsCache[lastActiveCacheKey];
                  const pendingLastFragment = pendingBucket?.[pendingBucket.length - 1];

                  const looksLikeInlineContinuation =
                    pendingLastFragment &&
                    Math.abs(
                      (pendingLastFragment.transform?.[5] ?? 0) -
                      (newItem.transform?.[5] ?? 0)
                    ) < Math.max(newItem.height || 1, pendingLastFragment.height || 1) * 2;

                  if (looksLikeInlineContinuation) {
                    tableContentItemsCache[lastActiveCacheKey] = [...pendingBucket, newItem];
                    newItem = null;
                  }
                }

                if (newItem && (reachedEnd || !relatedTextContentItem)) {
                  tableContentItems.push(newItem);
                  if (tableContentItemsCache?.[relatedTextContentId]) {
                    delete tableContentItemsCache[relatedTextContentId];
                  }
                  if (relatedTextContentId === lastActiveCacheKey) {
                    lastActiveCacheKey = null;
                  }
                }

                newItemIndex = tableContentItems.length - 1;
                lastItemIndex = newItemIndex - 1;
                lastItem = tableContentItems?.[lastItemIndex] || {};

                if ((relatedTextContentItem && !similarToRelated && !reachedEnd) || !newItem) {
                  if (newItem) {
                    //removeByIndexes(tableContentItems, [newItemIndex]);
                    tableContentItemsCache[relatedTextContentId] = [
                      ...(tableContentItemsCache[relatedTextContentId] || []),
                      newItem
                    ];
                    tableContentItemsCacheSource[relatedTextContentId] = relatedTextContentItem;
                    lastActiveCacheKey = relatedTextContentId;
                  }
                } else {
                  //let combinedTextContentItem = identicalToRelated ? false : reachedEnd;

                  let hasEOTCondition;
                  newItem['hasEOT'] = true;
                  newItem['hasEOL'] = (() => {
                    let hasEOL = relatedTextContentItem?.['hasEOL'] || false;
                    return identicalToRelated ? hasEOL ? lastItem.hasEOL ? false : hasEOL : false : false; //old:!combinedTextContentItem ? hasEOL : false; 
                  })();
                  newItem['altStr'] = relatedTextContentItem?.str;

                  let visibleEdges = edges.filter(item => isVisibleVector(item));
                  let isIntersectsEdges = intersectsEdges({
                    first: clearEmptyCoordinateItems([lastItem]).map(trimCoordinate),
                    second: clearEmptyCoordinateItems([newItem]).map(trimCoordinate),
                    targetGrids: ['cols', 'rows'],
                    edges: visibleEdges
                  });

                  //newItem will be guaranteed to be combined with lastItem; newItem is likely to be a space with a line break.
                  if (
                    (lastItem?.str || lastItem?.imageName) &&
                    !current['pathConstructed'] &&
                    ((newItem.str == current['str'])) && //!BUGFIX (combined text items/coordinates ) table.pdf 
                    !isIntersectsEdges
                  ) {
                    reservedLastItemEOT = lastItem['hasEOT'];
                    lastItem['hasEOT'] = false;
                  }

                  // if (tableContentItems.length == 93) {//214//275//278//216//29//47//83//37//55//tableContentItems.length == 47// 334//329 //34//opListIndex == 1028//1100
                  //     console.log(111);
                  // }

                  if (
                    lastItem.transform //lastItem exists
                    //&& lastItem.chars //lastItem is text
                    // && (
                    //     ((lastItem?.transform?.[4] != newItem?.transform?.[4]) && (!lastItem.hasEOT || true)) || //BUGFIX
                    //     ((lastItem?.transform?.[5] != newItem?.transform?.[5]) && !lastItem.hasEOL)
                    // )
                  ) { //BUGFIX for watermark.pdf

                    function getCoordinateData(newItemIndex, ignoreFirstSplitItem?) {
                      let lastItemIndex = newItemIndex - 1;
                      //let newItem = tableContentItems?.[newItemIndex];
                      let lastItem = tableContentItems?.[lastItemIndex];

                      let tableContentItemsRange = tableContentItems.slice(0, newItemIndex);
                      let eolObj = getSplitEdgeRange({
                        arr: tableContentItemsRange,
                        splitConditionFn: (item, index) => item.hasEOL,
                        ignoreFirstSplitItem: false,
                        includeFirstSplitItem: true,
                        getLast: true
                      });
                      let eotObj = getSplitEdgeRange({
                        arr: tableContentItemsRange,
                        splitConditionFn: (item, index) => item.hasEOT,
                        ignoreFirstSplitItem: ignoreFirstSplitItem,
                        includeFirstSplitItem: true,
                        getLast: true
                      });
                      let eotIndex = eotObj.index;
                      let eolIndex = eotIndex > eolObj.index ? -1 : eolObj.index;
                      let lastCoordinateEdge, coordinateItems = [], firstCoordinateEdge;
                      if (lastItem) {
                        let eotRange = eotObj.range;
                        coordinateItems = eotIndex == -1 ? [lastItem] : eotRange;
                        firstCoordinateEdge = coordinateItems[0] || lastItem;
                        lastCoordinateEdge = coordinateItems[coordinateItems.length - 1] || lastItem;
                      }
                      return { eolIndex, eotIndex, firstCoordinateEdge, lastCoordinateEdge, coordinateItems }
                    }



                    function intersectsTop(firstItem, secondItem, strict) {
                      let firstArray = Array.isArray(firstItem) ? firstItem : firstItem ? [firstItem] : [];
                      let secondArray = Array.isArray(secondItem) ? secondItem : secondItem ? [secondItem] : [];
                      if (firstArray.length && secondArray.length) {
                        let inRange = (
                          checkRectangleRanges(
                            getCoordinateFromObj(firstArray),
                            getCoordinateFromObj(secondArray),
                            { strict: strict, strictIntersecting: strict, axis: ['x'], tolerance: maxWidth / 2 }
                          ) as Array<any>
                        ).every(item => item.inRange);
                        return inRange;
                      } else {
                        return false;
                      }
                    };


                    function checkPreviousCoordinate() {
                      let previousCoordinate = getCoordinateData(currentCoordinate.eotIndex, false);
                      let previousItem = tableContentItems[currentCoordinate.eotIndex];
                      let previousPaddingTop = tableContentItems[previousCoordinate.eolIndex]?.['paddingTop'];
                      let currentMergedObj = [...currentCoordinate.coordinateItems, ...(lastItem && !currentCoordinate.coordinateItems.includes(lastItem) ? [lastItem] : [])];
                      let previousMergedObj = [...previousCoordinate.coordinateItems, ...(previousItem ? [previousItem] : [])];
                      let currentPaddingTop = getCoordinateFromObj(previousMergedObj).y[0] - getCoordinateFromObj(currentMergedObj).y[1];
                      let verticleIntersects = false;
                      let verticleSiblings = false;
                      let isPreviousIntersectsEdges = intersectsEdges({
                        first: clearEmptyCoordinateItems(previousMergedObj),
                        second: clearEmptyCoordinateItems(currentMergedObj),
                        targetGrids: ['cols', 'rows'], //old: previousIntersectsX ? ['cols'] : ['rows']
                        edges: visibleEdges
                      });
                      let previousIsLastItem = previousItem == lastItem;
                      let previousItemChanged = false;
                      let doubleIntersectXCheck = false;
                      let isCompletedParagraph = false;

                      // Find the paragraph boundary: go back from lastItem, skipping lastItem itself.
                      let paragraphStartIndex = 0;
                      for (let i = lastItemIndex; i >= 0; i--) {
                        if (i !== lastItemIndex && tableContentItems[i]?.hasEOL) {
                          paragraphStartIndex = i + 1;
                          break;
                        }
                      }
                      let paragraphItems = tableContentItems.slice(paragraphStartIndex, lastItemIndex + 1);

                      if (paragraphItems.length > 0 && newItem && newItem.transform && lastItem && lastItem.transform) {
                        let isUniformParagraph = paragraphItems.every(item => isSameFont(item, paragraphItems[0]));

                        if (isUniformParagraph) {
                          let sameY = Math.abs(lastItem.transform[5] - newItem.transform[5]) < 0.5;
                          let sameFont = isSameFont(newItem, paragraphItems[0]);

                          // We consider a paragraph to be finished only if BOTH conditions are violated:
                          // the current element is on a different line AND in a different font
                          if (!sameY && !sameFont) {
                            isCompletedParagraph = true;
                          }
                        }
                      }
                      // ============================================================

                      if (previousItem?.['hasEOT'] && !isPreviousIntersectsEdges) {
                        let trim = (obj) => obj.map(trimCoordinate);
                        let previousIntersectsX = intersectsTop(trim(previousMergedObj), trim(currentMergedObj), false);

                        if (!previousIntersectsX) {
                          previousIntersectsX = intersectsTop(trim(previousMergedObj), trim([...currentMergedObj, newItem]), false);
                          doubleIntersectXCheck = true;
                        }

                        if (
                          (lastItem.transform[5] == previousItem.transform[5]) &&
                          (newItem.transform[5] != lastItem.transform[5])
                        ) {
                          verticleSiblings = true;
                        }

                        verticleIntersects = previousIntersectsX;
                        let maxHeight = Math.min(previousItem.height, lastItem.height) / 2;

                        if (
                          previousIntersectsX &&
                          uniqueArr(currentMergedObj.map(item => item.fontName)).includes(previousItem.fontName) &&
                          uniqueArr(currentMergedObj.map(item => item.height)).includes(previousItem.height) &&
                          (previousPaddingTop ? currentPaddingTop == previousPaddingTop : currentPaddingTop <= maxHeight)
                        ) {
                          let sameY = Math.abs(previousItem.transform[5] - tableContentItems[currentCoordinate.eotIndex + 1].transform[5]) < 0.5;
                          previousItem['hasEOT'] = false;
                          if (doubleIntersectXCheck && verticleIntersects && verticleSiblings) {
                            previousItem['hasEOL'] = false;
                            removeLineBreak(previousItem);
                          } else {
                            previousItem['hasEOL'] = sameY ? false : true;
                          }

                          if (!previousPaddingTop && previousItem['hasEOL']) {
                            previousItem['paddingTop'] = previousItem.transform[5] - previousItem.height - ((doubleIntersectXCheck && verticleIntersects) || (lastItem == previousItem) ? newItem : lastItem)?.transform?.[5];
                          }
                          updateChars({
                            item: previousItem,
                            lineBreakNeeded: previousItem['hasEOL'],
                            spaceNeeded: false,
                            fontSpaceWidth: fontSpaceWidths[fontName]
                          });
                          previousItemChanged = true;
                        }
                      }
                      return {
                        verticleIntersects,
                        verticleSiblings,
                        previousIsLastItem,
                        previousItemChanged,
                        doubleIntersectXCheck,
                        isCompletedParagraph
                      }
                    }



                    function getProperty(axisItem) {
                      let properties = {
                        'x': 'width',
                        'y': 'height'
                      }
                      return properties[axisItem];
                    };

                    function getEdgesOnSameAxis(gridItemsType) {
                      return visibleEdges.filter((edge) => {
                        let axis = gridItemsType == 'cols' ? 'y' : 'x';
                        let axisValue = getProperty(axis);
                        let transformIndex = axis == 'x' ? 4 : 5;

                        let condition = gridItemsType == 'cols' ? ((edge.width < lineMaxWidth) && (edge.height > lineMaxWidth)) : ((edge.height < lineMaxWidth) && (edge.width > lineMaxWidth));

                        if (condition) {
                          let res: any = checkRectangleRanges(
                            edge,
                            { [axis]: [newItem.transform[transformIndex], newItem.transform[transformIndex] + newItem[axisValue]] },
                            { axis, strict: true, strictIntersecting: true }
                          );
                          return res?.isContained || !res?.biggestArgument && res?.isIntersecting;
                        } else {
                          return false;
                        }
                      });
                    }

                    let currentCoordinate = getCoordinateData(newItemIndex, false);
                    let currentMergedObj = [...currentCoordinate.coordinateItems, ...(lastItem && !currentCoordinate.coordinateItems.includes(lastItem) ? [lastItem] : [])];

                    let maxWidth = Math.max(...([...currentMergedObj, newItem]).map(item => {
                      return item.chars ? Math.max(...item.chars.map(glyph => {
                        var charWidth = 0;
                        if (typeof glyph == 'object') {
                          var width = glyph.width;
                          var spacing = (glyph.isSpace ? wordSpacing : 0) + charSpacing;
                          charWidth = width * _widthAdvanceScale + spacing * fontDirection;
                        }

                        return charWidth;
                      })) : 0;
                    }).flat());
                    maxWidth = (maxWidth + (maxWidth * 0.05)); // old : 0.001//need to add an additional threshold because the width of letters varies in the font
                    let maxHeight = Math.min(lastItem.height, newItem.height) / 2;
                    let intersectsX = intersectsTop(newItem, currentMergedObj, true);
                    let targetGrids = (() => {
                      let conditions = {
                        'cols': (lastItem?.transform?.[5] == newItem?.transform?.[5]) || !intersectsX, //false
                        'rows': (lastItem?.transform?.[5] != newItem?.transform?.[5]),
                      };
                      return Object.keys(conditions).filter(key => conditions[key]);
                    })();

                    let visibleEdges = [...(edges || []), ...(rectanglesEdges || [])].filter(item => isVisibleVector(item));
                    //let isIntersectsEdges = lastItem?.transform ? intersectsEdges({ first: clearEmptyCoordinateItems(currentMergedObj), second: clearEmptyCoordinateItems(newItem), targetGrids, edges: visibleEdges }) : false;
                    let borderSize = getAverageBorderSize(visibleEdges || [], lineMaxWidth);
                    let isIntersectsEdges = lastItem?.transform ? intersectsEdges({
                      first: clearEmptyCoordinateItems(currentMergedObj).map(trimCoordinate),
                      second: clearEmptyCoordinateItems([newItem]).map(trimCoordinate),
                      targetGrids,
                      edges: visibleEdges,
                      tolerance: borderSize * 2,
                    }) : false;
                    // let topEdges = filterBlocks(visibleEdges, {
                    //   'x': [newItem.transform[4], newItem.transform[4] + newItem.width],
                    //   'y': [newItem.y, Infinity],
                    //   strict: false,
                    //   withoutOverlap: false,
                    //   strictIntersecting: true
                    // });

                    let intersectingGridItemsObj = (() => {
                      let obj = {};
                      for (let index = 0; index < targetGrids.length; index++) {
                        const gridItem = targetGrids[index];
                        let edgesOnSameAxis = getEdgesOnSameAxis(gridItem);
                        obj[gridItem] = uniqueArr(edgesOnSameAxis, gridItem == 'cols' ? 'x' : 'y');
                      }
                      return obj;
                    })();

                    hasEOTCondition = (() => {
                      let getResults = (obj, gridItemsType) => {
                        return {
                          'cols': obj.x[1] - obj.x[0] > maxWidth,
                          'rows': obj.y[1] - obj.y[0] > maxHeight
                        }[gridItemsType]
                      };

                      return targetGrids.some(key => {
                        let paddingObj = getMergedCoordinatePaddingObj(
                          key == 'cols'
                            ? currentCoordinate.lastCoordinateEdge
                            : lastItem,
                          newItem,
                          key
                        );

                        let jumps = lastItem?.transform ? (
                          ((lastItem.transform[5] < newItem.transform[5]) && (key == 'cols')) ||
                          ((lastItem.transform[4] < newItem.transform[4]) && (key == 'rows'))
                        ) : false;

                        let returnOriginalValue = key == 'cols'
                          ? intersectingGridItemsObj[key].length > 2
                          : intersectingGridItemsObj[key].length > 3; //the table has enough edges (if rows then 3 (+header bottom line))

                        return returnOriginalValue
                          ? lastItem['hasEOT']
                          : jumps
                            ? true
                            : getResults(paddingObj, key); //BUG?
                      });
                    })();

                    let skip = false;

                    if (
                      !lastItem['hasEOL'] &&
                      (lastItem?.transform?.[5] != newItem?.transform?.[5]) &&
                      ((lastItem?.transform?.[5] + lastItem?.height) - newItem.transform?.[5]) > maxHeight &&
                      intersectsX &&
                      !isIntersectsEdges &&
                      uniqueArr(currentMergedObj.map(item => item.fontName)).includes(newItem.fontName) &&
                      uniqueArr(currentMergedObj.map(item => item.height)).includes(newItem.height) &&
                      !( //hasEOT condition
                        (lastItem?.transform?.[4] != newItem?.transform?.[4]) &&
                        hasEOTCondition
                      )
                      // (
                      //     tableContentItems?.[currentCoordinate.eolIndex]?.['paddingTop'] ?
                      //         (lastItem.transform[5] - lastItem.height - newItem?.transform?.[5]) == tableContentItems[currentCoordinate.eolIndex]['paddingTop']
                      //         : true
                      // )
                    ) {
                      //let res = checkPreviousCoordinate();
                      let newCurrentCoordinate = getCoordinateData(newItemIndex);
                      let newPaddingTop = lastItem.transform[5] - lastItem.height - newItem?.transform?.[5];
                      if (
                        (currentCoordinate.eolIndex == newCurrentCoordinate.eolIndex) &&
                        (currentCoordinate.eotIndex == newCurrentCoordinate.eotIndex)
                      ) {
                        lastItem['paddingTop'] = newPaddingTop;
                        lastItem['hasEOL'] = true;
                        updateChars({
                          item: lastItem,
                          lineBreakNeeded: lastItem['hasEOL'],
                          spaceNeeded: false,
                          fontSpaceWidth: fontSpaceWidths[fontName]
                        });
                      } else {
                        currentCoordinate = newCurrentCoordinate;
                        let paddingTop = tableContentItems?.[currentCoordinate.eolIndex]?.['paddingTop'];
                        if (paddingTop) {

                          let paddingTopTolerance = 0.005;
                          if (
                            getOnePercentOfAbsoluteDifference(newPaddingTop, paddingTop) <= paddingTopTolerance
                          ) {
                            lastItem['paddingTop'] = newPaddingTop;
                            let lastItemChars = clearChars({
                              chars: lastItem.chars
                            });
                            if (!lastItem['hasEOL'] || !lastItemChars[lastItemChars.length - 1].isLineBreak) {
                              lastItem['hasEOL'] = true;
                              updateChars({
                                item: lastItem,
                                lineBreakNeeded: lastItem['hasEOL'],
                                spaceNeeded: false,
                                fontSpaceWidth: fontSpaceWidths[fontName]
                              });
                            }
                          } else {
                            lastItem['hasEOT'] = true;
                            skip = true;
                          }
                        }
                      }
                    }

                    if (!skip) {
                      if ((
                        (
                          !lastItem['hasEOL'] &&
                          // chars?.every(char => {
                          //     return char?.isSpace && !char?.isInFont
                          // }) &&
                          (lastItem?.transform?.[4] != newItem?.transform?.[4]) &&
                          hasEOTCondition
                        ) || isIntersectsEdges
                      ) && Object.keys(intersectingGridItemsObj).some(key => !(key == 'rows' ? intersectingGridItemsObj[key].length > 2 : intersectingGridItemsObj[key].length > 3))
                        //old:((newItem.width / chars.length) > maxWidth) 
                        //old: && (((newItem.transform?.[4] + newItem.width) - lastItem?.transform?.[4]) > maxWidth
                      ) {
                        //if (Object.keys(intersectingGridItemsObj).some(key => !(key == 'rows' ? intersectingGridItemsObj[key].length > 2 : intersectingGridItemsObj[key].length > 3))) {
                        let res = checkPreviousCoordinate();
                        //}

                        if (
                          //res ?
                          !(
                            res.verticleIntersects == true &&
                            res.verticleSiblings == true &&
                            res.previousIsLastItem == true &&
                            res.previousItemChanged == true &&
                            res.doubleIntersectXCheck == false &&
                            !isIntersectsEdges &&
                            hasEOTCondition &&
                            intersectsX &&
                            (targetGrids[0] == 'rows') &&
                            (targetGrids.length == 1)
                          )
                          //: false
                        ) {

                          let isTrailingWhitespaceSeparator =
                            !lastItem?.str?.trim() &&
                            newItem?.hasEOT &&
                            lastItem?.transform?.[5] != newItem?.transform?.[5] &&
                            !intersectsX;

                          //if (!(res.previousItemChanged && res.previousIsLastItem)) {
                          if (
                            (
                              res &&
                              res.doubleIntersectXCheck &&
                              res.verticleIntersects &&
                              res.verticleSiblings &&
                              !res.isCompletedParagraph &&
                              !isTrailingWhitespaceSeparator
                            ) //from checkPreviousCoordinate
                            //(topEdges.length ? !isIntersectsEdges : false)
                          ) {
                            lastItem['hasEOL'] = true;
                            updateChars({
                              item: lastItem,
                              lineBreakNeeded: true,
                              spaceNeeded: false,
                              fontSpaceWidth: fontSpaceWidths[fontName]
                            });
                          } else {
                            lastItem['hasEOT'] = true;
                            let hasLineBreak = removeLineBreak(lastItem);
                            if (hasLineBreak) {
                              lastItem['hasEOL'] = false;
                            }
                          }
                        }

                      } else {
                        let sameY = Math.abs(lastItem.transform[5] - newItem.transform[5]) < 0.5;
                        let sameFont = isSameFont(lastItem, newItem);
                        let heightDiff = Math.abs(lastItem.height - newItem.height);
                        let similarHeight = heightDiff < 0.5 || heightDiff / Math.max(lastItem.height, newItem.height) < 0.05;

                        let isSmallXGap = ((a, b) => {
                          a = trimCoordinate(a);
                          b = trimCoordinate(b);

                          let xGap = Math.max(
                            0,
                            Math.max(a.transform[4], b.transform[4]) -
                            Math.min(
                              a.transform[4] + a.width,
                              b.transform[4] + b.width
                            )
                          );

                          let xGapMaxSympolsLength = 1.5;
                          let xGapMaxWidth = Math.max(maxWidth, lineMaxWidth) * xGapMaxSympolsLength;

                          return xGap <= xGapMaxWidth;
                        })(lastItem, newItem);

                        let condition = (() => {
                          let lastItemCopy = lastItem?.chars ? trimTableContentItem(lastItem, false) : lastItem;
                          let newItemCopy = newItem?.chars ? trimTableContentItem(newItem) : newItem;

                          // Strict stop: the gap in X is greater than 1.5 average symbols — definitely different cells.
                          if (!isSmallXGap) { return false; }

                          let sameType = typeof typeValue(lastItem?.str) === typeof typeValue(newItem?.str);
                          for (let gridItem of targetGrids) {
                            let axis = gridItem === 'rows' ? 'y' : 'x';
                            let max = gridItem === 'rows' ? maxHeight : maxWidth;
                            let paddingObj = getMergedCoordinatePaddingObj(
                              normalizeRotatedAnchor(lastItemCopy),
                              normalizeRotatedAnchor(newItemCopy),
                              gridItem
                            );
                            let paddingDiff = Math.abs(paddingObj[axis][0] - paddingObj[axis][1]);

                            // 1. The spacing between elements is within the allowed tolerance.
                            if (paddingDiff > max) {
                              return false;
                            }
                            // 2. For strings, we additionally check the type and font.
                            if (gridItem === 'rows' && (!sameType || !sameFont)) {
                              return false;
                            }
                            // 3. The height of the elements should be comparable.
                            if (!similarHeight) {
                              return false;
                            }
                            // 4. Special case: many columns and no intersection with edges — we require strict matching of Y
                            if (gridItem === 'cols') {
                              let hasManyGridLines = (intersectingGridItemsObj['cols']?.length > 2) && !isIntersectsEdges;
                              if (hasManyGridLines && !sameY) {
                                return false;
                              }
                            }
                          }

                          return !isIntersectsEdges;
                        })();

                        let shouldMerge = false;

                        if (condition) {
                          shouldMerge = true;
                        } else {
                          // Soft merge: one font, similar height, in one line, no borders
                          if (
                            sameY &&
                            sameFont &&
                            similarHeight &&
                            //!isIntersectsEdges && 
                            isSmallXGap &&
                            !hasEOTCondition
                          ) {
                            shouldMerge = true;
                          }
                        }

                        if (shouldMerge) {
                          lastItem['hasEOT'] = false;
                          if (!lastItem['hasEOL']) {
                            if ((lastItem?.transform?.[5] != newItem?.transform?.[5])) {
                              lastItem['hasEOL'] = true;
                            }
                          }
                          if (lastItem['hasEOL']) {
                            lastItem['hasEOL'] = (lastItem?.transform?.[5] != newItem?.transform?.[5]);
                          }
                        } else {
                          if (
                            isIntersectsEdges ||            // the visible boundary between cells
                            hasEOTCondition ||             // grid logic requires separation
                            (lastItem.transform[5] != newItem.transform[5] && !intersectsX) // different lines without intersection along X
                          ) {
                            lastItem['hasEOT'] = true;
                          }
                        }
                      }
                    }
                  }

                  if (newItem) {
                    if (hasEOTCondition || reservedLastItemEOT) {
                      // Separation confirmed: newItem — the start of a new text block
                      newItem['hasEOT'] = true;
                    } else {
                      // No conditions for separation: newItem continues the current block
                      // hasEOL controls line wrapping, but not the end of the block
                      newItem['hasEOT'] = false;
                    }

                    let lineBreakNeeded = newItem['hasEOL'];

                    // The trailing period of the leader's name, which appears as a separate Tj, is separated by a space according to the same rule
                    const needsLeaderGap = !!createLeaderGapGlyph(lastItem?.chars, newItem.chars, newItem.height);

                    updateChars({
                      item: newItem,
                      lineBreakNeeded,
                      spaceNeeded: spaceNeeded(newItem, lastItem) || needsLeaderGap,
                      fontSpaceWidth: fontSpaceWidths[fontName],
                    });
                  }
                  current['pathConstructed'] = false;
                }

              }
              //index++; //BUG no synchronization with pageTextContent.items
              // RESET ONLY AFTER ALL SEGMENTS
              //current['pathConstructed'] = false;
            }
          }

          // Final safety net: catches anything that isn't followed by
          // either `setFont` or `setTextMatrix` (for example, the very last block
          // of text on the page before `endText`).
          flushStaleTableContentItemsCache();
          recoverTruncatedTails();

          /**
           * Repairs items that lost their last glyph(s) while the interpreter built them
           * ("73,980,669" -> "73,980,66"). pdf.js getTextContent() is an independent source of
           * the full string, so an item is repaired only when ALL of these hold:
           *   - the item text (without spaces) is a STRICT PREFIX of a pdf.js item that starts at
           *     the same x and baseline;
           *   - at most 3 glyphs are missing and they are letters / digits / . , % );
           *   - the width pdf.js reports beyond our right edge matches those glyphs;
           *   - no other item already occupies that tail (a legitimate split into two cells).
           */
          function recoverTruncatedTails(): void {
            const references = (pageTextContent.items || []).filter(
              (reference: any) =>
                reference &&
                typeof reference.str === 'string' &&
                reference.str.trim() &&
                reference.transform &&
                reference.transform.length >= 6 &&
                Number.isFinite(reference.width),
            );
            if (!references.length) {
              return;
            }

            const compact = (text: string) => String(text || '').replace(/\s+/g, '');
            const isVisibleGlyph = (glyph: any) =>
              !!glyph &&
              typeof glyph === 'object' &&
              typeof glyph.unicode === 'string' &&
              glyph.unicode.trim().length > 0 &&
              Number.isFinite(glyph.x) &&
              Number.isFinite(glyph.charWidth);

            const getExtent = (item: any) => {
              const glyphs = (item?.chars || []).filter(isVisibleGlyph);
              if (!glyphs.length) {
                return null;
              }
              const rightmost = glyphs.reduce(
                (best: any, glyph: any) => (glyph.x + glyph.charWidth > best.x + best.charWidth ? glyph : best),
                glyphs[0],
              );
              return {
                left: Math.min(...glyphs.map((glyph: any) => glyph.x)),
                right: rightmost.x + rightmost.charWidth,
                rightmost,
              };
            };

            const skipped: any[] = [];

            tableContentItems.forEach((item: any) => {
              if (!item?.transform || item.imageName || !Array.isArray(item.chars) || !item.chars.length) {
                return;
              }
              if (!isHorizontalText(item) || /\n/.test(String(item.str || '').trim())) {
                return;
              }
              const visibleText = compact(item.str);
              const extent = getExtent(item);
              if (!visibleText || !extent) {
                return;
              }

              const height = Math.max(Math.abs(item.transform[3]) || item.height || 1, 1);
              const baselineTolerance = Math.max(height * 0.3, 0.5);

              const reference = references.find((candidate: any) => {
                if (Math.abs(candidate.transform[5] - item.transform[5]) > baselineTolerance) {
                  return false;
                }
                if (Math.abs(candidate.transform[4] - extent.left) > 1) {
                  return false;
                }
                const referenceText = compact(candidate.str);
                return referenceText.length > visibleText.length && referenceText.startsWith(visibleText);
              });
              if (!reference) {
                return;
              }

              const missing = compact(reference.str).slice(visibleText.length);
              const referenceRight = reference.transform[4] + reference.width;
              const tailWidth = referenceRight - extent.right;
              const reject = (reason: string) =>
                skipped.push({ reason, text: item.str, reference: reference.str, tailWidth: +tailWidth.toFixed(2) });

              if (missing.length > 3 || !/^[\p{L}\p{N}.,%)]+$/u.test(missing)) {
                return reject('tail is not a short word/number');
              }
              if (tailWidth < height * 0.1 * missing.length || tailWidth > height * 0.9 * missing.length) {
                return reject('tail width does not match the missing glyphs');
              }

              const occupied = tableContentItems.some((other: any) => {
                if (other === item || !other?.transform || other.imageName || !String(other.str || '').trim()) {
                  return false;
                }
                if (Math.abs(other.transform[5] - item.transform[5]) > baselineTolerance) {
                  return false;
                }
                const otherLeft = getExtent(other)?.left ?? other.transform[4];
                return otherLeft >= extent.right - 0.5 && otherLeft <= referenceRight + 0.5;
              });
              if (occupied) {
                return reject('tail is already a separate item');
              }

              const glyphWidth = tailWidth / missing.length;
              const em = height * 0.001; // glyph.width is stored in 1/1000 em
              const readingLength = Math.hypot(item.transform[0], item.transform[1]) || 1;
              const last = extent.rightmost;

              const glyphs = Array.from(missing).map((character: string, index: number) => {
                const x = extent.right + glyphWidth * index;
                const glyph: any = {
                  originalCharCode: character.charCodeAt(0),
                  fontChar: character,
                  unicode: character,
                  accent: null,
                  width: glyphWidth / em,
                  isSpace: false,
                  isInFont: true,
                  isLineBreak: false,
                  x,
                  y: Number.isFinite(last.y) ? last.y : item.transform[5],
                  charWidth: glyphWidth,
                  advanceWidth: glyphWidth,
                  wordSpacingWidth: 0,
                };
                if (Number.isFinite(last._pageX) && Number.isFinite(last._pageY)) {
                  glyph._pageX = last._pageX + ((x - last.x) * item.transform[0]) / readingLength;
                  glyph._pageY = last._pageY + ((x - last.x) * item.transform[1]) / readingLength;
                }
                return glyph;
              });

              const before = item.str;
              item.chars.splice(item.chars.lastIndexOf(last) + 1, 0, ...glyphs);
              const textEnd = String(item.str).replace(/\s+$/, '').length;
              item.str = String(item.str).slice(0, textEnd) + missing + String(item.str).slice(textEnd);
              item.width = Math.max(item.width || 0, extent.right + tailWidth - item.transform[4]);
            });
          }


          /**
           * The last glyph of the first word and the first glyph of the second word are flush against each other on the same baseline,
           * and there is no visible vertical line between them—this is a single word or number (11,062 | . | 6).
           */
          function areGlyphsTouchingOnSameLine(first: any, second: any): boolean {
            if (!first?.transform || !second?.transform || first.imageName || second.imageName) return false;
            if (!isHorizontalText(first) || !isHorizontalText(second)) return false;

            const firstEnd = getVisibleGlyphEdge(first, true);
            const secondStart = getVisibleGlyphEdge(second, false);
            if (!firstEnd || !secondStart) return false;

            const height = Math.max(Math.abs(second.transform[3]) || second.height || 1, 1);
            if (Math.abs(firstEnd.y - secondStart.y) > Math.max(height * 0.15, 0.3)) return false;

            const tolerance = Math.max(height * 0.08, 0.3);
            if (Math.abs(secondStart.left - firstEnd.right) > tolerance) return false;

            const junctionX = (firstEnd.right + secondStart.left) / 2;
            const hasRuleBetween = [...(edges || []), ...(rectanglesEdges || [])].some(edge => {
              if (!isVisibleVector(edge)) return false;
              const isVertical = edge.width < lineMaxWidth * 2 && edge.height > lineMaxWidth;
              return (
                isVertical &&
                edge.x + edge.width >= junctionX - tolerance &&
                edge.x <= junctionX + tolerance &&
                secondStart.y >= edge.y - tolerance &&
                secondStart.y <= edge.y + edge.height + tolerance
              );
            });

            return !hasRuleBetween;
          }

          function hasVerticalSeparatorBetween(firstItem, secondItem) {
            const first = getTextAnchor(firstItem);
            const second = getTextAnchor(secondItem);

            const minX = Math.min(first.x, second.x);
            const maxX = Math.max(first.x, second.x);

            if (maxX - minX < lineMaxWidth) {
              return false;
            }

            return [
              ...edges,
              ...(rectanglesEdges || [])
            ].some(edge => {
              if (!isVisibleVector(edge)) {
                return false;
              }

              const isVertical =
                edge.width < lineMaxWidth * 2 &&
                edge.height > lineMaxWidth;

              if (!isVertical) {
                return false;
              }

              // Text is usually positioned very close to the border of its
              // cell (with a small internal indent, often less than
              // lineMaxWidth)—so requiring a gap of an entire
              // lineMaxWidth on BOTH sides is too strict and may
              // overlook the actual border between two adjacent
              // colspan cells. A small epsilon is sufficient
              // to avoid confusing the border with the anchor coordinate itself.
              const edgeMargin = 0.5;

              if (
                edge.x <= minX + edgeMargin ||
                edge.x >= maxX - edgeMargin
              ) {
                return false;
              }

              const edgeTop = edge.y;
              const edgeBottom = edge.y + edge.height;

              const y1 = first.y;
              const y2 = second.y;

              const minY = Math.min(y1, y2);
              const maxY = Math.max(y1, y2);

              return (
                edgeBottom >= minY - lineMaxWidth &&
                edgeTop <= maxY + lineMaxWidth
              );
            });
          }

          function hasHorizontalSeparatorBetween(firstItem, secondItem) {
            const first = getTextAnchor(firstItem);
            const second = getTextAnchor(secondItem);

            const minY = Math.min(first.y, second.y);
            const maxY = Math.max(first.y, second.y);

            if (maxY - minY < lineMaxWidth) {
              return false;
            }

            return [
              ...edges,
              ...(rectanglesEdges || [])
            ].some(edge => {
              if (!isVisibleVector(edge)) {
                return false;
              }

              const isHorizontal =
                edge.height < lineMaxWidth * 2 &&
                edge.width > lineMaxWidth;

              if (!isHorizontal) {
                return false;
              }

              // Same logic as in `hasVerticalSeparatorBetween`.
              const edgeMargin = 0.5;

              if (
                edge.y <= minY + edgeMargin ||
                edge.y >= maxY - edgeMargin
              ) {
                return false;
              }

              const edgeLeft = edge.x;
              const edgeRight = edge.x + edge.width;

              const x1 = first.x;
              const x2 = second.x;

              const minX = Math.min(x1, x2);
              const maxX = Math.max(x1, x2);

              return (
                edgeRight >= minX - lineMaxWidth &&
                edgeLeft <= maxX + lineMaxWidth
              );
            });
          }



          function areInSameRotatedCell(firstItem, secondItem) {
            if (
              !isRotatedText(firstItem) &&
              !isRotatedText(secondItem)
            ) {
              return false;
            }

            if (hasVerticalSeparatorBetween(firstItem, secondItem)) {
              return false;
            }

            if (hasHorizontalSeparatorBetween(firstItem, secondItem)) {
              return false;
            }

            return true;
          }

          /**
 * Items created by flushStaleTableContentItemsCache() live at the end of
 * tableContentItems, so two neighbouring array entries are not necessarily
 * neighbours in the document. If such items are stacked in one column and the
 * line pitch is tight (gap < 1.25 * height), the "chain" pass glues them into
 * one multi-line cell.
 *
 * Two stacked flushed items are independent rows when BOTH of them have a
 * "row mate": a regular (not flushed), already finished text cell (hasEOT) on
 * the same baseline in another column, and the row mates of the two lines
 * overlap horizontally (i.e. they sit in the same column).
 *
 * Regular items are located before the flushed ones in the array, so their
 * hasEOT flags are already final when the chain pass reaches the flushed items.
 */
          function areStaleItemsOnSeparateRows(firstItem: any, secondItem: any): boolean {
            if (!firstItem?.isStaleFlush || !secondItem?.isStaleFlush) {
              return false;
            }

            const getRowMates = (item: any): any[] => {
              const baseline = item.transform[5];
              const itemHeight = Math.max(Math.abs(item.transform[3]) || item.height || 1, 1);
              const baselineTolerance = Math.max(itemHeight * 0.5, 1);
              const itemLeft = item.transform[4];
              const itemRight = itemLeft + (item.width || 0);

              return tableContentItems.filter((candidate: any) => {
                if (!candidate?.transform || candidate === item || candidate.imageName) {
                  return false;
                }
                if (candidate.isStaleFlush || candidate.hasEOT !== true) {
                  return false;
                }
                if (!candidate.str?.trim() || !isHorizontalText(candidate)) {
                  return false;
                }
                if (Math.abs(candidate.transform[5] - baseline) > baselineTolerance) {
                  return false;
                }

                // The mate must live in another column (to the left or to the right).
                const candidateLeft = candidate.transform[4];
                const candidateRight = candidateLeft + (candidate.width || 0);
                return (
                  candidateLeft >= itemRight - baselineTolerance ||
                  candidateRight <= itemLeft + baselineTolerance
                );
              });
            };

            const firstMates = getRowMates(firstItem);
            if (!firstMates.length) {
              return false;
            }
            const secondMates = getRowMates(secondItem);
            if (!secondMates.length) {
              return false;
            }

            const getRange = (item: any): [number, number] => {
              const left = item.transform[4];
              return [left, left + (item.width || 0)];
            };

            return firstMates.some(firstMate => {
              const [firstLeft, firstRight] = getRange(firstMate);
              return secondMates.some(secondMate => {
                const [secondLeft, secondRight] = getRange(secondMate);
                return Math.min(firstRight, secondRight) - Math.max(firstLeft, secondLeft) > 0;
              });
            });
          }


          function detectGlobalPageRotation() {
            const realTextItems = tableContentItems.filter(
              item => item && typeof item.str === 'string' && item.str.trim()
            );

            if (realTextItems.length < 5) return null;

            const rotatedItems = realTextItems.filter(isRotatedTextItem);

            if (rotatedItems.length < realTextItems.length * 0.9) {
              // A standard page where only part of the text is rotated (such as
              // the headings in agstat.pdf)—a global rotation isn't needed here.
              return null;
            }

            // The sign b (transform[1]) determines the direction of rotation:
            // [0, +s, -s, 0, ...] — a +90° rotation (counterclockwise),
            // [0, -s, +s, 0, ...] — a -90° rotation (clockwise).
            let positiveCount = 0;
            let negativeCount = 0;
            for (const item of rotatedItems) {
              if (item.transform[1] > 0) positiveCount++;
              else if (item.transform[1] < 0) negativeCount++;
            }

            const direction = positiveCount >= negativeCount ? 1 : -1;

            return direction;
          }



          const globalRotationDirection = detectGlobalPageRotation();

          if (globalRotationDirection) {
            // direction === 1  → the content is rotated by +90°; rotate it by -90°: (x,y) → (y,-x)
            // direction === -1 → the content is rotated by -90°; rotate it by +90°: (x,y) → (-y,x)
            const rotatePoint = (x, y) =>
              globalRotationDirection === 1 ? [y, -x] : [-y, x];

            // Calculate the bounding box AFTER rotation (but before translation), so that we can then
            // translate everything into the usual positive coordinate range of the page.
            let minX = Infinity, minY = Infinity;
            const allRawPoints = [];

            for (const e of edges) {
              allRawPoints.push([e.x, e.y], [e.x + e.width, e.y + e.height]);
            }
            for (const r of rectangles) {
              allRawPoints.push([r.x, r.y], [r.x + r.width, r.y + r.height]);
            }
            for (const item of tableContentItems) {
              if (!item?.transform) continue;
              allRawPoints.push([item.transform[4], item.transform[5]]);

              for (const glyph of item.chars || []) {
                if (Number.isFinite(glyph?._pageX) && Number.isFinite(glyph?._pageY)) {
                  allRawPoints.push([glyph._pageX, glyph._pageY]);
                }
              }
            }

            for (const [x, y] of allRawPoints) {
              const [rx, ry] = rotatePoint(x, y);
              if (rx < minX) minX = rx;
              if (ry < minY) minY = ry;
            }

            const shiftX = Number.isFinite(minX) ? -minX : 0;
            const shiftY = Number.isFinite(minY) ? -minY : 0;

            function transformPoint(x, y) {
              const [rx, ry] = rotatePoint(x, y);
              return [rx + shiftX, ry + shiftY];
            }

            function transformRect(rect) {
              const [x1, y1] = transformPoint(rect.x, rect.y);
              const [x2, y2] = transformPoint(rect.x + rect.width, rect.y + rect.height);
              rect.x = Math.min(x1, x2);
              rect.y = Math.min(y1, y2);
              rect.width = Math.abs(x2 - x1);
              rect.height = Math.abs(y2 - y1);
            }

            edges.forEach(transformRect);
            rectangles.forEach(transformRect);

            for (const item of tableContentItems) {
              if (!item?.transform) continue;

              const [a, b, c, d, e, f] = item.transform;

              // Transform each character from its own source fragment. This matters
              // when one extractor item was merged from multiple PDF.js text operations.
              let firstGlyphPoint: [number, number] | undefined;

              for (const glyph of item.chars || []) {
                if (!Number.isFinite(glyph?._pageX) || !Number.isFinite(glyph?._pageY)) {
                  continue;
                }

                const [gx, gy] = transformPoint(glyph._pageX, glyph._pageY);
                glyph.x = gx;
                glyph.y = gy;

                if (!firstGlyphPoint && typeof glyph.unicode === 'string' && glyph.unicode.trim()) {
                  firstGlyphPoint = [gx, gy];
                }

                delete glyph._pageX;
                delete glyph._pageY;
              }

              let newA: number;
              let newB: number;
              let newC: number;
              let newD: number;

              if (globalRotationDirection === 1) {
                newA = b;
                newB = -a;
                newC = d;
                newD = -c;
              } else {
                newA = -b;
                newB = a;
                newC = -d;
                newD = c;
              }

              // Use the actual first glyph position, not the merged item's possibly
              // incorrect anchor (which may have come from a later fragment).
              const [newE, newF] = firstGlyphPoint || transformPoint(e, f);

              item.transform = [newA, newB, newC, newD, newE, newF];

              const positioned = (item.chars || []).filter((glyph: any) =>
                glyph &&
                typeof glyph === 'object' &&
                typeof glyph.unicode === 'string' &&
                glyph.unicode.trim() &&
                Number.isFinite(glyph.x) &&
                Number.isFinite(glyph.charWidth)
              );

              if (positioned.length) {
                const left = Math.min(...positioned.map((glyph: any) => glyph.x));
                const right = Math.max(...positioned.map((glyph: any) => glyph.x + (glyph.charWidth || 0)));
                item.width = Math.max(0, right - left);
                item.height = Math.max(item.height || 0, Math.hypot(newC, newD) || 0, 1);
              }
            }
          } else if (!globalRotationDirection) {
            for (const item of tableContentItems) {
              for (const glyph of item.chars || []) {
                if (glyph && typeof glyph === 'object') {
                  delete glyph._pageX;
                  delete glyph._pageY;
                }
              }
            }
          }

          tableContentItems = separateBorderlessColumns(tableContentItems);

          for (let index = 1; index < tableContentItems.length; index++) {
            const previousItem = tableContentItems[index - 1];
            const currentItem = tableContentItems[index];

            if (!previousItem || !currentItem) {
              continue;
            }

            /*
             * A physical table separator has priority over any text-flow
             * heuristic. If it exists between two adjacent fragments,
             * they belong to different cells.
             */
            const hasSeparator =
              hasVerticalSeparatorBetween(
                previousItem,
                currentItem
              ) ||
              hasHorizontalSeparatorBetween(
                previousItem,
                currentItem
              );

            if (hasSeparator) {
              previousItem.hasEOT = true;
              continue;
            }

            /*
             * Rotated fragments that belong to the same cell.
             */
            if (
              areInSameRotatedCell(
                previousItem,
                currentItem
              )
            ) {
              const lineDistance = getTextLineDistance(
                previousItem,
                currentItem
              );

              const previousHeight =
                Math.abs(previousItem?.transform?.[3]) ||
                previousItem?.height ||
                1;

              const currentHeight =
                Math.abs(currentItem?.transform?.[3]) ||
                currentItem?.height ||
                1;

              const lineTolerance = Math.max(Math.min(previousHeight, currentHeight) * 0.6, 2);

              // Previously, the decision on "whether a line break is needed BETWEEN previousItem and
              // currentItem" was stored in currentItem.hasEOL. However,
              // when concatenating text, extractCoordinates() checks hasEOL
              // of the PREVIOUS element (data[index-1].hasEOL), meaning
              // the line break was actually applied only to the NEXT
              // pair—the first line break in each multi-line cell
              // was lost, while the rest “shifted” one position and
              // appeared correct only because the line spacing
              // is almost the same everywhere. We’ll implement the solution where
              // extractCoordinates actually uses it.
              previousItem.hasEOT = false;
              previousItem.hasEOL = lineDistance > lineTolerance;

              continue;
            }

            if (areGlyphsTouchingOnSameLine(previousItem, currentItem)) {
              previousItem.hasEOT = false;
              previousItem.hasEOL = false;
              continue;
            }

            /*
             * Ordinary horizontal text belonging to the same cell.
             *
             * Overlapping X ranges without a physical separator mean
             * that the fragments are inside one cell, even if the old
             * EOT heuristic decided otherwise.
             */
            if (
              isHorizontalText(previousItem) &&
              isHorizontalText(currentItem) &&
              // A bare space stub (a trailing space from the previous
              // cell/column) — an extremely narrow fragment whose X position
              // may coincidentally align with the start of the NEXT line from
              // a completely different row in the table (as here: “West Bengal”
              // and “Bihar” in twotables_1.pdf—the Y difference is ~23pt, meaning
              // it’s an entirely different row, but the narrow space coincidentally overlaps
              // along the X axis). Any positive xOverlap was previously considered
              // sufficient proof that “this is a single cell”—for
              // real text, this is normal (its boundaries are stable), but
              // for a bare space, this is not a reliable signal at all. If
              // previousItem is just a space, we leave its hasEOT as
              // determined by the main, verified algorithm,
              // rather than redefining it here.
              (previousItem.str || '').trim().length > 0
            ) {
              const previousX = previousItem.transform?.[4] ?? 0;
              const previousRight = previousX + (previousItem.width || 0);
              const currentX = currentItem.transform?.[4] ?? 0;
              const currentRight = currentX + (currentItem.width || 0);
              const xOverlap = Math.min(previousRight, currentRight) - Math.max(previousX, currentX);

              const lineDistance = getTextLineDistance(previousItem, currentItem);
              const previousHeight = Math.abs(previousItem?.transform?.[3]) || previousItem?.height || 1;
              const currentHeight = Math.abs(currentItem?.transform?.[3]) || currentItem?.height || 1;
              const lineTolerance = Math.max(Math.min(previousHeight, currentHeight) * 0.6, 2);
              const isSameLine = lineDistance <= lineTolerance;

              // “Touching” at the edges (0.001 pt, float noise) does not constitute an overlap.
              const touchTolerance = Math.max(Math.min(previousHeight, currentHeight) * 0.1, 0.1);

              // A leader character cannot be the beginning or continuation
              // of a wrapped cell line—it always ends its own line.
              const isLeaderOnLineBreak =
                !isSameLine &&
                (isLeaderOnlyText(previousItem.str) || isLeaderOnlyText(currentItem.str));

              if (xOverlap > touchTolerance && !isLeaderOnLineBreak) {
                // For a pair on a SINGLE line, the overlap should be only
                // a slight “touch” (due to measurement error in the width
                // of the glyphs), not significant—otherwise it is almost certainly
                // simply two adjacent cells in different columns with a slightly
                // overestimated width (such as “8297 ” and “2161” in
                // rotated.pdf, an overlap of 14pt out of a 24–27pt width), rather than
                // a single logical unit broken into fragments. For a pair
                // on DIFFERENT lines (a true line break within
                // a single cell), a large overlap is normal: the column
                // must align horizontally between its own
                // wrapped lines, so we do not
                // apply this condition there.
                const narrowerWidth = Math.min(previousItem.width || 0, currentItem.width || 0);
                const overlapIsSubstantial = narrowerWidth > 0 && xOverlap > narrowerWidth * 0.3;

                if (isSameLine && overlapIsSubstantial) {
                  // Different adjacent cells—we'll leave `hasEOT` as determined
                  // by the main pipeline; we won't change it.
                } else {
                  previousItem.hasEOT = false;
                  previousItem.hasEOL = lineDistance > lineTolerance;
                }
              }
            }



          }

          const tableContentItemsStr = stringifyPseudoJson(
            tableContentItems,
            {
              // 1. Property mapping
              keyMap: {
                index: 'i',
                str: 's',
                width: 'w',
                height: 'h',
                fillColor: 'fc',
                textColor: 'tc',
                fontName: 'fn',
                strokeColor: 'sc',
                transform: 't',
              },

              // 3. Value mapping by property path
              valueMap: {
                textColor: {
                  'rgb(255,255,255)': '#fff',
                  'rgb(0,0,0)': '#000',
                },

                fillColor: {
                  'rgb(255,255,255)': '#fff',
                  'rgb(0,0,0)': '#000',
                },
              },

              // 4. Quote only values of `str`
              quoteValues: new Set([
                'str',
              ]),

              // 5. Remove properties at any nesting depth
              exclude: new Set([
                'chars',
                'altStr',
                'dir',
              ]),

              // 6. Truncate decimal digits without rounding
              numberDigits: 3,
            }
          );

          // Geometric cell boundary for horizontal text.
          // Does not depend on drawn lines: two adjacent fragments cannot
          // be a single cell if the space between them on the same line is greater than
          // 1.5 times the font height, and the fragment on the new line does not have a horizontal
          // overlap with the already accumulated block, or if there is an empty space between them
          // greater than 1.25 times the font height.
          {
            const isPlainHorizontalText = (item) =>
              !!item?.transform &&
              !item.imageName &&
              (item.str || '').trim().length > 0 &&
              isHorizontalText(item) &&
              !isRotatedText(item);

            const getBox = (item) => {
              const t = item.transform;
              const h = Math.abs(t[3]) || item.height || 1;
              return {
                left: t[4],
                right: t[4] + (item.width || 0),
                bottom: t[5],
                top: t[5] + h,
                h
              };
            };

            let chain = null; // combined bounding box of fragments with the last boundary hasEOT

            for (let index = 1; index < tableContentItems.length; index++) {
              const previousItem = tableContentItems[index - 1];
              const currentItem = tableContentItems[index];

              if (!isPlainHorizontalText(previousItem) || !isPlainHorizontalText(currentItem)) {
                chain = null;
                continue;
              }

              const previousBox = getBox(previousItem);
              const currentBox = getBox(currentItem);

              if (previousItem.hasEOT) {
                chain = { ...currentBox };
                continue;
              }

              if (!chain) {
                chain = { ...previousBox };
              }

              const maxHeight = Math.max(previousBox.h, currentBox.h);
              const sameLine =
                Math.abs(currentBox.bottom - previousBox.bottom) <=
                Math.max(Math.min(previousBox.h, currentBox.h) * 0.6, 2);

              let isSeparateCell;

              if (sameLine) {
                const horizontalGap = Math.max(
                  0,
                  currentBox.left - previousBox.right,
                  previousBox.left - currentBox.right
                );

                // Spaces may be included in `str`, but not in `width`.
                // In this case, the geometric spacing is not empty.
                const hasInlineWhitespace =
                  /[^\S\r\n]$/u.test(previousItem.str || '') ||
                  /^[^\S\r\n]/u.test(currentItem.str || '');

                isSeparateCell =
                  !hasInlineWhitespace &&
                  horizontalGap > maxHeight * 1.5;
              } else {
                const horizontalOverlap =
                  Math.min(chain.right, currentBox.right) -
                  Math.max(chain.left, currentBox.left);

                const verticalGap =
                  currentBox.bottom >= chain.top
                    ? currentBox.bottom - chain.top
                    : currentBox.top <= chain.bottom
                      ? chain.bottom - currentBox.top
                      : 0;

                isSeparateCell =
                  horizontalOverlap < 0 ||
                  verticalGap > maxHeight * 1.25 ||
                  areStaleItemsOnSeparateRows(previousItem, currentItem);
              }

              if (isSeparateCell) {
                previousItem.hasEOT = true;
                chain = { ...currentBox };
              } else {
                chain = {
                  left: Math.min(chain.left, currentBox.left),
                  right: Math.max(chain.right, currentBox.right),
                  bottom: Math.min(chain.bottom, currentBox.bottom),
                  top: Math.max(chain.top, currentBox.top),
                  h: maxHeight
                };
              }
            }
          }

          // Columns without lines. We consider the start of a cell to be the column boundary if it is located at the same x
          // in at least 6 rows and almost no text crosses this x. Elements are split exactly there,
          // and adjacent elements on the same row are assigned hasEOT = true if the second one starts at that x.
          function separateBorderlessColumns(items: any[]): any[] {
            const MIN_ROWS = 6;
            const MIN_RATIO = 0.7;           // proportion of lines in which the column is intact
            const START_TOLERANCE = 0.6;     // x-axis drift between lines (≈0.0085 per line)
            const BASELINE_TOLERANCE = 0.6;
            const MIN_INNER_GAP_EM = 0.15;   // gap without spaces inside an element
            const MIN_SPACE_RUN = 2;         // two or more consecutive spaces also mark the start of a cell
            const MAX_ITEMS = 6000;
            const ROW_TOLERANCE = 1.5;
            const MAX_CANDIDATES = 3000;
            pageColumnBorders = [];

            if (!items?.length || items.length > MAX_ITEMS) {
              return items;
            }

            const analyse = (item: any) => {
              if (!item?.transform || item.imageName || !Array.isArray(item.chars)) return null;

              const [a, b] = item.transform;
              // This pass runs after global page rotation. Leave separately rotated
              // text alone; it must not influence the horizontal table-column model.
              if (!(a > 0) || Math.abs(b) > Math.abs(a) * 0.2) return null;

              const glyphs = item.chars
                .map((glyph: any, sourceIndex: number) => ({ glyph, sourceIndex }))
                .filter(({ glyph }: any) =>
                  glyph &&
                  typeof glyph === 'object' &&
                  typeof glyph.unicode === 'string' &&
                  Number.isFinite(glyph.x)
                )
                .map((ref: any, glyphIndex: number) => ({ ...ref, glyphIndex }));

              if (!glyphs.some(({ glyph }: any) => glyph.unicode.trim())) return null;

              const em = Math.max(Math.hypot(a, b), item.height || 0, 1);
              const lines: any[] = [];

              for (const ref of glyphs) {
                const y = Number.isFinite(ref.glyph.y) ? ref.glyph.y : item.transform[5];
                let line = lines[lines.length - 1];

                if (!line || Math.abs(y - line.baseline) > BASELINE_TOLERANCE) {
                  line = { baseline: y, refs: [], left: Infinity, right: -Infinity, innerStarts: [] };
                  lines.push(line);
                }

                line.refs.push(ref);
              }

              const innerStarts: any[] = [];

              for (const line of lines) {
                let previous: any = null;
                let spaceCount = 0;
                let spaceWidth = 0;
                let firstTextRef: any;

                for (const ref of line.refs) {
                  const glyph = ref.glyph;
                  const value = glyph.unicode;

                  if (glyph.isLineBreak || value === '\n') {
                    previous = null;
                    spaceCount = 0;
                    spaceWidth = 0;
                    continue;
                  }

                  if (!value.trim()) {
                    if (previous) {
                      spaceCount++;
                      spaceWidth += Math.abs(glyph.charWidth || 0);
                    }
                    continue;
                  }

                  if (!firstTextRef) firstTextRef = ref;
                  line.left = Math.min(line.left, glyph.x);
                  line.right = Math.max(line.right, glyph.x + (glyph.charWidth || em * 0.5));

                  if (previous) {
                    const gap = glyph.x - (previous.glyph.x + (previous.glyph.charWidth || em * 0.5));
                    const gapWithoutSpaces = spaceCount === 0 && gap >= em * MIN_INNER_GAP_EM;
                    // 0.45 em deliberately covers the ~4.24 pt two-space gap in m27
                    // (0.5 em was 4.26 pt and missed it by about 0.02 pt).
                    const gapBySpaces = spaceCount >= MIN_SPACE_RUN && spaceWidth >= Math.max(em * 0.45, 2);

                    if (gapWithoutSpaces || gapBySpaces) {
                      // The space between two leader glyphs (dot ... dot) represents the rhythm of the leader itself,
                      // not the column boundary. The “last dot → number” boundary remains.
                      const isInsideLeaderRun = isLeaderGlyph(glyph) && isLeaderGlyph(previous.glyph);

                      if (!isInsideLeaderRun) {
                        const boundary = { glyphIndex: ref.glyphIndex, sourceIndex: ref.sourceIndex, x: glyph.x, y: line.baseline };
                        line.innerStarts.push(boundary);
                        innerStarts.push(boundary);
                      }
                    }
                  }

                  previous = ref;
                  spaceCount = 0;
                  spaceWidth = 0;
                }

                if (firstTextRef) {
                  line.startGlyphIndex = firstTextRef.glyphIndex;
                  line.startSourceIndex = firstTextRef.sourceIndex;
                  line.left = Math.min(line.left, firstTextRef.glyph.x);
                }
              }

              return {
                item,
                glyphs,
                lines: lines.filter((line: any) => Number.isFinite(line.left) && Number.isFinite(line.right)),
                innerStarts,
                em,
              };
            };

            const runs: any[] = items.map(analyse);
            const valid = runs.filter(Boolean);
            if (!valid.length) return items;

            const baselines = [...new Set<number>(valid.flatMap((info: any) =>
              info.lines.map((line: any) => line.baseline)
            ))].sort((a, b) => a - b);

            const rowOf = new Map<number, number>();
            let rowId = -1;
            let rowStart = -Infinity;
            for (const baseline of baselines) {
              if (baseline - rowStart > ROW_TOLERANCE) {
                rowId++;
                rowStart = baseline;
              }
              rowOf.set(baseline, rowId);
            }

            const candidates: Array<{ x: number; row: number; y: number }> = [];
            for (const info of valid) {
              for (const line of info.lines) {
                const row = rowOf.get(line.baseline);
                if (row === undefined) continue;
                candidates.push({ x: line.left, row, y: line.baseline });
                for (const boundary of line.innerStarts) {
                  candidates.push({ x: boundary.x, row, y: boundary.y });
                }
              }
            }

            if (!candidates.length || candidates.length > MAX_CANDIDATES) return items;
            candidates.sort((a, b) => a.x - b.x);

            const clusters: Array<{ xs: number[]; rows: Set<number>; ys: number[] }> = [];
            for (const candidate of candidates) {
              const last = clusters[clusters.length - 1];
              if (last && candidate.x - last.xs[0] <= START_TOLERANCE) {
                last.xs.push(candidate.x);
                last.rows.add(candidate.row);
                last.ys.push(candidate.y);
              } else {
                clusters.push({ xs: [candidate.x], rows: new Set([candidate.row]), ys: [candidate.y] });
              }
            }

            const starts: Array<{ x: number; yFrom: number; yTo: number }> = [];
            for (const cluster of clusters) {
              if (cluster.rows.size < MIN_ROWS) continue;
              const xs = [...cluster.xs].sort((a, b) => a - b);
              const center = xs[Math.floor(xs.length / 2)];
              const crossingRows = new Set<number>();

              for (const info of valid) {
                for (const line of info.lines) {
                  const row = rowOf.get(line.baseline);
                  if (row === undefined) continue;

                  const startsHere =
                    Math.abs(line.left - center) <= START_TOLERANCE ||
                    line.innerStarts.some((boundary: any) => Math.abs(boundary.x - center) <= START_TOLERANCE);
                  const crosses = line.left < center - START_TOLERANCE && line.right > center + START_TOLERANCE;

                  if (crosses && !startsHere) crossingRows.add(row);
                }
              }

              // A row with a confirmed start is not also counted as a conflicting row.
              const conflictingRows = [...crossingRows].filter(row => !cluster.rows.has(row));
              const ratio = cluster.rows.size / Math.max(cluster.rows.size + conflictingRows.length, 1);

              if (ratio >= MIN_RATIO) {
                starts.push({
                  x: center,
                  yFrom: Math.min(...cluster.ys),
                  yTo: Math.max(...cluster.ys),
                });
              }
            }

            starts.sort((a, b) => a.x - b.x);
            if (!starts.length) return items;

            const isColumnStart = (x: number) => starts.some(start => Math.abs(start.x - x) <= START_TOLERANCE);

            const result: any[] = [];
            for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
              const item = items[itemIndex];
              const info = runs[itemIndex];
              if (!info) {
                result.push(item);
                continue;
              }


              const cutMap = new Map<number, number>();// sourceIndex -> geometric X
              for (const boundary of info.innerStarts) {
                if (isColumnStart(boundary.x)) {
                  cutMap.set(boundary.sourceIndex, boundary.x);
                }
              }

              // A word that starts exactly on a column start right after ONE space ("... GRILL 19 INC").
              // No gap is wide enough to be recorded in innerStarts, yet the text visibly continues in
              // the next column. The cut is made only when the column start is already confirmed by
              // other rows (isColumnStart) and the glyph before the space is a visible one.
              const isVisibleRef = (ref: any) => !!ref.glyph.unicode.trim();
              for (let glyphIndex = 2; glyphIndex < info.glyphs.length; glyphIndex++) {
                const current = info.glyphs[glyphIndex];
                const space = info.glyphs[glyphIndex - 1];
                const before = info.glyphs[glyphIndex - 2];

                if (!isVisibleRef(current) || isVisibleRef(space) || !isVisibleRef(before)) {
                  continue;
                }
                if (space.glyph.isLineBreak || space.glyph.unicode === '\n') {
                  continue;
                }
                if (!isColumnStart(current.glyph.x)) {
                  continue;
                }
                if (
                  Number.isFinite(current.glyph.y) &&
                  Number.isFinite(before.glyph.y) &&
                  Math.abs(current.glyph.y - before.glyph.y) > BASELINE_TOLERANCE
                ) {
                  continue;
                }
                if (isLeaderGlyph(current.glyph) && isLeaderGlyph(before.glyph)) {
                  continue;
                }

                cutMap.set(current.sourceIndex, current.glyph.x);
              }

              // A source text item can encode different cells separated by a PDF line move.
              // Split at a repeated column start when the next visual line starts in another column;
              // do not split ordinary multiline cell content whose lines start at the same X.
              for (let lineIndex = 1; lineIndex < info.lines.length; lineIndex++) {
                const line = info.lines[lineIndex];
                const previousLine = info.lines[lineIndex - 1];
                if (
                  line.startGlyphIndex > 0 &&
                  isColumnStart(line.left) &&
                  Math.abs(line.left - previousLine.left) > START_TOLERANCE
                ) {
                  const ref = info.glyphs[line.startGlyphIndex];
                  if (ref) cutMap.set(ref.sourceIndex, line.left);
                }
              }

              const cuts = [...cutMap.keys()].filter(index => index > 0 && index < item.chars.length).sort((a, b) => a - b);
              const uniqueCuts = cuts.filter((cut, index) => index === 0 || cut !== cuts[index - 1]);
              if (!uniqueCuts.length) {
                result.push(item);
                continue;
              }

              const pieceStarts = [0, ...uniqueCuts];
              const pieceEnds = [...uniqueCuts, item.chars.length];

              for (let pieceIndex = 0; pieceIndex < pieceStarts.length; pieceIndex++) {
                const isFirst = pieceIndex === 0;
                const isLast = pieceIndex === pieceStarts.length - 1;
                let chars = item.chars.slice(pieceStarts[pieceIndex], pieceEnds[pieceIndex]);

                while (!isFirst && chars.length && typeof chars[0]?.unicode === 'string' && !chars[0].unicode.trim()) {
                  chars = chars.slice(1);
                }
                while (!isLast && chars.length && typeof chars[chars.length - 1]?.unicode === 'string' && !chars[chars.length - 1].unicode.trim()) {
                  chars = chars.slice(0, -1);
                }
                while (!isLast && chars.length && chars[chars.length - 1]?.isLineBreak) {
                  chars = chars.slice(0, -1);
                }

                const solid = chars.filter((glyph: any) =>
                  glyph && typeof glyph === 'object' &&
                  typeof glyph.unicode === 'string' && glyph.unicode.trim() &&
                  Number.isFinite(glyph.x) && Number.isFinite(glyph.y)
                );
                if (!solid.length) continue;

                const first = solid[0];
                const left = Math.min(...solid.map((glyph: any) => glyph.x));
                const right = Math.max(...solid.map((glyph: any) => glyph.x + (glyph.charWidth || 0)));
                const str = chars.map((glyph: any) =>
                  typeof glyph === 'object' ? glyph.unicode || '' : ''
                ).join('');

                result.push({
                  ...item,
                  chars,
                  str,
                  width: Math.max(0, right - left),
                  transform: [item.transform[0], item.transform[1], item.transform[2], item.transform[3], first.x, first.y],
                  hasEOT: isLast ? item.hasEOT : true,
                  hasEOL: isLast ? item.hasEOL : false,
                });
              }
            }

            const getExtent = (item: any) => {
              const solid = (item.chars || []).filter((glyph: any) =>
                glyph && typeof glyph === 'object' &&
                typeof glyph.unicode === 'string' && glyph.unicode.trim() &&
                Number.isFinite(glyph.x) && Number.isFinite(glyph.charWidth)
              );
              if (!solid.length) {
                return item.transform
                  ? { left: item.transform[4], right: item.transform[4] + (item.width || 0) }
                  : null;
              }
              return {
                left: Math.min(...solid.map((glyph: any) => glyph.x)),
                right: Math.max(...solid.map((glyph: any) => glyph.x + (glyph.charWidth || 0))),
              };
            };

            for (let i = 1; i < result.length; i++) {
              const previous = result[i - 1];
              const current = result[i];
              if (!previous?.transform || !current?.transform || previous.hasEOT) continue;

              const previousExtent = getExtent(previous);
              const currentExtent = getExtent(current);
              if (!previousExtent || !currentExtent) continue;

              const sameLine = Math.abs(previous.transform[5] - current.transform[5]) <= BASELINE_TOLERANCE;
              if (
                sameLine &&
                previousExtent.right <= currentExtent.left + START_TOLERANCE &&
                isColumnStart(currentExtent.left)
              ) {
                previous.hasEOT = true;
              }
            }

            const sortedStarts = [...starts].sort((a, b) => a.x - b.x);
            const extents = result.map(getExtent);

            pageColumnBorders = sortedStarts
              .map((start, index) => {
                const previousStart = index > 0 ? sortedStarts[index - 1].x : -Infinity;
                let previousRight = -Infinity;

                extents.forEach(extent => {
                  if (!extent) {
                    return;
                  }
                  if (!(extent.left < start.x - START_TOLERANCE && extent.right <= start.x + START_TOLERANCE)) {
                    return;
                  }
                  // Text of the previous column. A header is usually centred over its column, so it may begin
                  // LEFT of the column start (the data below) and still end inside the column: it belongs here too.
                  const startsInColumn = extent.left >= previousStart - START_TOLERANCE;
                  const endsInColumn = extent.right > previousStart + START_TOLERANCE;
                  if (startsInColumn || endsInColumn) {
                    previousRight = Math.max(previousRight, extent.right);
                  }
                });

                const limit = start.x - 0.3;
                return {
                  x: Number.isFinite(previousRight) ? Math.min(limit, previousRight + 0.3) : limit,
                  hasContentOnTheLeft: Number.isFinite(previousRight),
                  yFrom: start.yFrom,
                  yTo: start.yTo,
                };
              })
              // Nothing lies left of the first column start: the table edge is its border, not a column boundary.
              .filter((border, index) => index > 0 || border.hasContentOnTheLeft)
              .map(({ x, yFrom, yTo }) => ({ x, yFrom, yTo }));
            return result;
          }

          // Function for extracting text coordinates
          function extractCoordinates(data) {

            let hasContent = (item) => item && (item['str']?.trim() || item['images']?.length);

            let coordinates = JSON.parse(JSON.stringify(data))
              .reduce((prev, item, index, arr) => {
                if (!item) return prev;
                let lastItem = prev[prev.length - 1];
                let hasEOT = data?.[index - 1]?.hasEOT;
                let hasEOL = data?.[index - 1]?.hasEOL;
                let [a, b, c, d, x, y] = item.transform;

                function getItemHeight(item) {
                  return Math.abs(item?.transform?.[3]) || item?.height || 1;
                }
                function getItemWidth(item) {
                  if (!item) return 0;
                  if (item.width > 1) return item.width;
                  return item.chars?.reduce((sum, ch) => {
                    if (typeof ch === 'number') return sum;
                    return sum + (ch?.charWidth || 0);
                  }, 0) || 0;
                }


                //Remove unnecessary spaces
                if (!item.imageName && !item.str?.trim() && (item.hasEOL || item.hasEOT)) {
                  if (item.hasEOL && lastItem) {
                    lastItem.hasEOL = true;
                    updateChars({ item: lastItem, lineBreakNeeded: lastItem.hasEOL, spaceNeeded: false });
                  } else if (item.hasEOT && lastItem) {
                    lastItem.hasEOT = true;
                  }
                  return prev;
                }

                // A coordinate that so far holds only whitespace must not swallow the next item: the merged
                // block would start at the whitespace and pull the text into the wrong column.
                const startsAfterBlankLead =
                  !!lastItem && !item.imageName && !lastItem.imageName && !hasContent(lastItem);

                if (hasEOT || index == 0 || startsAfterBlankLead) {
                  // A synthetic “spacing” space is not needed at the cell border. It has no coordinates,
                  // unlike a real space from a PDF, so the real spaces are not affected.
                  const leadingGlyph = item.chars?.[0];
                  if (leadingGlyph?.isSpace && !Number.isFinite(leadingGlyph.x) && /^\s/.test(item.str || '')) {
                    item.chars = item.chars.slice(1);
                    item.str = item.str.slice(1);
                  }
                  let newItem = {
                    index: index,
                    str: item?.str || '',
                    x,
                    y,
                    width: getItemWidth(item),
                    height: getItemHeight(item),
                    chars: item.chars || [],
                    templateStr: item?.str || '',
                    transform: item.transform,
                    textColor: item.textColor || null,
                  };

                  if (item.imageName) {
                    newItem['images'] = [];
                    newItem['images'].push({ ...item });
                    newItem['templateStr'] = `[-${item.imageName}-]`;
                  }

                  // Find ALL rectangles that contain a text block.
                  // A cell's background can consist of several overlapping translucent layers.
                  // --- START: Searching for the background of a cell with a composition of overlapping layers ---
                  let matchingRects = rectangles.filter(item => {
                    let inRange = (checkRectangleRanges(item, newItem, { strict: true, strictIntersecting: true, axis: ['x', 'y'] }) as Array<any>).every(item => item.inRange);
                    return inRange;
                  });

                  // let matchingEdgeFills = edges.filter(e => {
                  //   if (!e.fillColor) return false;
                  //   if (e.width < lineMaxWidth * 2 && e.height < lineMaxWidth * 2) return false;
                  //   let inRange = (checkRectangleRanges(e, newItem, { strict: true, strictIntersecting: true, axis: ['x', 'y'] }) as Array<any>).every(item => item.inRange);
                  //   return inRange;
                  // });

                  let visibleRects = matchingRects.filter(r => isVisibleVector(r));

                  let allFills = visibleRects.map(r => r.fillColor).filter(Boolean);

                  let fillColor = allFills.length > 1 ? compositeCellColors(allFills) : (allFills[0] || null);
                  let rectangle = visibleRects[0];
                  let strokeColor = rectangle?.strokeColor || null;
                  // --- END: Search for cell background ---

                  removeLineBreak(lastItem);
                  if (lastItem && !hasContent(lastItem)) {
                    removeByIndexes(prev, [prev.length - 1]);
                  }

                  if (index == arr.length - 1) {
                    removeLineBreak(newItem);
                  }

                  if (!(!hasContent(newItem) && (index == arr.length - 1))) {
                    prev.push(Object.assign(newItem, {
                      fontName: item.fontName,
                      fillColor: fillColor,
                      strokeColor: strokeColor
                    }));
                  }

                } else {
                  if (!lastItem) return prev;

                  // --- Protection against merging elements from different cells ---
                  // If the current element (especially an image) is far from lastItem,
                  // do not merge, but start a new coordinate block.
                  if (item.imageName || lastItem.imageName) {
                    let xOverlap = !(lastItem.x + lastItem.width < x || x + item.width < lastItem.x);
                    let yOverlap = !(lastItem.y + lastItem.height < y || y + item.height < lastItem.y);
                    if (!xOverlap && !yOverlap) {
                      // There is no intersection in terms of coordinates — these are different cells.
                      let newItem = {
                        index: index,
                        str: item?.str || '',
                        x, y,
                        width: getItemWidth(item),
                        height: getItemHeight(item),
                        chars: item.chars || [],
                        templateStr: item?.str || '',
                        transform: item.transform
                      };
                      if (item.imageName) {
                        newItem['images'] = [];
                        newItem['images'].push({ ...item });
                        newItem['templateStr'] = `[-${item.imageName}-]`;
                      }
                      removeLineBreak(lastItem);
                      if (lastItem && !hasContent(lastItem)) {
                        removeByIndexes(prev, [prev.length - 1]);
                      }
                      if (index == arr.length - 1) {
                        removeLineBreak(newItem);
                      }
                      prev.push(Object.assign(newItem, {
                        fontName: item.fontName,
                        fillColor: null,
                        strokeColor: null
                      }));
                      return prev;
                    }
                  }
                  // --- END OF PROTECTION ---

                  let itemHeight = getItemHeight(item);
                  let itemWidth = getItemWidth(item);
                  let lastItemHeight = getItemHeight(lastItem);
                  let lastItemWidth = getItemWidth(lastItem);

                  // For text rotated by 90°, adjacent “lines” of a single logical
                  // cell are arranged along page-X (rather than along page-Y, as with regular
                  // horizontal text), and the length of each individual line extends
                  // along page-Y (rather than page-X). The formulas below were written with
                  // horizontal text in mind, where itemHeight is the “Y-direction contribution,” and
                  // itemWidth is the “X-axis contribution.” For the rotated case, it’s literally
                  // the opposite: itemHeight (line thickness, ~font) is the X-axis contribution, and
                  // itemWidth (line length) is the Y-axis contribution. The old formula confused these
                  // roles, causing the resulting bounding box to no longer match the
                  // actual position on the page (confirmed by direct measurement
                  // of coordinates) and breaking the element’s alignment with the column/row grids further
                  // down the pipeline.
                  let mergingRotated =
                    lastItem.__isRotatedMerge ||
                    isRotatedText(lastItem) ||
                    isRotatedText(item);

                  let height, width;

                  if (mergingRotated) {
                    // We construct the bounding box of a line using its actual direction
                    // vectors from the transform (reading direction and ascent direction),
                    // rather than rigidly assuming that “height is always along the +X axis, width is always along the +Y axis.”
                    // Previously, this happened to give the correct WIDTH of the resulting block (both
                    // errors canceled each other out), but it shifted the X position itself exactly by
                    // the value of `height` in the wrong direction—which was confirmed by measurements in
                    // Photoshop. Using vectors, the position remains correct regardless of
                    // which way the text is rotated (+90° or -90°).
                    const rotationSource = (item.transform && item.transform.length >= 4)
                      ? item.transform
                      : lastItem.transform;

                    const [srcA, srcB, srcC, srcD] = rotationSource;

                    const readingLength = Math.hypot(srcA, srcB) || 1;
                    const ascentLength = Math.hypot(srcC, srcD) || 1;

                    const readingUnit = [srcA / readingLength, srcB / readingLength];
                    const ascentUnit = [srcC / ascentLength, srcD / ascentLength];

                    function getLineCorners(anchorX, anchorY, lineWidth, lineHeight) {
                      const corners = [];
                      for (const t of [0, lineWidth]) {
                        for (const s of [0, lineHeight]) {
                          corners.push([
                            anchorX + readingUnit[0] * t + ascentUnit[0] * s,
                            anchorY + readingUnit[1] * t + ascentUnit[1] * s,
                          ]);
                        }
                      }
                      return corners;
                    }

                    let prevBounds = lastItem.__rotatedBounds;
                    if (!prevBounds) {
                      const ownCorners = getLineCorners(lastItem.x, lastItem.y, lastItemWidth, lastItemHeight);
                      prevBounds = {
                        minX: Math.min(...ownCorners.map(corner => corner[0])),
                        maxX: Math.max(...ownCorners.map(corner => corner[0])),
                        minY: Math.min(...ownCorners.map(corner => corner[1])),
                        maxY: Math.max(...ownCorners.map(corner => corner[1])),
                      };
                    }

                    const newCorners = getLineCorners(x, y, itemWidth, itemHeight);

                    let bounds = {
                      minX: Math.min(prevBounds.minX, ...newCorners.map(corner => corner[0])),
                      maxX: Math.max(prevBounds.maxX, ...newCorners.map(corner => corner[0])),
                      minY: Math.min(prevBounds.minY, ...newCorners.map(corner => corner[1])),
                      maxY: Math.max(prevBounds.maxY, ...newCorners.map(corner => corner[1])),
                    };

                    x = bounds.minX;
                    y = bounds.minY;
                    width = Math.max(bounds.maxX - bounds.minX, 1);
                    height = Math.max(bounds.maxY - bounds.minY, 1);

                    lastItem.__rotatedBounds = bounds;
                  } else {
                    height = Math.max(lastItem.y + lastItemHeight, y + itemHeight) - Math.min(lastItem.y, y);
                    width = lastItem.y == y
                      ? (((x + itemWidth) < (lastItem.x + lastItemWidth)) ? lastItemWidth : ((x + itemWidth) - lastItem.x))
                      : Math.max(itemWidth, lastItemWidth);
                    x = Math.min(lastItem.x, x);
                  }

                  // Sometimes the PDF renders several lines of a single logical cell NOT in
                  // the visual top-to-bottom order (the narrow column “I”/‘UI’/“T” in
                  // background_lines_2.pdf is rendered in the order “UI”, “T”, ‘I’, even though “I”
                  // is physically located above “UI,” which is above “T”). Previously, a new
                  // fragment was always appended to the END of the accumulated line—that is,
                  // strictly in the order of appearance in the content stream, rather than in the order
                  // of its actual position on the page. We track the topmost Y value
                  // that has already been included in the accumulated cell, and if the new fragment is physically
                  // above it—we insert it at the beginning rather than at the end.
                  let accumulatedTopY = lastItem.__mergedTopY ?? lastItem.y;
                  let newItemIsAboveAccumulated = y > accumulatedTopY + 0.5;

                  let lastStr = lastItem?.str || '';
                  let itemStr = item?.str || '';
                  let str, chars;

                  if (newItemIsAboveAccumulated) {
                    let needsLeadingBreak = hasEOL && !itemStr.endsWith('\n');
                    if (needsLeadingBreak) { itemStr += '\n'; }
                    str = itemStr + lastStr;
                    let leadingBreakChar = needsLeadingBreak ? [{ originalCharCode: 10, fontChar: "\n", unicode: "\n", accent: null, width: 0, isSpace: false, isInFont: true, isLineBreak: true, }] : [];
                    chars = [...(item.chars || []), ...leadingBreakChar, ...(lastItem.chars || [])];
                  } else {
                    let needsSyntheticLineBreak = hasEOL && !lastStr.endsWith('\n');
                    if (needsSyntheticLineBreak) { lastStr += '\n'; }
                    str = [lastStr, itemStr].join('');
                    let syntheticBreakChar = needsSyntheticLineBreak ? [{ originalCharCode: 10, fontChar: "\n", unicode: "\n", accent: null, width: 0, isSpace: false, isInFont: true, isLineBreak: true, }] : [];
                    chars = [...(lastItem.chars || []), ...syntheticBreakChar, ...(item.chars || [])];
                  }

                  lastItem.__mergedTopY = Math.max(accumulatedTopY, y);
                  x = Math.min(lastItem.x, x);

                  Object.assign(lastItem, {
                    str: str,
                    x: x,
                    y: y,
                    width: width,
                    height: height,
                    chars: chars,
                    textColor: lastItem.textColor || item.textColor || null,
                    transform: [height, 0, 0, height, x, y],
                    __isRotatedMerge: mergingRotated,
                  });

                  if (lastItem['images'] || item.imageName) {
                    lastItem['images'] = [...(lastItem['images'] || []), ...(item.imageName ? [item] : [])];
                  }
                  if (lastItem['templateStr'] || lastItem['images'] || item.imageName) {
                    lastItem['templateStr'] = (lastItem['templateStr'] ? lastItem['templateStr'] : str) + (item.imageName ? `[-${item.imageName}-]` : (item?.str || ''));
                  }

                  if (index == arr.length - 1) {
                    removeLineBreak(lastItem);
                  }
                }

                return prev;
              }, []);

            return coordinates;
          }

          //Function for defining tables
          function defineGroups(options) {
            let { item, type, axis, tolerance, groups, lineMaxWidth, downcheck } = options;
            axis = Array.isArray(axis) ? axis : [axis];

            let isIntersecting = false;

            let getUnique = (arr, axis) => {
              let data = uniqueArr(arr, ['x', 'y', 'width', 'height', 'fillColor', 'strokeColor']);//old, axis
              let sortedData = sortArrayOfObjects(
                data,
                axis.map(axisItem => ({ field: axisItem, order: 'asc' }))
              );

              return sortedData;
            };


            function getProperty(axisItem) {
              let properties = {
                'x': 'width',
                'y': 'height'
              }
              return properties[axisItem];
            };

            function setGridItemsTo(group, sectionName, data) {
              data = data || [];
              data = Array.isArray(data) ? data : [data];
              if (data.length) {
                group[sectionName] = addToGridList(group?.[sectionName], data);//old:[...new Set([...(group?.[sectionName] || []), ...data])]?.sort((a, b) => a - b) || [];
              }

              return group[sectionName];
            }

            function addGridItems(group, item, type) {
              let isVisible = hasVectorColor(item);

              // Nested decoration rectangle: extends the spatial bounds of the group
              // (done by the caller), but must NOT create grid lines.
              if (type === 'rectangles' && nestedRectangles.has(item)) {
                return;
              }

              switch (type) {
                case 'edges': {
                  if ((item.height < lineMaxWidth) && (item.width > lineMaxWidth)) {
                    setGridItemsTo(group, 'rows', [item.y]);
                    setGridItemsTo(group, 'cols', [item.x, item.x + item.width]);
                    if (isVisible) {
                      setGridItemsTo(group, 'edgesRows', [item.y]);
                      setGridItemsTo(group, 'edgesCols', [item.x, item.x + item.width]);
                    }
                  } else if ((item.width < lineMaxWidth) && (item.height > lineMaxWidth)) {
                    setGridItemsTo(group, 'cols', [item.x]);
                    setGridItemsTo(group, 'rows', [item.y, item.y + item.height]);
                    if (isVisible) {
                      setGridItemsTo(group, 'edgesCols', [item.x]);
                      setGridItemsTo(group, 'edgesRows', [item.y, item.y + item.height]);
                    }
                  }
                  break;
                }
                case 'rectangles': {
                  setGridItemsTo(group, 'rows', [item.y, item.y + item.height]);
                  setGridItemsTo(group, 'cols', [item.x, item.x + item.width]);
                  if (isVisible) {
                    setGridItemsTo(group, 'rectanglesRows', [item.y, item.y + item.height]);
                    setGridItemsTo(group, 'rectanglesCols', [item.x, item.x + item.width]);
                  }
                  break;
                }
                case 'coordinates': {
                  if (downcheck ? !(group['edgesCols'].length >= 2) : true) {
                    setGridItemsTo(group, 'rows', [item.y, item.y + item.height]);
                    setGridItemsTo(group, 'cols', [item.x, item.x + item.width]);
                  }
                  break;
                }
                default: {
                  break;
                }
              }
            }

            //Check if the current element overlaps with existing groups
            groups.forEach(group => {
              let inRange = checkRectangleRanges(
                axis.reduce((prev, axisItem) => {
                  prev[axisItem] = [group[axisItem][0], group[axisItem][1]];
                  return prev;
                }, {}),
                axis.reduce((prev, axisItem) => {
                  let property = getProperty(axisItem);
                  prev[axisItem] = [item[axisItem], item[axisItem] + item[property]];
                  return prev;
                }, {}),
                { axis: axis, strict: true, strictIntersecting: true, tolerance: tolerance }
              ) as Array<any>;

              if (inRange.every(item => item.isIntersecting)) {
                isIntersecting = true;
                //if (inRange.every(item => item.isContained)) {
                axis.forEach(axisItem => {
                  let property = getProperty(axisItem);
                  group[axisItem] = [
                    Math.min(group[axisItem][0], item[axisItem]),
                    Math.max(group[axisItem][1], item[axisItem] + item[property])
                  ];
                });
                //}
                addGridItems(group, item, type);
                group[type] = addToBlockList(group[type], item, axis);//old:getUnique([...(group[type] || []), item], axis);
              }
            });

            //If the item does not overlap with existing tables, create a new table
            if (!isIntersecting) {
              let newGroup = axis.reduce((prev, axisItem) => {
                let property = getProperty(axisItem);
                prev[axisItem] = [item[axisItem], item[axisItem] + item[property]];
                return prev;
              }, {});
              addGridItems(newGroup, item, type);
              newGroup[type] = [item];
              groups.push(newGroup);
            }

            //Merge intersecting tables
            let newGroups = [];
            let addedIds = new Set();

            for (let i = 0; i < groups.length; i++) {
              if (addedIds.has(i)) continue;

              let mergedGroup = { ...groups[i] };
              let merged = false;

              for (let j = i + 1; j < groups.length; j++) {
                if (addedIds.has(j)) continue;

                let inRange = checkRectangleRanges(
                  axis.reduce((prev, axisItem) => {
                    prev[axisItem] = [groups[i][axisItem][0], groups[i][axisItem][1]];
                    return prev;
                  }, {}),
                  axis.reduce((prev, axisItem) => {
                    prev[axisItem] = [groups[j][axisItem][0], groups[j][axisItem][1]];
                    return prev;
                  }, {}),
                  { axis: axis, strict: true, strictIntersecting: true, tolerance: tolerance }
                ) as Array<any>;

                if (inRange.every(item => item.isIntersecting)) {
                  merged = true;
                  axis.forEach(axisItem => {
                    mergedGroup[axisItem] = [
                      Math.min(groups[i][axisItem][0], groups[j][axisItem][0]),
                      Math.max(groups[i][axisItem][1], groups[j][axisItem][1])
                    ];
                  });

                  let types = ['edges', 'rectangles', 'coordinates', 'rectanglesEdges'];

                  types.forEach(type => {
                    let data = addToBlockList(mergedGroup[type], groups[j][type], axis);//old:getUnique([...(mergedGroup[type] || []), ...(groups[j][type] || [])], axis);
                    if (data.length) {
                      mergedGroup[type] = data;
                    }
                  });

                  ['rows', 'cols', 'edgesRows', 'edgesCols', 'rectanglesRows', 'rectanglesCols'].forEach(sectionName => {
                    setGridItemsTo(mergedGroup, sectionName, groups[j][sectionName]);
                    let data = addToGridList(mergedGroup[type], groups[j][type]);//old:[...new Set([...(mergedGroup[type] || []), ...(groups[j][type] || [])])];
                    if (data.length) {
                      mergedGroup[type] = data;
                    }
                  });

                  addedIds.add(j);
                }
              }

              newGroups.push(mergedGroup);
              if (!merged) addedIds.add(i);
            }

            groups = newGroups;
            return groups;
          }

          // Function for defining cell boundaries
          function getGroups() {
            let tolerance = calculateToleranceValue(coordinates);
            const gapBands = getGapBandsBetweenRuledTables(edges);

            let pageGroups = createGroup({ edges, rectangles, coordinates, tolerance: Infinity });
            let tableGroups = createGroup({ edges, rectangles, coordinates, tolerance });
            tableGroups = splitGroups({ groups: tableGroups, globalGroup: pageGroups[0], downcheck: true });
            tableGroups = absorbEnclosedBlocks(tableGroups, pageGroups[0]);
            // Reconstruct missing row boundaries
            tableGroups = tableGroups.map(group => {
              const currentRows = [...(group.rows || [])]
                .sort((a, b) => b - a);

              const edgeRows = [
                ...new Set([
                  ...(group.edgesRows || []),
                  ...(group.rectanglesRows || [])
                ])
              ].sort((a, b) => b - a);

              const restoredRows = new Set(currentRows);

              for (let rowIndex = 0; rowIndex < currentRows.length - 1; rowIndex++) {
                const topRow = currentRows[rowIndex];
                const bottomRow = currentRows[rowIndex + 1];

                const internalEdges = edgeRows.filter(edge =>
                  edge < topRow - 0.25 &&
                  edge > bottomRow + 0.25
                );

                for (const edge of internalEdges) {
                  const hasTextAbove = (group.coordinates || []).some(coordinate =>
                    coordinate.y < topRow - 0.25 &&
                    coordinate.y > edge + 0.25
                  );

                  const hasTextBelow = (group.coordinates || []).some(coordinate =>
                    coordinate.y < edge - 0.25 &&
                    coordinate.y > bottomRow + 0.25
                  );

                  if (hasTextAbove && hasTextBelow) {
                    restoredRows.add(edge);
                  }
                }
              }

              group.rows = [...restoredRows].sort((a, b) => a - b);

              return group;
            });

            // Deleting completely identical groups
            tableGroups = tableGroups.filter((group, index, groups) => {
              const getSignature = (item) => JSON.stringify({
                rows: [...(item.rows || [])].sort((a, b) => a - b),
                cols: [...(item.cols || [])].sort((a, b) => a - b),
                x: item.x || [],
                y: item.y || []
              });

              const signature = getSignature(group);

              return groups.findIndex(item =>
                getSignature(item) === signature
              ) === index;
            });

            tableGroups = tableGroups.map(group => constrainGroupToRuledFrame(group));
            tableGroups = tableGroups.map(group => extendGroupTopBorder(group, pageGroups[0], lineMaxWidth));
            tableGroups = tableGroups.map(group => extendGroupBottomRow(group, pageGroups[0], lineMaxWidth));
            tableGroups = tableGroups.map(group => trimUnsupportedTrailingRows(group, lineMaxWidth));//!BUG fpdf_example-1.pdf (the last row of the table is missing)
            tableGroups = tableGroups.map(group => trimFullWidthTitleRow(group, lineMaxWidth));
            tableGroups = tableGroups.map(group => removeFillSeamRows(group, lineMaxWidth));
            tableGroups = tableGroups.map(group => removeFillPadColumns(group, lineMaxWidth));
            tableGroups = tableGroups.map(group => absorbThinEmptyBands(group, lineMaxWidth));
            tableGroups = tableGroups.map(group => refineTextOnlyTopRows(group, lineMaxWidth));
            tableGroups = tableGroups.map(group => rebuildUnseparatedRows(group, lineMaxWidth));
            tableGroups = tableGroups.map(group => applyLeaderRowBoundaries(group));

            // The order of the tables in the result should correspond to the reading order (from top to bottom on the page), not the order in which they were randomly arranged by clustering.
            tableGroups = [...tableGroups].sort((a, b) => {
              let aTop = a.rows?.length ? Math.max(...a.rows) : (a.y ? a.y[1] : 0);
              let bTop = b.rows?.length ? Math.max(...b.rows) : (b.y ? b.y[1] : 0);
              return bTop - aTop;
            });

            tableGroups = tableGroups.filter(group => {
              const keep = isTableGroup(group, lineMaxWidth);
              return keep;
            });

            tableGroups.forEach(group => {
              group.assuredCols = group.cols;
              group.assuredRows = group.rows;
            });

            function splitGroups(options) {
              let { groups, globalGroup, downcheck } = options;
              const hasTextContent = (coordinate: any) =>
                typeof coordinate?.str === 'string' &&
                coordinate.str.trim().length > 0;
              return groups.reduce((prev, group, index, arr) => {
                const prevGroupsLength = prev.length;

                const sourceGroup = {
                  ...group,
                  rows: [...(group.rows || [])],
                  cols: [...(group.cols || [])],
                  x: group.x ? [...group.x] : group.x,
                  y: group.y ? [...group.y] : group.y,
                };

                let headerRanges = [];
                const forcedRowSplits = new Set();
                //Split the group again if it contains two headers
                Object.keys(group.headerRows).sort((a: any, b: any) => b - a).forEach((rangeStr, rangeIndex, rangeArr) => {
                  let range = rangeStr.split('-').map(item => +item);
                  let targetRange = headerRanges.find(item => item.range.some(r => range.includes(r)));

                  if (!targetRange) {
                    headerRanges.push({
                      range: range
                    })
                  } else {
                    targetRange['range'] = [...new Set([...targetRange.range, ...range])].sort((a, b) => b - a);
                  }
                });

                //downward intersection check for additional verification/clarification of group size
                if (downcheck) {
                  //if (downcheck ? !(group['edgesCols'].length >= 2) : true) {
                  headerRanges.forEach(headerRange => {
                    let yRange = [headerRange.range[headerRange.range.length - 2], headerRange.range[headerRange.range.length - 1]]
                    let yRangeStr = yRange.join('-');
                    let textBlocks = group.headerRows[yRangeStr];

                    let edgeTolerance;
                    const visibleVerticalEdges = [
                      ...(globalGroup.edges || []),
                      ...(globalGroup.rectanglesEdges || [])
                    ].filter(edge =>
                      isVisibleVector(edge) &&
                      edge.width < lineMaxWidth &&
                      edge.height > lineMaxWidth
                    );

                    function getSideEdges(element: any) {
                      if (!element) {
                        return [];
                      }

                      const edges = visibleVerticalEdges.filter(edge => {
                        const tolerance = -Math.min(edge.width, edge.height);
                        edgeTolerance = (tolerance < edgeTolerance) || !edgeTolerance ? tolerance : edgeTolerance;
                        const result = checkRectangleRanges(
                          edge,
                          element,
                          {
                            strict: false,
                            strictIntersecting: false,
                            axis: ['x', 'y'],
                            tolerance,
                          }
                        ) as Array<any>;

                        return result.some(item => item.inRange);
                      });

                      if (!edges.length) {
                        return [];
                      }

                      const uniqueEdges = uniqueArr(
                        edges,
                        ['x', 'y', 'width', 'height']
                      );

                      if (uniqueEdges.length === 1) {
                        return uniqueEdges;
                      }

                      return [
                        uniqueEdges.reduce(
                          (prev, cur) => cur.x < prev.x ? cur : prev,
                          uniqueEdges[0]
                        ),
                        uniqueEdges.reduce(
                          (prev, cur) => cur.x > prev.x ? cur : prev,
                          uniqueEdges[0]
                        ),
                      ];
                    }

                    textBlocks?.forEach(textBlock => {
                      let colIndex = group.cols.findIndex((col, index) => {
                        let res: any = checkRectangleRanges({ x: [textBlock.x, textBlock.x + textBlock.width] }, { x: [group.cols[index], group.cols[index + 1]] }, { axis: 'x', strict: true, strictIntersecting: true });
                        return group.cols[index + 1] && (res.isContained || !res.biggestArgument && res.isIntersecting);
                      });

                      if (colIndex < 0) {
                        return;
                      }

                      let xRange = [group.cols[colIndex], group.cols[colIndex + 1]];
                      let mergedRows = getMergedArray(globalGroup.rows, group.rows).sort((a, b) => b - a);
                      let startIndex = mergedRows.indexOf(yRange[1]);
                      for (let index = startIndex; index < mergedRows.length; index++) {
                        let row = mergedRows[index];
                        let nextRow = mergedRows[index + 1];

                        let bottomElements = filterBlocks(
                          globalGroup.coordinates,
                          {
                            x: xRange,
                            y: [row, nextRow],
                            strict: true,
                            withoutOverlap: true,
                            strictIntersecting: true
                          }
                        );

                        // if (!bottomElements.length) {//!BUG no last table in three_tables_2.pdf
                        //   continue;
                        // }

                        const textBlockSideEdges = getSideEdges(textBlock);
                        const bottomTextBlockSideEdges = getSideEdges(bottomElements[0]);

                        const isSameSideEdges = (() => {
                          /*
                           * If we cannot determine both boundaries,
                           * we draw no conclusions.
                           *
                           * This is important: the absence of an edge != proof
                           * that the table is over.
                           */
                          if (
                            textBlockSideEdges.length < 2 ||
                            bottomTextBlockSideEdges.length < 2
                          ) {
                            return null;
                          }

                          if (textBlockSideEdges?.length && bottomTextBlockSideEdges?.length) {
                            let firstDiff = Math.abs(textBlockSideEdges[0].x - bottomTextBlockSideEdges[0].x);
                            let lastDiff = Math.abs(textBlockSideEdges[textBlockSideEdges.length - 1].x - bottomTextBlockSideEdges[bottomTextBlockSideEdges.length - 1].x);
                            let tolerance = Math.max(lineMaxWidth, 1);//edgeTolerance ? Math.abs(edgeTolerance) : Math.max(lineMaxWidth, 1);
                            return (firstDiff <= tolerance) && (lastDiff <= tolerance);
                          } else {
                            return true;
                          }
                        })();

                        if (isSameSideEdges === false) {
                          forcedRowSplits.add(row);
                          break;
                        }

                        if (
                          (bottomElements?.length && !bottomElements?.intersectsNextGridItem) && //has elements at the bottom
                          bottomElements.every(item => item.contained) && //are fully included in the header column
                          !groups.some(g => {//does not overlap the headings of other tables
                            return Object.keys(g.headerRows).some(r => {
                              let blocks = filterBlocks(g.headerRows[r], { 'x': xRange, 'y': [row, nextRow], strict: true, withoutOverlap: true, strictIntersecting: true });
                              return !!(blocks.length && !bottomElements?.intersectsNextGridItem);
                            })
                          })
                          //&& isSameSideEdges //share common visual boundaries
                        ) {
                          if (!group.rows.includes(nextRow)) {
                            //group.rows = [...new Set([...group.rows.slice(0, group.rows.indexOf(row) + 1), nextRow])].sort((a, b) => a - b) || [];
                            group.rows = addToGridList(group.rows, nextRow);//old:[...new Set([...group.rows, nextRow])].sort((a, b) => a - b);
                          }
                        } else {
                          if (index != startIndex) {//exclusion for the first row after headings
                            break;
                          }
                        }
                      }
                    });
                  });
                  //}
                }

                let rowsRanges = [];

                let addToRowsRange = (...args) => {
                  let lastRange =
                    rowsRanges[rowsRanges.length - 1];

                  if (!lastRange) {
                    lastRange = [];
                    rowsRanges.push(lastRange);
                  }

                  [...args].forEach(row => {
                    if (!lastRange.includes(row)) {
                      lastRange.push(row);
                    }
                  });
                };
                let groupRows = group.rows.sort((a, b) => b - a);
                // The first row below the upper table and the first row of the lower table start new ranges.
                const gapRowTolerance = 1.5;
                gapBands.forEach(band => {
                  const upperRow = groupRows.find(row => Math.abs(row - band.top) <= gapRowTolerance);
                  const lowerRow = groupRows.find(row => Math.abs(row - band.bottom) <= gapRowTolerance);
                  if (upperRow !== undefined) forcedRowSplits.add(upperRow);
                  if (lowerRow !== undefined) forcedRowSplits.add(lowerRow);
                });
                const rowTopologyTolerance = Math.max(
                  lineMaxWidth,
                  group.borderSize || 0,
                  1
                );

                const rowCols = [...group.cols].sort((a, b) => a - b);

                const visibleGroupEdges = [
                  ...(globalGroup.edges || []),
                  ...(globalGroup.rectanglesEdges || [])
                ].filter(item => isVisibleVector(item));

                const hasVerticalEdge = (
                  x,
                  top,
                  bottom
                ) => {
                  return visibleGroupEdges.some(edge => {
                    const edgeWidth = Math.abs(edge.width || 0);
                    const edgeHeight = Math.abs(edge.height || 0);

                    if (
                      edgeWidth > lineMaxWidth ||
                      edgeHeight <= lineMaxWidth
                    ) {
                      return false;
                    }

                    const edgeX = edge.x;
                    const edgeTop = Math.min(
                      edge.y,
                      edge.y + edge.height
                    );
                    const edgeBottom = Math.max(
                      edge.y,
                      edge.y + edge.height
                    );

                    return (
                      Math.abs(edgeX - x) <= rowTopologyTolerance &&
                      edgeTop <= top + rowTopologyTolerance &&
                      edgeBottom >= bottom - rowTopologyTolerance
                    );
                  });
                };

                const hasHorizontalCoverage = (
                  y,
                  left,
                  right
                ) => {
                  const intervals = visibleGroupEdges
                    .filter(edge => {
                      const edgeWidth = Math.abs(edge.width || 0);
                      const edgeHeight = Math.abs(edge.height || 0);

                      if (
                        edgeHeight > lineMaxWidth ||
                        edgeWidth <= lineMaxWidth
                      ) {
                        return false;
                      }

                      const edgeLeft = Math.min(
                        edge.x,
                        edge.x + edge.width
                      );
                      const edgeRight = Math.max(
                        edge.x,
                        edge.x + edge.width
                      );

                      return (
                        Math.abs(edge.y - y) <= rowTopologyTolerance &&
                        edgeRight > left - rowTopologyTolerance &&
                        edgeLeft < right + rowTopologyTolerance
                      );
                    })
                    .map(edge => [
                      Math.max(
                        left,
                        Math.min(edge.x, edge.x + edge.width)
                      ),
                      Math.min(
                        right,
                        Math.max(edge.x, edge.x + edge.width)
                      )
                    ])
                    .filter(([start, end]) => end > start)
                    .sort((a, b) => a[0] - b[0]);

                  if (!intervals.length) {
                    return false;
                  }

                  let coveredUntil = left;

                  for (const [start, end] of intervals) {
                    if (start > coveredUntil + rowTopologyTolerance) {
                      return false;
                    }

                    coveredUntil = Math.max(coveredUntil, end);

                    if (coveredUntil >= right - rowTopologyTolerance) {
                      return true;
                    }
                  }

                  return coveredUntil >= right - rowTopologyTolerance;
                };

                const hasContentInRowPart = (
                  top,
                  bottom,
                  left,
                  right
                ) => {
                  return filterBlocks(
                    group.coordinates || [],
                    {
                      x: [left, right],
                      y: [top, bottom],
                      strict: true,
                      withoutOverlap: true,
                      strictIntersecting: true
                    }
                  ).some(hasTextContent);
                };

                const hasClosedGridBlock = (
                  top,
                  bottom,
                  left,
                  right
                ) => {
                  if (
                    !hasHorizontalCoverage(top, left, right) ||
                    !hasHorizontalCoverage(bottom, left, right) ||
                    !hasVerticalEdge(left, top, bottom) ||
                    !hasVerticalEdge(right, top, bottom)
                  ) {
                    return false;
                  }

                  const internalCols = rowCols.filter(
                    col =>
                      col > left + rowTopologyTolerance &&
                      col < right - rowTopologyTolerance
                  );

                  // A real multi-column subtable must have its internal
                  // column boundaries drawn in this row.
                  return internalCols.length > 0 &&
                    internalCols.every(col =>
                      hasVerticalEdge(col, top, bottom)
                    );
                };

                const hasDetachedSideTableRow = (
                  firstRow,
                  secondRow,
                  rowIndex
                ) => {
                  // There must be an already established full-width table row above it.
                  if (rowIndex <= 0 || secondRow == null) {
                    return false;
                  }

                  const previousTop = groupRows[rowIndex - 1];
                  const previousBottom = firstRow;

                  const groupLeft = rowCols[0];
                  const groupRight = rowCols[rowCols.length - 1];

                  if (
                    !hasVerticalEdge(
                      groupLeft,
                      previousTop,
                      previousBottom
                    ) ||
                    !hasVerticalEdge(
                      groupRight,
                      previousTop,
                      previousBottom
                    )
                  ) {
                    return false;
                  }

                  // The split itself must be a real horizontal boundary
                  // spanning the complete previous table.
                  if (
                    !hasHorizontalCoverage(
                      firstRow,
                      groupLeft,
                      groupRight
                    )
                  ) {
                    return false;
                  }

                  const candidateRowTop = firstRow;
                  const candidateRowBottom = secondRow;

                  // Try a right-attached block and a left-attached block.
                  const candidates = [];

                  for (let index = 1; index < rowCols.length - 1; index++) {
                    // right side: [rowCols[index], groupRight]
                    if (rowCols.length - index >= 3) {
                      candidates.push([
                        rowCols[index],
                        groupRight,
                        groupLeft,
                        rowCols[index]
                      ]);
                    }

                    // left side: [groupLeft, rowCols[index]]
                    if (index >= 2) {
                      candidates.push([
                        groupLeft,
                        rowCols[index],
                        rowCols[index],
                        groupRight
                      ]);
                    }
                  }

                  return candidates.some(
                    ([candidateLeft, candidateRight, emptyLeft, emptyRight]) => {
                      const candidateWidth =
                        candidateRight - candidateLeft;

                      if (candidateWidth <= 0) {
                        return false;
                      }

                      // The candidate itself must be a closed multi-column block.
                      if (
                        !hasClosedGridBlock(
                          candidateRowTop,
                          candidateRowBottom,
                          candidateLeft,
                          candidateRight
                        )
                      ) {
                        return false;
                      }

                      // It must actually contain text.
                      if (
                        !hasContentInRowPart(
                          candidateRowTop,
                          candidateRowBottom,
                          candidateLeft,
                          candidateRight
                        )
                      ) {
                        return false;
                      }

                      // The part outside the candidate must be empty.
                      if (
                        hasContentInRowPart(
                          candidateRowTop,
                          candidateRowBottom,
                          emptyLeft,
                          emptyRight
                        )
                      ) {
                        return false;
                      }

                      // The opposite outer boundary of the original table
                      // must terminate at the split. This prevents merged
                      // cells / sparse final rows from being treated as a new table.
                      const oppositeOuterX =
                        candidateLeft === groupLeft
                          ? groupRight
                          : groupLeft;

                      if (
                        hasVerticalEdge(
                          oppositeOuterX,
                          candidateRowTop,
                          candidateRowBottom
                        )
                      ) {
                        return false;
                      }

                      return true;
                    }
                  );
                };
                groupRows.slice(0, -1).forEach((firstRow, rowIndex) => {
                  let secondRow = groupRows[rowIndex + 1];
                  let targetRange = headerRanges.find(item => {
                    let res = item.range[0] == firstRow;//checkRectangleRanges({y: +firstRow}, { y: [item.range[0], item.range[item.range.length - 1]]}, { axis: 'y', strict:true, strictIntersecting:true }).isContained
                    return res;
                  });

                  let textBlocks = secondRow ? filterBlocks(group.coordinates || [], {
                    ['y']: [firstRow, secondRow],
                    strictIntersecting: true
                  }) : [];

                  let visibleEdges = (group.edges || []).filter(item => isVisibleVector(item));
                  let edges = secondRow ? filterBlocks(visibleEdges, {
                    ['y']: [firstRow, secondRow],
                    strictIntersecting: true,
                    tolerance: -(group.borderSize * 2)
                  }) : [];

                  const detachedSideTableRow =
                    hasDetachedSideTableRow(
                      firstRow,
                      secondRow,
                      rowIndex
                    );

                  if (detachedSideTableRow) {
                    forcedRowSplits.add(firstRow);
                  }


                  let textBlocksLength = textBlocks.length;
                  let edgesLength = edges.length;

                  let splitRowsCondition = (() => {
                    let minRowsLength = 3;
                    return (groupRows.length - 1 > minRowsLength) ? (textBlocksLength <= 1) : !textBlocksLength;
                  })();

                  /*
                   * ---------------------------------------------------------
                   * Forced split to change external vertical boundaries..
                   *
                   * IMPORTANT:
                   * firstRow cannot be discarded from the previous range..
                   *
                   * Therefore, if firstRow is a split-point,
                   * a new range starts with this row first..
                   *
                   * Thanks to this, the boundary row is present.
                   * and as the lower boundary of the previous table,
                   * and as the upper boundary of the next one.
                   * ---------------------------------------------------------
                   */
                  const forcedSplit =
                    forcedRowSplits.has(firstRow);

                  if (
                    rowsRanges.length ? (
                      forcedSplit ||
                      (
                        (
                          targetRange ||
                          (splitRowsCondition && !edgesLength)
                        ) &&
                        (rowsRanges[rowsRanges.length - 1] ? rowsRanges[rowsRanges.length - 1]?.length : true) //no need to add a new array if the previous one is empty
                      )
                    ) : true //rowIndex === 0
                    //!(textBlocks.length == 1 && ((rowIndex + 1) == groupRows.length)) //row is not included in the table
                  ) {
                    rowsRanges.push([]);
                  }

                  addToRowsRange(firstRow, secondRow);

                  if (
                    splitRowsCondition &&
                    (rowIndex !== groupRows.length - 2)
                  ) {
                    rowsRanges.push([]);
                  }

                });

                // The range that lies entirely inside a gap band (titles, footnotes) is not a table.
                rowsRanges = rowsRanges.filter(
                  range =>
                    !gapBands.some(
                      band =>
                        Math.abs(range[0] - band.top) <= gapRowTolerance &&
                        Math.abs(range[range.length - 1] - band.bottom) <= gapRowTolerance
                    )
                );

                rowsRanges = rescueContinuationRanges({ rowsRanges, group, globalGroup });

                rowsRanges = rowsRanges.reduce((prev, range) => {
                  if (range.length > 2) {
                    prev.push(range);
                  } else {
                    //prev.push(null);
                  }
                  return prev;
                }, []);



                // A row containing a single block of text is considered a table separator. But
                // in background_lines_2.pdf, the subheading lines (colspan,
                // yellow fill “MARGINAL (BELOW 1.0)”, etc.) appear inside
                // the grid, and the table was split into pieces along each of them.
                // If a vertical border (drawn with separate, adjoining
                // segments) extends nearly the entire height of the group’s edges, this is a single
                // continuous grid. In that case, we retain a single range of rows within this
                // line. At the same time, text lines above and below the grid are trimmed off.
                if (rowsRanges.length > 1) {
                  const gridTolerance = 1.5;

                  const verticalSegments = (group.edges || [])
                    .filter(edge =>
                      isVisibleVector(edge) &&
                      !edge['_isFakeLine'] &&
                      edge.width < lineMaxWidth &&
                      edge.height > lineMaxWidth
                    )
                    .map(edge => ({
                      x: edge.x + edge.width / 2,
                      from: edge.y,
                      to: edge.y + edge.height
                    }))
                    .sort((a, b) => a.x - b.x);

                  // The lines of a single border may differ by fractions of a point along the X-axis
                  // (47.25 in the header and 46.5 in the blocks).
                  const xClusters: Array<{ x: number; segments: any[] }> = [];
                  verticalSegments.forEach(segment => {
                    const lastCluster = xClusters[xClusters.length - 1];
                    if (lastCluster && Math.abs(segment.x - lastCluster.x) <= gridTolerance) {
                      lastCluster.segments.push(segment);
                    } else {
                      xClusters.push({ x: segment.x, segments: [segment] });
                    }
                  });

                  // Within the cluster, we join adjacent segments into continuous chains.
                  let longestChain: any = null;
                  xClusters.forEach(cluster => {
                    const sortedSegments = [...cluster.segments].sort((a, b) => a.from - b.from);
                    let currentChain: any = null;

                    sortedSegments.forEach(segment => {
                      if (currentChain && segment.from <= currentChain.to + gridTolerance) {
                        currentChain.to = Math.max(currentChain.to, segment.to);
                      } else {
                        currentChain = { from: segment.from, to: segment.to };
                      }

                      if (
                        !longestChain ||
                        currentChain.to - currentChain.from > longestChain.to - longestChain.from
                      ) {
                        longestChain = { ...currentChain };
                      }
                    });
                  });

                  const gridEdgeRows = group.edgesRows || [];

                  if (longestChain && gridEdgeRows.length >= 3) {
                    const gridExtent = Math.max(...gridEdgeRows) - Math.min(...gridEdgeRows);
                    const chainLength = longestChain.to - longestChain.from;

                    if (gridExtent > 0 && chainLength >= gridExtent * 0.95) {
                      const wholeGridRows = groupRows.filter(row =>
                        row >= longestChain.from - gridTolerance &&
                        row <= longestChain.to + gridTolerance
                      );

                      if (wholeGridRows.length > 2) {
                        rowsRanges = [wholeGridRows];
                      }
                    }
                  }
                }

                let colsRangesGroups = [...Array(rowsRanges.length)].map(() => []);
                let groupCols = group.cols.sort((a, b) => b - a);
                for (let rowRangeIndex = 0; rowRangeIndex < rowsRanges.length; rowRangeIndex++) {
                  const rowRange = rowsRanges[rowRangeIndex];
                  let colsRanges = colsRangesGroups[rowRangeIndex];

                  if (rowRange == null) {
                    colsRangesGroups[rowRangeIndex] = null;
                    continue;
                  }

                  let addToColsRange = (...args) => {
                    let lastRange = colsRanges[colsRanges.length - 1];
                    [...args].forEach(col => {
                      if (!lastRange.includes(col)) {
                        lastRange.push(col);
                      }
                    });
                  };

                  groupCols.slice(0, -1).forEach((firstCol, colIndex) => {
                    let secondCol = groupCols[colIndex + 1];
                    let textBlocksOnRows = [];
                    let edgesOnRows = [];
                    rowRange.slice(0, -1).forEach((item, rowIndex) => {
                      let firstRow = rowRange[rowIndex];
                      let secondRow = rowRange[rowIndex + 1];

                      let textBlocks = secondCol ? filterBlocks(group.coordinates || [], {
                        ['x']: [firstCol, secondCol],
                        ['y']: [firstRow, secondRow],
                        strictIntersecting: true
                      }) : [];

                      let visibleEdges = (group.edges || []).filter(item => isVisibleVector(item));
                      let edges = secondCol ? filterBlocks(visibleEdges, {
                        ['x']: [firstCol, secondCol],
                        ['y']: [firstRow, secondRow],
                        strictIntersecting: true,
                        tolerance: -(group.borderSize * 2)
                      }) : [];

                      textBlocksOnRows.push(textBlocks);
                      edgesOnRows.push(edges);
                    });

                    let textBlocksLength = textBlocksOnRows.filter(item => item.length).length;
                    let edgesLength = edgesOnRows.filter(item => item.length).length;

                    let splitColsCondition = (() => {
                      let minColsLength = 3;
                      return (groupCols.length - 1 > minColsLength) ? (textBlocksLength <= 1) : !textBlocksLength;
                    })();

                    if (
                      colsRanges.length ? (
                        (
                          splitColsCondition && !edgesLength
                        ) &&
                        (colsRanges[colsRanges.length - 1] ? colsRanges[colsRanges.length - 1]?.length : true)
                      ) : true
                      //!(textBlocks.length == 1 && ((colIndex + 1) == groupCols.length)) //col is not included in the table
                    ) {
                      colsRanges.push([]);
                    }

                    addToColsRange(firstCol, secondCol);

                    if (
                      splitColsCondition &&
                      (colIndex !== groupCols.length - 2)
                    ) {
                      colsRanges.push([]);
                    }
                  });
                }
                colsRangesGroups = colsRangesGroups.reduce((prev, rangesGroup) => {
                  if (rangesGroup == null) {
                    //prev.push(null);
                    return prev;
                  }

                  rangesGroup = rangesGroup.reduce((prev, range) => {
                    if (range.length > 2) {
                      prev.push(range);
                    } else {
                      //prev.push(null);
                    }
                    return prev;
                  }, []);

                  if (rangesGroup.some(item => item != null)) {
                    prev.push(rangesGroup);
                  } else {
                    //prev.push(null);
                  }
                  return prev;
                }, []);

                for (let rowsRangeIndex = 0; rowsRangeIndex < rowsRanges.length; rowsRangeIndex++) {// needs improvement?
                  const rowsRange = rowsRanges[rowsRangeIndex];
                  for (let colsRangeIndex = 0; colsRangeIndex < colsRangesGroups[rowsRangeIndex]?.length || 0; colsRangeIndex++) {
                    const colsRange = colsRangesGroups[rowsRangeIndex][colsRangeIndex];

                    let tolerance = calculateToleranceValue(group.coordinates);//old: * 2;
                    let edges = globalGroup.edges?.filter(block => {
                      let res: any = checkRectangleRanges(
                        block,
                        { y: [rowsRange[0], rowsRange[rowsRange.length - 1]], x: [colsRange[0], colsRange[colsRange.length - 1]] },
                        { axis: 'y', strict: true, strictIntersecting: true, strictContained: true, tolerance }
                      );
                      return res.isContained && (res.biggestArgument == 1 || res.biggestArgument == null)
                      //&& (block.y + block.height <= rowsRange[0] && block.y >= rowsRange[rowsRange.length - 1]); //BUGFIX for 06-sales-order
                    }) || [];
                    let rectangles = globalGroup.rectangles?.filter(block => {
                      let res: any = checkRectangleRanges(
                        block,
                        { y: [rowsRange[0], rowsRange[rowsRange.length - 1]], x: [colsRange[0], colsRange[colsRange.length - 1]] },
                        { axis: 'y', strict: true, strictIntersecting: true, strictContained: true, tolerance }
                      );
                      return res.isContained && (res.biggestArgument == 1 || res.biggestArgument == null)
                      //&& (block.y + block.height <= rowsRange[0] && block.y >= rowsRange[rowsRange.length - 1]);//BUGFIX for 06-sales-order
                    }) || [];
                    let coordinates = globalGroup.coordinates?.filter(block => {
                      let res: any = checkRectangleRanges(
                        block,
                        { y: [rowsRange[0], rowsRange[rowsRange.length - 1]], x: [colsRange[0], colsRange[colsRange.length - 1]] },
                        { axis: 'y', strict: true, strictIntersecting: true, strictContained: true, tolerance }
                      );
                      return res.isContained && (res.biggestArgument == 1 || res.biggestArgument == null)
                      //&& (block.y + block.height <= rowsRange[0] && block.y >= rowsRange[rowsRange.length - 1]);//BUGFIX for 06-sales-order
                    }) || [];

                    let newTableGroups = createGroup({
                      edges: edges, //101
                      rectangles: rectangles, //12
                      coordinates: coordinates, //36
                      tolerance,
                      assuredRows: [...rowsRange]//BUGFIX //12
                    });

                    prev = [
                      ...prev,
                      ...newTableGroups
                        .filter(item => {
                          let headerRowsKeys = Object.keys(item.headerRows || {});
                          let headerRowsCoordinates = headerRowsKeys.map(key => item.headerRows[key]).flat();
                          return headerRowsCoordinates.length && headerRowsCoordinates?.length != item?.coordinates?.length && headerRowsKeys.length;
                        })
                    ];
                  }
                }

                const generatedGroups = prev.slice(prevGroupsLength);

                const getBounds = (values: number[] | undefined) => {
                  if (!values?.length) {
                    return null;
                  }

                  return [
                    Math.min(...values),
                    Math.max(...values),
                  ] as const;
                };

                const sourceCols = [...(sourceGroup.cols || [])]
                  .sort((a, b) => a - b);

                const findColumn = (x: number) => {
                  for (let i = 0; i < sourceCols.length - 1; i++) {
                    if (x >= sourceCols[i] && x < sourceCols[i + 1]) {
                      return i;
                    }
                  }

                  return -1;
                };

                const sameSourceRowWasDuplicated = (
                  first: any,
                  second: any,
                ): boolean => {
                  const firstX = getBounds(first.x);
                  const secondX = getBounds(second.x);
                  const firstY = getBounds(first.y);
                  const secondY = getBounds(second.y);

                  if (!firstX || !secondX || !firstY || !secondY) {
                    return false;
                  }

                  const xOverlap =
                    Math.min(firstX[1], secondX[1]) -
                    Math.max(firstX[0], secondX[0]);

                  const smallerWidth = Math.min(
                    firstX[1] - firstX[0],
                    secondX[1] - secondX[0],
                  );

                  const yOverlap =
                    Math.min(firstY[1], secondY[1]) -
                    Math.max(firstY[0], secondY[0]);

                  if (
                    smallerWidth <= 0 ||
                    xOverlap < smallerWidth * 0.8 ||
                    yOverlap <= 0
                  ) {
                    return false;
                  }

                  const firstIndexes = new Set(
                    (first.coordinates || [])
                      .map((item: any) => item.index)
                      .filter((index: any) => index != null),
                  );

                  const secondIndexes = new Set(
                    (second.coordinates || [])
                      .map((item: any) => item.index)
                      .filter((index: any) => index != null),
                  );

                  const sharedCoordinates = (sourceGroup.coordinates || [])
                    .filter((item: any) =>
                      item.index != null &&
                      firstIndexes.has(item.index) &&
                      secondIndexes.has(item.index) &&
                      typeof item.str === 'string' &&
                      item.str.trim().length > 0
                    );

                  const rowTolerance = 1.5;
                  const rowClusters: Array<{
                    y: number;
                    columns: Set<number>;
                  }> = [];

                  for (const item of sharedCoordinates) {
                    const centerX = item.x + (item.width || 0) / 2;
                    const column = findColumn(centerX);

                    if (column < 0) {
                      continue;
                    }

                    let cluster = rowClusters.find(row =>
                      Math.abs(row.y - item.y) <= rowTolerance
                    );

                    if (!cluster) {
                      cluster = {
                        y: item.y,
                        columns: new Set<number>(),
                      };

                      rowClusters.push(cluster);
                    }

                    cluster.columns.add(column);
                  }

                  return rowClusters.some(row => row.columns.size >= 2);
                };

                let duplicatedBoundaryRow = false;

                for (
                  let i = 0;
                  i < generatedGroups.length && !duplicatedBoundaryRow;
                  i++
                ) {
                  for (
                    let j = i + 1;
                    j < generatedGroups.length && !duplicatedBoundaryRow;
                    j++
                  ) {
                    duplicatedBoundaryRow = sameSourceRowWasDuplicated(
                      generatedGroups[i],
                      generatedGroups[j],
                    );
                  }
                }

                if (generatedGroups.length > 1 && duplicatedBoundaryRow) {
                  prev.splice(
                    prevGroupsLength,
                    generatedGroups.length,
                    sourceGroup,
                  );
                }

                // --- Safety net for nested rectangles --------------------------------
                // After excluding nested same-fill rects from the grid, a valid table
                // may break down into “header-only” and “body-only” fragments, and all
                // of them fail the header filter above. If this group has not produced a
                // single valid sub-table, but is itself valid (has headerRows and
                // non-header content) and contains excluded nested rects—we preserve
                // the original group instead of losing the table.
                if (prev.length === prevGroupsLength) {
                  const hasExcludedNested = (group.rectangles || [])
                    .some(rect => nestedRectangles.has(rect));
                  const headerRowsKeys = Object.keys(group.headerRows || {});

                  if (hasExcludedNested && headerRowsKeys.length) {
                    const headerCoordinates = headerRowsKeys
                      .map(key => group.headerRows[key])
                      .flat();
                    const groupCoordinates = group.coordinates || [];

                    if (headerCoordinates.length && headerCoordinates.length !== groupCoordinates.length) {
                      prev.push(group);
                    }
                  }
                }

                return prev;
              }, []);
            }

            function createGroup(options) {
              let { edges, rectangles, coordinates, tolerance, assuredRows, assuredCols } = options;
              let groups = [];

              //priority 1
              edges.forEach(item => {
                groups = defineGroups({ item, type: 'edges', axis: ['y', 'x'], tolerance, groups, lineMaxWidth });
              });
              //priority 2
              rectangles.forEach(item => {
                groups = defineGroups({ item, type: 'rectangles', axis: ['y', 'x'], tolerance, groups, lineMaxWidth });
              });
              //priority 3
              coordinates.forEach(item => {
                groups = defineGroups({ item, type: 'coordinates', axis: ['y', 'x'], tolerance, groups, lineMaxWidth });
              });

              groups = groups.reduce((prev, group, groupIndex) => {
                //clarify the boundaries
                group['edgesRows'] = [...new Set(mergeCoordinates(group['edgesRows'], [], { averageMerge: true, threshold: lineMaxWidth }))];
                group['edgesCols'] = [...new Set(mergeCoordinates(group['edgesCols'], [], { averageMerge: true, threshold: lineMaxWidth }))];

                group['rectanglesRows'] = [...new Set(mergeCoordinates(group['rectanglesRows'], group['edgesRows'], { averageMerge: true, threshold: lineMaxWidth }))];
                group['rectanglesCols'] = [...new Set(mergeCoordinates(group['rectanglesCols'], group['edgesCols'], { averageMerge: true, threshold: lineMaxWidth }))];

                group['assuredRows'] = assuredRows || [...new Set(mergeCoordinates([...group['edgesRows'], ...group['rectanglesRows']].sort((a, b) => a - b), group['edgesRows'], { averageMerge: true, threshold: lineMaxWidth }))];
                group['assuredCols'] = assuredCols || [...new Set(mergeCoordinates([...group['edgesCols'], ...group['rectanglesCols']].sort((a, b) => a - b), group['edgesCols'], { averageMerge: true, threshold: lineMaxWidth }))];

                // A group without vertical lines—the columns found based on alignment act as vertical boundaries
                if (
                  !assuredCols &&
                  !(group['edgesCols'] || []).length &&
                  pageColumnBorders.length &&
                  group['x'] &&
                  group['y']
                ) {
                  const [groupX0, groupX1] = group['x'];
                  const [groupY0, groupY1] = group['y'];

                  const borders = pageColumnBorders
                    .filter((border) => {
                      const span = Math.max(border.yTo - border.yFrom, 1);
                      const overlap = Math.min(border.yTo, groupY1) - Math.max(border.yFrom, groupY0);
                      return (
                        border.x > groupX0 + lineMaxWidth &&
                        border.x < groupX1 - lineMaxWidth &&
                        overlap / span >= 0.6 // The column should mostly fall within this group
                      );
                    })
                    .map((border) => border.x);

                  if (borders.length) {
                    group['assuredCols'] = addToGridList(group['assuredCols'], borders); //old:[...new Set([...group['assuredCols'], ...borders])].sort((a: number, b: number) => a - b);
                  }
                }

                let alias = group['alias'] = {};
                group['rows'] = mergeCoordinates([...(group['rows'] || []), ...(group['assuredRows'] || [])].sort((a, b) => a - b), group['assuredRows'], { averageMerge: true, threshold: lineMaxWidth });
                let handledRows = getHandledGridItems({
                  gridItems: group['rows'] || [],
                  gridItemsType: 'rows',
                  coordinates: group['coordinates'] || [],
                  assuredGridItems: group['assuredRows'] || []
                });
                if (tolerance !== Infinity && !assuredRows) {
                  const fmt = (values: number[] = []) => values.map(v => +v.toFixed(2));
                }
                alias['rows'] = handledRows.alias;
                group['rows'] = handledRows.gridItems;
                group['paddingSize'] = handledRows.paddingSize;

                //fake edges
                let borderSize = getAverageBorderSize(group.edges || [], lineMaxWidth);
                let rectanglesEdges = uniqueArr(
                  group.rectangles
                    ?.filter(rect => !nestedRectangles.has(rect))
                    .reduce((prev, cur) => {
                      let vectors = createLinesFromRectangle(cur, borderSize);
                      prev.push(...vectors);
                      return prev;
                    }, []) || [],
                  ['x', 'y', 'width', 'height']
                );
                group.rectanglesEdges = rectanglesEdges;

                let increasedCoordinates = JSON.parse(JSON.stringify(coordinates));
                let increasedCoordinatesIndexes = [];

                // Text that lies completely outside a closed rule box is not part of the table.
                // Left in, it creates an extra column (a stray "." right of the right border).
                // increasedCoordinates is built from ALL coordinates passed to createGroup, so it
                // has to be filtered as well, not only group['coordinates'].
                const ruledBox = getRuledBoxExtent(group, lineMaxWidth);

                if (ruledBox) {
                  const isOutsideBox = (block: any) =>
                    block.x >= ruledBox.right || block.x + block.width <= ruledBox.left;

                  const outsideBlocks = (group['coordinates'] || []).filter(isOutsideBox);

                  group['coordinates'] = (group['coordinates'] || []).filter(block => !isOutsideBox(block));
                  increasedCoordinates = increasedCoordinates.filter(block => !isOutsideBox(block));
                }

                // --- REMOVING CAPTION FROM COORDINATES ---
                if (group['coordinates']?.length && group['edges']?.length) {
                  let tableYMin = Math.min(...group['coordinates'].map(c => c.y));
                  let tableYMax = Math.max(...group['coordinates'].map(c => c.y + c.height));

                  group['coordinates'] = group['coordinates'].filter(c => {
                    let isTopEdge = Math.abs(c.y - tableYMin) < 1;
                    let isBottomEdge = Math.abs(c.y + c.height - tableYMax) < 1;

                    // We check the caption logic only at the edges of the table.
                    if (!isTopEdge && !isBottomEdge) return true;

                    // A single block on its own line?
                    let sameRow = group['coordinates'].filter(other =>
                      Math.abs(other.y - c.y) < 0.5 || Math.abs(other.y + other.height - c.y - c.height) < 0.5
                    );
                    if (sameRow.length !== 1) return true;

                    return !isCaptionBlock({
                      block: c,
                      edges: group['edges'],
                      coordinates: group['coordinates'],
                      lineMaxWidth
                    });
                  });
                }
                // --- END ---

                let headerRows = group['headerRows'] = determineHeaderRows({
                  coordinates: group['coordinates'] || [],
                  edges: group['edges'] || [],
                  rectangles: group['rectangles'] || [],
                  rows: group['rows'] || [],
                  cols: group['assuredCols'] || [],
                  lineMaxWidth: lineMaxWidth,
                  customConditionFn: ({
                    textBlock, item, nextItem
                  }) => {
                    //enlarge text blocks to the entire cell
                    if (textBlock.contained && !increasedCoordinatesIndexes.includes(textBlock.index)) {

                      let newTextBlock = increasedCoordinates.find(i => i.index == textBlock.index);
                      Object.assign(newTextBlock, {
                        y: item != newTextBlock.y ? Math.min(newTextBlock.y, item) : newTextBlock.y,
                        height: nextItem - item != newTextBlock.height ? Math.max(newTextBlock.height, nextItem - item) - 1 : newTextBlock.height,
                      });
                      increasedCoordinatesIndexes.push(textBlock.index);
                    }

                    return true;
                  }
                });

                let headerRanges = Object.keys(headerRows);
                let filterFn = (item, index, arr) => {
                  let isHeader = !!headerRanges.some(key => headerRows[key].find(el => el.index == item.index));
                  let isNotLastHeader = headerRanges.slice(1).some(key => headerRows[key].find(el => el.index == item.index));
                  return (isHeader ? !isNotLastHeader : true);//exclude headers with merged cells
                };

                group['cols'] = mergeCoordinates([...(group['cols'] || []), ...(group['assuredCols'] || [])].sort((a, b) => a - b), group['assuredCols'], { averageMerge: true, threshold: lineMaxWidth });
                let handledCols = getHandledGridItems({
                  gridItems: group['cols'],
                  gridItemsType: 'cols',
                  coordinates: increasedCoordinates,
                  filterFn: filterFn,
                  assuredGridItems: group['assuredCols']
                });
                alias['cols'] = handledCols.alias;
                group['cols'] = handledCols.gridItems;

                // The width of a ruled table is defined by its rules: column borders outside them
                // (decorations, pictures, backdrops) are not columns of the table
                if (tolerance !== Infinity) {
                  const ruleExtent = getRuleExtent(group, lineMaxWidth);

                  if (ruleExtent) {
                    const margin = 1.5;
                    const before = [...group['cols']];

                    group['cols'] = [...new Set([
                      ruleExtent.left,
                      ...group['cols'].filter(
                        col => col > ruleExtent.left + margin && col < ruleExtent.right - margin
                      ),
                      ruleExtent.right,
                    ])].sort((a, b) => a - b);
                  }
                }

                group['increasedCoordinates'] = increasedCoordinates;
                group['paddingSize'] = handledRows.paddingSize;
                group['borderSize'] = borderSize;

                group['x'] = [
                  Math.min(...group['x'], ...group.cols),
                  Math.max(...group['x'], ...group.cols)
                ];
                group['y'] = [
                  Math.min(...group['y'], ...group.rows),
                  Math.max(...group['y'], ...group.rows)
                ];

                const hasExcludedNestedRectangles = (group['rectangles'] || [])
                  .some(rect => nestedRectangles.has(rect));

                if (headerRanges.length || (tolerance == Infinity) || hasExcludedNestedRectangles) {
                  prev.push(group);
                }

                return prev;
              }, []);

              return groups;
            }


            return { tableGroups, pageGroups };
          }


          //Convergence threshold for border merger
          let threshold = 1;

          // let horizontalEdges = [], verticalEdges = [];
          // edges.sort((a, b) => b.y - a.y).filter(item => isVisibleVector(item)).forEach(edge => {
          //     if ((edge.height < lineMaxWidth) && (edge.width > lineMaxWidth)) {
          //         horizontalEdges.push(edge);
          //     } else if ((edge.width < lineMaxWidth) && (edge.height > lineMaxWidth)) {
          //         verticalEdges.push(edge);
          //     }
          // });

          /*intersections*/
          (() => {
            let watermarksIndexes = [];
            //let array = [];

            const findPreviousRelatedItem = (mainIndex, removedItem) => {
              const removedX = removedItem?.x ?? removedItem?.transform?.[4] ?? 0;
              const removedY = removedItem?.y ?? removedItem?.transform?.[5] ?? 0;
              const removedHeight = Math.abs(
                removedItem?.height || removedItem?.transform?.[3] || 0
              );

              const removedLeft = removedX;
              const removedRight = removedX + Math.abs(removedItem?.width || 0);

              let iterationLimit = 5;
              for (
                let index = mainIndex - 1;
                index >= Math.max(0, mainIndex - iterationLimit);
                index--
              ) {
                if (watermarksIndexes.includes(index)) {
                  continue;
                }

                const candidate = tableContentItems[index];

                if (!candidate) {//isEmptyCoordinate(candidate)
                  continue;
                }

                let isEmptyRemoved = isEmptyCoordinate(removedItem);

                if (isEmptyRemoved ? false : !isSameFont(candidate, removedItem)) {
                  continue;
                }

                const candidateY =
                  candidate?.y ?? candidate?.transform?.[5] ?? 0;

                const candidateHeight = Math.abs(
                  candidate?.height || candidate?.transform?.[3] || 0
                );

                const candidateLeft =
                  candidate?.x ?? candidate?.transform?.[4] ?? 0;

                const candidateRight =
                  candidateLeft + Math.abs(candidate?.width || 0);

                const sameY =
                  Math.abs(candidateY - removedY) <= 0.5;

                let toleranceTypes = {
                  empty: [4, 0.3],
                  fill: [0.5, 0.05],
                };

                let tolerance = isEmptyRemoved ? toleranceTypes['empty'] : toleranceTypes['fill'];

                const similarHeight =
                  removedHeight > 0 &&
                  candidateHeight > 0 &&
                  (
                    Math.abs(candidateHeight - removedHeight) < tolerance[0] ||
                    (Math.abs(candidateHeight - removedHeight) / Math.max(candidateHeight, removedHeight)) < tolerance[1]
                  );

                if (!similarHeight) {
                  continue;
                }

                const xTolerance = Math.max(0.5, removedHeight * 0.1);

                const touchesX =
                  Math.abs(candidateRight - removedLeft) <= xTolerance ||
                  Math.abs(removedRight - candidateLeft) <= xTolerance;

                if (touchesX && sameY) {
                  return candidate;
                }
                return candidate;
              }

              return null;
            };

            const getObj = (obj: any) =>
              Object.assign({}, obj, (() => {
                let [a, b, c, d, x, y] = obj.transform;
                x = obj.x || x;
                y = obj.y || y;
                return { x, y };
              })());

            const getYRange = (obj: any): [number, number] | null => {
              const y = obj.y || obj.transform?.[5];
              return Number.isFinite(y) && Number.isFinite(obj.height) ? getBoxRange(y, obj.height) : null;
            };

            const visibleEdges = [...(edges || []), ...(rectanglesEdges || [])].filter(item => isVisibleVector(item));
            const itemsIndex = createRangeIndex(tableContentItems, getYRange);
            const edgesIndex = createRangeIndex(visibleEdges, getYRange);

            for (let mainIndex = 0; mainIndex < tableContentItems.length; mainIndex++) {
              const item = tableContentItems[mainIndex];
              const itemBox = getObj(item);
              const yRange = getYRange(item);

              const isNeighbour = (index: number): boolean => {
                if (index === mainIndex) return false;
                const cur = tableContentItems[index];
                // An image never turns text into a watermark: text drawn over pictures
                // (a starry background, a logo behind a table) is ordinary content.
                // A watermark IMAGE is still removed: it is checked as `item` itself
                // (it intersects many text items).
                if (cur?.imageName && !item?.imageName) return false;
                return (
                  checkRectangleRanges(getObj(cur), itemBox, { strict: true, strictIntersecting: true, axis: ['x', 'y'] }) as Array<any>
                ).every(res => res.inRange);
              };
              //const neighbourCandidates = yRange ? itemsIndex.query(yRange[0], yRange[1]) : tableContentItems.map((_, i) => i);
              //const intersectionsIndexes = neighbourCandidates.filter(isNeighbour);//!BUG in m27.pdf (wrong header)
              const intersectionsIndexes = tableContentItems.reduce(
                (prev, cur, index) => {

                  if (isNeighbour(index)) {
                    prev.push(index);
                  }

                  return prev;
                },
                []
              );
              verifySameResult('intersections', intersectionsIndexes, () => tableContentItems.map((_, i) => i).filter(isNeighbour));

              if (
                intersectionsIndexes.length > 1 &&
                !isOverlayOnSameTextLine(item, intersectionsIndexes.map(index => tableContentItems[index]))
              ) {
                if (!watermarksIndexes.includes(mainIndex)) watermarksIndexes.push(mainIndex);
              }

              const touchesVisibleEdge = (): boolean => {
                const touches = (edge: any) =>
                  (
                    checkRectangleRanges(getObj(edge), itemBox, {
                      strict: true,
                      strictIntersecting: false,
                      axis: ['x', 'y'],
                      tolerance: -Math.min(edge.width, edge.height)
                    }) as Array<any>
                  ).every(res => res.inRange);
                const candidates = yRange ? edgesIndex.query(yRange[0], yRange[1]).map(i => visibleEdges[i]) : visibleEdges;
                return candidates.some(touches);
              };

              const isWatermark = (isEmptyCoordinate(item) && touchesVisibleEdge()) || (item?.str == ' ' && item.hasEOT);
              if (isWatermark) {
                let removedItem = tableContentItems[mainIndex];

                let previousRelatedItem = findPreviousRelatedItem(
                  mainIndex,
                  removedItem
                );

                if (previousRelatedItem) {
                  previousRelatedItem['hasEOT'] =
                    previousRelatedItem['hasEOT'] || removedItem['hasEOT'];

                  updateChars({
                    item: previousRelatedItem,
                    lineBreakNeeded:
                      previousRelatedItem['hasEOT']
                        ? false
                        : isEmptyCoordinate(removedItem)
                          ? removedItem['hasEOL']
                          : false,
                    spaceNeeded: false
                  });
                }

                if (!watermarksIndexes.includes(mainIndex)) {
                  watermarksIndexes.push(mainIndex);
                }
              }
            }

            // DEBUG_LOG && console.error('[WATERMARK REMOVED]', watermarksIndexes.map(index => ({
            //   str: tableContentItems[index]?.str,
            //   y: tableContentItems[index]?.transform?.[5],
            //   intersects: (array.find(entry => entry.index === index)?.intersectionsIndexes || [])
            //     .map(other => ({
            //       str: tableContentItems[other]?.str,
            //       image: tableContentItems[other]?.imageName,
            //     })),
            // })));
            removeByIndexes(tableContentItems, watermarksIndexes);
          })();

          /*FOR DEBUGGING
          function getContent(n){
              return [tableContentItemsOrig[n], tableContentItemsNew[n]];
          }
          tableContentItemsNew.reduce((prev, cur, n)=>{
              if((tableContentItemsNew[n].hasEOL != tableContentItemsOrig[n].hasEOL) || (tableContentItemsNew[n].hasEOT != tableContentItemsOrig[n].hasEOT)){
                  prev.push([n,...getContent(n)])
              }
              return prev
          },[])
          */


          //Extracting text coordinates
          tableContentItems = removeOverlaidDuplicateItems(tableContentItems);

          let coordinates = extractCoordinates(tableContentItems);

          // Nested decoration rectangles: fully contained in another visible rectangle
          // of the same fill color. They keep the group spatially united but must not
          // contribute their borders to the table grid (rows/cols/rectanglesEdges).
          const nestedRectangles = new Set<any>();
          {
            const visibleFillRects = rectangles.filter(r => isVisibleVector(r) && r.fillColor);
            for (const inner of visibleFillRects) {
              const isNested = visibleFillRects.some(outer =>
                outer !== inner && isSameFillColor(outer, inner) && isStrictlyContained(outer, inner)
              );
              if (isNested) {
                nestedRectangles.add(inner);
              }
            }
          }

          if (debugTrace) {
            // These are copies made before grouping and before replacing the edges with virtual edges.
            debugTrace.items = tableContentItems.map((item: any) => item ? ({
              ...item,
              transform: item.transform ? Array.from(item.transform) : item.transform,
              __pdfTraceOpIndexes: item.__pdfTraceOpIndexes
                ? Array.from(item.__pdfTraceOpIndexes)
                : item.__pdfTraceOpIndexes,
            }) : item);

            debugTrace.edges = edges.map((edge: any) => ({ ...edge }));
            debugTrace.rectangles = rectangles.map((rect: any) => ({ ...rect }));
          }

          //Defining cell boundaries
          let { tableGroups, pageGroups } = getGroups();

          if (debugTrace) {
            debugTrace.tableGroups = tableGroups;
            debugTrace.pageGroups = pageGroups;
            debugTrace.cleanupRoots.push(tableGroups, pageGroups);
          }

          for (let tableIndex = 0; tableIndex < tableGroups.length; tableIndex++) {
            let tableGroup = tableGroups[tableIndex];

            // Generation of virtual boundaries with merging of close boundaries
            let virtualEdges = generateVirtualEdges({
              rows: tableGroup.rows,//[...new Set([...pageRows, ...tableGroup.rows])].sort((a, b) => a - b),
              cols: tableGroup.cols,//[...new Set([...pageCols, ...tableGroup.cols])].sort((a, b) => a - b),
              coordinates: tableGroup.coordinates, //tableGroup.increasedCoordinates
              assuredEdges: (() => {
                let visibleEdges = [...(tableGroup?.edges || []), ...(tableGroup.rectanglesEdges || [])].filter(item => isVisibleVector(item));
                return visibleEdges;
              })(),
              lineMaxWidth,
              paddingSize: tableGroup.paddingSize,
              headerRows: tableGroup.headerRows,
              protectedRows: tableGroup.synthesizedRows || [],
              leaderBoundaries: tableGroup.leaderBoundaries || []
              //threshold
            });

            //overwrite the default boundaries
            edges = virtualEdges;

            // Detection and protection against non-numeric edges
            const badVirtualEdges = virtualEdges.filter(
              edge => ![edge.x, edge.y, edge.width, edge.height].every(Number.isFinite)
            );

            edges = virtualEdges.filter(
              edge => [edge.x, edge.y, edge.width, edge.height].every(Number.isFinite)
            );

            // merge rectangle to verticle lines and horizon lines
            let edges1 = JSON.parse(JSON.stringify(edges));
            let edges2 = JSON.parse(JSON.stringify(edges));
            edges1 = edges1.sort(function (a, b) { return (a.x - b.x) || (a.y - b.y); });
            edges2 = edges2.sort(function (a, b) { return (a.y - b.y) || (a.x - b.x); });

            // get verticle lines
            current = Object.assign(current, {
              x: null,
              y: null,
              height: 0
            })

            var verticles = [];
            var horizons = [];
            var lines = [];

            var linesAddVerticle = function (lines, top, bottom) {
              var hit = false;
              for (var i = 0; i < lines.length; i++) {
                if (lines[i].bottom < top || lines[i].top > bottom) { continue; }
                hit = true;
                top = Math.min(lines[i].top, top);
                bottom = Math.max(lines[i].bottom, bottom);
                lines.splice(i, 1);
                i--;
              }
              if (!hit) { lines.push({ top: top, bottom: bottom }); }
              else { lines.push({ top: top, bottom: bottom }); }
              return lines;
            };

            var linesAddHorizon = function (lines, left, right) {
              var hit = false;
              for (var i = 0; i < lines.length; i++) {
                if (lines[i].right < left || lines[i].left > right) { continue; }
                hit = true;
                left = Math.min(lines[i].left, left);
                right = Math.max(lines[i].right, right);
                lines.splice(i, 1);
                i--;
              }
              if (!hit) { lines.push({ left: left, right: right }); }
              else { lines.push({ left: left, right: right }); }
              return lines;
            };

            var verticlesMap = {};
            for (const edge of edges1) {
              if (edge.width > lineMaxWidth) continue;
              let bestX = null;
              let minDist = Infinity;
              for (const vx of Object.keys(verticlesMap)) {
                let dist = Math.abs(+vx - edge.x);
                if (dist < minDist) { minDist = dist; bestX = vx; }
              }
              if (!bestX || minDist > lineMaxWidth) {
                bestX = edge.x;
                verticlesMap[bestX] = [];
              }
              verticlesMap[bestX] = linesAddVerticle(verticlesMap[bestX], edge.y, edge.y + edge.height);
            }
            verticles = Object.keys(verticlesMap).map(vx => ({ x: +vx, lines: verticlesMap[vx] })).sort((a, b) => a.x - b.x);

            var horizonsMap = {};
            for (const edge of edges2) {
              if (edge.height > lineMaxWidth) continue;
              let bestY = null;
              let minDist = Infinity;
              for (const hy of Object.keys(horizonsMap)) {
                let dist = Math.abs(+hy - edge.y);
                if (dist < minDist) { minDist = dist; bestY = hy; }
              }
              if (!bestY || minDist > lineMaxWidth) {
                bestY = edge.y;
                horizonsMap[bestY] = [];
              }
              horizonsMap[bestY] = linesAddHorizon(horizonsMap[bestY], edge.x, edge.x + edge.width);
            }
            horizons = Object.keys(horizonsMap).map(hy => ({ y: +hy, lines: horizonsMap[hy] })).sort((a, b) => b.y - a.y);

            if (verticles.length === 0 || horizons.length === 0) {
              return {};
            }
            horizons.push({ y: current['y'], lines: lines });

            function createMatrix(verticles, horizons) {
              verticles = verticles.sort(function (a, b) { return a.x - b.x; });
              horizons = horizons.sort(function (a, b) { return b.y - a.y; });
              let mergesArrays = [];
              //let previousMergeArrayIndex;

              let xList = verticles.map(function (a) { return a.x; });
              var yList = horizons.map(function (a) { return a.y; });

              const headerSegments = (tableGroup.edges || [])
                .filter((edge: any) =>
                  hasVectorColor(edge) &&
                  !edge._isFakeLine &&
                  edge.height < 3 &&
                  edge.width > lineMaxWidth &&
                  Math.abs(edge.y + edge.height / 2 - yList[0]) <= 1.5
                )
                .map((edge: any) => ({
                  left: edge.x,
                  right: edge.x + edge.width,
                }));

              const hasHeaderSegmentBoundary = (x: number) => {
                const tolerance = 1.5;

                return (
                  headerSegments.some(segment => Math.abs(segment.right - x) <= tolerance) &&
                  headerSegments.some(segment => Math.abs(segment.left - x) <= tolerance)
                );
              };

              // Create a matrix 1 larger in width and height for correct border processing
              const matrix = Array.from({ length: yList.length * 2 - 1 }, () =>
                Array(xList.length * 2 - 1).fill(0)
              );

              for (var h = 0; h < matrix.length; h++) {
                let horizonIndex = Math.floor(h / 2);
                let currentHorizon = horizons[horizonIndex];
                let isHorizonBorder = !(h % 2);
                matrix[h]['name'] = isHorizonBorder ? currentHorizon.y : horizonIndex;
                for (var v = 0; v < matrix[h].length; v++) {
                  let verticleIndex = Math.floor(v / 2);
                  let currentVerticle = verticles[verticleIndex];
                  let isVerticleBorder = !(v % 2);
                  if (isVerticleBorder || isHorizonBorder) {
                    let hasLine = (() => {
                      // The outer border is always present so that the absence of a line at the edge
                      // does not result in a merge with a nonexistent cell
                      const isOuterVerticleBorder =
                        isVerticleBorder && !isHorizonBorder &&
                        (v === 0 || v === matrix[h].length - 1);
                      const isOuterHorizonBorder =
                        !isVerticleBorder && isHorizonBorder &&
                        (h === 0 || h === matrix.length - 1);

                      if (isOuterVerticleBorder || isOuterHorizonBorder) {
                        return 1;
                      }

                      let hCondition = (isVerticleBorder && [xList[0], xList[xList.length - 1]].includes(currentVerticle.x)) || currentHorizon.lines.some(item => {
                        return (checkRectangleRanges(
                          { x: [item.left, item.right] },
                          { x: !isVerticleBorder ? currentVerticle.x + 1 : currentVerticle.x },
                          { axis: ['x'], strict: true, strictIntersecting: true }
                        ) as Array<any>).every(item => item.inRange);
                      });
                      let vCondition = (isHorizonBorder && [yList[0], yList[yList.length - 1]].includes(currentHorizon.y)) || currentVerticle.lines.some(item => {
                        return (checkRectangleRanges(
                          { y: [item.top, item.bottom] },
                          { y: !isHorizonBorder ? currentHorizon.y - 1 : currentHorizon.y },
                          { axis: ['y'], strict: true, strictIntersecting: true }
                        ) as Array<any>).every(item => item.inRange);
                      })
                      if (isVerticleBorder && isHorizonBorder) { //horizontal and vertical border
                        return Number(hCondition || vCondition);
                      } else if (isVerticleBorder && !isHorizonBorder) {
                        return Number(
                          vCondition ||
                          (horizonIndex === 0 && hasHeaderSegmentBoundary(currentVerticle.x))
                        );
                      } else if (!isVerticleBorder && isHorizonBorder) {
                        return Number(hCondition);
                      } else {
                        return Number(hCondition && vCondition);
                      }
                    })();
                    matrix[h][v] = hasLine;

                    //let closedIndexes;
                    let previousCells;
                    let previousMatrixItems;
                    (() => {
                      if (isVerticleBorder && isHorizonBorder) {
                        previousCells = [];
                        if (horizonIndex > 0) previousCells.push([horizonIndex - 1, verticleIndex]);
                        if (verticleIndex > 0) previousCells.push([horizonIndex, verticleIndex - 1]);

                        previousMatrixItems = [];
                        if (h > 0) previousMatrixItems.push([h - 1, v]);
                        if (v > 0) previousMatrixItems.push([h, v - 1]);
                      } else if (isVerticleBorder && !isHorizonBorder) {
                        previousCells = [];
                        if (verticleIndex > 0) previousCells.push([horizonIndex, verticleIndex - 1]);

                        previousMatrixItems = [];
                        if (v > 0) previousMatrixItems.push([h, v - 1]);
                      } else if (!isVerticleBorder && isHorizonBorder) {
                        previousCells = [];
                        if (horizonIndex > 0) previousCells.push([horizonIndex - 1, verticleIndex]);

                        previousMatrixItems = [];
                        if (h > 0) previousMatrixItems.push([h - 1, v]);
                      } else {
                        previousCells = [[horizonIndex, verticleIndex]];
                        previousMatrixItems = [[h, v]];
                      }
                    })();

                    if (!hasLine) {
                      let adjacentValue;
                      let mergeMatrixNeighborValue;
                      let needFilteringAgain;
                      let currentMergeArray = (() => {
                        let filtered = mergesArrays.filter(arr => {
                          return arr.some(item => {
                            let cells = [[horizonIndex, verticleIndex]];//old:previousCells;
                            let isNeighbor = cells.some(p => (adjacentValue = areCellsAdjacent(item, p)).some(c => c));
                            return isNeighbor;
                          })
                        });
                        let neighborH = (adjacentValue || [])[0] ? h - 1 : h;
                        let neighborV = (adjacentValue || [])[1] ? v - 1 : v;
                        let neighborHIndex = Math.floor(neighborH / 2);
                        let neighborVIndex = Math.floor(neighborV / 2);
                        mergeMatrixNeighborValue = adjacentValue ? matrix[neighborH][neighborV] : 0;

                        //!BUGFIX (correct filtering)
                        needFilteringAgain = (
                          mergeMatrixNeighborValue &&
                          (neighborHIndex == horizonIndex && neighborHIndex != 0) &&
                          (neighborVIndex == verticleIndex && neighborVIndex != 0)
                        );
                        if (needFilteringAgain) {
                          neighborHIndex = (adjacentValue || [])[0] ? neighborHIndex - 1 : neighborHIndex;
                          neighborVIndex = (adjacentValue || [])[1] ? neighborVIndex - 1 : neighborVIndex;

                          neighborH = (adjacentValue || [])[0] ? neighborH - 1 : h;
                          neighborV = (adjacentValue || [])[1] ? neighborV - 1 : v;
                          //mergeMatrixNeighborValue = adjacentValue ? matrix[neighborH][neighborV] : 0;
                        }
                        //filter out those cells that are blocked by the line
                        filtered = mergeMatrixNeighborValue ? filtered.filter(arr => {
                          return !arr.some(item => {
                            return item[0] == neighborHIndex && item[1] == neighborVIndex
                          });
                        }) : filtered;

                        return filtered[filtered.length - 1];
                      })();

                      function addNewMergeArray() {
                        currentMergeArray = [...previousCells, [horizonIndex, verticleIndex]];
                        //previousMergeArrayIndex = mergesArrays.length;
                        //currentMergeArray.closed = [...Array(2)].map((item,index)=>currentMergeArray?.closed?.[index] || false);
                        mergesArrays.push(currentMergeArray);
                      }



                      if (currentMergeArray) { //&& (closedIndexes.length ? closedIndexes.every(i=>currentMergeArray.closed[i] == false): true)
                        if (!mergeMatrixNeighborValue || needFilteringAgain) {
                          if (previousMatrixItems.every(arr => matrix[arr[0]][arr[1]] == 0)) {
                            currentMergeArray.push([horizonIndex, verticleIndex]);
                          } else {
                            //closedIndexes.forEach(item=>currentMergeArray.closed[item]=true);
                          }
                        } else {
                          //currentMergeArray.closed = [...Array(2)].map((item,index)=>currentMergeArray?.closed?.[index] || adjacentValue?.[index] || false);
                          addNewMergeArray();
                        }
                      } else {
                        addNewMergeArray();
                      }
                    }
                  }
                }
              }

              

              let merges = mergesArrays.reduce((prev, cur) => {
                let widthArr = cur.reduce((p, c) => {
                  if (!p.some(item => item[1] == c[1])) {
                    p.push(c);
                  }
                  return p;
                }, []);
                let heightArr = cur.reduce((p, c) => {
                  if (!p.some(item => item[0] == c[0])) {
                    p.push(c);
                  }
                  return p;
                }, []);
                prev[cur[0].join('-')] = {
                  row: cur[0][0],
                  col: cur[0][1],
                  arr: uniqueArr(cur.map(item => item.join('-'))),
                  widthArr: uniqueArr(widthArr.map(item => item.join('-'))),
                  heightArr: uniqueArr(heightArr.map(item => item.join('-'))),
                  width: widthArr.length,
                  height: heightArr.length,
                }
                return prev;
              }, {})

              let mergeAlias = Object.keys(merges).reduce((prev, cur) => {
                merges[cur].arr.forEach(item => {
                  if (cur != item) {
                    prev[item] = cur;
                  }
                })
                return prev;
              }, {})


              // The greedy merge may produce overlapping rectangles (one cell owned by two merges).
              // Text of such cells ends up in a hidden alias cell, so they are treated as broken too.
              const cellOwner = new Map<string, string>();
              const hasOverlappingMerge = Object.keys(merges).some(rootKey =>
                merges[rootKey].arr.some((cellKey: string) => {
                  const owner = cellOwner.get(cellKey);
                  if (owner !== undefined && owner !== rootKey) {
                    return true;
                  }
                  cellOwner.set(cellKey, rootKey);
                  return false;
                })
              );
              // Non-rectangular merges (arr.length != width * height) always result in broken HTML
              // (cells are lost or duplicated). We rebuild them directly from the matrix.
              const hasBrokenMerge =
                hasOverlappingMerge ||
                Object.keys(merges).some(key => {
                  const merge = merges[key];
                  return merge.arr.length !== merge.width * merge.height;
                });

              if (hasBrokenMerge) {
                const rebuiltMerges = buildMergesFromMatrix(
                  matrix,
                  yList.length - 1,
                  xList.length - 1
                );

                if (rebuiltMerges) {
                  merges = rebuiltMerges;
                  mergeAlias = Object.keys(merges).reduce((prev, cur) => {
                    merges[cur].arr.forEach((item) => {
                      if (cur != item) {
                        prev[item] = cur;
                      }
                    });
                    return prev;
                  }, {} as Record<string, string>);
                }
              }

              return { matrix, merges, mergeAlias };
            }

            horizons = horizons.filter(item => Number.isFinite(item.y));
            verticles = verticles.filter(item => Number.isFinite(item.x));

            const textAlignedGrid = inferTextAlignedGrid(tableGroup, verticles.length - 1, lineMaxWidth);

            if (textAlignedGrid) {
              verticles = textAlignedGrid.verticles;
              horizons = textAlignedGrid.horizons;
              Object.assign(tableGroup, {
                cols: textAlignedGrid.cols,
                rows: textAlignedGrid.rows,
                x: textAlignedGrid.x,
                y: textAlignedGrid.y,
                headerRows: textAlignedGrid.headerRows
              });
              // tableGroup.coordinates DO NOT touch it.
            }

            let matrixData = createMatrix(
              verticles,
              horizons
            );

            inferMergesFromFillRectangles({
              tableGroup,
              pageGroup: pageGroups[0],
              verticles,
              horizons,
              merges: matrixData.merges,
              mergeAlias: matrixData.mergeAlias,
              lineMaxWidth,
            });

            inferHeaderRowSpans({
              tableGroup,
              verticles,
              horizons,
              merges: matrixData.merges,
              mergeAlias: matrixData.mergeAlias,
              lineMaxWidth
            });

            inferHeaderSpansFromText({
              tableGroup,
              verticles,
              horizons,
              merges: matrixData.merges,
              mergeAlias: matrixData.mergeAlias,
              lineMaxWidth,
            });

            validateColumnMerges({
              merges: matrixData.merges,
              mergeAlias: matrixData.mergeAlias,
              verticles, horizons,
              coordinates: tableGroup.coordinates || [],
            });

            Object.assign(tableGroup, {
              verticles,
              horizons,
              merges: matrixData.merges,
              mergeAlias: matrixData.mergeAlias,
              matrix: matrixData.matrix,
              filledRectangles,
              cellFills: computeCellFills({
                verticles,
                horizons,
                merges: matrixData.merges,
                mergeAlias: matrixData.mergeAlias,
                rectangles,
              }),
            });
          }

          return { tableGroups, pageGroups }

        }).then(function ({ tableGroups, pageGroups }) {

          for (let tableIndex = 0; tableIndex < tableGroups.length; tableIndex++) {
            let tableGroup = tableGroups[tableIndex];

            let tableData = extractTableData({
              verticles: tableGroup.verticles,
              horizons: tableGroup.horizons,
              coordinates: tableGroup.coordinates,
              merges: tableGroup.merges,
              mergeAlias: tableGroup.mergeAlias,
              headerRows: tableGroup.headerRows,
              edges: tableGroup.edges,
              tableGroup: tableGroup,
              pageGroup: pageGroups[0],
              lineMaxWidth: lineMaxWidth,
              rectangles: tableGroup.rectangles,
            });

            // A table needs at least a header and one body row: a single line of text is not a table.
            const nonEmptyRows = tableData.table.array.filter(row =>
              row.some(cell => (cell?.str || '').trim().length > 0),
            ).length;

            // A grid without any text is a decoration (a filled box, a frame, shadows), not a table
            if (tableData.table.array.length && nonEmptyRows >= 2) {
              tableGroup.tableData = tableData;
            }
          }

          if (debugTrace?.options?.onReport) {

            function stripDebugMetadata(roots: unknown[]): void {
              const seen = new WeakSet<object>();

              const visit = (value: any): void => {
                if (!value || typeof value !== 'object' || seen.has(value)) return;
                seen.add(value);
                delete value.__pdfTraceOpIndex;
                delete value.__pdfTraceOpIndexes;
                for (const key of Object.keys(value)) visit(value[key]);
              };

              for (const root of roots) visit(root);
            }

            const options = debugTrace.options;
            const expectedHtml = typeof options.expectedHtml === 'string'
              ? options.expectedHtml
              : options.expectedHtml?.[debugTrace.pageNumber];

            const groups = debugTrace.tableGroups || [];
            const tables = groups
              .filter((group: any) => !!group?.tableData?.table?.array)
              .map((group: any) => ({
                group,
                array: group.tableData.table.array,
              }));

            const text = buildDebugReport({
              pageNumber: debugTrace.pageNumber,
              pageSize: debugTrace.pageSize,
              opList: debugTrace.opList,
              pdfjsOps: debugTrace.pdfjsOps,
              pdfjsItems: debugTrace.pdfjsItems,
              items: debugTrace.items,
              edges: debugTrace.edges,
              rectangles: debugTrace.rectangles,
              lineMaxWidth: debugTrace.lineMaxWidth,
              tableGroups: groups,
              tables,
              level: options.level,
              region: options.region,
              maxItems: options.maxItems,
              numberDigits: options.numberDigits,
              minify: options.minify,
              opWindow: options.opWindow,
              compareTextPositions: options.compareTextPositions,
              expectedHtml,
            });

            try {
              options.onReport({ page: debugTrace.pageNumber, text });
            } finally {
              stripDebugMetadata(debugTrace.cleanupRoots);
            }
          }

          result.pageTables.push({
            page: pageNum,
            tableGroups: tableGroups.filter(group => group.tableData),
            pageGroup: pageGroups[0]
          });
          result.currentPage++;
          if ('function' === typeof (onProgress)) {
            onProgress(result);
          }

        });
      });
    };
    async function runPages() {
      for (let idx = 0; idx < pagesToProcess.length; idx++) {
        await loadPage(pagesToProcess[idx]);
        await yieldToMain(); // we give control to the browser between the pages — the tab does not hang
      }
      return result;
    }
    return runPages();
  };

  async function extractorRun(options) {
    let { dataArray, onProgress, onSuccess, onError, pages, debug } = options;

    let docParams: any = { data: dataArray };
    if (standardFontDataUrl) {
      docParams.standardFontDataUrl = standardFontDataUrl;
    }
    let documentLoadingTask = await pdfjs.getDocument(docParams);
    let documentProxy = await documentLoadingTask.promise;
    try {
      let extractorResults = await extractor({ doc: documentProxy, onProgress, pages, debugOptions: debug });
      let results = { extractorResults, documentProxy };
      if (onSuccess) {
        onSuccess(results);
      }
      return results;
    } catch (err) {
      if (onError) {
        onError(err);
      }
      throw err;
    }
  }

  return { extractorRun };
}
