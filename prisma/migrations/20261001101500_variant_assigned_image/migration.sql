-- Variant-specific images.
--
-- A variant references one of its product's existing `product_images` rows
-- rather than carrying a copy of the URL: Shopify assigns variant media from the
-- product's own media set, so the id resolves locally and there is one place to
-- update when a URL changes.
--
-- NULL means "no image assigned", which is the common case (11 of 19 variants in
-- the current catalog) and is what makes the storefront fall back to the product
-- image.
--
-- ON DELETE SET NULL, deliberately: the image reconcile hard-deletes images
-- Shopify no longer reports. RESTRICT would make a variant reference block that
-- delete; CASCADE would delete the variant -- and a variant is referenced by
-- order history. Clearing the reference degrades to the fallback instead.
-- AlterTable
ALTER TABLE `product_variants` ADD COLUMN `imageId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `product_variants_imageId_idx` ON `product_variants`(`imageId`);

-- AddForeignKey
ALTER TABLE `product_variants` ADD CONSTRAINT `product_variants_imageId_fkey` FOREIGN KEY (`imageId`) REFERENCES `product_images`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
