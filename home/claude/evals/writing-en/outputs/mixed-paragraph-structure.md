We should switch to a streaming architecture. It offers better latency, throughput, and memory usage. Backwards compatibility is the main constraint.

The old batch system processes data in chunks. The new streaming system handles records individually using Kafka, a distributed event streaming platform that LinkedIn originally built to handle its activity stream data.
