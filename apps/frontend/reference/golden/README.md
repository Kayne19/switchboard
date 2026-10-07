# Golden Screenshots

Canonical snapshots for `npm run test:visual` (`tests/visual/visual.spec.ts`,
every test tagged `@golden`; CI's browser job leaves them out). At four
geometries (portrait phone, portrait tablet, standard landscape, ultrawide):
the first seven scenes (idle, conversation, training, architecture, email,
code, composed) and eleven more: the calendar's four views (calendar,
calendar-day, calendar-month, calendar-agenda), tasks, inbox, weather,
timer (the page clock held still), results (a table), handoff (a sequence
diagram) and today (the composed briefing). Plus the landscape
primary-metric cluster. `apps/frontend/playwright.config.ts` reads them
from this directory.

Update only after explicit visual approval:

```bash
npm run test:visual -- --update-snapshots
```

Do not run screenshot updates as a generic test repair.
