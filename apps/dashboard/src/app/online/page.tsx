import { Planned } from '@/components/Planned';

export default function Page() {
  return (
    <Planned
      title="Online orders"
      intro="Swiggy, Zomato, ONDC and your own website in one inbox on the cashier app."
      features={[
        'Accept / reject with reason, auto-accept window',
        'Food ready → picked up (rider OTP) → delivered',
        'Store on/off with reason and reopen time',
        'Item on/off across all channels in one tap',
        'Channel prices and item mapping',
        'Payout reconciliation: commission, GST, TCS/TDS, ads, penalties',
        'Matched / missing / mismatched orders, dispute tracking',
        'Own website and QR table ordering (commission-free)',
      ]}
    />
  );
}
