import React from 'react';

export function Md3Slider({ min, max, value, step = 1, onChange, className = '' }: {
  min: number; max: number; value: number; step?: number;
  onChange: (v: number) => void; className?: string;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <input type="range" min={min} max={max} step={step} value={value}
      onChange={e => onChange(Number(e.target.value))}
      className={`md3-range w-full ${className}`}
      style={{ '--slider-pct': `${pct}%` } as React.CSSProperties} />
  );
}
