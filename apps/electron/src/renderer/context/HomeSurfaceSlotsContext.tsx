import * as React from 'react'
import { createContext, useContext, useMemo } from 'react'

/** A mountable slot: lazily renders its content, `undefined` = not provided. */
export type HomeSurfaceSlotRenderer = () => React.ReactNode

/**
 * Optional surfaces other feature areas can mount onto the home surface.
 * Renderers are lazy on purpose — the home page invokes them only at their
 * anchor points, and unprovided slots render nothing (no placeholder).
 */
export interface HomeSurfaceSlots {
  /** Home 「我的圈子」 entry card (provided by ws-circles-account). */
  circlesEntry?: HomeSurfaceSlotRenderer
  /** Pre-send credits blocking banner (provided by ws-circles-account). */
  creditsBlockingBanner?: HomeSurfaceSlotRenderer
}

export const HomeSurfaceSlotsContext = createContext<HomeSurfaceSlots>({})

export interface HomeSurfaceSlotsProviderProps {
  /** Slot map; omit for the default all-empty provider. */
  slots?: HomeSurfaceSlots
  children: React.ReactNode
}

/**
 * HomeSurfaceSlotsProvider — cross-workflow mounting contract (POO-70 WS-F).
 * Ships with an all-empty default so the app works without circle/credit
 * features; providers compose on top of the app root.
 */
export function HomeSurfaceSlotsProvider({ slots, children }: HomeSurfaceSlotsProviderProps) {
  const value = useMemo(() => slots ?? {}, [slots])
  return <HomeSurfaceSlotsContext.Provider value={value}>{children}</HomeSurfaceSlotsContext.Provider>
}

/** Reads the optional home surface slots (never throws; empty by default). */
export function useHomeSurfaceSlots(): HomeSurfaceSlots {
  return useContext(HomeSurfaceSlotsContext)
}
