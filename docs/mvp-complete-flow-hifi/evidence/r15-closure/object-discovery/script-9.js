/* Shared allowlist for product system results and review transport. No controls. */
window.poloSpaceSwitchResults = Object.freeze({
  'P-M02-STOPPING': ['P-M02-TARGET-LOADING', 'P-M02-STOP-FAILED'],
  'P-M02-TARGET-LOADING': ['P-M03-HOME-PERSONAL'],
  'P-M02-STOPPING-PERSONAL': ['P-M02-TARGET-LOADING-ENT'],
  'P-M02-TARGET-LOADING-ENT': ['P-M03-HOME-ENT']
});
