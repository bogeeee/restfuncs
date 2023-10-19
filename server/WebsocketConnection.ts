import crypto from "node:crypto";

export class WebsocketConnection {
    id = crypto.randomBytes(16);

    conn: unknown

    /**
     * The session values that were obtained from a http call
     */
    session?: object

    /**
     * Which security groups have been approved by http calls
     */
    allowedSecurityGroupIds = new Set<string>();


    onCall(clientCallId: number, ServerSessionId: string, methodName: string, args: any[]) {
        // Create new session object
        // Wrap with a proxy that serves the properties of session.
        // Can we get the session lazy ?
        // Check the validity of the session

        // do the call
        // if(sessionModified) {
        //      // hand out the session. Use a special token type so this can only be used to install the session as the main. Otherwise an attacker could have 2 valid sessions in stock.
        // }
    }

    onInstallSession() {

    }
}