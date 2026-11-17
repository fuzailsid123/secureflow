import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const sqlFolder = path.join(import.meta.dirname, 'sql');
const dataFolder = path.join(import.meta.dirname, '..', 'data');

mkdirSync(dataFolder, { recursive: true });
const db = new DatabaseSync(path.join(dataFolder, 'planner.db'));
db.exec('PRAGMA foreign_keys = ON');
runSqlFile('schema.sql');

function runSqlFile(fileName) {
  db.exec(readFileSync(path.join(sqlFolder, fileName), 'utf8'));
}

function inTransaction(work) {
  db.exec('BEGIN');
  try {
    work();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function insertPrerequisites(course) {
  const insert = db.prepare('INSERT INTO prerequisites (course_id, prereq_id) VALUES (?, ?)');
  for (const prereqId of course.prerequisites) {
    insert.run(course.id, prereqId);
  }
}

export function getCourses() {
  const rows = db.prepare('SELECT id, name, credits, priority, difficulty, deadline FROM courses ORDER BY id').all();
  const links = db.prepare('SELECT course_id, prereq_id FROM prerequisites ORDER BY prereq_id').all();

  const courses = rows.map((row) => ({ ...row, prerequisites: [] }));
  const courseById = new Map(courses.map((course) => [course.id, course]));
  for (const link of links) {
    courseById.get(link.course_id).prerequisites.push(link.prereq_id);
  }

  return courses;
}

export function getCourseIds() {
  const rows = db.prepare('SELECT id FROM courses').all();
  return new Set(rows.map((row) => row.id));
}

export function getDependents(id) {
  const rows = db.prepare('SELECT course_id FROM prerequisites WHERE prereq_id = ? ORDER BY course_id').all(id);
  return rows.map((row) => row.course_id);
}

export function addCourse(course) {
  inTransaction(() => {
    db.prepare('INSERT INTO courses (id, name, credits, priority, difficulty, deadline) VALUES (?, ?, ?, ?, ?, ?)')
      .run(course.id, course.name, course.credits, course.priority, course.difficulty, course.deadline);
    insertPrerequisites(course);
  });
}

export function updateCourse(course) {
  inTransaction(() => {
    db.prepare('UPDATE courses SET name = ?, credits = ?, priority = ?, difficulty = ?, deadline = ? WHERE id = ?')
      .run(course.name, course.credits, course.priority, course.difficulty, course.deadline, course.id);
    db.prepare('DELETE FROM prerequisites WHERE course_id = ?').run(course.id);
    insertPrerequisites(course);
  });
}

export function deleteCourse(id) {
  db.prepare('DELETE FROM courses WHERE id = ?').run(id);
}

export function clearCourses() {
  db.exec('DELETE FROM prerequisites; DELETE FROM courses;');
}

export function loadSample(name) {
  inTransaction(() => {
    clearCourses();
    runSqlFile(`sample-${name}.sql`);
  });
}
