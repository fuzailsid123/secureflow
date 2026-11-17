export function buildGraph(courses) {
  const dependents = new Map();
  const inDegree = new Map();

  for (const course of courses) {
    dependents.set(course.id, []);
    inDegree.set(course.id, 0);
  }

  for (const course of courses) {
    for (const prereqId of course.prerequisites) {
      dependents.get(prereqId).push(course.id);
      inDegree.set(course.id, inDegree.get(course.id) + 1);
    }
  }

  return { dependents, inDegree };
}
