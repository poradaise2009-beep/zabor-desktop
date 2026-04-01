import { useState, useEffect } from 'react';

export function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const cleanup = window.windowControls?.onMaximizeChange(setIsMaximized);
    return () => cleanup?.();
  }, []);

  return (
    <div className="title-bar h-9 bg-[#09090B] flex items-center justify-between shrink-0 relative z-[10000] border-b border-[#1a1a1f]">
      <div className="flex items-center pl-4 gap-2 pointer-events-none">
        <span className="text-[13px] font-black tracking-[0.2em] text-white/30">ZABOR</span>
      </div>
      <div className="flex items-center h-full title-no-drag">
        <button onClick={() => window.windowControls?.minimize()} className="h-full w-12 flex items-center justify-center text-white/40 hover:text-white hover:bg-white/[0.06] transition-colors">
          <svg width="12" height="1" viewBox="0 0 12 1" fill="currentColor"><rect width="12" height="1" rx="0.5" /></svg>
        </button>
        <button onClick={() => window.windowControls?.maximize()} className="h-full w-12 flex items-center justify-center text-white/40 hover:text-white hover:bg-white/[0.06] transition-colors">
          {isMaximized ? (
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1"><rect x="3" y="0.5" width="7.5" height="7.5" rx="1" /><rect x="0.5" y="3" width="7.5" height="7.5" rx="1" /></svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1"><rect x="0.5" y="0.5" width="9" height="9" rx="1.5" /></svg>
          )}
        </button>
        <button onClick={() => window.windowControls?.close()} className="h-full w-12 flex items-center justify-center text-white/40 hover:text-white hover:bg-[#c70060] transition-colors">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"><line x1="1" y1="1" x2="11" y2="11" /><line x1="11" y1="1" x2="1" y2="11" /></svg>
        </button>
      </div>
    </div>
  );
}
