Database connection pools reuse connections instead of creating new ones.

Creating database connections costs time—each requires TCP handshake, TLS negotiation, and authentication. Reusing connections eliminates this overhead.

Connection pools maintain idle connections. Requests borrow connections from the pool, then return them when done.

If all connections are busy, requests wait. If wait exceeds timeout, the request fails.

## Configuration

- Default pool size: 10
- Maximum pool size: 50
- Idle timeout: 30 seconds
- Connection lifetime: 1 hour

Tune values based on workload. Monitor pool use. Export connection pool metrics to monitoring systems.