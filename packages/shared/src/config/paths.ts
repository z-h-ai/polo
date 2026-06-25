/**
 * Centralized path configuration for Polo AI.
 *
 * Supports multi-instance development via POLO_AI_CONFIG_DIR environment variable.
 * When running from a numbered folder (e.g., polo-ai-1), the detect-instance.sh
 * script sets POLO_AI_CONFIG_DIR to ~/.polo-ai-1, allowing multiple instances to run
 * simultaneously with separate configurations.
 *
 * Default (non-numbered folders): ~/.polo-ai/
 * Instance 1 (-1 suffix): ~/.polo-ai-1/
 * Instance 2 (-2 suffix): ~/.polo-ai-2/
 */

import { homedir } from 'os';
import { join } from 'path';

// Allow override via environment variable for multi-instance dev
// Falls back to default ~/.polo-ai/ for production and non-numbered dev folders
export const CONFIG_DIR = process.env.POLO_AI_CONFIG_DIR || join(homedir(), '.polo-ai');
