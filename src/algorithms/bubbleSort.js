export function bubbleSort(items, compare) {
  const result = items.slice();

  for (let end = result.length - 1; end > 0; end--) {
    let swapped = false;

    for (let i = 0; i < end; i++) {
      if (compare(result[i], result[i + 1]) > 0) {
        [result[i], result[i + 1]] = [result[i + 1], result[i]];
        swapped = true;
      }
    }

    if (!swapped) {
      break;
    }
  }

  return result;
}
