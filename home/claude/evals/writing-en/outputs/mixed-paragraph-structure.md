We chose streaming architecture for better latency, throughput, and memory usage. This decision must consider backwards compatibility.

The old batch system processes data in chunks. The new streaming system handles records individually using Kafka, LinkedIn's distributed event streaming platform.