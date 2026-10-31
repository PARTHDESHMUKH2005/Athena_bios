# How we work without merge conflicts

Ownership is by **file path**, set in [STATUS.md](STATUS.md) section 2. Every file has one owner. Conflicts need two people editing the same lines, so the rules below make that case rare.

## The rules

1. **Edit only your own paths.** If your feature needs a change in someone else's file, ask the owner (an issue, or a comment on your PR), or send them a tiny PR to review. Never include edits to another stream's files in your feature PR.
2. **Put new work in new files you own.** Add a new module, a new test file or a new folder instead of growing a shared file.
3. **Append-only blocks in the few shared lists.** In `src/env.ts` (environment variables) and `package.json` (scripts, dependencies), add your lines at the end of the list under a comment with your stream letter (`// A:`). Never reorder or reformat the lines around them.
4. **Tests go in files you own.** Name new tests `tests/<stream-letter>-<topic>.test.ts` (the `tests/**/*.test.ts` glob finds them). `tests/units.test.ts` is frozen.
5. **Evaluation cases are per person.** Add cases under `bench/cases/<area>.json` in your own file. The benchmark runner (A) reads all of them.
6. **Lockfiles are never merged by hand.** On a conflict in a `package-lock.json`, take main's version and run `npm install` again.
7. **No sweeping changes to files you don't own**: no repo-wide formatting, no renames, no moving files.

## The API contract (B's backend, D's web app, C's upload code)

The contract is `athena/src/schemas.ts` plus section 3.3 of `athena.md`; the web app mirrors it in `athena/web/src/lib/types.ts`.

- Change it by **adding** fields or endpoints only. Never rename, remove or change the meaning of one.
- B makes the backend change and says so in `status/harshdeep.md` under "Contract changes". D then updates the web types. C and A only read the contract.

## Branches and pull requests

- Branch per task, named by stream: `a/phase0-findings`, `b/chat-without-document`, `c/ocr-pages`, `d/checkpoint-screen`.
- Small pull requests, one concern each. Squash-merge, then delete the branch.
- Start each day with `git fetch && git rebase origin/main` on your branch.
- Before you push, run from `athena/`:
  ```bash
  npm run check
  ```
  It runs the backend typecheck, all tests, the single-caller guard and the web typecheck. `main` must stay green.
- **Never force-push `main` or rewrite shared history** without everyone's agreement. Force-pushing your own branch is fine.
- Pushing straight to `main` is for the status files and docs only; code goes through a pull request.

## Secrets

Never commit a key. `.env` and `.dev.vars` are ignored; only placeholder names go in `.env.example`. If a key leaks, revoke it first, then clean up.

## Your status file

Each person keeps `status/<name>.md` current: done, doing now, next, blocked, and anything others must know. It is the only status file you edit.
