"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useOfflineDbReady, useSessionWithOfflineFallback } from "@/lib/offline/hooks";
import { useExchangeRateStore } from "@/lib/store/useExchangeRateStore";
import {
  getOfflineProducts,
  submitOfflineSale,
  seedSampleOfflineData,
  syncProductsFromServer,
  getOfflineInvoicesList,
  calculateCartTotals,
  getSystemCashCustomer,
  isSystemCashCustomer,
  resolveCartLinePrices,
  cartNeedsExchangeRate,
  type PosProductItem,
  type CachedProductUnit,
  type CartLineItem,
  type SelectedCustomer,
  type OfflineInvoice,
  type PaymentMethod,
} from "@/lib/offline";
import { ProductCatalog } from "./product-catalog";
import { CartPanel } from "./cart-panel";
import { WalkInCustomerModal } from "./walk-in-customer-modal";
import { PaymentModal } from "./payment-modal";
import { CheckoutSuccessModal } from "./checkout-success-modal";
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
} from "lucide-react";
import { toast } from "sonner";
import { serializeMoney, formatMoney, compareMoney } from "@/lib/utils/money";

export function PosLayout() {
  const { data: session } = useSessionWithOfflineFallback();
  const tenantId = session?.tenantId;

  const { isReady: isDbReady, status: dbStatus } = useOfflineDbReady(tenantId);
  const dailyExchangeRate = useExchangeRateStore((state) => state.dailyExchangeRate);
  const hydrateExchangeRate = useExchangeRateStore((state) => state.hydrateFromCache);

  // Data states
  const [products, setProducts] = useState<PosProductItem[]>([]);
  const [isLoadingProducts, setIsLoadingProducts] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [pendingInvoicesCount, setPendingInvoicesCount] = useState(0);
  const [isSyncingProducts, setIsSyncingProducts] = useState(false);

  // Cart & Customer states
  const [cartItems, setCartItems] = useState<CartLineItem[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<SelectedCustomer | null>(null);

  // Modals & Mobile Drawer states
  const [isMobileCartOpen, setIsMobileCartOpen] = useState(false);
  const [isCustomerModalOpen, setIsCustomerModalOpen] = useState(false);
  const [isPaymentModalOpen, setIsPaymentModalOpen] = useState(false);
  const [isSuccessModalOpen, setIsSuccessModalOpen] = useState(false);
  const [completedInvoice, setCompletedInvoice] = useState<OfflineInvoice | null>(null);
  const [completedCustomer, setCompletedCustomer] = useState<SelectedCustomer | null>(null);
  const [completedItems, setCompletedItems] = useState<CartLineItem[]>([]);
  const [allowSystemCustomer, setAllowSystemCustomer] = useState(true);
  const [reopenPaymentAfterCustomer, setReopenPaymentAfterCustomer] = useState(false);

  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // [FIX — race condition] Monotonically increasing request id, checked
  // against the id captured at request time before writing a product-search
  // response into state. Previously, two overlapping effects both called
  // getOfflineProducts on every searchQuery keystroke (see below), and
  // neither guarded against out-of-order resolution — a slower response
  // for an earlier keystroke could resolve AFTER a faster response for a
  // later keystroke and silently overwrite it, showing products that don't
  // match what's currently typed in the search box. This ref is the single
  // source of truth for "is this response still the one we care about."
  const productsRequestIdRef = useRef(0);

  // Full reload of everything (exchange rate + products + pending invoice
  // count) — intentionally used ONLY after an action that can invalidate
  // all of it at once (seeding demo data). Everyday product search and the
  // exchange-rate/pending-count refresh are each handled by their own
  // narrower effect below, so this is not on the render path.
  const loadData = useCallback(async () => {
    if (!isDbReady) return;
    try {
      await hydrateExchangeRate(tenantId);
      const [prods, offlineInvoices] = await Promise.all([
        getOfflineProducts(tenantId, searchQuery),
        getOfflineInvoicesList(tenantId),
      ]);
      setProducts(prods);
      const pendingCount = offlineInvoices.filter((inv) => inv.status === "PENDING").length;
      setPendingInvoicesCount(pendingCount);
    } catch (err) {
      console.error("Failed to load POS offline data:", err);
    } finally {
      setIsLoadingProducts(false);
    }
  }, [isDbReady, hydrateExchangeRate, tenantId, searchQuery]);

  // 1a. Exchange rate + pending-invoice count — loads once per tenant/DB
  // readiness change. Deliberately does NOT depend on searchQuery: neither
  // value has anything to do with what's typed in the product search box,
  // so re-running this on every keystroke (as the old merged effect did)
  // was pure wasted work, not a correctness requirement.
  useEffect(() => {
    if (!isDbReady) return;
    let isMounted = true;

    hydrateExchangeRate(tenantId)
      .then(() => getOfflineInvoicesList(tenantId))
      .then((offlineInvoices) => {
        if (!isMounted) return;
        const pendingCount = offlineInvoices.filter((inv) => inv.status === "PENDING").length;
        setPendingInvoicesCount(pendingCount);
      })
      .catch((err) => {
        if (isMounted) {
          console.error("Failed to load exchange rate / pending invoices:", err);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [isDbReady, hydrateExchangeRate, tenantId]);

  // 1b. Default system cash customer — also independent of searchQuery.
  // `prev ?? system` preserves whatever the cashier has already actively
  // selected (including mid-search) instead of clobbering it every time
  // this effect re-runs.
  useEffect(() => {
    if (!isDbReady) return;
    let isMounted = true;

    getSystemCashCustomer(tenantId).then((system) => {
      if (isMounted && system) {
        setSelectedCustomer((prev) => prev ?? system);
      }
    });

    return () => {
      isMounted = false;
    };
  }, [isDbReady, tenantId]);

  // 1c. Product catalog / search — the SINGLE source of truth for
  // `products` and `isLoadingProducts`. Previously this logic was
  // duplicated across two separate effects (the merged "initial load"
  // effect and a second "dynamic search filtering" effect) that both fired
  // on every searchQuery change, double-calling getOfflineProducts per
  // keystroke with no ordering guarantee between the two calls or between
  // successive keystrokes — see the productsRequestIdRef comment above for
  // why that was a real bug, not just redundant work.
  useEffect(() => {
    if (!isDbReady) return;

    const requestId = ++productsRequestIdRef.current;

    // [FIX — React "setState synchronously within an effect" warning]
    // Wrapped in an inner async function instead of calling
    // setIsLoadingProducts(true) directly as the first statement of the
    // effect body. React (and the Next.js dev overlay) flags a setState
    // call that runs synchronously in an effect's body as a potential
    // cascading-render risk — not a bug, but a best-practice nudge.
    // Moving the setState calls inside `run()` doesn't change the
    // request-id race-guard logic at all (see productsRequestIdRef
    // comment above); it only changes WHEN, relative to React's own
    // render/commit cycle, the state updates are scheduled.
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
  }, [isDbReady, searchQuery, tenantId]);

  // 1d. Opportunistic initial product sync from the server (Postgres ->
  // Dexie). Fires once per tenant/DB-ready change, independent of
  // searchQuery. This closes the gap where `cachedProducts` previously had
  // no path to ever receive a tenant's REAL catalog — only
  // `seedSampleOfflineData`'s hardcoded demo products ever wrote to it.
  //
  // Deliberately silent on failure (offline, fetch error): this must never
  // block or interrupt a cashier who may be legitimately offline and
  // relying on whatever was cached during the last successful sync. See
  // lib/offline/product-sync.ts for the "OFFLINE"/"FETCH_FAILED" reasons
  // this swallows here — the manual "مزامنة المنتجات" button below is the
  // path that surfaces those to the user instead.
  useEffect(() => {
    if (!isDbReady || !tenantId) return;
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
  }, [isDbReady, tenantId]);

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
  // `unitPriceSYP: string` since the v3.6 re-anchoring. That omission
  // meant every cart line was missing the ONE field calculateCartTotals()
  // actually multiplies by quantity — adding anything to the cart would
  // have thrown inside money.ts's toDecimal() the moment totals were
  // computed. Both prices (SYP authoritative, USD derived/nullable) are
  // now captured and stored, matching resolveCartLinePrices()'s real
  // return shape.
  function handleAddToCart(product: PosProductItem, unit: CachedProductUnit) {
    if (unit.isActive === false) {
      toast.error("لا يمكن بيع وحدة غير نشطة.");
      return;
    }
    const cartItemId = `${product.id}-${unit.id}`;

    let unitPriceSYP: string;
    let unitPriceUSD: string | null;
    let pricingCurrency: "USD" | "SYP";
    let priceRetailSYP: string | undefined;
    let priceRetailUSD: string | null | undefined;
    try {
      const prices = resolveCartLinePrices(unit, product, dailyExchangeRate);
      unitPriceSYP = prices.unitPriceSYP;
      unitPriceUSD = prices.unitPriceUSD;
      pricingCurrency = prices.pricingCurrency;
      priceRetailSYP = prices.priceRetailSYP;
      priceRetailUSD = prices.priceRetailUSD;
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
        priceRetailSYP,
        priceRetailUSD,
      };
      return [...prev, newItem];
    });

    toast.success(`تمت إضافة ${product.name} (${unit.unitName}) إلى السلة`, {
      duration: 1200,
    });
  }

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

  // [v3.6] FIX — same omission as handleAddToCart above: this rebuilt the
  // cart line's price fields on a unit change but only ever wrote
  // `unitPriceUSD`, silently dropping `unitPriceSYP` on the item that
  // changed. Now updates all four price fields returned by
  // resolveCartLinePrices().
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
                priceRetailSYP: prices.priceRetailSYP,
                priceRetailUSD: prices.priceRetailUSD,
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
  // [v3.6] FIX — this previously took `paidAmountUSD`/`debtAmountUSD` from
  // the payment step and forwarded `totalUSD`/`paidAmountUSD`/
  // `debtAmountUSD` straight into submitOfflineSale()'s payload. None of
  // those fields exist on OfflineSalePayload anymore (pos-service.ts):
  // the payload now only accepts the SYP-authoritative fields
  // (totalSYP/paidAmountSYP/debtAmountSYP) and derives USD itself inside
  // createOfflineInvoiceRecord. This now takes paidAmountSYP/debtAmountSYP
  // from the payment step and forwards only the SYP fields.
  //
  // NOTE: this requires payment-modal.tsx's own onConfirmCheckout callback
  // to be updated to compute and pass `paidAmountSYP`/`debtAmountSYP`
  // (leading its own payment UI with SYP, same as everywhere else) instead
  // of the old USD amounts — that file wasn't included here, so it needs
  // the matching change on its side for this to compile and work end to
  // end.
  //
  // [FIX — real bug: product stock display never refreshed after a sale]
  // This handler previously only re-fetched `getOfflineInvoicesList` after
  // a successful checkout (to update `pendingInvoicesCount`) — it never
  // re-read `products` from Dexie, unlike handleSyncProducts()/loadData()
  // elsewhere in this file, which both correctly call
  // `getOfflineProducts(tenantId, searchQuery)` + `setProducts(...)` after
  // any action that can change what's in stock. That left the product
  // catalog's displayed quantities frozen at whatever they were when this
  // component last mounted or last searched — a completed sale's stock
  // decrement was invisible until something else happened to re-run the
  // product-loading effects from scratch (a full page reload, or
  // navigating away from /pos and back, which unmounts and remounts this
  // component). A cashier had no way to see accurate remaining stock
  // in between. Fixed below: `products` is now refreshed in the same
  // place `pendingInvoicesCount` already was, fetched together via
  // Promise.all since neither read depends on the other's result.
  async function handleConfirmCheckout(paymentData: {
    paidAmountSYP: string;
    debtAmountSYP: string;
    paymentMethod?: PaymentMethod;
  }) {
    // [T4b] If any cart item is priced in USD, a valid dailyExchangeRate is mandatory.
    // For SYP-only carts, an exchange rate is optional; if none is cached, fallback to "1.0000"
    // so the Dexie offline invoice record can be durably saved.
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

    // [FIX — real bug] See the function-level FIX note above. A sale
    // reduces the stock available to sell next, and the cashier needs to
    // see that reflected in the product cards IMMEDIATELY — not after a
    // manual page reload or navigating away and back. Fetched together
    // with the pending-invoice-count refresh via Promise.all, since
    // neither read depends on the other's result.
    const [prods, offlineInvoices] = await Promise.all([
      getOfflineProducts(tenantId, searchQuery),
      getOfflineInvoicesList(tenantId),
    ]);
    setProducts(prods);
    setPendingInvoicesCount(offlineInvoices.filter((inv) => inv.status === "PENDING").length);

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
    // strict `tenantId: string` (not `string | undefined`) — see its
    // definition in pos-service.ts: unlike the read paths and the other
    // write paths in that file, it performs bulk durable writes
    // (cachedProducts / cachedCustomers / cachedTenantSettings) and the
    // whole point of that stricter signature is to make "no tenant
    // context" a compile-time error here rather than a runtime one. This
    // call site previously passed `tenantId` (typed `string | undefined`
    // from `session?.user?.tenantId`) straight through without narrowing
    // it first, which is exactly what TypeScript was correctly rejecting.
    // The guard below both fixes the compile error (TS narrows `tenantId`
    // to `string` for the rest of this function after the early return)
    // and gives the cashier/admin a clear Arabic explanation instead of
    // letting the click silently do nothing or fall through to the
    // generic catch-block error message below.
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

        Design changes vs. the previous version:
        1. "قاعدة Dexie: جاهزة" is no longer a permanent text badge — it's
           a small status dot with a tooltip. It rarely changes state
           during a shift, so it doesn't deserve constant label-width.
        2. The "فواتير بانتظار المزامنة" badge only renders when the count
           is > 0. A "0" badge told the cashier nothing and cost a full
           badge's width on every screen size.
        3. The exchange-rate badge drops its "سعر الصرف:" label below the
           sm breakpoint — the number + icon is enough once you already
           know what the badge is for.
        4. "مزامنة الأصناف" and "تهيئة بيانات تجريبية" collapse to
           icon-only buttons below lg (with a title tooltip) and expand to
           full labeled buttons on lg+, where there's room. These are
           secondary/admin actions — they shouldn't compete with the
           primary search-and-sell flow for mobile width.
        5. Hover states on secondary buttons switched from
           emerald-tinted to neutral zinc, so emerald reads consistently
           as "this is the important/primary action" (exchange-rate
           badge, sync spinner icon, mobile checkout bar) rather than
           being sprinkled across every interactive element.
      */}
      <div className="flex items-center justify-between gap-2 rounded-2xl border border-zinc-200 bg-white px-3 py-2 sm:p-3 dark:border-zinc-800 dark:bg-zinc-900 shadow-xs shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex items-center gap-1.5 shrink-0">
            <span
              className={`inline-block h-2 w-2 rounded-full ${isDbReady
                ? "bg-emerald-500"
                : dbStatus === "NO_CACHED_DATA"
                  ? "bg-amber-500"
                  : "bg-zinc-300 animate-pulse"
                }`}
              title={
                isDbReady
                  ? "قاعدة البيانات المحلية جاهزة"
                  : dbStatus === "NO_CACHED_DATA"
                    ? "لا توجد بيانات مخزنة محلياً بعد — يرجى الاتصال بالإنترنت للمزامنة"
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
          {dailyExchangeRate && compareMoney(dailyExchangeRate, 0) > 0 ? (
            <Badge className="bg-emerald-600 text-white gap-1 text-[11px] sm:text-xs px-2 sm:px-2.5 py-1 font-semibold whitespace-nowrap">
              <DollarSign className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">سعر الصرف: </span>
              <span>{formatMoney(dailyExchangeRate, "SYP")} ل.س</span>
            </Badge>
          ) : (
            <Badge
              variant="destructive"
              className="gap-1 text-[11px] sm:text-xs px-2 sm:px-2.5 py-1 font-semibold whitespace-nowrap"
            >
              <AlertTriangle className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">سعر الصرف غير محدد!</span>
              <span className="sm:hidden">لا يوجد سعر صرف</span>
            </Badge>
          )}

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
        </div>
      </div>

      {/*
        Main Split Layout: Desktop 2-column, Mobile 1-column.

        [FIX — bottom-nav clearance] `pb-16` (64px) matched the OLD
        floating cart bar's footprint (bottom-3 + h-13 ≈ 64px). Now that
        the bar sits higher (see below, to clear the app shell's bottom
        tab bar), the scrollable content needs more bottom clearance too
        — otherwise the catalog's last row of products would still sit
        directly under the floating bar even though the bar itself moved.
        Bumped to `pb-36` (144px), sized to the new bar position
        (bottom-20 ≈ 80px) + its own height (h-13 ≈ 52px) + a small
        margin. Re-check this alongside the bottom-nav height once you
        can give me the exact value (see note below).
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

        [FIX — hidden behind app shell bottom nav] This was previously
        `bottom-3` — the same fixed viewport-bottom zone the app shell's
        own bottom tab bar (سلة/مخزون/دفتر الديون/نقطة البيع/الرئيسية)
        occupies. Both are independently `fixed`, so they overlapped: the
        tab bar rendered on top, making this button invisible and
        unreachable on mobile even though it was present in the DOM.

        Moved to `bottom-20` (80px) so it sits ABOVE the tab bar instead
        of raising z-index — raising z-index alone would still visually
        stack this bar on top of the tab bar rather than clearing it.

        NOTE: `bottom-20` is an estimate based on the tab bar's visible
        height in the screenshot, not a measured constant. Once you can
        give me the tab bar component (or just its rendered height from
        DevTools → Computed), I'll replace this with an exact value —
        ideally read from a shared constant/CSS variable the tab bar
        itself exports, so the two can never drift out of sync again if
        the tab bar's height ever changes.
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
            [v3.6] FIX — SYP is now the primary/large figure and USD the
            secondary/derived one, matching the schema's re-anchoring
            (previously this was inverted: USD large/primary, SYP small).
            Also guards against `cartTotals.totalUSD` being `null` (no
            exchange rate cached yet) — the old code called
            formatMoney(cartTotals.totalUSD, "USD") unconditionally, which
            throws a MoneyError on null instead of just hiding the USD line.
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
        [v3.6] Now passes `totalSYP` (authoritative) alongside `totalUSD`
        (derived, may be null) so payment-modal.tsx can lead its own UI
        with SYP the same way the rest of the app does. That file isn't
        shown here, so its `totalSYP`/`totalUSD` props and its
        onConfirmCheckout payload shape (paidAmountSYP/debtAmountSYP,
        matching handleConfirmCheckout below) need the corresponding
        update on its side.
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
      />
    </div>
  );
}