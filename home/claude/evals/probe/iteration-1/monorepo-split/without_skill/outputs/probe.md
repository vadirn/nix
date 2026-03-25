## Git History Migration Tool Choice

**Question:** Is git filter-branch the best tool for preserving history when splitting repositories?

**Recommended Answer:** Use git filter-repo instead of git filter-branch. Git filter-branch is deprecated, significantly slower, and more error-prone for large repositories. Git filter-repo is the officially recommended replacement that handles edge cases better and processes history much faster. The learning curve for filter-repo is minimal but the reliability gains are substantial.

## Shared Library Dependency Versioning

**Question:** How will you prevent dependency hell when multiple repos depend on different versions of shared-libs?

**Recommended Answer:** Implement strict semantic versioning for shared-libs with automated testing against all consuming repositories before publication. Use peer dependencies for common packages like React or lodash to prevent version conflicts. Set up Dependabot or Renovate to automatically update dependencies across repos while running full test suites. The tradeoff is more complex release coordination but you avoid version incompatibility issues.

## Cross-Repository Feature Development

**Question:** How will developers work on features that require changes across multiple repositories simultaneously?

**Recommended Answer:** Use git submodules or a monorepo tool like Nx/Rush/Lerna for local development workflows. Create developer scripts that can clone and link related repositories automatically. Implement feature flags to decouple deployment from feature activation across repos. This accepts increased local setup complexity but maintains developer productivity for cross-cutting features.

## CI/CD Pipeline Orchestration

**Question:** How will you handle CI/CD when changes in shared-libs need to trigger builds and tests in dependent repositories?

**Recommended Answer:** Implement cross-repo CI triggers using webhooks or GitHub Actions that can build downstream dependencies when shared components change. Create integration test suites that validate the entire application stack across repositories. Use artifact registries (npm, Docker) to coordinate deployments. This significantly increases CI complexity but maintains quality gates and coordination.

## Dependency Diamond Problems

**Question:** What happens when shared-libs depends on library X version 1, but frontend depends on both shared-libs and library X version 2?

**Recommended Answer:** Design shared-libs with peer dependencies for common packages rather than direct dependencies. Use strict dependency linting rules to catch conflicts early. Implement automated conflict detection in CI pipelines that test shared-libs integration with different versions of peer dependencies. Accept some risk of runtime version mismatches to prevent bundling conflicts.

## Release Coordination Complexity

**Question:** How will you coordinate releases when a single feature requires changes to frontend, backend-api, and shared-libs?

**Recommended Answer:** Implement release trains with scheduled deployment windows for coordinated changes. Use feature flags to enable features only after all components are deployed. Create release planning tooling that tracks cross-repo dependencies and validates deployment order. This adds significant release management complexity but maintains atomic feature delivery.

## Access Control and Security Boundaries

**Question:** How will repository permissions change when code is split across multiple repos with different team ownership?

**Recommended Answer:** Map current team access to new repository ownership while ensuring teams maintain read access to dependencies. Use GitHub Apps or service accounts for automated cross-repo operations. Implement security scanning across all repos with centralized policy management. This requires more granular permission management but enables better security boundaries and team autonomy.

## Build System and Deployment Pipelines

**Question:** How will you handle build orchestration when components have interdependencies across repositories?

**Recommended Answer:** Implement directed acyclic graph (DAG) based build systems that understand cross-repo dependencies. Use artifact registries to publish and consume build outputs. Create deployment pipelines that can handle partial failures and rollback scenarios across multiple repos. This increases infrastructure complexity significantly but enables independent deployment cadences.

## Developer Onboarding and Local Setup

**Question:** How will new developers set up their local environment when the codebase is split across 4+ repositories?

**Recommended Answer:** Create comprehensive developer tooling that can clone, link, and configure all related repositories with a single command. Use Docker Compose or similar tools to standardize local development environments. Document the new workflows extensively and provide troubleshooting guides. This increases onboarding complexity but can be mitigated with good tooling.

## History Context and Cross-Repository Archaeology

**Question:** How will developers understand historical context when git blame only shows history within each individual repository?

**Recommended Answer:** Before splitting, create comprehensive documentation of cross-component relationships and architectural decisions. Preserve commit messages that reference other components. Consider maintaining a metadata repository with the complete monorepo history for historical research. Accept some loss of immediate context but preserve critical institutional knowledge through documentation.

## Rollback and Recovery Strategy

**Question:** What's your plan if the repository split causes critical production issues or developer productivity problems?

**Recommended Answer:** Maintain the original monorepo in read-only mode for 3-6 months as a safety net. Plan the migration during low-traffic periods with comprehensive monitoring. Have scripts ready to quickly revert to monorepo-style builds if critical issues arise. Implement gradual migration by moving repositories one at a time rather than all simultaneously. This provides escape hatches but requires maintaining parallel systems temporarily.

## Summary

The monorepo split plan addresses scalability and team ownership goals but introduces significant complexity in dependency management, release coordination, and developer workflows. Success depends heavily on implementing robust tooling for cross-repo development, comprehensive CI/CD orchestration, and maintaining good documentation during the transition. The biggest risks center around developer productivity degradation and the complexity of coordinating changes across multiple repositories.