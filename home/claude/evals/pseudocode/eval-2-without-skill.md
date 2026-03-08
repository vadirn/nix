---
name: pr
description: Creates a pull request for the current branch. Use when the user wants to open a PR, submit for review, or says "create PR", "open PR", "submit PR".
---

# Create Pull Request

Opens a draft pull request from the current branch.

## Process

1. **Gather state** (parallel):
   - `git status` — check for uncommitted changes
   - `git branch --show-current` — current branch
   - `gh repo view --json defaultBranchRef -q .defaultBranchRef.name` — default branch

2. **Guard: wrong branch**
   - If current branch == default branch → stop, tell user to create a feature branch

3. **Guard: dirty working tree**
   - If uncommitted changes exist → run `/commit` skill, then stop

4. **Push**
   - If no upstream: `git push -u origin <branch>`
   - Else if ahead of remote: `git push`
   - Else: skip (already up to date)

5. **Check existing PR**
   - `gh pr view --json url -q .url`
   - If PR exists → show URL, ask whether to update or stop

6. **Generate PR content** from `git diff <default-branch>...HEAD` and commit log:
   - **Title**: under 70 chars, conventional commit style (feat:, fix:, chore:)
   - **Body**:

     ```
     ## Summary
     - <bullet points describing changes>

     ## Test plan
     - [ ] <checklist items>
     ```

7. **Confirm with user**
   - Show title and body
   - Wait for approval before proceeding

8. **Create PR**
   - Always `--draft` unless user explicitly said otherwise
   - Use HEREDOC for body to preserve formatting:

     ```
     gh pr create --draft --title "the title" --body "$(cat <<'EOF'
     ## Summary
     ...

     ## Test plan
     ...
     EOF
     )"
     ```

9. **Show PR URL**
