"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useSession } from "next-auth/react";
import { useOfflineDbReady } from "@/lib/offline/hooks";
import { useExchangeRateStore } from "@/lib/store/useExchangeRateStore";
import {
  getOfflineProducts,
  submitOfflineSale,
  seedSampleOfflineData,
  getOfflineInvoicesList,
  calculateCartTotals,
  getSystemCashCustomer,
  isSystemCashCustomer,
  resolveCartLinePrices,
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
  Layers,
  Sparkles,
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
  const { data: session } = useSession();
  const tenantId = session?.user?.tenantId;

  const isDbReady = useOfflineDbReady();
  const dailyExchangeRate = useExchangeRateStore((state) => state.dailyExchangeRate);
  const hydrateExchangeRate = useExchangeRateStore((state) => state.hydrateFromCache);

  // Data states
  const [products, setProducts] = useState<PosProductItem[]>([]);
  const [isLoadingProducts, setIsLoadingProducts] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [pendingInvoicesCount, setPendingInvoicesCount] = useState(0);

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
    setIsLoadingProducts(true);

    getOfflineProducts(tenantId, searchQuery)
      .then((prods) => {
        // Only the most recently issued request is allowed to write to
        // state — an older, slower-resolving request for a previous
        // keystroke is discarded here even if it resolves later.
        if (productsRequestIdRef.current === requestId) {
          setProducts(prods);
        }
      })
      .catch((err) => {
        if (productsRequestIdRef.current === requestId) {
          console.error("Failed to load POS products:", err);
        }
      })
      .finally(() => {
        if (productsRequestIdRef.current === requestId) {
          setIsLoadingProducts(false);
        }
      });
  }, [isDbReady, searchQuery, tenantId]);

  // Cart Totals calculation strictly through decimal.js
  const cartTotals = useMemo(() => {
    return calculateCartTotals(cartItems, dailyExchangeRate);
  }, [cartItems, dailyExchangeRate]);

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
        if (cartItems.length > 0 && dailyExchangeRate && compareMoney(dailyExchangeRate, 0) > 0) {
          setIsPaymentModalOpen(true);
        } else if (!dailyExchangeRate || compareMoney(dailyExchangeRate, 0) <= 0) {
          toast.error("لا يمكن إتمام البيع بدون تحديد سعر الصرف اليومي.");
        }
      }
    }

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [
    cartItems.length,
    dailyExchangeRate,
    isCustomerModalOpen,
    isPaymentModalOpen,
    isSuccessModalOpen,
  ]);

  // 3. Cart Management Operations
  function handleAddToCart(product: PosProductItem, unit: CachedProductUnit) {
    const cartItemId = `${product.id}-${unit.id}`;

    let unitPriceUSD: string;
    let priceRetailUSD: string | undefined;
    try {
      const prices = resolveCartLinePrices(unit, product, dailyExchangeRate);
      unitPriceUSD = prices.unitPriceUSD;
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
        unitPriceUSD,
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

  function handleChangeUnit(cartId: string, newUnitId: string) {
    setCartItems((prev) =>
      prev.map((item) => {
        if (item.id === cartId) {
          const selectedUnit = item.product.units?.find((u) => u.id === newUnitId);
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
                unitPriceUSD: prices.unitPriceUSD,
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
  async function handleConfirmCheckout(paymentData: {
    paidAmountUSD: string;
    debtAmountUSD: string;
    paymentMethod?: PaymentMethod;
  }) {
    if (!dailyExchangeRate || compareMoney(dailyExchangeRate, 0) <= 0) {
      throw new Error("سعر الصرف غير محدد في الذاكرة المحلية.");
    }

    let customer = selectedCustomer;
    if (!customer || isSystemCashCustomer(customer)) {
      customer = isSystemCashCustomer(customer) && customer?.id
        ? customer
        : await getSystemCashCustomer(tenantId);
    }

    const { totalUSD, totalSYP } = calculateCartTotals(cartItems, dailyExchangeRate);

    // Save offline invoice strictly into Dexie
    const savedInvoice = await submitOfflineSale(tenantId, {
      customer,
      items: cartItems,
      totalUSD,
      totalSYP: totalSYP ?? "0",
      exchangeRateUsed: serializeMoney(dailyExchangeRate),
      paidAmountUSD: paymentData.paidAmountUSD,
      debtAmountUSD: paymentData.debtAmountUSD,
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

    // Refresh pending count
    const offlineInvoices = await getOfflineInvoicesList(tenantId);
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

  return (
    <div className="flex flex-col h-[calc(100vh-8.5rem)] space-y-3 relative" dir="rtl">
      {/* Top POS Action & Status Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900 shadow-xs shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className="gap-1.5 px-2.5 py-1 text-xs border-emerald-300 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-800 font-semibold"
            >
              <Layers className="h-3.5 w-3.5 text-emerald-600" />
              <span>قاعدة Dexie: {isDbReady ? "جاهزة ✓" : "جاري التهيئة..."}</span>
            </Badge>

            <Badge
              variant="outline"
              className="gap-1.5 px-2.5 py-1 text-xs border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-800 font-semibold"
            >
              <CloudOff className="h-3.5 w-3.5 text-amber-600" />
              <span>فواتير بانتظار المزامنة: {pendingInvoicesCount}</span>
            </Badge>
          </div>

          <div className="hidden md:flex items-center gap-1.5 text-[11px] text-zinc-500 mr-2">
            <Keyboard className="h-3.5 w-3.5 text-zinc-400" />
            <span>
              اختصارات: <kbd className="font-mono bg-zinc-100 dark:bg-zinc-800 px-1 rounded border border-zinc-200 dark:border-zinc-700">F2</kbd> بحث • <kbd className="font-mono bg-zinc-100 dark:bg-zinc-800 px-1 rounded border border-zinc-200 dark:border-zinc-700">F4</kbd> زبون • <kbd className="font-mono bg-zinc-100 dark:bg-zinc-800 px-1 rounded border border-zinc-200 dark:border-zinc-700">F9</kbd> دفع
            </span>
          </div>
        </div>

        {/* Right side controls (Exchange Rate & Seeder) */}
        <div className="flex items-center gap-2">
          {dailyExchangeRate && compareMoney(dailyExchangeRate, 0) > 0 ? (
            <Badge className="bg-emerald-600 text-white gap-1 text-xs px-2.5 py-1 font-semibold">
              <DollarSign className="h-3.5 w-3.5" />
              <span>سعر الصرف: {formatMoney(dailyExchangeRate, "SYP")} ل.س / $</span>
            </Badge>
          ) : (
            <Badge variant="destructive" className="gap-1 text-xs px-2.5 py-1 font-semibold">
              <AlertTriangle className="h-3.5 w-3.5" />
              <span>سعر الصرف غير محدد! (البيع موقوف)</span>
            </Badge>
          )}

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleSeedDemoData}
            className="text-xs h-8 gap-1.5 text-zinc-600 hover:text-emerald-700 hover:border-emerald-400"
            title="تحميل أصناف وزبائن تجريبية في Dexie للاختبار بدون اتصال"
          >
            <Sparkles className="h-3.5 w-3.5 text-emerald-600" />
            <span>تهيئة بيانات تجريبية</span>
          </Button>
        </div>
      </div>

      {/* Main Split Layout: Desktop 2-column, Mobile 1-column */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 flex-1 overflow-hidden pb-16 lg:pb-0">
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

      {/* Mobile Floating Bottom Bar (Trigger for Cart Drawer) */}
      <div className="lg:hidden fixed bottom-3 inset-x-3 z-30">
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

          <div className="flex items-center gap-2">
            <div className="text-left">
              <p className="text-xs font-extrabold font-mono">
                ${formatMoney(cartTotals.totalUSD, "USD")}
              </p>
              {cartTotals.totalSYP && (
                <p className="text-[10px] text-emerald-200">
                  {formatMoney(cartTotals.totalSYP, "SYP")} ل.س
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

      {/* Checkout & Payment Rail Selection Modal */}
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
        totalUSD={cartTotals.totalUSD}
        exchangeRate={dailyExchangeRate || 0}
        selectedCustomer={selectedCustomer}
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