-- CreateTable
CREATE TABLE `products` (
    `id` VARCHAR(191) NOT NULL,
    `shopifyProductId` VARCHAR(255) NOT NULL,
    `handle` VARCHAR(255) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `descriptionHtml` TEXT NULL,
    `vendor` VARCHAR(255) NULL,
    `productType` VARCHAR(255) NULL,
    `status` ENUM('ACTIVE', 'ARCHIVED', 'DRAFT') NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT false,
    `deactivatedAt` DATETIME(3) NULL,
    `deactivationReason` ENUM('SHOPIFY_STATUS', 'MISSING_FROM_SYNC', 'SHOPIFY_DELETED') NULL,
    `publishedAt` DATETIME(3) NULL,
    `shopifyUpdatedAt` DATETIME(3) NOT NULL,
    `lastSyncRunId` VARCHAR(36) NULL,
    `syncedAt` DATETIME(3) NOT NULL,
    `variantSyncCursor` VARCHAR(1024) NULL,
    `variantSyncComplete` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `products_shopifyProductId_key`(`shopifyProductId`),
    UNIQUE INDEX `products_handle_key`(`handle`),
    INDEX `products_isActive_publishedAt_id_idx`(`isActive`, `publishedAt`, `id`),
    INDEX `products_lastSyncRunId_idx`(`lastSyncRunId`),
    INDEX `products_variantSyncComplete_idx`(`variantSyncComplete`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `product_variants` (
    `id` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `shopifyVariantId` VARCHAR(255) NOT NULL,
    `sku` VARCHAR(255) NULL,
    `title` VARCHAR(255) NOT NULL,
    `position` INTEGER NOT NULL DEFAULT 0,
    `price` DECIMAL(18, 4) NOT NULL,
    `compareAtPrice` DECIMAL(18, 4) NULL,
    `currencyCode` CHAR(3) NOT NULL,
    `inventoryQuantity` INTEGER NOT NULL DEFAULT 0,
    `inventoryTracked` BOOLEAN NOT NULL DEFAULT true,
    `inventoryPolicy` ENUM('DENY', 'CONTINUE') NOT NULL DEFAULT 'DENY',
    `isActive` BOOLEAN NOT NULL DEFAULT false,
    `deactivatedAt` DATETIME(3) NULL,
    `deactivationReason` ENUM('SHOPIFY_STATUS', 'MISSING_FROM_SYNC', 'SHOPIFY_DELETED') NULL,
    `shopifyUpdatedAt` DATETIME(3) NOT NULL,
    `lastSyncRunId` VARCHAR(36) NULL,
    `syncedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `product_variants_shopifyVariantId_key`(`shopifyVariantId`),
    INDEX `product_variants_productId_position_idx`(`productId`, `position`),
    INDEX `product_variants_lastSyncRunId_idx`(`lastSyncRunId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `product_images` (
    `id` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `shopifyImageId` VARCHAR(255) NOT NULL,
    `url` VARCHAR(2048) NOT NULL,
    `altText` VARCHAR(500) NULL,
    `position` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `product_images_shopifyImageId_key`(`shopifyImageId`),
    INDEX `product_images_productId_position_idx`(`productId`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sync_runs` (
    `id` VARCHAR(191) NOT NULL,
    `mode` ENUM('FULL', 'INCREMENTAL') NOT NULL,
    `status` ENUM('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED') NOT NULL DEFAULT 'RUNNING',
    `activeLock` VARCHAR(16) NULL,
    `heartbeatAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `watermarkFrom` DATETIME(3) NULL,
    `pagesProcessed` INTEGER NOT NULL DEFAULT 0,
    `productsUpserted` INTEGER NOT NULL DEFAULT 0,
    `variantsUpserted` INTEGER NOT NULL DEFAULT 0,
    `productsDeactivated` INTEGER NOT NULL DEFAULT 0,
    `lastCursor` VARCHAR(1024) NULL,
    `lastError` TEXT NULL,
    `triggeredBy` ENUM('SCHEDULE', 'NIGHTLY', 'MANUAL', 'WEBHOOK') NOT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,

    UNIQUE INDEX `sync_runs_activeLock_key`(`activeLock`),
    INDEX `sync_runs_status_heartbeatAt_idx`(`status`, `heartbeatAt`),
    INDEX `sync_runs_status_startedAt_idx`(`status`, `startedAt`),
    INDEX `sync_runs_mode_startedAt_idx`(`mode`, `startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `orders` (
    `id` VARCHAR(191) NOT NULL,
    `reference` VARCHAR(32) NOT NULL,
    `publicToken` VARCHAR(64) NOT NULL,
    `idempotencyKey` VARCHAR(64) NOT NULL,
    `requestFingerprint` CHAR(64) NOT NULL,
    `submissionKey` VARCHAR(64) NOT NULL,
    `status` ENUM('PENDING_SYNC', 'SYNCING', 'DRAFT_CREATED', 'SYNCED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'PENDING_SYNC',
    `paymentMethod` ENUM('COD') NOT NULL DEFAULT 'COD',
    `currencyCode` CHAR(3) NOT NULL,
    `subtotal` DECIMAL(18, 4) NOT NULL,
    `shippingTotal` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `taxTotal` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `grandTotal` DECIMAL(18, 4) NOT NULL,
    `customerName` VARCHAR(255) NOT NULL,
    `customerPhone` VARCHAR(32) NOT NULL,
    `customerEmail` VARCHAR(320) NULL,
    `addressLine1` VARCHAR(255) NOT NULL,
    `addressLine2` VARCHAR(255) NULL,
    `city` VARCHAR(128) NOT NULL,
    `province` VARCHAR(128) NULL,
    `postalCode` VARCHAR(32) NULL,
    `countryCode` CHAR(2) NOT NULL,
    `customerNote` TEXT NULL,
    `shopifyDraftOrderId` VARCHAR(255) NULL,
    `shopifyOrderId` VARCHAR(255) NULL,
    `shopifyOrderName` VARCHAR(64) NULL,
    `attempt` INTEGER NOT NULL DEFAULT 0,
    `claimedAt` DATETIME(3) NULL,
    `submittedAt` DATETIME(3) NULL,
    `failureReason` VARCHAR(128) NULL,
    `lastError` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `orders_reference_key`(`reference`),
    UNIQUE INDEX `orders_publicToken_key`(`publicToken`),
    UNIQUE INDEX `orders_idempotencyKey_key`(`idempotencyKey`),
    UNIQUE INDEX `orders_submissionKey_key`(`submissionKey`),
    UNIQUE INDEX `orders_shopifyDraftOrderId_key`(`shopifyDraftOrderId`),
    UNIQUE INDEX `orders_shopifyOrderId_key`(`shopifyOrderId`),
    INDEX `orders_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `orders_status_claimedAt_idx`(`status`, `claimedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `order_items` (
    `id` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `variantId` VARCHAR(191) NULL,
    `shopifyVariantId` VARCHAR(255) NOT NULL,
    `shopifyProductId` VARCHAR(255) NOT NULL,
    `productTitle` VARCHAR(255) NOT NULL,
    `variantTitle` VARCHAR(255) NOT NULL,
    `sku` VARCHAR(255) NULL,
    `unitPrice` DECIMAL(18, 4) NOT NULL,
    `quantity` INTEGER NOT NULL,
    `lineTotal` DECIMAL(18, 4) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `order_items_variantId_idx`(`variantId`),
    UNIQUE INDEX `order_items_orderId_shopifyVariantId_key`(`orderId`, `shopifyVariantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `job_logs` (
    `id` VARCHAR(191) NOT NULL,
    `queueName` VARCHAR(64) NOT NULL,
    `jobName` VARCHAR(64) NOT NULL,
    `bullJobId` VARCHAR(128) NOT NULL,
    `attempt` INTEGER NOT NULL,
    `entityType` ENUM('ORDER', 'PRODUCT', 'SYNC_RUN') NULL,
    `entityId` VARCHAR(64) NULL,
    `status` ENUM('STARTED', 'SUCCEEDED', 'FAILED') NOT NULL DEFAULT 'STARTED',
    `durationMs` INTEGER NULL,
    `errorClass` VARCHAR(128) NULL,
    `errorMessage` TEXT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,

    INDEX `job_logs_entityType_entityId_startedAt_idx`(`entityType`, `entityId`, `startedAt`),
    INDEX `job_logs_queueName_status_startedAt_idx`(`queueName`, `status`, `startedAt`),
    INDEX `job_logs_status_startedAt_idx`(`status`, `startedAt`),
    UNIQUE INDEX `job_logs_bullJobId_attempt_key`(`bullJobId`, `attempt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `webhook_events` (
    `id` VARCHAR(191) NOT NULL,
    `shopifyWebhookId` VARCHAR(255) NOT NULL,
    `topic` VARCHAR(128) NOT NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `processedAt` DATETIME(3) NULL,

    UNIQUE INDEX `webhook_events_shopifyWebhookId_key`(`shopifyWebhookId`),
    INDEX `webhook_events_topic_receivedAt_idx`(`topic`, `receivedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `product_variants` ADD CONSTRAINT `product_variants_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `product_images` ADD CONSTRAINT `product_images_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `order_items` ADD CONSTRAINT `order_items_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `order_items` ADD CONSTRAINT `order_items_variantId_fkey` FOREIGN KEY (`variantId`) REFERENCES `product_variants`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- HAND-WRITTEN ADDITIONS
--
-- Everything above this line was generated by `prisma migrate dev --create-only`
-- and is untouched. Everything below is the block planned in prisma/schema.prisma
-- (see the "TO BE APPENDED TO THE FIRST MIGRATION" comment), which Prisma cannot
-- express in PSL. No schema change is smuggled in here: these statements add
-- constraints, they do not add, drop or alter a single column.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Character set
--
-- Every CREATE TABLE above already ends in
-- `DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`, so the tables are
-- correct as generated and no per-table CONVERT is needed -- running one would
-- be a no-op that rewrites every table for nothing.
--
-- What is NOT yet guaranteed is the DATABASE default, which is what a table
-- created outside Prisma would inherit (a manual CREATE TABLE, a future tool,
-- an ad-hoc temp table). Aligning it closes that gap.
--
-- NOTE, deliberate deviation from the plan in schema.prisma: that comment said
-- `COLLATE utf8mb4_0900_ai_ci`. Using it here would set the database default to
-- a DIFFERENT collation from every table Prisma creates, which is precisely the
-- "Illegal mix of collations" trap docker-compose.yml calls out. The collation
-- below matches what Prisma emits and what the server is configured with.
--
-- The database name is omitted on purpose: `ALTER DATABASE` then applies to the
-- connection's current schema, so this statement is correct for `marketplace`,
-- for `marketplace_shadow` during migrate's replay, and for any other
-- environment, without hardcoding a name.
ALTER DATABASE CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- CHECK constraints (enforced by MySQL 8.0.16+; this server is 8.4)
--
-- These encode money and quantity invariants in the database, so a bug in the
-- checkout path cannot persist a negative total or a line total that disagrees
-- with its own arithmetic. Every column referenced is DECIMAL(18,4) or INTEGER,
-- so the comparisons are exact -- there is no floating point anywhere in them.
-- ---------------------------------------------------------------------------

-- order_items: a line must be a real, non-negative, self-consistent line.
ALTER TABLE `order_items` ADD CONSTRAINT `chk_oi_qty_positive`
  CHECK (`quantity` > 0);

ALTER TABLE `order_items` ADD CONSTRAINT `chk_oi_unit_price_nonneg`
  CHECK (`unitPrice` >= 0);

-- DECIMAL * INTEGER is exact decimal arithmetic in MySQL, so equality here is
-- safe; the same test against a FLOAT column would be a latent bug.
ALTER TABLE `order_items` ADD CONSTRAINT `chk_oi_line_total`
  CHECK (`lineTotal` = `unitPrice` * `quantity`);

-- orders: the grand total must equal its parts, and nothing may go negative.
ALTER TABLE `orders` ADD CONSTRAINT `chk_o_totals`
  CHECK (`grandTotal` = `subtotal` + `shippingTotal` + `taxTotal`);

ALTER TABLE `orders` ADD CONSTRAINT `chk_o_amounts_nonneg`
  CHECK (`subtotal` >= 0 AND `shippingTotal` >= 0 AND `taxTotal` >= 0 AND `grandTotal` >= 0);

-- product_variants: catalog data arrives from Shopify, so this is a guard
-- against a bad sync payload rather than against our own code.
ALTER TABLE `product_variants` ADD CONSTRAINT `chk_pv_price_nonneg`
  CHECK (`price` >= 0);

-- Shopify permits negative inventory (oversell); the bound only rejects values
-- that could only come from a corrupt payload or an overflow.
ALTER TABLE `product_variants` ADD CONSTRAINT `chk_pv_inventory_sane`
  CHECK (`inventoryQuantity` >= -1000000);
