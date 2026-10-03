export interface ShippingCode {
  kind: "container" | "ship" | "ship-mmsi" | "air-waybill" | "bill-of-lading";
  code: string;
  carrier?: string;
  airline?: string;
  /** The shipping line's own tracking page. */
  tracking?: string;
  /** A public page for the ship. */
  lookup?: string;
}

export function containerValid(code: string): boolean;
export function imoValid(code: string): boolean;
export function awbValid(code: string): boolean;
export function findShippingCodes(text: string): ShippingCode[];
export const CONTAINER_OWNERS: Record<string, string>;
export const CARRIER_TRACKING: Record<string, string>;
export const AWB_AIRLINES: Record<string, string>;
