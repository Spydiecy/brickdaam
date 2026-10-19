export interface Pincode {
  pincode: string;
  city: string;
  /** Coordinates to use for this attempt (quick-commerce platforms are keyed on these). */
  lat: number;
  lng: number;
}

/** What an adapter returns for one product on one platform at one pincode. */
export interface RawListing {
  platformProductId: string;
  title: string;
  /** Brand as reported by the platform, when it provides one */
  brand?: string | null;
  /** Selling price in INR */
  price: number;
  /** Struck-through MRP in INR, if shown */
  mrp?: number | null;
  inStock: boolean;
  url: string;
}

/** Thrown by an adapter when the platform does not deliver to this location. */
export class NotServiceableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotServiceableError';
  }
}

/** Every platform (Amazon, Blinkit, ...) implements this same interface. */
export interface Adapter {
  /** Stable id stored in the DB, e.g. "amazon", "blinkit" */
  id: string;
  name: string;
  /**
   * "coordinates": the platform picks a dark store from lat/lng, so the scraper tries
   * several candidate points per pincode until one is serviceable.
   * "pincode": the platform takes the pincode itself.
   */
  locationKey: 'coordinates' | 'pincode';
  /**
   * Minimum minutes between crawls of the same pincode. Quick-commerce platforms leave this
   * unset (every tick). Big retailers whose prices move slowly and whose crawls are heavy
   * use a longer interval.
   */
  minIntervalMin?: number;
  /**
   * Return every LEGO product the platform shows for this location
   * (price and availability are location specific).
   * Throw NotServiceableError when the platform does not serve it.
   */
  fetchLegoListings(pincode: Pincode): Promise<RawListing[]>;
}
