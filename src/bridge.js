import { LIMITS, bytes, identifier, validateVariables, validateGameState } from './model.js';
import { validateTrialState } from './session-state.js';
export const PROTOCOL = 1;
const exact = (obj, keys) => obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).length === keys.length && keys.every(key => Object.hasOwn(obj, key));
const valid = (fn, value) => { try { fn(value); return true; } catch { return false; } };
export function validEnvelope(data, session, maximum = LIMITS.output) {
  try { return data && data.protocol === PROTOCOL && data.session === session && bytes(JSON.stringify(data)) <= maximum; } catch { return false; }
}
export function validFrameMessage(data, session) {
  const maximum = data?.kind === 'checkpoint' ? LIMITS.json : data?.kind === 'debug' ? 2 * LIMITS.output + 10000 : LIMITS.output;
  if (!validEnvelope(data, session, maximum)) return false;
  if (data.kind === 'ready') return exact(data, ['protocol', 'session', 'kind']);
  if (data.kind === 'diagnostic') return exact(data, ['protocol', 'session', 'kind', 'message']) && typeof data.message === 'string';
  if (data.kind === 'checkpoint') return exact(data, ['protocol', 'session', 'kind', 'save']) && data.save?.format === 'storyline-save' && data.save.formatVersion === 1 && valid(validateGameState, data.save.gameState) && valid(v => validateVariables(v, 'local'), data.save.localVariables);
  if (data.kind === 'debug') return exact(data, ['protocol', 'session', 'kind', 'passageId', 'gameState', 'localVariables', 'scene', 'canUndo']) && typeof data.canUndo === 'boolean' && (data.passageId === null || identifier(data.passageId)) && valid(validateGameState, data.gameState) && valid(v => validateVariables(v, 'local'), data.localVariables) && (data.scene === null || typeof data.scene === 'string');
  if (data.kind === 'navigate') return exact(data, ['protocol', 'session', 'kind', 'passageId']) && identifier(data.passageId);
  return false;
}
export function validInit(data, session) {
  try {
    const seeded = Object.hasOwn(data ?? {}, 'trialState');
    return validEnvelope(data, session, Infinity) && exact(data, ['protocol', 'session', 'kind', 'project', 'allowJavaScript', 'startId', ...(seeded ? ['trialState'] : [])]) && data.kind === 'init' && typeof data.allowJavaScript === 'boolean' && identifier(data.startId) && (!seeded || !!validateTrialState(data.trialState));
  } catch { return false; }
}
export function validCommand(data, session) {
  if (!validEnvelope(data, session, LIMITS.json)) return false;
  if (data.kind === 'save-game') return exact(data, ['protocol', 'session', 'kind']);
  if (data.kind === 'restore-game') return exact(data, ['protocol', 'session', 'kind', 'save']) && data.save && typeof data.save === 'object';
  if (data.kind === 'theme') return exact(data, ['protocol', 'session', 'kind', 'theme']) && ['dark', 'light'].includes(data.theme);
  if (data.kind === 'undo') return exact(data, ['protocol', 'session', 'kind']);
  return false;
}
