# Developer friend test: 10–15 minutes

Ask two or three developer friends, preferably people who work on platform tools, on-call workflows, or agents, to try the [live workbench](https://incident-context.dpratik3005.workers.dev). The user sends invitations and collects feedback. No tester responses have been collected or invented here.

The purpose is to find usability and product-fit gaps. Two or three friends are not a customer sample, and their responses should not be presented as commercial traction.

## Invitation draft

> Could you spend 10–15 minutes trying Incident Context, my HydraDB hackathon prototype? It selects a complete incident-agent tool bundle and shows the graph evidence behind it. I'd like candid feedback about what is useful, confusing, or missing for your workflow. Service incidents are simulated; Cloudflare provider status is live and read-only. Please use only the supplied scenarios and no private incident data. Link: https://incident-context.dpratik3005.workers.dev

## Tasks

1. Open the app. Without reading the source, describe what you think **Selection path** and **Tool bundle** are showing. Is the graph's purpose clear?
2. In the default **Checkout rollout regression · Sandbox** scenario, click the **Northstar Checkout** service node. Find its canonical service and resource. Expand **Query receipt** and one tool's **JSON schema**. Identify a tool prerequisite.
3. Click **Full catalog**, note the exact schema bytes and tool count, then click **Learned graph**. Can you explain the difference? Strategy changes and **Compile context** do not call the model.
4. Click **Run agent** once. Inspect **Agent observations**, the **Sandbox** label, the diagnosis, and **Run metadata**. Note whether the actual evidence supports the requested result. Do not retry a failure to make the test look successful.
5. If a run returned, click **Correct** or **Incorrect** based on your evidence review. Inspect the changed success/failure counts and **Feedback receipt**. This affects only your session, not the published evaluation.
6. Select **Search provider observation · Live provider**. Inspect the selected tools' source labels. If budget permits, run once and inspect an observation's timestamp and source. Explain what provider status can and cannot tell you about a service incident.
7. Open **Evidence** and **Catalog**. Find **Original learning checkpoints** and **Goal-oriented supplement**. Is it clear that the original curve is flat and that the supplement's one-case gain is a separate result? Check the repository's [results](results.md) for the full methods.
8. Optional failure path: return to **Context**, replace the request with `Investigate unknown-service-xyz deployment regression`, and click **Compile context**. Note the actual error. Restore the supplied checkout scenario through the scenario menu. This uses no model call.

The shared public limit is 60 reserved model attempts per UTC day; use at most two **Run agent** actions per tester. If the budget is exhausted, continue the graph, schema, catalog, and evidence tasks and record that the run was unavailable. If the graph is unavailable, note the time and visible error; no fallback graph is substituted.

## Feedback form

Copy this block once per tester. A name or handle is optional. Keep private incident details, credentials, and internal company names out of the response.

```text
Tester (optional):
Date/time and time zone:
Role and experience with incident tools/agents:
Browser/device:

What did you think the product did before clicking anything?
Which tasks did you complete? Which were blocked?
What were the selected/full schema bytes you saw?
Did a model run return? Actual result/error and approximate time:
Could you distinguish sandbox observations from live provider reports?
Was a missing prerequisite or service identity easier to understand? Why?
Which UI label, graph edge, or step was confusing?
One thing that would make this useful in your workflow:
Your current alternative (if any):
Would you consider a read-only pilot? Why or why not?
Reaction to an unvalidated US$99/team/month pilot hypothesis:
Biggest integration or trust blocker:
Permission to quote this feedback publicly? yes/no
If yes, the exact quote and attribution you approve:
```

Do not fill missing responses or summarize a tester's opinion without their actual input. A screenshot or console excerpt is optional; remove personal/session details before sharing. Store any identifiable raw feedback privately. Add a public aggregate or approved quote only after responses and permission exist.

## How to interpret the responses

Record observations separately from opinions: “could not find Query receipt” is an observed usability issue; “would pay” is a stated intention, not a sale. Count the actual number of testers and blocked tasks. Keep contradictory and negative feedback. Use this round to choose the next usability or integration improvement; production value and willingness to pay still need validation.
