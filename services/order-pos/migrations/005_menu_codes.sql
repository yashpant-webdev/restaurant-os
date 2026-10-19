-- Fast billing: short codes ("CB" = Chicken Biryani) and a sold-out switch the cashier can flip ("86").
ALTER TABLE menu_items
  ADD COLUMN short_code text CHECK (short_code ~ '^[A-Z0-9]{1,8}$'),
  ADD COLUMN is_available boolean NOT NULL DEFAULT true,
  ADD COLUMN food_type text NOT NULL DEFAULT 'VEG' CHECK (food_type IN ('VEG','NON_VEG','EGG')),
  ADD COLUMN sort_order integer NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX menu_items_short_code_uq ON menu_items (tenant_id, outlet_id, short_code) WHERE is_active AND short_code IS NOT NULL;
