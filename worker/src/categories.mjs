// D7's 21 Odoo expense categories, in D7's order. This list lives exactly once:
// both GET /categories and the unknown-category refusal read it, so the list the
// page is offered and the list the save rule accepts cannot drift.
// Pure: knows nothing of HTTP or D1.

export const CATEGORIES = Object.freeze([
  'Advertising & Marketing',
  'Communication',
  'Electricity',
  'Fuel / Petrol',
  'Gate Pass (Boat Delivery)',
  'Gifts',
  'Internet',
  'Meals',
  'Medical Checkup (Visa)',
  'Salary',
  'Shop Maintenance & Repairs',
  'Shop Rent',
  'Software Subscriptions',
  'Staff Accommodation Rent',
  'Stationery & Packing Supplies',
  'Travel & Accommodation',
  'Vehicle Maintenance',
  'Visa & Work Permit',
  'Warehouse Rent',
  'Waste Disposal',
  'Water'
]);

/** True iff `name` is one of D7's 21 categories. */
export function isKnownCategory(name) {
  return typeof name === 'string' && CATEGORIES.includes(name);
}

/** The 21 names as a fresh array, in D7's order. */
export function listCategories() {
  return CATEGORIES.slice();
}
