## 1. Why use git filter-branch instead of git filter-repo, which is faster and recommended by GitHub?

**Recommended:** Switch to git filter-repo for the history migration. Git filter-branch is deprecated and significantly slower for large repositories, while filter-repo is the officially recommended tool that handles edge cases better. This accepts learning a different tool but gains much faster processing and more reliable results.

## 2. How will you handle shared-libs versioning when multiple repos depend on different versions simultaneously?

**Recommended:** Implement semantic versioning with automated dependency updates via Dependabot or Renovate. Use npm workspaces or similar tooling to test shared-libs changes against dependent repos before publishing. This accepts the complexity of coordinated releases but prevents dependency hell and breaking changes.

## 3. What happens to your CI/CD when a frontend change depends on both shared-libs and backend-api changes?

**Recommended:** Implement cross-repo CI triggers using webhooks or GitHub Actions workflows that can build and test dependent repos when shared components change. Create integration test suites that validate the entire stack across repositories. This accepts significantly more complex CI orchestration but maintains quality gates.

## 4. How will developers work on features that span multiple repositories after the split?

**Recommended:** Use git submodules or a workspace tool like Nx, Rush, or Lerna to manage local development across repos. Create developer tooling that can clone and link related repositories automatically. This accepts increased setup complexity but maintains developer productivity for cross-cutting features.

## 5. How will you prevent diamond dependency problems when shared-libs has its own dependencies?

**Recommended:** Use peer dependencies in shared-libs for common packages (React, lodash, etc.) and strict dependency pinning for internal utilities. Implement automated dependency conflict detection in your CI pipeline. This accepts some risk of version mismatches but prevents bundling conflicts and version sprawl.

## 6. What's your rollback strategy if the split causes critical issues in production?

**Recommended:** Maintain the monorepo in read-only mode for 3-6 months after migration as a safety net. Plan the split to happen during a low-traffic period with full production monitoring. Have scripts ready to quickly revert to monorepo builds if needed. This accepts temporary storage overhead but provides escape hatch for critical issues.

## 7. How will you coordinate releases when a feature requires changes across frontend, backend-api, and shared-libs?

**Recommended:** Implement release trains with coordinated deployment windows. Use feature flags to decouple deployment from feature activation. Create release planning tools that track cross-repo dependencies. This accepts more complex release management but maintains atomic feature delivery.

## 8. How will you handle repository access permissions and security boundaries after the split?

**Recommended:** Map current team permissions to new repository structure, giving teams ownership of their primary repos while maintaining read access to dependencies. Use GitHub Apps or similar for automated cross-repo operations. This accepts more granular permission management but enables better security boundaries.

## 9. What happens to your build artifacts and deployment pipelines when repos are separated?

**Recommended:** Implement artifact registries (npm for shared-libs, Docker registry for services) and orchestrated deployment pipelines that can handle cross-repo dependencies. Use deployment graphs to ensure proper ordering. This accepts infrastructure complexity but enables independent deployment cadences.

## 10. How will you preserve meaningful git history when filter-branch removes context from other parts of the monorepo?

**Recommended:** Before splitting, document cross-component relationships and create architectural decision records. Preserve commit messages that reference other components. Consider maintaining a metadata repository with the full history for archaeological needs. This accepts some loss of immediate context but preserves critical decision history.

## Summary

### Resolved
- **History migration**: Use git filter-repo instead of deprecated filter-branch
- **Dependency management**: Semantic versioning with automated updates
- **Development workflow**: Git submodules or workspace tools for local development
- **Versioning strategy**: Peer dependencies to prevent diamond problems
- **Security model**: Granular repo permissions mapped from current team structure
- **Rollback plan**: Maintain read-only monorepo for 3-6 months as safety net

### Unresolved
- **Shared-libs publication timeline**: How quickly do you need to start publishing to npm?
- **CI/CD tooling choice**: Which specific tools will orchestrate cross-repo builds?
- **Feature flag implementation**: Do you have feature flagging infrastructure in place?
- **Team coordination process**: Who will own cross-repo feature planning and release coordination?
- **Migration schedule**: Which repository should be split first to minimize risk?