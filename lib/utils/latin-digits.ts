/**
 * Converts Arabic-Indic / Persian digits and Arabic separators to Latin so the
 * storefront matches the dashboard ("3,550", not "٣٬٥٥٠"). Presentation only.
 */
export function toLatinDigits(input: string): string {
    return input
        .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
        .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
        .replace(/\u066C/g, ",")
        .replace(/\u066B/g, ".");
}