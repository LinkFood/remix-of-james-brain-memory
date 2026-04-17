-- Allow entry_price null for manually-committed trades where the fill will
-- be set at the next book-manager tick. Book-manager already handles
-- planned→open transition that fills entry_price from current market.
SET search_path = public, extensions;

ALTER TABLE ct_trades ALTER COLUMN entry_price DROP NOT NULL;
