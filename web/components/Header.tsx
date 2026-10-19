'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Logo } from './Logo';
import { usePincode } from './PincodeProvider';

function PinIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="10" r="2.6" fill="currentColor" />
    </svg>
  );
}

function PincodePicker() {
  const { pincode, city, tracked, choose } = usePincode();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = async (pin: string) => {
    setError(null);
    if (!/^[1-9]\d{5}$/.test(pin)) return setError('Enter a 6 digit Indian pincode.');
    setBusy(true);
    try {
      await choose(pin);
      setOpen(false);
      setValue('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pin" ref={root}>
      <button className="pin-button" type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <PinIcon />
        <span className="pin-label">
          <span className="pin-label-small">Deliver to</span>
          <span className="pin-label-main">{pincode ? `${pincode}${city ? ` · ${city}` : ''}` : 'Set pincode'}</span>
        </span>
      </button>

      {open && (
        <div className="pin-panel" role="dialog" aria-label="Choose delivery pincode">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void pick(value.trim());
            }}
          >
            <label htmlFor="pin-input" className="pin-panel-title">
              Where should we check prices?
            </label>
            <p className="pin-panel-hint">Quick-commerce stock and prices depend on your exact pincode.</p>
            <div className="pin-panel-row">
              <input
                id="pin-input"
                ref={input}
                inputMode="numeric"
                maxLength={6}
                placeholder="e.g. 560001"
                value={value}
                onChange={(e) => setValue(e.target.value.replace(/\D/g, ''))}
                aria-invalid={!!error}
                aria-describedby={error ? 'pin-error' : undefined}
              />
              <button className="btn btn--dark" type="submit" disabled={busy}>
                {busy ? 'Checking…' : 'Apply'}
              </button>
            </div>
            {error && (
              <p id="pin-error" className="pin-panel-error" role="alert">
                {error}
              </p>
            )}
          </form>
          {tracked.length > 0 && (
            <div className="pin-panel-list">
              <p className="pin-panel-sub">Tracked pincodes</p>
              <ul>
                {tracked.map((p) => (
                  <li key={p.pincode}>
                    <button
                      type="button"
                      className={p.pincode === pincode ? 'is-current' : ''}
                      onClick={() => void pick(p.pincode)}
                    >
                      <strong>{p.pincode}</strong> {p.city}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function Header() {
  return (
    <>
      <div className="utility">
        <div className="wrap utility-inner">
          <span>Live LEGO® prices from 8 Indian stores, checked for your pincode</span>
          <span className="utility-note">Independent tracker. Not affiliated with the LEGO Group.</span>
        </div>
      </div>
      <header className="header">
        <div className="wrap header-inner">
          <Link href="/" className="header-home" aria-label="Brick Daam home">
            <Logo />
          </Link>
          <nav className="header-nav" aria-label="Main">
            <Link href="/">All sets</Link>
            <Link href="/stores">Stores</Link>
          </nav>
          <PincodePicker />
        </div>
      </header>
    </>
  );
}
