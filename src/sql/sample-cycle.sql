INSERT INTO courses (id, name, credits, priority, difficulty, deadline) VALUES
  ('CS101', 'Programming Fundamentals', 4, 5, 2, '2027-01-15'),
  ('MT101', 'Calculus I', 3, 4, 3, '2027-01-20'),
  ('CS102', 'Object Oriented Programming', 4, 5, 3, '2027-06-10'),
  ('CS201', 'Data Structures', 4, 5, 4, '2027-11-15'),
  ('CS202', 'Design and Analysis of Algorithms', 3, 5, 5, '2028-01-20'),
  ('CS205', 'Advanced Programming', 3, 3, 4, '2027-12-01'),
  ('CS301', 'Operating Systems', 4, 4, 4, '2028-01-15');

INSERT INTO prerequisites (course_id, prereq_id) VALUES
  ('CS102', 'CS101'),
  ('CS201', 'CS102'),
  ('CS201', 'CS205'),
  ('CS202', 'CS201'),
  ('CS205', 'CS202'),
  ('CS301', 'CS201');
