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
}

export type EmitCallCompletedSuccessfully = (input: Readonly<{
  flowId: string;
  userId: string;
}>) => Promise<void>;

/** Fired when the agent calls `scheduleAppointment`; triggers `send.confirmar_capacitacion` in the monolith immediately. */
export type EmitRequestConfirmarCapacitacion = (input: Readonly<{
  flowId: string;
  userId: string;
}>) => Promise<void>;

export type CreateFunctionMapDeps = Readonly<{
  emitCallCompletedSuccessfully: EmitCallCompletedSuccessfully;
  emitRequestConfirmarCapacitacion: EmitRequestConfirmarCapacitacion;
  /** Live Twilio stream context (flowId, user) when the model omits them or the call races `start`. */
  getScheduleContext?: () => Readonly<{ flowId?: string; userId?: string }>;
}>;

function coalesceTrimmedId(primary: string | undefined, fallback: string | undefined): string {
  const a = typeof primary === 'string' ? primary.trim() : '';
  if (a.length > 0) return a;
  const b = typeof fallback === 'string' ? fallback.trim() : '';
  return b;
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
      const userId = coalesceTrimmedId(args?.userId, ctx.userId);
      if (flowId.length > 0 && userId.length > 0) {
        await deps.emitRequestConfirmarCapacitacion({ userId, flowId });
      } else {
        console.warn(
          '[scheduleAppointment] skipping CRM signals: missing flowId or userId (check Twilio <Parameter> names: flowId or flow_id; customer_id or userId)',
          { flowId, userId, args, ctx },
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