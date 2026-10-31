import { validateVariables, validateGameState } from './model.js';
import { validateObservations } from './save.js';

// Ephemeral seed for a trial run; never part of project or save schemas.
export function validateTrialState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || Object.keys(state).length !== 2 || !Object.hasOwn(state, 'gameState') || !Object.hasOwn(state, 'localVariables')) throw new Error('Invalid trial state');
  validateGameState(state.gameState); validateObservations(state.gameState.observations); validateVariables(state.localVariables, 'local');
  return state;
}
