# Data Model Design for Multi-Tenant Task Management System

## Design 1: Relational (Normalized)

**Schema:**
```sql
-- Core hierarchy
CREATE TABLE tenants (id UUID PRIMARY KEY, name VARCHAR NOT NULL);
CREATE TABLE workspaces (id UUID PRIMARY KEY, tenant_id UUID REFERENCES tenants(id), name VARCHAR NOT NULL);
CREATE TABLE projects (id UUID PRIMARY KEY, workspace_id UUID REFERENCES workspaces(id), name VARCHAR NOT NULL);
CREATE TABLE tasks (
    id UUID PRIMARY KEY,
    project_id UUID REFERENCES projects(id),
    title VARCHAR NOT NULL,
    description TEXT,
    due_date TIMESTAMP
);

-- Many-to-many relationships
CREATE TABLE users (id UUID PRIMARY KEY, email VARCHAR UNIQUE, name VARCHAR);
CREATE TABLE task_assignments (
    task_id UUID REFERENCES tasks(id),
    user_id UUID REFERENCES users(id),
    PRIMARY KEY (task_id, user_id)
);

-- Labels and custom fields
CREATE TABLE labels (id UUID PRIMARY KEY, workspace_id UUID REFERENCES workspaces(id), name VARCHAR, color VARCHAR);
CREATE TABLE task_labels (task_id UUID REFERENCES tasks(id), label_id UUID REFERENCES labels(id));
CREATE TABLE custom_fields (
    id UUID PRIMARY KEY,
    project_id UUID REFERENCES projects(id),
    name VARCHAR,
    field_type VARCHAR CHECK (field_type IN ('text', 'number', 'date', 'boolean'))
);
CREATE TABLE task_custom_values (
    task_id UUID REFERENCES tasks(id),
    field_id UUID REFERENCES custom_fields(id),
    value TEXT
);
```

**Usage Example:**
```sql
-- Get task with all details (complex join)
SELECT t.title, t.due_date, w.name as workspace, p.name as project,
       array_agg(u.name) as assignees, array_agg(l.name) as labels
FROM tasks t
JOIN projects p ON t.project_id = p.id
JOIN workspaces w ON p.workspace_id = w.id
LEFT JOIN task_assignments ta ON t.id = ta.task_id
LEFT JOIN users u ON ta.user_id = u.id
LEFT JOIN task_labels tl ON t.id = tl.task_id
LEFT JOIN labels l ON tl.label_id = l.id
WHERE t.id = $1
GROUP BY t.id, w.name, p.name;
```

**Tradeoffs:**
- ✅ Perfect data consistency and referential integrity
- ✅ No data duplication, storage efficient
- ✅ Well-understood SQL patterns
- ✅ Flexible querying with standard tools
- ❌ Complex joins for simple operations (8+ tables for basic task view)
- ❌ Poor read performance on large datasets
- ❌ Difficult to scale horizontally

## Design 2: Document-Oriented (MongoDB/NoSQL)

**Schema:**
```javascript
// Task Document (self-contained)
{
  "_id": "task_12345",
  "title": "Implement OAuth",
  "description": "Add Google OAuth integration",
  "due_date": "2024-03-15T10:00:00Z",
  "status": "in_progress",

  // Embedded hierarchy (denormalized)
  "tenant": {"id": "t1", "name": "Acme Corp"},
  "workspace": {"id": "w1", "name": "Engineering"},
  "project": {"id": "p1", "name": "Auth Service"},

  // Embedded arrays to avoid joins
  "assignees": [
    {"id": "u1", "name": "John Doe", "email": "john@acme.com"}
  ],
  "labels": [
    {"id": "l1", "name": "Backend", "color": "#blue"}
  ],

  // Flexible schema for custom fields
  "custom_fields": {
    "priority": "High",
    "story_points": 8,
    "sprint": "Sprint 23"
  },

  // Embedded activity log
  "history": [
    {
      "action": "assigned",
      "user": "John Doe",
      "timestamp": "2024-03-10T09:00:00Z"
    }
  ]
}

// Workspace Document (for aggregations)
{
  "_id": "workspace_w1",
  "name": "Engineering",
  "tenant_id": "t1",
  "stats": {
    "total_tasks": 150,
    "open_tasks": 45,
    "completed_tasks": 105
  }
}
```

**Usage Example:**
```javascript
// Get user's tasks (single query, no joins)
db.tasks.find({
  "assignees.id": "u1",
  "tenant.id": "t1",
  "status": {$in: ["open", "in_progress"]}
}).sort({"due_date": 1});

// Project dashboard (aggregation pipeline)
db.tasks.aggregate([
  {$match: {"project.id": "p1"}},
  {$group: {
    _id: "$status",
    count: {$sum: 1},
    tasks: {$push: {title: "$title", assignees: "$assignees"}}
  }}
]);
```

**Tradeoffs:**
- ✅ Excellent read performance (1-2 queries for most operations)
- ✅ Natural object mapping for developers
- ✅ Flexible schema for evolving requirements
- ✅ Great for caching and offline-first apps
- ❌ Data duplication leads to consistency challenges
- ❌ Updates to reference data require bulk operations
- ❌ Document size can grow large with embedded data
- ❌ Complex cross-collection analytics

## Design 3: Event-Sourced

**Schema:**
```sql
-- Single event store table
CREATE TABLE events (
    id UUID PRIMARY KEY,
    aggregate_id UUID NOT NULL,
    aggregate_type VARCHAR NOT NULL, -- 'task', 'project', 'workspace'
    event_type VARCHAR NOT NULL,
    event_version INTEGER NOT NULL,
    tenant_id UUID NOT NULL, -- For partitioning
    event_data JSONB NOT NULL,
    metadata JSONB DEFAULT '{}',
    occurred_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(aggregate_id, event_version)
);

-- Read model projections (materialized views)
CREATE TABLE task_read_model (
    id UUID PRIMARY KEY,
    title VARCHAR,
    status VARCHAR,
    due_date TIMESTAMP,
    assignees JSONB,
    labels JSONB,
    custom_fields JSONB,
    project_id UUID,
    workspace_id UUID,
    tenant_id UUID,
    version INTEGER
);
```

**Usage Example:**
```json
// Events for task lifecycle
{
  "event_type": "TaskCreated",
  "aggregate_id": "task_123",
  "event_data": {
    "title": "Implement OAuth",
    "project_id": "project_456",
    "created_by": "user_789"
  }
}

{
  "event_type": "TaskAssigned",
  "aggregate_id": "task_123",
  "event_data": {
    "user_id": "user_101",
    "assigned_by": "user_789"
  }
}

{
  "event_type": "TaskCustomFieldSet",
  "aggregate_id": "task_123",
  "event_data": {
    "field_name": "priority",
    "field_value": "High"
  }
}
```

```sql
-- Query read model (fast)
SELECT * FROM task_read_model
WHERE tenant_id = $1 AND assignees @> '[{"id": "user_101"}]';

-- Replay events to rebuild state
SELECT event_data FROM events
WHERE aggregate_id = $1
ORDER BY event_version;
```

**Tradeoffs:**
- ✅ Complete audit trail and temporal queries
- ✅ High scalability (append-only writes)
- ✅ Complex business logic naturally modeled
- ✅ Can rebuild any historical state
- ❌ High complexity and learning curve
- ❌ Eventual consistency between write/read models
- ❌ Storage grows continuously (all history preserved)
- ❌ Debugging and troubleshooting more difficult

## Comparison & Analysis

**Query Performance:**
- Document-Oriented: Fastest (1-2 operations for most queries)
- Event-Sourced: Fast reads from projections, slower historical queries
- Relational: Slowest (complex multi-table joins)

**Data Consistency:**
- Relational: Strongest (ACID transactions, foreign keys)
- Event-Sourced: Strong eventual consistency
- Document-Oriented: Weakest (manual consistency management)

**Scalability:**
- Event-Sourced: Best (append-only, horizontal sharding)
- Document-Oriented: Good (sharding by tenant)
- Relational: Limited (vertical scaling, complex sharding)

**Development Complexity:**
- Document-Oriented: Lowest (intuitive object mapping)
- Relational: Medium (well-known SQL patterns)
- Event-Sourced: Highest (specialized patterns and tooling)

**Storage Requirements:**
- Relational: Lowest (normalized, no duplication)
- Document-Oriented: Medium (some duplication for performance)
- Event-Sourced: Highest (all historical events preserved)

## Recommendation

**Choose Document-Oriented for most use cases** because:

1. **Task management is naturally document-centric** - tasks contain comments, attachments, activity logs that benefit from co-location
2. **Read-heavy workload** - users spend more time viewing/filtering tasks than creating them
3. **Tenant isolation** - documents naturally partition by tenant for security and scaling
4. **Developer productivity** - faster development cycles with intuitive data modeling

**Implementation strategy:**
- Use MongoDB with proper indexing on tenant_id, assignees, labels, due_dates
- Implement change streams for real-time notifications
- Use reference collections for frequently-changing data (user profiles)
- Add caching layer (Redis) for dashboard aggregations

**When to consider alternatives:**
- **Choose Relational** for strong audit requirements or when team has deep SQL expertise
- **Choose Event-Sourced** for complex workflows with rich business logic or compliance requirements

The document-oriented approach provides the best balance of performance, developer experience, and natural fit for the task management domain.