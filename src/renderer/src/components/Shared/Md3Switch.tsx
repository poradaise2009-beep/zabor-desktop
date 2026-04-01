export function Md3Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void; }) {
  return (
    <button role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
      className={`relative w-[52px] h-[32px] rounded-full transition-all duration-300 shrink-0 border-2
        ${checked ? 'bg-[#c70060] border-[#c70060]' : 'bg-transparent border-[#79747E]'}`}>
      <span className={`absolute top-1/2 -translate-y-1/2 rounded-full transition-all duration-300 flex items-center justify-center
        ${checked ? 'left-[22px] w-6 h-6 bg-white shadow-md' : 'left-[4px] w-4 h-4 bg-[#79747E]'}`}>
        {checked && (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#c70060" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
      </span>
    </button>
  );
}
