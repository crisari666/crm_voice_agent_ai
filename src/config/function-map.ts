import type { FunctionMap } from '../types';

/** Params for getContactName (injected from call context; agent may call with no args). */
export interface GetContactNameParams {
  customer_name?: string;
}

/** Params for disabledUser (from agent function call). */
export interface DisabledUserParams {
  userId: string;
}

/** Params for scheduleAppointment (from agent function call). */
export interface ScheduleAppointmentParams {
  userId: string;
  flowId?: string;
  candidateId?: string;
}

export type EmitCallCompletedSuccessfully = (input: Readonly<{
  flowId: string;
  candidateId: string;
}>) => Promise<void>;

/** Fired when the agent calls `scheduleAppointment`; triggers `send.confirmar_capacitacion` in the monolith immediately. */
export type EmitRequestConfirmarCapacitacion = (input: Readonly<{
  flowId: string;
  candidateId: string;
}>) => Promise<void>;

export type CreateFunctionMapDeps = Readonly<{
  emitCallCompletedSuccessfully: EmitCallCompletedSuccessfully;
  emitRequestConfirmarCapacitacion: EmitRequestConfirmarCapacitacion;
  /** Live Twilio stream context when the model omits ids or the call races `start`. */
  getScheduleContext?: () => Readonly<{ flowId?: string; candidateId?: string }>;
}>;

function coalesceTrimmedId(primary: string | undefined, fallback: string | undefined): string {
  const a = typeof primary === 'string' ? primary.trim() : '';
  if (a.length > 0) return a;
  const b = typeof fallback === 'string' ? fallback.trim() : '';
  return b;
}

/** Mongo ObjectId string from this stack is always 24 hex chars (avoids LLM passing a display name as id). */
function isMongoObjectIdHex24(value: string | undefined): boolean {
  const v = typeof value === 'string' ? value.trim() : '';
  return v.length === 24 && /^[a-fA-F0-9]{24}$/.test(v);
}

function pickScheduleCandidateIdForCrm(
  argsCandidateId: string | undefined,
  argsUserId: string | undefined,
  ctxCandidateId: string | undefined,
): string {
  const fromArgsCandidate =
    typeof argsCandidateId === 'string' ? argsCandidateId.trim() : '';
  if (isMongoObjectIdHex24(fromArgsCandidate)) {
    return fromArgsCandidate;
  }
  const fromArgsUser = typeof argsUserId === 'string' ? argsUserId.trim() : '';
  if (isMongoObjectIdHex24(fromArgsUser)) {
    return fromArgsUser;
  }
  const fromCtx = typeof ctxCandidateId === 'string' ? ctxCandidateId.trim() : '';
  if (isMongoObjectIdHex24(fromCtx)) {
    return fromCtx;
  }
  return coalesceTrimmedId(argsCandidateId, coalesceTrimmedId(argsUserId, ctxCandidateId));
}

export function createFunctionMap(deps: CreateFunctionMapDeps): FunctionMap {
  return {
    getContactName(args: GetContactNameParams) {
      const name = args?.customer_name?.trim() || 'invitado';
      console.log('[getContactName] called, CONTACT_NAME:', name);
      return { contactName: name, CONTACT_NAME: name };
    },

    disabledUser(args: DisabledUserParams) {
      console.log('[disabledUser] called with params:', args);
      // TODO: call endpoint e.g. POST /api/users/:userId/disable
      return { success: true, message: 'Usuario marcado como desinteresado.' };
    },

    async scheduleAppointment(args: ScheduleAppointmentParams) {
      console.log('[scheduleAppointment] called with params:', args);
      const ctx = deps.getScheduleContext?.() ?? {};
      const flowId = coalesceTrimmedId(args?.flowId, ctx.flowId);
      const candidateId = pickScheduleCandidateIdForCrm(
        args?.candidateId,
        args?.userId,
        ctx.candidateId,
      );
      if (flowId.length > 0 && candidateId.length > 0) {
        await deps.emitRequestConfirmarCapacitacion({ candidateId, flowId });
      } else {
        console.warn(
          '[scheduleAppointment] skipping CRM signals: missing flowId or candidateId (Twilio <Parameter>: flowId; customer_id / candidateId)',
          { flowId, candidateId, args, ctx },
        );
      }
      return { success: true, message: 'Cita agendada para la capacitación.' };
    },
  };
}

// Default map (no-op emitter). Used by any legacy/unused websocket handler code.
export const FUNCTION_MAP: FunctionMap = createFunctionMap({
  emitCallCompletedSuccessfully: async () => {
    // intentionally empty
  },
  emitRequestConfirmarCapacitacion: async () => {
    // intentionally empty
  },
  getScheduleContext: () => ({}),
});
