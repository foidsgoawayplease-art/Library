const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const app = express();
const db = new DatabaseSync('library.db');
const tx = (fn) => { db.exec('BEGIN'); try { fn(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } };
app.use(express.json());
app.use(express.static('public'));

db.exec(`
CREATE TABLE IF NOT EXISTS books (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, author TEXT NOT NULL, isbn TEXT, category TEXT, total_copies INTEGER NOT NULL, available_copies INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS students (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT);
CREATE TABLE IF NOT EXISTS issues (id INTEGER PRIMARY KEY AUTOINCREMENT, book_id INTEGER NOT NULL, student_id INTEGER NOT NULL, issue_date TEXT NOT NULL, due_date TEXT NOT NULL, return_date TEXT);
`);

const iso = (d) => d.toISOString().slice(0, 10);
const today = () => iso(new Date());
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
const fail = (res, msg) => res.status(400).json({ error: msg });

// BOOKS
app.get('/api/books', (req, res) => {
  const q = `%${req.query.q || ''}%`;
  res.json(db.prepare('SELECT * FROM books WHERE title LIKE ? OR author LIKE ? ORDER BY title').all(q, q));
});
app.post('/api/books', (req, res) => {
  const { title, author, isbn, category } = req.body;
  const copies = parseInt(req.body.total_copies);
  if (!title || !author || !(copies > 0)) return fail(res, 'Title, author and copies (1+) are required');
  db.prepare('INSERT INTO books (title, author, isbn, category, total_copies, available_copies) VALUES (?,?,?,?,?,?)')
    .run(title, author, isbn || '', category || '', copies, copies);
  res.json({ ok: true });
});
app.put('/api/books/:id', (req, res) => {
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  if (!book) return fail(res, 'Book not found');
  const { title, author, isbn, category } = req.body;
  const copies = parseInt(req.body.total_copies);
  if (!title || !author || !(copies > 0)) return fail(res, 'Title, author and copies (1+) are required');
  const available = book.available_copies + (copies - book.total_copies);
  if (available < 0) return fail(res, 'Total copies cannot be less than copies currently issued');
  db.prepare('UPDATE books SET title=?, author=?, isbn=?, category=?, total_copies=?, available_copies=? WHERE id=?')
    .run(title, author, isbn || '', category || '', copies, available, book.id);
  res.json({ ok: true });
});
app.delete('/api/books/:id', (req, res) => {
  const active = db.prepare('SELECT COUNT(*) c FROM issues WHERE book_id=? AND return_date IS NULL').get(req.params.id).c;
  if (active > 0) return fail(res, 'Cannot delete: book is currently issued');
  db.prepare('DELETE FROM books WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// STUDENTS
app.get('/api/students', (req, res) => res.json(db.prepare('SELECT * FROM students ORDER BY name').all()));
app.post('/api/students', (req, res) => {
  const { name, email } = req.body;
  if (!name) return fail(res, 'Name is required');
  db.prepare('INSERT INTO students (name, email) VALUES (?,?)').run(name, email || '');
  res.json({ ok: true });
});

// ISSUE / RETURN
app.get('/api/issues', (req, res) => {
  const rows = db.prepare(`SELECT i.*, b.title, s.name AS student FROM issues i
    JOIN books b ON b.id = i.book_id JOIN students s ON s.id = i.student_id
    WHERE i.return_date IS NULL ORDER BY i.due_date`).all();
  const t = today();
  res.json(rows.map((r) => {
    const days = Math.max(0, Math.round((new Date(t) - new Date(r.due_date)) / 86400000));
    return { ...r, days_overdue: days, fine: days * 5 };
  }));
});
app.post('/api/issue', (req, res) => {
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.body.book_id);
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(req.body.student_id);
  if (!book || !student) return fail(res, 'Select a book and a student');
  if (book.available_copies < 1) return fail(res, 'No copies available');
  const held = db.prepare('SELECT COUNT(*) c FROM issues WHERE student_id=? AND return_date IS NULL').get(student.id).c;
  if (held >= 3) return fail(res, 'Student already has 3 books');
  tx(() => {
    db.prepare('INSERT INTO issues (book_id, student_id, issue_date, due_date) VALUES (?,?,?,?)').run(book.id, student.id, today(), addDays(14));
    db.prepare('UPDATE books SET available_copies = available_copies - 1 WHERE id = ?').run(book.id);
  });
  res.json({ ok: true });
});
app.post('/api/return/:id', (req, res) => {
  const issue = db.prepare('SELECT * FROM issues WHERE id = ? AND return_date IS NULL').get(req.params.id);
  if (!issue) return fail(res, 'Issue not found or already returned');
  tx(() => {
    db.prepare('UPDATE issues SET return_date = ? WHERE id = ?').run(today(), issue.id);
    db.prepare('UPDATE books SET available_copies = available_copies + 1 WHERE id = ?').run(issue.book_id);
  });
  res.json({ ok: true });
});

app.listen(3000, () => console.log('Running on http://localhost:3000'));
