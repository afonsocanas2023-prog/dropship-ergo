// ── Shared shipping / order types ────────────────────────────────────────────

export interface ShippingAddress {
  firstName: string;
  lastName: string;
  address1: string;
  address2?: string;
  city: string;
  province: string;
  country: string;
  zip: string;
  phone?: string;
}

export interface SupplierOrderLineItem {
  supplierSku: string;
  quantity: number;
  unitPrice: number;
}

export interface SupplierOrderPayload {
  shopifyOrderId: string;
  lineItems: SupplierOrderLineItem[];
  shippingAddress: ShippingAddress;
}

export interface SupplierOrderResult {
  supplierOrderId: string;
  trackingNumber?: string;
  estimatedDeliveryDays?: number;
}

export interface StockLevel {
  supplierSku: string;
  quantity: number;
}

// ── Shopify types ─────────────────────────────────────────────────────────────

export interface ShopifyLineItem {
  id: string;
  sku: string | null;
  variant_id: string;
  product_id: string;
  title: string;
  variant_title: string | null;
  quantity: number;
  price: string;
}

export interface ShopifyCustomer {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
}

export interface ShopifyOrder {
  id: string;
  order_number: number;
  email: string;
  total_price: string;
  currency: string;
  financial_status: string;
  fulfillment_status: string | null;
  note: string | null;
  line_items: ShopifyLineItem[];
  customer: ShopifyCustomer | null;
}

export interface ShopifyFulfillment {
  id: string;
  tracking_number: string | null;
  tracking_url: string | null;
  status: string;
}

// ── Gorgias types ─────────────────────────────────────────────────────────────

export interface GorgiasTicket {
  id: number;
  status: string;
  tags: Array<{ name: string }>;
  customer: { id: number; email: string } | null;
  messages_count: number;
}
