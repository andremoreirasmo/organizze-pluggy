-- Organizze transaction ids exceed PostgreSQL INTEGER range.
ALTER TABLE "CustomRecurringOccurrence"
ALTER COLUMN "organizzeTransactionId" TYPE BIGINT;
