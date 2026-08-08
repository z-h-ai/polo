if (process.env.POLO_AI_CLI_ARTIFACT_OUTPUT_DIR) {
  throw new Error(
    'POLO_AI_CLI_ARTIFACT_OUTPUT_DIR is test-only; production electron:build/electron:dist fail closed.',
  )
}
