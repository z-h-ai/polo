type AbortableController = Pick<AbortController, 'abort'>;

const inFlightLlmAbortControllers = new Set<AbortableController>();

export function trackInFlightLlmAbortController(controller: AbortableController): () => void {
  inFlightLlmAbortControllers.add(controller);
  return () => {
    inFlightLlmAbortControllers.delete(controller);
  };
}

export function getInFlightLlmAbortControllers(): Iterable<AbortableController> {
  return Array.from(inFlightLlmAbortControllers);
}

export function resetInFlightLlmAbortControllersForTests(): void {
  inFlightLlmAbortControllers.clear();
}
