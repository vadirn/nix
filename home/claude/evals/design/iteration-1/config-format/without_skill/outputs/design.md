# Configuration Format Design: Autonomous Pipeline Runner

I'll design three radically different configuration formats for an autonomous pipeline runner that handles complex workflows with step dependencies, model selection, retry policies, and skill requirements.

## Design 1: Graph-Based TOML Configuration

**Approach:** Structure configuration as explicit graph nodes with dependency relationships

### Schema
```toml
[pipeline]
name = "content-workflow"
description = "Automated content generation and review"
version = "1.0"

[pipeline.defaults]
model = "claude-sonnet-4"
timeout = "30m"
max_retries = 3

# Graph nodes (steps)
[[nodes]]
id = "research"
type = "llm_step"
prompt = """
Research the following topic thoroughly: {{inputs.topic}}
Provide factual information with credible sources.
"""
model = "claude-opus-4"
skills = ["web_search", "fact_verification"]
timeout = "15m"

[nodes.acceptance]
word_count_min = 300
word_count_max = 800
source_count_min = 3
factual_accuracy_threshold = 0.95

[nodes.retry]
max_attempts = 2
backoff_strategy = "exponential"
backoff_base = 2

[[nodes]]
id = "draft"
type = "llm_step"
prompt = """
Based on this research: {{nodes.research.output}}
Write a comprehensive blog post about {{inputs.topic}}.
"""
skills = ["content_writing", "seo_optimization"]

[nodes.acceptance]
word_count_min = 800
word_count_max = 1500
readability_score_max = 12
structure_check = ["intro", "body", "conclusion"]

[[nodes]]
id = "review"
type = "llm_step"
prompt = """
Review and enhance this content: {{nodes.draft.output}}
Focus on clarity, engagement, and factual accuracy.
"""
model = "claude-sonnet-4-latest"
skills = ["content_editing", "grammar_check"]

[nodes.acceptance]
grammar_score_min = 95
engagement_score_min = 80
factual_consistency_check = true

# Dependency edges
[[edges]]
from = "research"
to = "draft"
condition = "success"

[[edges]]
from = "draft"
to = "review"
condition = "success"

[inputs]
topic = { type = "string", required = true, description = "Content topic" }

[outputs]
final_content = "{{nodes.review.output}}"
research_data = "{{nodes.research.output}}"
```

### Usage Example
```bash
# Execute pipeline
pipeline-runner execute config.toml --input topic="Machine Learning Ethics"

# Visualize dependency graph
pipeline-runner graph config.toml --output graph.png

# Validate configuration
pipeline-runner validate config.toml --check-dependencies
```

### Tradeoffs
- **Pros:** Clear separation of graph structure from execution logic, excellent visualization
- **Cons:** More verbose than other formats, requires understanding of graph concepts
- **Best for:** Complex pipelines with intricate dependencies and visualization needs

## Design 2: Code-as-Configuration (JavaScript/TypeScript)

**Approach:** Use executable code with strong typing and composition patterns

### Schema
```typescript
// pipeline.config.ts
import { Pipeline, Step, Model, Skills, AcceptanceCriteria } from '@pipeline-runner/core';

export default Pipeline.create({
  name: 'content-workflow',
  description: 'Automated content generation and review',
})
.withDefaults({
  model: Model.CLAUDE_SONNET_4,
  timeout: Duration.minutes(30),
  maxRetries: 3,
})
.addStep(
  Step.llm('research')
    .withPrompt(({ inputs }) => `
      Research the following topic thoroughly: ${inputs.topic}
      Provide factual information with credible sources.
    `)
    .withModel(Model.CLAUDE_OPUS_4)
    .withSkills(Skills.WEB_SEARCH, Skills.FACT_VERIFICATION)
    .withTimeout(Duration.minutes(15))
    .acceptWhen(
      AcceptanceCriteria.wordCount({ min: 300, max: 800 }),
      AcceptanceCriteria.sourceCount({ min: 3 }),
      AcceptanceCriteria.factualAccuracy({ threshold: 0.95 })
    )
    .retryWith({
      maxAttempts: 2,
      backoffStrategy: 'exponential',
      backoffBase: 2
    })
)
.addStep(
  Step.llm('draft')
    .dependsOn('research')
    .withPrompt(({ nodes, inputs }) => `
      Based on this research: ${nodes.research.output}
      Write a comprehensive blog post about ${inputs.topic}.
    `)
    .withSkills(Skills.CONTENT_WRITING, Skills.SEO_OPTIMIZATION)
    .acceptWhen(
      AcceptanceCriteria.wordCount({ min: 800, max: 1500 }),
      AcceptanceCriteria.readabilityScore({ max: 12 }),
      AcceptanceCriteria.structureCheck(['intro', 'body', 'conclusion'])
    )
)
.addStep(
  Step.llm('review')
    .dependsOn('draft')
    .withPrompt(({ nodes }) => `
      Review and enhance this content: ${nodes.draft.output}
      Focus on clarity, engagement, and factual accuracy.
    `)
    .withModel(Model.CLAUDE_SONNET_4_LATEST)
    .withSkills(Skills.CONTENT_EDITING, Skills.GRAMMAR_CHECK)
    .acceptWhen(
      AcceptanceCriteria.grammarScore({ min: 95 }),
      AcceptanceCriteria.engagementScore({ min: 80 }),
      AcceptanceCriteria.factualConsistency()
    )
)
.withInputs({
  topic: Input.string({ 
    required: true, 
    description: 'Content topic',
    validation: z.string().min(5).max(100)
  })
})
.withOutputs({
  finalContent: '{{nodes.review.output}}',
  researchData: '{{nodes.research.output}}'
});

// Custom acceptance criteria
export const AcceptanceCriteria = {
  wordCount: ({ min, max }: { min: number; max: number }) =>
    new WordCountCriteria({ min, max }),
    
  sourceCount: ({ min }: { min: number }) =>
    new SourceCountCriteria({ min }),
    
  structureCheck: (sections: string[]) =>
    new StructureCriteria({ requiredSections: sections }),
    
  // Can define complex, reusable acceptance logic
  factualAccuracy: ({ threshold }: { threshold: number }) =>
    new CustomCriteria({
      name: 'factual_accuracy',
      check: async (output: string, context: ExecutionContext) => {
        const facts = await extractFacts(output);
        const verificationResults = await Promise.all(
          facts.map(fact => verifyFact(fact, context))
        );
        const accuracy = verificationResults.filter(Boolean).length / facts.length;
        return accuracy >= threshold;
      }
    })
};
```

### Usage Example
```typescript
// Execute programmatically
const pipeline = await import('./pipeline.config.ts');
const result = await pipeline.default.execute({ 
  topic: 'Machine Learning Ethics' 
});

// Conditional modification
const prodPipeline = process.env.NODE_ENV === 'production'
  ? pipeline.withModelOverride(Model.CLAUDE_OPUS_4)
  : pipeline;

// Composition and extension
const extendedPipeline = pipeline
  .addStep(
    Step.llm('seo-metadata')
      .dependsOn('review')
      .withPrompt(({ nodes }) => `Generate SEO metadata for: ${nodes.review.output}`)
  )
  .chain(publishingPipeline)
  .chain(analyticsePipeline);

// Testing configuration
describe('Content Pipeline', () => {
  it('should validate input requirements', () => {
    expect(() => pipeline.validate({ topic: '' })).toThrow();
  });
  
  it('should execute successfully with valid input', async () => {
    const result = await pipeline.execute({ topic: 'AI Ethics' });
    expect(result.finalContent).toBeDefined();
  });
});
```

### Tradeoffs
- **Pros:** Type safety, IDE support, powerful composition, testability, reusable components
- **Cons:** Requires programming knowledge, runtime dependencies, deployment complexity
- **Best for:** Complex pipelines requiring logic reuse and programmatic generation

## Design 3: Hierarchical XML with Declarative Rules

**Approach:** Structured markup with embedded rule engines and validation schemas

### Schema
```xml
<?xml version="1.0" encoding="UTF-8"?>
<pipeline xmlns="http://pipeline-runner.org/schema/v1" 
          name="content-workflow" 
          description="Automated content generation and review"
          version="1.0">

  <defaults>
    <model>claude-sonnet-4</model>
    <timeout>PT30M</timeout>
    <maxRetries>3</maxRetries>
    <retryStrategy>exponential</retryStrategy>
  </defaults>

  <inputs>
    <input name="topic" type="string" required="true">
      <description>Content topic for blog post generation</description>
      <validation>
        <minLength>5</minLength>
        <maxLength>100</maxLength>
        <pattern>^[a-zA-Z0-9\s\-\.]+$</pattern>
      </validation>
    </input>
  </inputs>

  <steps>
    <step id="research" type="llm-task">
      <model>claude-opus-4</model>
      <timeout>PT15M</timeout>
      <skills>
        <skill name="web_search"/>
        <skill name="fact_verification"/>
      </skills>
      
      <prompt>
        <![CDATA[
        Research the following topic thoroughly: {{inputs.topic}}
        Provide factual information with credible sources.
        ]]>
      </prompt>
      
      <acceptanceCriteria operator="all">
        <criterion type="word-count">
          <min>300</min>
          <max>800</max>
        </criterion>
        <criterion type="source-count">
          <min>3</min>
        </criterion>
        <criterion type="factual-accuracy">
          <threshold>0.95</threshold>
        </criterion>
      </acceptanceCriteria>
      
      <retryPolicy>
        <maxAttempts>2</maxAttempts>
        <backoffStrategy>exponential</backoffStrategy>
        <backoffBase>2</backoffBase>
      </retryPolicy>
    </step>

    <step id="draft" type="llm-task">
      <dependsOn>
        <step ref="research" condition="success"/>
      </dependsOn>
      
      <skills>
        <skill name="content_writing"/>
        <skill name="seo_optimization"/>
      </skills>
      
      <prompt>
        <![CDATA[
        Based on this research: {{steps.research.output}}
        Write a comprehensive blog post about {{inputs.topic}}.
        ]]>
      </prompt>
      
      <acceptanceCriteria operator="all">
        <criterion type="word-count">
          <min>800</min>
          <max>1500</max>
        </criterion>
        <criterion type="readability-score">
          <max>12</max>
        </criterion>
        <criterion type="structure-check">
          <requiredSections>
            <section>intro</section>
            <section>body</section>
            <section>conclusion</section>
          </requiredSections>
        </criterion>
      </acceptanceCriteria>
    </step>

    <step id="review" type="llm-task">
      <dependsOn>
        <step ref="draft" condition="success"/>
      </dependsOn>
      
      <model>claude-sonnet-4-latest</model>
      <skills>
        <skill name="content_editing"/>
        <skill name="grammar_check"/>
      </skills>
      
      <prompt>
        <![CDATA[
        Review and enhance this content: {{steps.draft.output}}
        Focus on clarity, engagement, and factual accuracy.
        ]]>
      </prompt>
      
      <acceptanceCriteria operator="all">
        <criterion type="grammar-score">
          <min>95</min>
        </criterion>
        <criterion type="engagement-score">
          <min>80</min>
        </criterion>
        <criterion type="factual-consistency-check">
          <enabled>true</enabled>
        </criterion>
      </acceptanceCriteria>
    </step>
  </steps>

  <outputs>
    <output name="finalContent" value="{{steps.review.output}}"/>
    <output name="researchData" value="{{steps.research.output}}"/>
  </outputs>

  <monitoring>
    <metrics>
      <metric name="execution_time" enabled="true"/>
      <metric name="success_rate" enabled="true"/>
      <metric name="retry_count" enabled="true"/>
    </metrics>
    <alerts>
      <alert condition="execution_time > PT60M" action="notify"/>
      <alert condition="success_rate < 0.8" action="escalate"/>
    </alerts>
  </monitoring>

</pipeline>
```

### Usage Example
```bash
# Execute with XML config
pipeline-runner run --config pipeline.xml --input topic="AI Ethics"

# Validate against XSD schema
xmllint --schema pipeline-schema.xsd pipeline.xml

# Transform for different environments
xsltproc prod-transform.xsl pipeline.xml > pipeline-prod.xml

# Generate documentation
pipeline-runner docs --config pipeline.xml --output docs/
```

### Tradeoffs
- **Pros:** Rich validation through XSD schemas, excellent tooling support, hierarchical organization
- **Cons:** Verbose syntax, limited dynamic capabilities, XML complexity
- **Best for:** Enterprise environments requiring formal validation and documentation generation

## Comparison Matrix

| Aspect | Graph-Based TOML | Code-as-Config | Hierarchical XML |
|--------|------------------|----------------|------------------|
| Human readability | High | Medium | Medium |
| Type safety | Schema-based | Native | Schema-based |
| Tooling support | Good | Excellent | Excellent |
| Learning curve | Medium | High | Medium |
| Expressiveness | Medium | Highest | Medium |
| Validation | External | Compile-time | Built-in |
| Version control | Excellent | Good | Good |
| Dynamic generation | Limited | Excellent | Limited |
| Enterprise features | Basic | Custom | Rich |

## Recommendation

For an autonomous pipeline runner, I recommend **Design 2: Code-as-Configuration (TypeScript)** as the primary configuration format with the following justification:

### Why Code-as-Configuration Wins

1. **Type Safety**: Compile-time validation prevents configuration errors before runtime
2. **Composition Power**: Can build complex pipelines from reusable components
3. **Testing**: Configuration can be unit tested, ensuring reliability
4. **IDE Support**: Full autocomplete, refactoring, and debugging support
5. **Flexibility**: Supports conditional logic, loops, and dynamic generation

### Implementation Strategy

**Phase 1: Core TypeScript DSL**
- Implement type-safe configuration builder with fluent API
- Support for all required features: dependencies, retry policies, acceptance criteria
- CLI tool for executing TypeScript configurations

**Phase 2: Multi-Format Support**
- Add TOML export for simple pipelines and GitOps workflows
- Provide XML import/export for enterprise integration
- Support configuration migration between formats

**Phase 3: Advanced Features**
- Configuration composition and inheritance
- Hot-reloading for development
- Visual pipeline editor that generates TypeScript

### Key Design Decisions

1. **Fluent Builder Pattern**: Makes complex configurations readable and discoverable
2. **Strong Typing**: Prevents runtime errors through compile-time validation
3. **Composition Over Inheritance**: Allows flexible pipeline assembly
4. **Plugin Architecture**: Extensible skill and acceptance criteria system

This approach provides the power and flexibility needed for autonomous pipeline orchestration while maintaining developer productivity through excellent tooling support and type safety.
