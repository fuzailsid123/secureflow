import { buildGraph } from './graph.js';

export function topologicalSort(courses) {
  const { dependents, inDegree } = buildGraph(courses);
  const queue = courses.filter((course) => inDegree.get(course.id) === 0).map((course) => course.id);
  const order = [];
  let head = 0;

  // A head index is used instead of queue.shift(), because shift() is O(n)
  while (head < queue.length) {
    const id = queue[head];
    head++;
    order.push(id);

    for (const dependentId of dependents.get(id)) {
      inDegree.set(dependentId, inDegree.get(dependentId) - 1);
      if (inDegree.get(dependentId) === 0) {
        queue.push(dependentId);
      }
    }
  }

  return order.length === courses.length ? order : null;
}

export function naiveTopologicalSort(courses) {
  const { dependents, inDegree } = buildGraph(courses);
  const placed = new Set();
  const order = [];

  while (order.length < courses.length) {
    const next = courses.find((course) => !placed.has(course.id) && inDegree.get(course.id) === 0);
    if (!next) {
      return null;
    }

    placed.add(next.id);
    order.push(next.id);
    for (const dependentId of dependents.get(next.id)) {
      inDegree.set(dependentId, inDegree.get(dependentId) - 1);
    }
  }

  return order;
}
