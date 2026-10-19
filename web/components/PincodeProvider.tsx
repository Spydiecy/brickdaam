'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, post } from '@/lib/api';
import type { Pincode } from '@/lib/types';

interface Ctx {
  /** The pincode prices are shown for, or null until one is known. */
  pincode: string | null;
  city: string | null;
  tracked: Pincode[];
  ready: boolean;
  choose: (pincode: string) => Promise<void>;
}

const PincodeContext = createContext<Ctx | null>(null);
const KEY = 'brickdaam:pincode';
const OLD_KEY = 'brickwatch:pincode'; // read once so a saved pincode survives the rename

export function PincodeProvider({ children }: { children: ReactNode }) {
  const [tracked, setTracked] = useState<Pincode[]>([]);
  const [pincode, setPincode] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    api<Pincode[]>('/api/pincodes')
      .then((list) => {
        setTracked(list);
        const saved = localStorage.getItem(KEY) ?? localStorage.getItem(OLD_KEY);
        setPincode(list.find((p) => p.pincode === saved)?.pincode ?? list[0]?.pincode ?? null);
      })
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);

  /** Switch to a pincode, starting to track it first if it is new. Throws a readable message. */
  const choose = useCallback(
    async (pin: string) => {
      if (!tracked.some((p) => p.pincode === pin)) {
        const added = await post<Pincode>('/api/pincodes', { pincode: pin });
        setTracked((t) => [...t, added].sort((a, b) => a.pincode.localeCompare(b.pincode)));
      }
      localStorage.setItem(KEY, pin);
      setPincode(pin);
    },
    [tracked],
  );

  const city = tracked.find((p) => p.pincode === pincode)?.city ?? null;
  return (
    <PincodeContext.Provider value={{ pincode, city, tracked, ready, choose }}>{children}</PincodeContext.Provider>
  );
}

export function usePincode() {
  const ctx = useContext(PincodeContext);
  if (!ctx) throw new Error('usePincode must be used inside PincodeProvider');
  return ctx;
}
