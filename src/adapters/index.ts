import type { Adapter } from '../types.js';
import { amazon } from './amazon.js';
import { bigbasket } from './bigbasket.js';
import { blinkit } from './blinkit.js';
import { firstcry } from './firstcry.js';
import { flipkart } from './flipkart.js';
import { instamart } from './instamart.js';
import { ozi } from './ozi.js';
import { zepto } from './zepto.js';

/**
 * Registry of real platform adapters. Each one implements `Adapter`
 * (see ../types.ts). An adapter is only added here after it has been
 * verified against the live platform.
 *
 * Not registered:
 *  - flipkart-minutes (flipkart-minutes.ts): worked once (20 items for 122003, prices matched the live
 *    pages), then Flipkart began redirecting Minutes searches to its landing page with no products.
 *  - amazon-now: no web entry point on amazon.in was found; Now appears to be app only.
 */
export const adapters: Adapter[] = [
  blinkit,
  zepto,
  ozi,
  amazon,
  flipkart,
  firstcry,
  bigbasket,
  instamart,
];
