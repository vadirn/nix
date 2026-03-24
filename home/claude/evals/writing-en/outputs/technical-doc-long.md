Database connection pooling maintains a set of idle connections for reuse. Creating new database connections is expensive due to TCP handshake, TLS negotiation, and authentication overhead. Connection pools eliminate this cost.

Requests borrow connections from the pool and return them when done. If all connections are busy, requests wait until timeout.

Default settings: pool size 10, maximum 50, idle timeout 30 seconds, connection lifetime 1 hour. Tune these values for your workload and monitor pool utilization for optimal performance.