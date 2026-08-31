"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useOfflineDbReady } from "@/lib/offline/hooks";
import { useExchangeRateStore } from "@/lib/store/useExchangeRateStore";
import {
  getOfflineProducts,
  submitOfflineSale,
  seedSampleOfflineData,
  getOfflineInvoicesList,
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Layers,
  Sparkles,
  CloudOff,
  Keyboard,
  Info,
  DollarSign,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";

export function PosLayout() {
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

  // Modals
  const [isCustomerModalOpen, setIsCustomerModalOpen] = useState(false);
  const [isPaymentModalOpen, setIsPaymentModalOpen] = useState(false);
  const [isSuccessModalOpen, setIsSuccessModalOpen] = useState(false);
  const [completedInvoice, setCompletedInvoice] = useState<OfflineInvoice | null>(null);
  const [completedCustomer, setCompletedCustomer] = useState<SelectedCustomer | null>(null);
  const [completedItems, setCompletedItems] = useState<CartLineItem[]>([]);

  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // 1. Initial Load & Sync with Dexie
  const loadData = useCallback(async () => {
    if (!isDbReady) return;
    setIsLoadingProducts(true);
    try {
      await hydrateExchangeRate();
      const [prods, offlineInvoices] = await Promise.all([
        getOfflineProducts(searchQuery),
        getOfflineInvoicesList(),
      ]);
      setProducts(prods);
      const pendingCount = offlineInvoices.filter((inv) => inv.status === "PENDING").length;
      setPendingInvoicesCount(pendingCount);
    } catch (err) {
      console.error("Failed to load POS offline data:", err);
    } finally {
      setIsLoadingProducts(false);
    }
  }, [isDbReady, hydrateExchangeRate]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Dynamic product search filtering without triggering full page loading state or re-hydrating store
  useEffect(() => {
    if (!isDbReady) return;
    let isSubscribed = true;
    getOfflineProducts(searchQuery).then((prods) => {
      if (isSubscribed) {
        setProducts(prods);
      }
    });
    return () => {
      isSubscribed = false;
    };
  }, [isDbReady, searchQuery]);

  // 2. Keyboard Shortcuts (F2: Search, F4: Customer, F9: Checkout, Esc: Close)
  useEffect(() => {
    function handleGlobalKeyDown(e: KeyboardEvent) {
      // Ignore if user is currently typing in an input inside a modal
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
        if (cartItems.length > 0 && dailyExchangeRate && dailyExchangeRate > 0) {
          setIsPaymentModalOpen(true);
        } else if (!dailyExchangeRate || dailyExchangeRate <= 0) {
          toast.error("لا يمكن إتمام البيع بدون تحديد سعر الصرف اليومي.");
        }
      }
    }

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [cartItems.length, dailyExchangeRate, isCustomerModalOpen, isPaymentModalOpen, isSuccessModalOpen]);

  // 3. Cart Management Operations
  function handleAddToCart(product: PosProductItem, unit: CachedProductUnit) {
    const cartItemId = `${product.id}-${unit.id}`;

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
        unitPriceUSD: Number(unit.priceUSD ?? unit.priceWholesale ?? product.priceUSD ?? product.priceWholesale ?? 0),
      };
      return [...prev, newItem];
    });

    toast.success(`تمت إضافة ${product.name} (${unit.unitName}) إلى السلة`, {
      duration: 1500,
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
            return {
              ...item,
              id: `${item.product.id}-${selectedUnit.id}`,
              unitId: selectedUnit.id,
              unitName: selectedUnit.unitName,
              conversionFactor: selectedUnit.conversionFactor,
              unitPriceUSD: Number(selectedUnit.priceUSD ?? selectedUnit.priceWholesale ?? 0),
            };
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
    paidAmountUSD: number;
    debtAmountUSD: number;
    paymentMethod: string;
  }) {
    if (!dailyExchangeRate || dailyExchangeRate <= 0) {
      throw new Error("سعر الصرف غير محدد في الذاكرة المحلية.");
    }

    const totalUSD = cartItems.reduce((acc, it) => acc + it.quantity * it.unitPriceUSD, 0);
    const totalSYP = totalUSD * dailyExchangeRate;

    const paymentMethod =
      paymentData.paidAmountUSD > 0
        ? (paymentData.paymentMethod as PaymentMethod)
        : undefined;

    // Save offline invoice strictly into Dexie
    const savedInvoice = await submitOfflineSale({
      customer: selectedCustomer,
      items: cartItems,
      totalUSD,
      totalSYP,
      exchangeRateUsed: dailyExchangeRate,
      paidAmountUSD: paymentData.paidAmountUSD,
      debtAmountUSD: paymentData.debtAmountUSD,
      paymentMethod,
    });

    // Save state for confirmation modal
    setCompletedInvoice(savedInvoice);
    setCompletedCustomer(selectedCustomer);
    setCompletedItems([...cartItems]);

    // Clear active cart & customer for next sale
    setCartItems([]);
    setSelectedCustomer(null);

    // Close payment modal and open confirmation
    setIsPaymentModalOpen(false);
    setIsSuccessModalOpen(true);

    // Refresh pending count
    const offlineInvoices = await getOfflineInvoicesList();
    setPendingInvoicesCount(offlineInvoices.filter((inv) => inv.status === "PENDING").length);

    toast.success("تم حفظ الفاتورة محلياً بنجاح في قاعدة البيانات (Dexie)!");
  }

  function handleStartNewSale() {
    setCartItems([]);
    setSelectedCustomer(null);
    setCompletedInvoice(null);
    setCompletedCustomer(null);
    setCompletedItems([]);
    searchInputRef.current?.focus();
  }

  async function handleSeedDemoData() {
    try {
      await seedSampleOfflineData();
      await loadData();
      toast.success("تم تجهيز بيانات الأصناف والزبائن وسعر الصرف في الذاكرة المحلية بنجاح!");
    } catch (err) {
      console.error("Failed to seed demo data:", err);
      toast.error("حدث خطأ أثناء تحميل البيانات التجريبية.");
    }
  }

  const totalUSD = cartItems.reduce((acc, it) => acc + it.quantity * it.unitPriceUSD, 0);

  return (
    <div className="flex flex-col h-[calc(100vh-8.5rem)] space-y-3" dir="rtl">
      {/* Top POS Action & Status Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900 shadow-xs shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="gap-1.5 px-2.5 py-1 text-xs border-emerald-300 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-800 font-semibold">
              <Layers className="h-3.5 w-3.5 text-emerald-600" />
              <span>قاعدة Dexie: {isDbReady ? "جاهزة ✓" : "جاري التهيئة..."}</span>
            </Badge>

            <Badge variant="outline" className="gap-1.5 px-2.5 py-1 text-xs border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-800 font-semibold">
              <CloudOff className="h-3.5 w-3.5 text-amber-600" />
              <span>فواتير بانتظار المزامنة: {pendingInvoicesCount}</span>
            </Badge>
          </div>

          <div className="hidden md:flex items-center gap-1.5 text-[11px] text-zinc-500 mr-2">
            <Keyboard className="h-3.5 w-3.5 text-zinc-400" />
            <span>اختصارات: <kbd className="font-mono bg-zinc-100 dark:bg-zinc-800 px-1 rounded border border-zinc-200 dark:border-zinc-700">F2</kbd> بحث • <kbd className="font-mono bg-zinc-100 dark:bg-zinc-800 px-1 rounded border border-zinc-200 dark:border-zinc-700">F4</kbd> زبون • <kbd className="font-mono bg-zinc-100 dark:bg-zinc-800 px-1 rounded border border-zinc-200 dark:border-zinc-700">F9</kbd> دفع</span>
          </div>
        </div>

        {/* Right side controls (Exchange Rate & Seeder) */}
        <div className="flex items-center gap-2">
          {dailyExchangeRate ? (
            <Badge className="bg-emerald-600 text-white gap-1 text-xs px-2.5 py-1">
              <DollarSign className="h-3.5 w-3.5" />
              <span>سعر الصرف المعتمد: {dailyExchangeRate.toLocaleString("ar-SY")} ل.س / $</span>
            </Badge>
          ) : (
            <Badge variant="destructive" className="gap-1 text-xs px-2.5 py-1">
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

      {/* Main Split Layout: Product Catalog on the RIGHT, Cart Drawer on the LEFT (in RTL) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 flex-1 overflow-hidden">
        {/* RIGHT SIDE (65% width): Product Catalog & Barcode Search */}
        <div className="lg:col-span-7 xl:col-span-8 flex flex-col overflow-hidden">
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

        {/* LEFT SIDE (35% width): Active Cart Drawer & Checkout */}
        <div className="lg:col-span-5 xl:col-span-4 flex flex-col overflow-hidden">
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

      {/* Modals */}
      <WalkInCustomerModal
        open={isCustomerModalOpen}
        onOpenChange={setIsCustomerModalOpen}
        selectedCustomer={selectedCustomer}
        onSelectCustomer={setSelectedCustomer}
      />

      <PaymentModal
        open={isPaymentModalOpen}
        onOpenChange={setIsPaymentModalOpen}
        totalUSD={totalUSD}
        exchangeRate={dailyExchangeRate || 0}
        selectedCustomer={selectedCustomer}
        onOpenCustomerModal={() => {
          setIsPaymentModalOpen(false);
          setIsCustomerModalOpen(true);
        }}
        onConfirmCheckout={handleConfirmCheckout}
      />

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
