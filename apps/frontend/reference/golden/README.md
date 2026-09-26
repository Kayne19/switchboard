# Golden Screenshots

Canonical snapshots for `npm run test:visual`. Seven scenes (idle,
conversation, training, architecture, email, code, composed) at four
geometries (portrait phone, portrait tablet, standard landscape, ultrawide),
plus the landscape primary-metric cluster. `apps/frontend/playwright.config.ts`
reads them from this directory.

Update only after explicit visual approval:

```bash
npm run test:visual -- --update-snapshots
```

Do not run screenshot updates as a generic test repair.
