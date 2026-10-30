export const headerIndicatorWords: { [key: string]: Array<string> } = {
  eng: ['name', 'surname', 'last name', 'first name', 'full name', 'user name', 'age', 'gender', 'sex', 'relationship', 'nationality', 'status', 'time', 'timeframe', 'period', 'duration', 'dilution', 'viscosity', 'resistance', 'density', 'destination', 'term', 'deadline', 'release', 'released', 'receive', 'received', 'effective', 'date', 'dates', 'start date', 'end date', 'birth day', 'date of birth', 'dob', 'description', 'title', 'label', 'subject', 'interest', 'experience', 'note', 'notes', 'comment', 'comments', 'header', 'column', 'col', 'area', 'country', 'city', 'town', 'zip', 'zip code', 'postal code', 'location', 'region', 'address', 'address line', 'street address', 'mail', 'e-mail', 'email', 'email address', 'phone', 'phone number', 'mobile', 'tel', 'telephone', 'contact', 'contacts', 'site', 'website', 'web', 'url', 'uri', 'path', 'parent', 'parents', 'operation', 'source', 'education', 'position', 'occupation', 'role', 'team', 'designation', 'department', 'volume', 'sold', 'unsold', 'average', 'span', 'currency', 'cost', 'price', 'unit price', 'price per unit', 'offer', 'order', 'budget', 'total', 'sub total', 'total price', 'discount', 'donation', 'quality', 'quantity', 'amount', 'salary', 'revenue', 'color', 'colour', 'speed', 'distance', 'valuation', 'value', 'size', 'width', 'height', 'length', 'weight', 'depth', 'population', 'range', 'queue', 'index', 'id', '#', '№', 'no', 'number', 'hash', 'year', 'month', 'day', 'height', 'weight', 'length', 'model', 'category', 'ticker', 'employee', 'artist', 'author', 'director', 'owner', 'genre', 'commodity', 'product', 'item', 'freight', 'feature', 'plan', 'task', 'issue', 'group', 'company', 'sector', 'division', 'district', 'customer', 'vendor', 'brand', 'salesman', 'assignee', 'requester', 'contributor', 'office', 'rate', 'balance', 'rating', 'rank', 'fee', 'score', 'grade', 'type', 'class', 'count', 'runs', 'progress', 'points', 'coins', 'expenses', 'priority', 'trend', 'engagement', 'percentage', 'profit', 'locale', 'language', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sun', 'mon', 'tues', 'wed', 'thur', 'fri', 'sat', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'],
  zho: ['稀釋倍數'],
};

export const OPS: { [key: string]: number } = {
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
}
export const PAGE_BACKGROUND = 'rgb(255,255,255)';

export const LEADER_CHARS = '[.\\u00B7\\u2022\\u2024\\u2026\\u2027\\u2219\\u22C5_\\-\\u2013\\u2014=~*]';
export const LEADER_RUN = new RegExp(`(${LEADER_CHARS})(?:\\s?\\1){4,}`, 'u');
export const LEADER_THEN_CONTENT = new RegExp(`(${LEADER_CHARS})(?:\\s?\\1){4,}\\s*[\\p{L}\\p{N}]`, 'u');
export const LEADER_TRAILING_RUN = new RegExp(
  `[ \\t]*(${LEADER_CHARS})(?:[ \\t]?\\1){4,}[ \\t]*(?=\\r?$)`,
  'gmu'
);
// Leader runs come in different shapes (". . . ." with spaces or "...." without them,
// depending on how the PDF positions the glyphs): spaces between the fillers are dropped.
export const LEADER_RUN_IN_TEXT = new RegExp(`(${LEADER_CHARS})(?:[ \\t\\u00A0]?\\1){4,}`, 'gu');
export const normalizeLeaderRuns = (text: string): string =>
  text.replace(LEADER_RUN_IN_TEXT, run => run.replace(/[ \t\u00A0]+/g, ''));
// Строка целиком из «заполнителей» (........ / . . . .), минимум 3 символа.
export const LEADER_ONLY_TEXT = new RegExp(`^(?:${LEADER_CHARS}|\\s)+$`, 'u');
export const LEADER_GLYPH_REGEXP = new RegExp(`^(?:${LEADER_CHARS})$`, 'u');

export function isLeaderOnlyText(str?: string): boolean {
  if (!str || !LEADER_ONLY_TEXT.test(str)) {
    return false;
  }
  return str.replace(/\s+/g, '').length >= 3;
}

export function isLeaderGlyph(glyph: any): boolean {
  return (
    !!glyph &&
    typeof glyph === 'object' &&
    typeof glyph.unicode === 'string' &&
    LEADER_GLYPH_REGEXP.test(glyph.unicode.trim())
  );
}

/**
 * Отрицательное число TJ между двумя лидер-глифами — это пробел в строке ". . . .",
 * но в str оно не попадает. Заменяем его синтетическим пробельным глифом с тем же смещением,
 * чтобы str и chars описывали то, что нарисовано.
 */
export function materializeLeaderGaps(
  entries: any[],
  options: { fontSize: number; charSpacing: number; fontDirection: number; vertical: boolean },
): any[] {
  const { fontSize, charSpacing, fontDirection, vertical } = options;
  const unitScale = fontSize * 0.001;

  if (!Array.isArray(entries) || vertical || !(unitScale > 0)) {
    return entries;
  }

  let changed = false;
  const minimalGap = fontSize * 0.15;
  // Зазор шире порога ячейки (его использует segmentPreliminaryItem) — это граница ячеек, а не ритм лидера.
  // Если закрыть его синтетическим пробелом, ячейки слипнутся (три «-» в трёх колонках)
  const maximalGap = Math.max(fontSize * 0.6, 2);

  const result = entries.map((entry, index) => {
    if (typeof entry !== 'number' || entry >= 0) {
      return entry;
    }

    const advance = -entry * unitScale;// смещение вправо в единицах страницы
    if (
      advance < minimalGap ||
      advance > maximalGap ||
      !isLeaderGlyph(entries[index - 1]) ||
      !isLeaderGlyph(entries[index + 1])
    ) {
      return entry;
    }

    changed = true;

    // handleCharsArgs считает charWidth = width * unitScale + charSpacing * fontDirection,
    // поэтому ширину подбираем так, чтобы смещение осталось ровно прежним
    return {
      originalCharCode: 32,
      fontChar: ' ',
      unicode: ' ',
      accent: null,
      width: (advance - charSpacing * fontDirection) / unitScale,
      isSpace: false,
      isInFont: true,
      isLineBreak: false,
    };
  });

  return changed ? result : entries;
}

