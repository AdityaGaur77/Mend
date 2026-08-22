# Controlled failure alert

Create this rule from **Alerts → New alert → Metrics based alert** (or from the
dashboard's **Stage failures** panel):

- Name: `Zero Downtime controlled pipeline failure`
- Metric: `zero_downtime_stage_failures_total`
- Filter: `pipeline.stage = 'scrape'`
- Aggregate within time series: `increase`
- Aggregate across time series: `sum`
- Condition: above `0` at least once in the last 5 minutes
- Labels: `severity=warning`, `escalation=human-review`

For a demo, set evaluation to one minute, run `npm run telemetry:smoke`, and
show the firing state and alert history. The correlated error log contains
`escalation.target=human-review`, `retry.eligible=true`, and the `run.id`; use
that run ID to pivot between the alert, metric, logs, and trace. Notification
routing is deliberately a UI/account step because it needs a user-owned email,
webhook, Slack channel, or Port endpoint and must not be committed.
