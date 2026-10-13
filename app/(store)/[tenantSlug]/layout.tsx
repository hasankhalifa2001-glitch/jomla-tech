import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * D16: every store page is noindex, nofollow by default (public wholesale
 * prices must not be crawled). Each page's generateMetadata may still add its
 * own title / Open Graph data on top of this — link previews are unaffected by
 * noindex.
 */
export const metadata: Metadata = {
    robots: { index: false, follow: false },
};

export default function StoreLayout({ children }: { children: ReactNode }) {
    return <>{children}</>;
}