# Multi-Tenant Task Management Data Model Designs

I'll present three radically different architectural approaches for modeling a multi-tenant task management system with the hierarchy: Tenants → Workspaces → Projects → Tasks.

## Design 1: Relational Database with Row-Level Security

**Approach:** Traditional normalized relational model with PostgreSQL row-level security

### Schema
```sql
-- Core entity tables
CREATE TABLE tenants (
  id UUID PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  subscription_tier VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE users (
  id UUID PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  tenant_id UUID REFERENCES tenants(id),
  role VARCHAR(50) DEFAULT 'member'
);

CREATE TABLE workspaces (
  id UUID PRIMARY KEY,
  tenant_id UUID REFERENCES tenants(id),
  name VARCHAR(255) NOT NULL,
  created_by UUID REFERENCES users(id)
);

CREATE TABLE projects (
  id UUID PRIMARY KEY,
  workspace_id UUID REFERENCES workspaces(id),
  name VARCHAR(255) NOT NULL,
  status VARCHAR(50) DEFAULT 'active'
);

CREATE TABLE tasks (
  id UUID PRIMARY KEY,
  project_id UUID REFERENCES projects(id),
  title VARCHAR(500) NOT NULL,
  description TEXT,
  status VARCHAR(50) DEFAULT 'todo',
  due_date DATE,
  created_by UUID REFERENCES users(id)
);

-- Supporting tables
CREATE TABLE task_assignments (
  task_id UUID REFERENCES tasks(id),
  user_id UUID REFERENCES users(id),
  PRIMARY KEY (task_id, user_id)
);

CREATE TABLE labels (
  id UUID PRIMARY KEY,
  project_id UUID REFERENCES projects(id),
  name VARCHAR(100),
  color VARCHAR(7)
);

CREATE TABLE task_labels (
  task_id UUID REFERENCES tasks(id),
  label_id UUID REFERENCES labels(id),
  PRIMARY KEY (task_id, label_id)
);

-- Custom fields - EAV pattern
CREATE TABLE custom_field_definitions (
  id UUID PRIMARY KEY,
  project_id UUID REFERENCES projects(id),
  name VARCHAR(100) NOT NULL,
  type VARCHAR(20) NOT NULL, -- text, number, date, boolean, select
  options JSONB, -- for select fields
  required BOOLEAN DEFAULT FALSE
);

CREATE TABLE custom_field_values (
  id UUID PRIMARY KEY,
  task_id UUID REFERENCES tasks(id),
  field_id UUID REFERENCES custom_field_definitions(id),
  value TEXT
);

-- Row-level security policies
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_tasks ON tasks
  USING (project_id IN (
    SELECT p.id FROM projects p
    JOIN workspaces w ON p.workspace_id = w.id
    WHERE w.tenant_id = current_setting('app.current_tenant_id')::UUID
  ));
```

### Usage Example
```sql
-- Application sets tenant context
SET app.current_tenant_id = 'tenant-uuid';

-- Query all tasks in a workspace (automatically filtered by RLS)
SELECT t.title, t.status, t.due_date, 
       array_agg(l.name) as labels,
       json_object_agg(cfd.name, cfv.value) as custom_fields
FROM tasks t
JOIN projects p ON t.project_id = p.id
LEFT JOIN task_labels tl ON t.id = tl.task_id
LEFT JOIN labels l ON tl.label_id = l.id
LEFT JOIN custom_field_values cfv ON t.id = cfv.task_id
LEFT JOIN custom_field_definitions cfd ON cfv.field_id = cfd.id
WHERE p.workspace_id = ?
GROUP BY t.id, t.title, t.status, t.due_date;
```

### Tradeoffs
- **Pros:** ACID transactions, mature ecosystem, complex queries, referential integrity
- **Cons:** Schema evolution challenges, EAV pattern complexity, JOIN performance overhead
- **Best for:** Systems requiring strict consistency and complex reporting

## Design 2: Document-Oriented with MongoDB

**Approach:** Denormalized document structure optimized for application query patterns

### Schema
```javascript
// Collection: tenants
{
  _id: ObjectId,
  name: String,
  subscription_tier: String,
  settings: {
    max_users: Number,
    features: [String]
  }
}

// Collection: workspaces  
{
  _id: ObjectId,
  tenant_id: ObjectId,
  name: String,
  members: [{
    user_id: ObjectId,
    email: String,
    role: String,
    joined_at: Date
  }],
  project_count: Number, // denormalized counter
  created_at: Date
}

// Collection: projects
{
  _id: ObjectId,
  workspace_id: ObjectId,
  tenant_id: ObjectId, // denormalized for efficient queries
  name: String,
  description: String,
  status: String,
  custom_field_schema: [{
    name: String,
    type: String, // "text" | "number" | "date" | "select" | "boolean"
    options: [String], // for select types
    required: Boolean,
    default_value: String
  }],
  labels: [{
    name: String,
    color: String
  }],
  task_count: Number,
  created_at: Date
}

// Collection: tasks (heavily denormalized)
{
  _id: ObjectId,
  project_id: ObjectId,
  tenant_id: ObjectId, // for efficient tenant isolation
  workspace: { // denormalized for queries
    id: ObjectId,
    name: String
  },
  project: { // denormalized for queries
    id: ObjectId,
    name: String
  },
  title: String,
  description: String,
  status: String,
  priority: String,
  due_date: Date,
  assigned_to: [{
    user_id: ObjectId,
    email: String,
    name: String,
    assigned_at: Date
  }],
  labels: [String], // label names for fast filtering
  custom_fields: {
    // Dynamic object based on project schema
    "Story Points": 8,
    "Priority Level": "High",
    "Sprint": "Sprint 24"
  },
  activity_log: [{
    action: String,
    user_id: ObjectId,
    timestamp: Date,
    details: Object
  }],
  created_by: ObjectId,
  created_at: Date,
  updated_at: Date
}
```

### Usage Example
```javascript
// Find overdue tasks for a tenant with custom field filtering
db.tasks.find({
  tenant_id: tenant_id,
  due_date: { $lt: new Date() },
  status: { $ne: "completed" },
  "custom_fields.Priority Level": "High"
}).sort({ due_date: 1 });

// Create task with validation against project schema
const project = db.projects.findOne({ _id: project_id });
const task = {
  project_id: project_id,
  tenant_id: project.tenant_id,
  workspace: { id: project.workspace_id, name: workspace_name },
  project: { id: project_id, name: project.name },
  title: "Implement user authentication",
  custom_fields: {
    "Story Points": 5,
    "Component": "Backend",
    "Epic": "User Management"
  }
};

// Aggregate tasks by status across workspace
db.tasks.aggregate([
  { $match: { "workspace.id": workspace_id } },
  { $group: { 
      _id: "$status",
      count: { $sum: 1 },
      avg_story_points: { $avg: "$custom_fields.Story Points" }
    }
  }
]);
```

### Tradeoffs
- **Pros:** Natural custom fields, fast reads, horizontal scaling, schema flexibility
- **Cons:** Data duplication, complex aggregations, no transactions across documents
- **Best for:** Applications with evolving schema requirements and read-heavy workloads

## Design 3: Event-Sourced with CQRS

**Approach:** Store all changes as immutable events, build read models for queries

### Schema
```sql
-- Event store (append-only)
CREATE TABLE domain_events (
  id UUID PRIMARY KEY,
  aggregate_id UUID NOT NULL, -- tenant, workspace, project, or task ID
  aggregate_type VARCHAR(50) NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  event_data JSONB NOT NULL,
  event_version INTEGER NOT NULL,
  tenant_id UUID NOT NULL, -- for tenant isolation
  occurred_at TIMESTAMPTZ DEFAULT NOW(),
  caused_by UUID, -- user who triggered the event
  
  CONSTRAINT unique_version_per_aggregate UNIQUE (aggregate_id, event_version),
  INDEX events_aggregate_idx (aggregate_id, event_version),
  INDEX events_tenant_idx (tenant_id, occurred_at),
  INDEX events_type_idx (aggregate_type, event_type)
);

-- Read model: Current task state (projected from events)
CREATE TABLE task_read_model (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  workspace_id UUID,
  project_id UUID,
  title VARCHAR(500),
  description TEXT,
  status VARCHAR(50),
  priority VARCHAR(20),
  due_date DATE,
  assigned_users JSONB, -- array of user objects
  labels JSONB, -- array of label strings
  custom_fields JSONB, -- dynamic object
  version INTEGER NOT NULL, -- for optimistic concurrency
  last_updated TIMESTAMPTZ,
  
  INDEX task_tenant_idx (tenant_id),
  INDEX task_project_idx (project_id),
  INDEX task_status_idx (status),
  INDEX task_due_date_idx (due_date)
);

-- Read model: Project summaries
CREATE TABLE project_read_model (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  workspace_id UUID,
  name VARCHAR(255),
  task_counts JSONB, -- {"todo": 5, "in_progress": 3, "done": 12}
  custom_field_definitions JSONB,
  version INTEGER NOT NULL,
  last_updated TIMESTAMPTZ
);
```

### Usage Example
```sql
-- Events for task lifecycle
INSERT INTO domain_events (aggregate_id, aggregate_type, event_type, event_data, event_version, tenant_id, caused_by)
VALUES 
  -- Task created
  ('task-uuid', 'Task', 'TaskCreated', 
   '{"title": "Build login form", "project_id": "project-uuid"}', 1, 'tenant-uuid', 'user-uuid'),
  
  -- Custom field added
  ('task-uuid', 'Task', 'CustomFieldSet',
   '{"field_name": "Story Points", "field_value": 8}', 2, 'tenant-uuid', 'user-uuid'),
   
  -- Task assigned
  ('task-uuid', 'Task', 'TaskAssigned',
   '{"user_id": "user-uuid", "user_email": "dev@company.com"}', 3, 'tenant-uuid', 'user-uuid');

-- Query current state (from read model)
SELECT * FROM task_read_model 
WHERE tenant_id = ? AND project_id = ?
ORDER BY due_date ASC NULLS LAST;

-- Historical query: What was task status on specific date?
WITH historical_events AS (
  SELECT event_type, event_data, event_version
  FROM domain_events
  WHERE aggregate_id = 'task-uuid'
    AND occurred_at <= '2024-01-15T00:00:00Z'
  ORDER BY event_version
)
-- Rebuild state by replaying events up to that point

-- Business analytics: Task completion velocity over time
SELECT 
  DATE_TRUNC('week', occurred_at) as week,
  COUNT(*) as tasks_completed
FROM domain_events
WHERE event_type = 'TaskCompleted'
  AND tenant_id = ?
  AND occurred_at >= NOW() - INTERVAL '3 months'
GROUP BY week
ORDER BY week;
```

### Tradeoffs
- **Pros:** Complete audit trail, temporal queries, scalable writes, business insight
- **Cons:** Complex implementation, eventual consistency, increased storage, learning curve
- **Best for:** Systems requiring full auditability and business analytics

## Comparison Matrix

| Criteria | Relational | Document-Oriented | Event-Sourced |
|----------|------------|-------------------|---------------|
| Schema flexibility | Low | High | High |
| Query performance | Good (with indexes) | Excellent | Good (read models) |
| Data consistency | Strong | Eventual | Eventual |
| Custom fields | Complex (EAV) | Native | Native |
| Audit capabilities | Basic | None | Complete |
| Development complexity | Medium | Low | High |
| Operational overhead | Low | Medium | High |
| Tenant isolation | Excellent (RLS) | Good | Excellent |
| Analytics capabilities | Good | Limited | Excellent |

## Recommendation

For a multi-tenant task management system, I recommend **Document-Oriented (MongoDB)** as the primary solution with the following justification:

### Why Document-Oriented Wins
1. **Custom fields are first-class:** The flexible schema naturally accommodates user-defined fields without complex EAV patterns
2. **Query performance:** Denormalized documents eliminate expensive JOINs for common task management queries
3. **Development velocity:** Faster iteration without schema migration ceremonies
4. **Horizontal scaling:** Native support for sharding across tenants

### Hybrid Architecture Recommendation
Start with MongoDB for core task management, add complementary systems:

- **Relational database (PostgreSQL)** for tenant billing/accounting requiring ACID transactions
- **Analytics warehouse (ClickHouse/BigQuery)** for business intelligence and reporting
- **Search engine (Elasticsearch)** for full-text search across tasks and projects

### Implementation Strategy
1. **Phase 1:** Core CRUD operations with MongoDB
2. **Phase 2:** Add search and analytics layers
3. **Phase 3:** Consider event sourcing for specific audit requirements

This approach balances development speed, operational simplicity, and the specific requirements of dynamic custom fields while maintaining excellent performance for typical task management workflows.
