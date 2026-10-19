# User flows

Our own design. Petpooja's screens are not public, so these follow standard Indian restaurant practice and the behaviour Petpooja documents publicly (user rights, day end, KOT/cancel/split rules, online-order statuses).

## A. Cashier app (Flutter, Android first)

### Screen map
```
Device setup (once) ─► PIN login ─► Shift start ─► HOME
HOME (tabs):  Tables │ Takeaway │ Delivery │ Online orders │ More (reports, cash, settings, sync)
Order screen:  [Categories] [Items grid + search/short code] [Cart: items, KOT, discount, bill, settle]
```

### A1. First-time device setup
1. Owner opens the app and scans a **pairing QR** shown in the dashboard (Outlet → Devices → Add device).
2. The device registers: name ("Counter 1"), outlet, invoice series (`C1-`), printers.
3. The app downloads the menu, tables, staff PINs (hashed), taxes and settings, then works offline.

### A2. Login and shift
1. Staff pick their name and enter a **4-digit PIN** (works offline; PINs are hashed on the device).
2. If no shift is open on this device: **Start shift** → enter opening cash float → Start.
3. Rights come from the role (biller, manager, owner). Restricted actions ask for a **manager PIN**.

### A3. Dine-in order
1. **Tables tab**: areas as tabs; tables as tiles coloured by state (free / running / bill printed / paying), showing amount, time and captain.
2. Tap a free table → guests count → order screen.
3. Add items: tap a category, search by name, or type a **short code** and press Enter. Items with variants open a picker (Half/Full); add-on groups enforce min/max; long-press adds a note ("less spicy", "Jain").
4. **KOT** → prints at each item's kitchen station (or goes to the KDS). The order stays open; the table turns "running".
5. Later rounds: open the table, add items → **KOT** again (KOT #2). Reducing or removing an item already sent needs a reason and prints a **cancel KOT**.

### A4. Bill and settle
1. **Bill** → bill preview: items, discounts, charges (service / packing), taxes, round-off, total.
2. **Discount** (optional): % or ₹ on the bill or an item, or a coupon code; choose a reason. Above the user's limit, a manager approves with their PIN.
3. **Print bill** → table turns "bill printed". Reprints are logged.
4. **Settle** → choose a tender: Cash (enter amount received, app shows change), UPI (dynamic QR on the customer display or the printed bill), Card (manual or EDC), Due (pick or create a credit customer), Complimentary (manager PIN + reason). Split tender: add several payments until the balance is ₹0.
5. Optional: add the customer's phone number → e-bill on WhatsApp, loyalty points.
6. Settled → invoice number assigned, table frees, drawer opens for cash.

### A5. Split, merge, move
- **Split**: equal parts / by item / by amount → separate bills, each settled on its own.
- **Move table**: running table → Move → pick a free table (prints a transfer KOT for the kitchen).
- **Merge**: select two running tables → Merge → one bill.

### A6. Takeaway and delivery
1. Takeaway tab → New → items → **KOT + bill** in one tap (QSR mode), token number printed.
2. Delivery → customer phone (finds address) → items → delivery charge → KOT → settle on delivery or prepaid.

### A7. Online orders
1. New Swiggy/Zomato/ONDC/website orders ring and appear in the **Online orders** tab with a countdown.
2. **Accept** (set prep time) or **Reject** (reason). Auto-accept if configured.
3. KOT prints automatically → **Food ready** → **Picked up** (rider OTP). The status goes back to the platform.
4. Store on/off and item on/off are available here (reason + reopen time).

### A8. Cash and day end
1. **Pay-in / Pay-out** (petty expenses with reason, e.g. "milk ₹200").
2. **Close shift**: count cash by denomination → the app shows expected vs counted vs difference → close → shift report prints. The next biller opens their shift (handover).
3. **Day end** (manager): all shifts closed and no running tables (or carried forward) → Z-report (sales, tenders, discounts, voids, taxes) → day locked.

### A9. Offline behaviour
- A banner shows "Offline — N changes waiting to sync"; billing never stops.
- Invoices use the device's own series, so numbers stay gapless.
- UPI QR needs internet; offline the cashier can take cash/card, or a static QR verified later.
- On reconnect: push local changes → pull menu/table updates. Conflicts (e.g. a table opened on two devices) are shown to the manager.

## B. Captain mode (same Flutter app)
1. PIN login → Tables (own tables outlined) → open a table → guests → items → **Send KOT**.
2. Add rounds, add the guest's phone, **Request bill** (the cashier is notified live).
3. Phase 2: print or settle at the table (UPI QR / card tap) if the captain has the right.

## C. Kitchen display mode
1. Pick a station (or all).
2. New tickets appear with a timer; colour turns amber after N minutes, red after M.
3. Tap item → **Ready**; tap ticket → **All ready** (the captain and cashier see it; online orders go to "Food ready").
4. Long-press an item → **Sold out** (hidden on POS, captain and online menus until restocked).

## D. Central dashboard (Next.js web)

### Navigation
```
Overview │ Outlets │ Menu │ Floor & devices │ Staff & roles │ Inventory │ Central kitchen │ Purchase │ Customers │ Online │ Reports │ Finance │ Settings
```

### D1. Onboarding
Sign up → organisation → brand → first outlet (GSTIN, FSSAI, address, timings) → add menu (Excel import or manual) → tables → staff with PINs → pair devices (QR) → go live.

### D2. Menu
1. Categories (drag to reorder, timings) → items (short code, price, veg/non-veg, tax profile, kitchen station, image).
2. Variants and add-on groups; combos; prices per area/channel; order-type availability.
3. **Publish** → choose outlets → devices pick up the new menu version (with progress per outlet).

### D3. Floor & devices
Areas → tables (seats, layout drag-and-drop) → printers and kitchen stations → devices (pair, rename, revoke) → invoice series per device.

### D4. Staff & roles
Users with phone + PIN → role per outlet → permission toggles (discount limit %, void, complimentary, after-settlement edit, reports access) → activity log per user.

### D5. Inventory (per store)
1. Raw materials (unit, purchase unit, min/reorder levels, shelf life).
2. Recipes: item/variant/add-on → ingredients with quantities; semi-finished sub-recipes.
3. Stock: live balance and value; ledger per material.
4. Wastage entry; daily closing count; stock audit → variance report (qty and ₹) → approve adjustments.

### D6. Purchase
Vendors (GSTIN, terms, rate card) → purchase order (suggested from reorder levels) → send (WhatsApp/email PDF) → **receive** (GRN: quantities, rejects, batch, expiry, invoice no.) → purchase bill → payment.

### D7. Central kitchen
1. Outlet store manager raises an **indent** (or it is auto-suggested from par levels).
2. Central kitchen sees all indents → approves quantities → **production** plan for semi-finished items → **dispatch** (transfer note, vehicle, e-way bill, route).
3. Outlet **receives** → enters received/damaged quantities → variance goes back to the central kitchen → damaged stock is returned to source.
4. Transfer pricing feeds each outlet's food cost.

### D8. Customers, online, reports, finance
- Customers: list, profile, segments, loyalty settings, campaigns, feedback.
- Online: channel connections, item mapping, store timings, payout uploads → reconciliation.
- Reports: the owner analytics (✅ built) plus standard reports with export.
- Finance: P&L ✅, expenses ✅, ledger, payables, bank reconciliation, GST returns.
