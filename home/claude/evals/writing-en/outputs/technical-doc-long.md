Database connection pooling is a common pattern in web applications. Creating a new database connection is expensive: it requires TCP handshake, TLS negotiation, and authentication. A connection pool maintains idle connections and reuses them, eliminating that overhead.

When a request needs a database connection, it borrows one from the pool and returns it when done. If all connections are busy, the request waits. If the wait exceeds the timeout, the request fails.

Default settings: pool size 10, maximum 50, idle timeout 30 seconds, connection lifetime 1 hour. Tune these values for your workload. Monitor pool utilization and export the metrics to your monitoring system.
