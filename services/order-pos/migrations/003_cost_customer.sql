-- Food cost per dish (for menu engineering and P&L) and the customer on an order (for CRM).

ALTER TABLE menu_items
  ADD COLUMN cost_paise bigint CHECK (cost_paise >= 0),
  ADD COLUMN category text CHECK (length(category) <= 40);

ALTER TABLE order_lines ADD COLUMN unit_cost_paise bigint;

-- Indian mobile number only; marketing needs explicit consent (DPDP Act 2023).
ALTER TABLE orders
  ADD COLUMN customer_phone text CHECK (customer_phone ~ '^[6-9][0-9]{9}$'),
  ADD COLUMN customer_name text CHECK (length(customer_name) <= 80),
  ADD COLUMN marketing_consent boolean NOT NULL DEFAULT false;
