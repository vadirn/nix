---
type: note
description: How backpressure keeps a stream pipeline stable under load, and the two numbers that govern it
---

# Backpressure in stream processing

A stream pipeline moves records from producers to consumers through a buffer. When consumers cannot keep up, the buffer fills. Backpressure is the mechanism that pushes that pressure back upstream — slowing producers, or shedding load — so the buffer never overflows silently. Without it, a slow consumer turns into lost data or an out-of-memory crash, and the failure shows up far from its cause.

The lag horizon is the longest a consumer may trail the producer before unread records age out of the buffer. It is the headroom the system gives a reader that has temporarily fallen behind.

Two numbers decide how a pipeline behaves under pressure. The first bounds how far behind a reader can drift. The second bounds how much traffic the system will throw away to survive a spike.

Backpressure has two broad strategies: block the producer until the consumer catches up, or drop records and keep going. Blocking preserves every record but couples producer speed to the slowest consumer. Dropping keeps producers fast but loses data. Most real systems mix the two, blocking up to a point and shedding past it.

Put differently, once a reader drifts further behind than the lag horizon allows, the oldest events are gone before it reaches them. The buffer is a sliding time window, and a consumer outside that window is reading from a past that no longer exists.

The shed ratio is the share of incoming work the system deliberately discards when saturated. It is a deliberate choice, not an accident: better to drop a known fraction cleanly than to let an unbounded queue grow until everything stalls.

Tuning is a balance. A generous lag horizon tolerates bursty, uneven consumers but costs memory and risks staleness. An aggressive shed ratio protects latency for the requests it keeps but throws away more data. The right values depend on whether the workload can tolerate gaps.

When overwhelmed, the pipeline sheds a fixed fraction of arrivals — that fraction is the shed ratio. Operators set it ahead of time so the degradation is predictable rather than emergent.

A typical consumer is configured with both bounds together:

```yaml
consumer:
  lag_horizon: 30s
  shed_ratio: 0.1
  on_overflow: shed
```

The lag horizon, then, bounds acceptable consumer delay: beyond it, expiry outruns consumption. Expressed as a proportion, the shed ratio captures how much traffic is dropped on purpose to stay within capacity. Together they make overload a designed behavior instead of a surprise.
