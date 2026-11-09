import { checkRectangleRanges } from '@unsonet/js-utils';

export interface FilterBlocksOptions {
  x?: number[];
  y?: number[];
  strict?: boolean;
  strictIntersecting?: boolean;
  tolerance?: number;
  withoutOverlap?: boolean;
  filterFn?: (block: any, index: number, blocks: any[]) => unknown;
}

export type FilteredBlocks = any[] & { intersectsNextGridItem: boolean };

const deepCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const hasFiniteBox = (block: any): boolean =>
  Number.isFinite(block?.x) &&
  Number.isFinite(block?.y) &&
  Number.isFinite(block?.width) &&
  Number.isFinite(block?.height);

/**
 * Returns deep copies of the blocks that fall into the given x/y ranges, each
 * annotated with `contained`.
 *
 * Previously the whole input array was JSON-cloned first and filtered after;
 * with thousands of blocks and several calls per text item / table row that
 * clone dominated the run time. Now the check runs on the originals and only
 * the survivors are cloned. The result is identical, with one guard: a block
 * whose x/y/width/height is not a finite number goes through the old
 * "clone first" path, because JSON turns NaN/undefined into null/missing and
 * the predicate has to keep seeing exactly that.
 *
 * Assumption: checkRectangleRanges does not mutate its arguments.
 */
export function filterBlocks(blocks: any[], options: FilterBlocksOptions): FilteredBlocks {
  const { x, y, withoutOverlap, strict, filterFn, strictIntersecting, tolerance } = options;
  const filteredBlocks: any[] = [];

  blocks.forEach((original, index) => {
    const needsRoundTrip = !hasFiniteBox(original);
    const probe = needsRoundTrip ? deepCopy(original) : original;

    const xInRange: any = checkRectangleRanges(probe, { x, y }, { axis: 'x', strict, strictIntersecting, tolerance });
    const yInRange: any = checkRectangleRanges(probe, { x, y }, { axis: 'y', strict, strictIntersecting, tolerance });

    if (!(xInRange?.inRange && yInRange?.inRange)) {
      return;
    }

    const block = needsRoundTrip ? probe : deepCopy(original);
    block.contained = [xInRange, yInRange].every(
      (item: any) => item.isContained && (item.biggestArgument == 1 || item.biggestArgument == null)
    );

    if (filterFn && !filterFn(block, index, blocks)) {
      return;
    }

    filteredBlocks.push(block);
  });

  let intersectsNextGridItem = false;

  if (withoutOverlap && (x || y)) {
     // Check overlap in x-axis or y-axis
    const axis = x ? 'y' : 'x';
    for (let i = 0; i < filteredBlocks.length; i++) {
      for (let j = i + 1; j < filteredBlocks.length; j++) {
        const overlap: any = checkRectangleRanges(filteredBlocks[i], filteredBlocks[j], { axis, strictIntersecting: true });
        if (overlap.inRange && filteredBlocks[i].index != filteredBlocks[j].index) {
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

  return filteredBlocks as FilteredBlocks;
}
