import type { ReactNode } from "react";

/** Shared stroke-icon wrapper. Decorative by default (aria-hidden). */
function Svg({
    size = 20,
    strokeWidth = 2,
    children,
}: {
    size?: number;
    strokeWidth?: number;
    children: ReactNode;
}) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            {children}
        </svg>
    );
}

type P = { size?: number };

export const PhoneIcon = ({ size }: P) => (
    <Svg size={size}>
        <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z" />
    </Svg>
);
export const WhatsAppIcon = ({ size }: P) => (
    <Svg size={size}>
        <path d="M21 11.5a8.4 8.4 0 0 1-12.4 7.4L3 20.5l1.7-5.4A8.4 8.4 0 1 1 21 11.5z" />
    </Svg>
);
export const CartIcon = ({ size }: P) => (
    <Svg size={size}>
        <circle cx="9" cy="20" r="1.5" />
        <circle cx="18" cy="20" r="1.5" />
        <path d="M2 3h3l2.7 12.4a2 2 0 0 0 2 1.6h8.3a2 2 0 0 0 2-1.5L21.5 8H6" />
    </Svg>
);
export const SearchIcon = ({ size = 22 }: P) => (
    <Svg size={size}>
        <circle cx="11" cy="11" r="7" />
        <path d="M21 21l-4.3-4.3" />
    </Svg>
);
export const PlusIcon = ({ size }: P) => (
    <Svg size={size} strokeWidth={2.4}>
        <path d="M12 5v14M5 12h14" />
    </Svg>
);
export const MinusIcon = ({ size = 18 }: P) => (
    <Svg size={size} strokeWidth={2.4}>
        <path d="M5 12h14" />
    </Svg>
);
export const ChevronLeftIcon = ({ size = 18 }: P) => (
    <Svg size={size}>
        <path d="M15 18l-6-6 6-6" />
    </Svg>
);
export const CloseIcon = ({ size = 20 }: P) => (
    <Svg size={size}>
        <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
);
export const InfoIcon = ({ size = 18 }: P) => (
    <Svg size={size}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v4M12 16h.01" />
    </Svg>
);
export const CopyIcon = ({ size = 18 }: P) => (
    <Svg size={size}>
        <rect x="9" y="9" width="11" height="11" rx="2" />
        <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </Svg>
);
export const RepeatIcon = ({ size = 20 }: P) => (
    <Svg size={size}>
        <path d="M17 2l4 4-4 4" />
        <path d="M3 11V9a3 3 0 0 1 3-3h15" />
        <path d="M7 22l-4-4 4-4" />
        <path d="M21 13v2a3 3 0 0 1-3 3H3" />
    </Svg>
);

/* Category tiles cycle through these (category names are free text, so the
   icon is decorative rather than semantic). */
const CategoryDrop = ({ size = 26 }: P) => (
    <Svg size={size} strokeWidth={1.8}>
        <path d="M12 3c3 4 6 7 6 11a6 6 0 0 1-12 0c0-4 3-7 6-11z" />
    </Svg>
);
const CategoryCup = ({ size = 26 }: P) => (
    <Svg size={size} strokeWidth={1.8}>
        <path d="M5 8h11v6a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V8z" />
        <path d="M16 9h2a2 2 0 0 1 0 5h-2" />
    </Svg>
);
const CategorySpark = ({ size = 26 }: P) => (
    <Svg size={size} strokeWidth={1.8}>
        <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2 2M16 16l2 2M18 6l-2 2M8 16l-2 2" />
    </Svg>
);
const CategoryGrain = ({ size = 26 }: P) => (
    <Svg size={size} strokeWidth={1.8}>
        <path d="M12 21V9" />
        <path d="M12 9c-2.2-1-3.2-3-3.2-5.2C11 4.8 12 6.8 12 9z" />
        <path d="M12 9c2.2-1 3.2-3 3.2-5.2C13 4.8 12 6.8 12 9z" />
        <path d="M12 15c-2.2-1-3.2-3-3.2-5M12 15c2.2-1 3.2-3 3.2-5" />
    </Svg>
);
const CategoryBag = ({ size = 26 }: P) => (
    <Svg size={size} strokeWidth={1.8}>
        <path d="M6 7h12l1 13H5z" />
        <path d="M9 7a3 3 0 0 1 6 0" />
    </Svg>
);
const CategoryBox = ({ size = 26 }: P) => (
    <Svg size={size} strokeWidth={1.8}>
        <path d="M3 8l9-5 9 5v8l-9 5-9-5z" />
        <path d="M3 8l9 5 9-5M12 13v8" />
    </Svg>
);

export const CATEGORY_ICONS = [
    CategoryDrop,
    CategoryCup,
    CategorySpark,
    CategoryGrain,
    CategoryBag,
    CategoryBox,
];