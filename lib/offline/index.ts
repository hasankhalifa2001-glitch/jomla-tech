export * from "./db";
export * from "./id";
export * from "./exchange-rate";
export * from "./hooks";
export * from "./pos-service";
export * from "./sync-worker";
export * from "./cache-refresh";
export * from "./session-cache";
export * from "./transaction-helpers";
// [ADDED — T4b camera + hardware scanner integration]
// findProductUnitByBarcode: the single sanctioned barcode -> cart-line
// resolution path shared by BarcodeScannerModal (camera, continuous mode)
// and ProductCatalog's hardware keyboard-wedge scanner Enter handler.
export * from "./barcode-lookup";