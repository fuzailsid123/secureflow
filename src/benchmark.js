import { mergeSort } from './algorithms/mergeSort.js';
import { bubbleSort } from './algorithms/bubbleSort.js';
import { compareBy } from './algorithms/compare.js';
import { topologicalSort, naiveTopologicalSort } from './algorithms/topologicalSort.js';

const SIZES = [250, 500, 1000, 2000, 4000];
const LINKS_PER_COURSE = 5;
const RUNS = 3;

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function randomDate() {
  const month = String(randomInt(1, 12)).padStart(2, '0');
  const day = String(randomInt(1, 28)).padStart(2, '0');
  return `2027-${month}-${day}`;
}

function randomCourses(count) {
  const courses = [];

  for (let i = 0; i < count; i++) {
    const prerequisites = new Set();
    const linkCount = Math.min(i, LINKS_PER_COURSE);
    while (prerequisites.size < linkCount) {
      prerequisites.add(`C${randomInt(0, i - 1)}`);
    }

    courses.push({
      id: `C${i}`,
      name: `Course ${i}`,
      credits: randomInt(1, 4),
      priority: randomInt(1, 5),
      difficulty: randomInt(1, 5),
      deadline: randomDate(),
      prerequisites: [...prerequisites],
    });
  }

  return courses;
}

function bestTime(work) {
  let best = Infinity;
  for (let run = 0; run < RUNS; run++) {
    const start = performance.now();
    work();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

function countComparisons(sort, items, compare) {
  let count = 0;
  sort(items, (a, b) => {
    count++;
    return compare(a, b);
  });
  return count;
}

export function runBenchmark() {
  const compare = compareBy('priority');
  const sorting = [];
  const scheduling = [];

  for (const size of SIZES) {
    const courses = randomCourses(size);

    sorting.push({
      size,
      mergeMs: bestTime(() => mergeSort(courses, compare)),
      bubbleMs: bestTime(() => bubbleSort(courses, compare)),
      mergeComparisons: countComparisons(mergeSort, courses, compare),
      bubbleComparisons: countComparisons(bubbleSort, courses, compare),
    });

    scheduling.push({
      size,
      links: courses.reduce((total, course) => total + course.prerequisites.length, 0),
      topoMs: bestTime(() => topologicalSort(courses)),
      naiveMs: bestTime(() => naiveTopologicalSort(courses)),
    });
  }

  return { sorting, scheduling };
}
