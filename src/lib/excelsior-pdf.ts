// import { fileURLToPath } from 'url';
// import { dirname } from 'path';
import { getTextDirection, multiSort, findClosestIndex, parseRGB, getMergedArray, uniqueArr, findMod, findAverage, caseIndependentCompare, setValueByPath, splitArrayByIndex, checkRectangleRanges, removeByIndexes, getSplitEdgeRange, calculateDifference, typeValue } from '@unsonet/utils'

// const __filename = fileURLToPath(import.meta.url);
// const __dirname = dirname(__filename);
export function init({
  pdfjs,
  workerSrc
}): any {

  //let version = 'v4.10.38';
  //let pdfjs = await import(`pdfjs-dist/legacy/build/pdf.min.mjs`);//old (local): await import(`./pdf.js/${version}/build/pdf.mjs`);
  //let pdfjsWorker = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs');
  //var modulePath = __dirname.substring(0, __dirname.lastIndexOf("/"));
  //pdfjs.workerSrc = modulePath + '/pdfjs-dist/build/pdf.worker.js';
  //pdfjs.cMapUrl = modulePath + '/pdfjs-dist/cmaps/';

  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;//`pdfjs-dist/legacy/build/pdf.worker.mjs`;;

  pdfjs = {
    ...pdfjs,
    workerSrc: pdfjs.GlobalWorkerOptions.workerSrc,// `pdfjs-dist/legacy/build/pdf.worker.mjs`,
    cMapUrl: 'cmaps/',
    cMapPacked: true,
  };

  function extractor(doc, onProgress?) {
    var numPages = doc.numPages;
    var result: {
      pageTables: Array<any>,
      numPages: number,
      currentPage: number
    } = {
      pageTables: [],
      numPages: numPages,
      currentPage: 0,
    };


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

    var lastPromise = Promise.resolve(); // will be used to chain promises
    var loadPage = function (pageNum) {
      return doc.getPage(pageNum).then(async function (page) {
        var defaultTransformMatrix = [1, 0, 0, 1, 0, 0];
        var transformMatrix = JSON.parse(JSON.stringify(defaultTransformMatrix));
        var textMatrix = JSON.parse(JSON.stringify(defaultTransformMatrix));
        var transformStack = [];
        let fontIdentityMatrix = [0.001, 0, 0, 0.001, 0, 0];
        let pageTextContent = await page.getTextContent();
        pageTextContent.items = pageTextContent.items.reduce((prev, cur, index) => {
          if (cur.str.trim()) {
            cur.index = prev.length;
            prev.push(cur);
          }
          return prev;
        }, []);

        function getRelatedTextContentItems(element) {
          return pageTextContent.items.filter((item, index) => {
            return (checkRectangleRanges(
              element,
              { x: item.transform[4], y: item.transform[5], height: item.height, width: item.width },
              { axis: ['x', 'y'], strict: false, strictIntersecting: false }
            ) as Array<any>).every(item => item.inRange)
          });
        };

        return page.getOperatorList().then(function (opList) {
          // Get rectangle first
          var showed = {};
          var REVOPS = [];
          for (var op in pdfjs.OPS) {
            REVOPS[pdfjs.OPS[op]] = op;
          }

          var edges = [];
          var tableContentItems = [];
          var tableContentItemsCache = {};
          var lineMaxWidth = 5;//old:2.5;

          let current = {
            x: null,
            y: null,
            height: 0,
            width: 0,
            lineWidth: .567 / page.userUnit,//BUGFIX
            charSpacing: 0,
            wordSpacing: 0,
            strokeRGBColor: null,
            fillRGBColor: null,
            strokeAlpha: 1,
            fillAlpha: 1,
            pathConstructed: false,
            vectorType: null,
            vectorCache: null,
            fontSpaceWidths: {},
            contentItem: {} as { [key: string]: any },

            fontDirection: null,
            fontName: null,
            fontSize: null,
          };
          let opListIndex = -1, index = 0;
          let rectangles = [];
          let rectanglesEdges = [];

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
            return JSON.stringify(transformMatrix) == JSON.stringify(defaultTransformMatrix);
          }

          while (opList.fnArray.length) {
            opListIndex++;
            var fn = opList.fnArray.shift();
            var args = opList.argsArray.shift();
            var x, y, width, height;

            //debugging: Object.keys(pdfjs.OPS).find(item=>pdfjs.OPS[item] == opList.fnArray[33])
            //opList.fnArray.map(item=>Object.keys(pdfjs.OPS).find(key=>pdfjs.OPS[key] == item))
            if (pdfjs.OPS.constructPath == fn) {
              current['pathConstructed'] = true;

              while (args[0].length) {
                op = args[0].shift();

                if (op == pdfjs.OPS.rectangle) {
                  x = args[1].shift();
                  y = args[1].shift();
                  width = args[1].shift();
                  height = args[1].shift();

                  let x2 = x + width;
                  let y2 = y + height;

                  // Apply transform matrix to coordinates 
                  if (!isDefaultTransformMatrix(transformMatrix)) {//BUGFIX earlier worked only for 07-multi-table, in 10-example the figures were shifted 
                    [x, y] = applyTransformFn([x, y], transformMatrix);
                    [x2, y2] = applyTransformFn([x2, y2], transformMatrix);
                    width = x2 - x;
                    height = y2 - y;
                  }

                  let vector = { y: y, x: x, width: width, height: height, transform: transformMatrix };
                  let vectorType = Math.min(Math.abs(width), Math.abs(height)) < lineMaxWidth ? 'edge' : 'rectangle';
                  let vectors = vectorType == 'rectangle' ? rectangles : edges;

                  if (vectorType == 'rectangle') {
                    //fake edges
                    let borderSize = getAverageBorderSize(edges || [], lineMaxWidth);
                    rectanglesEdges = uniqueArr([rectanglesEdges, ...createLinesFromRectangle(vector, borderSize)], ['x', 'y', 'width', 'height']);
                  }

                  vectors.push(vector);
                  current['vectorCache'] = vector;
                  current['vectorType'] = vectorType;
                } else if (op == pdfjs.OPS.moveTo) {
                  current['x'] = args[1].shift();
                  current['y'] = args[1].shift();

                  // Apply transform matrix to coordinates
                  if (!isDefaultTransformMatrix(transformMatrix)) {
                    [current['x'], current['y']] = applyTransformFn([current['x'], current['y']], transformMatrix);
                  }

                  //add to cache
                  let vector = { x: current['x'], y: current['y'] };
                  current['vectorCache'] = vector;

                } else if (op == pdfjs.OPS.lineTo) {
                  x = args[1].shift();
                  y = args[1].shift();

                  // Apply transform matrix to coordinates
                  if (!isDefaultTransformMatrix(transformMatrix)) {
                    [x, y] = applyTransformFn([x, y], transformMatrix);
                  }

                  let vector;
                  let lineWidth = current['lineWidth'];
                  if (current['x'] == x) {
                    vector = { y: Math.min(y, current['y']), x: x - lineWidth / 2, width: lineWidth, height: Math.abs(y - current['y']), transform: transformMatrix };
                  } else if (current['y'] == y) {
                    vector = { x: Math.min(x, current['x']), y: y - lineWidth / 2, height: lineWidth, width: Math.abs(x - current['x']), transform: transformMatrix };
                  }
                  else { //BUGFIX?
                    vector = { x: Math.min(x, current['x']), y: Math.min(y, current['y']), height: Math.abs(y - current['y']), width: Math.abs(x - current['x']), transform: transformMatrix };
                  }

                  if (vector) {
                    let colorType = 'stroke';
                    let color = getColor(colorType);
                    if (color) {
                      Object.assign(vector, { [`${colorType}Color`]: color });
                    }
                  } else {
                    //unexpected behavior
                  }

                  edges.push(vector);
                  current['vectorType'] = 'edge';
                  current['x'] = x;
                  current['y'] = y;
                } else if (op == pdfjs.OPS.closePath) {
                  current['vectorCache'] = null;
                }
                else {
                  // throw ('constructPath ' + op);
                }
              }
            } else if (pdfjs.OPS.save == fn) {
              transformStack.push(transformMatrix);
            } else if (pdfjs.OPS.restore == fn) {
              transformMatrix = transformStack.pop();
            }
            else if (pdfjs.OPS.transform == fn) {
              transformMatrix = transformFn(transformMatrix, args);
            }
            else if (pdfjs.OPS.setTextMatrix == fn) {
              textMatrix = args;
              current.contentItem.transform = textMatrix;
              current['pathConstructed'] = true;//BUGFIX (07-multi-table.pdf). It works, but there's no justification
            } else if (pdfjs.OPS.stroke == fn) {
              let vectorType = current['vectorType']
              let vectors = vectorType == 'rectangle' ? rectangles : edges;
              let vector = vectors[vectors.length - 1];

              if (vector) {
                let colorType = 'stroke';
                let color = getColor(colorType);
                if (color) {
                  Object.assign(vector, { [`${colorType}Color`]: color });
                }
              }
            } else if (pdfjs.OPS.fill == fn) {
              let vectorType = current['vectorType']
              let vectors = vectorType == 'rectangle' ? rectangles : edges;
              let vector = vectors[vectors.length - 1];

              if (vector) {
                let colorType = 'fill';
                let color = getColor(colorType);
                if (color) {
                  Object.assign(vector, { [`${colorType}Color`]: color });
                }
              }
            } else if (pdfjs.OPS.setStrokeRGBColor == fn) {
              current['strokeRGBColor'] = [...args];
              current['colorType'] = 'stroke';
            } else if (pdfjs.OPS.setFillRGBColor == fn) {
              current['fillRGBColor'] = [...args];
              current['colorType'] = 'fill';
            } else if (pdfjs.OPS.setGState == fn) {
              args.forEach(array => {
                array.forEach(pairArray => {
                  switch (pairArray[0]) {
                    case 'ca': {//fill alpha
                      current['fillAlpha'] = pairArray[1];
                      break;
                    }
                    case 'CA': {//stroke alpha
                      current['strokeAlpha'] = pairArray[1];
                      break;
                    }
                    default: {
                      break;
                    }

                  }
                })

              })
            } else if (pdfjs.OPS.setLineWidth == fn) {
              current['lineWidth'] = args[0];
            } else if (['eoFill'].indexOf(REVOPS[fn]) >= 0) {//new

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

              let vectorType = current['vectorType']
              let vectors = vectorType == 'rectangle' ? rectangles : edges;
              let vector = vectors[vectors.length - 1];
              let isFilled = isEdgeFilledEvenOdd(current.vectorCache, vector, edges);
              if (vector && isFilled) {
                let colorType = 'fill';
                let color = getColor(colorType);
                if (color) {
                  Object.assign(vector, { [`${colorType}Color`]: color });
                }
              }
            } else if (pdfjs.OPS.paintImageXObject == fn) {
              // let lastItem = tableContentItems[tableContentItems.length - 1];
              // if (lastItem && typeof lastItem?.str != 'string' && !lastItem?.imageName) {
              //     tableContentItems.splice(-1, 1);
              //     lastItem = tableContentItems[tableContentItems.length - 1];
              // }

              // if ((lastItem.str || lastItem.imageName) && !current['pathConstructed']) {
              //     lastItem['hasEOT'] = false;
              // }

              tableContentItems.push({
                width: transformMatrix[0],
                height: transformMatrix[3],
                transform: transformMatrix,
                imageName: args[0],
                hasEOT: true,
              });
            }
            else if (pdfjs.OPS.charSpacing == fn) {
              current.charSpacing = args[0];
            }
            else if (pdfjs.OPS.wordSpacing == fn) {
              current.wordSpacing = args[0];
            }
            else if (pdfjs.OPS.setFont == fn) {
              let fontName = args[0];
              let fontSize = args[1];
              // let lastItem = tableContentItems[tableContentItems.length - 1];
              // if (lastItem && typeof lastItem?.str != 'string' && !lastItem?.imageName) {
              //     tableContentItems.splice(-1, 1);
              // }

              let contentItem = {
                height: fontSize,
                transform: [
                  ...[
                    fontSize,
                    0,
                    0,
                    fontSize,
                  ],
                  ...transformMatrix.slice(4)
                ],
                fontName: fontName,
              };

              current.contentItem = contentItem;//old: tableContentItems.push(contentItem);

              if (fontSize < 0) {
                fontSize = -fontSize;
                current.fontDirection = -1;
              } else {
                current.fontDirection = 1;
              }

              current.fontName = fontName;
              current.fontSize = fontSize;
            }
            else if (pdfjs.OPS.setLeadingMoveText == fn) {
                textMatrix = [...textMatrix.slice(0, 4), ...args];
            }
            else if (pdfjs.OPS.moveText == fn) {//BUG:|| pdfjs.OPS.setLeadingMoveText == fn

              let textMatrixChanged = textMatrix.toString() != defaultTransformMatrix.toString();

              if (textMatrixChanged) {//BUGFIX?
                textMatrix = [...textMatrix.slice(0, 4), ...applyTransformFn(args, textMatrix)];
                //args = [textMatrix[4], textMatrix[5]]
              }

              let contentItem = current.contentItem;
              //let newItem = tableContentItems?.[tableContentItems.length - 1];
              //if (newItem?.str == undefined && newItem.transform.length && !newItem.imageName) {
              Object.assign(contentItem, {
                transform: [...contentItem.transform.slice(0, 4), ...(textMatrixChanged ? [textMatrix[4], textMatrix[5]] : args)]//[...newItem.transform.slice(0, 4), ...args]
              })
              // } else {
              //     tableContentItems.push({
              //         transform: [...transformMatrix.slice(0, 4), ...(textMatrixChanged ? [textMatrix[4], textMatrix[5]] : args)]
              //     });
              // }
            }
            else if (pdfjs.OPS.showText == fn) {
              var fontName = current.fontName;
              var fontSize = current.fontSize;
              var charSpacing = current.charSpacing;
              var wordSpacing = current.wordSpacing;
              var fontDirection = current.fontDirection;
              var widthAdvanceScale = fontSize * fontIdentityMatrix[0];
              var vertical = pageTextContent.styles[fontName]?.vertical || false; //BUG Sometimes fonts are missing
              var spacingDir = vertical ? 1 : -1;


              function handleCharsArgs(options) {
                let {
                  charsArr, rangeArr, x, y, setCoordinates, setCharWidth,
                  //wordSpacing, widthAdvanceScale, charSpacing, spacingDir, fontSize
                } = options;
                x = x || 0;
                let currentX = x;
                let str;
                let charsRangesArrays = [[], [], []];
                let widthRangesArrays = [[], [], []];
                let fontSpaceWidths = {};

                let charsArrFiltered = charsArr.filter(item => typeof item == 'object');

                let widthsObj = charsArr.reduce((acc, glyph, glyphIndex) => {
                  let currentWidth = 0;

                  if (typeof glyph === 'object') {
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
                      !((glyph.isSpace || glyph.isLineBreak) && (charsArrFiltered[charsArrFiltered.length - 1] == glyph)) //if the last element is a space, it is taken into account
                    ) {
                      let tolerance = 0.05;
                      let start = rangeArr[0];
                      let end = (rangeArr[1] + tolerance);
                      let charRangeIndexes = {
                        0: currentX < start,
                        1: (currentX >= start) && (currentX <= end),
                        2: currentX > end,
                      };
                      return Object.keys(charRangeIndexes).find(item => charRangeIndexes[item]);
                    } else {
                      return 1;
                    }
                  })();

                  charsRangesArrays[charRangeIndex].push(glyph);
                  widthRangesArrays[charRangeIndex].push(currentWidth);

                  return acc;
                }, { lineWidths: [], currentLineWidth: 0 });

                // After completion, add the last line if it is not empty
                if (widthsObj.currentLineWidth > 0) {
                  widthsObj.lineWidths.push(widthsObj.currentLineWidth);
                }

                // Total array of row widths
                let lineWidths = widthsObj.lineWidths;
                let maxlineWidth = Math.max(...lineWidths);
                let widthRanges: Array<number> = widthRangesArrays.map(item => item.reduce((acc, val) => acc + val, 0));

                return { widthRanges, lineWidths, maxlineWidth, str, charsRangesArrays, fontSpaceWidths }
              }

              function spaceNeeded(newItem, lastItem) {
                let startSpecialCharsRegExp = /[\[\(\<\‹\'\"\`\{\«\„\‘～]/i;
                let endSpecialCharsRegExp = /[\]\)\>\›\'\"\`\}\»\”\’～,:%]/i;
                let firstWordRegExp = /^[\p{L}\w]+/gu;

                let newItemChars = clearChars({ chars: newItem?.chars || [] });
                let lastItemChars = clearChars({ chars: lastItem?.chars || [] });

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
                      )
                      && (() => {
                        let startCondition = (lastItemChars?.length ? startSpecialCharsRegExp.test(lastItemChars[lastItemChars.length - 1].unicode) : false);
                        let endCondition = (newItemChars?.length ? endSpecialCharsRegExp.test(newItemChars[0].unicode) : false);
                        return newItemChars?.length ?
                          (
                            lastItemChars?.length ? !(startCondition || endCondition) : !endCondition
                          )
                          : lastItemChars?.length ? !startCondition : true;
                      })()
                      : false
                  );
              }

              function getTextContentItemId(textContentItem) {
                return textContentItem ? [textContentItem.transform[5], textContentItem.transform[4]].join('-') : null;
              }

              function trimTableContentItem(item, clearStart = true, clearEnd = true) {
                item = JSON.parse(JSON.stringify(item));
                let chars = clearChars({ chars: item.chars, fullClear: true, clearStart, clearEnd });
                chars = chars.length ? chars : item.chars;
                let handledValues = handleCharsArgs({
                  charsArr: chars,
                  x: item.transform[4]
                });
                Object.assign(item, {
                  str: item.str.trim(),
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
              Object.assign(preliminaryItem, {
                transform: (textMatrix.slice(-2).toString() == preliminaryItem.transform.slice(-2).toString()) ? preliminaryItem.transform : transformFn(textMatrix, preliminaryItem.transform)
              });

              let { widthRanges, str, charsRangesArrays, fontSpaceWidths } = handleCharsArgs({
                charsArr: JSON.parse(JSON.stringify(args[0])),//clearChars({chars:args[0], fullClear:false, clearStart:true, clearEnd:false}),
                x: preliminaryItem.transform[4],
                y: preliminaryItem.transform[5],
                setCoordinates: true,
                setCharWidth: true
              });
              fontSpaceWidths = Object.assign(current.fontSpaceWidths, fontSpaceWidths);

              //removeByIndexes(tableContentItems, [tableContentItems.length - 1]);

              current['str'] = str;

              Object.assign(preliminaryItem,
                {
                  str: str,
                  chars: charsRangesArrays.flat(), //need to update
                  fontName: fontName,
                  height: fontSize,
                  dir: ['rtl', 'ltr'][fontDirection] || getTextDirection(str),
                  width: widthRanges[1],
                  //transform: (textMatrix.slice(-2).toString() == preliminaryItem.transform.slice(-2).toString()) ? preliminaryItem.transform : transformFn(textMatrix, preliminaryItem.transform),
                  //hasEOL: hasEOL(str)//BUGFIX there are no line breaks in the text
                }
              );

              let relatedTextContentItems = getRelatedTextContentItems({
                x: preliminaryItem.transform[4],
                y: preliminaryItem.transform[5],
                height: preliminaryItem.height,
                width: preliminaryItem.width
              })
                .filter(item => {
                  let parseStr = (str) => {
                    return str ? [...(str.match(/\p{L}+|\p{N}+|\w|\W/gmu) || [])] : [];
                  };
                  let [str1, str2] = [item?.str || '', str || ''];
                  return parseStr(str1).some(i => str2.includes(i)) ||
                    parseStr(str2).some(i => str1.includes(i));
                });
              relatedTextContentItems = relatedTextContentItems.length ? relatedTextContentItems : [undefined];

              for (let relatedTextContentIndex = 0; relatedTextContentIndex < relatedTextContentItems.length; relatedTextContentIndex++) {
                const relatedTextContentItem = relatedTextContentItems[relatedTextContentIndex];

                let relatedTextContentId = getTextContentItemId(relatedTextContentItem);
                let identicalToRelated = relatedTextContentItem?.str == str;
                let similarToRelated = relatedTextContentItem?.str?.trim() == str?.trim();
                let skippedLastTextContentItem = false;
                let reachedEnd = (() => {
                  if (relatedTextContentItem ? relatedTextContentItem.str : false) {
                    //old:
                    let subStrIndex = relatedTextContentItem.str.indexOf(str);
                    skippedLastTextContentItem = (subStrIndex != -1) && (subStrIndex != 0) && !tableContentItemsCache[relatedTextContentId]?.length;
                    let reachedSubStrEnd = (subStrIndex + str.length) == relatedTextContentItem.str.length;
                    if (
                      (
                        (preliminaryItem.transform[4] <= (relatedTextContentItem.transform[4] + relatedTextContentItem.width)) &&
                        ((preliminaryItem.transform[4] + preliminaryItem.width) >= (relatedTextContentItem.transform[4] + relatedTextContentItem.width))
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

                if (relatedTextContentItem && !similarToRelated && reachedEnd) {

                  let intersectLast = (checkRectangleRanges(preliminaryItem, lastItem, { axis: ['x', 'y'] }) as Array<any>).every(item => item.inRange);
                  let currentCacheItems = preliminaryItem.str.includes(relatedTextContentItem.str) ||
                    (
                      intersectLast &&
                      !tableContentItemsCache[relatedTextContentId]
                    ) ? [preliminaryItem] : [...tableContentItemsCache[relatedTextContentId], preliminaryItem];

                  newItem = currentCacheItems.reduce((prev, cur) => {

                    let newPrev;

                    //if (prev.str) {
                    if (prev.str) {
                      updateChars({ item: cur, spaceNeeded: spaceNeeded(cur, prev), fontSpaceWidth: fontSpaceWidths[fontName] });
                      updateChars({ item: prev, lineBreakNeeded: prev.transform[5] != cur.transform[5], fontSpaceWidth: fontSpaceWidths[fontName] });
                    }

                    let { str, charsRangesArrays } = handleCharsArgs({
                      charsArr: cur.chars,
                      x: cur.transform[4],
                      rangeArr: [
                        relatedTextContentItem.transform[4],
                        relatedTextContentItem.transform[4] + relatedTextContentItem.width
                      ]
                    });
                    let chars = [...(prev['chars'] || []), ...charsRangesArrays[1]];
                    let handledValues = handleCharsArgs({
                      charsArr: chars
                    });
                    chars = clearChars({ chars: handledValues.charsRangesArrays[1], fullClear: false, clearStart: true });

                    let prevTransform = prev.str ? prev.transform : defaultTransformMatrix;

                    newPrev = handledValues.charsRangesArrays.flat().length ? {
                      str: handledValues.str,
                      chars: chars,
                      fontName: fontName,
                      height: fontSize,
                      dir: ['rtl', 'ltr'][fontDirection] || getTextDirection(str),
                      width: Math.max(...handledValues.widthRanges),
                      transform: [
                        Math.max(prevTransform[0], cur.transform[0]),
                        Math.max(prevTransform[1], cur.transform[1]),
                        Math.max(prevTransform[2], cur.transform[2]),
                        Math.max(prevTransform[3], cur.transform[3]),
                        chars[0].x || Math.min(prevTransform[4], cur.transform[4]),
                        Math.max(prevTransform[5], cur.transform[5]),
                      ],
                    } : null;
                    // } else {
                    //     newPrev = cur;
                    // }
                    return newPrev;
                  }, {});

                }
                else {
                  newItem = preliminaryItem;
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

                  newItem['hasEOT'] = true;
                  newItem['hasEOL'] = (() => {
                    let hasEOL = relatedTextContentItem?.['hasEOL'] || false;
                    return identicalToRelated ? hasEOL ? lastItem.hasEOL ? false : hasEOL : false : false; //old:!combinedTextContentItem ? hasEOL : false; 
                  })();
                  newItem['altStr'] = relatedTextContentItem?.str;

                  if ((lastItem.str || lastItem.imageName) && !current['pathConstructed']) {
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
                  ) {//BUGFIX for 09-watermark.pdf

                    function getCoordinateData(newItemIndex, ignoreFirstSplitItem?) {
                      let lastItemIndex = newItemIndex - 1;
                      let newItem = tableContentItems?.[newItemIndex];
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

                    function getMergedCoordinatePaddingObj(lastItem, newItem, gridItemsType) {
                      if (!Array.isArray(lastItem) && !lastItem?.transform) {
                        lastItem = newItem;
                      }

                      let lastItemArray = Array.isArray(lastItem) ? lastItem : [lastItem];
                      let newItemArray = Array.isArray(newItem) ? newItem : [newItem];

                      let mergedCoordinatePaddingObj = gridItemsType == 'cols' ? {
                        'x': getCoordinateFromObj(lastItemArray).x[0] < getCoordinateFromObj(newItemArray).x[0] ? [
                          Math.max(
                            ...lastItemArray.map(item => item.transform[4] + item.width)
                          ),
                          Math.min(
                            ...newItemArray.map(item => item.transform[4])
                          )
                        ] : [
                          Math.max(
                            ...newItemArray.map(item => item.transform[4] + item.width)
                          ),
                          Math.min(
                            ...lastItemArray.map(item => item.transform[4])
                          )
                        ],
                        'y': [
                          Math.min(
                            ...lastItemArray.map(item => item.transform[5]),
                            ...newItemArray.map(item => item.transform[5]),
                          ),
                          Math.max(
                            ...lastItemArray.map(item => item.transform[5] + item.height),
                            ...newItemArray.map(item => item.transform[5] + item.height)
                          )
                        ]
                      } : {
                        'x': [
                          Math.min(
                            ...lastItemArray.map(item => item.transform[4]),
                            ...newItemArray.map(item => item.transform[4])
                          ),
                          Math.max(
                            ...lastItemArray.map(item => item.transform[4] + item.width),
                            ...newItemArray.map(item => item.transform[4] + item.width)
                          )
                        ],
                        'y': getCoordinateFromObj(lastItemArray).y[0] < getCoordinateFromObj(newItemArray).y[0] ? [//DONE
                          Math.max(
                            ...lastItemArray.map(item => item.transform[5] + item.height)
                          ),
                          Math.min(
                            ...newItemArray.map(item => item.transform[5])
                          )
                        ] : [//DONE
                          Math.max(
                            ...newItemArray.map(item => item.transform[5] + item.height),
                          ),
                          Math.min(
                            ...lastItemArray.map(item => item.transform[5])
                          )
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
                        targetGrids: ['cols', 'rows'],//old: previousIntersectsX ? ['cols'] : ['rows']
                        edges: visibleEdges
                      });
                      let previousIsLastItem = previousItem == lastItem;
                      let previousItemChanged = false;
                      let doubleIntersectXCheck = false;

                      if (previousItem?.['hasEOT'] && !isPreviousIntersectsEdges) {
                        let previousIntersectsX = intersectsTop(previousMergedObj, currentMergedObj, false);

                        if (!previousIntersectsX) {
                          previousIntersectsX = intersectsTop(previousMergedObj, [...currentMergedObj, newItem], false);
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
                          previousItem['hasEOT'] = false;
                          if (doubleIntersectXCheck && verticleIntersects && verticleSiblings) {
                            previousItem['hasEOL'] = false;
                            removeLineBreak(previousItem);
                          } else {
                            previousItem['hasEOL'] = true;
                          }

                          if (!previousPaddingTop && previousItem['hasEOL']) {
                            previousItem['paddingTop'] = previousItem.transform[5] - previousItem.height - ((doubleIntersectXCheck && verticleIntersects) || (lastItem == previousItem) ? newItem : lastItem)?.transform?.[5];
                          }
                          updateChars({ item: previousItem, lineBreakNeeded: previousItem['hasEOL'], spaceNeeded: false, fontSpaceWidth: fontSpaceWidths[fontName] });
                          previousItemChanged = true;
                        }
                      }
                      return { verticleIntersects, verticleSiblings, previousIsLastItem, previousItemChanged, doubleIntersectXCheck }
                    }

                    function intersectsEdges({ first, second, targetGrids, edges }) {
                      return targetGrids.some(key => {
                        if (first.length && second.length) {
                          let paddingObj = getMergedCoordinatePaddingObj(first, second, key);
                          let visibleEdges = edges.filter(item => isVisibleVector(item));
                          return filterBlocks(visibleEdges, { ...paddingObj, strictIntersecting: false })
                            .filter(item => !paddingObj.x.includes(item.x) && !paddingObj.y.includes(item.y)) //BUGFIX
                            .length;
                        } else {
                          return false;
                        }
                      })
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
                          charWidth = width * widthAdvanceScale + spacing * fontDirection;
                        }

                        return charWidth;
                      })) : 0;
                    }).flat());
                    maxWidth = (maxWidth + (maxWidth * 0.05));// old : 0.001//need to add an additional threshold because the width of letters varies in the font
                    let maxHeight = Math.min(lastItem.height, newItem.height) / 2;

                    let intersectsX = intersectsTop(newItem, currentMergedObj, true);
                    let targetGrids = (() => {
                      let conditions = {
                        'cols': (lastItem?.transform?.[5] == newItem?.transform?.[5]) || !intersectsX,//false
                        'rows': (lastItem?.transform?.[5] != newItem?.transform?.[5]),
                      };
                      return Object.keys(conditions).filter(key => conditions[key]);
                    })();

                    let visibleEdges = [...(edges || []), ...(rectanglesEdges || [])].filter(item => isVisibleVector(item));
                    let isIntersectsEdges = lastItem?.transform ? intersectsEdges({
                      first: clearEmptyCoordinateItems(currentMergedObj),
                      second: clearEmptyCoordinateItems(newItem),
                      targetGrids,
                      edges: visibleEdges
                    }) : false;
                    let topEdges = filterBlocks(visibleEdges, { 'x': [newItem.transform[4], newItem.transform[4] + newItem.width], 'y': [newItem.y, Infinity], strict: false, withoutOverlap: false, strictIntersecting: true })

                    let intersectingGridItemsObj = (() => {
                      let obj = {};
                      for (let index = 0; index < targetGrids.length; index++) {
                        const gridItem = targetGrids[index];
                        let edgesOnSameAxis = getEdgesOnSameAxis(gridItem);
                        obj[gridItem] = uniqueArr(edgesOnSameAxis, gridItem == 'cols' ? 'x' : 'y');
                      }
                      return obj;
                    })();

                    let hasEOTCondition = (() => {
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

                        return returnOriginalValue ? lastItem['hasEOT'] : jumps ? true : getResults(paddingObj, key); //BUG
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
                      !(//hasEOT condition
                        (lastItem?.transform?.[4] != newItem?.transform?.[4]) &&
                        hasEOTCondition
                      )
                      // (
                      //     tableContentItems?.[currentCoordinate.eolIndex]?.['paddingTop'] ?
                      //         (lastItem.transform[5] - lastItem.height - newItem?.transform?.[5]) == tableContentItems[currentCoordinate.eolIndex]['paddingTop']
                      //         : true
                      // )
                    ) {
                      let res = checkPreviousCoordinate();
                      let newCurrentCoordinate = getCoordinateData(newItemIndex);
                      let newPaddingTop = lastItem.transform[5] - lastItem.height - newItem?.transform?.[5];
                      if (
                        (currentCoordinate.eolIndex == newCurrentCoordinate.eolIndex) &&
                        (currentCoordinate.eotIndex == newCurrentCoordinate.eotIndex)
                      ) {
                        lastItem['paddingTop'] = newPaddingTop;
                        lastItem['hasEOL'] = true;
                        updateChars({ item: lastItem, lineBreakNeeded: lastItem['hasEOL'], spaceNeeded: false, fontSpaceWidth: fontSpaceWidths[fontName] });
                      } else {
                        currentCoordinate = newCurrentCoordinate;
                        let paddingTop = tableContentItems?.[currentCoordinate.eolIndex]?.['paddingTop'];
                        if (paddingTop) {

                          let paddingTopTolerance = 0.005;
                          if (
                            calculateDifference(newPaddingTop, paddingTop) <= paddingTopTolerance
                          ) {
                            lastItem['paddingTop'] = newPaddingTop;
                            let lastItemChars = clearChars({ chars: lastItem.chars });
                            if (!lastItem['hasEOL'] || !lastItemChars[lastItemChars.length - 1].isLineBreak) {
                              lastItem['hasEOL'] = true;
                              updateChars({ item: lastItem, lineBreakNeeded: lastItem['hasEOL'], spaceNeeded: false, fontSpaceWidth: fontSpaceWidths[fontName] });
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
                          //if (!(res.previousItemChanged && res.previousIsLastItem)) {
                          if (
                            (res && res.doubleIntersectXCheck && res.verticleIntersects && res.verticleSiblings) //from checkPreviousCoordinate
                            //(topEdges.length ? !isIntersectsEdges : false)
                          ) {
                            lastItem['hasEOL'] = true;
                            updateChars({ item: lastItem, lineBreakNeeded: true, spaceNeeded: false, fontSpaceWidth: fontSpaceWidths[fontName] });
                          } else {
                            lastItem['hasEOT'] = true;
                            let hasLineBreak = removeLineBreak(lastItem);
                            if (hasLineBreak) {
                              lastItem['hasEOL'] = false;
                            }
                          }
                        }


                      } else {
                        let condition = (() => {
                          let lastItemCopy = lastItem.chars ? trimTableContentItem(lastItem, false) : lastItem;
                          let newItemCopy = newItem.chars ? trimTableContentItem(newItem) : newItem;

                          return targetGrids.every(gridItem => {
                            let axis = gridItem == 'rows' ? 'y' : 'x';
                            let max = gridItem == 'rows' ? maxHeight : maxWidth;
                            let paddingObj = getMergedCoordinatePaddingObj(lastItemCopy, newItemCopy, gridItem);

                            let res = (
                              ((intersectingGridItemsObj[gridItem]?.length > 2) && (gridItem == 'cols') && !isIntersectsEdges) ?
                                lastItemCopy.transform[5] == newItemCopy.transform[5] : (
                                  (Math.abs(paddingObj[axis][0] - paddingObj[axis][1]) <= max) &&
                                  (
                                    (typeof typeValue(lastItem.str) == typeof typeValue(newItem.str)) ? //some fonts do not support numbers
                                      (gridItem == 'rows' ? lastItem.fontName == newItem.fontName : true)
                                      : true
                                  ) &&
                                  (lastItem.height == newItem.height)//old:(gridItem == 'cols' ? lastItem.height == newItem.height : true)
                                )
                            );

                            return res;
                          })
                        })();

                        if (
                          condition
                        ) {
                          lastItem['hasEOT'] = false;
                          if (!lastItem['hasEOL'] && (lastItem?.transform?.[5] != newItem?.transform?.[5])) {
                            lastItem['hasEOL'] = true;
                          }
                        } else {
                          lastItem['hasEOT'] = true;
                        }
                      }
                    }

                  }

                  let lineBreakNeeded = newItem['hasEOL'];
                  newItem['hasEOT'] = newItem['hasEOL'] == newItem['hasEOT'] ? newItem['hasEOL'] ? false : newItem['hasEOT'] : newItem['hasEOT'];//BUGFIX?                               

                  updateChars({ item: newItem, lineBreakNeeded, spaceNeeded: spaceNeeded(newItem, lastItem), fontSpaceWidth: fontSpaceWidths[fontName] });

                  current['pathConstructed'] = false;

                }
              }
              //index++; //BUG no synchronization with pageTextContent.items
            }
            else if ('undefined' === typeof (showed[fn])) {
              showed[fn] = REVOPS[fn];
            }
            else {
            }

          }

          function updateChars(options) {
            let { item, lineBreakNeeded, spaceNeeded, fontSpaceWidth } = options;
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
            let conditionFn = glyph => (typeof glyph == 'object') && (fullClear ? !glyph.isSpace && glyph?.unicode?.trim() : true);

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



          // Function for extracting text coordinates
          function extractCoordinates(data) {

            let hasContent = (item) => item['str'].trim() || item['images']?.length;

            let coordinates = JSON.parse(JSON.stringify(data))
              .reduce((prev, item, index, arr) => {
                let lastItem = prev[prev.length - 1];
                let hasEOT = data?.[index - 1]?.hasEOT;
                let hasEOL = data?.[index - 1]?.hasEOL;
                let [a, b, c, d, x, y] = item.transform;

                //Remove unnecessary spaces
                if (!item.imageName && !item.str?.trim() && (item.hasEOL || item.hasEOT)) {
                  if (item.hasEOL) {
                    lastItem.hasEOL = true;
                    updateChars({ item: lastItem, lineBreakNeeded: lastItem.hasEOL, spaceNeeded: false });
                  } else if (item.hasEOT) {
                    lastItem.hasEOT = true;
                  }
                  return prev;
                }

                if (hasEOT || index == 0) {
                  let newItem = {
                    index: index,
                    str: item.str || '',
                    x,
                    y,
                    width: item.width,
                    height: item.height,
                    chars: item.chars || [],
                    templateStr: item.str || '',
                    transform: item.transform
                  };

                  if (item.imageName) {
                    newItem['images'] = [];
                    newItem['images'].push({ ...item });
                    newItem['templateStr'] = `[-${item.imageName}-]`;
                  }

                  let rectangle = rectangles.find(item => {
                    let inRange = (checkRectangleRanges(item, newItem, { strict: true, strictIntersecting: true, axis: ['x', 'y'] }) as Array<any>).every(item => item.inRange);
                    return inRange;
                  });

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
                      fillColor: rectangle?.fillColor,
                      strokeColor: rectangle?.strokeColor
                    }));
                  }

                } else {

                  let height = Math.max(lastItem.y + lastItem.height, y + item.height) - Math.min(lastItem.y, y);
                  let width = lastItem.y == y ? ((x + item.width) < (lastItem.x + lastItem.width)) ? lastItem.width : ((x + item.width) - lastItem.x) : Math.max(item.width, lastItem.width);
                  let str = [lastItem.str || '', item.str || ''].join('');//old:.join(hasEOL ? '\n' : '');
                  let chars = [...(lastItem.chars || []), ...(item.chars || [])];
                  x = Math.min(lastItem.x, x);

                  Object.assign(lastItem, {
                    str: str,
                    x: x,
                    y: y,
                    width: width,
                    height: height,
                    chars: chars,
                    transform: [height, 0, 0, height, x, y]
                  });

                  if (lastItem['images'] || item.imageName) {
                    lastItem['images'] = [...(lastItem['images'] || []), ...(item.imageName ? [item] : [])];
                  }
                  if (lastItem['templateStr'] || lastItem['images'] || item.imageName) {
                    lastItem['templateStr'] = (lastItem['templateStr'] ? lastItem['templateStr'] : str) + (item.imageName ? `[-${item.imageName}-]` : (item.str || ''));
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



          function determineHeaderRows(options) {
            let { coordinates, rows, edges, rectangles, customConditionFn } = options;

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

            let allPropertiesCounter = countProperties(coordinates?.filter(item => item.str) || []);

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
                let textBlocks = filterBlocks(coordinates.filter(item => item.str), { 'y': range, strictIntersecting: true });

                let currentHeaderCombo = headersCombo[headersCombo.length - 1];
                let lastTruthHeaderCombo = headersCombo?.findLast(item => item.isHeader == true);
                let hasDuplicateCopies = currentHeaderCombo ? textBlocks.some(item => currentHeaderCombo.textBlocks.map(item => JSON.stringify(item)).includes(JSON.stringify(item))) : false; //contains duplicate header values
                if (
                  textBlocks?.length &&
                  (//The number of text items in the current row is greater than the number of items in the previous row (merged headings indicator)
                    currentHeaderCombo &&
                      lastTruthHeaderCombo &&
                      (currentHeaderCombo == lastTruthHeaderCombo) ?
                      currentHeaderCombo.textBlocks.length < textBlocks.length ||
                      hasDuplicateCopies
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

                    let condition = (
                      (currentTargetProperties.length ? currentTargetProperties.every(prop => {
                        let weight = 1 - targetPropertiesWeight[prop];
                        return (
                          Number(propertiesCounter?.[prop]?.[textBlock?.[prop]] || 0) > (
                            Number(Object.values(propertiesCounter?.[prop] || {})?.reduce((prev, cur) => Number(prev) + Number(cur), 0) || 0) * (weight ? weight : 1)
                          )
                        );//the number of cells with target properties exceeds the number of cells with other properties
                      }) : true) &&
                      (targetProperties.length ? (() => {
                        let arr = targetProperties.map(prop => {
                          let propExceptions = ['height'];
                          return propExceptions.includes(prop) ? true : (textBlock?.[prop] != modeProperties[prop]) //the value of the target cell property is not equal to the most frequent value on the page
                        });
                        return arr.length > 2 ? findMod(arr) == 'true' : arr.some(item => item)
                      })() : true) &&
                      (Object.values(propertiesCounter?.['str'] || {}).reduce((prev, cur) => Number(prev) + Number(cur), 0) == textBlocks?.length) && //the number of non-empty cells in the record is greater than the minimum threshold
                      ((edges || rectangles) ? [bottomElements[0], bottomElements[1]].some(item => ['rectangle', 'edge'].includes(item?.vectorType)) : true)//the header cell contains a geometric figure at the bottom
                    ) ||
                      isHeaderIndicator(textBlock?.['str']);//cell value corresponds to a word in the indicator

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

          //Function for defining tables
          function defineGroups(options) {
            let { item, type, axis, tolerance, groups, lineMaxWidth, downcheck } = options;
            axis = Array.isArray(axis) ? axis : [axis];

            let isIntersecting = false;

            let getUnique = (arr, axis) => {
              let data = uniqueArr(arr, ['x', 'y', 'width', 'height']);//old, axis
              let sortedData = multiSort(
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
              let isVisible = isVisibleVector(item);
              switch (type) {
                case 'edges': {
                  if ((item.height < lineMaxWidth) && (item.width > lineMaxWidth)) {
                    setGridItemsTo(group, 'rows', [item.y]);
                    setGridItemsTo(group, 'cols', [item.x, item.x + item.width]);//?
                    if (isVisible) {
                      setGridItemsTo(group, 'edgesRows', [item.y]);
                      setGridItemsTo(group, 'edgesCols', [item.x, item.x + item.width]);//?
                    }
                  } else if ((item.width < lineMaxWidth) && (item.height > lineMaxWidth)) {
                    setGridItemsTo(group, 'cols', [item.x]);
                    setGridItemsTo(group, 'rows', [item.y, item.y + item.height]);//?
                    if (isVisible) {
                      setGridItemsTo(group, 'edgesCols', [item.x]);
                      setGridItemsTo(group, 'edgesRows', [item.y, item.y + item.height]);//?
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

            tableGroups = splitGroups({ groups: tableGroups, globalGroup: pageGroups[0], downcheck: true });
            tableGroups.forEach(group => {
              group.assuredCols = group.cols;
              group.assuredRows = group.rows;
            });

            function splitGroups(options) {
              let { groups, globalGroup, downcheck } = options;
              return groups.reduce((prev, group, index, arr) => {
                let headerRanges = [];

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

                    textBlocks?.forEach(textBlock => {
                      let colIndex = group.cols.findIndex((col, index) => {
                        let res: any = checkRectangleRanges({ x: [textBlock.x, textBlock.x + textBlock.width] }, { x: [group.cols[index], group.cols[index + 1]] }, { axis: 'x', strict: true, strictIntersecting: true });
                        return group.cols[index + 1] && (res.isContained || !res.biggestArgument && res.isIntersecting);
                      });

                      let xRange = [group.cols[colIndex], group.cols[colIndex + 1]];
                      let mergedRows = getMergedArray(globalGroup.rows, group.rows).sort((a, b) => b - a);
                      let startIndex = mergedRows.indexOf(yRange[1]);
                      for (let index = startIndex; index < mergedRows.length; index++) {
                        let row = mergedRows[index];
                        let nextRow = mergedRows[index + 1];

                        let bottomElements = filterBlocks(globalGroup.coordinates, { 'x': xRange, 'y': [row, nextRow], strict: true, withoutOverlap: true, strictIntersecting: true })

                        if (
                          (bottomElements?.length && !bottomElements?.intersectsNextGridItem) && //has elements at the bottom
                          bottomElements.every(item => item.contained) && //are fully included in the header column
                          !groups.some(g => {//does not overlap the headings of other tables
                            return Object.keys(g.headerRows).some(r => {
                              let blocks = filterBlocks(g.headerRows[r], { 'x': xRange, 'y': [row, nextRow], strict: true, withoutOverlap: true, strictIntersecting: true });
                              return !!(blocks.length && !bottomElements?.intersectsNextGridItem);
                            })
                          })
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
                  let lastRange = rowsRanges[rowsRanges.length - 1];
                  [...args].forEach(col => {
                    if (!lastRange.includes(col)) {
                      lastRange.push(col);
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

                  if (
                    rowsRanges.length ? (
                      (
                        targetRange ||
                        splitRowsCondition && !edgesLength
                      ) &&
                      (rowsRanges[rowsRanges.length - 1] ? rowsRanges[rowsRanges.length - 1]?.length : true) //no need to add a new array if the previous one is empty
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
                let rectanglesEdges = uniqueArr(group.rectangles?.reduce((prev, cur) => {
                  let vectors = createLinesFromRectangle(cur, borderSize);
                  prev.push(...vectors);
                  return prev;
                }, []) || [], ['x', 'y', 'width', 'height']);
                group.rectanglesEdges = rectanglesEdges;

                let increasedCoordinates = JSON.parse(JSON.stringify(coordinates));
                let increasedCoordinatesIndexes = [];

                let headerRows = group['headerRows'] = determineHeaderRows({
                  coordinates: group['coordinates'] || [],
                  edges: group['edges'] || [],
                  rectangles: group['rectangles'] || [],
                  rows: group['rows'] || [],
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

                if (headerRanges.length || (tolerance == Infinity)) {
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
                  let gridItemsPairsKeys = Object.keys(gridItemsPairs);
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

                        let firstIndexes = splitArrayByIndex(distancesIndexes, firstSplitIndex == -1 ? 0 : firstSplitIndex)[0];
                        let secondIndexes = splitArrayByIndex(distancesIndexes, secondSplitIndex == -1 ? distances.length - 1 : secondSplitIndex)[1];

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
              gridItems = Object.keys(gridItemsPairs).reduce((prev, cur) => {
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

          function isVisibleVector(item) {
            let color = item?.fillColor || item?.strokeColor;
            let numbers = parseRGB(color);
            return numbers.length ? !(numbers.length == 4 && numbers[numbers.length - 1] == 0) : false;
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
            cols = cols.sort((a, b) => a - b);
            rows = rows.sort((a, b) => a - b);
            let verticalAssuredEdges = [];
            let horizontalAssuredEdges = [];
            let headerRowsKeys = uniqueArr(Object.keys(headerRows).map(item => item.split('-').map(i => +i)).flat());
            assuredEdges = assuredEdges.filter(edge => {
              let isVisible = isVisibleVector(edge);
              if (isVisible) {
                if ((edge.height < lineMaxWidth) && (edge.width > lineMaxWidth)) {
                  //if (!headerRowsKeys.includes(edge.y)) {//!BUG 08-camelot-example.pdf
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
                  let res = (checkRectangleRanges(vector, { x: [edge.x, edge.x + edge.width], y: [edge.y, edge.y + edge.height] }, { axis: ['x', 'y'], strict: true, strictIntersecting: true, tolerance }) as Array<any>).every(res => {
                    return res.isContained || !res.biggestArgument && res.isIntersecting;
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
                  return (calculateDifference(edge.x, item.x) <= positionTolerance) &&
                    (calculateDifference(edge.y, item.y) <= positionTolerance)
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
                // let foundAssuredEdges = multiSort(
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

                  let intersectingElements = verticalAssuredEdges?.filter(vector => {
                    let res: any = checkRectangleRanges(vector, { y: [textBlock.y, textBlock.y + textBlock.height] }, { axis: 'y', strict: true, strictIntersecting: true });
                    return res.isContained || !res.biggestArgument && res.isIntersecting;
                  }) || [];

                  let relatedAssuredEdge = getRelatedAssuredEdge(edge, verticalAssuredEdges);

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
                // let foundAssuredEdges = multiSort(
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

                for (let k = 0; k < coordinates.length; k++) {
                  let textBlock = coordinates[k];
                  let intersectingElements = horizontalAssuredEdges?.filter(vector => {
                    let res: any = checkRectangleRanges(vector, { x: [textBlock.x, textBlock.x + textBlock.width] }, { axis: 'x', strict: true, strictIntersecting: true });
                    return res.isContained || !res.biggestArgument && res.isIntersecting;
                  }) || [];

                  let relatedAssuredEdge = getRelatedAssuredEdge(edge, horizontalAssuredEdges);

                  //let colIndex = horizontalAssuredEdges.length ? findClosestIndex(intersectingElements.map(item => item.y), edge.y, paddingSize * 2) : getGridIndex(cols, edge.x);
                  //colIndex = colIndex == -1 ? getGridIndex(cols, edge.x) : colIndex; //wrong

                  let edgeOnSameAxis = (() => {
                    let res: any = checkRectangleRanges(edge, { x: [textBlock.x, textBlock.x + textBlock.width] }, { axis: 'x', strict: true, strictIntersecting: true })
                    return res.isIntersecting;//old: res.isContained || !res.biggestArgument && res.isIntersecting; //BUGFIX if the text block is located in a merged cell and crosses two edges
                  })();

                  let intersectingGridItems = uniqueArr(intersectingElements, 'y');

                  //exclude header edges for correct definition of table type
                  if (!isHeader(textBlock)) {
                    intersectingGridItems = intersectingGridItems
                      .filter(item => {
                        return !headerRowsKeys.some(key => (checkRectangleRanges({ y: item.y }, { y: key }, { axis: ['y'], strictIntersecting: true, tolerance: 1 }) as Array<any>).every(item => item.isIntersecting))
                      })
                  }

                  if (
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

            let edges = [...verticalEdges, ...horizontalEdges]

            return edges;
          }

          function createLinesFromRectangle(rectangle, borderSize) {
            const { y, x, width, height } = rectangle;
            let isVisible = isVisibleVector(rectangle);
            const strokeColor = isVisible ? "rgba(0,0,0)" : "rgba(0,0,0,0)";
            //Creating lines
            const edges = [
              {
                x: x,
                y: y,
                width: width,
                height: borderSize,
                transform: [1, 0, 0, 1, 0, 0],
                strokeColor: strokeColor
              }, //Top line
              {
                x: x + width,
                y: y,
                width: borderSize,
                height: height,
                transform: [1, 0, 0, 1, 0, 0],
                strokeColor: strokeColor
              }, //Right line
              {
                x: x,
                y: y + height,
                width: width,
                height: borderSize,
                transform: [1, 0, 0, 1, 0, 0],
                strokeColor: strokeColor
              }, //Bottom line
              {
                x: x,
                y: y,
                width: borderSize,
                height: height,
                transform: [1, 0, 0, 1, 0, 0],
                strokeColor: strokeColor
              } //Left line
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

          let intersections = (() => {
            let watermarksIndexes = [];
            let array = [];
            for (let mainIndex = 0; mainIndex < tableContentItems.length; mainIndex++) {
              let item = tableContentItems[mainIndex];
              let getObj = (obj) => {
                return Object.assign({}, obj, (() => {
                  let [a, b, c, d, x, y] = obj.transform;
                  x = obj.x || x;
                  y = obj.y || y;
                  return { x, y }
                })());
              }
              let data = {
                index: mainIndex,
                intersectionsIndexes: tableContentItems.reduce((prev, cur, index) => {

                  if (index != mainIndex) {
                    let inRange = (checkRectangleRanges(getObj(cur), getObj(item), { strict: true, strictIntersecting: true, axis: ['x', 'y'] }) as Array<any>).every(item => item.inRange);
                    if (inRange) {
                      prev.push(index);
                    }
                  }

                  return prev;
                }, [])
              };

              let isIntersectsEdge = (() => {
                let visibleEdges = [...(edges || []), ...(rectanglesEdges || [])].filter(item => isVisibleVector(item));
                return visibleEdges.filter(edge => {
                  let inRange = (checkRectangleRanges(getObj(edge), getObj(item), { strict: true, strictIntersecting: false, axis: ['x', 'y'], tolerance: -(Math.min(edge.width, edge.height)) }) as Array<any>).every(item => item.inRange);
                  return inRange;
                });
              })();

              if (data.intersectionsIndexes.length > 1) {
                if (!watermarksIndexes.includes(mainIndex)) {
                  watermarksIndexes.push(mainIndex);
                }
              }

              if (
                isIntersectsEdge.length
                || ((tableContentItems[mainIndex].str == ' ') && tableContentItems[mainIndex].hasEOT) //exceptions
              ) {
                if (isEmptyCoordinate(tableContentItems[mainIndex])) {//Transfer to the previous object the properties of the deleted object
                  let tableContentItemsRange = tableContentItems.slice(0, mainIndex);
                  let lastItem = tableContentItemsRange.findLast(item => !isEmptyCoordinate(item));
                  lastItem['hasEOT'] = lastItem['hasEOT'] || item['hasEOT'];
                  updateChars({ item: lastItem, lineBreakNeeded: lastItem['hasEOT'] ? false : tableContentItems[mainIndex]['hasEOL'] });
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

          //Defining cell boundaries
          let { tableGroups, pageGroups } = getGroups();

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

            let matrixData = createMatrix(verticles, horizons);

            Object.assign(tableGroup, {
              verticles,
              horizons,
              merges: matrixData.merges,
              mergeAlias: matrixData.mergeAlias,
              matrix: matrixData.matrix,
            })
          }

          return { tableGroups, pageGroups }

        }).then(function ({ tableGroups, pageGroups }) {

          for (let tableIndex = 0; tableIndex < tableGroups.length; tableIndex++) {
            let tableGroup = tableGroups[tableIndex];

            function extractTableData(options) {
              let {
                verticles,
                horizons,
                coordinates,
                merges = {},
                mergeAlias = {},
                headerRows = {},
                edges
              } = options;
              // Sorting by requirements
              verticles = verticles.sort((a, b) => a.x - b.x);
              horizons = horizons.sort((a, b) => b.y - a.y); // Inverted y-axis
              coordinates = multiSort(
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

                // Add text to the table
                if (tablePos[row][col] !== null && Math.abs(tablePos[row][col] - y) > 5) {
                  table.array[row][col]['str'] += "\n";
                }
                tablePos[row][col] = y;
                table.array[row][col]['str'] += item.str;
                if (item.fillColor) {
                  table.array[row][col]['fillColor'] = item.fillColor;
                }
              }

              // Generate HTML table
              table.html = (() => {
                const headerRowCount = Object.keys(headerRows).length; // Determine the number of header rows
                let borderColor = findMod(edges?.map(item => item.strokeColor)?.filter(item => item)) || 'rgb(0,0,0)';
                let html = `<table style="border-collapse:collapse;">` + '\n';
                html += '<thead>\n';

                for (let r = 0; r < table.array.length; r++) {
                  let tagName = r < headerRowCount ? 'th' : 'td';

                  if (r === headerRowCount) {
                    html += '</thead>\n<tbody>\n';
                  }

                  html += `<tr>\n`;
                  for (let c = 0; c < table.array[r].length; c++) {
                    const r_c = `${r}-${c}`;

                    if (mergeAlias[r_c]) {
                      continue;
                    }
                    let fillColor = table.array[r][c]['fillColor'];
                    let cell = `<${tagName} style="border: 1px solid ${borderColor};${fillColor ? ` background-color: ${fillColor};` : ''}"`;
                    if (merges[r_c]) {
                      if (merges[r_c].width > 1) {
                        cell += ` colspan="${merges[r_c].width}"`;
                      }
                      if (merges[r_c].height > 1) {
                        cell += ` rowspan="${merges[r_c].height}"`;
                      }
                    }
                    cell += `>${table.array[r][c]['str'].replace(/\n/gim, '<br>')}</${tagName}>\n`;
                    html += cell;
                  }
                  html += '</tr>\n';
                }

                html += '</tbody>\n</table>';

                return html;
              })();

              // Generate JSON table
              table.json = (() => {
                const headerRowCount = Object.keys(headerRows).length;
                let headerRowsKeys = Object.keys(tableGroup.headerRows).sort((a: any, b: any) => b - a);
                let clonedArray = JSON.parse(JSON.stringify(table.array));
                let formatHeader = (str) => {
                  return str.replace(/\n/gim, ' ');
                }

                // Process merged cells (clones content in merged cells)
                Object.keys(merges).forEach((key) => {
                  const { row, col, arr } = merges[key];
                  const mainContent = table.array[row][col]['str'];
                  arr.forEach((cellKey) => {
                    const [mergeRow, mergeCol] = cellKey.split("-").map(Number);
                    if (mergeRow !== row || mergeCol !== col) {
                      clonedArray[mergeRow][mergeCol]['str'] = mainContent;
                    }
                  });
                });

                function generateHeaderPaths(headers) {
                  let paths = [];

                  // Going through each level of headings
                  for (let i = 0; i < headers[0].length; i++) {
                    let path = formatHeader(headers[0][i].str);

                    // Go through each level, starting with the second one
                    for (let j = 1; j < headers.length; j++) {
                      let currentHeader = formatHeader(headers[j][i].str);
                      if (currentHeader !== formatHeader(headers[j - 1][i].str)) {
                        path += `.${currentHeader}`;
                      }
                    }

                    paths.push(path);
                  }

                  return paths;
                }

                let headerPaths = generateHeaderPaths(clonedArray.slice(0, headerRowsKeys.length));

                let jsonData = clonedArray.slice(headerRowCount).map(row => {
                  let obj = {};
                  row.forEach((col, colIndex) => {
                    if (row[colIndex].str) {
                      setValueByPath(obj, headerPaths[colIndex], row[colIndex].str);
                    }
                  });
                  return obj
                })

                return jsonData;
              })();

              return {
                table,
                width: colsCount,
                height: rowsCount,
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

    for (var i = 1; i <= numPages; i++) {
      lastPromise = lastPromise.then(loadPage.bind(null, i));
    }
    return lastPromise.then(function () {
      return result;
    });
  };

  async function extractorRun(options) {
    let {dataArray, onProgress, onSuccess, onError} = options;
    let documentLoadingTask = await pdfjs.getDocument({ data: dataArray });
    let documentProxy = await documentLoadingTask.promise;

    try {
      let extractorResults = await extractor(documentProxy, onProgress);
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

  return { extractorRun};
}
