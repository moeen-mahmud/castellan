---
keywords: [deploy, rollback, staging, release]
---

<!-- Tier 3: enters the context only on turns whose input mentions a keyword above. Not pinned —
     compaction may drop it, and it is never paid for on turns that don't need it. -->

Deploys go staging first, always. Staging picks up the TLS cert three days before prod does,
so a cert about to expire fails there first — that is the point of the gap. A rollback is
`vela rollback <service>` and takes about ninety seconds; it does not roll back migrations,
which need `vela db undo` run separately and confirmed by hand.
