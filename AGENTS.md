# Agent notes

## Versioning and releases

- Releases are **patch bumps by default** (0.2.1, 0.2.2, …). Never bump minor or major without being explicitly asked.
- Before any version work, run `npm view situationship versions` — the npm registry, not package.json or git tags, is the source of truth for what's taken. Published versions are immutable and can never be reused.
- Release flow: `npm version patch && git push origin main --follow-tags && npm publish`. `prepublishOnly` runs the syntax checks and tests automatically.
- `npm publish` requires 2FA, so Rob runs it himself in a real terminal (or with `--otp=`).
- History note: 0.2.0 shipped as an accidental minor bump; since it's immutable on npm, the version line continues from 0.2.x.

## Checks

- `npm run check` — syntax-checks all entry points; keep the list in sync when adding files under `lib/`.
- `npm test` — Node's built-in test runner (`node --test`).
