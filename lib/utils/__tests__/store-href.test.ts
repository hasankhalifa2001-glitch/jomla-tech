import { describe, it, expect } from "vitest";
import { storePath, storeHref } from "@/lib/utils/store-href";

/**
 * T5a - store URL builder. Every internal link, canonical/OG URL and the
 * WhatsApp text routes through this so a future subdomain deployment is a
 * one-place change.
 */
describe("storePath", () => {
  it("builds /store/<slug> with no trailing path", () => {
    expect(storePath("acme")).toBe("/store/acme");
  });

  it("appends a path segment", () => {
    expect(storePath("acme", "products")).toBe("/store/acme/products");
  });

  it("strips leading/trailing slashes on the path", () => {
    expect(storePath("acme", "/products/")).toBe("/store/acme/products");
  });

  it("url-encodes the slug so a hyphen or unicode slug is safe", () => {
    expect(storePath("a b")).toBe("/store/a%20b");
  });
});

describe("storeHref", () => {
  it("returns the path portion when no origin is given", () => {
    expect(storeHref("acme", "products")).toBe("/store/acme/products");
  });

  it("prefixes an origin and strips its trailing slash", () => {
    expect(storeHref("acme", "products", "https://jomla.tech/")).toBe(
      "https://jomla.tech/store/acme/products",
    );
  });

  it("builds the store root when origin given and no path", () => {
    expect(storeHref("acme", "", "https://jomla.tech")).toBe("https://jomla.tech/store/acme");
  });
});
