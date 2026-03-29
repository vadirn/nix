# Data Model Design: Multi-Tenant Task Management System

## Design 1: Normalized Relational Model

**Constraint:** Optimize for data consistency and relational integrity.

### Schema Design
```sql
-- Tenant isolation at row level
CREATE TABLE tenants (
  id UUID PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  plan_type VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE workspaces (
  id UUID PRIMARY KEY,
  tenant_id UUID REFERENCES tenants(id),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  INDEX tenant_workspace_idx (tenant_id)
);

CREATE TABLE projects (
  id UUID PRIMARY KEY,
  workspace_id UUID REFERENCES workspaces(id),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  status VARCHAR(50) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  INDEX workspace_project_idx (workspace_id)
);

CREATE TABLE tasks (
  id UUID PRIMARY KEY,
  project_id UUID REFERENCES projects(id),
  title VARCHAR(500) NOT NULL,
  description TEXT,
  status VARCHAR(50) DEFAULT 'open',
  priority VARCHAR(20),
  due_date DATE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  INDEX project_task_idx (project_id),
  INDEX due_date_idx (due_date)
);

CREATE TABLE task_assignments (
  id UUID PRIMARY KEY,
  task_id UUID REFERENCES tasks(id),
  user_id UUID NOT NULL,
  assigned_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(task_id, user_id)
);

CREATE TABLE task_labels (
  id UUID PRIMARY KEY,
  task_id UUID REFERENCES tasks(id),
  label VARCHAR(100) NOT NULL,
  color VARCHAR(7),  -- hex color
  INDEX task_label_idx (task_id),
  INDEX label_value_idx (label)
);

CREATE TABLE custom_fields (
  id UUID PRIMARY KEY,
  project_id UUID REFERENCES projects(id),
  field_name VARCHAR(100) NOT NULL,
  field_type VARCHAR(20) NOT NULL, -- text, number, date, select
  field_options JSON, -- for select types
  required BOOLEAN DEFAULT FALSE,
  INDEX project_field_idx (project_id)
);

CREATE TABLE task_custom_values (
  id UUID PRIMARY KEY,
  task_id UUID REFERENCES tasks(id),
  custom_field_id UUID REFERENCES custom_fields(id),
  value TEXT,
  UNIQUE(task_id, custom_field_id)
);
```

### Usage Example
```sql
-- Query tasks with custom fields for a tenant
SELECT 
  t.title, t.status, t.due_date,
  tcv.value as custom_value,
  cf.field_name as field_name
FROM tenants tn
JOIN workspaces w ON tn.id = w.tenant_id
JOIN projects p ON w.id = p.workspace_id
JOIN tasks t ON p.id = t.project_id
LEFT JOIN task_custom_values tcv ON t.id = tcv.task_id
LEFT JOIN custom_fields cf ON tcv.custom_field_id = cf.id
WHERE tn.id = ? AND p.id = ?;

-- Insert new task with custom field
INSERT INTO tasks (project_id, title, description) VALUES (?, ?, ?);
INSERT INTO task_custom_values (task_id, custom_field_id, value) VALUES (?, ?, ?);
```

### Tradeoffs
- **Pros:** Strong consistency, referential integrity, mature tooling, complex queries
- **Cons:** Schema migrations are complex, rigid structure, JOIN-heavy queries can be slow

## Design 2: Document-Oriented Model

**Constraint:** Optimize for flexible schema and fast read performance.

### Schema Design
```javascript
// MongoDB/DocumentDB collections

// Tenants collection
{
  _id: ObjectId,
  name: String,
  plan_type: String,
  settings: {
    max_workspaces: Number,
    features: [String]
  },
  created_at: Date
}

// Workspaces collection (tenant embedded for performance)
{
  _id: ObjectId,
  tenant: {
    id: ObjectId,
    name: String
  },
  name: String,
  description: String,
  projects: [{
    id: ObjectId,
    name: String,
    description: String,
    status: String,
    custom_fields: [{
      name: String,
      type: String, // text, number, date, select
      options: [String], // for select types
      required: Boolean
    }],
    created_at: Date
  }],
  created_at: Date
}

// Tasks collection (denormalized for performance)
{
  _id: ObjectId,
  tenant_id: ObjectId,
  workspace: {
    id: ObjectId,
    name: String
  },
  project: {
    id: ObjectId,
    name: String
  },
  title: String,
  description: String,
  status: String,
  priority: String,
  due_date: Date,
  assignments: [{
    user_id: String,
    user_name: String,
    assigned_at: Date
  }],
  labels: [{
    name: String,
    color: String
  }],
  custom_fields: {
    "Priority Level": "High",
    "Estimation": 8,
    "Release Version": "2.1.0"
  },
  created_at: Date,
  updated_at: Date
}
```

### Usage Example
```javascript
// Find all high-priority tasks for a tenant
db.tasks.find({
  tenant_id: tenant_id,
  $or: [
    { priority: "high" },
    { "custom_fields.Priority Level": "High" }
  ]
}).sort({ due_date: 1 });

// Create task with custom fields
db.tasks.insertOne({
  tenant_id: tenant_id,
  workspace: { id: workspace_id, name: "Engineering" },
  project: { id: project_id, name: "Mobile App" },
  title: "Implement user authentication",
  custom_fields: {
    "Story Points": 5,
    "Epic": "User Management",
    "Sprint": "Sprint 23"
  }
});

// Update task and add label
db.tasks.updateOne(
  { _id: task_id },
  { 
    $set: { status: "in_progress" },
    $push: { labels: { name: "bug", color: "#ff0000" } }
  }
);
```

### Tradeoffs
- **Pros:** Flexible schema, fast reads, easy horizontal scaling, natural custom fields
- **Cons:** Data duplication, eventual consistency, complex aggregations, no joins

## Design 3: Event-Sourced Model

**Constraint:** Optimize for auditability and temporal queries.

### Schema Design
```sql
-- Event store
CREATE TABLE events (
  id UUID PRIMARY KEY,
  stream_id VARCHAR(255) NOT NULL,  -- tenant:workspace:project:task
  stream_type VARCHAR(50) NOT NULL, -- tenant, workspace, project, task
  event_type VARCHAR(100) NOT NULL,
  event_data JSONB NOT NULL,
  event_version INTEGER NOT NULL,
  occurred_at TIMESTAMP DEFAULT NOW(),
  INDEX stream_idx (stream_id, event_version),
  INDEX type_idx (stream_type, event_type),
  INDEX time_idx (occurred_at)
);

-- Read model projections (materialized views)
CREATE TABLE task_projections (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  workspace_id UUID,
  project_id UUID,
  title VARCHAR(500),
  description TEXT,
  status VARCHAR(50),
  due_date DATE,
  assignments JSONB, -- [{"user_id": "...", "assigned_at": "..."}]
  labels JSONB,      -- [{"name": "bug", "color": "#ff0000"}]
  custom_fields JSONB, -- {"Priority": "High", "Points": 5}
  version INTEGER NOT NULL,
  last_updated TIMESTAMP,
  INDEX tenant_workspace_idx (tenant_id, workspace_id),
  INDEX project_idx (project_id),
  INDEX status_idx (status)
);

CREATE TABLE workspace_projections (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  name VARCHAR(255),
  project_count INTEGER DEFAULT 0,
  task_count INTEGER DEFAULT 0,
  custom_field_definitions JSONB,
  version INTEGER NOT NULL,
  last_updated TIMESTAMP
);
```

### Usage Example
```sql
-- Events for task lifecycle
INSERT INTO events (stream_id, stream_type, event_type, event_data) VALUES
  ('tenant1:workspace1:project1:task1', 'task', 'TaskCreated', 
   '{"title": "Implement auth", "project_id": "project1"}'),
  ('tenant1:workspace1:project1:task1', 'task', 'TaskAssigned',
   '{"user_id": "user123", "assigned_at": "2024-01-15T10:00:00Z"}'),
  ('tenant1:workspace1:project1:task1', 'task', 'CustomFieldSet',
   '{"field_name": "Story Points", "field_value": 5}');

-- Query current task state
SELECT * FROM task_projections 
WHERE tenant_id = ? AND project_id = ?
ORDER BY due_date ASC;

-- Historical query: what was this task's status on specific date?
WITH task_events AS (
  SELECT event_type, event_data, occurred_at
  FROM events 
  WHERE stream_id = 'tenant1:workspace1:project1:task1'
    AND occurred_at <= '2024-01-20T00:00:00Z'
  ORDER BY event_version
)
-- Replay events to reconstruct state at point in time
```

### Tradeoffs
- **Pros:** Complete audit trail, time-travel queries, business event modeling, scalability
- **Cons:** Complex implementation, eventual consistency, query complexity, storage overhead

## Comparison

| Aspect | Relational | Document | Event-Sourced |
|--------|------------|----------|---------------|
| Schema flexibility | Low | High | Medium |
| Query complexity | Medium | Simple | High |
| Consistency | Strong | Eventual | Eventual |
| Audit capability | Manual | None | Built-in |
| Horizontal scaling | Difficult | Easy | Easy |
| Custom fields | Complex | Natural | Natural |
| Development speed | Medium | Fast | Slow |
| Operational complexity | Low | Medium | High |

## Synthesis and Recommendation

For a multi-tenant task management system, I recommend **Design 2: Document-Oriented Model** with the following rationale:

1. **Custom fields requirement:** Document databases naturally handle dynamic schemas, which is crucial for user-defined custom fields

2. **Multi-tenancy:** Document structure allows for efficient tenant isolation and query patterns

3. **Development velocity:** Faster iteration on features without complex schema migrations

4. **Read-heavy workload:** Task management systems are typically read-heavy; denormalized documents optimize for common query patterns

**Implementation approach:**
- Start with MongoDB/DocumentDB for core functionality
- Add relational database for accounting/billing data that requires strong consistency
- Consider event sourcing for specific audit requirements (e.g., task history timeline)

**Key design decisions:**
- Embed workspace/project references in tasks for query performance
- Denormalize user names in assignments for reduced lookups
- Use flexible custom_fields object rather than rigid schema

This hybrid approach balances development speed, operational simplicity, and the specific requirements of dynamic custom fields while maintaining good performance for typical task management query patterns.
