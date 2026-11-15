# Incident Context

Build a small incident-response agent context layer on real self-hosted HydraDB.

- Read docs/architecture.md and src/shared/contracts.ts before implementing.
- Use actual bounded HydraDB queries. No in-memory graph fallback or fake engine receipts.
- Label simulated incident tools and live provider-status observations clearly.
- Keep the held-out benchmark fixed and never train on its outcomes.
- Keep credentials, runtime state, SSH details and dependencies out of git.
- Use authenticated gh for GitHub. Use Wrangler for the public Cloudflare deployment.
- Commit verified, coherent changes with short messages.
- New logic needs meaningful regression tests; verify UI interactions in a real browser.
