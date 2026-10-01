-- AlterTable
ALTER TABLE "PluggyItem" ADD COLUMN     "connectorId" INTEGER,
ADD COLUMN     "connectorImageUrl" TEXT,
ADD COLUMN     "connectorPrimaryColor" TEXT,
ADD COLUMN     "connectorType" TEXT,
ADD COLUMN     "customName" TEXT,
ADD COLUMN     "status" TEXT;
