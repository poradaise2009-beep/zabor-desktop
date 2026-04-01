import { unpackGif, getStaticFrameSync } from '../../utils/avatar';

export function AvatarImg({ src, size, animate = true, className = '' }: {
  src: string | null | undefined;
  size: number;
  animate?: boolean;
  className?: string;
}) {
  if (!src) return null;

  const packed = unpackGif(src);

  if (packed && animate) {
    return (
      <div className={`w-full h-full overflow-hidden relative ${className}`}>
        <img
          src={packed.g}
          draggable={false}
          className="absolute left-1/2 top-1/2 pointer-events-none"
          style={{
            transform: `translate(calc(-50% + ${packed.x * (size / 200)}px), calc(-50% + ${packed.y * (size / 200)}px)) scale(${packed.s})`,
            maxWidth: '100%',
            maxHeight: '100%',
            objectFit: 'contain',
          }}
        />
      </div>
    );
  }

  if (packed && !animate) {
    const staticSrc = getStaticFrameSync(src);
    return staticSrc ? <img src={staticSrc} className={`w-full h-full object-cover ${className}`} /> : null;
  }

  return <img src={src} className={`w-full h-full object-cover ${className}`} />;
}
