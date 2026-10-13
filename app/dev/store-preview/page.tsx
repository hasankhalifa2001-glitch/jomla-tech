import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { lineKey } from "@/components/store/keys";
import type { CartLineBase, HomeData, StoreProductDTO } from "@/components/store/types";
import { HomeView } from "@/components/store/Homeview";

/**
 * DEV ONLY — /dev/store-preview renders the storefront home with mock data so it
 * can be compared with the approved design before lib/data/store.ts exists.
 * Delete this folder before launch (it returns 404 in production anyway).
 * Submitting an order here fails (no /api/store/orders yet) — that is expected;
 * the error path is part of what you can see.
 */
export const metadata: Metadata = { robots: { index: false, follow: false } };

const products: StoreProductDTO[] = [
    {
        id: "p1",
        name: "زيت الزهرة",
        category: "زيوت",
        imageUrl: null,
        stockText: "متوفر 120 طرد",
        inStock: true,
        units: [
            { id: "u1", name: "قطعة", factorText: null, price: "250", currency: "SYP", approxSYP: null },
            { id: "u2", name: "طرد", factorText: "= 24 قطعة", price: "5880", currency: "SYP", approxSYP: null },
        ],
    },
    {
        id: "p2",
        name: "متة خارطة",
        category: "مشروبات",
        imageUrl: null,
        stockText: "متوفر 80 طرد",
        inStock: true,
        units: [
            { id: "u1", name: "قطعة", factorText: null, price: "150", currency: "SYP", approxSYP: null },
            { id: "u2", name: "طرد", factorText: "= 24 قطعة", price: "3550", currency: "SYP", approxSYP: null },
        ],
    },
    {
        id: "p3",
        name: "مدار سائل جلي",
        category: "منظفات",
        imageUrl: null,
        stockText: "متوفر 45 كرتونة",
        inStock: true,
        units: [
            { id: "u1", name: "قطعة", factorText: null, price: "1200", currency: "SYP", approxSYP: null },
            { id: "u2", name: "كرتونة", factorText: "= 12 قطعة", price: "13500", currency: "SYP", approxSYP: null },
        ],
    },
    {
        id: "p4",
        name: "سكر ناعم",
        category: "مواد غذائية",
        imageUrl: null,
        stockText: "متوفر 200 طرد",
        inStock: true,
        units: [{ id: "u1", name: "طرد", factorText: "= 10 كغ", price: "12.5", currency: "USD", approxSYP: "1688" }],
    },
    {
        id: "p5",
        name: "رز مصري",
        category: "مواد غذائية",
        imageUrl: null,
        stockText: null,
        inStock: false,
        units: [{ id: "u1", name: "كيس", factorText: null, price: "9800", currency: "SYP", approxSYP: null }],
    },
    {
        id: "p6",
        name: "معكرونة",
        category: "مواد غذائية",
        imageUrl: null,
        stockText: "متوفر 60 طرد",
        inStock: true,
        units: [
            { id: "u1", name: "قطعة", factorText: null, price: "900", currency: "SYP", approxSYP: null },
            { id: "u2", name: "طرد", factorText: "= 20 قطعة", price: "17000", currency: "SYP", approxSYP: null },
        ],
    },
    {
        id: "p7",
        name: "شاي ورق",
        category: "مشروبات",
        imageUrl: null,
        stockText: "متوفر 90 طرد",
        inStock: true,
        units: [
            { id: "u1", name: "علبة", factorText: null, price: "2100", currency: "SYP", approxSYP: null },
            { id: "u2", name: "طرد", factorText: "= 25 علبة", price: "48000", currency: "SYP", approxSYP: null },
        ],
    },
];

// Every listable product/unit, for "أعد طلبي الأخير".
const reorderIndex: Record<string, CartLineBase> = {};
for (const p of products) {
    if (!p.inStock) continue;
    for (const u of p.units) {
        reorderIndex[lineKey(p.id, u.id)] = {
            productId: p.id,
            unitId: u.id,
            productName: p.name,
            unitName: u.name,
            price: u.price,
            currency: u.currency,
        };
    }
}

const byId = (ids: string[]) => ids.map((id) => products.find((p) => p.id === id)!);

const data: HomeData = {
    store: {
        slug: "demo",
        name: "مؤسسة الخليفة للجملة",
        logoUrl: null,
        phone: "0991234567",
        whatsappNumber: "963991234567",
        platformHref: "/",
    },
    categories: [
        { key: "زيوت", label: "زيوت" },
        { key: "مشروبات", label: "مشروبات" },
        { key: "منظفات", label: "منظفات" },
        { key: "مواد غذائية", label: "مواد غذائية" },
        { key: "__none__", label: "أخرى" },
    ],
    newest: byId(["p4", "p6", "p3", "p5"]),
    bestSellers: byId(["p1", "p2", "p3", "p7"]),
    reorderIndex,
};

export default function StorePreviewPage() {
    if (process.env.NODE_ENV === "production") notFound();
    return <HomeView data={data} />;
}