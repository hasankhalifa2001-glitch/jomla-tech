/**
 * lib/config/retailer-signal-labels.ts
 *
 * T5a creates this file but shows the signal to NOBODY (the public storefront
 * never renders it). T5b imports these strings for the admin order queue and
 * detail view. They exist here so the wording is defined once and is never
 * relabeled as trusted/verified elsewhere: the signal is behavioral (an order
 * from this phone was accepted before), NOT proof of identity (D14).
 *
 * No screen may hardcode this wording or use "موثوق" / "موثّق".
 */

/** Badge shown when the phone exists in VerifiedRetailer (yes state). */
export const PRIOR_APPROVAL_BADGE_LABEL = "رقم سبق قبول طلب منه";

/** Shown when the phone is NOT in VerifiedRetailer (no state). */
export const NO_PRIOR_APPROVAL_LABEL = "لم يسبق قبول طلب من هذا الرقم";

/** Fixed warning line, always rendered directly beneath the badge/label, in BOTH states. */
export const RETAILER_SIGNAL_WARNING =
    "الرقم غير مُتحقَّق منه، تأكد من هوية التاجر قبل الموافقة.";