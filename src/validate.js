import { MAX_CREDITS } from './algorithms/planner.js';

export const MAX_COURSES = 1000;
export const MAX_LINKS = 5000;

export function readCourse(body) {
  const prerequisites = Array.isArray(body.prerequisites) ? body.prerequisites : [];

  return {
    id: String(body.id ?? '').trim().toUpperCase(),
    name: String(body.name ?? '').trim(),
    credits: Number(body.credits),
    priority: Number(body.priority),
    difficulty: Number(body.difficulty),
    deadline: String(body.deadline ?? '').trim(),
    prerequisites: [...new Set(prerequisites.map((id) => String(id).trim().toUpperCase()).filter(Boolean))],
  };
}

function isWholeNumberBetween(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function isDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return false;
  }
  const date = new Date(text);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

export function validateCourse(course, existingIds) {
  const errors = [];

  if (!/^[A-Z0-9-]{1,20}$/.test(course.id)) {
    errors.push('Course ID must be 1 to 20 letters, digits or dashes');
  }
  if (!course.name) {
    errors.push('Name is required');
  }
  if (!isWholeNumberBetween(course.credits, 1, MAX_CREDITS)) {
    errors.push(`Credits must be a whole number from 1 to ${MAX_CREDITS}`);
  }
  if (!isWholeNumberBetween(course.priority, 1, 5)) {
    errors.push('Priority must be a whole number from 1 to 5');
  }
  if (!isWholeNumberBetween(course.difficulty, 1, 5)) {
    errors.push('Difficulty must be a whole number from 1 to 5');
  }
  if (!isDate(course.deadline)) {
    errors.push('Deadline must be a valid date (YYYY-MM-DD)');
  }

  for (const prereqId of course.prerequisites) {
    if (prereqId === course.id) {
      errors.push(`${course.id} cannot be a prerequisite of itself`);
    } else if (!existingIds.has(prereqId)) {
      errors.push(`Prerequisite ${prereqId} does not exist`);
    }
  }

  return errors;
}

export function validateCourseList(courses) {
  const errors = [];
  const ids = new Set(courses.map((course) => course.id));
  let linkCount = 0;

  if (ids.size !== courses.length) {
    errors.push('Course IDs must be unique');
  }
  if (courses.length > MAX_COURSES) {
    errors.push(`At most ${MAX_COURSES} courses are allowed`);
  }

  for (const course of courses) {
    linkCount += course.prerequisites.length;
    for (const error of validateCourse(course, ids)) {
      errors.push(`${course.id}: ${error}`);
    }
  }

  if (linkCount > MAX_LINKS) {
    errors.push(`At most ${MAX_LINKS} prerequisite links are allowed`);
  }

  return errors;
}
