CREATE TABLE "QuotaWindow" (
    "key" VARCHAR(200) NOT NULL,
    "windowStart" TIMESTAMPTZ(3) NOT NULL,
    "count" INTEGER NOT NULL,
    CONSTRAINT "QuotaWindow_pkey" PRIMARY KEY ("key", "windowStart")
);
