ALTER TABLE "orders" ADD COLUMN "compensationSourceId" TEXT;

CREATE TABLE "order_compensations" (
  "originalOrderId" TEXT NOT NULL PRIMARY KEY REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "amount" INTEGER NOT NULL CHECK ("amount" >= 0)
);

ALTER TABLE "orders" ADD CONSTRAINT "orders_compensationSourceId_fkey"
  FOREIGN KEY ("compensationSourceId") REFERENCES "order_compensations"("originalOrderId") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "orders_compensationSourceId_idx" ON "orders"("compensationSourceId");

CREATE TABLE "compensation_payos_links" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "orderId" TEXT NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "orderCode" INTEGER NOT NULL,
  "qrCodeUrl" TEXT NOT NULL,
  "checkoutUrl" TEXT NOT NULL
);
CREATE UNIQUE INDEX "compensation_payos_links_orderId_key" ON "compensation_payos_links"("orderId");
CREATE UNIQUE INDEX "compensation_payos_links_orderCode_key" ON "compensation_payos_links"("orderCode");

CREATE TABLE "order_notifications" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "orderId" TEXT NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "status" "OrderStatus" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "readAt" TIMESTAMP(3)
);
CREATE INDEX "order_notifications_orderId_createdAt_idx" ON "order_notifications"("orderId", "createdAt");
