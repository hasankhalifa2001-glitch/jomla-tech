/**
 * types/web-bluetooth.d.ts
 *
 * T4f — MINIMAL local ambient types for the Web Bluetooth surface this app
 * actually uses.
 *
 * WHY THIS FILE EXISTS: TypeScript's bundled lib.dom.d.ts (checked against
 * the version pinned in this repo) does NOT include the Web Bluetooth API, so
 * `navigator.bluetooth` is a compile error without a declaration. There is no
 * @types/web-bluetooth in package.json, and adding a dependency for a handful
 * of member signatures is not worth the supply-chain surface — the app uses
 * exactly one operation (request a device, connect, write bytes) and nothing
 * else in the profile.
 *
 * Deliberately NARROW: only the members lib/receipts/bluetooth-printer.ts
 * touches are declared. A wider declaration would silently accept code that
 * this codebase has no intention of running (advertising, notifications,
 * descriptors), which is exactly the kind of "looks supported, isn't" surface
 * Rule 4's no-inference posture argues against.
 *
 * `export {}` makes this a module so `declare global` augments the real
 * Navigator rather than shadowing anything.
 */

export {};

declare global {
  interface BluetoothCharacteristicProperties {
    readonly write: boolean;
    readonly writeWithoutResponse: boolean;
  }

  interface BluetoothRemoteGATTCharacteristic extends EventTarget {
    readonly uuid: string;
    readonly properties: BluetoothCharacteristicProperties;
    /**
     * The real API accepts BufferSource. Declared as Uint8Array deliberately:
     * this app only ever writes Uint8Array slices of an ESC/POS job (see
     * lib/receipts/escpos.ts's chunkBytes), and the narrower type avoids
     * lib.dom's ArrayBufferLike/BufferSource variance friction under
     * TypeScript 5.7+'s typed-array generics.
     */
    writeValue(value: Uint8Array): Promise<void>;
  }

  interface BluetoothRemoteGATTService {
    readonly uuid: string;
    getCharacteristic(characteristic: string): Promise<BluetoothRemoteGATTCharacteristic>;
    getCharacteristics(): Promise<BluetoothRemoteGATTCharacteristic[]>;
  }

  interface BluetoothRemoteGATTServer {
    readonly connected: boolean;
    connect(): Promise<BluetoothRemoteGATTServer>;
    disconnect(): void;
    getPrimaryService(service: string): Promise<BluetoothRemoteGATTService>;
    getPrimaryServices(): Promise<BluetoothRemoteGATTService[]>;
  }

  interface BluetoothDevice extends EventTarget {
    readonly id: string;
    readonly name?: string;
    readonly gatt?: BluetoothRemoteGATTServer;
  }

  interface BluetoothRequestDeviceFilter {
    services?: string[];
    namePrefix?: string;
  }

  interface BluetoothRequestDeviceOptions {
    filters?: BluetoothRequestDeviceFilter[];
    optionalServices?: string[];
    acceptAllDevices?: boolean;
  }

  interface Bluetooth {
    requestDevice(options: BluetoothRequestDeviceOptions): Promise<BluetoothDevice>;
    getDevices?(): Promise<BluetoothDevice[]>;
  }

  interface Navigator {
    readonly bluetooth?: Bluetooth;
  }
}
