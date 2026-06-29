#!/usr/bin/env tsx
/** Prints the worker system prompt to stdout — used by e2e-worker.sh */
import { SYSTEM_PROMPT_TEXT } from '../worker/prompts.js';
console.log(SYSTEM_PROMPT_TEXT);
