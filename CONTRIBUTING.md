# Contributing to Surveyor

Thanks for considering a contribution. Surveyor protects people who take real
risks to speak: read this file and `SECURITY.md` before touching the code.

## Licence

Surveyor is licensed **AGPL-3.0** (see `LICENSE`). By contributing you agree
that your contribution is licensed under the same terms. Network copyleft is
deliberate: a hosted derivative must stay auditable.

## Ground rules

- **Never commit a secret, a real submission, or real investigation material.**
  Use synthetic fixtures. This repository must stay safe to make public.
- **Never weaken a protection to pass a test.** If a guarantee needs to bend,
  say so in the issue and record it (the constitution's Complexity Tracking).
- **Security claims need tests.** A claim without a test is treated as false.
- **Australian English** in prose: behaviour, colour, optimise, licence (noun).
- Keep model output fenced and validated; nothing untrusted publishes directly.

## Development

Requires Node ≥ 22 (tests use `node:sqlite`; CI runs Node 24).

```sh
cd surveyor
npm ci
npm run typecheck
npm test
npm run build
npm run smoke:runtime   # boots workerd locally; no Cloudflare account needed
```

All four gates must pass. `npm run smoke:runtime` is the local runtime check;
a live installation can be smoked with `npm run smoke -- <url> --token <t>`.

## Pull requests

- One logical change per PR; explain the *why* and the risk.
- Include the test that proves the change (or say why none is possible).
- Note any effect on the constitution's principles in the description.
- Do not include generated build output (`dist/`) or `node_modules/`.

## Security

Do **not** open a public issue for a vulnerability. Follow the disclosure
process in `SECURITY.md`.
