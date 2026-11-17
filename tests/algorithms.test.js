import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSort } from '../src/algorithms/mergeSort.js';
import { bubbleSort } from '../src/algorithms/bubbleSort.js';
import { compareBy } from '../src/algorithms/compare.js';
import { topologicalSort, naiveTopologicalSort } from '../src/algorithms/topologicalSort.js';
import { planSemesters, MAX_CREDITS } from '../src/algorithms/planner.js';
import { validateCourseList } from '../src/validate.js';

function course(id, credits, priority, prerequisites = []) {
  return { id, name: id, credits, priority, difficulty: 3, deadline: '2027-01-01', prerequisites };
}

const curriculum = [
  course('A', 4, 5),
  course('B', 3, 4),
  course('C', 4, 3, ['A']),
  course('D', 3, 5, ['A', 'B']),
  course('E', 6, 2, ['C', 'D']),
  course('F', 6, 1),
  course('G', 6, 1),
];

test('merge sort and bubble sort give the same result as the built-in sort', () => {
  const numbers = Array.from({ length: 300 }, () => Math.floor(Math.random() * 50));
  const ascending = (a, b) => a - b;
  const expected = [...numbers].sort(ascending);

  assert.deepEqual(mergeSort(numbers, ascending), expected);
  assert.deepEqual(bubbleSort(numbers, ascending), expected);
});

test('merge sort is stable', () => {
  const items = [
    { key: 2, label: 'a' },
    { key: 1, label: 'b' },
    { key: 2, label: 'c' },
    { key: 1, label: 'd' },
  ];
  const sorted = mergeSort(items, (x, y) => x.key - y.key);
  assert.deepEqual(sorted.map((item) => item.label), ['b', 'd', 'a', 'c']);
});

test('ranking by priority puts the highest first and breaks ties by course ID', () => {
  const courses = [course('X2', 3, 4), course('X1', 3, 4), course('X3', 3, 5)];
  const ranked = mergeSort(courses, compareBy('priority'));
  assert.deepEqual(ranked.map((c) => c.id), ['X3', 'X1', 'X2']);
});

test('both topological sorts place every prerequisite before its course', () => {
  for (const sort of [topologicalSort, naiveTopologicalSort]) {
    const order = sort(curriculum);
    assert.equal(order.length, curriculum.length);
    for (const c of curriculum) {
      for (const prereqId of c.prerequisites) {
        assert.ok(order.indexOf(prereqId) < order.indexOf(c.id), `${prereqId} should come before ${c.id}`);
      }
    }
  }
});

test('plan keeps each semester within the credit limit and after its prerequisites', () => {
  const plan = planSemesters(curriculum, 'priority');
  assert.equal(plan.ok, true);

  const semesterOf = new Map();
  for (const semester of plan.semesters) {
    assert.ok(semester.credits <= MAX_CREDITS);
    for (const c of semester.courses) {
      semesterOf.set(c.id, semester.number);
    }
  }

  assert.equal(semesterOf.size, curriculum.length);
  for (const c of curriculum) {
    for (const prereqId of c.prerequisites) {
      assert.ok(semesterOf.get(prereqId) < semesterOf.get(c.id));
    }
  }
});

test('a course that would go over the credit limit is deferred', () => {
  const plan = planSemesters(curriculum, 'priority');
  const first = plan.semesters[0];

  assert.deepEqual(first.courses.map((c) => c.id), ['A', 'B', 'F']);
  assert.deepEqual(first.deferred, ['G']);
  assert.equal(first.credits, 13);
});

test('a circular dependency is reported with the courses in the loop', () => {
  const courses = [
    course('A', 3, 3),
    course('B', 3, 3, ['A', 'D']),
    course('C', 3, 3, ['B']),
    course('D', 3, 3, ['C']),
    course('E', 3, 3, ['D']),
  ];
  const plan = planSemesters(courses, 'priority');

  assert.equal(plan.ok, false);
  assert.deepEqual(plan.blocked, ['B', 'C', 'D', 'E']);
  assert.deepEqual(plan.cycle, ['C', 'D', 'B', 'C']);
  assert.equal(topologicalSort(courses), null);
});

test('validation rejects missing and self prerequisites', () => {
  const errors = validateCourseList([course('A', 3, 3, ['A']), course('B', 3, 3, ['Z'])]);
  assert.deepEqual(errors, ['A: A cannot be a prerequisite of itself', 'B: Prerequisite Z does not exist']);
});
