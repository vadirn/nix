## 1. How will you design cache keys to avoid collisions and enable targeted invalidation?

**Recommended:** Use hierarchical keys like `api:v1:users:{id}:profile` or `api:v1:posts:list:page:{n}`. This enables pattern-based invalidation (`DEL api:v1:users:{id}:*` when user data changes) and prevents key collisions between different API endpoints. This accepts slightly longer key names but gains precise invalidation control.

## 2. When Redis Cluster is unreachable, do you fall back to the database (adding latency) or return cached-miss errors (potentially breaking clients)?

**Recommended:** Fall back to database with circuit breaker pattern. When Redis is down, bypass cache entirely for reads and continue processing writes normally. This maintains API availability at the cost of higher database load and increased response times.

## 3. How will you handle write invalidation across multiple API instances when using Redis Cluster?

**Recommended:** Implement pub/sub invalidation notifications. When any API instance processes a write, it publishes invalidation events to a Redis channel that all instances subscribe to. This ensures cache coherence across the cluster but adds complexity of managing pub/sub connections and handling message delivery failures.

## 4. What happens when cache invalidation fails but the write succeeds?

**Recommended:** Log the invalidation failure and continue. Implement a background job that periodically cleans up potentially stale entries by checking timestamps. This accepts temporary inconsistency for 5 minutes (TTL period) but prevents write operations from failing due to cache issues.

## 5. How will you handle Redis Cluster node failures and data resharding?

**Recommended:** Configure Redis Cluster with minimum 3 master nodes and 1 replica each. Use Redis client libraries that automatically handle cluster topology changes and node failover. This accepts higher infrastructure costs but provides true high availability.

## 6. Which GET endpoints will you cache, and how will you handle endpoints with user-specific data?

**Recommended:** Cache public/shared data (product catalogs, static content) and user-specific data with user-scoped keys (`user:{id}:dashboard`). Skip caching for endpoints with complex query parameters or real-time requirements. This accepts increased complexity in key design but maximizes cache hit rates.

## 7. How will you prevent cache stampeding when popular cached items expire?

**Recommended:** Implement cache warming with jittered TTL (4-6 minute random TTL instead of exactly 5 minutes) and single-flight pattern for expensive queries. When cache miss occurs, only one request fetches from database while others wait for the result. This accepts slight complexity but prevents database overload.

## 8. How will you monitor cache performance and detect degradation?

**Recommended:** Track cache hit ratio, Redis memory usage, response time improvements, and invalidation success rates. Set alerts for hit ratio below 70% or Redis memory above 80%. This accepts monitoring overhead but enables proactive cache optimization.

## 9. How will you handle cache warming on deployment or Redis restarts?

**Recommended:** Implement lazy loading (cache-aside pattern) rather than pre-warming. Let normal traffic naturally warm the cache over 5-10 minutes after restart. For critical paths, consider background jobs to pre-populate specific high-traffic keys. This accepts temporary performance degradation but avoids complex warming logic.

## 10. What's your Redis memory management strategy when cache grows beyond available memory?

**Recommended:** Configure Redis with `maxmemory-policy allkeys-lru` and set `maxmemory` to 80% of available RAM. This automatically evicts least-recently-used keys when memory pressure occurs. This accepts potential cache misses for older entries but prevents Redis from crashing due to memory exhaustion.

## Summary

### Resolved
- **Cache key design**: Hierarchical keys for targeted invalidation
- **Failure handling**: Database fallback with circuit breaker
- **Invalidation strategy**: Pub/sub notifications across instances
- **High availability**: 3-master Redis Cluster with replicas
- **Memory management**: LRU eviction with 80% memory limit
- **Monitoring**: Hit ratio, memory usage, and performance metrics
- **Cache warming**: Lazy loading approach

### Unresolved
- **Specific endpoint selection**: Need to audit existing APIs to determine which endpoints benefit most from caching
- **Redis infrastructure sizing**: Need to estimate memory requirements based on actual traffic patterns
- **Deployment rollout**: Need strategy for enabling cache gradually vs all-at-once activation