# Landing page

Static one-page site for Claimable bot promises (Astro 5). `scripts/extract-run.mjs` reads every number on the page from the recorded fixtures and the repo README, and stops the build if a fixture disagrees.

```
npm ci
npm run dev        # http://localhost:4321
npm run build      # -> dist/
npm run preview
```

Optional environment variables: `BASE_PATH` for a subpath (e.g. `/claimable-bot-promises/`), `PUBLIC_REPO_URL` (defaults to the GitHub repository) and `PUBLIC_SITE_URL` (enables the `og:url` and `og:image` tags). `node scripts/shots.mjs` takes screenshots and runs axe accessibility checks against a running `npm run preview`; it needs `npx playwright install chromium`.

The live copy at https://smtdcs.github.io/claimable-bot-promises/ is built and published by `.github/workflows/pages.yml` on every push to `main` that touches the site, the README or the fixtures.
