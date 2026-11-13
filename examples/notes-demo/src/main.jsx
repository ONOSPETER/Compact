import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  const [notes, setNotes] = useState([]);
  const [text, setText] = useState('');
  const load = () => fetch('/api/notes').then((r) => r.json()).then(setNotes);
  useEffect(() => { load(); }, []);
  const add = async () => {
    await fetch('/api/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    setText(''); load();
  };
  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 480, margin: '2rem auto' }}>
      <h1>notes-demo</h1>
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a note" />
      <button onClick={add} disabled={!text}>Add</button>
      <ul>{notes.map((n) => <li key={n.id}>{n.text}</li>)}</ul>
    </main>
  );
}
createRoot(document.getElementById('root')).render(<App />);
