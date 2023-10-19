

export type CSRFProtectionMode = "preflight" | "corsReadToken" | "csrfToken"

export type WelcomeInfo = {
    classId: string,
    /**
     * Undefined, if it the server does not support engine.io
     */
    engineIoUrl?: string
};

export interface IServerSession {
    /**
     * The client needs to know some things, before creating the socket connection
     */
    getWelcomeInfo(): WelcomeInfo;
}