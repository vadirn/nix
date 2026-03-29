The platform team designed our event-driven architecture in 2023 using RabbitMQ for message routing. Exchange-based routing enabled flexible message distribution across microservices.

The system experienced message loss under high load. Dead-letter queues did not solve this problem. Our custom queue monitoring solution lacked production reliability.

We chose to migrate from RabbitMQ to Kafka. The architecture review board evaluated this decision. Kafka offers durable, ordered, and replayable event streams.

The migration has three phases. First, implement dual-write capability to publish events to both RabbitMQ and Kafka. Second, migrate consumers to read from Kafka. Third, decommission RabbitMQ.

Kafka adds operational complexity. Teams must learn partition models, consumer groups, and offset management. Kafka requires more storage than RabbitMQ.