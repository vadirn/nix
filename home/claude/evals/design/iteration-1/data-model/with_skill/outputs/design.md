# Data Model Design for Multi-Tenant Task Management System

## Design 1: Fully Normalized

**Database Schema:**
```sql
-- Core hierarchy with strict referential integrity
CREATE TABLE tenants (
    id UUID PRIMARY KEY,
    name VARCHAR NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE workspaces (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    name VARCHAR NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE projects (
    id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL REFERENCES workspaces(id),
    name VARCHAR NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE tasks (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id),
    title VARCHAR NOT NULL,
    description TEXT,
    due_date TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Normalized support entities
CREATE TABLE users (
    id UUID PRIMARY KEY,
    email VARCHAR UNIQUE NOT NULL,
    name VARCHAR NOT NULL
);

CREATE TABLE task_assignments (
    task_id UUID REFERENCES tasks(id),
    user_id UUID REFERENCES users(id),
    assigned_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (task_id, user_id)
);

CREATE TABLE labels (
    id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL REFERENCES workspaces(id),
    name VARCHAR NOT NULL,
    color VARCHAR
);

CREATE TABLE task_labels (
    task_id UUID REFERENCES tasks(id),
    label_id UUID REFERENCES labels(id),
    PRIMARY KEY (task_id, label_id)
);

CREATE TABLE custom_field_definitions (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id),
    name VARCHAR NOT NULL,
    type VARCHAR NOT NULL, -- 'text', 'number', 'date', 'select'
    options JSONB -- for select fields
);

CREATE TABLE custom_field_values (
    task_id UUID REFERENCES tasks(id),
    field_id UUID REFERENCES custom_field_definitions(id),
    value TEXT,
    PRIMARY KEY (task_id, field_id)
);
```

**Usage Example:**
```sql
-- Get task details (requires 12+ table joins)
SELECT
    t.title, t.description, t.due_date,
    ten.name as tenant_name,
    w.name as workspace_name,
    p.name as project_name,
    array_agg(DISTINCT u.name) as assignees,
    array_agg(DISTINCT l.name) as labels,
    json_object_agg(cfd.name, cfv.value) as custom_fields
FROM tasks t
JOIN projects p ON t.project_id = p.id
JOIN workspaces w ON p.workspace_id = w.id
JOIN tenants ten ON w.tenant_id = ten.id
LEFT JOIN task_assignments ta ON t.id = ta.task_id
LEFT JOIN users u ON ta.user_id = u.id
LEFT JOIN task_labels tl ON t.id = tl.task_id
LEFT JOIN labels l ON tl.label_id = l.id
LEFT JOIN custom_field_values cfv ON t.id = cfv.task_id
LEFT JOIN custom_field_definitions cfd ON cfv.field_id = cfd.id
WHERE t.id = $1
GROUP BY t.id, ten.name, w.name, p.name;
```

**Hidden Complexity:**
- Single task retrieval requires 12+ table joins
- Permission checks traverse 3-level hierarchy
- Creating tasks requires coordinated multi-table transactions
- Simple filters become complex multi-join queries
- Dashboard aggregations need expensive GROUP BY operations

**Tradeoffs:**
- ✅ Zero data redundancy and perfect consistency
- ✅ Database-enforced referential integrity
- ✅ Maximum flexibility for complex organizational structures
- ✅ Type-safe custom fields with validation
- ❌ Every query requires multiple complex joins
- ❌ Performance impact from extensive join operations
- ❌ High development complexity for simple operations
- ❌ Transaction overhead for basic CRUD operations

## Design 2: Denormalized for Reads

**Database Schema:**
```sql
-- Core tasks table with heavy denormalization
CREATE TABLE tasks (
    id UUID PRIMARY KEY,
    title VARCHAR NOT NULL,
    description TEXT,
    due_date TIMESTAMP,

    -- Denormalized hierarchy (redundant but fast)
    tenant_id UUID NOT NULL,
    tenant_name VARCHAR NOT NULL,
    workspace_id UUID NOT NULL,
    workspace_name VARCHAR NOT NULL,
    project_id UUID NOT NULL,
    project_name VARCHAR NOT NULL,

    -- Flattened assignee data
    assignee_ids UUID[],
    assignee_names VARCHAR[],
    assignee_emails VARCHAR[],

    -- JSON for labels and custom fields
    labels JSONB, -- [{"id": "...", "name": "Bug", "color": "#ff0000"}]
    custom_fields JSONB, -- {"priority": "High", "story_points": 8}

    -- Pre-computed values
    is_overdue BOOLEAN GENERATED ALWAYS AS (due_date < NOW()) STORED,
    days_until_due INTEGER GENERATED ALWAYS AS (EXTRACT(days FROM due_date - NOW())) STORED,

    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Aggregation tables for instant dashboard queries
CREATE TABLE workspace_stats (
    workspace_id UUID PRIMARY KEY,
    total_tasks INTEGER DEFAULT 0,
    completed_tasks INTEGER DEFAULT 0,
    overdue_tasks INTEGER DEFAULT 0,
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE project_stats (
    project_id UUID PRIMARY KEY,
    total_tasks INTEGER DEFAULT 0,
    completed_tasks INTEGER DEFAULT 0,
    overdue_tasks INTEGER DEFAULT 0,
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes optimized for read patterns
CREATE INDEX idx_tasks_tenant_workspace ON tasks (tenant_id, workspace_id);
CREATE INDEX idx_tasks_assignees ON tasks USING GIN (assignee_ids);
CREATE INDEX idx_tasks_labels ON tasks USING GIN (labels);
CREATE INDEX idx_tasks_due_date ON tasks (due_date) WHERE due_date IS NOT NULL;
```

**Usage Example:**
```sql
-- User dashboard (zero joins)
SELECT title, description, due_date, project_name,
       labels->'name' as label_names,
       is_overdue, days_until_due
FROM tasks
WHERE $1 = ANY(assignee_ids)
  AND tenant_id = $2
ORDER BY due_date ASC NULLS LAST;

-- Project overview with filtering (single table)
SELECT COUNT(*) as total,
       COUNT(*) FILTER (WHERE is_overdue) as overdue,
       json_agg(DISTINCT labels) as all_labels_used
FROM tasks
WHERE project_id = $1
  AND ($2 IS NULL OR $2 = ANY(assignee_ids));
```

**Hidden Complexity:**
- Write operations require 3-5 table updates with careful transaction management
- Data consistency requires triggers, background jobs, and monitoring
- Storage overhead of 2-5x due to massive redundancy
- Schema changes become complex cascade operations
- Complex update logic when reference data changes

**Tradeoffs:**
- ✅ Lightning-fast reads (sub-100ms regardless of data size)
- ✅ Zero-join queries for complex filtering
- ✅ Instant aggregations with pre-calculated stats
- ✅ Scalable performance that doesn't degrade with growth
- ❌ 2-5x storage overhead from redundancy
- ❌ Complex write operations and consistency management
- ❌ Schema changes require careful cascade planning
- ❌ Potential for data inconsistency if triggers fail

## Design 3: Event-Sourced

**Event Store Schema:**
```sql
CREATE TABLE events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_id UUID NOT NULL,
    aggregate_type VARCHAR NOT NULL,
    event_type VARCHAR NOT NULL,
    event_version INTEGER NOT NULL,
    tenant_id UUID NOT NULL, -- For isolation

    event_data JSONB NOT NULL,
    metadata JSONB DEFAULT '{}',

    -- Distributed tracing
    causation_id UUID, -- Event that caused this
    correlation_id UUID, -- Request/command that started the chain

    created_at TIMESTAMP DEFAULT NOW(),

    -- Ensure event ordering per aggregate
    UNIQUE (aggregate_id, event_version)
);

-- Optimized for event replay
CREATE INDEX idx_events_aggregate_replay ON events (aggregate_id, event_version);
CREATE INDEX idx_events_tenant ON events (tenant_id);
CREATE INDEX idx_events_created_at ON events (created_at);

-- Snapshots for performance
CREATE TABLE snapshots (
    aggregate_id UUID PRIMARY KEY,
    aggregate_type VARCHAR NOT NULL,
    version INTEGER NOT NULL,
    data JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);
```

**Event Types:**
```json
// Task Created
{
  "event_type": "TaskCreated",
  "event_data": {
    "task_id": "123e4567-e89b-12d3-a456-426614174000",
    "project_id": "234e5678-e89b-12d3-a456-426614174001",
    "title": "Implement user authentication",
    "description": "Add OAuth2 support...",
    "created_by": "user123"
  }
}

// Task Assigned
{
  "event_type": "TaskAssigned",
  "event_data": {
    "task_id": "123e4567-e89b-12d3-a456-426614174000",
    "assigned_to": "user456",
    "assigned_by": "user123"
  }
}

// Custom Field Set
{
  "event_type": "TaskCustomFieldSet",
  "event_data": {
    "task_id": "123e4567-e89b-12d3-a456-426614174000",
    "field_name": "priority",
    "field_value": "High"
  }
}
```

**Usage Example:**
```javascript
// Rebuild Task aggregate from events
function rebuildTask(taskId, events) {
    let task = null;

    for (const event of events) {
        switch (event.event_type) {
            case 'TaskCreated':
                task = {
                    id: event.event_data.task_id,
                    project_id: event.event_data.project_id,
                    title: event.event_data.title,
                    description: event.event_data.description,
                    assignees: [],
                    labels: [],
                    custom_fields: {},
                    status: 'open'
                };
                break;

            case 'TaskAssigned':
                task.assignees.push(event.event_data.assigned_to);
                break;

            case 'TaskCustomFieldSet':
                task.custom_fields[event.event_data.field_name] =
                    event.event_data.field_value;
                break;

            case 'TaskCompleted':
                task.status = 'completed';
                task.completed_at = event.created_at;
                break;
        }
    }

    return task;
}
```

**Hidden Complexity:**
- Event ordering and optimistic concurrency control
- Performance optimization through snapshots and projections
- Schema evolution and event versioning strategies
- Cross-aggregate queries requiring read model maintenance
- Event store maintenance and data lifecycle management

**Tradeoffs:**
- ✅ Complete audit trail and time travel capabilities
- ✅ High scalability through append-only operations
- ✅ Rich analytics from historical event data
- ✅ Natural fit for complex business workflows
- ❌ High implementation complexity and steep learning curve
- ❌ Append-only storage growth over time
- ❌ Eventual consistency model
- ❌ Complex debugging and troubleshooting

## Design 4: Document-Oriented

**Document Schema:**
```javascript
// Task Document (self-contained)
{
  "_id": "task_123456",
  "title": "Implement user authentication",
  "description": "Add OAuth2 support with Google and GitHub providers",
  "status": "in_progress",
  "due_date": "2024-03-15T10:00:00Z",

  // Embedded hierarchy info
  "tenant": {
    "id": "tenant_123",
    "name": "Acme Corp"
  },
  "workspace": {
    "id": "workspace_456",
    "name": "Engineering"
  },
  "project": {
    "id": "project_789",
    "name": "Authentication System"
  },

  // Embedded user data to avoid lookups
  "assignees": [
    {
      "id": "user_101",
      "name": "John Doe",
      "email": "john@acme.com",
      "avatar_url": "https://..."
    }
  ],

  "labels": [
    {
      "id": "label_001",
      "name": "Backend",
      "color": "#blue",
      "description": "Server-side work"
    }
  ],

  // Flexible custom fields
  "custom_fields": {
    "story_points": 8,
    "sprint": "Sprint 23",
    "priority": "High",
    "component": "Authentication"
  },

  // Embedded activity history
  "comments": [
    {
      "id": "comment_001",
      "author": {
        "id": "user_102",
        "name": "Jane Smith"
      },
      "content": "Added OAuth2 library dependency",
      "created_at": "2024-03-10T14:30:00Z"
    }
  ],

  "activity": [
    {
      "type": "assigned",
      "user": {"id": "user_101", "name": "John Doe"},
      "timestamp": "2024-03-08T09:00:00Z"
    },
    {
      "type": "status_changed",
      "from": "open",
      "to": "in_progress",
      "user": {"id": "user_101", "name": "John Doe"},
      "timestamp": "2024-03-10T10:15:00Z"
    }
  ],

  "created_at": "2024-03-08T09:00:00Z",
  "updated_at": "2024-03-10T14:30:00Z"
}

// Project Document (aggregated task info)
{
  "_id": "project_789",
  "name": "Authentication System",
  "workspace_id": "workspace_456",
  "tenant_id": "tenant_123",

  // Pre-aggregated stats for dashboards
  "stats": {
    "total_tasks": 15,
    "open_tasks": 8,
    "in_progress_tasks": 4,
    "completed_tasks": 3,
    "overdue_tasks": 2
  },

  "custom_field_definitions": [
    {
      "name": "story_points",
      "type": "number",
      "required": true
    },
    {
      "name": "priority",
      "type": "select",
      "options": ["Low", "Medium", "High", "Critical"]
    }
  ]
}
```

**Usage Example:**
```javascript
// Get user's tasks (single query)
db.tasks.find({
  "assignees.id": "user_101",
  "tenant.id": "tenant_123",
  "status": { $in: ["open", "in_progress"] }
}).sort({ "due_date": 1 });

// Project kanban board (single query with aggregation)
db.tasks.aggregate([
  { $match: { "project.id": "project_789" } },
  { $group: {
      _id: "$status",
      tasks: { $push: {
        id: "$_id",
        title: "$title",
        assignees: "$assignees",
        labels: "$labels"
      }}
    }}
]);

// Full task details with comments (single document fetch)
db.tasks.findOne({"_id": "task_123456"});
```

**Hidden Complexity:**
- Data consistency management when reference data changes
- Complex update operations for embedded user information
- Document size management for tasks with extensive comment threads
- Index strategy optimization for embedded array queries
- Bulk update operations when organizational structure changes

**Tradeoffs:**
- ✅ Excellent query performance (1-2 lookups for most operations)
- ✅ Great developer experience with natural object mapping
- ✅ Effective caching with self-contained documents
- ✅ Strong offline support for mobile applications
- ❌ 2-3x storage overhead from data duplication
- ❌ Complex update logic when reference data changes
- ❌ Potential document size issues with long histories
- ❌ Cross-project analytics require map-reduce operations

## Design Comparison

**Query Complexity**:
- **Fully Normalized**: Complex (12+ table joins for basic queries)
- **Denormalized**: Simple (zero-join queries, pre-aggregated)
- **Event-Sourced**: Variable (simple reads from projections, complex state derivation)
- **Document-Oriented**: Simple (1-2 document lookups for most operations)

**Data Consistency**:
- **Fully Normalized** (winner): Database-enforced ACID guarantees
- **Event-Sourced**: Strong consistency within aggregates, eventual across
- **Denormalized**: Complex consistency through triggers and background jobs
- **Document-Oriented**: Manual consistency maintenance required

**Performance Characteristics**:
- **Denormalized** (winner for reads): Sub-100ms dashboards, instant aggregations
- **Document-Oriented**: Excellent read performance, good caching
- **Event-Sourced**: Great read performance with projections, write overhead
- **Fully Normalized**: Poor read performance, excellent write performance

**Storage Efficiency**:
- **Fully Normalized** (winner): Zero redundancy, minimal storage
- **Event-Sourced**: Append-only growth, historical data preserved
- **Denormalized**: 2-5x storage overhead from redundancy
- **Document-Oriented**: 2-3x storage overhead from embedding

**Audit/Analytics Capabilities**:
- **Event-Sourced** (winner): Complete audit trail, time travel, rich analytics
- **Denormalized**: Pre-computed aggregations for fast reporting
- **Document-Oriented**: Activity history embedded in documents
- **Fully Normalized**: Basic audit through change tracking

**Development Complexity**:
- **Document-Oriented** (simplest): Intuitive object mapping, natural development
- **Denormalized**: Complex write operations, consistency management
- **Fully Normalized**: Standard SQL patterns, well-understood
- **Event-Sourced** (most complex): Steep learning curve, specialized patterns

## Synthesis & Recommendation

**For most task management systems, choose Document-Oriented with selective normalization**:

1. **Natural fit**: Tasks are naturally document-centric with embedded comments, labels, attachments
2. **Developer productivity**: Intuitive object mapping accelerates development
3. **Query simplicity**: Most screens require 1-2 lookups instead of complex joins
4. **Offline support**: Self-contained documents work well for mobile apps

**Hybrid approach for optimal results**:
- Use **Document-Oriented** for core entities (Tasks, Projects) with embedded operational data
- Use **Normalized tables** for reference data (Users, Labels, Custom Field Definitions) that changes frequently
- Implement **Event sourcing** for critical audit trails (task status changes, assignments)
- Add **Denormalized views** for dashboard aggregations

**Implementation strategy**:
1. Start with pure document model for MVP
2. Extract frequently-changing reference data to normalized tables
3. Add event sourcing for audit-critical operations
4. Create denormalized projections for reporting as needed

This hybrid approach maximizes developer productivity while addressing the consistency and storage concerns of pure document orientation.