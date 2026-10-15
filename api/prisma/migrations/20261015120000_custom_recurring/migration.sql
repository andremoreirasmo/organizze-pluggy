-- CreateEnum
CREATE TYPE "CustomRecurringKind" AS ENUM ('EXPENSE', 'INCOME');

-- CreateEnum
CREATE TYPE "CustomRecurringUnit" AS ENUM ('DAY', 'WEEK', 'MONTH');

-- CreateEnum
CREATE TYPE "CustomRecurringStatus" AS ENUM ('ACTIVE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CustomRecurringOccurrenceStatus" AS ENUM ('PENDING', 'CREATED', 'FAILED');

-- CreateTable
CREATE TABLE "CustomRecurringSeries" (
    "id" TEXT NOT NULL,
    "kind" "CustomRecurringKind" NOT NULL,
    "description" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "accountId" INTEGER NOT NULL,
    "categoryId" INTEGER,
    "tags" JSONB NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "intervalUnit" "CustomRecurringUnit" NOT NULL,
    "intervalCount" INTEGER NOT NULL,
    "status" "CustomRecurringStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomRecurringSeries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomRecurringOccurrence" (
    "id" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "scheduledDate" DATE NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "organizzeTransactionId" INTEGER,
    "status" "CustomRecurringOccurrenceStatus" NOT NULL DEFAULT 'PENDING',
    "lastError" TEXT,

    CONSTRAINT "CustomRecurringOccurrence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomRecurringOccurrence_seriesId_idx" ON "CustomRecurringOccurrence"("seriesId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomRecurringOccurrence_seriesId_index_key" ON "CustomRecurringOccurrence"("seriesId", "index");

-- AddForeignKey
ALTER TABLE "CustomRecurringOccurrence" ADD CONSTRAINT "CustomRecurringOccurrence_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "CustomRecurringSeries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
