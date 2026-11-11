import { sortArrayOfObjects, uniqueArr } from '@unsonet/js-utils';

/**
 * Drop-in replacements for two things `defineGroups` rebuilt from scratch on
 * EVERY inserted item (O(n log n) each, so O(n² log n) per page group):
 *
 *   getUnique([...list, item], ['y','x'])                      ->  addToBlockList(list, item)
 *   [...new Set([...list, ...values])].sort((a, b) => a - b)   ->  addToGridList(list, values)
 *
 * Both give the same result as the old expressions. A list is only updated
 * incrementally when it is known to be the product of these functions (tracked
 * in WeakMaps); anything else, or any non-finite coordinate, goes through the
 * original expression, so unusual data keeps its old behaviour.
 *
 * Both functions return a new array when something changed (the old code always
 * returned a new array) and never mutate the array they were given.
 */

const BLOCK_KEYS = ['x', 'y', 'width', 'height', 'fillColor', 'strokeColor'];
const blockKeyOf = (item: any): string => BLOCK_KEYS.map(key => item[key]).join('|'); // same key as uniqueArr

const knownBlockLists = new WeakMap<any[], Set<string>>();
const knownGridLists = new WeakSet<number[]>();

const isDefaultAxis = (axis: string[]): boolean => axis.length === 2 && axis[0] === 'y' && axis[1] === 'x';

function addToBlockListSlow(list: any[] | undefined, item: any, axis: string[]): any[] {
  let itemArr = (Array.isArray(item) || (item == undefined) ? (item || []) as Array<any>: [item]);
  const unique = uniqueArr([...(list || []), ...itemArr], BLOCK_KEYS);
  const sorted = sortArrayOfObjects(unique, axis.map(field => ({ field, order: 'asc' })));

  if (isDefaultAxis(axis) && sorted.every((entry: any) => Number.isFinite(entry?.y) && Number.isFinite(entry?.x))) {
    knownBlockLists.set(sorted, new Set(sorted.map(blockKeyOf)));
  }
  return sorted;
}

/** Old: uniqueArr by x/y/width/height/fillColor/strokeColor (later duplicate replaces the earlier one in place), then stable sort by y, then x. */
export function addToBlockList(list: any[] | undefined, item: any, axis: string[] = ['y', 'x']): any[] {
  const keys = list ? knownBlockLists.get(list) : undefined;

  if (!list || !keys || !isDefaultAxis(axis) || !Number.isFinite(item?.y) || !Number.isFinite(item?.x)) {
    return addToBlockListSlow(list, item, axis);
  }

  // first position whose (y, x) is greater than the item's: the item is the last input element,
  // so a stable sort puts it after everything that compares equal
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const entry = list[middle];
    if (entry.y > item.y || (entry.y === item.y && entry.x > item.x)) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }

  const key = blockKeyOf(item);
  const next = list.slice();

  if (keys.has(key)) {
    // duplicate: it takes the place of the earlier entry with the same key (same y and x, so right next to `low`)
    let position = low - 1;
    while (position >= 0 && list[position].y === item.y && list[position].x === item.x && blockKeyOf(list[position]) !== key) {
      position--;
    }
    if (position < 0 || blockKeyOf(list[position]) !== key) {
      return addToBlockListSlow(list, item, axis);
    }
    next[position] = item;
  } else {
    keys.add(key);
    next.splice(low, 0, item);
  }

  knownBlockLists.delete(list);
  knownBlockLists.set(next, keys);
  return next;
}

const MAX_INCREMENTAL_VALUES = 16;

/** Old: unique numbers, sorted ascending. */
export function addToGridList(list: number[] | undefined, values: number[] | number): number[] {
  let valuesArr: number[] = (Array.isArray(values) || (values == undefined) ? (values || []) as Array<any>: [values]);
  if (!list || !knownGridLists.has(list) || valuesArr.length > MAX_INCREMENTAL_VALUES || !valuesArr.every(Number.isFinite)) {
    const result = [...new Set([...(list || []), ...valuesArr])].sort((a, b) => a - b);
    if (result.every(Number.isFinite)) {
      knownGridLists.add(result);
    }
    return result;
  }

  let next = list;
  for (const rawValue of valuesArr) {
    const value = rawValue === 0 ? 0 : rawValue; // a Set stores -0 as +0
    let low = 0;
    let high = next.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (next[middle] < value) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    if (next[low] === value) {
      continue; // already there (Set semantics)
    }
    if (next === list) {
      next = list.slice();
    }
    next.splice(low, 0, value);
  }

  if (next !== list) {
    knownGridLists.delete(list);
    knownGridLists.add(next);
  }
  return next;
}
