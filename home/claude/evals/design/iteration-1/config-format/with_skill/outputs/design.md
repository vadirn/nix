# Configuration Format Design for Autonomous Pipeline Runner

## Design 1: Flat Key-Value

**Configuration Format:**
```
# Core pipeline metadata
PIPELINE_NAME=design-evaluation-pipeline
PIPELINE_VERSION=1.0

# Global defaults (inherited by all steps unless overridden)
DEFAULT_MODEL=claude-sonnet-4-20250514
DEFAULT_IMAGE=claude-runner
DEFAULT_MAX_ROUNDS=50
DEFAULT_WAIT=30
DEFAULT_RESOLVE_QUESTIONS=true

# Step definitions - use step index for ordering
STEP_0_NAME=setup
STEP_0_PROMPT=Initialize workspace and validate prerequisites
STEP_0_ACCEPT=All required files exist and environment is ready
STEP_0_DEPENDS_ON=
STEP_0_SKILLS=checkpoint
STEP_0_MODEL=claude-haiku-4-5
STEP_0_MAX_ROUNDS=3
STEP_0_ON_FAIL=stop
STEP_0_MAX_RETRIES=2
STEP_0_VERIFY=test -f requirements.txt && python3 -m py_compile *.py

STEP_1_NAME=data-collection
STEP_1_PROMPT=Gather evaluation data from specified sources and validate format
STEP_1_ACCEPT=Data files exist in correct format with required fields
STEP_1_DEPENDS_ON=setup
STEP_1_SKILLS=checkpoint,data-fetch
STEP_1_MODEL=${DEFAULT_MODEL}
STEP_1_MAX_ROUNDS=${DEFAULT_MAX_ROUNDS}
STEP_1_ON_FAIL=retry
STEP_1_MAX_RETRIES=3
STEP_1_VERIFY=python3 validate_data.py --check-format

STEP_2_NAME=benchmark-execution
STEP_2_PROMPT=Run benchmark suite with both skill and non-skill variants
STEP_2_ACCEPT=All benchmark results saved with timing metadata
STEP_2_DEPENDS_ON=data-collection
STEP_2_SKILLS=checkpoint,bench,design
STEP_2_MODEL=${DEFAULT_MODEL}
STEP_2_MAX_ROUNDS=10
STEP_2_IMAGE=claude-runner-benchmark
STEP_2_ON_FAIL=retry
STEP_2_MAX_RETRIES=1
STEP_2_VERIFY=python3 validate_results.py --count-outputs
```

**Usage Example:**
```bash
# Override specific values via environment
export STEP_1_MAX_RETRIES=5
export DEFAULT_MODEL=claude-opus-4-6
export STEP_2_VERIFY="python3 custom_verify.py"

# Run pipeline with overrides
python3 run.py --workspace /project --config pipeline.env

# Grep-friendly operations
grep "SKILLS.*design" pipeline.env          # Find steps using design skill
grep "ON_FAIL=retry" pipeline.env           # Find steps with retry policies
grep "DEPENDS_ON.*data-collection" pipeline.env  # Find dependency chain
```

**Hidden Complexity:**
- Dependency graph resolution with topological sorting
- Variable expansion (${DEFAULT_MODEL} references)
- Type coercion and validation (strings → bools, ints, arrays)
- Configuration inheritance (defaults → step overrides → env overrides)
- Step ordering and parallel execution planning

**Tradeoffs:**
- ✅ Greppability: Every configuration option is searchable with simple text tools
- ✅ Environment compatibility: All values can be overridden via environment variables
- ✅ Simplicity: No nested structures or complex YAML syntax
- ✅ Tooling: Standard shell tools work (grep, sed, awk)
- ❌ Verbosity: Repetitive prefixes increase config file size
- ❌ Readability: Related settings scattered across file rather than grouped
- ❌ Maintenance: Adding new step requires updating multiple keys
- ❌ Scalability: Large pipelines become unwieldy with many steps

## Design 2: Nested Hierarchy

**Configuration Format:**
```yaml
# Pipeline metadata and global configuration
pipeline:
  name: "autonomous-code-review"
  version: "1.2.0"
  description: "Automated code review pipeline with static analysis and testing"

# Default values inherited by all steps unless overridden
defaults:
  model: "claude-sonnet-4-20250514"
  max_rounds: 50
  timeout: 300s
  image: "claude-runner:latest"
  skills: []

# Runtime configuration separate from execution logic
runtime:
  workspace: "${WORKSPACE_PATH:/tmp/pipeline}"
  cleanup_on_success: true
  cleanup_on_failure: false
  parallel_execution: true
  checkpoint_frequency: "per_step"

# Individual steps with clear hierarchical organization
steps:
  - name: "static-analysis"
    prompt: |
      Analyze the codebase for potential issues using static analysis tools.
      Focus on security vulnerabilities, code quality, and maintainability.

    accept:
      conditions:
        - "Static analysis report generated"
        - "No critical security vulnerabilities found"
        - "Code quality metrics within acceptable range"

      verify: |
        test -f static_analysis_report.json &&
        jq -e '.critical_issues | length == 0' static_analysis_report.json

    # Step-level overrides
    model: "claude-haiku-4-5"  # Faster model for straightforward analysis
    max_rounds: 10

    skills: ["analysis", "security", "checkpoint"]

    retry:
      max_attempts: 3
      on_failure: "retry"
      backoff: "exponential"

  - name: "auto-fix"
    prompt: |
      Review the static analysis results and automatically fix issues that can be
      safely resolved without changing business logic.

    accept:
      conditions:
        - "Fixable issues have been resolved"
        - "Changes preserve existing functionality"
        - "Modified files pass syntax validation"

      verify: |
        python3 -m py_compile src/**/*.py &&
        git diff --name-only | wc -l | grep -q '[1-9]'

    # Dependencies on previous steps
    depends_on: ["static-analysis"]

    skills: ["refactor", "checkpoint"]

    # Custom container with additional tools
    image: "claude-runner-refactor:v2.1"

    retry:
      max_attempts: 2
      on_failure: "continue"  # Don't block pipeline if auto-fix fails

  - name: "test-execution"
    prompt: |
      Execute the full test suite including unit tests, integration tests, and
      end-to-end tests. Analyze any failures and suggest fixes.

    accept:
      conditions:
        - "All tests pass or failures are documented"
        - "Test coverage meets minimum threshold"
        - "Performance benchmarks within acceptable range"

      verify: |
        python3 -m pytest tests/ --cov=src --cov-min-percentage=80 &&
        python3 run_benchmarks.py --threshold=baseline.json

    depends_on: ["auto-fix"]

    skills: ["testing", "benchmark", "checkpoint"]
    timeout: 600s  # Longer timeout for comprehensive testing

  - name: "generate-report"
    prompt: |
      Generate a comprehensive code review report including:
      - Summary of issues found and fixed
      - Test results and coverage metrics
      - Performance analysis
      - Recommendations for further improvement

    accept:
      conditions:
        - "Report generated in markdown format"
        - "All sections complete with actionable recommendations"
        - "Report includes metrics and evidence"

    depends_on: ["static-analysis", "auto-fix", "test-execution"]

    skills: ["analysis", "documentation", "checkpoint"]

    # Can run in parallel with other reporting steps
    parallel: true
```

**Usage Example:**
```bash
# Standard execution
pipeline-runner run code-review-pipeline.yaml

# Override global defaults
pipeline-runner run code-review-pipeline.yaml \
  --set defaults.model=claude-opus-4-6 \
  --set runtime.parallel_execution=false

# Environment-based configuration
export CLAUDE_MODEL=claude-sonnet-4-6
export WORKSPACE_PATH=/project/review-workspace
pipeline-runner run code-review-pipeline.yaml
```

**Hidden Complexity:**
- Dependency resolution engine with topological sorting and parallel execution
- State management with checkpointing and variable scoping
- Retry mechanisms with backoff strategies and failure classification
- Template engine with recursive resolution and type coercion
- Model/skill management with resource allocation and lifecycle handling
- Monitoring systems with metrics, logging, and audit trails

**Tradeoffs:**
- ✅ Intuitive organization: Related settings grouped hierarchically
- ✅ Inheritance patterns: Defaults cascade naturally to steps
- ✅ Maintainability: Easy to add/modify steps and see relationships
- ✅ Schema validation: YAML structure can be validated
- ✅ Extensibility: New fields fit naturally into hierarchy
- ❌ Verbosity: More verbose than flat format for simple cases
- ❌ Complexity creep: Easy to add unnecessary nesting
- ❌ Learning curve: Users must understand YAML and inheritance rules
- ❌ Configuration drift: Complex inheritance can lead to unexpected values

## Design 3: Convention-over-Configuration

**Configuration Format:**

**Minimal `pipeline.yaml`:**
```yaml
target: design-skill
defaults:
  model: claude-sonnet-4
  timeout: 300s
```

**Directory Structure:**
```
.pipeline/
├── pipeline.yaml
├── 01-implement/
│   ├── prompt.md
│   ├── accept.md
│   ├── skills.txt
│   └── verify.sh
├── 02-test/
│   ├── prompt.md
│   └── verify.sh
├── 03-benchmark/
│   ├── prompt.md
│   ├── accept.md
│   ├── skills.txt
│   └── depends.txt
└── 04-document/
    └── prompt.md
```

**Usage Example:**

**`01-implement/prompt.md`:**
```markdown
Implement the design-skill functionality based on the requirements in docs/requirements.md.

The skill should handle design generation with the following interface:
- Input: design topic and constraints
- Output: multiple design alternatives with comparison
- Dependencies: Use existing design patterns and templates
```

**`01-implement/accept.md`:**
```markdown
- Implementation exists in src/design-skill.py
- All requirements from docs/requirements.md are addressed
- Code follows project style guidelines
- Unit tests pass
```

**`03-benchmark/depends.txt`:**
```
01-implement
02-test
```

**Hidden Complexity:**
- Dependency resolution from directory structure and depends.txt files
- Resource management with dynamic container allocation based on step requirements
- Checkpoint management with automatic state persistence and recovery
- Skill loading with dynamic skill discovery and dependency injection
- Failure handling with retry logic, error propagation, and partial recovery

**Tradeoffs:**
- ✅ Minimal cognitive overhead: New users see 5 lines of config, not 50
- ✅ Self-documenting: Directory structure explains the pipeline visually
- ✅ Convention consistency: Enforces patterns across projects
- ✅ Rapid prototyping: Add directory + prompt.md, pipeline runs
- ❌ Convention learning curve: Users must learn the naming/structure rules
- ❌ Reduced flexibility: Complex dependency graphs require explicit depends.txt
- ❌ Implicit magic: Behavior changes based on file presence, harder to debug
- ❌ Migration cost: Existing pipelines need restructuring to fit conventions

## Design 4: Schema-Driven

**Configuration Format:**
```json
{
  "$schema": "https://schemas.example.com/pipeline/v1.json",
  "$comment": "Configuration for autonomous pipeline runner with embedded validation",

  "pipeline": {
    "name": "content-analysis-pipeline",
    "version": "1.0.0",
    "description": "Analyze content quality and generate improvement recommendations"
  },

  "defaults": {
    "model": "claude-sonnet-4-20250514",
    "max_rounds": 50,
    "timeout": "5m",
    "image": "claude-runner:latest"
  },

  "variables": {
    "source_dir": "${INPUT_DIR:/workspace/content}",
    "output_dir": "${OUTPUT_DIR:/workspace/results}",
    "quality_threshold": "${QUALITY_THRESHOLD:0.8}"
  },

  "steps": [
    {
      "name": "content-scan",
      "prompt": "Scan the content directory and catalog all files by type and metadata. Generate a structured inventory.",

      "acceptance_criteria": [
        {
          "type": "file_exists",
          "description": "Inventory file generated",
          "condition": "content_inventory.json"
        },
        {
          "type": "content_validation",
          "description": "All content files cataloged",
          "condition": "jq '.total_files > 0' content_inventory.json"
        }
      ],

      "skills": ["filesystem", "analysis", "checkpoint"],
      "model": "claude-haiku-4-5",
      "max_rounds": 10,

      "retry_policy": {
        "max_attempts": 3,
        "on_failure": "retry",
        "backoff_strategy": "linear",
        "backoff_base": "30s"
      }
    },

    {
      "name": "quality-analysis",
      "prompt": "Analyze content quality using the inventory from content-scan. Generate quality scores and identify improvement areas.",

      "acceptance_criteria": [
        {
          "type": "file_exists",
          "description": "Quality report generated",
          "condition": "quality_report.json"
        },
        {
          "type": "threshold_check",
          "description": "Quality analysis complete",
          "condition": "jq '.analysis_complete == true' quality_report.json"
        }
      ],

      "dependencies": ["content-scan"],
      "skills": ["analysis", "quality-check", "checkpoint"],

      "variables": {
        "min_quality": "${quality_threshold}"
      }
    },

    {
      "name": "generate-recommendations",
      "prompt": "Based on quality analysis results, generate specific improvement recommendations with priority levels.",

      "acceptance_criteria": [
        {
          "type": "file_exists",
          "description": "Recommendations file created",
          "condition": "recommendations.md"
        },
        {
          "type": "content_validation",
          "description": "Recommendations include priority levels",
          "condition": "grep -q 'Priority:' recommendations.md"
        }
      ],

      "dependencies": ["quality-analysis"],
      "skills": ["analysis", "documentation", "checkpoint"],

      "retry_policy": {
        "max_attempts": 2,
        "on_failure": "continue"
      }
    }
  ]
}
```

**Schema Definition (embedded):**
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Pipeline Configuration",
  "description": "Configuration format for autonomous pipeline runner",

  "properties": {
    "pipeline": {
      "type": "object",
      "description": "Pipeline metadata and identification",
      "required": ["name", "version"],
      "properties": {
        "name": {
          "type": "string",
          "pattern": "^[a-z0-9-]+$",
          "description": "Pipeline identifier (lowercase, hyphens allowed)"
        },
        "version": {
          "type": "string",
          "pattern": "^\\d+\\.\\d+\\.\\d+$",
          "description": "Semantic version (e.g., 1.2.3)"
        }
      }
    },

    "steps": {
      "type": "array",
      "description": "Ordered list of pipeline execution steps",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["name", "prompt"],
        "properties": {
          "name": {
            "type": "string",
            "pattern": "^[a-z0-9-]+$",
            "description": "Step identifier for dependencies and logging"
          },
          "prompt": {
            "type": "string",
            "minLength": 10,
            "description": "Task description for the autonomous agent"
          },
          "skills": {
            "type": "array",
            "description": "List of skills available to this step",
            "items": {
              "type": "string",
              "enum": ["analysis", "design", "checkpoint", "testing", "benchmark"]
            }
          }
        }
      }
    }
  }
}
```

**Usage Example:**
```bash
# Validate configuration against schema
jsonschema -i pipeline.json schema.json

# Run with validation
pipeline-runner run --validate pipeline.json

# Override variables
pipeline-runner run pipeline.json \
  --var INPUT_DIR=/project/content \
  --var QUALITY_THRESHOLD=0.9
```

**Hidden Complexity:**
- Schema validation engines with detailed error reporting and suggestion systems
- Dependency resolution with cycle detection and parallel execution optimization
- Variable interpolation with type coercion and recursive resolution
- Model abstraction layer with automatic selection and fallback mechanisms
- Retry logic with sophisticated backoff strategies and failure classification
- Execution state management with checkpointing and recovery mechanisms

**Tradeoffs:**
- ✅ Rich validation: Comprehensive validation prevents runtime errors
- ✅ Self-documenting: Schema provides detailed field descriptions and examples
- ✅ Tool integration: JSON Schema ecosystem provides editors, validators, generators
- ✅ Type safety: Strong typing with enums, patterns, and range validation
- ✅ Evolution support: Schema versioning enables backward compatibility
- ❌ Configuration complexity: Verbose format requiring JSON expertise
- ❌ Schema maintenance: Schema must be updated with configuration changes
- ❌ Runtime overhead: Validation and parsing more expensive than simple formats
- ❌ Limited expressiveness: Some validation rules difficult to express in JSON Schema

## Design Comparison

**Configuration Complexity**:
- **Flat Key-Value** (simplest): Linear list of STEP_N_FIELD=value pairs
- **Convention-over-Configuration**: Minimal explicit config, inferred from structure
- **Nested Hierarchy**: Structured YAML with clear groupings and inheritance
- **Schema-Driven** (most complex): Rich JSON with embedded validation and documentation

**Discoverability**:
- **Schema-Driven** (winner): Self-documenting with descriptions and examples
- **Nested Hierarchy**: Clear structure with inheritance patterns
- **Convention-over-Configuration**: Directory structure explains pipeline visually
- **Flat Key-Value**: Requires external documentation to understand prefixes

**Validation & Safety**:
- **Schema-Driven** (winner): Comprehensive validation at parse time
- **Nested Hierarchy**: YAML schema validation available
- **Convention-over-Configuration**: Runtime validation through conventions
- **Flat Key-Value**: Minimal validation, runtime type coercion

**Maintainability**:
- **Convention-over-Configuration** (winner for simple cases): Add directory = add step
- **Nested Hierarchy**: Natural grouping makes changes intuitive
- **Schema-Driven**: Verbose but self-explaining changes
- **Flat Key-Value**: Scattered settings, prone to inconsistency

**Tool Integration**:
- **Flat Key-Value** (winner): grep, sed, awk, environment variables
- **Schema-Driven**: Rich tooling via JSON Schema ecosystem
- **Nested Hierarchy**: Standard YAML tooling
- **Convention-over-Configuration**: File system tools, limited config tooling

**Scalability to Complex Pipelines**:
- **Schema-Driven** (winner): Handles arbitrary complexity with validation
- **Nested Hierarchy**: Natural scaling through hierarchical organization
- **Flat Key-Value**: Becomes unwieldy with many steps
- **Convention-over-Configuration**: Convention breaks down for complex dependencies

## Synthesis & Recommendation

**For most autonomous pipeline runners, choose Nested Hierarchy with schema validation**:

1. **Natural organization**: Groups related settings logically (defaults, steps, runtime)
2. **Scalability**: Handles both simple and complex pipelines gracefully
3. **Developer experience**: Familiar YAML syntax with clear inheritance patterns
4. **Tool support**: Rich ecosystem of YAML editors, validators, and processors

**Hybrid approach for optimal results**:
- Use **Nested Hierarchy** as the primary format for maintainability
- Add **Schema-Driven** validation for safety and documentation
- Support **Flat Key-Value** environment overrides for operational flexibility
- Provide **Convention-over-Configuration** shortcuts for common patterns

**Implementation strategy**:
```yaml
# Core nested structure
pipeline:
  name: my-pipeline
  defaults:
    model: claude-sonnet-4
    max_rounds: 50

# Schema validation (embedded or external)
$schema: https://schemas.example.com/pipeline/v1.json

# Convention shortcuts
steps:
  - from_directory: ./steps/  # Auto-discover from file structure
  - name: custom-step         # Explicit when conventions don't fit
    prompt: "Custom logic here"
```

**Environment override support**:
```bash
# Override any nested value via flat key
PIPELINE_DEFAULTS_MODEL=claude-opus-4-6
STEP_BENCHMARK_MAX_ROUNDS=10
```

This hybrid approach maximizes both developer productivity and operational reliability while providing escape hatches for complex edge cases that don't fit standard patterns.