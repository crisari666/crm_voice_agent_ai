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
}

export const FUNCTION_MAP: FunctionMap = {
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

  scheduleAppointment(args: ScheduleAppointmentParams) {
    console.log('[scheduleAppointment] called with params:', args);
    // TODO: call endpoint e.g. POST /api/appointments with userId
    return { success: true, message: 'Cita agendada para la capacitación.' };
  },
}; 