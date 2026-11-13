import express from 'express';

const app = express();
app.use(express.json());
const notes = [];
app.get('/api/notes', (_req, res) => res.json(notes));
app.post('/api/notes', (req, res) => {
  const note = { id: notes.length + 1, text: String(req.body?.text ?? '').slice(0, 500) };
  notes.push(note);
  res.status(201).json(note);
});
app.listen(process.env.PORT || 3001, () => console.log('notes-demo API on', process.env.PORT || 3001));
