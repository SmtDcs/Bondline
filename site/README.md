# Landing page

Static one-page site for Claimable bot promises (Astro 5). Every number on the page is read from the recorded fixtures and the
repository README by `scripts/extract-run.mjs`, which stops the build if a fixture disagrees.

```
npm ci
npm run dev        # http://localhost:4321
npm run build      # -> dist/
npm run preview
```

Optional environment variables: `PUBLIC_REPO_URL` (defaults to the GitHub repository) and `PUBLIC_SITE_URL` (enables the
`og:url` / `og:image` tags). `node scripts/shots.mjs` takes screenshots and runs axe accessibility checks against a running
`npm run preview` (needs `npx playwright install chromium`).
