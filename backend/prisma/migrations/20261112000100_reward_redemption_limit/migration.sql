ALTER TABLE "reward_items"
ADD COLUMN "redemptionLimit" INTEGER;

ALTER TABLE "reward_items"
ADD CONSTRAINT "reward_items_redemptionLimit_check"
CHECK ("redemptionLimit" IS NULL OR "redemptionLimit" > 0);

CREATE INDEX "user_vouchers_promotionId_usedAt_idx"
ON "user_vouchers"("promotionId", "usedAt");
