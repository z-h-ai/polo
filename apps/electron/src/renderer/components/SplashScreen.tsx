import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import { PoloAiSymbol } from './icons/PoloAiSymbol'

interface SplashScreenProps {
  isExiting: boolean
  onExitComplete?: () => void
}

/** How long the splash may sit before the reassurance line appears. */
export const SPLASH_STILL_STARTING_DELAY_MS = 15_000

/**
 * SplashScreen - Shows Polo AI symbol during app initialization
 *
 * Displays centered symbol on app background, fades out when app is fully ready.
 * On exit, the symbol scales up and fades out quickly while the background fades slower.
 *
 * If initialization takes abnormally long (a hung IPC in the startup chain),
 * a single reassurance line fades in after SPLASH_STILL_STARTING_DELAY_MS —
 * purely presentational, it never interrupts the normal path.
 */
export function SplashScreen({ isExiting, onExitComplete }: SplashScreenProps) {
  const { t } = useTranslation()
  const [showStillStarting, setShowStillStarting] = useState(false)

  useEffect(() => {
    if (isExiting) return
    const timer = window.setTimeout(() => {
      setShowStillStarting(true)
    }, SPLASH_STILL_STARTING_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [isExiting])

  return (
    <motion.div
      className="fixed inset-0 z-splash flex items-center justify-center bg-background"
      initial={{ opacity: 1 }}
      animate={{ opacity: isExiting ? 0 : 1 }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
      onAnimationComplete={() => {
        if (isExiting && onExitComplete) {
          onExitComplete()
        }
      }}
    >
      <motion.div
        initial={{ scale: 1.5, opacity: 1 }}
        animate={{
          scale: isExiting ? 3 : 1.5,
          opacity: isExiting ? 0 : 1
        }}
        transition={{
          duration: 0.2,
          ease: [0.16, 1, 0.3, 1] // Exponential out curve
        }}
      >
        <PoloAiSymbol className="h-8 text-accent" />
      </motion.div>
      {showStillStarting && !isExiting ? (
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
          role="status"
          data-testid="splash-still-starting"
          className="absolute left-1/2 top-[calc(50%+40px)] w-[min(420px,80vw)] -translate-x-1/2 text-center text-[13px] leading-[1.5] text-foreground-50"
        >
          {t('splash.stillStarting')}
        </motion.p>
      ) : null}
    </motion.div>
  )
}
