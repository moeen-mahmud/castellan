---
name: incident-timeline
description: Reconstruct what happened during an outage from log files and shell history into a timestamped timeline with a root cause. Use when investigating an incident, a crash loop, a service that stopped responding, or a postmortem.
license: Apache-2.0
metadata:
  dispach-when-not-to-use: >
    Not for a failure happening right now that has an obvious fix — read the error and fix it.
    Not for interpreting a single stack trace, and not for performance work where nothing broke.
---

<!-- Authoring note: the ordering rule in step 3 is the one worth keeping. Everything else here is
     recoverable from first principles; that one is learned. -->

1. Establish the window first. Ask what time the symptom was noticed, and work outward from there —
   a timeline assembled without a bound grows until it is useless.
2. Collect timestamps from every source before interpreting any of them: application logs, the service
   manager's own log, `uptime`, and the shell history of whoever was working at the time.
3. **Sort by timestamp, then look for the first anomaly — not the first error.** The first *error* is
   usually a consequence. The first anomaly is often something that does not look like a failure at
   all: a load average climbing, a restart count incrementing, a file growing.
4. Distinguish what the system reported from what it did. A log line saying a service is healthy is
   evidence about the log line.
5. State the root cause as one sentence, and separately state what made it hard to see. Those are two
   different fixes and the second is usually the more valuable one.

Report the timeline as a table of time, source, and observation, then the cause, then what would have
made it visible sooner.
