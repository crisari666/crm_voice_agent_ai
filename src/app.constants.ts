/** Twilio AMD `AnsweredBy` values that mean voicemail/machine or fax — end the call. */
export const ANSWERED_BY_SHOULD_HANGUP: ReadonlySet<string> = new Set([
  'machine_start',
  'machine_end_beep',
  'machine_end_silence',
  'machine_end_other',
  'fax',
  'unknown',
]);

export type CrmBackEventPayload = Readonly<{
  type: 'voice_agent_ms_events';
  payload: Record<string, unknown>;
}>;
