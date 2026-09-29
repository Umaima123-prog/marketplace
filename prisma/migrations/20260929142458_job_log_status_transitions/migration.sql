-- AlterTable
ALTER TABLE `job_logs` ADD COLUMN `endStatus` VARCHAR(32) NULL,
    ADD COLUMN `retryable` BOOLEAN NULL,
    ADD COLUMN `startStatus` VARCHAR(32) NULL;
