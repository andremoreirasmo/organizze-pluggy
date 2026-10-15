-- CreateEnum
CREATE TYPE "SavingsGoalStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'PAUSED');

-- CreateEnum
CREATE TYPE "GoalLedgerKind" AS ENUM ('CONTRIBUTION', 'REALLOCATION', 'ADJUSTMENT');

-- CreateTable
CREATE TABLE "GoalsPreference" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "minPct" DOUBLE PRECISION NOT NULL DEFAULT 30,
    "primaryPct" DOUBLE PRECISION NOT NULL DEFAULT 35,
    "idealPct" DOUBLE PRECISION NOT NULL DEFAULT 40,
    "investmentCategoryIds" JSONB NOT NULL DEFAULT '[]',
    "estimatedUsdBrl" DOUBLE PRECISION,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoalsPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavingsGoal" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "targetCents" INTEGER NOT NULL,
    "allocatedCents" INTEGER NOT NULL DEFAULT 0,
    "targetDate" DATE,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "monthlyContributionCents" INTEGER,
    "monthlyContributionPct" DOUBLE PRECISION,
    "status" "SavingsGoalStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavingsGoal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoalLedgerEntry" (
    "id" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "kind" "GoalLedgerKind" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoalLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SavingsGoal_status_priority_idx" ON "SavingsGoal"("status", "priority");

-- CreateIndex
CREATE INDEX "GoalLedgerEntry_goalId_date_idx" ON "GoalLedgerEntry"("goalId", "date");

-- AddForeignKey
ALTER TABLE "GoalLedgerEntry" ADD CONSTRAINT "GoalLedgerEntry_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "SavingsGoal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
