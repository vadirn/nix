The platform team built our event-driven architecture in 2023 using RabbitMQ for message routing across microservices.

RabbitMQ created challenges: message loss during high load, and dead-letter queues didn't solve the problem. Our custom monitoring solution for queue depths wasn't production-ready.

We decided to migrate from RabbitMQ to Apache Kafka after the architecture review board's evaluation. Kafka provides durable, ordered, replayable event streams that RabbitMQ cannot match.

The three-phase migration: First, implement dual-write to publish events to both RabbitMQ and Kafka. Second, migrate consumers to read from Kafka. Third, decommission RabbitMQ.

Kafka introduces operational complexity. The team must learn partition models, consumer groups, and offset management. We need monitoring and alerting before production deployment. Kafka requires more disk space than RabbitMQ.