# Configuration Format Design: Autonomous Pipeline Runner

## Design 1: Declarative YAML with DAG Specification

**Constraint:** Optimize for human readability and explicit dependency declaration.

### Schema Design
```yaml
# pipeline.yaml
apiVersion: pipeline/v1
kind: Pipeline
metadata:
  name: "content-generation-pipeline"
  description: "Automated content creation and review workflow"
  version: "1.2.0"

spec:
  defaults:
    model: "claude-sonnet-4"
    max_retries: 3
    retry_backoff: "exponential"
    timeout: "30m"

  steps:
    - name: "research"
      prompt: |
        Research the topic: {{.input.topic}}
        Provide key insights and data points.
      acceptance_criteria:
        - "Contains at least 5 factual claims with sources"
        - "Word count between 200-500 words"
        - "No factual errors detected"
      model: "claude-opus-4"
      skills: ["web-search", "fact-check"]
      timeout: "15m"
      
    - name: "draft-content"
      depends_on: ["research"]
      prompt: |
        Using the research from step 'research':
        {{.steps.research.output}}
        
        Create a blog post about {{.input.topic}}
      acceptance_criteria:
        - "Word count 800-1200"
        - "Includes introduction, body, and conclusion"
        - "References research findings"
      skills: ["writing"]
      retry_policy:
        max_attempts: 5
        backoff: "linear"
        
    - name: "review-and-edit"
      depends_on: ["draft-content"]
      prompt: |
        Review and improve this draft:
        {{.steps.draft-content.output}}
        
        Focus on clarity, engagement, and accuracy.
      acceptance_criteria:
        - "Grammar and style score > 90%"
        - "Readability grade level < 12"
        - "No plagiarism detected"
      model: "claude-sonnet-4-latest"
      skills: ["grammar-check", "plagiarism-check"]
      
    - name: "generate-metadata"
      depends_on: ["review-and-edit"]
      prompt: |
        Generate SEO metadata for this content:
        {{.steps.review-and-edit.output}}
      acceptance_criteria:
        - "Title length 50-60 characters"
        - "Meta description 150-160 characters"
        - "Contains 3-5 relevant keywords"
      parallel: true  # Can run in parallel with other final steps
      
  inputs:
    topic:
      type: string
      required: true
      description: "The main topic for content generation"
      
  outputs:
    final_content: "{{.steps.review-and-edit.output}}"
    seo_metadata: "{{.steps.generate-metadata.output}}"
    research_summary: "{{.steps.research.output}}"
```

### Usage Example
```bash
# Run pipeline with input
pipeline-runner execute --config pipeline.yaml --input topic="AI in Healthcare"

# Validate configuration
pipeline-runner validate --config pipeline.yaml

# Generate execution plan
pipeline-runner plan --config pipeline.yaml --dry-run
```

### Tradeoffs
- **Pros:** Clear dependency visualization, explicit schema validation, GitOps friendly
- **Cons:** Verbose for simple pipelines, limited dynamic behavior, YAML complexity

## Design 2: Functional Programming DSL

**Constraint:** Optimize for composability and programmatic configuration.

### Schema Design
```python
# pipeline.py
from pipeline_runner import Pipeline, Step, Model, Skills

def create_content_pipeline():
    return (Pipeline("content-generation")
        .with_defaults(
            model=Model.CLAUDE_SONNET_4,
            max_retries=3,
            timeout="30m"
        )
        .add_step(
            Step("research")
            .prompt("""
                Research the topic: {input.topic}
                Provide key insights and data points.
            """)
            .accept_when(
                word_count_between(200, 500),
                contains_sources(min=5),
                no_factual_errors()
            )
            .use_model(Model.CLAUDE_OPUS_4)
            .with_skills(Skills.WEB_SEARCH, Skills.FACT_CHECK)
            .timeout("15m")
        )
        .add_step(
            Step("draft-content")
            .depends_on("research")
            .prompt("""
                Using the research from step 'research':
                {steps.research.output}
                
                Create a blog post about {input.topic}
            """)
            .accept_when(
                word_count_between(800, 1200),
                has_structure(["introduction", "body", "conclusion"]),
                references_research()
            )
            .with_skills(Skills.WRITING)
            .retry_policy(max_attempts=5, backoff="linear")
        )
        .add_step(
            Step("review-and-edit")
            .depends_on("draft-content")
            .prompt("""
                Review and improve this draft:
                {steps.draft-content.output}
                
                Focus on clarity, engagement, and accuracy.
            """)
            .accept_when(
                grammar_score_above(90),
                readability_below_grade(12),
                no_plagiarism()
            )
            .use_model(Model.CLAUDE_SONNET_4_LATEST)
            .with_skills(Skills.GRAMMAR_CHECK, Skills.PLAGIARISM_CHECK)
        )
        .add_parallel_step(
            Step("generate-metadata")
            .depends_on("review-and-edit")
            .prompt("Generate SEO metadata for: {steps.review-and-edit.output}")
            .accept_when(
                title_length_between(50, 60),
                meta_description_length_between(150, 160),
                keyword_count_between(3, 5)
            )
        )
        .with_inputs(
            required_string("topic", "The main topic for content generation")
        )
        .with_outputs(
            "final_content": "{steps.review-and-edit.output}",
            "seo_metadata": "{steps.generate-metadata.output}",
            "research_summary": "{steps.research.output}"
        )
    )

# Custom acceptance criteria
def word_count_between(min_words, max_words):
    return AcceptanceCriteria(
        name=f"word_count_{min_words}_{max_words}",
        check=lambda output: min_words <= len(output.split()) <= max_words
    )

def contains_sources(min=1):
    return AcceptanceCriteria(
        name=f"contains_{min}_sources",
        check=lambda output: len(re.findall(r'(http|www|doi)', output)) >= min
    )
```

### Usage Example
```python
# Create and execute pipeline
pipeline = create_content_pipeline()
result = pipeline.execute(topic="AI in Healthcare")

# Conditional pipeline modifications
if environment == "production":
    pipeline = pipeline.with_model_override(Model.CLAUDE_OPUS_4)

# Compose with other pipelines
full_workflow = (create_content_pipeline()
    .chain(create_publishing_pipeline())
    .chain(create_analytics_pipeline()))
```

### Tradeoffs
- **Pros:** Type safety, IDE support, powerful composition, custom acceptance criteria
- **Cons:** Requires programming knowledge, less accessible to non-developers, deployment complexity

## Design 3: JSON Schema with Templating Engine

**Constraint:** Optimize for tool integration and dynamic configuration generation.

### Schema Design
```json
{
  "schema_version": "1.0",
  "pipeline": {
    "name": "content-generation-pipeline",
    "description": "Automated content creation workflow",
    "settings": {
      "default_model": "claude-sonnet-4",
      "global_timeout": "30m",
      "retry_strategy": {
        "default_max_attempts": 3,
        "default_backoff": "exponential",
        "backoff_multiplier": 2
      }
    }
  },
  "steps": [
    {
      "id": "research",
      "type": "llm_task",
      "config": {
        "prompt": {
          "template": "research_topic.j2",
          "variables": {
            "topic": "{{pipeline.inputs.topic}}"
          }
        },
        "model": "claude-opus-4",
        "skills": ["web-search", "fact-check"],
        "timeout": "15m",
        "acceptance": {
          "rules": [
            {
              "type": "word_count",
              "min": 200,
              "max": 500
            },
            {
              "type": "regex_count",
              "pattern": "(http|www|doi)",
              "min": 5,
              "description": "Must contain at least 5 source references"
            },
            {
              "type": "fact_check",
              "threshold": 0.95
            }
          ],
          "operator": "all"
        }
      }
    },
    {
      "id": "draft-content",
      "type": "llm_task",
      "dependencies": ["research"],
      "config": {
        "prompt": {
          "template": "draft_blog_post.j2",
          "variables": {
            "topic": "{{pipeline.inputs.topic}}",
            "research_output": "{{steps.research.output}}"
          }
        },
        "skills": ["writing"],
        "retry_policy": {
          "max_attempts": 5,
          "backoff": "linear"
        },
        "acceptance": {
          "rules": [
            {
              "type": "word_count",
              "min": 800,
              "max": 1200
            },
            {
              "type": "structure_check",
              "required_sections": ["introduction", "body", "conclusion"]
            },
            {
              "type": "content_reference",
              "source_step": "research",
              "min_references": 2
            }
          ]
        }
      }
    },
    {
      "id": "review-and-edit",
      "type": "llm_task",
      "dependencies": ["draft-content"],
      "config": {
        "prompt": {
          "text": "Review and improve this draft:\n{{steps.draft-content.output}}\n\nFocus on clarity, engagement, and accuracy."
        },
        "model": "claude-sonnet-4-latest",
        "skills": ["grammar-check", "plagiarism-check"],
        "acceptance": {
          "rules": [
            {
              "type": "grammar_score",
              "min_score": 90
            },
            {
              "type": "readability_grade",
              "max_grade": 12
            },
            {
              "type": "plagiarism_check",
              "max_similarity": 0.15
            }
          ]
        }
      }
    },
    {
      "id": "generate-metadata",
      "type": "llm_task",
      "dependencies": ["review-and-edit"],
      "parallel": true,
      "config": {
        "prompt": {
          "text": "Generate SEO metadata for this content:\n{{steps.review-and-edit.output}}"
        },
        "acceptance": {
          "rules": [
            {
              "type": "field_length",
              "field": "title",
              "min": 50,
              "max": 60
            },
            {
              "type": "field_length", 
              "field": "meta_description",
              "min": 150,
              "max": 160
            },
            {
              "type": "keyword_count",
              "min": 3,
              "max": 5
            }
          ]
        }
      }
    }
  ],
  "inputs": {
    "topic": {
      "type": "string",
      "required": true,
      "description": "The main topic for content generation",
      "validation": {
        "min_length": 5,
        "max_length": 100
      }
    }
  },
  "outputs": {
    "final_content": "{{steps.review-and-edit.output}}",
    "seo_metadata": "{{steps.generate-metadata.output}}",
    "research_summary": "{{steps.research.output}}"
  },
  "templates": {
    "research_topic.j2": "Research the topic: {{topic}}\nProvide key insights and data points with sources.",
    "draft_blog_post.j2": "Using this research:\n{{research_output}}\n\nCreate a comprehensive blog post about {{topic}}"
  }
}
```

### Usage Example
```bash
# Execute with JSON config
pipeline-runner run --config pipeline.json --input '{"topic": "AI in Healthcare"}'

# Generate config from template with environment variables
pipeline-runner generate-config --template base-pipeline.json.tmpl --env prod --output pipeline.json

# Validate against JSON Schema
pipeline-runner validate --config pipeline.json --schema pipeline-schema.json

# API integration
curl -X POST /api/pipeline/execute \
  -H "Content-Type: application/json" \
  -d @pipeline.json
```

### Tradeoffs
- **Pros:** Universal tool compatibility, strong validation, template reuse, API friendly
- **Cons:** Verbose JSON syntax, limited expressiveness, template management overhead

## Comparison

| Aspect | YAML DAG | Python DSL | JSON + Templates |
|--------|----------|------------|------------------|
| Human readability | Excellent | Good | Good |
| Tool integration | Good | Poor | Excellent |
| Type safety | None | Excellent | Schema-based |
| Expressiveness | Limited | High | Medium |
| Learning curve | Low | High | Medium |
| Version control | Excellent | Good | Excellent |
| Dynamic generation | Poor | Excellent | Good |
| Validation | Schema-based | Compile-time | Runtime + Schema |

## Synthesis and Recommendation

For an autonomous pipeline runner, I recommend **Design 1: Declarative YAML with DAG Specification** as the primary configuration format with the following rationale:

1. **Accessibility:** YAML syntax is familiar to both technical and non-technical users, lowering the barrier to pipeline creation

2. **GitOps alignment:** YAML configurations integrate naturally with version control workflows and CI/CD pipelines

3. **Explicit dependencies:** The declarative dependency model makes pipeline structure immediately visible and debuggable

4. **Tooling ecosystem:** Mature tooling exists for YAML validation, editing, and processing

**Implementation strategy:**
- Start with YAML for v1.0 focusing on explicit, readable configurations
- Add templating support using Jinja2 or similar for dynamic content generation
- Provide Python DSL as an advanced feature for power users requiring programmatic generation
- Support JSON import/export for API and tool integrations

**Key design decisions:**
- Use explicit `depends_on` arrays rather than implicit dependency inference
- Support both inline and external template files for prompt reuse
- Provide comprehensive acceptance criteria validation with clear error messages
- Enable parallel execution flags for performance optimization

This approach balances ease of use, operational clarity, and the specific requirements of autonomous pipeline orchestration while remaining accessible to teams with varying technical backgrounds.
