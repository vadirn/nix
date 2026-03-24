We switched to a streaming architecture for better latency, throughput, and memory usage.

The old batch system processes data in chunks. The new streaming system handles records individually while maintaining backwards compatibility.

The system uses Kafka, a distributed event streaming platform that LinkedIn built to handle activity stream data.