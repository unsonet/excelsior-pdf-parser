/**
 * One-dimensional bucket index.
 *
 * It answers "which items MAY overlap the range [from, to]" without scanning
 * all items. The answer is a superset: callers keep their original (exact)
 * predicate and run it on the returned candidates only, so the final result is
 * the same as the old full scan as long as every stored range is at least as
 * wide as the geometry that predicate looks at.
 *
 * Candidates come back in ascending item order, exactly like Array#filter would
 * have produced them (several callers depend on that order for tie-breaking).
 */

export interface RangeIndex {
  /** Ascending item indexes whose stored range overlaps [from, to]. */
  query(from: number, to: number): number[];
}

export type RangeGetter<T> = (item: T, index: number) => readonly [number, number] | null | undefined;

const DEFAULT_BUCKET_SIZE = 32;
const MAX_BUCKETS_PER_ITEM = 64;

export function createRangeIndex<T>(
  items: ReadonlyArray<T>,
  getRange: RangeGetter<T>,
  bucketSize: number = DEFAULT_BUCKET_SIZE
): RangeIndex {
  const buckets = new Map<number, number[]>();
  // Items we cannot (or should not) bucket are always returned, so nothing is lost.
  const alwaysCandidates: number[] = [];
  const lows = new Float64Array(items.length);
  const highs = new Float64Array(items.length);

  items.forEach((item, index) => {
    const range = item == null ? null : getRange(item, index);
    const first = range ? range[0] : NaN;
    const second = range ? range[1] : NaN;

    if (!Number.isFinite(first) || !Number.isFinite(second)) {
      alwaysCandidates.push(index);
      return;
    }

    const low = Math.min(first, second);
    const high = Math.max(first, second);
    const firstBucket = Math.floor(low / bucketSize);
    const lastBucket = Math.floor(high / bucketSize);

    if (lastBucket - firstBucket > MAX_BUCKETS_PER_ITEM) {
      alwaysCandidates.push(index);
      return;
    }

    lows[index] = low;
    highs[index] = high;
    for (let bucket = firstBucket; bucket <= lastBucket; bucket++) {
      const list = buckets.get(bucket);
      if (list) {
        list.push(index);
      } else {
        buckets.set(bucket, [index]);
      }
    }
  });

  const seenAt = new Uint32Array(items.length);
  let generation = 0;

  return {
    query(from: number, to: number): number[] {
      const low = Math.min(from, to);
      const high = Math.max(from, to);

      if (!Number.isFinite(low) || !Number.isFinite(high)) {
        return items.map((_, index) => index);
      }

      generation = (generation + 1) >>> 0;
      if (generation === 0) {
        seenAt.fill(0);
        generation = 1;
      }

      const result: number[] = alwaysCandidates.slice();
      const visit = (list: number[]): void => {
        for (const index of list) {
          if (seenAt[index] === generation) {
            continue;
          }
          seenAt[index] = generation;
          if (highs[index] >= low && lows[index] <= high) {
            result.push(index);
          }
        }
      };

      const firstBucket = Math.floor(low / bucketSize);
      const lastBucket = Math.floor(high / bucketSize);

      if (lastBucket - firstBucket > buckets.size) {
        // A very tall query: walk the existing buckets instead of every possible one.
        buckets.forEach((list, bucket) => {
          if (bucket >= firstBucket && bucket <= lastBucket) {
            visit(list);
          }
        });
      } else {
        for (let bucket = firstBucket; bucket <= lastBucket; bucket++) {
          const list = buckets.get(bucket);
          if (list) {
            visit(list);
          }
        }
      }

      return result.sort((first, second) => first - second);
    }
  };
}

/**
 * Range exactly as `checkRectangleRanges` reads a block along one axis:
 *  - a falsy start (0, NaN, undefined) means "unbounded" on that axis,
 *  - a falsy size counts as 0.
 * Returns null for "unbounded": the index then treats the item as a candidate
 * for every query, and a null query range must be answered with "everything".
 * Use this one for every index that pre-filters a checkRectangleRanges call.
 */
export function getCheckedRange(start: number | undefined, size: number | undefined): [number, number] | null {
  return start ? [start, start + (size || 0)] : null;
}

/**
 * @deprecated not exact for start === 0 / NaN (checkRectangleRanges treats those as unbounded).
 * Use getCheckedRange. [start, start + size] normalised and widened by `margin`.
 */
export function getBoxRange(start: number, size: number, margin: number = 1): [number, number] {
  const end = start + size;
  return [Math.min(start, end) - margin, Math.max(start, end) + margin];
}

/**
 * @deprecated guesses the device box; with getDeviceBBox available use
 * getCheckedRange(box.y, box.height) on the real box instead.
 * Y-range that surely contains the glyph box of a pdf.js-style text item
 * (`transform`, `width` along the reading direction, `height` along the ascent
 * direction), for horizontal and rotated text alike. The padding is generous on
 * purpose: this range is only a pre-filter, the exact predicate runs afterwards.
 */
export function getTextYRange(
  transform: ArrayLike<number> | null | undefined,
  width: number,
  height: number,
  margin: number = 1
): [number, number] | null {
  if (!transform || transform.length < 6) {
    return null;
  }

  const [a, b, c, d] = [transform[0], transform[1], transform[2], transform[3]];
  const baselineY = transform[5];
  const readingLength = Math.hypot(a, b) || 1;
  const ascentLength = Math.hypot(c, d) || 1;
  const alongReading = (Number(width) || 0) * (b / readingLength);
  const alongAscent = (Number(height) || 0) * (d / ascentLength);
  const offsets = [0, alongReading, alongAscent, alongReading + alongAscent];
  const padding = Math.max(Math.abs(Number(height) || 0), 1) * 1.5 + margin;

  return [baselineY + Math.min(...offsets) - padding, baselineY + Math.max(...offsets) + padding];
}
