import express from 'express';
import cors from 'cors';
import {
  getCourses,
  getCourseIds,
  getDependents,
  addCourse,
  updateCourse,
  deleteCourse,
  clearCourses,
  loadSample,
} from './db.js';
import { readCourse, validateCourse, validateCourseList } from './validate.js';
import { planSemesters, MAX_CREDITS } from './algorithms/planner.js';
import { SORT_ORDER } from './algorithms/compare.js';
import { runBenchmark } from './benchmark.js';

const PORT = process.env.PORT || 3001;
const SAMPLES = ['courses', 'cycle'];

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/courses', (req, res) => {
  res.json(getCourses());
});

app.post('/api/courses', (req, res) => {
  const course = readCourse(req.body ?? {});
  const ids = getCourseIds();
  const errors = validateCourse(course, ids);

  if (ids.has(course.id)) {
    errors.unshift(`Course ${course.id} already exists`);
  }
  if (errors.length > 0) {
    return res.status(400).json({ errors });
  }

  addCourse(course);
  res.status(201).json(course);
});

app.put('/api/courses/:id', (req, res) => {
  const course = readCourse({ ...req.body, id: req.params.id });
  const ids = getCourseIds();

  if (!ids.has(course.id)) {
    return res.status(404).json({ errors: [`Course ${course.id} not found`] });
  }

  const errors = validateCourse(course, ids);
  if (errors.length > 0) {
    return res.status(400).json({ errors });
  }

  updateCourse(course);
  res.json(course);
});

app.delete('/api/courses/:id', (req, res) => {
  const id = req.params.id.toUpperCase();
  const dependents = getDependents(id);

  if (dependents.length > 0) {
    return res.status(400).json({
      errors: [`Cannot delete ${id} because it is a prerequisite of ${dependents.join(', ')}`],
    });
  }

  deleteCourse(id);
  res.json({ deleted: id });
});

app.delete('/api/courses', (req, res) => {
  clearCourses();
  res.json({ deleted: 'all' });
});

app.post('/api/samples/:name', (req, res) => {
  if (!SAMPLES.includes(req.params.name)) {
    return res.status(404).json({ errors: ['Unknown sample'] });
  }

  loadSample(req.params.name);
  res.json(getCourses());
});

app.post('/api/plan', (req, res) => {
  const sortBy = req.body?.sortBy;
  if (!Object.hasOwn(SORT_ORDER, sortBy)) {
    return res.status(400).json({ errors: [`sortBy must be one of: ${Object.keys(SORT_ORDER).join(', ')}`] });
  }

  const courses = getCourses();
  const errors = validateCourseList(courses);
  if (errors.length > 0) {
    return res.status(400).json({ errors });
  }

  const start = performance.now();
  const plan = planSemesters(courses, sortBy);
  const timeMs = performance.now() - start;

  res.json({ ...plan, sortBy, maxCredits: MAX_CREDITS, timeMs });
});

app.get('/api/benchmark', (req, res) => {
  res.json(runBenchmark());
});

app.use((error, req, res, next) => {
  res.status(error.status ?? 500).json({ errors: [error.message] });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
