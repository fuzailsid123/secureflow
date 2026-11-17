import { buildGraph } from './graph.js';
import { mergeSort } from './mergeSort.js';
import { compareBy } from './compare.js';

export const MAX_CREDITS = 18;

export function planSemesters(courses, sortBy) {
  const courseById = new Map(courses.map((course) => [course.id, course]));
  const { dependents, inDegree } = buildGraph(courses);
  const compare = compareBy(sortBy);

  let available = courses.filter((course) => inDegree.get(course.id) === 0);
  const semesters = [];
  let placedCount = 0;

  while (available.length > 0) {
    const ranked = mergeSort(available, compare);
    const taken = [];
    const deferred = [];
    let credits = 0;

    for (const course of ranked) {
      if (credits + course.credits <= MAX_CREDITS) {
        taken.push(course);
        credits += course.credits;
      } else {
        deferred.push(course);
      }
    }

    const unlocked = [];
    for (const course of taken) {
      for (const dependentId of dependents.get(course.id)) {
        inDegree.set(dependentId, inDegree.get(dependentId) - 1);
        if (inDegree.get(dependentId) === 0) {
          unlocked.push(courseById.get(dependentId));
        }
      }
    }

    semesters.push({
      number: semesters.length + 1,
      credits,
      courses: taken,
      deferred: deferred.map((course) => course.id),
    });
    placedCount += taken.length;
    available = [...deferred, ...unlocked];
  }

  if (placedCount < courses.length) {
    const blocked = courses.filter((course) => inDegree.get(course.id) > 0);
    return {
      ok: false,
      cycle: findCycle(blocked),
      blocked: blocked.map((course) => course.id),
    };
  }

  return {
    ok: true,
    semesters,
    order: semesters.flatMap((semester) => semester.courses.map((course) => course.id)),
  };
}

// Every blocked course still has a blocked prerequisite, so walking backwards must repeat a course
function findCycle(blocked) {
  const blockedById = new Map(blocked.map((course) => [course.id, course]));
  const path = [];
  const positionInPath = new Map();
  let current = blocked[0];

  while (!positionInPath.has(current.id)) {
    positionInPath.set(current.id, path.length);
    path.push(current.id);
    const blockedPrereqId = current.prerequisites.find((id) => blockedById.has(id));
    current = blockedById.get(blockedPrereqId);
  }

  const cycle = path.slice(positionInPath.get(current.id)).reverse();
  return [...cycle, cycle[0]];
}
