"use client";

/**
 * lib/receipts/bluetooth-printer.ts
 *
 * T4f — the Web Bluetooth / ESC/POS transport. The ONLY file in this feature
 * that touches `navigator.bluetooth`, and therefore the only file allowed to
 * (see eslint.config.mjs's T4f block, which bans the API everywhere else in
 * lib/** and components/**).
 *
 * The marketing page already promises this exact capability — "أرسل الإيصال
 * إلى طابعة حرارية مقاس 58 أو 80 مم عبر البلوتوث من متصفح Chrome" — so the
 * transport is Web Bluetooth, and the bytes it writes are produced entirely by
 * lib/receipts/escpos.ts.
 *
 * [THE ONE THING THIS FILE MUST NOT DO] It must not decide, guess, or read a
 * printer's width. Device metadata cannot be trusted for that (Rule 4), and
 * the width is already a confirmed per-device setting by the time anything
 * gets here — the caller passes a raster whose width was asserted against that
 * setting (assertRasterMatchesConfiguredWidth) BEFORE calling in.
 *
 * [BROWSER SUPPORT — stated rather than discovered later] Web Bluetooth is
 * Chrome/Edge on desktop and Android. It is NOT available in iOS Safari or
 * Firefox; `isWebBluetoothSupported()` exists so the UI can say so plainly and
 * offer the browser-print fallback rather than failing silently.
 *
 * [WHY WRITES ARE CHUNKED] A BLE GATT write is limited by the negotiated ATT
 * MTU (23 bytes by default, of which 3 are header). A whole receipt is tens of
 * kilobytes, so it is written in small sequential chunks — sequential, not
 * parallel, because most thermal printers have a small input buffer that
 * overflows (garble, dropped bands) if it is flooded.
 */

import { BLE_DEFAULT_CHUNK_BYTES, chunkBytes } from "./escpos";

/** Service UUIDs used by the ESC/POS-over-BLE printers this app targets.
 * 18F0 is the common vendor service; FF00 and the IIT/ISSC pair cover most of
 * the rest of the cheap 58/80 mm field. */
export const ESC_POS_SERVICE_UUIDS: readonly string[] = [
  "000018f0-0000-1000-8000-00805f9b34fb",
  "0000ff00-0000-1000-8000-00805f9b34fb",
  "49535343-fe7d-4ae5-8fa9-9fafd205e455",
];

/** Likewise for the writable characteristic inside those services. */
export const ESC_POS_WRITE_CHARACTERISTIC_UUIDS: readonly string[] = [
  "00002af1-0000-1000-8000-00805f9b34fb",
  "0000ff02-0000-1000-8000-00805f9b34fb",
  "49535343-8841-43f4-a8d4-ecbe34729bb3",
];

export const BLUETOOTH_UNSUPPORTED_MESSAGE =
  "الطباعة الحرارية المباشرة تتطلب متصفح Chrome أو Edge (على أندرويد أو ويندوز) — هذا المتصفح لا يدعم Web Bluetooth. يمكنك استخدام «طباعة من المتصفح» بدلاً من ذلك.";

export interface ThermalPrinterHandle {
  deviceId: string;
  /** Device-reported name, shown in the UI only. NEVER used to pick a width. */
  name: string;
  device: BluetoothDevice;
}

export function isWebBluetoothSupported(): boolean {
  return typeof navigator !== "undefined" && Boolean(navigator.bluetooth);
}

function assertBluetoothAvailable(): Bluetooth {
  if (!isWebBluetoothSupported() || !navigator.bluetooth) {
    throw new Error(BLUETOOTH_UNSUPPORTED_MESSAGE);
  }
  return navigator.bluetooth;
}

/**
 * Prompts the user to pair a printer. The browser's own chooser is the pairing
 * UI (a web page cannot enumerate devices silently), so this must be called
 * from a user gesture.
 */
export async function requestThermalPrinter(): Promise<ThermalPrinterHandle> {
  const bluetooth = assertBluetoothAvailable();

  const device = await bluetooth.requestDevice({
    filters: ESC_POS_SERVICE_UUIDS.map((service) => ({ services: [service] })),
    optionalServices: [...ESC_POS_SERVICE_UUIDS],
  });

  return {
    deviceId: device.id,
    name: device.name?.trim() || "طابعة حرارية",
    device,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findWriteCharacteristic(
  gatt: BluetoothRemoteGATTServer
): Promise<BluetoothRemoteGATTCharacteristic> {
  for (const serviceUuid of ESC_POS_SERVICE_UUIDS) {
    let service: BluetoothRemoteGATTService;
    try {
      service = await gatt.getPrimaryService(serviceUuid);
    } catch {
      continue;
    }

    for (const characteristicUuid of ESC_POS_WRITE_CHARACTERISTIC_UUIDS) {
      try {
        const characteristic = await service.getCharacteristic(characteristicUuid);
        if (characteristic) return characteristic;
      } catch {
        // Fall through to the property-based search below.
      }
    }

    try {
      const characteristics = await service.getCharacteristics();
      const writable = characteristics.find(
        (candidate) =>
          candidate.properties?.write || candidate.properties?.writeWithoutResponse
      );
      if (writable) return writable;
    } catch {
      // Service has no usable characteristic list; try the next service.
    }
  }

  throw new Error(
    "تم الاتصال بالطابعة لكن لم يتم العثور على قناة الكتابة (write characteristic) — تأكد من أن الجهاز طابعة ESC/POS حديثة."
  );
}

/**
 * Writes a complete ESC/POS job over the given handle.
 *
 * A cached handle can go stale (the printer slept, moved out of range, or the
 * page stayed open across a reconnect). This function does NOT hide that — it
 * throws — because the decision to re-pair (a browser permission prompt, which
 * needs a user gesture) belongs to the caller's click handler, not to a helper
 * running after an await. See receipt-actions.tsx's print handler.
 */
export async function printEscPosBytes(
  handle: ThermalPrinterHandle,
  bytes: Uint8Array,
  options: { chunkSize?: number; chunkDelayMs?: number } = {}
): Promise<void> {
  const chunkSize = options.chunkSize ?? BLE_DEFAULT_CHUNK_BYTES;
  const chunkDelayMs = options.chunkDelayMs ?? 12;

  let gatt = handle.device.gatt;
  if (!gatt) {
    throw new Error(
      "تعذّر الوصول إلى واجهة الطابعة (GATT) — أعد إقران الطابعة من إعدادات الطابعة."
    );
  }
  if (!gatt.connected) {
    gatt = await gatt.connect();
  }

  const characteristic = await findWriteCharacteristic(gatt);

  for (const chunk of chunkBytes(bytes, chunkSize)) {
    await characteristic.writeValue(chunk);
    if (chunkDelayMs > 0) await delay(chunkDelayMs);
  }
}

export function isPrinterConnected(handle: ThermalPrinterHandle): boolean {
  return Boolean(handle.device.gatt?.connected);
}

export function disconnectThermalPrinter(handle: ThermalPrinterHandle): void {
  try {
    handle.device.gatt?.disconnect();
  } catch {
    // A disconnect failure is not actionable — the browser tears the link down
    // with the page, and reconnecting is attempted on the next print.
  }
}
