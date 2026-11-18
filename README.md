# Personal University

A personal quiz app that turns books I've read into questions, schedules them with spaced repetition at the concept level, and has an AI tutor respond to my reasoning.

## Run it

```bash
npm install
npm start
```

Then open http://localhost:3000.

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Enables tutor feedback on spoken or typed reasoning. Without it, answers still work. |
| `APP_PASSWORD` | Single shared password. Unset means no login (fine locally, not when deployed). |
| `DATABASE_PATH` | SQLite file. Defaults to `personal-university.db` in the repo; point it at a persistent volume when deployed. |
| `PORT` | Defaults to 3000. |

## How it fits together

- `data/<book>/source.json` lists a book's chapters; `chNN.json` is a chapter's question bank. Banks are synced into SQLite on every start; the database keeps everything I do (reads, attempts, scheduling, kills, flags).
- `prompts/question-writing.md` is the brief for writing banks. `npm run validate` checks one.
- `server/scheduler.js` holds one FSRS card per concept and picks the single most useful question on each request. No due counts.
- `server/feedback.js` sends my reasoning, the question's authored explanations and the chapter's key ideas to Claude, which replies and rates how well I know the concept.
- `public/` is the whole frontend: plain HTML, CSS and JS, no build step.

`npm test` runs the scheduler tests.
