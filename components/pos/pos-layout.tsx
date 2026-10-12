"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useOfflineDbReady, useSessionWithOfflineFallback } from "@/lib/offline/hooks";
import { useExchangeRateStore } from "@/lib/store/useExchangeRateStore";
import {
  getOfflineProducts,
  submitOfflineSale,
  syncProductsFromServer,
  calculateCartTotals,
  getSystemCashCustomer,
  isSystemCashCustomer,
  resolveCartLinePrices,
  cartNeedsExchangeRate,
  useSyncWorker,
  // [camera + hardware barcode scanning] Re-exported via lib/offline/index.ts's
  // `export * from "./barcode-lookup"` — imported from the barrel like
  // everything else in this block.
  findProductUnitByBarcode,
  type PosProductItem,
  type CachedProductUnit,
  type CartLineItem,
  type SelectedCustomer,
  type OfflineInvoice,
  type PaymentMethod,
} from "@/lib/offline";
import { BarcodeScannerModal } from "@/components/inventory/BarcodeScannerModal";
import { ProductCatalog, ProductSearchBar } from "./product-catalog";
import { CartPanel } from "./cart-panel";
import { WalkInCustomerModal } from "./walk-in-customer-modal";
import { PaymentModal } from "./payment-modal";
import { CheckoutSuccessModal } from "./checkout-success-modal";
import { Money } from "./money";
// [v4.1 — T4d] The OFFLINE void entry point. Deliberately a separate surface
// from T4c2's online void flow: it reads only local Dexie data and calls
// only the local submitOfflineVoid() service — never the server-side ledger
// void endpoint T4c2 itself uses.
import { OfflineVoidPanel } from "./offline-void-panel";
// [T4f — Rule 4] The per-DEVICE thermal printer settings control. On the POS
// screen rather than under /settings/**, which is ADMIN-gated — printing is a
// CASHIER activity, so a cashier on a fresh device must be able to configure
// its printer without an admin present.
import { PrinterSettingsPopover } from "./printer-settings-popover";
import { useCustomerCacheSync } from "@/lib/offline/customer-sync";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import {
  RefreshCw,
  CloudOff,
  AlertTriangle,
  ShoppingCart,
  ChevronUp,
  ScanLine,
  PackageSearch,
  Minus,
  X,
  Undo2,
} from "lucide-react";
import { toast } from "sonner";
import { compareMoney } from "@/lib/utils/money";
import { cn } from "@/lib/utils";
import { fmtInt, fmtMoney } from "@/lib/utils/digits";

/** Where a barcode came from: the camera dialog, or a keyboard-wedge scanner. */
type ScanSource = "camera" | "keyboard";

/** What the camera dialog shows after each scan (instead of a toast over the video). */
interface ScanBanner {
  kind: "ok" | "error" | "info";
  text: string;
  /** The cart line a successful scan landed on — its LIVE quantity is shown. */
  cartId?: string;
  /** Changes on every scan so the banner re-mounts (and re-animates). */
  nonce: number;
}

type AddToCartResult = { ok: true; cartId: string } | { ok: false; message: string };

// ---------------------------------------------------------------------------
// [UX] Audible + haptic confirmation for each scan. The cashier is looking at
// the product, not the screen: a short high beep = added, a low buzz = rejected.
// The AudioContext is created lazily (the scanner is opened by a tap, which is
// the user gesture browsers require) and every call is wrapped so a device
// without audio/vibration support simply stays silent.
// ---------------------------------------------------------------------------
let scanAudioCtx: AudioContext | null = null;

function playScanFeedback(kind: "ok" | "error") {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(kind === "ok" ? 30 : [60, 40, 60]);
    }

    const Ctx =
      typeof window !== "undefined"
        ? window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        : undefined;
    if (!Ctx) return;
    if (!scanAudioCtx) scanAudioCtx = new Ctx();
    const ctx = scanAudioCtx;
    if (ctx.state === "suspended") void ctx.resume();

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = kind === "ok" ? "sine" : "sawtooth";
    osc.frequency.value = kind === "ok" ? 880 : 200;
    const duration = kind === "ok" ? 0.09 : 0.22;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration + 0.02);
  } catch {
    /* feedback is best-effort — never let it break a scan */
  }
}

/**
 * [UX] The live panel under the camera video while a scan session is running:
 * the result of the LAST scan (with the line's current quantity), the most
 * recent cart lines with − / × so a wrong scan can be fixed WITHOUT closing the
 * scanner, the running total, and an undo button.
 */
function ScanSessionPanel({
  banner,
  bannerQty,
  items,
  totalLabel,
  canUndo,
  onUndo,
  onDecrement,
  onRemove,
}: {
  banner: ScanBanner | null;
  bannerQty: number | null;
  items: CartLineItem[];
  totalLabel: string;
  canUndo: boolean;
  onUndo: () => void;
  onDecrement: (cartId: string) => void;
  onRemove: (cartId: string) => void;
}) {
  const recent = [...items].reverse().slice(0, 3);
  const hiddenCount = items.length - recent.length;

  return (
    <div className="mt-3 space-y-2.5" dir="rtl">
      {banner ? (
        <div
          key={banner.nonce}
          aria-live="polite"
          className={cn(
            "flex animate-in items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-sm font-bold duration-150 fade-in zoom-in-95 motion-reduce:animate-none",
            banner.kind === "ok" && "border-emerald-200 bg-emerald-50 text-emerald-900",
            banner.kind === "error" && "border-red-200 bg-red-50 text-red-800",
            banner.kind === "info" && "border-slate-200 bg-slate-50 text-slate-700"
          )}
        >
          <span className="min-w-0 truncate">
            {banner.kind === "ok" ? "✓ " : banner.kind === "error" ? "✕ " : ""}
            {banner.text}
          </span>
          {banner.kind === "ok" && bannerQty !== null && (
            <span
              dir="ltr"
              className="shrink-0 rounded-full bg-emerald-600 px-2.5 py-0.5 text-xs font-extrabold tabular-nums text-white"
            >
              × {fmtInt(bannerQty)}
            </span>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-slate-200 px-3 py-2.5 text-center text-xs text-slate-500">
          وجّه الكاميرا نحو الباركود — كل مسحة بتنضاف للسلة مباشرة.
        </div>
      )}

      {recent.length > 0 && (
        <div className="space-y-1.5">
          {recent.map((item) => (
            <div
              key={item.id}
              className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold text-slate-900">{item.product.name}</p>
                <p className="text-[11px] text-slate-500">{item.unitName}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => onDecrement(item.id)}
                  aria-label="إنقاص الكمية"
                  className="size-9 border-slate-200"
                >
                  <Minus className="size-4" />
                </Button>
                <span dir="ltr" className="min-w-8 text-center text-sm font-extrabold tabular-nums">
                  {fmtInt(item.quantity)}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => onRemove(item.id)}
                  aria-label="حذف الصنف من السلة"
                  className="size-9 text-red-600 hover:bg-red-50 hover:text-red-700"
                >
                  <X className="size-4" />
                </Button>
              </div>
            </div>
          ))}
          {hiddenCount > 0 && (
            <p className="text-center text-[11px] text-slate-500">
              و {fmtInt(hiddenCount)} {hiddenCount === 1 ? "صنف" : "أصناف"} تانية بالسلة
            </p>
          )}
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-slate-600">
          {fmtInt(items.length)} أصناف · <span className="font-extrabold text-slate-900">{totalLabel}</span>
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!canUndo}
          onClick={onUndo}
          className="h-9 gap-1.5 border-slate-200 text-xs font-semibold"
        >
          <Undo2 className="size-3.5" />
          تراجع عن آخر مسحة
        </Button>
      </div>
    </div>
  );
}

export function PosLayout() {
  const { data: session } = useSessionWithOfflineFallback();
  const tenantId = session?.tenantId;

  // [FIX — empty-cache deadlock] `isReady` requires products AND customers
  // AND an exchange rate to ALL be cached (lib/offline/hooks.ts), which is
  // deliberately strict (T4a's contract) and must not change. A brand-new
  // tenant has none of the three, so `isReady` is false until after the
  // very first sync — but every data-loading effect below used to be
  // gated on `isReady`, so the catalog spun forever and the effect that
  // performs that first sync (1d) could never run: the cache could never
  // populate itself. The effects below are therefore gated on `isDbOpen`
  // ("Dexie is open and queryable", true even when every table is empty)
  // instead. `isDbReady` is kept ONLY for the status dot's colour.
  const { isReady: isDbReady, isDbOpen, status: dbStatus } = useOfflineDbReady(tenantId);
  const dailyExchangeRate = useExchangeRateStore((state) => state.dailyExchangeRate);
  const hydrateExchangeRate = useExchangeRateStore((state) => state.hydrateFromCache);

  // [FIX] This hook was previously never mounted anywhere in the POS
  // screen at all — sync-worker.ts's reactive auto-sync logic (fires a
  // debounced sync attempt whenever a Dexie write moves pendingCount from
  // 0 to a positive number) therefore never actually ran during a normal
  // POS session. `pendingCount` below is the single, live source of
  // truth for the "بانتظار المزامنة" badge.
  const { pendingCount: pendingInvoicesCount, triggerSync } = useSyncWorker(tenantId);
  // [v4.2] T4e Addendum: Evicts merged duplicate customers from cachedCustomers across tabs
  useCustomerCacheSync(tenantId);

  // Data states
  const [products, setProducts] = useState<PosProductItem[]>([]);
  const [isLoadingProducts, setIsLoadingProducts] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [isSyncingProducts, setIsSyncingProducts] = useState(false);

  // Cart & Customer states
  const [cartItems, setCartItems] = useState<CartLineItem[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<SelectedCustomer | null>(null);

  // Modals & Mobile Drawer states
  const [isMobileCartOpen, setIsMobileCartOpen] = useState(false);
  const [isCustomerModalOpen, setIsCustomerModalOpen] = useState(false);
  const [isPaymentModalOpen, setIsPaymentModalOpen] = useState(false);
  const [isSuccessModalOpen, setIsSuccessModalOpen] = useState(false);
  /**
   * [T4f] Printer-settings popover visibility, owned here because BOTH the top
   * bar's trigger and a failed thermal print (from any ReceiptActions on this
   * screen) need to open it — see onPrinterSetupRequired below.
   */
  const [printerSettingsOpen, setPrinterSettingsOpen] = useState(false);
  const [completedInvoice, setCompletedInvoice] = useState<OfflineInvoice | null>(null);
  const [completedCustomer, setCompletedCustomer] = useState<SelectedCustomer | null>(null);
  const [completedItems, setCompletedItems] = useState<CartLineItem[]>([]);
  const [allowSystemCustomer, setAllowSystemCustomer] = useState(true);
  const [reopenPaymentAfterCustomer, setReopenPaymentAfterCustomer] = useState(false);
  // Camera barcode scanner modal open/close state.
  const [barcodeScannerOpen, setBarcodeScannerOpen] = useState(false);
  // [UX] State of the CURRENT camera scan session: the banner for the last scan,
  // and the cart-line ids added by camera scans (newest last) so "undo last
  // scan" knows what to take back. Both reset every time the scanner opens.
  const [scanBanner, setScanBanner] = useState<ScanBanner | null>(null);
  const [scanStack, setScanStack] = useState<string[]>([]);

  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // [FIX — race condition] Monotonically increasing request id, checked
  // against the id captured at request time before writing a product-search
  // response into state. A slower response for an earlier keystroke could
  // otherwise resolve AFTER a faster response for a later keystroke and
  // silently overwrite it.
  const productsRequestIdRef = useRef(0);

  // 1a. Exchange rate — loads once per tenant/DB-open change.
  // Deliberately does NOT depend on searchQuery.
  useEffect(() => {
    if (!isDbOpen) return;
    let isMounted = true;

    hydrateExchangeRate(tenantId).catch((err) => {
      if (isMounted) {
        console.error("Failed to load exchange rate:", err);
      }
    });

    return () => {
      isMounted = false;
    };
  }, [isDbOpen, hydrateExchangeRate, tenantId]);

  // 1b. Default system cash customer — also independent of searchQuery.
  // `prev ?? system` preserves whatever the cashier has already actively
  // selected (including mid-search) instead of clobbering it every time
  // this effect re-runs.
  useEffect(() => {
    if (!isDbOpen) return;
    let isMounted = true;

    getSystemCashCustomer(tenantId).then((system) => {
      if (isMounted && system) {
        setSelectedCustomer((prev) => prev ?? system);
      }
    });

    return () => {
      isMounted = false;
    };
  }, [isDbOpen, tenantId]);

  // 1c. Product catalog / search — the SINGLE source of truth for
  // `products` and `isLoadingProducts`. Runs as soon as Dexie is open, so
  // an EMPTY cache resolves to "loaded, zero products" (clearing the
  // spinner) rather than waiting for a full cache that can only be filled
  // by the sync in effect 1d.
  useEffect(() => {
    if (!isDbOpen) return;

    const requestId = ++productsRequestIdRef.current;

    // [FIX — React "setState synchronously within an effect" warning]
    // setState calls live inside an inner async function instead of the
    // effect body's first statement.
    async function run() {
      setIsLoadingProducts(true);
      try {
        const prods = await getOfflineProducts(tenantId, searchQuery);
        // Only the most recently issued request is allowed to write to
        // state — an older, slower-resolving request for a previous
        // keystroke is discarded here even if it resolves later.
        if (productsRequestIdRef.current === requestId) {
          setProducts(prods);
        }
      } catch (err) {
        if (productsRequestIdRef.current === requestId) {
          console.error("Failed to load POS products:", err);
        }
      } finally {
        if (productsRequestIdRef.current === requestId) {
          setIsLoadingProducts(false);
        }
      }
    }

    void run();
  }, [isDbOpen, searchQuery, tenantId]);

  // 1d. Opportunistic initial product sync from the server (Postgres ->
  // Dexie). Fires once per tenant/DB-open change, independent of
  // searchQuery. [FIX] Gated on `isDbOpen`, NOT `isDbReady`: on a
  // brand-new tenant the cache is empty so `isDbReady` is false — gating
  // this on it meant an empty cache could never populate itself.
  //
  // Deliberately silent on failure (offline, fetch error): this must never
  // block or interrupt a cashier who may be legitimately offline and
  // relying on whatever was cached during the last successful sync. The
  // manual "مزامنة الأصناف" button / empty-state banner below is the path
  // that surfaces those to the user instead.
  useEffect(() => {
    if (!isDbOpen || !tenantId) return;
    let isMounted = true;

    syncProductsFromServer(tenantId).then((result) => {
      if (!isMounted || !result.success) return;
      // Re-run the same read the search effect (1c) uses, so newly-synced
      // products appear immediately without requiring the cashier to
      // retype their search query.
      getOfflineProducts(tenantId, searchQuery).then((prods) => {
        if (isMounted) setProducts(prods);
      });
    });

    return () => {
      isMounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDbOpen, tenantId]);

  // Cart Totals calculation strictly through decimal.js
  const cartTotals = useMemo(() => {
    return calculateCartTotals(cartItems, dailyExchangeRate);
  }, [cartItems, dailyExchangeRate]);

  // cart line id → quantity, so each unit button in the catalog can show how
  // many of it are already in the cart. (Line ids are `${product.id}-${unit.id}`.)
  const cartQuantities = useMemo(() => {
    const map: Record<string, number> = {};
    for (const item of cartItems) map[item.id] = item.quantity;
    return map;
  }, [cartItems]);

  // [T4b] True only when at least one cart line is USD-priced — the only
  // case where checkout legitimately requires a cached exchange rate.
  // A SYP-only cart must never be blocked by a missing rate.
  const rateRequired = useMemo(
    () => cartNeedsExchangeRate(cartItems),
    [cartItems]
  );

  const isRateMissing =
    !dailyExchangeRate || compareMoney(dailyExchangeRate, 0) <= 0;

  // [FIX] Explicit "nothing cached yet" state: Dexie is open, the first
  // read finished, no search is active, and there are zero products. This
  // replaces the endless spinner with an actionable message.
  const showEmptyCacheBanner =
    isDbOpen &&
    !isLoadingProducts &&
    products.length === 0 &&
    searchQuery.trim() === "";

  // [UX] The quantity shown on the scan banner is read LIVE from the cart, so
  // scanning the same product again visibly turns "× 1" into "× 2".
  const scanBannerQty = scanBanner?.cartId
    ? (cartItems.find((item) => item.id === scanBanner.cartId)?.quantity ?? null)
    : null;

  // Local-database status: a small dot on the sync button (colour) + its tooltip.
  const dbDotClass = isDbReady
    ? "bg-emerald-500"
    : dbStatus === "NO_CACHED_DATA" || dbStatus === "PARTIAL"
      ? "bg-amber-500"
      : "bg-slate-300 animate-pulse";
  const dbStatusText = isDbReady
    ? "قاعدة البيانات المحلية جاهزة"
    : dbStatus === "NO_CACHED_DATA"
      ? "لا توجد بيانات مخزنة محلياً بعد — يرجى الاتصال بالإنترنت للمزامنة"
      : dbStatus === "PARTIAL"
        ? "بعض البيانات المحلية غير مكتملة بعد (مثل سعر الصرف أو الزبائن)"
        : "جاري تهيئة قاعدة البيانات...";

  // 2. Keyboard Shortcuts (F2: Search, F4: Customer, F9: Checkout, Esc: Close)
  useEffect(() => {
    function handleGlobalKeyDown(e: KeyboardEvent) {
      if (isCustomerModalOpen || isPaymentModalOpen || isSuccessModalOpen) {
        if (e.key === "Escape") {
          setIsCustomerModalOpen(false);
          setIsPaymentModalOpen(false);
          setIsSuccessModalOpen(false);
        }
        return;
      }

      if (e.key === "F2") {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      } else if (e.key === "F4") {
        e.preventDefault();
        setIsCustomerModalOpen(true);
      } else if (e.key === "F9") {
        e.preventDefault();
        if (cartItems.length > 0) {
          // [T4b] Only block checkout for a missing rate when the cart
          // actually contains USD-priced items. A SYP-only cart checks
          // out with no rate at all.
          const needsRate = cartNeedsExchangeRate(cartItems);
          if (needsRate && (!dailyExchangeRate || compareMoney(dailyExchangeRate, 0) <= 0)) {
            toast.error(
              "لا يمكن إتمام البيع: يوجد في السلة صنف مسعّر بالدولار ولا يوجد سعر صرف يومي محفوظ."
            );
          } else {
            setIsPaymentModalOpen(true);
          }
        }
      }
    }

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [cartItems, cartItems.length, dailyExchangeRate, isCustomerModalOpen, isPaymentModalOpen, isSuccessModalOpen]);

  // 3. Cart Management Operations
  //
  // [v3.6] FIX — this handler previously only captured `unitPriceUSD` from
  // resolveCartLinePrices() and never stored `unitPriceSYP` on the cart
  // line at all, even though CartLineItem (pos-service.ts) has required
  // `unitPriceSYP: string` since the v3.6 re-anchoring. Both prices (SYP
  // authoritative, USD derived/nullable) are now captured and stored,
  // matching resolveCartLinePrices()'s real return shape.
  //
  // [UX] RETURNS the outcome, and takes `silent` for the camera scanner:
  // while scanning, toasts would pile up on top of the video, so the camera
  // path reports through its own banner instead. Every other caller (the
  // catalog's add buttons, the hardware scanner) keeps the toasts as before.
  function handleAddToCart(
    product: PosProductItem,
    unit: CachedProductUnit,
    opts: { silent?: boolean } = {}
  ): AddToCartResult {
    const fail = (message: string): AddToCartResult => {
      if (!opts.silent) toast.error(message);
      return { ok: false, message };
    };

    if (unit.isActive === false) {
      return fail("لا يمكن بيع وحدة غير نشطة.");
    }
    const cartItemId = `${product.id}-${unit.id}`;

    let unitPriceSYP: string;
    let unitPriceUSD: string | null;
    let pricingCurrency: "USD" | "SYP";
    try {
      const prices = resolveCartLinePrices(unit, product, dailyExchangeRate);
      unitPriceSYP = prices.unitPriceSYP;
      unitPriceUSD = prices.unitPriceUSD;
      pricingCurrency = prices.pricingCurrency;
    } catch (err) {
      return fail(
        err instanceof Error
          ? err.message
          : "لا يمكن إضافة هذا الصنف إلى السلة بدون سعر جملة أو سعر صرف صالح."
      );
    }

    setCartItems((prev) => {
      const existingIndex = prev.findIndex((item) => item.id === cartItemId);
      if (existingIndex > -1) {
        const copy = [...prev];
        copy[existingIndex] = {
          ...copy[existingIndex],
          quantity: copy[existingIndex].quantity + 1,
        };
        return copy;
      }

      const newItem: CartLineItem = {
        id: cartItemId,
        product,
        unitId: unit.id,
        unitName: unit.unitName,
        conversionFactor: unit.conversionFactor,
        quantity: 1,
        unitPriceSYP,
        unitPriceUSD,
        // [T4b] Preserved from resolveCartLinePrices so cartNeedsExchangeRate
        // can inspect items without re-reading the unit from the catalog.
        pricingCurrency,
      };
      return [...prev, newItem];
    });

    if (!opts.silent) {
      toast.success(`تمت إضافة ${product.name} (${unit.unitName}) إلى السلة`, {
        duration: 1200,
      });
    }
    return { ok: true, cartId: cartItemId };
  }

  // [barcode -> cart bridge]
  // The SINGLE resolution path shared by BOTH scan surfaces:
  //   1. The camera scanner (BarcodeScannerModal, mode="continuous" below)
  //   2. The hardware keyboard-wedge scanner (ProductSearchBar's Enter
  //      handler, wired via the onBarcodeEnter prop)
  // Offline-first: tries the full local cache first (findProductUnitByBarcode
  // — NOT the debounced/filtered `products` state) and only reaches for the
  // network as a last resort, and only when actually online. Never blocks or
  // throws while offline.
  //
  // Returns a boolean so the Enter handler can distinguish "this was
  // recognized as a barcode" (found, or found-but-rejected) from "this wasn't
  // a barcode at all" (falls through to plain text-search behavior there).
  //
  // [UX] `source: "camera"` switches the reporting from toasts to the scan
  // banner under the video (see ScanSessionPanel). Both sources get the beep /
  // vibration, so a hardware-scanner cashier also hears success vs. failure.
  const handleBarcodeScan = useCallback(
    async (barcode: string, opts?: { source?: ScanSource }): Promise<boolean> => {
      if (!tenantId) return false;

      const fromCamera = opts?.source === "camera";

      const reject = (text: string) => {
        playScanFeedback("error");
        if (fromCamera) {
          setScanBanner({ kind: "error", text, nonce: Date.now() });
        } else {
          toast.error(text);
        }
      };

      let result = await findProductUnitByBarcode(tenantId, barcode);

      // Fallback: barcode not found locally AND we're online — the product
      // may be genuinely new (created/edited after this device's last
      // sync). One retry after a fresh pull, never more than one, so a
      // legitimately nonexistent barcode still fails fast instead of
      // looping.
      if (
        result.status === "not_found" &&
        typeof navigator !== "undefined" &&
        navigator.onLine
      ) {
        const syncResult = await syncProductsFromServer(tenantId);
        if (syncResult.success) {
          result = await findProductUnitByBarcode(tenantId, barcode);
          // Keep the visible catalog in sync with what was just pulled.
          const prods = await getOfflineProducts(tenantId, searchQuery);
          setProducts(prods);
        }
      }

      if (result.status === "found") {
        const added = handleAddToCart(result.product, result.unit, { silent: fromCamera });
        if (!added.ok) {
          // handleAddToCart already toasted for the non-camera path.
          playScanFeedback("error");
          if (fromCamera) {
            setScanBanner({ kind: "error", text: added.message, nonce: Date.now() });
          }
          return true; // recognized as a real barcode — rejected, not "unmatched text"
        }

        playScanFeedback("ok");
        if (fromCamera) {
          setScanBanner({
            kind: "ok",
            text: `${result.product.name} — ${result.unit.unitName}`,
            cartId: added.cartId,
            nonce: Date.now(),
          });
          setScanStack((prev) => [...prev, added.cartId]);
        }
        return true;
      }

      if (result.status === "unit_inactive") {
        // [FIX — previously silent when matched via the hardware-scanner
        // Enter path] Now a clear Arabic message on every entry point.
        reject(`الصنف "${result.product.name}" (${result.unit.unitName}) غير نشط ولا يمكن بيعه.`);
        return true; // recognized as a real barcode — rejected, not "unmatched text"
      }

      // not_found — offline with no local match, or genuinely nonexistent.
      reject(
        typeof navigator !== "undefined" && navigator.onLine
          ? "الباركود غير مسجّل — لم يتم العثور على منتج مرتبط به."
          : "لم يتم العثور على هذا الباركود محلياً — تحقق من الاتصال بالإنترنت والمزامنة."
      );
      return false;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tenantId, searchQuery, dailyExchangeRate]
  );

  function handleUpdateQuantity(cartId: string, delta: number) {
    setCartItems((prev) =>
      prev
        .map((item) => {
          if (item.id === cartId) {
            const newQty = item.quantity + delta;
            return newQty > 0 ? { ...item, quantity: newQty } : null;
          }
          return item;
        })
        .filter((item): item is CartLineItem => item !== null)
    );
  }

  function handleSetQuantity(cartId: string, quantity: number) {
    setCartItems((prev) =>
      prev.map((item) => (item.id === cartId ? { ...item, quantity } : item))
    );
  }

  // [v3.6] FIX — rebuilds ALL price fields returned by
  // resolveCartLinePrices() on a unit change (previously only
  // `unitPriceUSD` was written, silently dropping `unitPriceSYP`).
  function handleChangeUnit(cartId: string, newUnitId: string) {
    setCartItems((prev) =>
      prev.map((item) => {
        if (item.id === cartId) {
          const selectedUnit = item.product.units?.find((u) => u.id === newUnitId && u.isActive !== false);
          if (selectedUnit) {
            try {
              const prices = resolveCartLinePrices(
                selectedUnit,
                item.product,
                dailyExchangeRate
              );
              return {
                ...item,
                id: `${item.product.id}-${selectedUnit.id}`,
                unitId: selectedUnit.id,
                unitName: selectedUnit.unitName,
                conversionFactor: selectedUnit.conversionFactor,
                unitPriceSYP: prices.unitPriceSYP,
                unitPriceUSD: prices.unitPriceUSD,
                // [T4b] Keep pricingCurrency up to date when the cashier
                // switches a line item to a different unit mid-sale.
                pricingCurrency: prices.pricingCurrency,
              };
            } catch (err) {
              toast.error(
                err instanceof Error
                  ? err.message
                  : "لا يمكن تبديل الوحدة بدون سعر جملة أو سعر صرف صالح."
              );
              return item;
            }
          }
        }
        return item;
      })
    );
  }

  function handleRemoveItem(cartId: string) {
    setCartItems((prev) => prev.filter((item) => item.id !== cartId));
  }

  function handleClearCart() {
    setCartItems([]);
    toast.info("تم إفراغ السلة");
  }

  // [UX] Camera scan session helpers.
  function openBarcodeScanner() {
    setScanBanner(null);
    setScanStack([]);
    setBarcodeScannerOpen(true);
  }

  // Takes back the newest camera scan: one unit off that cart line (the line
  // disappears if that was its only unit). A line already removed by hand is
  // simply a no-op.
  function handleUndoLastScan() {
    const lastCartId = scanStack[scanStack.length - 1];
    if (!lastCartId) return;
    setScanStack((prev) => prev.slice(0, -1));
    handleUpdateQuantity(lastCartId, -1);
    setScanBanner({ kind: "info", text: "تم التراجع عن آخر مسحة", nonce: Date.now() });
  }

  // 4. Offline Checkout Submission
  //
  // [v3.6] Takes paidAmountSYP/debtAmountSYP from the payment step and
  // forwards only the SYP-authoritative fields to submitOfflineSale();
  // USD is derived inside createOfflineInvoiceRecord.
  //
  // [FIX] An explicit triggerSync() right after a successful checkout
  // gives the cashier fast, deterministic feedback instead of depending
  // solely on the hook's own 2-second debounce.
  async function handleConfirmCheckout(paymentData: {
    paidAmountSYP: string;
    debtAmountSYP: string;
    paymentMethod?: PaymentMethod;
  }) {
    // [T4b] If any cart item is priced in USD, a valid dailyExchangeRate is mandatory.
    // [v4.9] For SYP-only carts the rate stays null — USD fields are persisted
    // as null (never a "1.0000" fallback) and omitted from the UI.
    const effectiveRate =
      dailyExchangeRate && compareMoney(dailyExchangeRate, 0) > 0
        ? dailyExchangeRate
        : null;

    if (rateRequired && !effectiveRate) {
      throw new Error("سعر الصرف غير محدد في الذاكرة المحلية (مطلوب للأصناف المسعرة بالدولار).");
    }

    let customer = selectedCustomer;
    if (!customer || isSystemCashCustomer(customer)) {
      customer = isSystemCashCustomer(customer) && customer?.id
        ? customer
        : await getSystemCashCustomer(tenantId);
    }

    const { totalSYP } = calculateCartTotals(cartItems, effectiveRate);

    // Save offline invoice strictly into Dexie
    const savedInvoice = await submitOfflineSale(tenantId, {
      customer,
      items: cartItems,
      totalSYP,
      // [v4.9] effectiveRate is null for SYP-only carts with no cached rate —
      // passed through as null (never serializeMoney(null), never "1.0000").
      exchangeRateUsed: effectiveRate,
      paidAmountSYP: paymentData.paidAmountSYP,
      debtAmountSYP: paymentData.debtAmountSYP,
      paymentMethod: paymentData.paymentMethod,
    });

    // Save state for confirmation modal
    setCompletedInvoice(savedInvoice);
    setCompletedCustomer(customer);
    setCompletedItems([...cartItems]);

    // Clear active cart & customer for next sale
    setCartItems([]);
    setAllowSystemCustomer(true);
    void getSystemCashCustomer(tenantId).then((system) => {
      setSelectedCustomer(system);
    });
    setIsMobileCartOpen(false);

    // Close payment modal and open confirmation
    setIsPaymentModalOpen(false);
    setIsSuccessModalOpen(true);

    // Products still need a manual refresh here (stock display is not
    // covered by any live query) — the pending-invoice COUNT does not,
    // since useSyncWorker's pendingCount updates itself reactively.
    const prods = await getOfflineProducts(tenantId, searchQuery);
    setProducts(prods);

    void triggerSync();

    toast.success("تم حفظ الفاتورة محلياً بنجاح في قاعدة البيانات (Dexie)!");
  }

  function handleStartNewSale() {
    setCartItems([]);
    setAllowSystemCustomer(true);
    setCompletedInvoice(null);
    setCompletedCustomer(null);
    setCompletedItems([]);
    setIsMobileCartOpen(false);
    void getSystemCashCustomer(tenantId).then((system) => {
      setSelectedCustomer(system);
    });
    searchInputRef.current?.focus();
  }

  // Manual product sync (server -> Dexie). Unlike the opportunistic effect
  // above (1d), this surfaces success/failure to the cashier/admin
  // explicitly — meant to be used right after adding/editing a product in
  // Inventory, when the person wants it usable in the POS immediately
  // instead of waiting for the next POS mount.
  async function handleSyncProducts() {
    if (!tenantId) {
      toast.error("لا يمكن مزامنة الأصناف دون تحديد هوية المتجر (تسجيل الدخول مطلوب).");
      return;
    }

    setIsSyncingProducts(true);
    try {
      const result = await syncProductsFromServer(tenantId);
      if (result.success) {
        const prods = await getOfflineProducts(tenantId, searchQuery);
        setProducts(prods);
        setIsLoadingProducts(false);
        toast.success(`تمت مزامنة ${result.count} صنف من السيرفر بنجاح.`);
      } else if (result.reason === "OFFLINE") {
        toast.error("لا يوجد اتصال بالإنترنت — تعذّرت مزامنة الأصناف.");
      } else {
        toast.error("حدث خطأ أثناء مزامنة الأصناف من السيرفر.");
      }
    } finally {
      setIsSyncingProducts(false);
    }
  }

  return (
    <div className="relative flex h-[calc(100dvh-8.5rem)] flex-col gap-3" dir="rtl">
      {/*
        Command bar — ONE row on every screen size:
          [ search / hardware-scanner input ........ ] [scan] [sync] [printer]
        The shortcuts hint strip is gone (F2/F4/F9 are printed on the controls
        they trigger), and the exchange-rate chip is gone while a rate exists —
        the app's top bar already shows it. Only the MISSING-rate warning (and
        pending-sync count) appear, as chips in the row below, when relevant.

        On a phone the scan action is the floating button above the cart bar
        (thumb reach); the labeled scan button here is lg+ only.
      */}
      <div className="flex shrink-0 items-center gap-2">
        <ProductSearchBar
          className="min-w-0 flex-1"
          products={products}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onAddToCart={handleAddToCart}
          searchInputRef={searchInputRef}
          // Hardware keyboard-wedge scanner support — see handleBarcodeScan above.
          onBarcodeEnter={handleBarcodeScan}
        />

        <Button
          type="button"
          variant="outline"
          onClick={openBarcodeScanner}
          title="مسح باركود بالكاميرا وإضافة للسلة مباشرة"
          className="hidden h-11 shrink-0 gap-1.5 rounded-xl border-emerald-200 bg-emerald-50 px-3.5 text-xs font-bold text-emerald-800 shadow-sm hover:bg-emerald-100 hover:text-emerald-900 lg:inline-flex"
        >
          <ScanLine className="size-4 text-emerald-600" aria-hidden />
          مسح باركود
        </Button>

        {/* Sync products — icon-only, labeled from xl. The dot is the local-DB status. */}
        <Button
          type="button"
          variant="outline"
          onClick={handleSyncProducts}
          disabled={isSyncingProducts}
          title={`سحب أحدث الأصناف من السيرفر — ${dbStatusText}`}
          aria-label="مزامنة الأصناف"
          className="relative h-11 min-w-11 shrink-0 gap-1.5 rounded-xl border-slate-200 bg-white px-3 text-xs font-bold text-slate-700 shadow-sm hover:bg-slate-50 hover:text-slate-900"
        >
          <RefreshCw
            className={cn("size-4 text-emerald-600", isSyncingProducts && "animate-spin")}
            aria-hidden
          />
          <span className="hidden xl:inline">{isSyncingProducts ? "جاري المزامنة..." : "مزامنة الأصناف"}</span>
          <span
            className={cn("absolute -inset-e-1 -top-1 size-2.5 rounded-full ring-2 ring-white", dbDotClass)}
            aria-hidden
          />
        </Button>

        {/*
          [T4f — Rule 4] The printer settings control. Deliberately NOT
          role-gated: the printer's dots-per-line is a property of THIS device
          (Dexie's `deviceSettings` table, which stores no tenantId and no
          userId), and a cashier is the person who actually prints.

          Its controlled `open` state lives in this component so a failed
          thermal print can route the user straight here instead of leaving
          them with a toast and no way forward.

          The trigger itself already matches the command bar (44px, rounded-xl,
          label from xl up like the sync button) — see its default classes.
        */}
        <PrinterSettingsPopover open={printerSettingsOpen} onOpenChange={setPrinterSettingsOpen} />
      </div>

      {(pendingInvoicesCount > 0 || isRateMissing) && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {pendingInvoicesCount > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-bold text-amber-800">
              <CloudOff className="size-3.5 text-amber-600" aria-hidden />
              {fmtInt(pendingInvoicesCount)} بانتظار المزامنة
            </span>
          )}
          {isRateMissing && (
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-bold text-amber-800"
              title="البيع بالليرة السورية متاح بدون سعر صرف. السعر مطلوب فقط للأصناف المسعّرة بالدولار."
            >
              <AlertTriangle className="size-3.5 text-amber-600" aria-hidden />
              سعر الصرف غير محدد
            </span>
          )}
        </div>
      )}

      {/*
        [v4.1 — T4d §6.3] Offline void panel.

        Mounted directly under the command bar so it is visible on BOTH the
        mobile and desktop layouts of this screen. It is conditionally
        self-rendering: with zero not-yet-synced local invoices it returns null
        and is genuinely absent from the DOM (see offline-void-panel.tsx).

        `triggerSync` is the ONE instance owned by the useSyncWorker() call at
        the top of this component — passed down instead of mounting a second
        useSyncWorker() inside the panel, which would duplicate that hook's own
        debounced 0->positive scheduling effect.
      */}
      <OfflineVoidPanel
        tenantId={tenantId}
        isAdmin={session?.role === "ADMIN"}
        triggerSync={triggerSync}
      />

      {/*
        [FIX] Explicit "no local data yet" state, replacing the old endless
        spinner. Shown when Dexie is open, the first read has finished, no
        search is active and there are zero cached products — i.e. a brand-new
        tenant (or a device that has never synced). It tells the user exactly
        what to do and offers the sync action directly.
      */}
      {showEmptyCacheBanner && (
        <div className="flex shrink-0 items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-amber-900">
          <div className="flex min-w-0 items-start gap-2.5">
            <PackageSearch className="mt-0.5 size-5 shrink-0 text-amber-600" aria-hidden />
            <div className="min-w-0 space-y-0.5">
              <p className="text-xs font-extrabold">لا توجد أصناف محلية بعد</p>
              <p className="text-[11px] leading-relaxed text-amber-800">
                {typeof navigator !== "undefined" && !navigator.onLine
                  ? "لا يوجد اتصال بالإنترنت. اتصل بالإنترنت ثم اضغط مزامنة الأصناف."
                  : "اضغط مزامنة الأصناف لتحميل أصناف متجرك. إذا لم تضف أصنافاً بعد، أضفها من صفحة المخزون أولاً."}
              </p>
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={handleSyncProducts}
            disabled={isSyncingProducts}
            className="h-9 shrink-0 gap-1.5 bg-emerald-600 text-xs font-bold text-white hover:bg-emerald-700"
          >
            <RefreshCw className={cn("size-3.5", isSyncingProducts && "animate-spin")} aria-hidden />
            {isSyncingProducts ? "جاري المزامنة..." : "مزامنة الأصناف"}
          </Button>
        </div>
      )}

      {/*
        Main split: desktop 2-column, mobile 1-column.

        [FIX — bottom-nav clearance] The clearance for the mobile floating bars
        now lives INSIDE the catalog's scroller (pb-44), not here: padding on
        this grid permanently shrank the visible list to a sliver, while padding
        inside the scroller lets the list use the full height and still scroll
        its last card clear of the bars.
      */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-hidden lg:grid-cols-12">
        {/* RIGHT SIDE (in RTL): Product Catalog */}
        <div className="col-span-1 flex min-h-0 flex-col overflow-hidden lg:col-span-7 xl:col-span-8">
          <ProductCatalog
            products={products}
            isLoading={isLoadingProducts}
            searchQuery={searchQuery}
            exchangeRate={dailyExchangeRate}
            onAddToCart={handleAddToCart}
            cartQuantities={cartQuantities}
          />
        </div>

        {/* LEFT SIDE (in RTL): persistent cart panel */}
        <div className="hidden min-h-0 flex-col overflow-hidden lg:col-span-5 lg:flex xl:col-span-4">
          <CartPanel
            items={cartItems}
            customer={selectedCustomer}
            exchangeRate={dailyExchangeRate}
            onUpdateQuantity={handleUpdateQuantity}
            onSetQuantity={handleSetQuantity}
            onChangeUnit={handleChangeUnit}
            onRemoveItem={handleRemoveItem}
            onClearCart={handleClearCart}
            onOpenCustomerModal={() => setIsCustomerModalOpen(true)}
            onOpenPaymentModal={() => setIsPaymentModalOpen(true)}
          />
        </div>
      </div>

      {/*
        [UX] Mobile floating scan button. Scanning adds straight to the cart, so
        on a phone it is THE primary action: a large round button within thumb
        reach, just above the cart bar.
      */}
      <div className="fixed bottom-36 inset-s-3 z-30 lg:hidden">
        <Button
          type="button"
          onClick={openBarcodeScanner}
          aria-label="مسح باركود بالكاميرا وإضافة للسلة"
          className="size-14 rounded-full bg-emerald-600 text-white shadow-lg shadow-emerald-900/25 ring-4 ring-white hover:bg-emerald-700"
        >
          <ScanLine className="size-6" />
        </Button>
      </div>

      {/*
        Mobile floating cart bar (trigger for the cart drawer).

        [FIX — hidden behind app shell bottom nav] `bottom-20` (80px) sits ABOVE
        the app shell's own bottom tab bar. NOTE: it is an estimate of the tab
        bar's height, not a measured constant — ideally replace it with a
        shared constant/CSS variable exported by the tab bar component.
      */}
      <div className="fixed inset-x-3 bottom-20 z-30 lg:hidden">
        <button
          type="button"
          onClick={() => setIsMobileCartOpen(true)}
          aria-label="عرض سلة المبيعات"
          className="flex w-full items-center justify-between gap-3 rounded-2xl border border-emerald-700 bg-linear-to-br from-emerald-600 to-emerald-800 px-3.5 py-2.5 text-white shadow-lg shadow-emerald-900/25 transition-transform active:scale-[0.99]"
        >
          <span className="flex min-w-0 items-center gap-2.5">
            <span className="relative flex size-9 shrink-0 items-center justify-center rounded-xl bg-white/20">
              <ShoppingCart className="size-4.5" aria-hidden />
              {cartTotals.itemCount > 0 && (
                // Re-mounts on every change, so each scan / tap bumps the badge.
                <span
                  key={cartTotals.itemCount}
                  className="absolute -inset-e-1.5 -top-1.5 flex h-5 min-w-5 animate-in items-center justify-center rounded-full bg-amber-400 px-1 text-[10px] font-extrabold tabular-nums text-amber-950 shadow-sm duration-200 zoom-in-50 motion-reduce:animate-none"
                >
                  {fmtInt(cartTotals.itemCount)}
                </span>
              )}
            </span>
            <span className="min-w-0 text-start">
              <span className="block text-[13px] font-extrabold">عرض سلة المبيعات</span>
              <span className="block truncate text-[11px] text-emerald-100">
                {selectedCustomer ? selectedCustomer.name : "لم يتم اختيار زبون"} • {fmtInt(cartItems.length)} أصناف
              </span>
            </span>
          </span>

          {/* [v3.6] SYP is the primary figure and USD the secondary one; USD may be null. */}
          <span className="flex shrink-0 items-center gap-2">
            <span className="text-start">
              <Money
                value={cartTotals.totalSYP}
                className="text-sm font-extrabold"
                unitClassName="text-emerald-100"
              />
              {cartTotals.totalUSD !== null && (
                <span className="block text-[10px] text-emerald-100">
                  ≈ <Money value={cartTotals.totalUSD} currency="USD" />
                </span>
              )}
            </span>
            <ChevronUp className="size-4 text-emerald-100" aria-hidden />
          </span>
        </button>
      </div>

      {/* Mobile Cart Bottom Sheet Drawer */}
      <Drawer open={isMobileCartOpen} onOpenChange={setIsMobileCartOpen}>
        <DrawerContent className="h-[85dvh] p-0" dir="rtl">
          <DrawerHeader className="sr-only">
            <DrawerTitle>سلة المبيعات</DrawerTitle>
            <DrawerDescription>تفاصيل الأصناف وإتمام الدفع</DrawerDescription>
          </DrawerHeader>
          <div className="flex h-full flex-1 flex-col overflow-hidden pt-2">
            <CartPanel
              items={cartItems}
              customer={selectedCustomer}
              exchangeRate={dailyExchangeRate}
              onUpdateQuantity={handleUpdateQuantity}
              onSetQuantity={handleSetQuantity}
              onChangeUnit={handleChangeUnit}
              onRemoveItem={handleRemoveItem}
              onClearCart={handleClearCart}
              onOpenCustomerModal={() => {
                setIsCustomerModalOpen(true);
              }}
              onOpenPaymentModal={() => {
                setIsPaymentModalOpen(true);
              }}
              isMobileDrawer
            />
          </div>
        </DrawerContent>
      </Drawer>

      {/* Customer Selection & Walk-in Creation Modal */}
      <WalkInCustomerModal
        open={isCustomerModalOpen}
        onOpenChange={(open) => {
          setIsCustomerModalOpen(open);
          if (!open && reopenPaymentAfterCustomer) {
            setReopenPaymentAfterCustomer(false);
            setIsPaymentModalOpen(true);
          }
        }}
        selectedCustomer={selectedCustomer}
        onSelectCustomer={setSelectedCustomer}
        tenantId={tenantId}
        allowSystemCustomer={allowSystemCustomer}
      />

      {/*
        Checkout & Payment Rail Selection Modal.
        [v3.6] Passes `totalSYP` (authoritative) alongside `totalUSD`
        (derived, may be null) so payment-modal.tsx leads its own UI with
        SYP the same way the rest of the app does.
      */}
      <PaymentModal
        open={isPaymentModalOpen}
        onOpenChange={(open) => {
          setIsPaymentModalOpen(open);
          if (!open && !reopenPaymentAfterCustomer) {
            setAllowSystemCustomer(true);
            if (!selectedCustomer) {
              void getSystemCashCustomer(tenantId).then((system) => {
                if (system) setSelectedCustomer(system);
              });
            }
          }
        }}
        totalSYP={cartTotals.totalSYP}
        totalUSD={cartTotals.totalUSD}
        exchangeRate={dailyExchangeRate || 0}
        selectedCustomer={selectedCustomer}
        // [T4b] Only block checkout on a missing rate when the cart
        // actually contains USD-priced items. A SYP-only cart must be
        // allowed through even with no cached rate.
        requiresExchangeRate={rateRequired}
        onPaymentModeChange={(mode) => {
          const allow = mode === "FULL_CASH";
          setAllowSystemCustomer(allow);
          if (!allow && (!selectedCustomer || isSystemCashCustomer(selectedCustomer))) {
            setSelectedCustomer(null);
          }
          if (allow && (!selectedCustomer || isSystemCashCustomer(selectedCustomer))) {
            void getSystemCashCustomer(tenantId).then((system) => {
              if (system) setSelectedCustomer(system);
            });
          }
        }}
        onOpenCustomerModal={() => {
          setIsPaymentModalOpen(false);
          setReopenPaymentAfterCustomer(true);
          setIsCustomerModalOpen(true);
        }}
        onConfirmCheckout={handleConfirmCheckout}
      />

      {/* Checkout Success & Local Save Confirmation Modal */}
      <CheckoutSuccessModal
        open={isSuccessModalOpen}
        onOpenChange={setIsSuccessModalOpen}
        invoice={completedInvoice}
        customer={completedCustomer}
        items={completedItems}
        onStartNewSale={handleStartNewSale}
        /*
          [T4f] A thermal print with no confirmed printer width on this device
          lands here. The success dialog is CLOSED first, deliberately: the
          printer popover lives in the command bar, and a modal Radix dialog
          makes everything behind it inert — so opening the popover without
          closing this dialog would render it unreachable. Closing the dialog
          reveals the popover (and the receipt is already saved locally, so
          nothing is lost by dismissing it).
        */
        onPrinterSetupRequired={() => {
          setIsSuccessModalOpen(false);
          setPrinterSettingsOpen(true);
        }}
      />

      {/*
        Camera barcode scanner — continuous mode so the cashier can scan
        multiple items back-to-back without reopening this dialog per item.
        feedback="silent" because this screen produces its own feedback: a
        beep/vibration per scan, plus the live panel below the video (last
        result with the line's quantity, the latest cart lines with − / ×, the
        running total and an undo button) — see ScanSessionPanel. Toasts are
        deliberately NOT used on the camera path: they would pile up over the
        video.
      */}
      <BarcodeScannerModal
        open={barcodeScannerOpen}
        onOpenChange={setBarcodeScannerOpen}
        onScan={(barcode) => {
          void handleBarcodeScan(barcode, { source: "camera" });
        }}
        mode="continuous"
        feedback="silent"
        continuousCooldownMs={1200}
        title="مسح المنتجات للسلة"
        description="وجّه الكاميرا نحو الباركود — كل مسحة بتنضاف للسلة مباشرة. اضغط «إنهاء المسح» لما تخلص."
      >
        <ScanSessionPanel
          banner={scanBanner}
          bannerQty={scanBannerQty}
          items={cartItems}
          totalLabel={`${fmtMoney(cartTotals.totalSYP, "SYP")} ل.س`}
          canUndo={scanStack.length > 0}
          onUndo={handleUndoLastScan}
          onDecrement={(cartId) => handleUpdateQuantity(cartId, -1)}
          onRemove={handleRemoveItem}
        />
      </BarcodeScannerModal>
    </div>
  );
}