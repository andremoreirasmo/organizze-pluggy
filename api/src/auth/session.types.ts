export type SessionUser = {
  email: string;
};

export const SESSION_COOKIE_NAME = 'op_session';

/** Idle timeout without activity — cookie maxAge and server check. */
export const SESSION_IDLE_SECONDS = 60 * 60 * 12; // 12 hours

/** Hard cap from login time — does not slide. */
export const SESSION_ABSOLUTE_SECONDS = 60 * 60 * 24 * 7; // 7 days

/** Min interval between lastSeenAt / cookie renewals. */
export const SESSION_TOUCH_THROTTLE_SECONDS = 60 * 5; // 5 minutes
