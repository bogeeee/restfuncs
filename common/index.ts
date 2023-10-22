

export type CSRFProtectionMode = "preflight" | "corsReadToken" | "csrfToken"

/**
 * The info that's needed  to set up a socket connection
 */
export type WelcomeInfo = {
    classId: string,
    /**
     * Undefined, if it the server does not support engine.io
     */
    engineIoPath?: string
};

export interface IServerSession {
    /**
     * The client needs to know some things, before creating the socket connection
     */
    getWelcomeInfo(): WelcomeInfo;
}