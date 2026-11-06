# Why Arkiv

## What a user would lose with Postgres

**Anyone could be shown a different answer.** With Postgres, "Was I wronged?" means trusting our server. With Arkiv, a verdict is an entity whose owner is a known wallet, and anyone can run the same query against the chain without us. See the runnable query in [`schema.md`](schema.md).

**The record would end with the project.** A hackathon database goes away when the demo server does. Redress is about what people are owed, so that record should outlive the team, at least for its expiry period.

**Expiry would be a cron job.** True-up claims have a 7-day window. In Postgres that needs a scheduled job and trust that it ran. On Arkiv the entity expires by itself.

**Others could not build on it.** A protocol, a DAO or a victim's wallet can query verdicts directly, with no API key from us.

## What Postgres does better

We should be plain about this:

- It has no anonymous query budget. Arkiv's public endpoint stopped answering our queries, so the app needs a fallback.
- It has no lifetime cap. Arkiv's is about 182 days.
- It is simpler to run.

## What stays off Arkiv

The chain is the source of truth for money. The vault's events decide what was paid, and Arkiv is an index that points at them. If they ever disagree, the chain is right.
