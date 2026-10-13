import { Cairo } from "next/font/google";

/** The storefront's one font. Applied on the root element of every store page. */
export const cairo = Cairo({
    subsets: ["arabic", "latin"],
    weight: ["400", "600", "700", "800"],
    display: "swap",
});