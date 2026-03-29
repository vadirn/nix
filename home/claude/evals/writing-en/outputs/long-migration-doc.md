## Why We Migrated from PostgreSQL 12 to PostgreSQL 16

The database team migrated our primary database from PostgreSQL 12 to PostgreSQL 16 using logical replication in a dedicated migration environment.

Three factors affect migration timeline: dataset size, number of dependent services, and backwards compatibility requirements.

## Preparation

We identified all affected tables and created replication slots. The operations team implemented monitoring for replication lag with alerting thresholds before starting the migration.

## Migration

We replicated every table to the new cluster and verified data integrity by running checksums on source and target databases. If discrepancies appeared, we would initiate rollback. Because this setup resembled standard logical replication, the team was familiar with the operational procedures.

## Outcome

The migration succeeded. Use this approach for future migrations.
