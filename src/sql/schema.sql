CREATE TABLE IF NOT EXISTS courses (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  credits    INTEGER NOT NULL CHECK (credits BETWEEN 1 AND 18),
  priority   INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 5),
  difficulty INTEGER NOT NULL CHECK (difficulty BETWEEN 1 AND 5),
  deadline   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prerequisites (
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  prereq_id TEXT NOT NULL REFERENCES courses(id),
  PRIMARY KEY (course_id, prereq_id),
  CHECK (course_id <> prereq_id)
);
