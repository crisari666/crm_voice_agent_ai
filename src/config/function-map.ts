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

export type CreateFunctionMapDeps = Readonly<{
  emitCallCompletedSuccessfully: EmitCallCompletedSuccessfully;
}>;

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
      const flowId = args?.flowId ?? '69bb06bfb2cdd000b18c4f72';
      const userId = args?.userId ?? '67f47ec83ed9f93528d3fe61';
      if (args?.userId && args?.flowId) {
        await deps.emitCallCompletedSuccessfully({
          userId,
          flowId,
        });
      }

      // The agent can use this as “tool result”.
      return { success: true, message: 'Cita agendada para la capacitación.' };
    },
  };
}

// Default map (no-op emitter). Used by any legacy/unused websocket handler code.
export const FUNCTION_MAP: FunctionMap = createFunctionMap({
  emitCallCompletedSuccessfully: async () => {
    
    // intentionally empty
  },
});