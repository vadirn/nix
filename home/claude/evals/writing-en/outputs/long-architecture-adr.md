## Why We Are Leaving RabbitMQ

The platform team built our event-driven architecture in 2023 using RabbitMQ. The team chose it for its exchange-based routing, which enabled flexible message distribution across microservices.

RabbitMQ has created problems. Message loss occurred during high load, and dead-letter queues didn't solve it. We monitored queue depths with a custom solution built by the infrastructure team, but it wasn't production-ready.

## Migrating to Apache Kafka

The architecture review board evaluated alternatives and chose Apache Kafka. Kafka provides durable, ordered, replayable event streams. RabbitMQ does not.

The migration runs in three phases. First, implement dual-write to publish events to both RabbitMQ and Kafka. Second, migrate consumers to read from Kafka. Third, decommission RabbitMQ.

## Operational Impact

Kafka introduces significant operational complexity. The team must learn Kafka's partition model, consumer groups, and offset management. Set up monitoring and alerting before the production deployment. Kafka also requires more disk space than RabbitMQ, so provision additional storage.
