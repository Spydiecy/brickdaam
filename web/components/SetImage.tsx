/**
 * Set photo served as a small WebP from the tracker's own cache (/api/img/<set>?w=...), so pages load
 * kilobytes from this machine instead of multi-megabyte originals from the catalogue CDN.
 * The browser picks the width it needs from srcset.
 */
export function SetImage({
  setNumber,
  alt,
  sizes,
  priority = false,
  className,
}: {
  setNumber: string;
  alt: string;
  sizes: string;
  priority?: boolean;
  className?: string;
}) {
  const src = (w: number) => `/api/img/${setNumber}?w=${w}`;
  return (
    <img
      className={className}
      src={src(320)}
      srcSet={`${src(320)} 320w, ${src(640)} 640w, ${src(1000)} 1000w`}
      sizes={sizes}
      alt={alt}
      width={320}
      height={320}
      loading={priority ? 'eager' : 'lazy'}
      fetchPriority={priority ? 'high' : 'auto'}
      decoding="async"
    />
  );
}
