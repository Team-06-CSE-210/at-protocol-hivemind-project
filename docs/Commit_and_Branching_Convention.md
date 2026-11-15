# Commit Message & Branching Convention

**Status:** Proposed team convention — confirm with the team before enforcing.

## 1. Branching strategy

- `main`: stable branch; avoid direct pushes.
- `develop`: integration branch for reviewed work; avoid direct pushes.
- Create a short-lived branch from the latest `develop` for each issue or focused change.
- Open a pull request (PR) from your branch into `develop`. Request review before merging.
- Merge `develop` into `main` when the team agrees the integrated work is ready.

### Branch names

Use lowercase letters and hyphens, with the format `<type>/<short-description>` (optionally include an issue number).

| Type | Use | Example |
| --- | --- | --- |
| `feature/` | New functionality | `feature/agent-offer` |
| `fix/` | Bug fix | `fix/message-validation` |
| `docs/` | Documentation | `docs/branching-convention` |
| `test/` | Tests | `test/offer-schema` |
| `chore/` | Maintenance and tooling | `chore/lint-config` |

Examples with issue IDs: `docs/7-branching-convention`, `feature/12-host-pds`.

### Workflow

```bash
git fetch origin
git switch develop
git pull --ff-only origin develop
git switch -c docs/7-branching-convention

# Make changes, then:
git add docs/Commit-and-Branching-Convention.md
git commit -m "docs: define commit and branching conventions"
git push -u origin docs/7-branching-convention
```

Then open a PR with **base: `develop`** and **compare: your feature branch**. Link the issue, describe the changes, and request review. If `develop` advances, sync your branch before merging and resolve conflicts as needed.

## 2. Commit message convention

Use a simple Conventional Commits style:

```
<type>(optional-scope): <short imperative description>
```

Types:

- `feat`: new feature
- `fix`: bug fix
- `docs`: documentation only
- `test`: add or update tests
- `refactor`: restructure code without changing behavior
- `chore`: maintenance, dependencies, or tooling
- `ci`: CI workflow changes

Examples relevant to this repository:

```
feat(protocol): add agent offer message schema
fix(coordinator): validate registration input
docs: document branch and commit conventions
test(protocol): cover invalid offer messages
chore: update biome configuration
```

Guidelines:

- Use lowercase type names and a colon followed by one space.
- Write a specific, concise summary in imperative form (e.g., `add`, `fix`, `document`).
- Keep each commit focused on one logical change.
- Avoid vague messages like `update`, `stuff`, or `final changes`.
- For substantial changes, add a blank line and a body explaining *why* the change was needed.

## 3. Pull request checklist

- [ ] Branch was created from an up-to-date `develop`.
- [ ] Commits follow the message format above.
- [ ] PR targets `develop` (unless the team agrees otherwise).
- [ ] PR description summarizes the change and links the relevant issue.
- [ ] Relevant checks pass (`npm run typecheck`, `npm run check`, and any applicable tests).
- [ ] At least one teammate reviews the PR before merge, subject to the team's agreed review policy.

**Note:** The uploaded repository snapshot has no configured automated test suite (`npm test` is a placeholder), so do not treat `npm test` as a working check yet. Branch protection and mandatory review settings must be configured separately on GitHub; this document alone does not enforce them.
