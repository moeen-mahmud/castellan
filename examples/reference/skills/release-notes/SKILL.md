---
name: release-notes
description: Draft release notes from a range of git commits, grouped by change type with breaking changes called out first. Use when asked to write a changelog, summarise what shipped, or prepare notes for a tag or version.
license: Apache-2.0
metadata:
  dispach-when-not-to-use: >
    Not for deciding *what* to release or for bumping a version — that is a judgement about
    readiness, not a summary of history. Not for a single commit either; just read it.
---

<!-- Authoring note: this file is injected verbatim on the turn it activates, so every line here is
     paid for. Keep it to steps. Detail that is only occasionally needed belongs in references/. -->

Work from the commit range the person named. If they named none, use everything since the most recent
tag.

1. Read the commits with `git log --oneline <range>`. Do not read the diffs unless a subject line is
   too vague to classify — the subjects are the source material.
2. Group by what a reader cares about, in this order: **breaking changes**, then features, then fixes,
   then everything else under "internal".
3. Write one line per change, in the past tense, describing the effect rather than the edit. "Telegram
   messages over 4096 characters are split" beats "refactor splitMessage".
4. Drop anything a reader cannot observe: version bumps, formatting passes, test-only changes. If that
   empties a group, omit the heading.
5. Put breaking changes first even when there is one and forty features. Someone skimming for what
   will break their setup should not have to scroll.

Report the notes as markdown. Do not commit anything, and do not create a tag — say what you would
write and let the person place it.
