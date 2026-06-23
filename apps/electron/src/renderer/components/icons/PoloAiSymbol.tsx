interface PoloAiSymbolProps {
  className?: string
}

export function PoloAiSymbol({ className }: PoloAiSymbolProps) {
  return (
    <svg
      viewBox="0 0 100 100"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M 22 85 V 10 H 44 A 19 19 0 0 1 44 48 H 34"
        stroke="currentColor"
        strokeWidth="8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="42" cy="76" r="9" fill="currentColor" />
      <path
        d="M 60 65 V 85 H 68"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="84" cy="76" r="9" fill="currentColor" />
    </svg>
  )
}
