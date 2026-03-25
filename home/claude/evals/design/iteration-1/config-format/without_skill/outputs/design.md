# Configuration Format Design for Autonomous Pipeline Runner

## Design 1: Declarative YAML

**Schema:**
```yaml
pipeline:
  name: "data-processing-pipeline"
  version: "1.0.0"

defaults:
  model: "claude-sonnet-4"
  max_rounds: 50
  timeout: 300
  retry_policy: "stop"

steps:
  - name: "extract"
    prompt: "Extract data from source systems and validate format"
    accept:
      - "Data extraction completed successfully"
      - "All required fields present in extracted data"
      - "Data validation passes with no critical errors"
    depends_on: []
    skills: ["data-fetch", "validation"]
    model: "claude-haiku-4"  # Override default
    max_rounds: 10

    retry:
      max_attempts: 3
      on_failure: "retry"
      backoff: "exponential"

    verification: "test -f extracted_data.json && jq '.records | length > 0' extracted_data.json"

  - name: "transform"
    prompt: "Transform extracted data according to business rules and clean inconsistencies"
    accept:
      - "Data transformation applied successfully"
      - "Output schema matches target format"
      - "Data quality checks pass"
    depends_on: ["extract"]
    skills: ["data-transform", "validation"]

  - name: "load"
    prompt: "Load transformed data into target system with error handling"
    accept:
      - "Data loaded successfully to target system"
      - "Load process completed without data loss"
      - "Target system confirms data integrity"
    depends_on: ["transform"]
    skills: ["data-load", "monitoring"]
```

**Usage Example:**
```bash
# Run pipeline with defaults
pipeline-runner execute data-pipeline.yaml

# Override global settings
pipeline-runner execute data-pipeline.yaml \
  --set defaults.model=claude-opus-4-6 \
  --set defaults.max_rounds=100

# Environment variables override
PIPELINE_MODEL=claude-sonnet-4-6 pipeline-runner execute data-pipeline.yaml
```

**Tradeoffs:**
- ✅ Human-readable and intuitive structure
- ✅ Clear inheritance from defaults to steps
- ✅ Native support for arrays and complex data types
- ✅ Good tool support for editing and validation
- ❌ YAML parsing quirks and indentation sensitivity
- ❌ Limited ability to validate complex business rules
- ❌ Verbose for simple linear pipelines

## Design 2: Code-as-Configuration (Python DSL)

**Schema:**
```python
from pipeline import Pipeline, Step, RetryPolicy

# Define pipeline using fluent interface
pipeline = Pipeline("data-processing") \
    .version("1.0.0") \
    .default_model("claude-sonnet-4") \
    .default_timeout(300)

# Define steps with method chaining
extract = Step("extract") \
    .prompt("Extract data from source systems and validate format") \
    .accept([
        "Data extraction completed successfully",
        "All required fields present in extracted data"
    ]) \
    .skills(["data-fetch", "validation"]) \
    .model("claude-haiku-4") \
    .max_rounds(10) \
    .retry(RetryPolicy.exponential(max_attempts=3)) \
    .verify("test -f extracted_data.json")

transform = Step("transform") \
    .prompt("Transform extracted data according to business rules") \
    .accept([
        "Data transformation applied successfully",
        "Output schema matches target format"
    ]) \
    .depends_on(extract) \
    .skills(["data-transform", "validation"])

load = Step("load") \
    .prompt("Load transformed data into target system") \
    .accept([
        "Data loaded successfully to target system",
        "Load process completed without data loss"
    ]) \
    .depends_on(transform) \
    .skills(["data-load", "monitoring"])

# Assemble pipeline
pipeline.add_steps([extract, transform, load])

# Export for runner
pipeline.export("data-pipeline.json")
```

**Usage Example:**
```bash
# Generate config from Python
python3 data-pipeline.py

# Run generated pipeline
pipeline-runner execute data-pipeline.json

# Dynamic configuration with Python logic
python3 -c "
import pipeline_config as cfg
cfg.pipeline.default_model = 'claude-opus-4-6'
cfg.extract.max_rounds = 20 if cfg.is_production else 5
cfg.pipeline.export('runtime-pipeline.json')
"
pipeline-runner execute runtime-pipeline.json
```

**Tradeoffs:**
- ✅ Full programming language power for complex logic
- ✅ Type checking and IDE support (autocomplete, refactoring)
- ✅ Reusable components and abstraction capabilities
- ✅ Dynamic configuration based on environment/conditions
- ❌ Requires programming knowledge to modify
- ❌ More complex toolchain and dependencies
- ❌ Harder to review configuration changes in git
- ❌ Runtime evaluation needed to see final config

## Design 3: Flat Environment-Based

**Schema:**
```bash
# Pipeline metadata
PIPELINE_NAME=data-processing-pipeline
PIPELINE_VERSION=1.0.0

# Global defaults
DEFAULT_MODEL=claude-sonnet-4
DEFAULT_MAX_ROUNDS=50
DEFAULT_TIMEOUT=300
DEFAULT_RETRY_POLICY=stop

# Step 1: extract
STEP_1_NAME=extract
STEP_1_PROMPT="Extract data from source systems and validate format"
STEP_1_ACCEPT="Data extraction completed successfully; All required fields present"
STEP_1_DEPENDS_ON=
STEP_1_SKILLS=data-fetch,validation
STEP_1_MODEL=claude-haiku-4
STEP_1_MAX_ROUNDS=10
STEP_1_RETRY_MAX_ATTEMPTS=3
STEP_1_RETRY_ON_FAILURE=retry
STEP_1_RETRY_BACKOFF=exponential
STEP_1_VERIFY="test -f extracted_data.json && jq '.records | length > 0' extracted_data.json"

# Step 2: transform
STEP_2_NAME=transform
STEP_2_PROMPT="Transform extracted data according to business rules and clean inconsistencies"
STEP_2_ACCEPT="Data transformation applied successfully; Output schema matches target format"
STEP_2_DEPENDS_ON=extract
STEP_2_SKILLS=data-transform,validation
STEP_2_MODEL=${DEFAULT_MODEL}
STEP_2_MAX_ROUNDS=${DEFAULT_MAX_ROUNDS}

# Step 3: load
STEP_3_NAME=load
STEP_3_PROMPT="Load transformed data into target system with error handling"
STEP_3_ACCEPT="Data loaded successfully; Load process completed without data loss"
STEP_3_DEPENDS_ON=transform
STEP_3_SKILLS=data-load,monitoring
STEP_3_MODEL=${DEFAULT_MODEL}
STEP_3_MAX_ROUNDS=${DEFAULT_MAX_ROUNDS}
```

**Usage Example:**
```bash
# Load from file
pipeline-runner execute --config data-pipeline.env

# Override via environment
export STEP_1_MAX_ROUNDS=20
export DEFAULT_MODEL=claude-opus-4-6
pipeline-runner execute --config data-pipeline.env

# Search and modify with standard tools
grep "MODEL=" data-pipeline.env          # Find all model settings
sed -i 's/claude-haiku-4/claude-sonnet-4/g' data-pipeline.env  # Bulk replace
grep "DEPENDS_ON=extract" data-pipeline.env  # Find dependencies

# Generate variations programmatically
cat data-pipeline.env | sed 's/MAX_ROUNDS=50/MAX_ROUNDS=100/g' > high-rounds-pipeline.env
```

**Tradeoffs:**
- ✅ Simple key-value format compatible with shell tools
- ✅ Easy environment variable override capabilities
- ✅ Grep-friendly for searching and bulk operations
- ✅ No parsing complexity or dependencies
- ❌ Verbose and repetitive (STEP_N_PREFIX for everything)
- ❌ Limited data types (everything is a string)
- ❌ Poor readability for complex configurations
- ❌ No validation or schema enforcement

## Comparison & Analysis

**Ease of Authoring:**
- Code-as-Configuration: Best for programmers, worst for operators
- Declarative YAML: Good balance of readability and functionality
- Flat Environment: Simple but verbose and repetitive

**Validation & Safety:**
- Code-as-Configuration: Best (type checking, IDE support)
- Declarative YAML: Good (schema validation possible)
- Flat Environment: Worst (no built-in validation)

**Tool Integration:**
- Flat Environment: Best (grep, sed, awk, env vars)
- Declarative YAML: Good (YAML tools, editors)
- Code-as-Configuration: Mixed (great IDE support, limited ops tools)

**Flexibility:**
- Code-as-Configuration: Highest (full language capabilities)
- Declarative YAML: Medium (structured but limited logic)
- Flat Environment: Lowest (key-value only)

**Maintainability:**
- Declarative YAML: Best balance of structure and simplicity
- Code-as-Configuration: Good for complex cases, overkill for simple ones
- Flat Environment: Poor for large configurations

## Recommendation

**Choose Declarative YAML for most use cases** because:

1. **Optimal balance**: Readable for humans, parseable by machines
2. **Industry standard**: Widely adopted in DevOps and configuration management
3. **Tool ecosystem**: Rich support for editing, validation, and transformation
4. **Scalability**: Handles both simple and complex pipelines effectively
5. **Version control friendly**: Clean diffs and merge behavior

**Implementation considerations:**
- Use YAML schema validation to catch errors early
- Support environment variable overrides for operational flexibility
- Provide templates and examples for common patterns
- Include linting tools to enforce consistency

**When to consider alternatives:**
- **Use Code-as-Configuration** for highly dynamic pipelines with complex business logic
- **Use Flat Environment** for simple linear pipelines in constrained environments

The YAML approach provides the best developer experience while maintaining operational flexibility and avoiding the complexity overhead of more sophisticated approaches.