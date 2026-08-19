---
name: csv-profile
description: Profile a CSV file — row and column counts, types, null rates, and the most common values per column — before anyone writes a query against it. Use when handed a CSV, a spreadsheet export, or a data dump of unknown shape.
license: Apache-2.0
compatibility: Requires python3
metadata:
  dispach-when-not-to-use: >
    Not for cleaning or transforming the file, and not for answering a question *from* the data —
    this only describes what is in it. For a file that is already understood, skip straight to the query.
---

<!-- Authoring note: the script exists because counting null rates by reading a file into context is
     both expensive and unreliable at scale. Decision 6.4: a deterministic script beats instructions a
     model has to interpret. -->

1. Run the profiler on the file the person named:

   `skill.csv-profile.profile` with `args: ["<path to the csv>"]`

2. Read its output before saying anything about the data. It reports the row count, and per column: the
   inferred type, how many values are missing, and the three most common values.
3. Call out anything that will surprise someone writing a query: a column that is 90% empty, a numeric
   column holding a stray non-numeric value, a date column in more than one format.
4. If the file is not UTF-8 or not comma-separated the script says so and stops. Report that rather
   than guessing at a delimiter — a mis-parsed profile is worse than no profile.

Do not modify the file. This is a read.
