import poloAiLogo from "@/assets/polo_ai_logo_c.svg"

interface PoloAiAppIconProps {
  className?: string
  size?: number
}

/**
 * PoloAiAppIcon - Displays the Polo AI logo (colorful "C" icon)
 */
export function PoloAiAppIcon({ className, size = 64 }: PoloAiAppIconProps) {
  return (
    <img
      src={poloAiLogo}
      alt="Polo AI"
      width={size}
      height={size}
      className={className}
    />
  )
}
