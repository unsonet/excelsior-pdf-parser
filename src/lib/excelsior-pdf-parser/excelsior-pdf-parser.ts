// import * as Fs from 'fs';
// import * as Path from 'path';
// import { fileURLToPath } from 'url';
// import { dirname } from 'path';
import { getTextDirection, findClosestIndex, parseRGB, getMergedArray, uniqueArr, findMod, findAverage, caseIndependentCompare, splitByIndex, checkRectangleRanges, removeByIndexes, getSplitEdgeRange, getOnePercentOfAbsoluteDifference, typeValue, sortArrayOfObjects, deepSet } from '@unsonet/js-utils'

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

  // Gives control to the browser (paint/input) between pieces of heavy synchronous work.
  // MessageChannel provides minimal latency and works in both the browser and node18 (nodeConfig).
  function yieldToMain(): Promise<void> {
    if (typeof MessageChannel !== 'undefined') {
      return new Promise<void>(resolve => {
        const channel = new MessageChannel();
        channel.port2.onmessage = () => resolve();
        channel.port1.postMessage(null);
      });
    }
    return new Promise<void>(resolve => setTimeout(resolve, 0));
  }

  // Turns the pages option into a specific list of page numbers (1-based).
  // Without pages, the behavior is the same as before: all pages.
  function resolvePagesToProcess(numPages: number, pages?: number[] | { from?: number; to?: number }): number[] {
    if (!pages) {
      return Array.from({ length: numPages }, (_, i) => i + 1);
    }
    if (Array.isArray(pages)) {
      return pages.filter(p => p >= 1 && p <= numPages);
    }
    const from = Math.max(1, pages.from || 1);
    const to = Math.min(numPages, pages.to || numPages);
    const arr: number[] = [];
    for (let p = from; p <= to; p++) arr.push(p);
    return arr;
  }

  function extractor(doc, onProgress?, pages?: number[] | { from?: number; to?: number }) {
    var numPages = doc.numPages;
    var result: { pageTables: Array<any>, numPages: number, currentPage: number } = { pageTables: [], numPages: numPages, currentPage: 0, };
    var lineMaxWidth = 5;//old:2.5;


    // === CJK normalization utilities ===
    const CJK_REGEX = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF\uFF00-\uFFEF]/;

    /** Checks if a single character is CJK/fullwidth */
    function isCJKChar(ch: string): boolean {
      return CJK_REGEX.test(ch);
    }

    /** Removes spaces between CJK characters (pdfjs 6.x artifact) */
    function normalizeCJKText(str: string): string {
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

    //pdfjs.Util.transform
    function transformFn(m1, m2) {
      return [
        m1[0] * m2[0] + m1[2] * m2[1],
        m1[1] * m2[0] + m1[3] * m2[1],
        m1[0] * m2[2] + m1[2] * m2[3],
        m1[1] * m2[2] + m1[3] * m2[3],
        m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
        m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
      ];
    };

    //pdfjs.Util.applyTransform
    function applyTransformFn(p, m) {
      var xt = p[0] * m[0] + p[1] * m[2] + m[4];
      var yt = p[0] * m[1] + p[1] * m[3] + m[5];
      return [xt, yt];
    };


    var pagesToProcess = resolvePagesToProcess(numPages, pages);
    var loadPage = function (pageNum) {
      return doc.getPage(pageNum).then(async function (page) {
        const _defaultTransformMatrix = [1, 0, 0, 1, 0, 0];
        const _fontIdentityMatrix = [0.001, 0, 0, 0.001, 0, 0];
        var transformMatrix = JSON.parse(JSON.stringify(_defaultTransformMatrix));
        var textMatrix = JSON.parse(JSON.stringify(_defaultTransformMatrix));
        var transformStack = [];
        let pageTextContent = await page.getTextContent();
        let pageViewport = page.getViewport({ scale: 1 });
        let pageWidth = pageViewport.width;
        let pageHeight = pageViewport.height;

        console.error(`[DEBUG Page ${pageNum}] getTextContent items:`, pageTextContent.items.length);
        console.error(`[DEBUG Page ${pageNum}] first 3 items:`, pageTextContent.items.slice(0, 3).map(i => i ? { str: i.str, hasEOL: i.hasEOL, width: i.width, height: i.height } : 'NULL'));

        pageTextContent.items = pageTextContent.items.reduce((prev, cur, index) => {
          if (cur && typeof cur.str === 'string' && cur.str.trim()) {
            //cur.str = normalizeCJKText(cur.str);
            cur.index = prev.length;
            prev.push(cur);
          }
          return prev;
        }, []);

        console.error(`[DEBUG Page ${pageNum}] filtered items:`, pageTextContent.items.length);

        function getRelatedTextContentItems(element) {
          return pageTextContent.items.filter((item, index) => {
            if (!item) return false;
            return (checkRectangleRanges(
              element,
              { x: item.transform[4], y: item.transform[5], height: item.height, width: item.width },
              { axis: ['x', 'y'], strict: false, strictIntersecting: false }
            ) as Array<any>).every(item => item.inRange)
          });
        };

        const NESTED_RECT_TOLERANCE = 0.5;

        function isSameFillColor(a: any, b: any): boolean {
          return !!a?.fillColor && a.fillColor === b?.fillColor;
        }

        function isStrictlyContained(outer: any, inner: any, tolerance: number = NESTED_RECT_TOLERANCE): boolean {
          const innerRight = inner.x + inner.width;
          const innerBottom = inner.y + inner.height;
          const outerRight = outer.x + outer.width;
          const outerBottom = outer.y + outer.height;

          const contained =
            inner.x >= outer.x - tolerance &&
            inner.y >= outer.y - tolerance &&
            innerRight <= outerRight + tolerance &&
            innerBottom <= outerBottom + tolerance;

          if (!contained) return false;

          // Отсекаем дубликаты/совпадающие прямоугольники:
          // вложенный должен быть заметно меньше хотя бы по одной оси.
          const strictlySmaller =
            innerRight - inner.x < outerRight - outer.x - tolerance ||
            innerBottom - inner.y < outerBottom - outer.y - tolerance;

          return strictlySmaller;
        }

        function isVisibleVector(item) {
          let color = item?.fillColor || item?.strokeColor;
          let numbers = parseRGB(color);
          return numbers?.length ? !(numbers.length == 4 && numbers[numbers.length - 1] == 0) : false;
        }

        function hasVectorColor(item) {
          return !!(item?.fillColor || item?.strokeColor);
        }

        return page.getOperatorList().then(async function (opList) {
          // Get rectangle first
          var edges = [];
          var tableContentItems = [];
          var tableContentItemsCache = {};

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
          };

          let rectangles = [];
          let rectanglesEdges = [];

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


          // ===== HELPERS for compatibility of pdfjs-dist v5.1+ / v6+ (Node.js fake worker) =====
          function extractArrayLike(v: any): any[] {
            if (Array.isArray(v)) return v;
            if (!v || typeof v !== 'object') return [];
            if (typeof v.length === 'number') return Array.from(v);
            var keys = Object.keys(v).filter(function (k) { return /^\d+$/.test(k); })
              .sort(function (a, b) { return parseInt(a, 10) - parseInt(b, 10); });
            return keys.map(function (k) { return v[k]; });
          }

          function normalizeNumericArgs(args: any): any[] {
            // New format: [ { "0": x, "1": y, ... } ] (array with one Array-like object)
            if (Array.isArray(args) && args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
              return extractArrayLike(args[0]);
            }
            // Old format: Array-like object without wrapper
            if (!Array.isArray(args) && args && typeof args === 'object') {
              return extractArrayLike(args);
            }
            return args;
          }

          function grayToRGB(value: number): number[] {
            const gray = Math.round(
              Math.max(0, Math.min(1, value)) * 255
            );

            return [gray, gray, gray];
          }

          function cmykToRGB(
            c: number,
            m: number,
            y: number,
            k: number
          ): number[] {
            c = Math.max(0, Math.min(1, c));
            m = Math.max(0, Math.min(1, m));
            y = Math.max(0, Math.min(1, y));
            k = Math.max(0, Math.min(1, k));

            return [
              Math.round(255 * (1 - Math.min(1, c + k))),
              Math.round(255 * (1 - Math.min(1, m + k))),
              Math.round(255 * (1 - Math.min(1, y + k))),
            ];
          }

          function normalizeGenericColorArgs(args: any): number[] {
            const values = normalizeNumericArgs(args)
              .filter(value => typeof value === 'number');

            if (values.length === 1) {
              return grayToRGB(values[0]);
            }

            if (values.length === 3) {
              return values.map(value =>
                Math.round(
                  Math.max(0, Math.min(1, value)) * 255
                )
              );
            }

            if (values.length === 4) {
              return cmykToRGB(
                values[0],
                values[1],
                values[2],
                values[3]
              );
            }

            return [];
          }

          function normalizeColorArgs(args: any): number[] {
            if (Array.isArray(args) && args.length === 1 && typeof args[0] === 'string' && args[0].startsWith('#')) {
              var hex = args[0].slice(1);
              if (hex.length === 3) hex = hex.split('').map(function (c) { return c + c; }).join('');
              var num = parseInt(hex, 16);
              return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
            }
            var arr = normalizeNumericArgs(args);
            // Old format: args = [{"0":128,"1":128,"2":128}]
            if (Array.isArray(arr) && arr.length === 1 && arr[0] && typeof arr[0] === 'object' && !Array.isArray(arr[0])) {
              arr = extractArrayLike(arr[0]);
            }
            return Array.isArray(arr) ? arr.filter(v => typeof v === 'number') : [];
          }

          function normalizeFontArgs(args: any): [string, number] {
            if (!Array.isArray(args) || args.length === 0) return ['', 0];
            // New format pdfjs@6: [["g_d0_f3", 8], ["g_d0_f2", 8]]
            if (Array.isArray(args[0]) && args.length >= 1) {
              return [args[0][0], args[0][1]];
            }
            // Old format: ["g_d0_f1", 8]
            if (typeof args[0] === 'string') {
              return [args[0], args[1] || 0];
            }
            // Fallback
            let norm = normalizeNumericArgs(args);
            if (Array.isArray(norm[0])) return [norm[0][0], norm[0][1]];
            return [norm[0], norm[1]];
          }

          /**
 * Выделяет из pathOps/pathCoords замкнутые осевые подпути
 * (moveTo → lineTo×N → closePath), описывающие прямоугольники, и заменяет
 * каждый одиночным OPS.rectangle. Неконвертируемые подпути (кривые,
 * несомкнутые, невырожденные) копируются без изменений.
 */
          function extractClosedSubpathRectangles(pathOps: number[], pathCoords: number[]): { ops: number[], coords: number[] } {
            const coordCountFor = (op: number): number => {
              if (op === OPS.rectangle) return 4;
              if (op === OPS.moveTo || op === OPS.lineTo) return 2;
              if (op === OPS.curveTo) return 6;
              if (op === OPS.curveTo2 || op === OPS.curveTo3) return 4;
              return 0; // closePath и прочие без координат
            };

            const trySubpathToRect = (pts: number[][]): [number, number, number, number] | null => {
              if (pts.length < 4) return null; // moveTo + минимум 3 угла
              const xs = pts.map(p => p[0]);
              const ys = pts.map(p => p[1]);
              const x1 = Math.min(...xs), x2 = Math.max(...xs);
              const y1 = Math.min(...ys), y2 = Math.max(...ys);
              if (x2 - x1 < 0.01 || y2 - y1 < 0.01) return null;
              // все сегменты — осевые и на периметре bbox, периметр пути равен периметру bbox
              let perimeter = 0;
              for (let k = 0; k < pts.length; k++) {
                const [ax, ay] = pts[k];
                const [bx, by] = pts[(k + 1) % pts.length];
                const dx = bx - ax, dy = by - ay;
                if (Math.abs(dx) > 1e-4 && Math.abs(dy) > 1e-4) return null;
                perimeter += Math.abs(dx) + Math.abs(dy);
              }
              for (const [px, py] of pts) {
                const onV = (Math.abs(px - x1) < 0.01 || Math.abs(px - x2) < 0.01) && py >= y1 - 0.01 && py <= y2 + 0.01;
                const onH = (Math.abs(py - y1) < 0.01 || Math.abs(py - y2) < 0.01) && px >= x1 - 0.01 && px <= x2 + 0.01;
                if (!onV && !onH) return null;
              }
              if (Math.abs(perimeter - 2 * ((x2 - x1) + (y2 - y1))) > 0.5) return null;
              return [x1, y1, x2 - x1, y2 - y1];
            };

            const outOps: number[] = [];
            const outCoords: number[] = [];
            let ci = 0, i = 0;
            while (i < pathOps.length) {
              if (pathOps[i] !== OPS.moveTo) {
                const op = pathOps[i];
                outOps.push(op);
                const n = coordCountFor(op);
                for (let k = 0; k < n; k++) outCoords.push(pathCoords[ci++]);
                i++;
                continue;
              }
              // собираем подпуть до closePath / следующего moveTo
              const pts: number[][] = [[pathCoords[ci], pathCoords[ci + 1]]];
              ci += 2;
              const subOps: number[] = [OPS.moveTo];
              const subCoords: number[] = [...pts[0]];
              let closed = false;
              let hasCurves = false;
              i++;
              while (i < pathOps.length) {
                const op = pathOps[i];
                if (op === OPS.closePath) { closed = true; i++; break; }
                if (op === OPS.moveTo) break;
                subOps.push(op);
                const n = coordCountFor(op);
                for (let k = 0; k < n; k++) subCoords.push(pathCoords[ci]);
                if (op === OPS.lineTo) pts.push([pathCoords[ci], pathCoords[ci + 1]]);
                if (op >= OPS.curveTo && op <= OPS.curveTo3) hasCurves = true;
                ci += n;
                i++;
              }
              const rect = (closed && !hasCurves) ? trySubpathToRect(pts) : null;
              if (rect) {
                outOps.push(OPS.rectangle);
                outCoords.push(...rect);
              } else {
                outOps.push(...subOps, ...(closed ? [OPS.closePath] : []));
                outCoords.push(...subCoords);
              }
            }
            return { ops: outOps, coords: outCoords };
          }

          function normalizeShowTextArgs(args: any): any[] {
            if (!args || !args.length) return [];
            let glyphs = args[0];
            // If pdfjs returned the string directly
            if (typeof glyphs === 'string') {
              return glyphs.split('').map(ch => ({
                unicode: ch,
                width: 500,
                isSpace: ch === ' ',
                isLineBreak: ch === '\n',
                isInFont: true
              }));
            }
            // Array of arrays — flatten
            if (Array.isArray(glyphs) && glyphs.length > 0 && Array.isArray(glyphs[0])) {
              glyphs = glyphs.flat();
            }
            // Make sure that \n is marked as isLineBreak
            if (Array.isArray(glyphs)) {
              return glyphs.map(g => {
                if (typeof g === 'number') return g;
                if (typeof g === 'object' && g !== null) {
                  if (g.unicode === '\n' && !g.isLineBreak) {
                    return { ...g, isLineBreak: true };
                  }
                  return g;
                }
                return g;
              });
            }
            return [];
          }

          function normalizeDependencyArgs(args: any): string[] {
            if (!Array.isArray(args)) return [];
            if (args.length > 0 && Array.isArray(args[0])) {
              return args.map(pair => pair[0]).filter(Boolean);
            }
            return args.filter(item => typeof item === 'string');
          }
          // ===== END OF HELPERS =====

          // ===== BULLETPROOF OPS + getOperatorList =====
          const OPS = pdfjs?.OPS || {
            dependency: 1, setLineWidth: 2, setLineCap: 3, setLineJoin: 4, setMiterLimit: 5,
            setDash: 6, setRenderingIntent: 7, setFlatness: 8, setGState: 9, save: 10,
            restore: 11, transform: 12, moveTo: 13, lineTo: 14, curveTo: 15, curveTo2: 16,
            curveTo3: 17, closePath: 18, rectangle: 19, stroke: 20, closeStroke: 21,
            fill: 22, eoFill: 23, fillStroke: 24, eoFillStroke: 25, closeFillStroke: 26,
            closeEOFillStroke: 27, endPath: 28, clip: 29, eoClip: 30, beginText: 31,
            endText: 32, setCharSpacing: 33, setWordSpacing: 34, setHScale: 35,
            setLeading: 36, setFont: 37, setTextRenderingMode: 38, setTextRise: 39,
            moveText: 40, setLeadingMoveText: 41, setTextMatrix: 42, nextLine: 43,
            showText: 44, showSpacedText: 45, nextLineShowText: 46,
            nextLineSetSpacingShowText: 47, setCharWidth: 48, setCharWidthAndBounds: 49,
            setStrokeColorSpace: 50, setFillColorSpace: 51, setStrokeColor: 52,
            setStrokeColorN: 53, setFillColor: 54, setFillColorN: 55, setStrokeGray: 56,
            setFillGray: 57, setStrokeRGBColor: 58, setFillRGBColor: 59,
            setStrokeCMYKColor: 60, setFillCMYKColor: 61, shadingFill: 62,
            beginInlineImage: 63, beginImageData: 64, endInlineImage: 65,
            paintXObject: 66, markPoint: 67, markPointProps: 68, beginMarkedContent: 69,
            beginMarkedContentProps: 70, endMarkedContent: 71, beginCompat: 72,
            endCompat: 73, paintFormXObjectBegin: 74, paintFormXObjectEnd: 75,
            beginGroup: 76, endGroup: 77, beginAnnotation: 80, endAnnotation: 81,
            paintImageMaskXObject: 83, paintImageMaskXObjectGroup: 84,
            paintImageXObject: 85, paintInlineImageXObject: 86,
            paintInlineImageXObjectGroup: 87, paintImageXObjectRepeat: 88,
            paintImageMaskXObjectRepeat: 89, paintSolidColorImageMask: 90,
            constructPath: 91, setStrokeTransparent: 92, setFillTransparent: 93
          };

          // Normalize to regular arrays (Node.js can return an Int32Array)
          const _fnArray = Array.from(opList.fnArray || []);
          const _argsArray = Array.from(opList.argsArray || []);

          console.error(`[DIAG Page ${pageNum}] total ops:`, _fnArray.length);
          let constructPathCount = 0;

          const DEBUG_DUMP_CONTENT = false;
          if (DEBUG_DUMP_CONTENT) {
            let content = opList.fnArray
              .map(item => Object.keys(pdfjs.OPS).find(key => pdfjs.OPS[key] == item))
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

            //debugging: Object.keys(pdfjs.OPS).find(item=>pdfjs.OPS[item] == opList.fnArray[33])
            //opList.fnArray.map(item=>Object.keys(pdfjs.OPS).find(key=>pdfjs.OPS[key] == item))
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

                  if (constructPathCount === 1) {
                    console.error(`[DIAG Page ${pageNum}] pdfjs6 format detected`);
                    console.error(`[DIAG Page ${pageNum}] paintType:`, paintType);
                    console.error(`[DIAG Page ${pageNum}] pathOps (first 10):`, pathOps.slice(0, 10));
                    console.error(`[DIAG Page ${pageNum}] pathCoords (first 8):`, pathCoords.slice(0, 8));
                    console.error(`[DIAG Page ${pageNum}] bboxArr:`, bboxArr);
                  }

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

                  if (constructPathCount === 1) {
                    console.error(`[DIAG Page ${pageNum}] normArgs[0]:`, normArgs[0]);
                    console.error(`[DIAG Page ${pageNum}] segments count:`, segments.length);
                    console.error(`[DIAG Page ${pageNum}] pathData length:`, pathData.length);
                    console.error(`[DIAG Page ${pageNum}] pathData (first 20):`, pathData.slice(0, 20));
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
                    } else if (newOp === 2) {// curveTo — skip (6 coordinates), the old loop can't
                      idx += 6;
                    } else if (newOp === 3) {// quadraticCurveTo — skip (4 coordinates)
                      idx += 4;
                    } else if (newOp === 4) {// closePath
                      pathOps.push(OPS.closePath);
                    }
                  }

                  // Restoring rectangle from bbox (args[2])
                  bboxArr = extractArrayLike(normArgs[2]);
                  if (constructPathCount === 1) {
                    console.error(`[DIAG Page ${pageNum}] bboxArr:`, bboxArr);
                  }
                  if (isNewFormat && paintType != null && paintType !== OPS.endPath) {
                    const isFillOnlyPaint = paintType === OPS.fill || paintType === OPS.eoFill;
                    if (isFillOnlyPaint) {
                      // Фон ячеек часто рисуется одним fill-путём из десятков подпрямоугольников;
                      // каждый — геометрия отдельной ячейки (в т.ч. объединённых rowspan/colspan).
                      const extracted = extractClosedSubpathRectangles(pathOps, pathCoords);
                      pathOps = extracted.ops;
                      pathCoords = extracted.coords;
                    }
                  }

                  // minMax (bbox) — метаданные пути, а не нарисованная геометрия.
                  // Добавляем только если сам путь не дал ни одного сегмента
                  // (например, путь состоял только из пропускаемых кривых).
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

              if (constructPathCount === 1) {
                console.error(`[DIAG Page ${pageNum}] constructPath #1 pathOps:`, pathOps);
                console.error(`[DIAG Page ${pageNum}] constructPath #1 pathCoords (first 8):`, pathCoords.slice(0, 8));
              }

              let coordIdx = 0;
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
                  // CTM с отражением по Y (типичный «перевёрнутый» cm) даёт отрицательные
                  // width/height — приводим к каноническому bbox, иначе containment-проверки
                  // ниже по конвейеру молча отбрасывают такие прямоугольники.
                  rwidth = Math.abs(x2 - rx);
                  rheight = Math.abs(y2 - ry);
                  rx = Math.min(rx, x2);
                  ry = Math.min(ry, y2);
                  let vector = { y: ry, x: rx, width: rwidth, height: rheight, transform: transformMatrix };

                  // We skip the full‑size background rectangles/page cropping
                  let isFullPageRect = Math.abs(rwidth - pageWidth) < 1
                    && Math.abs(rheight - pageHeight) < 1
                    && Math.abs(rx) < 1
                    && Math.abs(ry) < 1;
                  if (isFullPageRect) {
                    current['vectorCache'] = vector;
                    current['vectorType'] = 'rectangle';
                    continue; // do not add to rectangles / edges
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
                  current['y'] = my;
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

                    if (!isPageBoundary) {//&& !isPaintlessPath BUG sales_order.pdf 
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
                  coordIdx += 6; // skip the 6 coordinates of the Bezier curve
                } else if (op === OPS.curveTo2 || op === OPS.curveTo3) {
                  if (coordIdx + 3 >= pathCoords.length) break;
                  coordIdx += 4; // skipping 4 coordinates
                } else if (op === OPS.closePath) {
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
              });

              current['vectorType'] = null;
              current['vectorCache'] = null;
            } else if (fn === OPS.restore) {
              const savedState = transformStack.pop();

              if (savedState) {
                transformMatrix = [...savedState.transformMatrix];

                current.fillRGBColor = [
                  ...(savedState.fillRGBColor || [])
                ];

                current.strokeRGBColor = [
                  ...(savedState.strokeRGBColor || [])
                ];

                current.fillAlpha = savedState.fillAlpha;
                current.strokeAlpha = savedState.strokeAlpha;
                current.lineWidth = savedState.lineWidth;
                current.colorType = savedState.colorType;
              }

              current['vectorType'] = null;
              current['vectorCache'] = null;
            } else if (fn === OPS.transform) {
              var normTransformArgs = normalizeNumericArgs(args);
              transformMatrix = transformFn(transformMatrix, normTransformArgs);
            } else if (fn === OPS.setTextMatrix) {
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
              /**
                 * Determines if the area between two points is filled using the evenodd rule.
                 *
                 * @param {Object} edgeStart - The starting point of the edge.
                 * @param {Object} edgeEnd - The end point of the edge.
                 * @param {Array} allEdges - All edges to verify crossings.
                 * @returns {boolean} - True if the area is filled.
                 */
              function isEdgeFilledEvenOdd(edgeStart, edgeEnd, allEdges) {
                // Check if the start and end points match
                if (edgeStart.x === edgeEnd.x && edgeStart.y === edgeEnd.y) {
                  // If it is a closed path, treat it as a filled area
                  return true;
                }

                let intersections = 0;

                // Check intersections with other edges
                allEdges.forEach(edge => {
                  if (edge !== edgeStart && edge !== edgeEnd && doEdgesIntersect(edge, edgeStart, edgeEnd)) {
                    intersections++;
                  }
                });

                // Evenodd rule: if the number of intersections is odd, the area is flooded
                return intersections % 2 === 1;
              }

              /**
               * Checks the intersection of two segments.
               *
               * @param {Object} edge - Edge for verification.
               * @param {Object} edgeStart - The starting point of the current edge.
               * @param {Object} edgeEnd - The end point of the current edge.
               * @returns {boolean} - True if the segments intersect.
               */
              function doEdgesIntersect(edge, edgeStart, edgeEnd) {
                // Determine the coordinates of the segments
                const x1 = edgeStart.x;
                const y1 = edgeStart.y;
                const x2 = edgeEnd.x;
                const y2 = edgeEnd.y;
                const x3 = edge.x;
                const y3 = edge.y;
                const x4 = edge.x + edge.width;
                const y4 = edge.y + edge.height;

                // We use the axial intersection test
                const o1 = orientation(x1, y1, x2, y2, x3, y3);
                const o2 = orientation(x1, y1, x2, y2, x4, y4);
                const o3 = orientation(x3, y3, x4, y4, x1, y1);
                const o4 = orientation(x3, y3, x4, y4, x2, y2);

                // Crossing check
                if (o1 !== o2 && o3 !== o4) {
                  return true;
                }

                return false;
              }

              /**
               * Defines the orientation of the three points (rotation direction).
               *
               * @param {number} x1 - The x coordinate of the first point.
               * @param {number} y1 - The y coordinate of the first point.
               * @param {number} x2 - The x coordinate of the second point.
               * @param {number} y2 - The y coordinate of the second point.
               * @param {number} x3 - The x coordinate of the third point.
               * @param {number} y3 - The y coordinate of the third point.
               * @returns {number} - 0: collinear, 1: clockwise, 2: counterclockwise.
               */
              function orientation(x1, y1, x2, y2, x3, y3) {
                const val = (y2 - y1) * (x3 - x2) - (x2 - x1) * (y3 - y2);
                if (val === 0) return 0; // collinear
                return (val > 0) ? 1 : 2; // clockwise or counterclockwise
              }

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
              let [fontName, fontSize] = normalizeFontArgs(args);
              let contentItem = { height: fontSize, transform: [...[fontSize, 0, 0, fontSize], ...transformMatrix.slice(4)], fontName: fontName };
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
              var normLeadArgs = normalizeNumericArgs(args);
              textMatrix = [...textMatrix.slice(0, 4), ...normLeadArgs];
            } else if (fn === OPS.moveText) {//BUG:|| pdfjs.OPS.setLeadingMoveText == fn
              var normMoveArgs = normalizeNumericArgs(args);
              let textMatrixChanged = textMatrix.toString() != _defaultTransformMatrix.toString();
              if (textMatrixChanged) {//BUGFIX?
                textMatrix = [...textMatrix.slice(0, 4), ...applyTransformFn(normMoveArgs, textMatrix)];
              }
              let contentItem = current.contentItem;
              Object.assign(contentItem, { transform: [...contentItem.transform.slice(0, 4), ...(textMatrixChanged ? [textMatrix[4], textMatrix[5]] : normMoveArgs)] });
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

              function getTextContentItemId(textContentItem) {
                return textContentItem ? [textContentItem.transform[5], textContentItem.transform[4]].join('-') : null;
              }

              function trimCoordinate(item) {
                if (!item || item.imageName || !item.chars?.length) return item;
                return trimTableContentItem(item, true, true);
              }

              function trimTableContentItem(item, clearStart = true, clearEnd = true) {
                item = JSON.parse(JSON.stringify(item));
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
              let finalTransform = (textMatrix.slice(-2).toString() == preliminaryItem.transform.slice(-2).toString())
                ? preliminaryItem.transform
                : transformFn(textMatrix, preliminaryItem.transform);

              // pdfjs 6.x sometimes reports fontSize=1 while the real scale lives in textMatrix
              let matrixScaleY = Math.abs(finalTransform[3]);
              let fontSizeIsNotSet = (fontSize <= 1 && matrixScaleY > 1.5) || (matrixScaleY > fontSize * 1.5);
              let effectiveHeight = !fontSizeIsNotSet ? fontSize : (matrixScaleY || fontSize);

              if (fontSizeIsNotSet) {
                _widthAdvanceScale = effectiveHeight * _fontIdentityMatrix[0];
                current.contentItem.height = effectiveHeight;
                current.contentItem.transform[0] = effectiveHeight;
                current.contentItem.transform[3] = effectiveHeight;
              }

              Object.assign(preliminaryItem, {
                transform: finalTransform,
                height: effectiveHeight
              });

              let normalizedShowText = normalizeShowTextArgs(args);
              let { widthRanges, str, charsRangesArrays, fontSpaceWidths } = handleCharsArgs({
                charsArr: JSON.parse(JSON.stringify(normalizedShowText)),//JSON.parse(JSON.stringify(args[0])), //clearChars({chars:args[0], fullClear:false, clearStart:true, clearEnd:false}),
                x: preliminaryItem.transform[4],
                y: preliminaryItem.transform[5],
                setCoordinates: true,
                setCharWidth: true,
                fontSize: effectiveHeight,
              });
              fontSpaceWidths = Object.assign(current.fontSpaceWidths, fontSpaceWidths);

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

              let relatedTextContentItems = getRelatedTextContentItems({
                x: preliminaryItem.transform[4],
                y: preliminaryItem.transform[5],
                height: preliminaryItem.height,
                width: preliminaryItem.width
              }).filter(item => {
                if (!item) return false;

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
                  (itemLeft <= prelimRight && itemRight >= prelimLeft); // пересечение

                let sameY = Math.abs(item.transform[5] - preliminaryItem.transform[5]) < preliminaryItem.height * 1.5;

                let hasMainStrOverlap = parseStr(str1).some(i => preliminaryItem.str.includes(i)) || parseStr(preliminaryItem.str).some(i => str1.includes(i));

                return xAdjacent && sameY && hasMainStrOverlap;
              });
              relatedTextContentItems = relatedTextContentItems.length ? relatedTextContentItems : [undefined];

              // ============================================================
              // FUNCTIONS OF SEGMENTATION preliminaryItem BASED ON GLYPH GEOMETRY
              // ============================================================
              function segmentPreliminaryItem(item: any): any[] {
                if (!item?.chars?.length) return [item];
                const glyphs = item.chars.filter((ch: any) =>
                  ch && typeof ch === 'object' && typeof ch.unicode === 'string' && ch.x !== undefined
                );
                if (glyphs.length <= 1) return [item];
                const threshold = Math.max(item.height * 0.6, 2);
                const segments: any[] = [];
                let currentGlyphs: any[] = [glyphs[0]];
                let currentStartX = glyphs[0].x;
                let lastEndX = glyphs[0].x + (glyphs[0].charWidth || item.height * 0.5);

                for (let i = 1; i < glyphs.length; i++) {
                  const g = glyphs[i];
                  const gap = g.x - lastEndX;
                  if (gap > threshold) {
                    segments.push(buildSegment(item, currentGlyphs, currentStartX));
                    currentGlyphs = [g];
                    currentStartX = g.x;
                  } else {
                    currentGlyphs.push(g);
                  }
                  lastEndX = g.x + (g.charWidth || item.height * 0.5);
                }
                if (currentGlyphs.length) {
                  segments.push(buildSegment(item, currentGlyphs, currentStartX));
                }
                return segments.length > 0 ? segments : [item];
              }

              function buildSegment(baseItem: any, glyphs: any[], startX: number): any {
                const endX = glyphs[glyphs.length - 1].x + (glyphs[glyphs.length - 1].charWidth || 0);
                const width = Math.max(0, endX - startX);
                const str = glyphs.map((g: any) => g.unicode).join('');
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
                    startX,
                    baseItem.transform[5]
                  ]
                };
              }

              function isSegmentContainedByRelatedItem(
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

              function findExactRelatedTextContentItem(
                segment: any,
                relatedItems: any[]
              ): any {
                if (
                  !segment?.str?.trim() ||
                  !relatedItems?.length ||
                  relatedItems.length <= 1
                ) {
                  return undefined;
                }

                const items = relatedItems
                  .filter(item => item?.transform)
                  .slice()
                  .sort((a, b) => {
                    const yDifference =
                      b.transform[5] - a.transform[5];

                    if (Math.abs(yDifference) > 0.5) {
                      return yDifference;
                    }

                    return (
                      a.transform[4] -
                      b.transform[4]
                    );
                  });

                if (items.length <= 1) {
                  return undefined;
                }

                const normalizeForExactMatch = (value: any) =>
                  normalizeCJKText(String(value || ''))
                    .replace(/\s+/g, '')
                    .trim();

                const segmentText =
                  normalizeForExactMatch(segment.str);

                const relatedText =
                  normalizeForExactMatch(
                    items
                      .map(item => item.str || '')
                      .join('')
                  );

                /*
                 * Главный критерий:
                 *
                 * preliminaryItem и ВСЯ группа PDF.js items
                 * должны содержать один и тот же текст.
                 *
                 * Пробелы игнорируем, потому что PDF.js может
                 * разбить "Cases of loose" на совершенно разные
                 * textContent items с геометрическими промежутками.
                 */
                if (
                  !segmentText ||
                  segmentText !== relatedText
                ) {
                  return undefined;
                }

                /*
                 * Проверяем, что все related items действительно
                 * находятся в пределах preliminaryItem.
                 */
                const segmentX1 =
                  segment.transform[4];

                const segmentX2 =
                  segmentX1 +
                  segment.width;

                const segmentY1 =
                  segment.transform[5];

                const segmentY2 =
                  segmentY1 +
                  segment.height;

                const minX = Math.min(
                  ...items.map(item => item.transform[4])
                );

                const maxX = Math.max(
                  ...items.map(
                    item =>
                      item.transform[4] +
                      item.width
                  )
                );

                const minY = Math.min(
                  ...items.map(item => item.transform[5])
                );

                const maxY = Math.max(
                  ...items.map(
                    item =>
                      item.transform[5] +
                      item.height
                  )
                );

                const geometryTolerance =
                  Math.max(
                    segment.height * 0.75,
                    2
                  );

                if (
                  minX < segmentX1 - geometryTolerance ||
                  maxX > segmentX2 + geometryTolerance ||
                  minY < segmentY1 - geometryTolerance ||
                  maxY > segmentY2 + geometryTolerance
                ) {
                  return undefined;
                }

                /*
                 * Все items должны находиться на том же baseline
                 * либо образовывать реальный многострочный preliminaryItem.
                 */
                const segmentTop = Math.min(
                  segmentY1,
                  segmentY2
                );

                const segmentBottom = Math.max(
                  segmentY1,
                  segmentY2
                );

                const allInsideSegment =
                  items.every(item => {
                    const itemTop = Math.min(
                      item.transform[5],
                      item.transform[5] + item.height
                    );

                    const itemBottom = Math.max(
                      item.transform[5],
                      item.transform[5] + item.height
                    );

                    return (
                      itemBottom >=
                      segmentTop -
                      geometryTolerance &&
                      itemTop <=
                      segmentBottom +
                      geometryTolerance
                    );
                  });

                if (!allInsideSegment) {
                  return undefined;
                }

                const firstItem = items[0];
                const lastItem =
                  items[items.length - 1];

                /*
                 * Создаём synthetic related item,
                 * представляющий ВСЮ группу PDF.js items.
                 *
                 * chars здесь специально не объединяем:
                 * при exact match downstream-код не должен
                 * заходить в range-clipping ветку.
                 */
                return {
                  ...firstItem,

                  str: segment.str?.trim() || segment.str,

                  width: maxX - minX,

                  height: Math.max(
                    maxY - minY,
                    segment.height
                  ),

                  transform: [
                    firstItem.transform[0],
                    firstItem.transform[1],
                    firstItem.transform[2],
                    firstItem.transform[3],
                    minX,
                    minY,
                  ],

                  fontName:
                    segment.fontName ||
                    firstItem.fontName,

                  hasEOL:
                    lastItem?.hasEOL || false,

                  hasEOT:
                    lastItem?.hasEOT || false,

                  isSyntheticRelatedTextContentItem:
                    true,
                };
              }

              function findRelatedTextContentSpan(
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
                 * Сначала ищем точное соответствие:
                 *
                 * segment
                 *     ==
                 * concatenated related items
                 *
                 * Именно этот случай имеет место у:
                 *
                 * Cases / of loose / motion / and /
                 * vomiting reported / from / Village
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
                     * Не смешиваем разные строки.
                     *
                     * Для одной строки baseline должен быть
                     * практически одинаковым.
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
                     * Дальше уже точно больше segment,
                     * поэтому продолжать бессмысленно.
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

              function findBestRelatedTextContentItem(segment: any, relatedItems: any[]): any {
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

                  // Пересечение по X и Y
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

              function getMergedCoordinatePaddingObj(lastItem, newItem, gridItemsType) {
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

              function getCoordinateFromObj(obj) {
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

              function intersectsEdges(options) {
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

                  newItem = currentCacheItems.reduce((prev, cur) => {
                    let newPrev;
                    // We take the actual scale from the transform element (fallback to fontSize).
                    let curEffectiveHeight = Math.abs(cur.transform[3]) || fontSize;

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

                    let chars = [
                      ...(prev?.['chars'] || []),
                      ...charsRangesArrays[1],
                      ...(recoverRange2 ? charsRangesArrays[2] : [])
                    ];

                    let handledValues = handleCharsArgs({
                      charsArr: chars,
                      fontSize: curEffectiveHeight
                    });

                    console.error('[MERGE RANGE DEBUG]', {
                      related: relatedTextContentItem?.str,
                      cur: cur.str,
                      useRelatedRange,
                      curX: cur.transform[4],
                      curRight:
                        cur.transform[4] + cur.width,
                      relatedX:
                        relatedTextContentItem?.transform?.[4],
                      relatedRight:
                        relatedTextContentItem
                          ? relatedTextContentItem.transform[4] +
                          relatedTextContentItem.width
                          : undefined,
                      beforeClear:
                        handledValues.charsRangesArrays[1]
                          ?.map(g => g?.unicode || '')
                          .join(''),
                    });

                    chars = clearChars({
                      chars: handledValues.charsRangesArrays[1],
                      fullClear: false,
                      clearStart: true
                    });

                    console.error('[MERGE CLEAR DEBUG]', {
                      afterClear:
                        chars
                          ?.map(g => g?.unicode || '')
                          .join(''),
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

                    let prevTransform = prev?.str ? prev.transform : _defaultTransformMatrix;

                    newPrev = handledValues.charsRangesArrays.flat().length ? {
                      str: handledValues?.str,
                      chars: handledValues.charsRangesArrays.flat(),
                      fontName: fontName,
                      textColor: prev?.textColor || cur?.textColor || null,
                      height: Math.max(Math.abs(prevTransform[3]) || curEffectiveHeight, Math.abs(cur.transform[3]) || curEffectiveHeight), //old:cur.transform[3] BUG in (three_tables_2.pdf): old fontSize,
                      dir: ['rtl', 'ltr'][fontDirection] || getTextDirection(handledValues.str),
                      width: Number.isFinite(actualRight) &&
                        Number.isFinite(actualLeft)
                        ? actualRight - actualLeft
                        : Math.max(...handledValues.widthRanges),
                      transform: [
                        Math.max(prevTransform[0], cur.transform[0]),
                        Math.max(prevTransform[1], cur.transform[1]),
                        Math.max(prevTransform[2], cur.transform[2]),
                        Math.max(prevTransform[3], cur.transform[3]),
                        handledValues.charsRangesArrays.flat()[0]?.x || Math.min(prevTransform[4], cur.transform[4]),
                        Math.max(prevTransform[5], cur.transform[5]),
                      ],
                    } : null;
                    // } else {
                    //     newPrev = cur;
                    // }
                    return newPrev;
                  }, null);
                } else {
                  newItem = segment;
                }

                if (newItem) {
                  newItem['altStr'] = relatedTextContentItem?.str;
                }

                if (newItem && (reachedEnd || !relatedTextContentItem)) {
                  tableContentItems.push(newItem);
                  if (tableContentItemsCache?.[relatedTextContentId]) {
                    delete tableContentItemsCache[relatedTextContentId];
                  }
                }

                newItemIndex = tableContentItems.length - 1;
                lastItemIndex = newItemIndex - 1;
                lastItem = tableContentItems?.[lastItemIndex] || {};

                if ((relatedTextContentItem && !similarToRelated && !reachedEnd) || !newItem) {
                  if (newItem) {
                    //removeByIndexes(tableContentItems, [newItemIndex]);
                    tableContentItemsCache[relatedTextContentId] = [...(tableContentItemsCache[relatedTextContentId] || []), newItem];
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
                    let topEdges = filterBlocks(visibleEdges, {
                      'x': [newItem.transform[4], newItem.transform[4] + newItem.width],
                      'y': [newItem.y, Infinity],
                      strict: false,
                      withoutOverlap: false,
                      strictIntersecting: true
                    });

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
                        let paddingObj = getMergedCoordinatePaddingObj(key == 'cols' ? currentCoordinate.lastCoordinateEdge : lastItem, newItem, key);

                        let jumps = lastItem?.transform ? (
                          ((lastItem.transform[5] < newItem.transform[5]) && (key == 'cols')) ||
                          ((lastItem.transform[4] < newItem.transform[4]) && (key == 'rows'))
                        ) : false;

                        let returnOriginalValue = (key == 'cols' ? intersectingGridItemsObj[key].length > 2 : intersectingGridItemsObj[key].length > 3); //the table has enough edges (if rows then 3 (+header bottom line))

                        return returnOriginalValue ? lastItem['hasEOT'] : jumps ? true : getResults(paddingObj, key); //BUG?
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
                          let xGap = Math.max(0, Math.max(a.transform[4], b.transform[4]) - Math.min(a.transform[4] + a.width, b.transform[4] + b.width));
                          let xGapMaxSympolsLength = 1.5;
                          let xGapMaxWidth = Math.max(maxWidth, lineMaxWidth) * xGapMaxSympolsLength;
                          return xGap <= xGapMaxWidth
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
                            let paddingObj = getMergedCoordinatePaddingObj(lastItemCopy, newItemCopy, gridItem);
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
                    updateChars({
                      item: newItem,
                      lineBreakNeeded,
                      spaceNeeded: spaceNeeded(newItem, lastItem),
                      fontSpaceWidth: fontSpaceWidths[fontName]
                    });
                  }
                  current['pathConstructed'] = false;
                }

              }
              //index++; //BUG no synchronization with pageTextContent.items
              // СБРОС ТОЛЬКО ПОСЛЕ ВСЕХ СЕГМЕНТОВ
              //current['pathConstructed'] = false;
            }
          }

          console.log(`[DIAG T]`, tableContentItems);
          console.error(`[DIAG Page ${pageNum}] constructPath hits:`, constructPathCount);
          console.error(`[DIAG Page ${pageNum}] edges after loop:`, edges.length, 'rectangles:', rectangles.length);

          function getSymbolsBetween(
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

          function updateChars(options) {
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

          function removeLineBreak(lastItem) {
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

          function clearChars(options) {
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

          function isEmptyCoordinate(item) {
            return !(clearChars({ chars: item.chars, fullClear: true })?.length || item?.imageName)
          }

          function clearEmptyCoordinateItems(array) {
            array = Array.isArray(array) ? array : [array];
            return array.filter(item => {
              return !isEmptyCoordinate(item);
            })
          }

          function compositeCellColors(colorStrings) {
            let layers = colorStrings
              .map(c => parseRGB(c))
              .filter(c => c && c.length >= 3)
              .map(c => ({ r: c.r, g: c.g, b: c.b, a: c.a !== undefined ? c.a : 1 }));

            if (!layers.length) return null;
            if (layers.length === 1) {
              let l = layers[0];
              return l.a >= 0.999 ? `rgb(${l.r},${l.g},${l.b})` : `rgba(${l.r},${l.g},${l.b},${l.a})`;
            }

            let r = layers[0].r, g = layers[0].g, b = layers[0].b, a = layers[0].a;
            for (let i = 1; i < layers.length; i++) {
              let l = layers[i];
              let outA = l.a + a * (1 - l.a);
              if (outA > 0.001) {
                r = (l.r * l.a + r * a * (1 - l.a)) / outA;
                g = (l.g * l.a + g * a * (1 - l.a)) / outA;
                b = (l.b * l.a + b * a * (1 - l.a)) / outA;
              }
              a = outA;
            }

            r = Math.round(Math.max(0, Math.min(255, r)));
            g = Math.round(Math.max(0, Math.min(255, g)));
            b = Math.round(Math.max(0, Math.min(255, b)));
            a = Math.min(1, Math.max(0, a));

            if (a >= 0.999) return `rgb(${r},${g},${b})`;
            return `rgba(${r},${g},${b},${parseFloat(a.toFixed(3))})`;
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

                if (hasEOT || index == 0) {
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

                  let height = Math.max(lastItem.y + lastItemHeight, y + itemHeight) - Math.min(lastItem.y, y);
                  let width = lastItem.y == y ? (((x + itemWidth) < (lastItem.x + lastItemWidth)) ? lastItemWidth : ((x + itemWidth) - lastItem.x)) : Math.max(itemWidth, lastItemWidth);

                  // hasEOL относится к lastItem — если перенос был нужен, но ещё не
                  // попал в его str/chars (bывает, когда hasEOL проставляется
                  // постфактум, уже после того как для фрагмента отработал updateChars),
                  // достраиваем перенос прямо здесь, перед склейкой
                  let lastStr = lastItem?.str || '';
                  let needsSyntheticLineBreak = hasEOL && !lastStr.endsWith('\n');
                  if (needsSyntheticLineBreak) { lastStr += '\n'; }
                  let str = [lastStr, item?.str || ''].join('');
                  let syntheticBreakChar = needsSyntheticLineBreak ? [{
                    originalCharCode: 10, fontChar: "\n", unicode: "\n", accent: null,
                    width: 0, isSpace: false, isInFont: true, isLineBreak: true,
                  }] : [];
                  let chars = [...(lastItem.chars || []), ...syntheticBreakChar, ...(item.chars || [])];
                  x = Math.min(lastItem.x, x);

                  Object.assign(lastItem, {
                    str: str,
                    x: x,
                    y: y,
                    width: width,
                    height: height,
                    chars: chars,
                    textColor: lastItem.textColor || item.textColor || null,
                    transform: [height, 0, 0, height, x, y]
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

          function filterBlocks(blocks, options) {
            const { x, y, withoutOverlap, strict, filterFn, strictIntersecting, tolerance } = options;
            let blocksCopy = JSON.parse(JSON.stringify(blocks || '[]'));
            let intersectsNextGridItem = false;
            let filteredBlocks = blocksCopy.filter((block, index, arr) => {
              const xInRange: any = checkRectangleRanges(block, { x, y }, { axis: 'x', strict, strictIntersecting, tolerance });
              const yInRange: any = checkRectangleRanges(block, { x, y }, { axis: 'y', strict, strictIntersecting, tolerance });
              block.contained = [xInRange, yInRange].every((item: any) => item.isContained && (item.biggestArgument == 1 || item.biggestArgument == null));
              return xInRange?.inRange && yInRange?.inRange && (filterFn ? filterFn(block, index, arr) : true);
            });

            if (withoutOverlap && (x || y)) {
              // Check overlap in x-axis or y-axis
              const axis = x ? 'y' : 'x';
              for (let i = 0; i < filteredBlocks.length; i++) {
                for (let j = i + 1; j < filteredBlocks.length; j++) {
                  if (
                    (checkRectangleRanges(filteredBlocks[i], filteredBlocks[j], { axis, strictIntersecting: true }) as any).inRange &&
                    (filteredBlocks[i].index != filteredBlocks[j].index)
                  ) {
                    intersectsNextGridItem = true;
                  }
                }
              }
            }

            Object.defineProperty(filteredBlocks, 'intersectsNextGridItem', {
              value: intersectsNextGridItem,
              enumerable: false,
              configurable: true,
              writable: true
            });

            return filteredBlocks;
          }

          function countProperties(arr) {
            const result = {};

            arr.forEach(obj => {
              for (const key in obj) {
                if (obj.hasOwnProperty(key)) {
                  if (!result[key]) {
                    result[key] = {};
                  }
                  const value = obj[key];
                  if (!result[key][value]) {
                    result[key][value] = 0;
                  }
                  result[key][value]++;
                }
              }
            });

            return result;
          }

          function isSameFont(a, b) {
            return typeof a?.fontName == 'string' &&
              typeof b?.fontName == 'string' &&
              a?.fontName === b?.fontName;
          }


          function isCaptionBlock(options) {
            let { block, edges, coordinates, lineMaxWidth } = options;

            if (!block || !edges?.length || !coordinates?.length) return false;

            // Vertical table separators
            let verticalEdges = edges.filter(e =>
              isVisibleVector(e) && e.width < lineMaxWidth && e.height > lineMaxWidth
            );

            if (!verticalEdges.length) return false;

            // Table boundaries along the Y axis
            let tableYMin = Math.min(...coordinates.map(c => c.y));
            let tableYMax = Math.max(...coordinates.map(c => c.y + c.height));

            // If a block has a horizontal border at the top or bottom, it’s a cell, not a caption
            let horizontalEdges = edges.filter(e =>
              isVisibleVector(e) && e.height < lineMaxWidth && e.width > lineMaxWidth
            );

            let blockHasHorizontalBorder = horizontalEdges.some(e => {
              let yMatchTop = Math.abs(e.y - block.y) < lineMaxWidth * 2;
              let yMatchBottom = Math.abs(e.y - (block.y + block.height)) < lineMaxWidth * 2;
              let xOverlap = !(e.x + e.width < block.x || e.x > block.x + block.width);
              return (yMatchTop || yMatchBottom) && xOverlap;
            });

            // If the block is bounded by horizontal lines, it is part of the table (merged header), not a caption.
            if (blockHasHorizontalBorder) return false;


            // Lines intersecting the interior of the block along X and the table along Y
            let dividersInBlock = filterBlocks(verticalEdges, {
              x: [block.x + 1, block.x + block.width - 1],
              y: [tableYMin, tableYMax],
              strictIntersecting: true
            });

            let uniqueY = [...new Set(dividersInBlock.map(item => item.y))];

            return uniqueY.length >= 2;
          }

          function determineHeaderRows(options) {
            let { coordinates, rows, edges, rectangles, lineMaxWidth, customConditionFn } = options;

            function isHeaderIndicator(str) {
              str = str?.trim() || '';

              let headerIndicatorWords: { [key: string]: Array<string> } = {
                eng: ['name', 'surname', 'last name', 'first name', 'full name', 'user name', 'age', 'gender', 'sex', 'relationship', 'nationality', 'status', 'time', 'timeframe', 'period', 'duration', 'dilution', 'viscosity', 'resistance', 'density', 'destination', 'term', 'deadline', 'release', 'released', 'receive', 'received', 'effective', 'date', 'dates', 'start date', 'end date', 'birth day', 'date of birth', 'dob', 'description', 'title', 'label', 'subject', 'interest', 'experience', 'note', 'notes', 'comment', 'comments', 'header', 'column', 'col', 'area', 'country', 'city', 'town', 'zip', 'zip code', 'postal code', 'location', 'region', 'address', 'address line', 'street address', 'mail', 'e-mail', 'email', 'email address', 'phone', 'phone number', 'mobile', 'tel', 'telephone', 'contact', 'contacts', 'site', 'website', 'web', 'url', 'uri', 'path', 'parent', 'parents', 'operation', 'source', 'education', 'position', 'occupation', 'role', 'team', 'designation', 'department', 'volume', 'sold', 'unsold', 'average', 'span', 'currency', 'cost', 'price', 'unit price', 'price per unit', 'offer', 'order', 'budget', 'total', 'sub total', 'total price', 'discount', 'donation', 'quality', 'quantity', 'amount', 'salary', 'revenue', 'color', 'colour', 'speed', 'distance', 'valuation', 'value', 'size', 'width', 'height', 'length', 'weight', 'depth', 'population', 'range', 'queue', 'index', 'id', '#', '№', 'no', 'number', 'hash', 'year', 'month', 'day', 'height', 'weight', 'length', 'model', 'category', 'ticker', 'employee', 'artist', 'author', 'director', 'owner', 'genre', 'commodity', 'product', 'item', 'freight', 'feature', 'plan', 'task', 'issue', 'group', 'company', 'sector', 'division', 'district', 'customer', 'vendor', 'brand', 'salesman', 'assignee', 'requester', 'contributor', 'office', 'rate', 'balance', 'rating', 'rank', 'fee', 'score', 'grade', 'type', 'class', 'count', 'runs', 'progress', 'points', 'coins', 'expenses', 'priority', 'trend', 'engagement', 'percentage', 'profit', 'locale', 'language', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sun', 'mon', 'tues', 'wed', 'thur', 'fri', 'sat', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'],
                zho: ['稀釋倍數'],
              };
              let headerIndicatorWordsArray = Object.keys(headerIndicatorWords).reduce((prev, cur) => {
                return [...prev, ...headerIndicatorWords[cur]];
              }, []);

              let getParsedStrArray = (str) => str.split(/(?=\p{Lu})|-| |_|\./gum).filter(item => item && !/^[^\p{L}\d]$/ui.test(item)).map(item => item.toLowerCase());
              //regular expression that finds strings containing the keyword, but only if there is a single word before or after it, or if the keyword stands alone.
              let getHeaderTextRegExp = (keyWord) => new RegExp(`^(?:(?<![\\p{L}\\p{N}_])(?:(?:\\p{L}|\\p{N})+\\s+)?(?:${getParsedStrArray(keyWord).join(' ')})(?:\\s+(?:\\p{L}|\\p{N})+)?(?![\\p{L}\\p{N}_]))$`, 'ui');
              return headerIndicatorWordsArray.some(item => (
                caseIndependentCompare(item, str) ||
                getHeaderTextRegExp(item).test(getParsedStrArray(str).join(' '))
              ));
            }

            let allPropertiesCounter = countProperties(coordinates?.filter(item => item?.str) || []);

            let targetPropertiesWeight = {
              'fillColor': 1,
              'strokeColor': 1,
              'fontName': 1,
              'height': 0.9
            };

            let targetProperties = Object.keys(targetPropertiesWeight).filter(prop => Object.keys(allPropertiesCounter?.[prop] || {})?.length > 1);
            let modeProperties = targetProperties.reduce((prev, cur) => {
              let keys = Object.keys(allPropertiesCounter[cur]);
              let values = Object.values(allPropertiesCounter[cur]) as Array<any>;
              prev[cur] = keys.find(item => allPropertiesCounter[cur][item] == Math.max(...values));
              return prev;
            }, {});

            let headersCombo: Array<any> = [];
            let defaultHeaderRows = {};

            let setDefaultHeaderRows = (headersCombo) => {
              for (let index = 0; index < headersCombo.length; index++) {
                const item = headersCombo[index];
                if (index == 0) {
                  defaultHeaderRows[item.rangeStr] = item.textBlocks;
                } else {
                  //The number of text items in the current row is greater than the number of items in the previous row (merged headers indicator)
                  if (headersCombo[index - 1] && item?.textBlocks?.length > headersCombo?.[index - 1]?.textBlocks?.length) {
                    defaultHeaderRows[item.rangeStr] = item.textBlocks;
                  } else {
                    break;
                  }
                }
              }
            };

            let headerRows = rows.sort((a, b) => b - a).reduce((prev, item, index, arr) => {
              let nextItem = arr[index + 1];
              if (nextItem) {
                let range = [item, nextItem];
                let rangeStr = range.join('-');

                let medianBorderWidth = 0;
                // Vertical table separators
                let verticalEdges = edges.filter(e => {
                  let res = isVisibleVector(e) && e.width < lineMaxWidth && e.height > lineMaxWidth;
                  if (res) {
                    medianBorderWidth = Math.max(e.width, medianBorderWidth);
                  }
                  return res;
                });

                let textBlocks = filterBlocks(coordinates.filter(item => item?.str), {
                  'y': range.map((r, i) => {
                    return i == 0 ? r - (medianBorderWidth * 2) : r + (medianBorderWidth * 2)
                  }), strictIntersecting: true
                });

                // GUARD: single-block line at the edge of the table = caption?
                if (textBlocks.length === 1 && edges?.length) {
                  let isFirstOrLastRow = (index === 0) || (index >= arr.length - 2);
                  if (!isFirstOrLastRow) return prev;

                  let tb = textBlocks[0];

                  if (isCaptionBlock({
                    block: tb,
                    edges,
                    coordinates,
                    lineMaxWidth
                  })) {
                    return prev;
                  }
                }
                // --- END GUARD ---

                let currentHeaderCombo = headersCombo[headersCombo.length - 1];
                let lastTruthHeaderCombo = headersCombo?.findLast(item => item.isHeader == true);
                let hasDuplicateCopies = currentHeaderCombo ? textBlocks.some(item => currentHeaderCombo.textBlocks.map(item => JSON.stringify(item)).includes(JSON.stringify(item))) : false; //contains duplicate header values
                if (
                  textBlocks?.length &&
                  (//The number of text items in the current row is greater than the number of items in the previous row (merged headings indicator)
                    currentHeaderCombo != undefined &&
                      lastTruthHeaderCombo &&
                      (currentHeaderCombo == lastTruthHeaderCombo) ?
                      (currentHeaderCombo.textBlocks.length < textBlocks.length || hasDuplicateCopies)
                      : true
                  )
                ) {
                  let propertiesCounter = countProperties(textBlocks);
                  let currentTargetProperties = targetProperties.filter(prop => Object.keys(propertiesCounter?.[prop] || {})?.length > 1);
                  let headerConditions = [];

                  textBlocks?.forEach(textBlock => {

                    let bottomElements = filterBlocks([
                      ...(coordinates || [])?.map(item => Object.assign({}, item, { vectorType: 'coordinate' })),
                      ...(edges || [])?.map(item => Object.assign({}, item, { vectorType: 'edge' })),
                      ...(rectangles || [])?.map(item => Object.assign({}, item, { vectorType: 'rectangle' })),
                    ], { 'x': [textBlock.x, textBlock.x + textBlock.width], 'y': [textBlock.y, 0], strictIntersecting: true })
                      ?.filter(item => item.vectorType == 'coordinate' ? true : isVisibleVector(item))//old:item.strokeColor || item.fillColor
                      ?.sort(function (a, b) { return (b.y - a.y) }) || [];

                    if (customConditionFn) {
                      let customCondition = customConditionFn({
                        textBlock, item, nextItem
                      });
                      headerConditions.push(customCondition);
                    }

                    let hasUniformStr = Object.values(propertiesCounter?.['str'] || {})
                      .reduce((prev, cur) => Number(prev) + Number(cur), 0) === textBlocks?.length;

                    let hasDistinctStyle = true;
                    if (targetProperties.length) {
                      let styleChecks = targetProperties.map(prop => {
                        let propExceptions = ['height'];
                        if (propExceptions.includes(prop)) return true;
                        return textBlock?.[prop] !== modeProperties[prop];
                      });
                      hasDistinctStyle = styleChecks.length > 2
                        ? findMod(styleChecks) === 'true'
                        : styleChecks.some(item => item);
                    }

                    let hasMajorityStyle = true;
                    if (currentTargetProperties.length) {
                      hasMajorityStyle = currentTargetProperties.every(prop => {
                        let weight = 1 - targetPropertiesWeight[prop];
                        let total = Number(Object.values(propertiesCounter?.[prop] || {})
                          .reduce((p, c) => Number(p) + Number(c), 0) || 0);
                        let count = Number(propertiesCounter?.[prop]?.[textBlock?.[prop]] || 0);
                        return count > (total * (weight || 1));//the number of cells with target properties exceeds the number of cells with other properties
                      });
                    }

                    let hasBottomBorder = true;
                    if (edges || rectangles) {
                      hasBottomBorder = [bottomElements[0], bottomElements[1]]
                        .some(item => ['rectangle', 'edge'].includes(item?.vectorType));
                    }

                    let isIndicator = isHeaderIndicator(textBlock?.['str']);//cell value corresponds to a word in the indicator

                    let condition = (hasMajorityStyle && hasDistinctStyle && hasUniformStr && hasBottomBorder) || isIndicator;

                    headerConditions.push(condition);
                  });

                  let isHeader = headerConditions.every(item => item);

                  if (isHeader) {
                    prev[rangeStr] = textBlocks;
                    if (headersCombo.length) {
                      headersCombo.forEach(item => {
                        prev[item.rangeStr] = item.textBlocks;
                        item.isHeader = true;
                      });
                    }
                    headersCombo.push({ rangeStr, textBlocks, isHeader });
                  }
                  //old:headersCombo.push({ rangeStr, textBlocks, isHeader });//BUG 06-sales-order
                } else {
                  if (!textBlocks?.length) {
                    setDefaultHeaderRows(headersCombo);
                    headersCombo = [];
                  }
                }
              }

              if (index == arr.length) {
                setDefaultHeaderRows(headersCombo);
              }

              return prev;
            }, {});

            return headerRows;
          }

          function trimUnsupportedTrailingRows(group, lineMaxWidth) {
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
              return { edgesInRange, usedCols, textBlocks };
            }

            // проверяем от конца группы к началу: строка считается
            // "неподкреплённой", если рядом с ней вообще нет реальных edges,
            // либо использован узкий срез колонок (< 60% от полного набора) —
            // это ровно сигнатура твоих двух PDF (пустые edges слева / только
            // правые колонки)
            let cutIndex = -1;
            for (let i = 0; i < sortedRows.length - 1; i++) {
              let { edgesInRange, usedCols, textBlocks } = analyzeRange(sortedRows[i], sortedRows[i + 1]);
              if (!textBlocks.length) continue;
              let unsupported = edgesInRange.length === 0 || (usedCols.size > 0 && usedCols.size < fullColsCount * 0.6);
              if (!unsupported) { cutIndex = -1; continue; }
              if (cutIndex === -1) cutIndex = i;
            }
            // cutIndex теперь указывает на ПЕРВУЮ строку самого длинного
            // неподкреплённого хвоста, если он тянется до конца группы
            if (cutIndex === -1) return group;
            let tailIsUnbroken = true;
            for (let j = cutIndex; j < sortedRows.length - 1; j++) {
              let { edgesInRange, usedCols, textBlocks } = analyzeRange(sortedRows[j], sortedRows[j + 1]);
              if (!textBlocks.length) continue;
              let unsupported = edgesInRange.length === 0 || (usedCols.size > 0 && usedCols.size < fullColsCount * 0.6);
              if (!unsupported) { tailIsUnbroken = false; break; }
            }
            if (!tailIsUnbroken || cutIndex < 2) return group; // не режем, если это не хвост или почти вся таблица

            let cutoffY = sortedRows[cutIndex];
            group.rows = group.rows.filter(y => y >= cutoffY);
            group.coordinates = (group.coordinates || []).filter(c => c.y >= cutoffY - 1);
            group.edges = (group.edges || []).filter(e => e.y >= cutoffY - 1);
            group.rectangles = (group.rectangles || []).filter(r => r.y >= cutoffY - 1);
            group.headerRows = determineHeaderRows({
              coordinates: group.coordinates || [], edges: group.edges || [],
              rectangles: group.rectangles || [], rows: group.rows || [], lineMaxWidth,
            });
            return group;
          }

          function extendGroupTopBorder(group, pageGroup, lineMaxWidth) {
            if (!pageGroup || !group.rows?.length || !group.cols?.length) return group;

            let currentTop = Math.max(...group.rows);
            let groupXMin = Math.min(...group.cols);
            let groupXMax = Math.max(...group.cols);
            let groupWidth = groupXMax - groupXMin;
            let borderSize = group.borderSize || 0.57;
            let edgeTolerance = Math.max(1, borderSize * 3);

            // окно поиска привязано к СОБСТВЕННОМУ шагу строки именно этой
            // таблицы, а не к произвольной константе и не к странице целиком
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

            // структурное доказательство: у САМОЙ этой таблицы (по её
            // собственным крайним X — левой/правой колонке) должно физически
            // что-то быть рядом с кандидатной Y. Случайная чужая линия дальше
            // на странице почти никогда не совпадёт по X с границами именно
            // этой таблицы.
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
            // под линией нет вообще никакого текста ЭТОЙ таблицы — вероятно,
            // это не её граница, отказываемся расширять
            if (!newCoordinates.length) return group;

            group.rows = [...new Set([...group.rows, bestY])].sort((a, b) => a - b);
            group.edgesRows = [...new Set([...(group.edgesRows || []), bestY])].sort((a, b) => a - b);
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
                group[sectionName] = [...new Set([...(group?.[sectionName] || []), ...data])]?.sort((a, b) => a - b) || [];
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
                group[type] = getUnique([...(group[type] || []), item], axis);
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
                    let data = getUnique([...(mergedGroup[type] || []), ...(groups[j][type] || [])], axis);
                    if (data.length) {
                      mergedGroup[type] = data;
                    }
                  });

                  ['rows', 'cols', 'edgesRows', 'edgesCols', 'rectanglesRows', 'rectanglesCols'].forEach(sectionName => {
                    setGridItemsTo(mergedGroup, sectionName, groups[j][sectionName]);
                    let data = [...new Set([...(mergedGroup[type] || []), ...(groups[j][type] || [])])];
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

          function calculateEdgeToleranceValue(edges, lineMaxWidth) {
            let horizontalEdges = (edges || []).filter(e =>
              isVisibleVector(e) && e.height < lineMaxWidth && e.width > lineMaxWidth
            );
            if (horizontalEdges.length < 2) return null;

            let ys = uniqueArr(horizontalEdges.map(e => e.y)).sort((a, b) => a - b);
            let gaps = ys.slice(1).map((y, i) => y - ys[i]).filter(g => g > 0);
            if (!gaps.length) return null;

            return +findMod(gaps) || findAverage(gaps);
          }

          function calculateToleranceValue(coordinates) {
            //Find the modulus of text height
            let modeTextHeight = findMod(coordinates.map(item => item.height));

            //Create an object with y-coordinates grouping
            let obj = coordinates.reduce((prev, cur) => {
              prev[cur.y] = [...(prev[cur.y] || []), cur.y + cur.height];
              return prev;
            }, {});

            //Sort object keys
            let sortedKeys = Object.keys(obj).sort((a: any, b: any) => a - b);

            //Create a data array by alternating keys and values
            let data = sortedKeys.reduce((prev, key: any, index) => {
              let value = +findMod(obj[key]);
              key = +key;

              if (index % 2) {
                prev.push(key);
              } else {
                prev.push(value);
              }
              return prev;
            }, [])
              .sort((a, b) => a - b);//Sort an array of data

            //Calculate distances between elements of a data array and filter them out
            let distances = data.slice(1).reduce((prev, cur, index) => {
              let distance = cur - data[index];
              if (distance < modeTextHeight * 2 && distance > modeTextHeight / 2) {
                prev.push(distance);
              }
              return prev;
            }, []);

            //Calculate the average of the distances and divide by 2
            let averageDistance = (findAverage(distances) + (+findMod(distances))) / 2;//old: findAverage(distances)/2 

            return averageDistance;
          }

          // Function for defining cell boundaries
          function getGroups() {
            let tolerance = calculateToleranceValue(coordinates);

            let pageGroups = createGroup({ edges, rectangles, coordinates, tolerance: Infinity });
            let tableGroups = createGroup({ edges, rectangles, coordinates, tolerance });

            console.error('rows from createGroup (до extendGroupTopBorder, которого больше нет):', tableGroups.map(g => g.rows))

            tableGroups = splitGroups({ groups: tableGroups, globalGroup: pageGroups[0], downcheck: true });

            tableGroups = tableGroups.map(group => extendGroupTopBorder(group, pageGroups[0], lineMaxWidth));
            tableGroups = tableGroups.map(group => trimUnsupportedTrailingRows(group, lineMaxWidth));

            // порядок таблиц в результате должен соответствовать порядку
            // чтения (сверху вниз на странице), а не порядку, в котором их
            // случайно построила кластеризация
            tableGroups = [...tableGroups].sort((a, b) => {
              let aTop = a.rows?.length ? Math.max(...a.rows) : (a.y ? a.y[1] : 0);
              let bTop = b.rows?.length ? Math.max(...b.rows) : (b.y ? b.y[1] : 0);
              return bTop - aTop;
            });

            tableGroups.forEach(group => {
              group.assuredCols = group.cols;
              group.assuredRows = group.rows;
            });

            function splitGroups(options) {
              let { groups, globalGroup, downcheck } = options;
              return groups.reduce((prev, group, index, arr) => {
                const prevGroupsLength = prev.length;

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
                           * Если мы не можем определить обе границы,
                           * никаких выводов не делаем.
                           *
                           * Это важно: отсутствие edge != доказательство
                           * того, что таблица закончилась.
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
                            group.rows = [...new Set([...group.rows.slice(0, group.rows.indexOf(row) + 1), nextRow])].sort((a, b) => a - b) || [];
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


                  let textBlocksLength = textBlocks.length;
                  let edgesLength = edges.length;

                  let splitRowsCondition = (() => {
                    let minRowsLength = 3;
                    return (groupRows.length - 1 > minRowsLength) ? (textBlocksLength <= 1) : !textBlocksLength;
                  })();

                  /*
         * ---------------------------------------------------------
         * Forced split по изменению внешних вертикальных границ.
         *
         * ВАЖНО:
         * firstRow нельзя выбрасывать из предыдущего range.
         *
         * Поэтому, если firstRow является split-point,
         * сначала начинается новый range с этой строки.
         *
         * Благодаря этому boundary row присутствует
         * и как нижняя граница предыдущей таблицы,
         * и как верхняя граница следующей.
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
                rowsRanges = rowsRanges.reduce((prev, range) => {
                  if (range.length > 2) {
                    prev.push(range);
                  } else {
                    //prev.push(null);
                  }
                  return prev;
                }, []);

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

                // --- Safety net для nested-rectangles --------------------------------
                // После исключения вложенных same-fill rects из сетки валидная таблица
                // может распасться на фрагменты «только header» + «только body», и все
                // они проваливают header-фильтр выше. Если эта группа не породила ни
                // одного валидного саб-таблицы, но сама валидна (есть headerRows и
                // non-header контент) и содержит excluded nested rects — сохраняем
                // исходную группу вместо потери таблицы.
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
                      console.error(`[DIAG] splitGroups: fragments failed header filter, keeping original group (y=${group.y})`);
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

                let alias = group['alias'] = {};
                group['rows'] = mergeCoordinates([...(group['rows'] || []), ...(group['assuredRows'] || [])].sort((a, b) => a - b), group['assuredRows'], { averageMerge: true, threshold: lineMaxWidth });
                let handledRows = getHandledGridItems({
                  gridItems: group['rows'] || [],
                  gridItemsType: 'rows',
                  coordinates: group['coordinates'] || [],
                  assuredGridItems: group['assuredRows'] || []
                });
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
                // --- КОНЕЦ ---

                let headerRows = group['headerRows'] = determineHeaderRows({
                  coordinates: group['coordinates'] || [],
                  edges: group['edges'] || [],
                  rectangles: group['rectangles'] || [],
                  rows: group['rows'] || [],
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

            function getHandledGridItems(options) {
              let {
                gridItems,
                gridItemsType,
                coordinates,
                filterFn,
                assuredGridItems,
              } = options;
              //Removing duplicates and sorting coordinates
              gridItems = [...new Set(JSON.parse(JSON.stringify(gridItems)))].sort((a: any, b: any) => a - b);

              let gridItemsPairs = {};
              let alias = {};
              let paddingBorders = [];
              let paddingSizes = [];
              let paddingSize = 0;
              let modeTextHeight = findMod(coordinates.map(item => item.height));
              let coordinatePaddings = coordinates.reduce((prev, cur) => {
                let secondLine = cur[gridItemsType === 'cols' ? 'x' : 'y'];
                let firstLine = gridItems?.[findClosestIndex(gridItems, secondLine, modeTextHeight * 2)];
                let diffTolerance = 0;
                if (firstLine) {
                  let diff = Math.abs(firstLine - secondLine);
                  if (diff > diffTolerance) {
                    prev.push(diff);
                  }
                }
                return prev;
              }, []);

              function findPropertyWithMaxScore(obj) {
                let maxScore = -Infinity;
                let resultProperty = null;

                for (let key in obj) {
                  if (obj.hasOwnProperty(key)) {
                    let [plusPoints, minusPoints] = obj[key];
                    plusPoints = Array.isArray(plusPoints) ? plusPoints.length : plusPoints;
                    minusPoints = Array.isArray(minusPoints) ? minusPoints.length : minusPoints;
                    let totalScore = plusPoints - minusPoints;

                    if (totalScore > maxScore) {
                      maxScore = totalScore;
                      resultProperty = key;
                    }
                  }
                }

                return resultProperty;
              }



              //Basic cycle for processing coordinate pairs
              for (let firstBorderIndex = 0; firstBorderIndex < gridItems.length; firstBorderIndex++) {
                for (let secondBorderIndex = firstBorderIndex + 1; secondBorderIndex < gridItems.length; secondBorderIndex++) {
                  const firstBorder = gridItems[firstBorderIndex];
                  const secondBorder = gridItems[secondBorderIndex];

                  //Skipping incorrect pairs
                  if (!(firstBorder && secondBorder) || (firstBorder === secondBorder)) {
                    break;
                  }

                  //Filtering text blocks within a specified range
                  // if null, the current boundaries intersect two text blocks on the same axis
                  let textBlocks = filterBlocks(coordinates || [], {
                    [gridItemsType === 'cols' ? 'x' : 'y']: [firstBorder, secondBorder],
                    withoutOverlap: true,
                    filterFn,
                    strictIntersecting: true
                  })
                  //?.filter(item => ![firstBorder, secondBorder].includes(item[gridItemsType === 'cols' ? 'x' : 'y'])); //BUGFIX;

                  let intersectsNextGridItem = textBlocks.intersectsNextGridItem;//intersection of two text blocks on the same axis

                  let isLastBorder = (secondBorder === gridItems[gridItems.length - 1]);
                  let isAssuredBorder = assuredGridItems.includes(secondBorder);
                  let gridItemsPairsKeys = sortArrayOfObjects(
                    Object.keys(gridItemsPairs),
                    [{ isNumber: true, order: 'asc' }]
                  );
                  let gridItemRangeEnded = (assuredGridItems.length > 2 ? isAssuredBorder : intersectsNextGridItem) && textBlocks.some(item => item.contained);

                  function updateCycle(secondBorder) {
                    //for optimization, we skip checking the boundaries that go before the current coordinate pair
                    let foundSecondBorderIndex = gridItems.indexOf(secondBorder);
                    foundSecondBorderIndex = foundSecondBorderIndex == -1 ? secondBorderIndex : foundSecondBorderIndex;
                    firstBorderIndex = secondBorderIndex = foundSecondBorderIndex;
                  }

                  function addGridItemsPairs(firstBorder, secondBorder, textBlocks) {
                    gridItemsPairs[firstBorder] = gridItemsPairs[firstBorder] || {};
                    let keys = Object.keys(gridItemsPairs[firstBorder]);
                    let dividedTextBlocks = subdivideTextBlocks(textBlocks, filterFn);
                    let previousTextBlocks = keys[keys.length - 1] ? filterBlocks(coordinates || [], {
                      [gridItemsType === 'cols' ? 'x' : 'y']: [keys[keys.length - 1], secondBorder],
                      withoutOverlap: true,
                      filterFn,
                      strictIntersecting: true
                    }) : textBlocks;

                    let textBlocksIndexes = textBlocks.map((item) => item.index).sort((a, b) => a - b);
                    let dividedTextBlocksIndexes = dividedTextBlocks.flat().sort((a, b) => a - b);
                    let previousTextBlocksIndexes = previousTextBlocks.map((item) => item.index).sort((a, b) => a - b);

                    //let isLastBorder = (secondBorder === gridItems[gridItems.length - 1]);
                    //let isAssuredBorder = assuredGridItems.includes(secondBorder);
                    //let gridItemRangeEnded = (assuredGridItems.length > 2 ? isAssuredBorder : intersectsNextGridItem) && textBlocks.some(item => item.contained);


                    let hasDuplicateCopies = previousTextBlocks.some(item => textBlocks.map(item => JSON.stringify(item)).includes(JSON.stringify(item)));
                    let isLastIterationPadding = (
                      (textBlocksIndexes.toString() == dividedTextBlocksIndexes.toString()) &&//the number of text blocks in the range has not changed since the previous iteration
                      !previousTextBlocksIndexes.length //the grown range segment does not contain text blocks
                    );

                    if (
                      isLastIterationPadding ||
                      (isLastBorder || gridItemRangeEnded)
                    ) {
                      let newSecondBorder;
                      //if(isLastBorder || gridItemRangeEnded){
                      if (isLastIterationPadding || hasDuplicateCopies) {
                        newSecondBorder = +findPropertyWithMaxScore(gridItemsPairs[firstBorder]) || secondBorder;
                      } else {
                        newSecondBorder = secondBorder;
                      }
                      //}

                      gridItemsPairs[firstBorder] = newSecondBorder;
                      updateCycle(newSecondBorder);
                    } else {
                      //Updating coordinate pair with the number of text blocks
                      gridItemsPairs[firstBorder][secondBorder] = gridItemsPairs[firstBorder][secondBorder] || dividedTextBlocks;
                    }
                  }

                  if (textBlocks?.length || gridItemRangeEnded) {
                    if (paddingBorders.includes(firstBorder)) {//process the last padding boundary
                      paddingBorders = paddingBorders.sort((a, b) => a - b);
                      //Calculate distances between paddingBorders
                      let distances = paddingBorders.reduce((prev, cur, index) => {
                        let distance = index == 0 ? 0 : cur - paddingBorders[index - 1];
                        prev.push(distance);
                        return prev;
                      }, []);

                      //Calculate the average of the distances
                      let averageDistance = distances.reduce((prev, cur) => prev + cur, 0) / distances.filter(item => item > 0).length;
                      let maxDistance = (modeTextHeight * 2);

                      if (averageDistance > maxDistance) {//Spaces are too large, boundaries need to be locked in
                        let distancesIndexes = distances.map((item, index) => index);
                        let firstSplitIndex = distances.findIndex(item => item > maxDistance);
                        let secondSplitIndex = distances.findLastIndex(item => item > maxDistance);

                        let firstIndexes = splitByIndex(distancesIndexes, firstSplitIndex == -1 ? 0 : firstSplitIndex, { exclude: true })[0];
                        let secondIndexes = splitByIndex(distancesIndexes, secondSplitIndex == -1 ? distances.length - 1 : secondSplitIndex, { exclude: true })[1];

                        let firstIndex = firstIndexes[1] || firstIndexes[0] || ((firstSplitIndex == 0) || (firstSplitIndex == -1) ? 0 : firstSplitIndex - 1);
                        let secondIndex = secondIndexes[secondIndexes.length - 2] || secondIndexes[secondIndexes.length - 1] || ((secondSplitIndex == paddingBorders.length - 1) || (secondSplitIndex == - 1) ? paddingBorders.length - 1 : secondSplitIndex + 1);

                        let newFirstBorder = paddingBorders[firstIndex]
                        let newSecondBorder = paddingBorders[secondIndex];

                        if (distances[firstIndex + 1] > maxDistance) {
                          let aliasValue = newFirstBorder + paddingSize;
                          updateAlias([newFirstBorder], alias, aliasValue);
                        }

                        if ((distances[secondIndex] > maxDistance) && newFirstBorder != newSecondBorder) {
                          let aliasValue = newSecondBorder - paddingSize;
                          updateAlias([newSecondBorder], alias, aliasValue);
                        }

                        gridItemsPairs[newFirstBorder] = newSecondBorder;
                        updateCycle(newSecondBorder);
                      } else {
                        let aliasValue = calculateAliasValue(paddingBorders, assuredGridItems);
                        //let newSecondBorder = paddingBorders[paddingBorders.length - 1];
                        //gridItemsPairs[firstBorder] = newSecondBorder;
                        updateAlias(paddingBorders, alias, aliasValue);
                      }
                      paddingBorders = [];
                    } else {
                      if (
                        [firstBorder, secondBorder].every(item => { //all boundaries are guaranteed
                          return assuredGridItems.includes(item);
                        })
                      ) {
                        //calculate the alias
                        //if ((gridItemsPairsKeys.length > 1 ? +gridItemsPairs[gridItemsPairsKeys[gridItemsPairsKeys.indexOf(firstBorder + '') - 1]] <= +firstBorder : false)) {
                        if (gridItemsPairsKeys.length > 0) {
                          let keys = Object.keys(gridItemsPairs[firstBorder] || {});
                          if (!isLastBorder && keys.length && !isAssuredBorder) {
                            updateAlias([secondBorder], alias, (+keys[keys.length - 1] + secondBorder) / 2);
                            paddingSizes.push(Number(secondBorder) - Number(keys[keys.length - 1]));
                            paddingSize = getPaddingSize();
                          }
                        }

                        gridItemsPairs[firstBorder] = secondBorder;
                        updateCycle(secondBorder);

                      } else {
                        if (assuredGridItems.includes(secondBorder)) {
                          gridItemsPairs[firstBorder] = secondBorder;
                          updateCycle(secondBorder);
                        } else {
                          addGridItemsPairs(firstBorder, secondBorder, textBlocks);
                        }
                      }
                    }
                  } else {
                    addPaddingBorders(paddingBorders, firstBorder, secondBorder);
                    paddingSizes.push(secondBorder - firstBorder);
                    paddingSize = getPaddingSize();
                  }
                }
              }

              //Updating gridItems based on coordinate and alias pairs
              let gridItemsPairsKeys = sortArrayOfObjects(
                Object.keys(gridItemsPairs),
                [{ isNumber: true, order: 'asc' }]
              );
              gridItems = gridItemsPairsKeys.reduce((prev, cur) => {
                let key = +cur;
                let value = +gridItemsPairs[key];
                if (!prev.includes(value)) {
                  if (!prev.includes(key)) prev.push(key);
                  prev.push(value);
                }
                return prev;
              }, []);

              function getPaddingSize() {
                let paddingMode = +findMod([...paddingSizes, ...coordinatePaddings]);
                let paddingSize = findAverage([...paddingSizes, ...coordinatePaddings].filter(item => item <= paddingMode));
                return paddingSize;
              }

              paddingSize = getPaddingSize();
              gridItems = updateGridItems(gridItems, alias, assuredGridItems, paddingSize || null).sort((a: any, b: any) => a - b);

              return {
                gridItems,
                alias,
                paddingSize,
              };
            }

            //Function for calculating the value of alias
            function calculateAliasValue(paddingBorders, assuredGridItems) {
              const length = paddingBorders.length;
              let assuredArr = paddingBorders.filter(item => assuredGridItems.includes(item));
              if (assuredArr.length > 0) {
                if (assuredArr.length === 1) {
                  return assuredArr[0];
                } else {
                  paddingBorders = assuredArr;
                }
              }

              if (length % 2 === 0) {
                //If the number of elements is even, return the arithmetic mean
                const sum = paddingBorders.reduce((acc, val) => acc + val, 0);
                return sum / length;
              } else {
                //If the number of elements is odd, return the middle element
                const middleIndex = Math.floor(length / 2);
                return paddingBorders[middleIndex];
              }
            }

            //Function for updating alias
            function updateAlias(paddingBorders, alias, aliasValue) {
              paddingBorders.forEach(item => {
                if (!alias[item] && aliasValue && (item != aliasValue)) {
                  alias[item] = aliasValue;
                }
              });
            }

            //Function for adding paddingBorders
            function addPaddingBorders(paddingBorders, firstBorder, secondBorder) {
              [firstBorder, secondBorder].forEach(item => {
                if (!paddingBorders.includes(item)) {
                  paddingBorders.push(item);
                }
              });
            }

            //Function for calculating the number of text blocks
            function subdivideTextBlocks(textBlocks, filterFn) {
              let contained = [];
              let doesNotContained = []
              for (let index = 0; index < textBlocks.length; index++) {
                const textBlock = textBlocks[index];
                if (textBlock.contained && (filterFn ? filterFn(textBlock, index, textBlocks) : true)) {
                  contained.push(textBlock.index);
                } else {
                  doesNotContained.push(textBlock.index);
                }
              }

              return [contained, doesNotContained];
            }

            //Function for updating gridItems
            function updateGridItems(gridItems, alias, assuredGridItems, defaultGap) {
              let aliasKeys = Object.keys(alias).map(item => +item);
              let distanceDifference = aliasKeys.map(item => item - alias[item]);
              let mode = +findMod(distanceDifference);
              defaultGap = aliasKeys.length ? defaultGap ? Math.min(defaultGap, findAverage(aliasKeys)) : findAverage(aliasKeys) : defaultGap || 1;

              gridItems = gridItems.map((item, index, arr) => {
                let currentAlias = alias[item];
                let value;
                let isAssuredBorder = assuredGridItems.includes(item);
                if (currentAlias) {
                  value = currentAlias;
                } else {
                  if (!isAssuredBorder) {
                    if (item === arr[0]) {
                      value = mode ? item - mode : item - defaultGap;
                      alias[item] = value;
                    } else if (item === arr[arr.length - 1]) {
                      value = mode ? item + mode : item + defaultGap;
                      alias[item] = value;
                    } else {
                      value = item;
                    }
                  } else {
                    value = item;
                  }
                }
                return value;
              });

              return [...new Set(gridItems)];
            }

            return { tableGroups, pageGroups };
          }

          //Function for combining close coordinates
          function mergeCoordinates(coordinates, fixedCoordinates, options) {
            const { threshold = 2.5, averageMerge = false, specialMode = false, preferLarger = false } = options;

            if (!coordinates || coordinates?.length === 0) return [];

            const mergedCoordinates = [];
            let i = 0;

            while (i < coordinates.length) {
              let currentCoordinate = coordinates[i];
              let isFixed = fixedCoordinates.includes(currentCoordinate);
              let tempCoords = [currentCoordinate];

              let j = i + 1;
              while (j < coordinates.length && Math.abs(coordinates[j] - currentCoordinate) < threshold) {
                if (fixedCoordinates.includes(coordinates[j])) {
                  tempCoords.push(coordinates[j]);
                  break;
                }
                if (specialMode && !isFixed && !fixedCoordinates.includes(coordinates[j])) {
                  j++;
                  continue;
                }
                tempCoords.push(coordinates[j]);
                j++;
              }

              if (tempCoords.length > 1) {
                if (tempCoords.some(coord => fixedCoordinates.includes(coord))) {
                  //If there is a fixed coordinate, it has priority
                  mergedCoordinates.push(...tempCoords.filter(coord => fixedCoordinates.includes(coord)));
                } else {
                  if (averageMerge) {
                    const average = tempCoords.reduce((sum, coord) => sum + coord, 0) / tempCoords.length;
                    mergedCoordinates.push(average);
                  } else {
                    const maxCoordinate = Math.max(...tempCoords);
                    const minCoordinate = Math.min(...tempCoords);
                    mergedCoordinates.push(preferLarger ? maxCoordinate : minCoordinate);
                  }
                }
              } else {
                mergedCoordinates.push(currentCoordinate);
              }

              i = j;
            }

            return uniqueArr(mergedCoordinates);
          }

          function getAverageBorderSize(edges, lineMaxWidth) {
            let defaultBorderSize = 0.57;
            let widths = [];

            for (let index = 0; index < edges.length; index++) {
              let item = edges[index];
              if (item.height < lineMaxWidth) {
                widths.push(item.height);
              }
              if (item.width < lineMaxWidth) {
                widths.push(item.width);
              }
            }

            return +findMod(widths) || defaultBorderSize;
          }

          //Function for generating virtual edges
          function generateVirtualEdges(options) {
            let {
              cols,
              rows,
              coordinates,
              assuredEdges,
              lineMaxWidth,
              paddingSize,
              headerRows
            } = options;
            cols = [...cols].sort((a, b) => a - b);
            rows = [...rows].sort((a, b) => a - b);
            let verticalAssuredEdges = [];
            let horizontalAssuredEdges = [];
            let headerRowsKeys = uniqueArr(Object.keys(headerRows).map(item => item.split('-').map(i => +i)).flat());
            assuredEdges = assuredEdges.filter(edge => {
              let isVisible = hasVectorColor(edge);
              if (isVisible) {
                if ((edge.height < lineMaxWidth) && (edge.width > lineMaxWidth)) {
                  //if (!headerRowsKeys.includes(edge.y)) {//!BUG table.pdf
                  horizontalAssuredEdges.push(edge);
                  //}
                } else if ((edge.width < lineMaxWidth) && (edge.height > lineMaxWidth)) {
                  verticalAssuredEdges.push(edge);
                }
              }
              return isVisible;
            });

            let borderSize = getAverageBorderSize(assuredEdges, lineMaxWidth);
            let deletedEdges = [];

            /**
             * Удаляет фантомные крайние строки сетки — строки за пределами реальных
             * границ таблицы (линий/прямоугольников), появившиеся из-за «висящего»
             * текста рядом с таблицей (сноски, легенды, подписи).
             *
             * Такой текст полностью отделён от ближайшей реальной границы зазором,
             * тогда как текст настоящих ячеек примыкает к границам своей строки.
             * Трогаем только таблицы с видимыми горизонтальными линиями: в таблицах
             * без линий (borderless) крайние строки формируются исключительно
             * координатами и всегда легитимны.
             */
            function removePhantomBoundaryRows(gridRows) {
              if (!gridRows.length || !horizontalAssuredEdges.length) {
                return gridRows;
              }
              const realYs = [...new Set(horizontalAssuredEdges.map(edge => edge.y))].sort((a, b) => a - b);
              const edgeTolerance = Math.max(lineMaxWidth, borderSize * 2, 1);
              // Текст настоящей ячейки может слегка заступать на линию границы,
              // но не «плавает» в отрыве от неё. Зазор больше — призмер отрывного блока.
              const detachTolerance = Math.max(borderSize, 0.5);

              function hasContent(coordinate) {
                return coordinate && (coordinate.str?.trim() || coordinate.imageName);
              }

              function getBox(coordinate) {
                return {
                  top: Math.min(coordinate.y, coordinate.y + coordinate.height),
                  bottom: Math.max(coordinate.y, coordinate.y + coordinate.height),
                };
              }

              function isPhantomRow(rowY, inwardDir) {
                // Крайняя строка фантомна только если за таблицей нет реальной линии
                const hasRealEdge = horizontalAssuredEdges.some(
                  edge => Math.abs(edge.y - rowY) <= edgeTolerance
                );
                if (hasRealEdge) {
                  return false;
                }
                // Ближайшая реальная граница внутрь таблицы
                const inwardRealYs = realYs.filter(y => inwardDir > 0 ? y > rowY : y < rowY);
                if (!inwardRealYs.length) {
                  return false;
                }
                const nearestRealY = inwardDir > 0 ? Math.min(...inwardRealYs) : Math.max(...inwardRealYs);
                const content = (coordinates || []).filter(hasContent);
                // Контент не должен торчать за пределы крайней строки сетки
                const hasOutsideContent = content.some(coordinate => {
                  const box = getBox(coordinate);
                  return inwardDir > 0 ? box.top < rowY : box.bottom > rowY;
                });
                if (hasOutsideContent) {
                  return false;
                }
                // Вся полоса между фантомной строкой и реальной границей должна
                // состоять только из текста, отделённого от реальной границы зазором
                const bandCoordinates = content.filter(coordinate => {
                  const box = getBox(coordinate);
                  return inwardDir > 0
                    ? (box.bottom > rowY && box.top < nearestRealY)
                    : (box.top < rowY && box.bottom > nearestRealY);
                });
                return bandCoordinates.every(coordinate => {
                  const box = getBox(coordinate);
                  const gap = inwardDir > 0 ? nearestRealY - box.bottom : box.top - nearestRealY;
                  return gap > detachTolerance;
                });
              }

              if (gridRows.length < 2) {
                return gridRows;
              }
              const firstRowY = gridRows[0];
              const lastRowY = gridRows[gridRows.length - 1];
              const filtered = gridRows.filter(rowY => {
                if (rowY === firstRowY && isPhantomRow(rowY, +1)) {
                  return false;
                }
                if (rowY === lastRowY && isPhantomRow(rowY, -1)) {
                  return false;
                }
                return true;
              });
              // Не даём вырождать сетку меньше двух строк
              return filtered.length >= 2 ? filtered : gridRows;
            }

            rows = removePhantomBoundaryRows(rows);

            // внутри generateVirtualEdges — сразу после removePhantomBoundaryRows(rows)
            // intersectingElements зависит ТОЛЬКО от textBlock, а не от позиции в сетке.
            // Считаем один раз на координату вместо пересчёта в каждой ячейке сетки.
            let verticalIntersectorsByCoordinate = coordinates.map((textBlock) => {
              return verticalAssuredEdges?.filter((vector) => {
                let res: any = checkRectangleRanges(vector, { y: [textBlock.y, textBlock.y + textBlock.height] }, { axis: 'y', strict: true, strictIntersecting: true });
                return res.isContained || !res.biggestArgument && res.isIntersecting;
              }) || [];
            });
            let horizontalIntersectorsByCoordinate = coordinates.map((textBlock) => {
              return horizontalAssuredEdges?.filter((vector) => {
                let res: any = checkRectangleRanges(vector, { x: [textBlock.x, textBlock.x + textBlock.width] }, { axis: 'x', strict: true, strictIntersecting: true });
                return res.isContained || !res.biggestArgument && res.isIntersecting;
              }) || [];
            });

            let isIntersecting = (rect1, rect2) => {
              return (checkRectangleRanges(rect1, rect2, { axis: ['x', 'y'], strictIntersecting: true }) as Array<any>).every(item => item.isIntersecting);
            }

            let headerCoordinatesIndexes = Object.values(headerRows).flat().map((item: any) => item.index);
            let isHeader = (textBlock) => {
              return headerCoordinatesIndexes.includes(textBlock.index);
            };

            function getGridIndex(grid, coordinate) {
              for (let i = 0; i < grid.length - 1; i++) {
                if (coordinate >= grid[i] && coordinate < grid[i + 1]) {
                  return i;
                }
              }
              return -1;
            }

            function getRelatedAssuredEdge(edge, assuredEdges) {
              let res;
              let toleranceList = [-(borderSize / 2)];

              for (let index = 0; index < toleranceList.length; index++) {
                const tolerance = toleranceList[index];
                res = assuredEdges.find(vector => {
                  let res = (checkRectangleRanges(
                    vector,
                    { x: [edge.x, edge.x + edge.width], y: [edge.y, edge.y + edge.height] },
                    { axis: ['x', 'y'], strict: true, strictIntersecting: true, tolerance }
                  ) as Array<any>).every(res => {
                    return res.isContained || (!res.biggestArgument && res.isIntersecting);
                  });
                  return res;
                });
                if (res) {
                  break;
                }
              }
              let positionTolerance = 0.005;
              if (!res) {
                res = assuredEdges.find(item => {
                  return (getOnePercentOfAbsoluteDifference(edge.x, item.x) <= positionTolerance) &&
                    (getOnePercentOfAbsoluteDifference(edge.y, item.y) <= positionTolerance);
                });
              }

              return res;
            }

            let verticalEdges = [];
            for (let i = 0; i < cols.length; i++) {
              for (let j = 0; j < rows.length - 1; j++) {
                let x = cols[i];
                let nextY = rows[j + 1];
                let y = rows[j];
                let edge = {
                  x: x,
                  y: y,
                  width: borderSize,
                  height: nextY - y
                };

                let isIntersectingTextBlock = false;
                // let foundAssuredEdges = sortArrayOfObjects(
                //     verticalAssuredEdges?.filter(item=>isIntersecting(item, edge)),
                //     { field: ['y', 'height'], order: 'asc' }
                // );
                // let foundAssuredEdge = foundAssuredEdges?.[0] || null;
                // //adjust the values of the found edge
                // if(foundAssuredEdge){
                //     let rowIndex = findClosestIndex(rows, foundAssuredEdge.y + foundAssuredEdge.height);
                //     let height = rows[rowIndex] - y;
                //     Object.assign(foundAssuredEdge, {x, y, height, used:true});
                // }
                for (let k = 0; k < coordinates.length; k++) {
                  let textBlock = coordinates[k];
                  let intersectingElements = verticalIntersectorsByCoordinate[k];
                  // let intersectingElements = verticalAssuredEdges?.filter(vector => {
                  //   let res: any = checkRectangleRanges(vector, { y: [textBlock.y, textBlock.y + textBlock.height] }, { axis: 'y', strict: true, strictIntersecting: true });
                  //   return res.isContained || !res.biggestArgument && res.isIntersecting;
                  // }) || [];
                  let relatedAssuredEdge = getRelatedAssuredEdge(edge, verticalAssuredEdges);
                  if (relatedAssuredEdge) {
                    if (!edge['strokeColor']) {
                      edge['strokeColor'] = relatedAssuredEdge.strokeColor || relatedAssuredEdge.fillColor;
                      edge['_isFakeLine'] = true;
                    }
                  }
                  //let rowIndex = verticalAssuredEdges.length ? findClosestIndex(intersectingElements.map(item => item.x), edge.x, paddingSize * 2) : getGridIndex(rows, edge.y);
                  //rowIndex = rowIndex == -1 ? getGridIndex(rows, edge.y) : rowIndex;//wrong

                  let edgeOnSameAxis = (() => {
                    let res: any = checkRectangleRanges(edge, { y: [textBlock.y, textBlock.y + textBlock.height] }, { axis: 'y', strict: true, strictIntersecting: true })
                    return res.isIntersecting;//old: res.isContained || !res.biggestArgument && res.isIntersecting; //BUGFIX if the text block is located in a merged cell and crosses two edges
                  })();
                  let intersectingGridItems = uniqueArr(intersectingElements, 'x');
                  if (
                    //intersectingElements.length == cols.length && //BUG
                    intersectingGridItems.length > 2 && //threshold of number of edges for corrective detection of merged cells
                    //rowIndex == -1 &&
                    edgeOnSameAxis &&
                    //(!isHeader(textBlock) ? true : isIntersecting(edge, textBlock)) &&
                    !relatedAssuredEdge
                  ) { //edge crosses the text or is missing
                    isIntersectingTextBlock = true;
                    deletedEdges.push(edge);
                    break;
                  }
                }

                if (!isIntersectingTextBlock) {
                  let newEdge: any = edge;//foundAssuredEdge || edge;
                  if (!newEdge.used) {
                    newEdge.used = true;
                    verticalEdges.push(newEdge);
                  }
                }

              }
            }

            let sortedRowsForGap = [...rows].sort((a, b) => a - b);
            let rowGapsForSuppression = sortedRowsForGap.slice(1).map((y, i) => y - sortedRowsForGap[i]).filter(g => g > 0);
            let modalRowHeightForSuppression = +findMod(rowGapsForSuppression) || findAverage(rowGapsForSuppression) || 20;
            let yProximityTolerance = modalRowHeightForSuppression * 1.5;

            let horizontalEdges = [];

            for (let i = 0; i < rows.length; i++) {
              for (let j = 0; j < cols.length - 1; j++) {
                let x = cols[j];
                let nextX = cols[j + 1];
                let y = rows[i];
                let edge = {
                  x: x,
                  y: y,
                  width: nextX - x,
                  height: borderSize
                };
                let isIntersectingTextBlock = false;

                //if (!isOuterBoundary) {//!BUG
                // let foundAssuredEdges = sortArrayOfObjects(
                //     horizontalAssuredEdges?.filter(item=>isIntersecting(item, edge)),
                //     { field: ['x', 'width'], order: 'asc' }
                // );
                // let foundAssuredEdge = foundAssuredEdges?.[0] || null;
                // //adjust the values of the found edge
                // if(foundAssuredEdge){
                //     let colIndex = findClosestIndex(cols, foundAssuredEdge.x + foundAssuredEdge.width);
                //     let width = cols[colIndex] - x;
                //     Object.assign(foundAssuredEdge, {x, y, width});
                // }

                let isOuterBoundary = (i === 0 || i === rows.length - 1);
                for (let k = 0; k < coordinates.length; k++) {
                  let textBlock = coordinates[k];

                  // let textBlockCenterY = textBlock.y - (textBlock.height || 0) / 2; //!BUG ломает объединение ячеек в twotables_1.pdf
                  // if (Math.abs(textBlockCenterY - y) > yProximityTolerance) {
                  //   continue;
                  // }

                  let intersectingElements = horizontalIntersectorsByCoordinate[k];
                  // let intersectingElements = horizontalAssuredEdges?.filter(vector => {
                  //   let res: any = checkRectangleRanges(vector, { x: [textBlock.x, textBlock.x + textBlock.width] }, { axis: 'x', strict: true, strictIntersecting: true });
                  //   return res.isContained || !res.biggestArgument && res.isIntersecting;
                  // }) || [];

                  let relatedAssuredEdge = getRelatedAssuredEdge(edge, horizontalAssuredEdges);
                  if (relatedAssuredEdge) {
                    if (!edge['strokeColor']) {
                      edge['strokeColor'] = relatedAssuredEdge.strokeColor || relatedAssuredEdge.fillColor;
                      edge['_isFakeLine'] = true;
                    }
                  }
                  //let colIndex = horizontalAssuredEdges.length ? findClosestIndex(intersectingElements.map(item => item.y), edge.y, paddingSize * 2) : getGridIndex(cols, edge.x);
                  //colIndex = colIndex == -1 ? getGridIndex(cols, edge.x) : colIndex; //wrong

                  let edgeOnSameAxis = (() => {
                    let res: any = checkRectangleRanges(edge, { x: [textBlock.x, textBlock.x + textBlock.width] }, { axis: 'x', strict: true, strictIntersecting: true })
                    return res.isIntersecting;//old: res.isContained || !res.biggestArgument && res.isIntersecting; //BUGFIX if the text block is located in a merged cell and crosses two edges
                  })();

                  let intersectingGridItems = uniqueArr(intersectingElements, 'y');

                  //exclude header edges for correct definition of table type
                  if (!isHeader(textBlock)) {
                    intersectingGridItems = intersectingGridItems.filter(item => {
                      return !headerRowsKeys.some(key => (checkRectangleRanges({ y: item.y }, { y: key }, { axis: ['y'], strictIntersecting: true, tolerance: 1 }) as Array<any>).every(item => item.isIntersecting))
                    })
                  }
                  if (
                    !isOuterBoundary &&
                    //intersectingElements.length == rows.length && //BUG
                    intersectingGridItems.length > 3 && //threshold of number of edges for corrective detection of merged cells
                    //colIndex == -1 &&
                    edgeOnSameAxis &&
                    //(!isHeader(textBlock) ? true : isIntersecting(edge, textBlock)) && 
                    !relatedAssuredEdge
                  ) {//edge crosses the text or is missing
                    isIntersectingTextBlock = textBlock;
                    deletedEdges.push(edge);
                    break;
                  }
                }
                if (!isIntersectingTextBlock) {
                  let newEdge: any = edge;//foundAssuredEdge || edge;
                  if (!newEdge.used) {
                    newEdge.used = true;
                    horizontalEdges.push(newEdge);
                  }
                }
              }
            }

            let edges = [...verticalEdges, ...horizontalEdges];
            return edges;
          }

          function createLinesFromRectangle(rectangle, borderSize) {
            const { y, x, width, height } = rectangle;
            const color = rectangle.strokeColor || rectangle.fillColor || "rgba(0,0,0,0)";
            const _isFakeLine = true;
            const edges = [
              { x: x, y: y, width: width, height: borderSize, transform: [1, 0, 0, 1, 0, 0], strokeColor: color, _isFakeLine },
              { x: x + width, y: y, width: borderSize, height: height, transform: [1, 0, 0, 1, 0, 0], strokeColor: color, _isFakeLine },
              { x: x, y: y + height, width: width, height: borderSize, transform: [1, 0, 0, 1, 0, 0], strokeColor: color, _isFakeLine },
              { x: x, y: y, width: borderSize, height: height, transform: [1, 0, 0, 1, 0, 0], strokeColor: color, _isFakeLine }
            ];
            return edges;
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

          console.error(`[DEBUG Page ${pageNum}] edges:`, edges.length, 'rectangles:', rectangles.length, 'tableContentItems:', tableContentItems.length);

          let intersections = (() => {
            let watermarksIndexes = [];
            let array = [];

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

            for (
              let mainIndex = 0;
              mainIndex < tableContentItems.length;
              mainIndex++
            ) {
              let item = tableContentItems[mainIndex];

              let getObj = (obj) => {
                return Object.assign({}, obj, (() => {
                  let [a, b, c, d, x, y] = obj.transform;

                  x = obj.x || x;
                  y = obj.y || y;

                  return { x, y };
                })());
              };

              let data = {
                index: mainIndex,
                intersectionsIndexes: tableContentItems.reduce(
                  (prev, cur, index) => {
                    if (index != mainIndex) {
                      let inRange = (
                        checkRectangleRanges(
                          getObj(cur),
                          getObj(item),
                          {
                            strict: true,
                            strictIntersecting: true,
                            axis: ['x', 'y']
                          }
                        ) as Array<any>
                      ).every(item => item.inRange);

                      if (inRange) {
                        prev.push(index);
                      }
                    }

                    return prev;
                  },
                  []
                )
              };

              let isIntersectsEdge = (() => {
                let visibleEdges = [
                  ...(edges || []),
                  ...(rectanglesEdges || [])
                ].filter(item => isVisibleVector(item));

                return visibleEdges.filter(edge => {
                  let inRange = (
                    checkRectangleRanges(
                      getObj(edge),
                      getObj(item),
                      {
                        strict: true,
                        strictIntersecting: false,
                        axis: ['x', 'y'],
                        tolerance: -(Math.min(edge.width, edge.height))
                      }
                    ) as Array<any>
                  ).every(item => item.inRange);

                  return inRange;
                });
              })();

              if (data.intersectionsIndexes.length > 1) {
                if (!watermarksIndexes.includes(mainIndex)) {
                  watermarksIndexes.push(mainIndex);
                }
              }

              let isWatermark =
                (isIntersectsEdge.length && isEmptyCoordinate(tableContentItems[mainIndex])) ||
                (
                  tableContentItems[mainIndex]?.str == ' ' &&
                  tableContentItems[mainIndex].hasEOT
                );

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

              array.push(data);
            }

            removeByIndexes(tableContentItems, watermarksIndexes);

            return array;
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
          let coordinates = extractCoordinates(tableContentItems);

          console.error(`[DEBUG Page ${pageNum}] coordinates:`, coordinates.length);
          if (coordinates.length > 0) {
            console.error(`[DEBUG Page ${pageNum}] first coord:`, { str: coordinates[0].str?.substring(0, 30), x: coordinates[0].x, y: coordinates[0].y });
          }

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
          console.error(`[DEBUG Page ${pageNum}] nested rectangles:`, nestedRectangles.size);

          //Defining cell boundaries
          let { tableGroups, pageGroups } = getGroups();

          console.error(`[DEBUG Page ${pageNum}] tableGroups:`, tableGroups.length);
          tableGroups.forEach((g, i) => {
            console.error(`[DEBUG Page ${pageNum}] tableGroup[${i}]: rows=${g.rows?.length}, cols=${g.cols?.length}, coords=${g.coordinates?.length}`);
          });

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
              //threshold
            });

            //overwrite the default boundaries
            edges = virtualEdges;

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
                if (lines[i].bottom < top || lines[i].top > bottom) {
                  continue;
                }
                hit = true;

                top = Math.min(lines[i].top, top);
                bottom = Math.max(lines[i].bottom, bottom);

                lines.splice(i, 1); // Delete the current line
                i--; // Correcting the index after removal
              }
              if (!hit) {
                lines.push({ top: top, bottom: bottom });
              } else {
                lines.push({ top: top, bottom: bottom }); // Adding a merged line
              }
              return lines;
            };
            var edge;
            while (edge = edges1.shift()) {
              // skip horizon lines
              if (edge.width > lineMaxWidth) {
                continue;
              }

              // new verticle lines
              if (null === current['x'] || edge.x - current['x'] > lineMaxWidth) {
                if (current['height'] > lineMaxWidth) {
                  lines = linesAddVerticle(lines, current['y'], current['y'] + current['height']);
                }
                if (null !== current['x'] && lines.length) {
                  verticles.push({ x: current['x'], lines: lines });
                }
                current['x'] = edge.x;
                current['y'] = edge.y;
                current['height'] = 0;
                lines = [];
              }

              if (Math.abs(current['y'] + current['height'] - edge.y) < 10) {
                current['height'] = edge.height + edge.y - current['y'];
              } else {
                if (current['height'] > lineMaxWidth) {
                  lines = linesAddVerticle(lines, current['y'], current['y'] + current['height']);
                }
                current['y'] = edge.y;
                current['height'] = edge.height;
              }
            }
            if (current['height'] > lineMaxWidth) {
              lines = linesAddVerticle(lines, current['y'], current['y'] + current['height']);
            }

            // no table
            if (current['x'] === null || lines.length == 0) {
              return {};
            }
            verticles.push({ x: current['x'], lines: lines });

            // Get horizon lines
            current['x'] = null;
            current['y'] = null;
            current['width'] = 0;

            var linesAddHorizon = function (lines, left, right) {
              var hit = false;
              for (var i = 0; i < lines.length; i++) {
                if (lines[i].right < left || lines[i].left > right) {
                  continue;
                }
                hit = true;

                left = Math.min(lines[i].left, left);
                right = Math.max(lines[i].right, right);
                lines.splice(i, 1); // Delete the current line
                i--; // Correcting the index after removal
              }
              if (!hit) {
                lines.push({ left: left, right: right });
              } else {
                lines.push({ left: left, right: right }); // Adding a merged line
              }
              return lines;
            };

            while (edge = edges2.shift()) {
              if (edge.height > lineMaxWidth) {
                continue;
              }

              if (null === current['y'] || edge.y - current['y'] > lineMaxWidth) {
                if (current['width'] > lineMaxWidth) {
                  lines = linesAddHorizon(lines, current['x'], current['x'] + current['width']);
                }
                if (null !== current['y'] && lines.length) {
                  horizons.push({ y: current['y'], lines: lines });
                }
                current['x'] = edge.x;
                current['y'] = edge.y;
                current['width'] = 0;
                lines = [];
              }

              if (Math.abs(current['x'] + current['width'] - edge.x) < 10) {
                current['width'] = edge.width + edge.x - current['x'];
              } else {
                if (current['width'] > lineMaxWidth) {
                  lines = linesAddHorizon(lines, current['x'], current['x'] + current['width']);
                }
                current['x'] = edge.x;
                current['width'] = edge.width;
              }
            }
            if (current['width'] > lineMaxWidth) {
              lines = linesAddHorizon(lines, current['x'], current['x'] + current['width']);
            }
            // no table
            if (current['y'] === null || lines.length == 0) {
              return {};
            }
            horizons.push({ y: current['y'], lines: lines });
            console.error('[DIAG final horizons near 673]',
              horizons.find(h => Math.abs(h.y - 673.53) < 2)
            );

            function parseId(str) {
              let [row, col] = str.split('-').map(item => item ? +item : undefined);
              return { row, col };
            }

            function isValidId(str, verticles, horizons) {
              let parsedId = parseId(str);
              if (parsedId?.row == undefined || parsedId?.col == undefined) {
                return false
              } else {
                return (horizons?.length ? (parsedId?.row < horizons?.length - 1) : true) && (verticles?.length ? (parsedId?.col < verticles?.length - 1) : true)
              }
            }

            function areCellsAdjacent(cell1, cell2) {
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

            function inferMergesFromFillRectangles(options: {
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
               * verticles/horizons содержат объекты:
               *
               * verticles -> { x, lines }
               * horizons  -> { y, lines }
               *
               * Поэтому здесь намеренно сравниваем координату
               * со свойством .x/.y.
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
                const span =
                  getRectGridSpan(rectangle);

                /*
                 * Временная диагностика.
                 * Здесь теперь для 8 должен появиться кандидат.
                 */
                console.error(
                  '[MERGE FROM FILL CANDIDATE]',
                  {
                    rectangle: normalizeRect(rectangle),
                    span,
                  }
                );

                if (!span) {
                  continue;
                }

                const rowSpan =
                  span.rowEnd - span.rowStart;

                const colSpan =
                  span.colEnd - span.colStart;

                if (
                  rowSpan <= 1 &&
                  colSpan <= 1
                ) {
                  continue;
                }

                const occupiedCells =
                  getOccupiedCells(span);

                console.error(
                  '[MERGE FROM FILL]',
                  {
                    rectangle: normalizeRect(rectangle),
                    rowStart: span.rowStart,
                    rowEnd: span.rowEnd,
                    colStart: span.colStart,
                    colEnd: span.colEnd,
                    rowSpan,
                    colSpan,
                    occupiedCells,
                  }
                );

                /*
                 * У merged rectangle должен быть один anchor-content.
                 *
                 * Это отсекает обычные большие фоновые rectangles.
                 */
                if (
                  occupiedCells.length !== 1
                ) {
                  continue;
                }

                const anchor =
                  occupiedCells[0];

                if (
                  anchor.row !== span.rowStart ||
                  anchor.col !== span.colStart
                ) {
                  continue;
                }

                /*
                 * Проверяем реальные внутренние
                 * горизонтальные границы.
                 */
                let hasInternalHorizontalEdge =
                  false;

                for (
                  let row = span.rowStart + 1;
                  row < span.rowEnd;
                  row++
                ) {
                  const y =
                    getHorizontalCoordinate(row);

                  if (
                    hasHorizontalEdge(
                      y,
                      span.x1,
                      span.x2
                    )
                  ) {
                    hasInternalHorizontalEdge =
                      true;
                    break;
                  }
                }

                if (hasInternalHorizontalEdge) {
                  continue;
                }

                /*
                 * Проверяем реальные внутренние
                 * вертикальные границы.
                 */
                let hasInternalVerticalEdge =
                  false;

                for (
                  let col = span.colStart + 1;
                  col < span.colEnd;
                  col++
                ) {
                  const x =
                    getVerticalCoordinate(col);

                  if (
                    hasVerticalEdge(
                      x,
                      span.y1,
                      span.y2
                    )
                  ) {
                    hasInternalVerticalEdge =
                      true;
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

                console.error(
                  '[MERGE FROM FILL CREATED]',
                  {
                    created,
                    anchor,
                    span,
                  }
                );
              }
            }

            function validateColumnMerges(options: {
              merges: Record<string, any>;
              mergeAlias: Record<string, string>;
              verticles: any[];
              horizons: any[];
              coordinates: any[];
            }) {
              let { merges, mergeAlias, verticles, coordinates } = options;
              let sortedV = [...verticles].sort((a, b) => a.x - b.x);
              let colBounds = (colIndex: number) => [sortedV[colIndex]?.x, sortedV[colIndex + 1]?.x];

              Object.keys(merges).forEach(rootKey => {
                let merge = merges[rootKey];
                if (merge.width <= 1) return; // не colspan — не трогаем

                let colFrom = merge.col;
                let colTo = merge.col + merge.width;
                let xFrom = sortedV[colFrom]?.x;
                let xTo = sortedV[colTo]?.x;
                if (!Number.isFinite(xFrom) || !Number.isFinite(xTo)) return;

                let rowFrom = merge.row;
                let rowTo = merge.row + merge.height;
                let ySorted = [...options.horizons].sort((a, b) => b.y - a.y);
                let yTop = ySorted[rowFrom]?.y;
                let yBottom = ySorted[rowTo]?.y;
                if (!Number.isFinite(yTop) || !Number.isFinite(yBottom)) return;

                let itemsInSpan = (coordinates || []).filter(c => {
                  if (!c?.str?.trim()) return false;
                  let cx1 = c.x, cx2 = c.x + c.width;
                  return cx1 >= xFrom - 1 && cx2 <= xTo + 1 && c.y <= yTop + 1 && c.y > yBottom - 1;
                });
                if (itemsInSpan.length < 2) return; // делить нечего

                let subColumnsUsed = new Set<number>();
                let anyItemSpansMultipleColumns = false;
                itemsInSpan.forEach(item => {
                  let itemLeft = item.x;
                  let itemRight = item.x + item.width;
                  let touchedCols: number[] = [];
                  for (let c = colFrom; c < colTo; c++) {
                    let [cxFrom, cxTo] = colBounds(c);
                    let overlap = Math.min(itemRight, cxTo) - Math.max(itemLeft, cxFrom);
                    if (overlap > Math.min(item.width, cxTo - cxFrom) * 0.5) touchedCols.push(c);
                  }
                  if (touchedCols.length > 1) anyItemSpansMultipleColumns = true;
                  touchedCols.forEach(c => subColumnsUsed.add(c));
                });

                // ни один текстовый блок реально не пересекает границу между
                // колонками, при этом блоки лежат в разных колонках — значит
                // это НЕ единая объединённая ячейка, а просто отсутствующий
                // разделитель. Разбиваем colspan-merge на отдельные
                // rowspan-only merge'и по каждой колонке.
                if (!anyItemSpansMultipleColumns && subColumnsUsed.size > 1) {
                  delete merges[rootKey];
                  (merge.arr || []).forEach((cellKey: string) => {
                    if (mergeAlias[cellKey] === rootKey) delete mergeAlias[cellKey];
                  });

                  if (merge.height > 1) {
                    for (let c = colFrom; c < colTo; c++) {
                      let newRootKey = `${rowFrom}-${c}`;
                      let arr: string[] = [];
                      for (let r = rowFrom; r < rowTo; r++) arr.push(`${r}-${c}`);
                      merges[newRootKey] = {
                        row: rowFrom, col: c, arr,
                        widthArr: [newRootKey], heightArr: arr,
                        width: 1, height: merge.height,
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

            function createMatrix(verticles, horizons) {
              verticles = verticles.sort(function (a, b) { return a.x - b.x; });
              horizons = horizons.sort(function (a, b) { return b.y - a.y; });
              let mergesArrays = [];
              //let previousMergeArrayIndex;

              let xList = verticles.map(function (a) { return a.x; });
              var yList = horizons.map(function (a) { return a.y; });

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
                        return Number(vCondition);
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
                      if (isVerticleBorder && isHorizonBorder) { //horizontal and vertical border
                        previousCells = [[horizonIndex - 1, verticleIndex], [horizonIndex, verticleIndex - 1]];
                        previousMatrixItems = [[h - 1, v], [h, v - 1]];
                        //closedIndexes = [0,1];
                      } else if (isVerticleBorder && !isHorizonBorder) {
                        previousCells = [[horizonIndex, verticleIndex - 1]];
                        previousMatrixItems = [[h, v - 1]];
                        //closedIndexes = [1];
                      } else if (!isVerticleBorder && isHorizonBorder) {
                        previousCells = [[horizonIndex - 1, verticleIndex]];
                        previousMatrixItems = [[h - 1, v]];
                        //closedIndexes = [0]
                      } else {
                        previousCells = [[horizonIndex, verticleIndex]]
                        previousMatrixItems = [[h, v]];
                        //closedIndexes = [];
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

              return { matrix, merges, mergeAlias };
            }

            console.error('[DIAG all horizons]', horizons.map(h => ({ y: h.y, lines: h.lines })));

            let matrixData = createMatrix(
              verticles,
              horizons
            );

            console.error('[DIAG raw matrix merges]', JSON.parse(JSON.stringify(matrixData.merges)));
            console.error('[DIAG raw matrix mergeAlias]', JSON.parse(JSON.stringify(matrixData.mergeAlias)));

            inferMergesFromFillRectangles({
              tableGroup,
              pageGroup: pageGroups[0],
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
              matrix: matrixData.matrix
            });
          }

          return { tableGroups, pageGroups }

        }).then(function ({ tableGroups, pageGroups }) {

          for (let tableIndex = 0; tableIndex < tableGroups.length; tableIndex++) {
            let tableGroup = tableGroups[tableIndex];

            function extractTableData(options) {
              let { verticles, horizons, coordinates, merges = {}, mergeAlias = {}, headerRows = {}, edges, tableGroup, pageGroup, lineMaxWidth, rectangles = [] } = options;
              // Sorting by requirements
              verticles = verticles.sort((a, b) => a.x - b.x);
              horizons = horizons.sort((a, b) => b.y - a.y); // Inverted y-axis
              coordinates = sortArrayOfObjects(
                coordinates,
                [{ field: 'y', order: 'desc' }, { field: 'x', order: 'asc' }]
              );

              const rowsCount = horizons.length - 1;
              const colsCount = verticles.length - 1;
              const table = {
                array: Array.from({ length: rowsCount }, () => [...Array(colsCount)].map(i => ({ str: "" }))),
                html: null,
                json: null,
              }
              const tablePos = Array.from({ length: rowsCount }, () => Array(colsCount).fill(null));

              // ===== DIAGNOSTICS: try-catch with precise location =====
              try {
                for (const item of coordinates) {
                  const x = item.transform[4];
                  const y = item.transform[5];

                  // Looking for the column
                  let col = -1;
                  for (let i = 0; i < verticles.length - 1; i++) {
                    if (x >= verticles[i].x && x < verticles[i + 1].x) {
                      col = i;
                      break;
                    }
                  }
                  if (col === -1) {
                    continue;
                  }

                  // Looking for the row
                  let row = -1;
                  for (let i = 0; i < horizons.length - 1; i++) {
                    if (y <= horizons[i].y && y > horizons[i + 1].y) {
                      row = i;
                      break;
                    }
                  }
                  if (row === -1) {
                    continue;
                  }

                  // Check for merged cells
                  const mergeKey = `${row}-${col}`;
                  if (mergeAlias[mergeKey]) {
                    const [mergedRow, mergedCol] = mergeAlias[mergeKey].split("-").map(Number);
                    row = mergedRow;
                    col = mergedCol;
                  }

                  // Protection from going abroad
                  if (row < 0 || row >= rowsCount || col < 0 || col >= colsCount || !table.array[row] || !table.array[row][col]) {
                    console.error(`[WARN] Coordinate out of bounds or cell undefined: row=${row}, col=${col}, str="${item?.str?.substring(0, 30)}"`);
                    continue;
                  }

                  // Add text to the table
                  if (tablePos[row][col] !== null && Math.abs(tablePos[row][col] - y) > 5) {
                    table.array[row][col]['str'] += "\n";
                  }
                  tablePos[row][col] = y;
                  table.array[row][col]['str'] += (item?.str || '');
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

                      if (table.array[row][col]['str'].includes('Sl.')) {
                        console.error('[SL NO FILL DEBUG]', {
                          row,
                          col,

                          cell: {
                            x1: cellX1,
                            x2: cellX2,
                            y1: cellY1,
                            y2: cellY2,
                            width: cellX2 - cellX1,
                            height: cellY2 - cellY1
                          },

                          mergeInfo,

                          rectangles: (rectangles || [])
                            .map(rectangle => {
                              const rectX1 = Number(
                                rectangle?.x ?? rectangle?.transform?.[4]
                              );
                              const rectY1 = Number(
                                rectangle?.y ?? rectangle?.transform?.[5]
                              );
                              const rectWidth = Math.abs(
                                Number(rectangle?.width) || 0
                              );
                              const rectHeight = Math.abs(
                                Number(rectangle?.height) || 0
                              );

                              const rectX2 = rectX1 + rectWidth;
                              const rectY2 = rectY1 + rectHeight;

                              const intersects =
                                rectX2 >= cellX1 &&
                                rectX1 <= cellX2 &&
                                rectY2 >= cellY1 &&
                                rectY1 <= cellY2;

                              return intersects
                                ? {
                                  x: rectX1,
                                  y: rectY1,
                                  width: rectWidth,
                                  height: rectHeight,
                                  x2: rectX2,
                                  y2: rectY2,
                                  fillColor: rectangle?.fillColor,
                                  fillRGBColor: rectangle?.fillRGBColor
                                }
                                : null;
                            })
                            .filter(Boolean)
                        });
                      }

                      const fillRectangle = (rectangles || []).find(rectangle => {
                        if (
                          rectangle?.fillColor == null &&
                          !Array.isArray(rectangle?.fillRGBColor)
                        ) {
                          return false;
                        }

                        const rectX1 = Number(
                          rectangle?.x ?? rectangle?.transform?.[4]
                        );
                        const rectY1 = Number(
                          rectangle?.y ?? rectangle?.transform?.[5]
                        );

                        const rectWidth = Math.abs(
                          Number(rectangle?.width) || 0
                        );
                        const rectHeight = Math.abs(
                          Number(rectangle?.height) || 0
                        );

                        if (
                          !Number.isFinite(rectX1) ||
                          !Number.isFinite(rectY1) ||
                          rectWidth <= 0 ||
                          rectHeight <= 0
                        ) {
                          return false;
                        }

                        const rectX2 = rectX1 + rectWidth;
                        const rectY2 = rectY1 + rectHeight;

                        return (
                          Math.abs(rectX1 - cellX1) <= tolerance &&
                          Math.abs(rectX2 - cellX2) <= tolerance &&
                          Math.abs(rectY1 - cellY1) <= tolerance &&
                          Math.abs(rectY2 - cellY2) <= tolerance
                        );
                      });

                      if (fillRectangle) {
                        table.array[row][col]['fillColor'] =
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
                console.error(`[FATAL] Error in coordinate placement phase:`, err.message);
                console.error(`[FATAL] Stack:`, err.stack);
                throw err;
              }

              // Generate HTML table
              table.html = (() => {
                try {
                  const headerRowCount = Object.keys(headerRows).length;

                  // --- EDGES LOGIC ---

                  // We collect ALL visible real lines: group + page lines (in case of a split)
                  let groupEdges = [
                    ...(edges || []),
                    ...(tableGroup?.rectanglesEdges || [])
                  ].filter(item => isVisibleVector(item) && !item['_isFakeLine']);

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
                    ].filter(item => isVisibleVector(item) && !item['_isFakeLine']);

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

                  // Тонкие полоски заливки (артефакты отрисовки поверх линий, толщиной ~0.03)
                  // не должны участвовать в выборе модального цвета рамки таблицы —
                  // иначе белые «крышки» ячеек перебивают реальный цвет границы.
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

                  const borderColorCache = {};

                  function findColorInPool(idealLine, pool, isHorizontalIdeal, idealLength) {
                    // Let's summarize the overlaps for each unique color.
                    let realOverlapMap = {};
                    let degenerateOverlapMap = {};
                    let realTotal = 0, degenerateTotal = 0;

                    for (let edge of pool) {
                      let edgeColor = edge.isLinePath ? edge.strokeColor : (edge.strokeColor || edge.fillColor);
                      if (!edgeColor) continue;

                      let isHorizontalEdge = edge.height < lineMaxWidth && edge.width > lineMaxWidth;
                      let isVerticalEdge = edge.width < lineMaxWidth && edge.height > lineMaxWidth;

                      if (isHorizontalIdeal && !isHorizontalEdge) continue;
                      if (!isHorizontalIdeal && !isVerticalEdge) continue;

                      // Proximity along the main axis
                      let axisMatch = isHorizontalIdeal ? Math.abs(edge.y - idealLine.y1) <= tolerance : Math.abs(edge.x - idealLine.x1) <= tolerance;
                      if (!axisMatch) continue;

                      // Overlap in length
                      let overlapStart, overlapEnd;
                      if (isHorizontalIdeal) {
                        overlapStart = Math.max(edge.x, Math.min(idealLine.x1, idealLine.x2));
                        overlapEnd = Math.min(edge.x + edge.width, Math.max(idealLine.x1, idealLine.x2));
                      } else {
                        overlapStart = Math.max(edge.y, Math.min(idealLine.y1, idealLine.y2));
                        overlapEnd = Math.min(edge.y + edge.height, Math.max(idealLine.y1, idealLine.y2));
                      }
                      let overlap = Math.max(0, overlapEnd - overlapStart);
                      if (overlap <= 0) continue;

                      // вырожденный (0pt) сегмент — гораздо менее надёжное доказательство
                      // реальной границы, чем сегмент с настоящей толщиной, даже если
                      // он тоже залит цветом (часто это дубль того же контура)
                      let thickness = isHorizontalIdeal ? edge.height : edge.width;
                      if (thickness > 0.3) { // old: > 0.01
                        realOverlapMap[edgeColor] = (realOverlapMap[edgeColor] || 0) + overlap;
                        realTotal += overlap;
                      } else {
                        degenerateOverlapMap[edgeColor] = (degenerateOverlapMap[edgeColor] || 0) + overlap;
                        degenerateTotal += overlap;
                      }
                      //let weight = thickness > 0.01 ? 1 : 0.05;
                    }

                    if (realTotal > 0) {
                      let sortedColors = Object.entries(realOverlapMap)
                        .sort((a: any, b: any) => b[1] - a[1]);

                      let bestColor: any = sortedColors[0][0];
                      let bestOverlap: any = sortedColors[0][1];
                      // Порог: 5% длины или минимум 1px
                      let threshold = Math.min(idealLength * 0.05, 1);

                      if (bestOverlap >= threshold) {
                        return bestColor;
                      }
                    }

                    return null;
                  }

                  function getSegmentBorderColor(idealLine) {
                    const cacheKey = `${idealLine.x1.toFixed(2)},${idealLine.y1.toFixed(2)},${idealLine.x2.toFixed(2)},${idealLine.y2.toFixed(2)}`;
                    if (borderColorCache[cacheKey] !== undefined) {
                      return borderColorCache[cacheKey];
                    }
                    let isHorizontalIdeal = Math.abs(idealLine.y2 - idealLine.y1) < tolerance;
                    let idealLength = isHorizontalIdeal ?
                      Math.abs(idealLine.x2 - idealLine.x1) :
                      Math.abs(idealLine.y2 - idealLine.y1);

                    if (idealLength <= 0) {
                      borderColorCache[cacheKey] = null;
                      return null;
                    }

                    // 1. The main search is in the edges of the table itself
                    let result = findColorInPool(idealLine, groupEdges, isHorizontalIdeal, idealLength);

                    // 2. Fallback — real page lines, but only inside the bbox of the table
                    if (!result && pageEdgesFiltered.length > 0) {
                      result = findColorInPool(idealLine, pageEdgesFiltered, isHorizontalIdeal, idealLength);
                    }

                    // 3. If there is a line nearby, but the color has not shifted (micro-shifts) — the dominant color
                    if (!result && hasAnyBorders && tableBorderColor) {
                      let hasNearbyEdge = allEdges.some(edge => {
                        let isHorizontalEdge = edge.height < lineMaxWidth && edge.width > lineMaxWidth;
                        let isVerticalEdge = edge.width < lineMaxWidth && edge.height > lineMaxWidth;
                        if (isHorizontalIdeal && !isHorizontalEdge) return false;
                        if (!isHorizontalIdeal && !isVerticalEdge) return false;

                        if (isHorizontalIdeal) {
                          let yMatch = Math.abs(edge.y - idealLine.y1) <= tolerance;
                          let xOverlap = !(edge.x + edge.width < Math.min(idealLine.x1, idealLine.x2) - tolerance ||
                            edge.x > Math.max(idealLine.x1, idealLine.x2) + tolerance);
                          return yMatch && xOverlap;
                        } else {
                          let xMatch = Math.abs(edge.x - idealLine.x1) <= tolerance;
                          let yOverlap = !(edge.y + edge.height < Math.min(idealLine.y1, idealLine.y2) - tolerance ||
                            edge.y > Math.max(idealLine.y1, idealLine.y2) + tolerance);
                          return xMatch && yOverlap;
                        }
                      });

                      if (hasNearbyEdge) {
                        result = tableBorderColor;
                      }
                    }

                    borderColorCache[cacheKey] = result;
                    return result;
                  }
                  // --- END EDGES LOGIC ---

                  let html = `<table style="border-collapse:collapse;">` + '\n';
                  html += '<thead>\n';

                  for (let r = 0; r < table.array.length; r++) {
                    if (!table.array[r]) {
                      console.error(`[WARN HTML] table.array[${r}] is undefined, skipping row`);
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
                        console.error(`[WARN HTML] table.array[${r}][${c}] is undefined, skipping cell`);
                        continue;
                      }

                      let fillColor = table.array[r][c]['fillColor'];
                      let textColor = table.array[r][c]['textColor'];
                      // Defining the colors of the 4 sides of the cell
                      let cellBorders = { top: null, right: null, bottom: null, left: null };

                      const mergeInfo = merges[r_c];
                      const rowSpan = mergeInfo ? mergeInfo.height : 1;
                      const colSpan = mergeInfo ? mergeInfo.width : 1;

                      console.error('pool for State top border:', groupEdges.filter(e => Math.abs(e.y - 689.6409912109375) <= 2 && e.x < 179));

                      cellBorders.top = getSegmentBorderColor({ x1: verticles[c].x, y1: horizons[r].y, x2: verticles[c + colSpan].x, y2: horizons[r].y });
                      cellBorders.bottom = getSegmentBorderColor({ x1: verticles[c].x, y1: horizons[r + rowSpan].y, x2: verticles[c + colSpan].x, y2: horizons[r + rowSpan].y });
                      cellBorders.left = getSegmentBorderColor({ x1: verticles[c].x, y1: horizons[r + rowSpan].y, x2: verticles[c].x, y2: horizons[r].y });
                      cellBorders.right = getSegmentBorderColor({ x1: verticles[c + colSpan].x, y1: horizons[r + rowSpan].y, x2: verticles[c + colSpan].x, y2: horizons[r].y });

                      let borderStyle = '';
                      if (cellBorders.top) borderStyle += `border-top: 1px solid ${cellBorders.top};`;
                      if (cellBorders.right) borderStyle += `border-right: 1px solid ${cellBorders.right};`;
                      if (cellBorders.bottom) borderStyle += `border-bottom: 1px solid ${cellBorders.bottom};`;
                      if (cellBorders.left) borderStyle += `border-left: 1px solid ${cellBorders.left};`;

                      if (textColor) {
                        borderStyle += `color: ${textColor};`;
                      }

                      let safeStr = (table.array[r][c]['str'] || '').replace(/\n/gim, '<br>');
                      let cell = `<${tagName} style="${borderStyle}${fillColor ? ` background-color: ${fillColor};` : ''}"`;

                      if (merges[r_c]) {
                        if (merges[r_c].width > 1) cell += ` colspan="${merges[r_c].width}"`;
                        if (merges[r_c].height > 1) cell += ` rowspan="${merges[r_c].height}"`;
                      }

                      cell += `>${safeStr}</${tagName}>\n`;
                      html += cell;
                    }
                    html += '</tr>\n';
                  }
                  html += '</tbody>\n</table>';
                  return html;
                } catch (err) {
                  console.error(`[FATAL] Error in HTML generation phase:`, err.message);
                  console.error(`[FATAL] Stack:`, err.stack);
                  throw err;
                }
              })();

              // Generate JSON table
              table.json = (() => {
                try {
                  const headerRowCount = Object.keys(headerRows).length;
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
                      console.error(`[WARN JSON] merge source cell [${row}][${col}] undefined, key=${key}`);
                      return;
                    }
                    const mainContent = clonedArray[row][col]['str'] || '';
                    arr.forEach((cellKey) => {
                      const [mergeRow, mergeCol] = cellKey.split("-").map(Number);
                      if (clonedArray[mergeRow] && clonedArray[mergeRow][mergeCol]) {
                        clonedArray[mergeRow][mergeCol]['str'] = mainContent;
                      } else {
                        console.error(`[WARN JSON] merge target cell [${mergeRow}][${mergeCol}] undefined, key=${cellKey}`);
                      }
                    });
                  });

                  const PATH_SEP = '>';
                  const PATH_SPLIT_RE = /[^>]+/g;

                  function generateHeaderPaths(headers) {
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

                  let headerPaths = generateHeaderPaths(clonedArray.slice(0, headerRowsKeys.length));

                  let jsonData = clonedArray.slice(headerRowCount).map((row, rowIdx) => {
                    let obj = {};
                    row.forEach((col, colIndex) => {
                      if (!headerPaths[colIndex]) {
                        console.error(`[WARN JSON] headerPaths[${colIndex}] undefined for row ${rowIdx}`);
                        return;
                      }
                      if (row[colIndex]?.str) {
                        deepSet(obj, headerPaths[colIndex], row[colIndex].str, {
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
                  console.error(`[FATAL] Error in JSON generation phase:`, err.message);
                  console.error(`[FATAL] Stack:`, err.stack);
                  throw err;
                }
              })();

              return {
                table,
                width: colsCount,
                height: rowsCount
              };
            }

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
            if (tableData.table.array.length) {
              tableGroup.tableData = tableData;
            }
          }

          result.pageTables.push({
            page: pageNum,
            tableGroups,
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
    let { dataArray, onProgress, onSuccess, onError, pages } = options;

    let docParams: any = { data: dataArray };
    if (standardFontDataUrl) {
      docParams.standardFontDataUrl = standardFontDataUrl;
    }
    let documentLoadingTask = await pdfjs.getDocument(docParams);
    let documentProxy = await documentLoadingTask.promise;
    try {

      // === diagnostics getOperatorList ===
      const testPage = await documentProxy.getPage(1);
      const testOpList = await testPage.getOperatorList();

      const uniqueFns = [...new Set(testOpList.fnArray)].sort((a: any, b: any) => a - b);
      console.error('[DIAG] fnArray length:', testOpList.fnArray.length);
      console.error('[DIAG] unique fn values:', uniqueFns.join(', '));
      console.error('[DIAG] has constructPath (91)?', uniqueFns.includes(91));
      console.error('[DIAG] has rectangle (19)?', uniqueFns.includes(19));
      console.error('[DIAG] has moveTo (13)?', uniqueFns.includes(13));
      console.error('[DIAG] has lineTo (14)?', uniqueFns.includes(14));
      console.error('[DIAG] has save (10)?', uniqueFns.includes(10));
      console.error('[DIAG] has restore (11)?', uniqueFns.includes(11));
      // ===================================

      let extractorResults = await extractor(documentProxy, onProgress, pages);
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
