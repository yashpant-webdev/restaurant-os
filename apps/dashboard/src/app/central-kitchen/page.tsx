import { Planned } from '@/components/Planned';

export default function Page() {
  return (
    <Planned
      title="Central kitchen"
      intro="One kitchen supplies many outlets: requests, production, dispatch, receipt and returns."
      features={[
        'Outlet indents (requests), auto-suggested from par levels',
        'Approve quantities across all outlets',
        'Production plan for semi-finished items',
        'Dispatch with transfer note, vehicle and e-way bill',
        'Consolidated delivery routes',
        'Outlet receives with received / damaged quantities',
        'Return damaged stock to source',
        'Transfer pricing into each outlet’s food cost',
        'Stock transfers between outlets',
      ]}
    />
  );
}
