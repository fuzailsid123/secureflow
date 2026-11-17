# Smart Study Planner: Backend

DAA semester project. This is the backend API. It turns a list of courses and their prerequisites into a semester-by-semester study plan, with at most 18 credits per semester, and reports circular prerequisites. The React frontend is in a separate repository, `smart-study-planner-frontend`.

**Group members:** Fuzail Ahmed Siddiqui (CT-24177), Ayan Mirza (CT-24197), Ahmed Raza (CT-24171), Hassan Shakil (CT-24185)

**Algorithms:**

- **Topological sort, source-removal method** (decrease and conquer): orders courses so prerequisites come first.
- **Merge sort** (divide and conquer): ranks the courses available in each semester.

## Tech stack

- **Server:** Node.js with Express
- **Database:** SQLite, using Node's built-in `node:sqlite` module, so nothing extra to install. The tables are defined in [src/sql/schema.sql](src/sql/schema.sql).

## How to run

You need **Node.js 22.13 or newer**.

```bash
npm install
npm run dev
```

The API runs on http://localhost:3001. To use a different port, set the `PORT` environment variable. The database file `data/planner.db` is created the first time the server starts.

| Command | What it does |
|---|---|
| `npm run dev` | Starts the server and restarts it when a file changes |
| `npm start` | Starts the server |
| `npm test` | Runs the algorithm tests in `tests/` |

## Where each algorithm is

| File | Contents |
|---|---|
| [src/algorithms/graph.js](src/algorithms/graph.js) | Builds the adjacency list (`dependents`) and the in-degree of every course |
| [src/algorithms/planner.js](src/algorithms/planner.js) | The semester planner: source-removal topological sort with merge-sort ranking, the credit limit and cycle detection |
| [src/algorithms/mergeSort.js](src/algorithms/mergeSort.js) | Merge sort |
| [src/algorithms/compare.js](src/algorithms/compare.js) | Compares two courses by the chosen key, breaking ties by course ID |
| [src/algorithms/topologicalSort.js](src/algorithms/topologicalSort.js) | Plain source-removal topological sort (queue), plus the naive repeated-scan version for comparison |
| [src/algorithms/bubbleSort.js](src/algorithms/bubbleSort.js) | Bubble sort, for comparison |
| [src/benchmark.js](src/benchmark.js) | Generates random courses and times the algorithms |

## How the plan is built

1. Build the graph. For each course, store the list of courses that depend on it, and its in-degree (the number of prerequisites it still needs).
2. Courses with in-degree 0 form the **available** set.
3. For each semester:
   1. Merge sort ranks the available set by the chosen key.
   2. Courses are added in rank order while the total stays at or under 18 credits.
   3. A course that would go over the limit is deferred to the next semester.
4. Each course taken lowers the in-degree of the courses that depend on it. Any course that reaches 0 becomes available from the next semester, because a prerequisite must be finished before its dependent course can start.
5. Repeat until no course is available.
6. If courses are still left over, they are blocked by a cycle. The server starts at a blocked course and keeps moving to one of its blocked prerequisites until a course repeats. That loop is returned as the **Circular Dependency Error**.

The ranking keys are:

- **Priority:** 1 to 5, highest first
- **Deadline:** earliest first
- **Credits:** most first
- **Difficulty:** 1 to 5, hardest first

Ties are broken by course ID. Merge sort is also stable, which `tests/algorithms.test.js` checks.

## Efficiency

| Module | Algorithm | Complexity | Naive alternative | Naive complexity |
|---|---|---|---|---|
| Dependency scheduling | Topological sort (source removal) | O(V + E) | Repeated scan of all courses | O(V²) |
| Ranking | Merge sort | O(n log n) time, O(n) extra memory | Bubble sort | O(n²) |

The graph uses O(V + E) space. `GET /api/benchmark` measures both comparisons. With 4,000 courses, merge sort runs about 150 times faster than bubble sort. Topological sort runs about 18 times faster than the repeated scan.

## Validation rules

- Credits are 1 to 18. Priority and difficulty are 1 to 5. The deadline must be a valid date.
- Every prerequisite must be an existing course, and a course cannot be its own prerequisite.
- A course that is a prerequisite of another course cannot be deleted.
- Planning accepts at most 1,000 courses and 5,000 prerequisite links.

## API

Errors are returned as `{ "errors": ["..."] }` with status 400 or 404.

| Method | Path | Description |
|---|---|---|
| GET | `/api/courses` | List all courses with their prerequisites |
| POST | `/api/courses` | Add a course |
| PUT | `/api/courses/:id` | Update a course |
| DELETE | `/api/courses/:id` | Delete a course |
| DELETE | `/api/courses` | Delete all courses |
| POST | `/api/samples/courses` or `/api/samples/cycle` | Replace all courses with a sample set |
| POST | `/api/plan` | Build the plan. Body: `{ "sortBy": "priority" }` |
| GET | `/api/benchmark` | Run the efficiency comparison |

A course looks like this:

```json
{
  "id": "CS201",
  "name": "Data Structures",
  "credits": 4,
  "priority": 5,
  "difficulty": 4,
  "deadline": "2027-11-15",
  "prerequisites": ["CS102", "MT102"]
}
```

`POST /api/plan` returns either `{ "ok": true, "semesters": [...], "order": [...], "timeMs": ... }` or, when there is a cycle, `{ "ok": false, "cycle": [...], "blocked": [...] }`.

## Project structure

```
src/
  index.js          Express routes
  db.js             SQLite queries
  validate.js       Input validation
  benchmark.js      Efficiency comparison
  algorithms/       The algorithms listed above
  sql/              schema.sql and the two sample data files
tests/              Algorithm tests (node --test)
```
