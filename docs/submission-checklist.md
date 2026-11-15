# Submission checklist

Event cutoff from the supplied hackathon brief: **November 16, 2026 at 09:00 IST**. The brief asks for a hosted app, an open-source repository, a Loom walkthrough, and tagged social posts. This checklist distinguishes prepared artifacts from actions still owned by the user.

## Prepared artifacts

- [x] Live application URL: https://incident-context.dpratik3005.workers.dev
- [x] Public application repository URL: https://github.com/PRADDZY/incident-context
- [x] README with product scope, architecture, setup links, measured comparisons, and mixed-data disclosure.
- [x] Original 180-attempt deterministic study and 30-request paired live evidence retained in `evaluation/`.
- [x] Separate 160-attempt goal-oriented supplement retained alongside the initial study, with its preregistration and locked corpus.
- [x] [Results interpretation](results.md), [evaluation protocol](evaluation.md), and [supplement protocol](ambiguity-protocol.md) linked for reviewers.
- [x] [Three-minute silent walkthrough script](demo-script.md) prepared. **Script only; no video or Loom link exists.**
- [x] [X, LinkedIn, and community drafts](go-to-market.md) prepared, with account-verification and claim caveats.
- [x] [Two-to-three-developer tester guide](tester-guide.md) and blank feedback fields prepared.

The linked [operations guide](operations.md) covers setup and deployment. Use [reliability evidence](reliability.md) for actual browser, concurrency, timeout, and recovery outcomes; a link or intended check is not itself proof that a runtime check passed.

## User actions before the cutoff

- [ ] Open the live URL and repository from the account/network used for submission; confirm judge access and keep the existing execution host available through judging.
- [ ] Verify the organizer's exact HydraDB X account and LinkedIn page. The supplied brief requires a tag but does not specify the handle; `@HydraDB` in the draft is unverified.
- [ ] Review and publish the X thread and LinkedIn post with the verified HydraDB account/page tagged. Add another relevant social/community post if appropriate. Save the actual post URLs.
- [ ] Invite two or three developer friends, collect their real feedback, and retain both positive and negative results. No tester feedback or customer traction is claimed before that happens.
- [ ] Resolve the Loom requirement. The user requested a script only, so **the required actual walkthrough video remains unmet**. Supply an actual Loom externally or obtain an explicit organizer-approved alternative. Do not submit the script as if it were a video.
- [ ] Complete the organizer's actual submission form/channel with the live app, public repository, genuine walkthrough artifact or accepted alternative, and actual social URLs. No submission destination is invented here.
- [ ] Confirm the final submission was received before **09:00 IST on November 16**. Preserve its receipt or message link privately.

No social posts, invitations, form submission, or video publication are performed by preparing these documents.

## Facts to preserve in the submission

| Topic | Accurate statement |
| --- | --- |
| Track | Track 2: agent context layer using the self-hosted open-source HydraDB engine. |
| Initial deterministic result | 40 training / 20 held-out narratives; 180 attempts; four service fixtures. Full/keyword/frozen/learned executor success: 20/19/20/20 out of 20. Learned mean schema bytes: 1,976 vs full 6,560 (69.9% fewer). |
| Initial learning curve | 20/20 at 0/10/20/40 training outcomes. No measured learning gain. |
| Paired live result | Ten fixed tasks × three strategies, once each. Full/frozen/learned: 7/10, 9/10, 10/10. Frozen includes one HTTP 502 and missing usage. |
| Live context usage | Mean reported input tokens full 2,320.9 (10 returned), frozen 900.67 (9 returned), learned 912.4 (10 returned); learned is 60.7% below full. |
| Live interpretation | Frozen/learned inputs matched in 9/9 comparable pairs. Do not attribute their success difference to learning or claim significance. |
| Supplement | A separate AI sub-agent authored 40 narratives blind to the planner, skills, tools, original corpus, and previous results; corpus locked at `68a05a8`; SHA-256 `7f29df93c38efdf15d47fea66dbc958e5dfd5f26a5cc2257096f3b1f519da2f7`. 160 deterministic attempts; 20 training attempts yielded 16 actual feedback updates. |
| Supplement outcome | Independent goal success 14/20 → 15/20 → 15/20 → 15/20 at 0/5/10/20 attempts. Final full/keyword/frozen/learned: 15/11/14/15 out of 20. Mean bytes: 6,560/3,925/2,067/1,996, excluding unavailable measurements. Five failures retained. |
| Generalization | Both studies reuse four underlying service fixtures and two families. The supplement is a one-case gain with an early plateau, not broad incident-response generalization or a replacement for the flat initial result. |
| Data/model boundary | Real HydraDB traversals and Workers AI calls; simulated service incidents; live read-only Cloudflare provider status. The backend renders the observed diagnosis from verified observations. Provider reports do not prove root cause. |
| Product/commercial state | Prototype for platform/on-call teams. No validated demand, production incident outcomes, paying users, or pricing. US$99/team/month is a pilot hypothesis only. |
| Separate bounty | SelfGraph PR #49 is separate work. It is not a claimed win or part of the app's measured results. |

The [raw result artifacts](../evaluation/) retain failures and unreported usage. Keep their provenance and both study metrics intact when shortening the pitch.
