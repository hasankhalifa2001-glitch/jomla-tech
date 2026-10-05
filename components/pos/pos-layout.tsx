"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useOfflineDbReady, useSessionWithOfflineFallback } from "@/lib/offline/hooks";
import { useExchangeRateStore } from "@/lib/store/useExchangeRateStore";
import {
  getOfflineProducts,
  submitOfflineSale,
  seedSampleOfflineData,
  syncProductsFromServer,
  calculateCartTotals,
  getSystemCashCustomer,
  isSystemCashCustomer,
  resolveCartLinePrices,
  cartNeedsExchangeRate,
  useSyncWorker,
  // [ADDED — camera + hardware barcode scanning] Re-exported via
  // lib/offline/index.ts's `export * from "./barcode-lookup"` — imported
  // from the barrel like everything else in this block, not a separate
  // direct file import.
  findProductUnitByBarcode,
  type PosProductItem,
  type CachedProductUnit,
  type CartLineItem,
  type SelectedCustomer,
  type OfflineInvoice,
  type PaymentMethod,
} from "@/lib/offline";
import { BarcodeScannerModal } from "@/components/inventory/BarcodeScannerModal";
import { ProductCatalog } from "./product-catalog";
import { CartPanel } from "./cart-panel";
import { WalkInCustomerModal } from "./walk-in-customer-modal";
import { PaymentModal } from "./payment-modal";
import { CheckoutSuccessModal } from "./checkout-success-modal";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sparkles,
  RefreshCw,
  CloudOff,
  Keyboard,
  DollarSign,
  AlertTriangle,
  ShoppingCart,
  ChevronUp,
  ScanLine,
  PackageSearch,
} from "lucide-react";
import { toast } from "sonner";
import { serializeMoney, formatMoney, compareMoney } from "@/lib/utils/money";

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
  // [ADDED] Camera barcode scanner modal open/close state.
  const [barcodeScannerOpen, setBarcodeScannerOpen] = useState(false);

  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // [FIX — race condition] Monotonically increasing request id, checked
  // against the id captured at request time before writing a product-search
  // response into state. A slower response for an earlier keystroke could
  // otherwise resolve AFTER a faster response for a later keystroke and
  // silently overwrite it.
  const productsRequestIdRef = useRef(0);

  // Full reload of products (exchange rate + product catalog) — intentionally
  // used ONLY after an action that can invalidate all of it at once
  // (seeding demo data). Everyday product search and the exchange-rate
  // refresh are each handled by their own narrower effect below.
  //
  // [FIX] The exchange-rate hydrate is wrapped in its OWN try/catch so a
  // missing/failed rate can never prevent the product catalog from loading.
  const loadData = useCallback(async () => {
    if (!isDbOpen) return;
    try {
      try {
        await hydrateExchangeRate(tenantId);
      } catch (err) {
        console.error("Failed to hydrate exchange rate (non-fatal):", err);
      }
      const prods = await getOfflineProducts(tenantId, searchQuery);
      setProducts(prods);
    } catch (err) {
      console.error("Failed to load POS offline data:", err);
    } finally {
      setIsLoadingProducts(false);
    }
  }, [isDbOpen, hydrateExchangeRate, tenantId, searchQuery]);

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
  // searchQuery. [FIX] Now gated on `isDbOpen`, NOT `isDbReady`: on a
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
  function handleAddToCart(product: PosProductItem, unit: CachedProductUnit) {
    if (unit.isActive === false) {
      toast.error("لا يمكن بيع وحدة غير نشطة.");
      return;
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
      toast.error(
        err instanceof Error
          ? err.message
          : "لا يمكن إضافة هذا الصنف إلى السلة بدون سعر جملة أو سعر صرف صالح."
      );
      return;
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

    toast.success(`تمت إضافة ${product.name} (${unit.unitName}) إلى السلة`, {
      duration: 1200,
    });
  }

  // [ADDED — barcode -> cart bridge]
  // The SINGLE resolution path shared by BOTH scan surfaces:
  //   1. The camera scanner (BarcodeScannerModal, mode="continuous" below)
  //   2. The hardware keyboard-wedge scanner (ProductCatalog's search-input
  //      Enter handler, wired via the onBarcodeEnter prop)
  // Offline-first: tries the full local cache first (findProductUnitByBarcode
  // — NOT the debounced/filtered `products` state) and only reaches for the
  // network as a last resort, and only when actually online. Never blocks or
  // throws while offline.
  //
  // Returns a boolean so ProductCatalog's Enter handler can distinguish
  // "this was recognized as a barcode" (found, or found-but-rejected) from
  // "this wasn't a barcode at all" (falls through to plain text-search
  // behavior there).
  const handleBarcodeScan = useCallback(
    async (barcode: string): Promise<boolean> => {
      if (!tenantId) return false;

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
        handleAddToCart(result.product, result.unit);
        return true;
      }

      if (result.status === "unit_inactive") {
        // [FIX — previously silent when matched via the hardware-scanner
        // Enter path] Now a clear Arabic toast on every entry point.
        toast.error(
          `الصنف "${result.product.name}" (${result.unit.unitName}) غير نشط ولا يمكن بيعه.`
        );
        return true; // recognized as a real barcode — rejected, not "unmatched text"
      }

      // not_found — offline with no local match, or genuinely nonexistent.
      toast.error(
        typeof navigator !== "undefined" && navigator.onLine
          ? "لم يتم العثور على منتج مرتبط بهذا الباركود."
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
    // For SYP-only carts, an exchange rate is optional; if none is cached, fallback to "1.0000"
    // so the Dexie offline invoice record can be durably saved.
    //
    // KNOWN CONCERN (reported to the maintainer, intentionally NOT changed
    // here): with the "1.0000" fallback the persisted invoice freezes
    // exchangeRateUsed = 1, so its derived USD figures equal the SYP
    // figures. See the review notes accompanying this file.
    const effectiveRate =
      dailyExchangeRate && compareMoney(dailyExchangeRate, 0) > 0
        ? dailyExchangeRate
        : rateRequired
          ? null
          : "1.0000";

    if (!effectiveRate) {
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
      exchangeRateUsed: serializeMoney(effectiveRate),
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

  async function handleSeedDemoData() {
    // [FIX — TS2345] `seedSampleOfflineData` deliberately requires a
    // strict `tenantId: string` (it performs bulk durable writes), so
    // "no tenant context" is made a compile-time error here. The guard
    // below narrows `tenantId` to `string` for the rest of this function
    // and gives the user a clear Arabic explanation.
    if (!tenantId) {
      toast.error("لا يمكن تحميل بيانات تجريبية دون تحديد هوية المتجر (تسجيل الدخول مطلوب).");
      return;
    }

    try {
      await seedSampleOfflineData(tenantId);
      await loadData();
      const system = await getSystemCashCustomer(tenantId);
      if (system) {
        setSelectedCustomer((prev) => prev ?? system);
      }
      toast.success("تم تجهيز بيانات الأصناف والزبائن وسعر الصرف في الذاكرة المحلية بنجاح!");
    } catch (err) {
      console.error("Failed to seed demo data:", err);
      toast.error("حدث خطأ أثناء تحميل البيانات التجريبية.");
    }
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
    <div className="flex flex-col h-[calc(100vh-8.5rem)] space-y-3 relative" dir="rtl">
      {/*
        Top POS Action & Status Bar — reworked for density on mobile.

        1. "قاعدة Dexie: جاهزة" is a small status dot with a tooltip.
        2. The "فواتير بانتظار المزامنة" badge only renders when the count
           is > 0.
        3. The exchange-rate badge drops its label below the sm breakpoint.
           [FIX] When the rate is missing it is now a non-blocking AMBER
           warning (SYP sales never need a rate), not a red alarm.
        4. Secondary buttons collapse to icon-only below lg.
        5. Hover states on secondary buttons are neutral zinc so emerald
           reads consistently as "primary".
        6. A "مسح باركود" scan button, same pattern as sync/seed.
      */}
      <div className="flex items-center justify-between gap-2 rounded-2xl border border-zinc-200 bg-white px-3 py-2 sm:p-3 dark:border-zinc-800 dark:bg-zinc-900 shadow-xs shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex items-center gap-1.5 shrink-0">
            <span
              className={`inline-block h-2 w-2 rounded-full ${isDbReady
                ? "bg-emerald-500"
                : dbStatus === "NO_CACHED_DATA" || dbStatus === "PARTIAL"
                  ? "bg-amber-500"
                  : "bg-zinc-300 animate-pulse"
                }`}
              title={
                isDbReady
                  ? "قاعدة البيانات المحلية جاهزة"
                  : dbStatus === "NO_CACHED_DATA"
                    ? "لا توجد بيانات مخزنة محلياً بعد — يرجى الاتصال بالإنترنت للمزامنة"
                    : dbStatus === "PARTIAL"
                      ? "بعض البيانات المحلية غير مكتملة بعد (مثل سعر الصرف أو الزبائن)"
                      : "جاري تهيئة قاعدة البيانات..."
              }
            />
            {pendingInvoicesCount > 0 && (
              <Badge
                variant="outline"
                className="gap-1 px-2 py-0.5 text-[11px] border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-800 font-semibold whitespace-nowrap"
              >
                <CloudOff className="h-3 w-3 text-amber-600" />
                <span>{pendingInvoicesCount} بانتظار المزامنة</span>
              </Badge>
            )}
          </div>

          <div className="hidden lg:flex items-center gap-1.5 text-[11px] text-zinc-500 mr-1 shrink-0">
            <Keyboard className="h-3.5 w-3.5 text-zinc-400" />
            <span>
              اختصارات:{" "}
              <kbd className="font-mono bg-zinc-100 dark:bg-zinc-800 px-1 rounded border border-zinc-200 dark:border-zinc-700">
                F2
              </kbd>{" "}
              بحث •{" "}
              <kbd className="font-mono bg-zinc-100 dark:bg-zinc-800 px-1 rounded border border-zinc-200 dark:border-zinc-700">
                F4
              </kbd>{" "}
              زبون •{" "}
              <kbd className="font-mono bg-zinc-100 dark:bg-zinc-800 px-1 rounded border border-zinc-200 dark:border-zinc-700">
                F9
              </kbd>{" "}
              دفع
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          {!isRateMissing ? (
            <Badge className="bg-emerald-600 text-white gap-1 text-[11px] sm:text-xs px-2 sm:px-2.5 py-1 font-semibold whitespace-nowrap">
              <DollarSign className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">سعر الصرف: </span>
              <span>{formatMoney(dailyExchangeRate, "SYP")} ل.س</span>
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="gap-1 text-[11px] sm:text-xs px-2 sm:px-2.5 py-1 font-semibold whitespace-nowrap border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-800"
              title="البيع بالليرة السورية متاح بدون سعر صرف. السعر مطلوب فقط للأصناف المسعّرة بالدولار."
            >
              <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
              <span className="hidden sm:inline">سعر الصرف غير محدد</span>
              <span className="sm:hidden">بدون سعر صرف</span>
            </Badge>
          )}

          {/* [ADDED] Camera barcode scan — icon-only under lg, labeled on lg+,
              same pattern as the sync/seed buttons beside it. */}
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => setBarcodeScannerOpen(true)}
            className="h-8 w-8 lg:hidden text-zinc-600 hover:text-zinc-900 hover:border-zinc-400"
            title="مسح باركود بالكاميرا"
          >
            <ScanLine className="h-3.5 w-3.5 text-emerald-600" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setBarcodeScannerOpen(true)}
            className="hidden lg:flex text-xs h-8 gap-1.5 text-zinc-600 hover:text-zinc-900 hover:border-zinc-400"
            title="مسح باركود بالكاميرا وإضافة للسلة مباشرة"
          >
            <ScanLine className="h-3.5 w-3.5 text-emerald-600" />
            <span>مسح باركود</span>
          </Button>

          {/* Sync products — icon-only under lg, labeled button on lg+ */}
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={handleSyncProducts}
            disabled={isSyncingProducts}
            className="h-8 w-8 lg:hidden text-zinc-600 hover:text-zinc-900 hover:border-zinc-400"
            title="مزامنة الأصناف من السيرفر"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 text-emerald-600 ${isSyncingProducts ? "animate-spin" : ""}`}
            />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleSyncProducts}
            disabled={isSyncingProducts}
            className="hidden lg:flex text-xs h-8 gap-1.5 text-zinc-600 hover:text-zinc-900 hover:border-zinc-400"
            title="سحب أحدث الأصناف من السيرفر إلى الذاكرة المحلية"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 text-emerald-600 ${isSyncingProducts ? "animate-spin" : ""}`}
            />
            <span>{isSyncingProducts ? "جاري المزامنة..." : "مزامنة الأصناف"}</span>
          </Button>

          {/* Seed demo data — icon-only under lg, labeled button on lg+ */}
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={handleSeedDemoData}
            className="h-8 w-8 lg:hidden text-zinc-600 hover:text-zinc-900 hover:border-zinc-400"
            title="تهيئة بيانات تجريبية"
          >
            <Sparkles className="h-3.5 w-3.5 text-emerald-600" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleSeedDemoData}
            className="hidden lg:flex text-xs h-8 gap-1.5 text-zinc-600 hover:text-zinc-900 hover:border-zinc-400"
            title="تحميل أصناف وزبائن تجريبية في Dexie للاختبار بدون اتصال"
          >
            <Sparkles className="h-3.5 w-3.5 text-emerald-600" />
            <span>تهيئة بيانات تجريبية</span>
          </Button>

          {/*
            [T4f — Rule 4] The printer settings control. Deliberately NOT
            role-gated: the printer's dots-per-line is a property of THIS device
            (Dexie's `deviceSettings` table, which stores no tenantId and no
            userId), and a cashier is the person who actually prints.

            Its controlled `open` state lives in this component so a failed
            thermal print can route the user straight here instead of leaving
            them with a toast and no way forward.
          */}
          <PrinterSettingsPopover
            open={printerSettingsOpen}
            onOpenChange={setPrinterSettingsOpen}
          />
        </div>
      </div>

      {/*
        [v4.1 — T4d §6.3] Offline void panel.

        Mounted directly under the top status bar so it is visible on BOTH the
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
        "جاري قراءة الأصناف من الذاكرة المحلية" spinner. Shown when Dexie is
        open, the first read has finished, no search is active and there are
        zero cached products — i.e. a brand-new tenant (or a device that has
        never synced). It tells the user exactly what to do and offers the
        sync action directly.
      */}
      {showEmptyCacheBanner && (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-amber-300 bg-amber-50 px-3.5 py-3 text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200 shrink-0">
          <div className="flex items-start gap-2.5 min-w-0">
            <PackageSearch className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="space-y-0.5 min-w-0">
              <p className="text-xs font-bold">لا توجد أصناف محلية بعد</p>
              <p className="text-[11px] leading-relaxed text-amber-800 dark:text-amber-300">
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
            className="h-8 gap-1.5 text-xs bg-emerald-600 hover:bg-emerald-700 text-white shrink-0"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${isSyncingProducts ? "animate-spin" : ""}`}
            />
            <span>{isSyncingProducts ? "جاري المزامنة..." : "مزامنة الأصناف"}</span>
          </Button>
        </div>
      )}

      {/*
        Main Split Layout: Desktop 2-column, Mobile 1-column.

        [FIX — bottom-nav clearance] `pb-36` (144px) clears the floating
        mobile cart bar, which sits above the app shell's bottom tab bar.
      */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 flex-1 overflow-hidden pb-36 lg:pb-0">
        {/* RIGHT SIDE (60%-65% width on desktop, 100% on mobile): Product Catalog */}
        <div className="col-span-1 lg:col-span-7 xl:col-span-8 flex flex-col overflow-hidden">
          <ProductCatalog
            products={products}
            isLoading={isLoadingProducts}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            exchangeRate={dailyExchangeRate}
            onAddToCart={handleAddToCart}
            onSeedDemoData={handleSeedDemoData}
            searchInputRef={searchInputRef}
            // [ADDED] Hardware keyboard-wedge scanner support — see
            // handleBarcodeScan above and product-catalog.tsx's prop doc.
            onBarcodeEnter={handleBarcodeScan}
          />
        </div>

        {/* LEFT SIDE (35%-40% width on desktop): Persistent Cart Panel */}
        <div className="hidden lg:flex lg:col-span-5 xl:col-span-4 flex-col overflow-hidden">
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
        Mobile Floating Bottom Bar (Trigger for Cart Drawer).

        [FIX — hidden behind app shell bottom nav] Moved to `bottom-20`
        (80px) so it sits ABOVE the app shell's own bottom tab bar instead
        of overlapping it. NOTE: `bottom-20` is an estimate of the tab
        bar's height, not a measured constant — ideally replace it with a
        shared constant/CSS variable exported by the tab bar component.
      */}
      <div className="lg:hidden fixed bottom-20 inset-x-3 z-30">
        <Button
          type="button"
          onClick={() => setIsMobileCartOpen(true)}
          className="w-full h-13 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white shadow-lg shadow-emerald-600/30 flex items-center justify-between px-4"
        >
          <div className="flex items-center gap-2.5">
            <div className="relative flex h-8 w-8 items-center justify-center rounded-xl bg-emerald-700 text-white">
              <ShoppingCart className="h-4 w-4" />
              {cartTotals.itemCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-amber-400 text-[10px] font-extrabold text-zinc-900 shadow-xs">
                  {cartTotals.itemCount}
                </span>
              )}
            </div>
            <div className="text-right">
              <p className="text-xs font-bold">عرض سلة المبيعات</p>
              <p className="text-[10px] text-emerald-100">
                {selectedCustomer ? selectedCustomer.name : "لم يتم اختيار زبون"} • {cartItems.length} أصناف
              </p>
            </div>
          </div>

          {/*
            [v3.6] SYP is the primary/large figure and USD the
            secondary/derived one. Guards against `cartTotals.totalUSD`
            being `null` (no exchange rate cached yet).
          */}
          <div className="flex items-center gap-2">
            <div className="text-left">
              <p className="text-xs font-extrabold font-mono">
                {formatMoney(cartTotals.totalSYP, "SYP")} ل.س
              </p>
              {cartTotals.totalUSD !== null && (
                <p className="text-[10px] text-emerald-200">
                  ≈ ${formatMoney(cartTotals.totalUSD, "USD")}
                </p>
              )}
            </div>
            <ChevronUp className="h-4 w-4 text-emerald-200" />
          </div>
        </Button>
      </div>

      {/* Mobile Cart Bottom Sheet Drawer */}
      <Drawer open={isMobileCartOpen} onOpenChange={setIsMobileCartOpen}>
        <DrawerContent className="h-[85vh] p-0" dir="rtl">
          <DrawerHeader className="sr-only">
            <DrawerTitle>سلة المبيعات</DrawerTitle>
            <DrawerDescription>تفاصيل الأصناف وإتمام الدفع</DrawerDescription>
          </DrawerHeader>
          <div className="flex-1 overflow-hidden h-full flex flex-col pt-2">
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
          printer popover lives in the top bar, and a modal Radix dialog makes
          everything behind it inert — so opening the popover without closing
          this dialog would render it unreachable. Closing the dialog reveals
          the popover (and the receipt is already saved locally, so nothing is
          lost by dismissing it).
        */
        onPrinterSetupRequired={() => {
          setIsSuccessModalOpen(false);
          setPrinterSettingsOpen(true);
        }}
      />

      {/*
        [ADDED] Camera barcode scanner — continuous mode so the cashier can
        scan multiple items back-to-back without reopening this dialog per
        item. feedback="silent" because handleBarcodeScan / handleAddToCart
        already produce their own contextual toasts (item added / inactive /
        not found) — showing this modal's own generic "تم مسح الباركود
        بنجاح" toast on top would double up during rapid scanning.
      */}
      <BarcodeScannerModal
        open={barcodeScannerOpen}
        onOpenChange={setBarcodeScannerOpen}
        onScan={(barcode) => {
          void handleBarcodeScan(barcode);
        }}
        mode="continuous"
        feedback="silent"
      />
    </div>
  );
}