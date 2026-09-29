-- Give each JobLog row the INSTANCE of the BullMQ job it belongs to.
--
-- Why: submit-order uses a FIXED job id per order (that is what stops two jobs
-- submitting one order twice), and that id is reused every time the order is
-- re-enqueued. A replacement job restarts at attempt 1, so `(bullJobId, attempt)`
-- collides with the attempt-1 row of the job it replaced. Observed on the first
-- real COD order: the WINNING attempt could not be recorded at all -- the insert
-- hit the unique index, `startJobLog` warned and returned a null id, and the
-- finish became a no-op. Job history silently lost the only attempt that mattered.
--
-- The discriminator is BullMQ's `job.timestamp` (enqueue time, epoch millis) as a
-- string. It is stable for the life of one job instance, differs between a job and
-- its replacement, and needs no coordination.
--
-- DEFAULT '' so rows written before this column existed keep the old
-- `(bullJobId, attempt)` uniqueness among themselves instead of becoming
-- duplicable. New rows always carry a real timestamp.
ALTER TABLE `job_logs` ADD COLUMN `jobInstance` VARCHAR(32) NOT NULL DEFAULT '';

-- Swap the uniqueness: one row per attempt per job INSTANCE. Re-logging a given
-- attempt of a given instance is still idempotent, which is what the original
-- constraint was for.
DROP INDEX `job_logs_bullJobId_attempt_key` ON `job_logs`;

CREATE UNIQUE INDEX `job_logs_bullJobId_jobInstance_attempt_key`
  ON `job_logs`(`bullJobId`, `jobInstance`, `attempt`);
