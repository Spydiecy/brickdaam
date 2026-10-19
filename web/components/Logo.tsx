/** A 2x2 brick seen from above, plus the wordmark. Original artwork, not the LEGO logo. */
export function Logo() {
  return (
    <span className="logo">
      <svg className="logo-mark" viewBox="0 0 40 40" aria-hidden="true">
        <rect x="1" y="1" width="38" height="38" rx="6" fill="var(--red)" />
        {[11, 29].flatMap((cx) =>
          [11, 29].map((cy) => (
            <g key={`${cx}-${cy}`}>
              <circle cx={cx} cy={cy + 1.2} r="6.4" fill="#8E0A0D" />
              <circle cx={cx} cy={cy} r="6.4" fill="#F0262A" />
              <circle cx={cx - 1.6} cy={cy - 1.8} r="2" fill="#FF7A7A" opacity="0.7" />
            </g>
          )),
        )}
      </svg>
      <span className="logo-word" aria-hidden="true">
        Brick
        <span className="logo-swap">
          <span className="logo-en">daam</span>
          <span className="logo-hi" lang="hi">
            दाम
          </span>
        </span>
      </span>
    </span>
  );
}
