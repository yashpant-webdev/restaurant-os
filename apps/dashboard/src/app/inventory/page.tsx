import { Planned } from '@/components/Planned';

export default function Page() {
  return (
    <Planned
      title="Inventory & recipes"
      intro="Every sale deducts ingredients automatically; you see stock, value and variance in rupees."
      features={[
        'Raw materials with units, reorder levels, shelf life',
        'Multi-stage recipes (e.g. gravy base used in 5 dishes)',
        'Automatic stock deduction from every bill',
        'Stock health grid: healthy / below reorder / out of stock',
        'Dish auto sold-out when an ingredient runs out',
        'Vendors, purchase orders, goods received (GRN) with rejects',
        'Wastage with reasons and photos',
        'Daily closing count and stock audits',
        'Variance: expected vs actual usage, in ₹ (theft / over-portioning)',
        'Batches, expiry alerts, FIFO',
      ]}
    />
  );
}
